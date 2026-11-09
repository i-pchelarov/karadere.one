// Edge Function `chat` — e2e поток:
//   валидация → Turnstile → rate limit → retrieval → системен промпт +
//   контекст → LLM (OpenRouter) → SSE стрийминг към клиента.
//
// Публичен endpoint (verify_jwt = false). Конфигурацията идва само от env
// (config.ts). Нищо не се хардкодва.
//
// Протоколът към клиента е SSE с именувани събития:
//   event: meta    → { articles, hits, trace }  (какво е намерено, преди отговора)
//   event: delta   → { text }                   (парче от отговора)
//   event: warning → { message }                (напр. retrieval е паднал)
//   event: done    → { finish }                 (край)
//   event: error   → { message }                (фатална грешка)
//
// EventSource не поддържа POST, затова клиентът чете през fetch + ReadableStream.

import { loadConfig, ragDeps, MAX_MODELS, type AppConfig } from "./config.ts";
import { runQuery, type Hit, type Mode } from "./rag.ts";
import { checkRateLimit, clientIp } from "./ratelimit.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { buildMessages, uniqueArticles, type ChatMessage } from "./prompt.ts";
import { fetchWithRetry, type RetryDeps } from "./retry.ts";
import { ChatError, publicMessageOf } from "./errors.ts";

// --- конфигурация (лениво, веднъж) -------------------------------------------
let cachedConfig: AppConfig | null = null;
function config(): AppConfig {
  if (cachedConfig === null) cachedConfig = loadConfig();
  return cachedConfig;
}

// --- CORS --------------------------------------------------------------------
// Allowlist, не един origin: локалният Jekyll сървър и продукцията трябва да
// работят едновременно. Ехо на Origin-а само ако е в списъка — иначе браузърът
// получава отговор без Access-Control-Allow-Origin и блокира четенето.
function allowedOrigin(cfg: AppConfig, req?: Request): string {
  const origin = req?.headers.get("Origin") ?? "";
  if (origin !== "" && cfg.cors.allowedOrigins.includes(origin)) return origin;
  // Няма Origin (curl, сървър-към-сървър) или непознат: връщаме първия
  // разрешен, за да остане отговорът валиден за предварителната заявка.
  return cfg.cors.allowedOrigins[0] ?? "";
}

function corsHeaders(cfg: AppConfig, req?: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(cfg, req),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonError(
  message: string,
  status: number,
  cfg: AppConfig,
  req?: Request,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(cfg, req), "Content-Type": "application/json" },
  });
}

// --- валидация ---------------------------------------------------------------
const ROLES = new Set(["system", "user", "assistant"]);

interface Validated {
  messages: ChatMessage[];
  question: string;
  mode: Mode;
  turnstileToken: string | undefined;
}

// Връща Validated при успех или текст на грешката (string) при невалидна заявка.
function validate(body: unknown, cfg: AppConfig): Validated | string {
  if (typeof body !== "object" || body === null) return "тялото не е JSON обект";
  const obj = body as Record<string, unknown>;

  const raw = obj.messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return "липсва непразен масив `messages`";
  }
  if (raw.length > cfg.limits.maxMessages) {
    return `твърде много съобщения (макс ${cfg.limits.maxMessages})`;
  }

  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return "невалидно съобщение";
    const m = item as Record<string, unknown>;
    const role = String(m.role ?? "");
    const content = typeof m.content === "string" ? m.content : "";
    if (!ROLES.has(role)) return `невалидна роля: ${role}`;
    if (content.trim() === "") return "празно съдържание на съобщение";
    if (content.length > cfg.limits.maxMessageChars) {
      return `съобщение над ${cfg.limits.maxMessageChars} знака`;
    }
    messages.push({ role: role as ChatMessage["role"], content });
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "няма потребителско съобщение";

  // Общ таван на контекста: много съобщения под поединичния лимит пак могат
  // да надуят заявката. Броим знаците, не токените — точно и без зависимост
  // от tokenizer.
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > cfg.limits.maxTotalChars) {
    return `историята е твърде дълга (макс ${cfg.limits.maxTotalChars} знака)`;
  }

  const modeRaw = obj.mode;
  const mode: Mode = modeRaw === "vector" || modeRaw === "keyword"
    ? modeRaw
    : "auto";

  // Turnstile токенът идва от widget-а на фронтенда. Не е задължителен тук —
  // проверката решава дали да го изисква (само когато е конфигуриран secret).
  const turnstileToken = typeof obj.turnstileToken === "string"
    ? obj.turnstileToken
    : undefined;

  return { messages, question: lastUser.content, mode, turnstileToken };
}

// --- SSE ---------------------------------------------------------------------
const encoder = new TextEncoder();
function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// --- LLM стрийминг -----------------------------------------------------------
interface OpenRouterChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: number | string };
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface LlmResult {
  deltas: number;
  finishReason: string | null;
  usage: { completion?: number; reasoning?: number } | null;
}

// Редът на моделите: основният, после резервните. OpenRouter ги пробва
// последователно при 429/срив/модерация. Само `:free` — платен модел в
// списъка се таксува при fallback. Отрязан до MAX_MODELS: OpenRouter връща
// 400 при повече от 3 модела.
export function modelChain(cfg: AppConfig): string[] {
  return [cfg.models.chat, ...cfg.models.chatFallbacks].slice(0, MAX_MODELS);
}

interface ParsedChunk {
  text: string | null;
  finishReason: string | null;
  usage: { completion?: number; reasoning?: number } | null;
}

// Разчита един SSE payload. Хвърля при грешка, пратена В ПОТОКА: OpenRouter я
// връща като `data: {"error":{...}}` и после `[DONE]`. Ако я прескочим,
// клиентът вижда meta → done без нито един delta и причината се губи напълно.
function parseChunk(payload: string): ParsedChunk | null {
  let parsed: OpenRouterChunk;
  try {
    parsed = JSON.parse(payload) as OpenRouterChunk;
  } catch {
    return null; // не-JSON ред (коментар/keep-alive) — прескачаме
  }
  if (parsed.error) {
    const msg = parsed.error.message ?? JSON.stringify(parsed.error);
    // Суровият текст остава в `detail` (лог); клиентът вижда само общото.
    throw new ChatError("моделът върна грешка по време на потока", `LLM stream error: ${msg}`);
  }
  const choice = parsed.choices?.[0];
  const text = choice?.delta?.content;
  const usage = parsed.usage
    ? {
      completion: parsed.usage.completion_tokens,
      reasoning: parsed.usage.completion_tokens_details?.reasoning_tokens,
    }
    : null;
  return {
    text: typeof text === "string" && text.length > 0 ? text : null,
    finishReason: choice?.finish_reason ?? null,
    usage,
  };
}

async function streamLlm(
  messages: ChatMessage[],
  cfg: AppConfig,
  send: (chunk: Uint8Array) => void,
  fetchImpl: typeof fetch = fetch,
  retryDeps: RetryDeps = {},
): Promise<LlmResult> {
  const resp = await fetchWithRetry(
    fetchImpl,
    `${cfg.openRouter.base}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openRouter.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        models: modelChain(cfg),
        messages,
        stream: true,
        max_tokens: cfg.limits.maxTokens,
        // Reasoning токените се броят към max_tokens. При кратък правен отговор
        // те само изяждат бюджета и отговорът излиза отрязан.
        ...(cfg.limits.reasoning ? {} : { reasoning: { enabled: false } }),
        // За да виждаме колко е отишло за „мислене“ и колко за текст.
        usage: { include: true },
      }),
    },
    cfg.retry,
    retryDeps,
  );

  if (!resp.ok || !resp.body) {
    const detail = resp.body ? (await resp.text()).slice(0, 300) : "<no body>";
    throw new ChatError(
      "услугата за модела е временно недостъпна",
      `LLM HTTP ${resp.status}: ${detail}`,
    );
  }

  // Предпазна мрежа: ако доставчикът върне обикновен JSON вместо SSE поток
  // (някои рутери игнорират `stream`), отговорът не бива да се губи.
  const ctype = resp.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream")) {
    const raw = await resp.text();
    let parsed: {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ChatError(
        "моделът върна неочакван отговор",
        `LLM върна не-SSE отговор: ${raw.slice(0, 300)}`,
      );
    }
    if (parsed.error) {
      throw new ChatError(
        "моделът върна грешка",
        `LLM error: ${parsed.error.message ?? raw.slice(0, 300)}`,
      );
    }
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.length > 0) {
      send(sse("delta", { text }));
      return { deltas: 1, finishReason: "stop", usage: null };
    }
    throw new ChatError(
      "моделът върна празен отговор",
      `LLM върна JSON без съдържание: ${raw.slice(0, 300)}`,
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let deltas = 0;
  let finishReason: string | null = null;
  let usage: LlmResult["usage"] = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // последният ред може да е непълен

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return { deltas, finishReason, usage };

        const chunk = parseChunk(payload);
        if (chunk === null) continue;
        if (chunk.finishReason !== null) finishReason = chunk.finishReason;
        if (chunk.usage !== null) usage = chunk.usage;
        if (chunk.text !== null) {
          deltas++;
          send(sse("delta", { text: chunk.text }));
        }
      }
    }
  } finally {
    decoder.decode(); // затваря decoder-а (иначе Deno отчита leak)
    reader.releaseLock();
  }

  return { deltas, finishReason, usage };
}

// --- handler -----------------------------------------------------------------
// `overrides` съществува само за тестовете: позволява инжектиране на fetch и
// на конфигурация, без да се пипат env или мрежата. Продукцията не го подава.
export interface HandlerOverrides {
  fetch?: typeof fetch;
  config?: AppConfig;
  retry?: RetryDeps;
  // Инжектируем за тестове: проверката на Turnstile и лимитерът иначе биха
  // искали мрежа. Продукцията не ги подава.
  verifyTurnstile?: typeof verifyTurnstile;
}

export async function handleChat(
  req: Request,
  overrides: HandlerOverrides = {},
): Promise<Response> {
  const cfg = overrides.config ?? config();
  const fetchImpl = overrides.fetch ?? fetch;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(cfg, req) });
  }
  if (req.method !== "POST") {
    return jsonError("методът не се поддържа", 405, cfg, req);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("невалиден JSON", 400, cfg, req);
  }

  const validated = validate(body, cfg);
  if (typeof validated === "string") return jsonError(validated, 400, cfg, req);
  const { messages, question, mode, turnstileToken } = validated;

  const deps = ragDeps(cfg, fetchImpl);
  const ip = clientIp(req);

  // Turnstile ПРЕДИ rate limit-а: проверката е евтина (един HTTP до Cloudflare)
  // и реже автоматизирания шум, преди да е похарчил квота от лимитера.
  const verify = overrides.verifyTurnstile ?? verifyTurnstile;
  const human = await verify(turnstileToken, ip, {
    fetch: fetchImpl,
    secretKey: cfg.turnstile.secretKey,
    expectedAction: cfg.turnstile.expectedAction,
    expectedHostnames: cfg.turnstile.hostnames,
  });
  if (!human.ok) {
    console.error("chat: turnstile отказа:", human.reason);
    return jsonError("проверката за човек не мина", 403, cfg, req);
  }

  const limit = await checkRateLimit(req, {
    fetch: deps.fetch,
    supabaseUrl: deps.supabaseUrl,
    serviceRoleKey: cfg.serviceRoleKey,
    config: cfg.rateLimit,
  });
  if (!limit.allowed) {
    const headers: Record<string, string> = {
      ...corsHeaders(cfg, req),
      "Content-Type": "application/json",
    };
    if (limit.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(limit.retryAfterSeconds);
    }
    return new Response(JSON.stringify({ error: "твърде много заявки" }), {
      status: 429,
      headers,
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: Uint8Array) => controller.enqueue(chunk);
      try {
        let hits: Hit[] = [];
        try {
          const result = await runQuery(question, cfg.limits.topK, mode, deps);
          hits = result.hits;
          send(sse("meta", {
            articles: uniqueArticles(hits),
            hits: hits.length,
            trace: result.trace,
          }));
        } catch (err) {
          // Retrieval е спомагателен: ако падне, чатът пак отговаря, но без
          // цитати. Клиентът получава warning и може да го покаже.
          send(sse("warning", { message: `retrieval: ${String(err)}` }));
        }

        const llmMessages = buildMessages(messages, hits);
        const result = await streamLlm(llmMessages, cfg, send, fetchImpl, overrides.retry);

        // Празен отговор не бива да изглежда като успех: клиентът вижда
        // meta → done без текст и не знае защо. Причината се казва явно.
        if (result.deltas === 0) {
          send(sse("warning", {
            message: result.finishReason === "length"
              ? "моделът изчерпа лимита за токени, без да върне текст"
              : "моделът не върна текст",
          }));
        } else if (result.finishReason === "length") {
          // Отрязан отговор: казваме го, вместо да го представяме за пълен.
          send(sse("warning", {
            message: "отговорът е отрязан — достигнат е лимитът за токени",
          }));
        }

        send(sse("done", {
          finish: result.finishReason ?? "stop",
          deltas: result.deltas,
          usage: result.usage,
        }));
      } catch (err) {
        // Суровият текст (тяло от доставчик, метаданни) остава в лога; към
        // клиента излиза само безопасното съобщение.
        console.error("chat: необработена грешка:", err);
        send(sse("error", {
          message: publicMessageOf(err, "възникна вътрешна грешка"),
        }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(cfg, req),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// Само при директно пускане (edge runtime / `deno run`). При import от тест
// сървърът не се вдига.
if (import.meta.main) {
  Deno.serve((req) => handleChat(req));
}
