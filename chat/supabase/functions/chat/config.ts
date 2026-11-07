// Конфигурация на чат функцията — само от environment.
// Стойностите идват от `supabase secrets set` (деплой) или от
// `--env-file ./supabase/functions/.env` (локално). Никога не се хардкодват.
//
// ВАЖНО: този модул НЕ чете env при import. Всичко минава през loadConfig(),
// за да могат тестовете да подадат собствен env (или никакъв) и да не
// гърмят при import. Ключовете са параметри, не глобални константи.

export type EnvReader = (name: string) => string | undefined;

const defaultEnv: EnvReader = (name) => Deno.env.get(name);

function str(env: EnvReader, name: string, fallback?: string): string {
  const v = env(name);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

function num(env: EnvReader, name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Списък, разделен със запетая. Празни елементи се изхвърлят.
function list(env: EnvReader, name: string, fallback: string[] = []): string[] {
  const v = env(name);
  if (v === undefined || v === "") return fallback;
  return v.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

// Булево от env: "1"/"true"/"yes"/"on" са истина, всичко друго — fallback.
function bool(env: EnvReader, name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

// --- retrieval настройки -----------------------------------------------------
export interface RagTuning {
  vectorThreshold: number;
  weakTop: number;
  confidentTop: number;
  minHits: number;
  fetchFactor: number;
  fetchLimit: number;
  maxTerms: number;
  minTermLen: number;
}

export const DEFAULT_TUNING: RagTuning = {
  vectorThreshold: 0.2,
  weakTop: 0.38,
  confidentTop: 0.62,
  minHits: 2,
  fetchFactor: 4,
  fetchLimit: 200,
  maxTerms: 8,
  minTermLen: 3,
};

// OpenRouter приема най-много 3 модела в `models` (основен + резервни).
// Повече → 400 „'models' array must have 3 items or fewer.“
export const MAX_MODELS = 3;

// Повторен опит при 429/5xx от OpenRouter. `attempts` включва първия опит.
export interface RetryConfig {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4000,
};

// Резервни LLM модели при 429/срив на основния. Само `:free` варианти —
// платен модел в списъка се таксува при fallback. Броят им + основният
// не бива да надвишава MAX_MODELS.
export const DEFAULT_CHAT_FALLBACKS: string[] = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

// Ограничение на честотата по IP (Ф.4). Фиксиран прозорец от секунди и праг
// заявки в него. 0 изключва лимита (полезно за локални тестове).
export interface RateLimitConfig {
  windowSeconds: number;
  limit: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowSeconds: 60,
  limit: 20,
};

// Разрешени origins за CORS (Ф.4). Списък, не един низ: локалният Jekyll
// сървър и продукцията трябва да работят едновременно, без да се пипа код.
export const DEFAULT_ALLOWED_ORIGINS: string[] = [
  "https://karadere.one",
  "https://www.karadere.one",
];

// --- зависимости на retrieval слоя -------------------------------------------
// Всичко, което rag.ts ползва, идва оттук. Тестовете подават фалшив fetch и
// фалшиви URL-и; продукцията подава истинските.
export interface RagDeps {
  fetch: typeof fetch;
  supabaseUrl: string;
  supabaseAnonKey: string;
  openRouterApiKey: string;
  openRouterBase: string;
  embedModel: string;
  embedDimensions: number;
  tuning: RagTuning;
}

export interface AppConfig {
  supabase: { url: string; anonKey: string };
  openRouter: { apiKey: string; base: string };
  models: {
    chat: string;
    chatFallbacks: string[];
    embed: string;
    embedDimensions: number;
  };
  rag: RagTuning;
  limits: {
    maxMessages: number;
    maxMessageChars: number;
    // Общ таван на знаците в цялата история. Пази от много дълги истории,
    // които минават поединичните лимити, но надуват контекста и цената.
    maxTotalChars: number;
    maxTokens: number;
    topK: number;
    reasoning: boolean;
  };
  retry: RetryConfig;
  cors: { allowedOrigins: string[] };
  turnstile: {
    secretKey: string;
    // Очаквано действие (data-action на widget-а). Празно = без проверка.
    expectedAction: string;
    // Разрешени hostname-и от siteverify. Празен списък = без проверка.
    hostnames: string[];
  };
  rateLimit: RateLimitConfig;
  // Ключ за RPC-то на лимитера. Supabase инжектира SUPABASE_SERVICE_ROLE_KEY
  // автоматично; празен низ изключва лимита (локално без ключ).
  serviceRoleKey: string;
}

export function loadConfig(env: EnvReader = defaultEnv): AppConfig {
  return {
    supabase: {
      url: str(env, "SUPABASE_URL"),
      anonKey: str(env, "SUPABASE_ANON_KEY"),
    },
    openRouter: {
      apiKey: str(env, "OPENROUTER_API_KEY"),
      base: "https://openrouter.ai/api/v1",
    },
    models: {
      chat: str(env, "CHAT_LLM_MODEL", "google/gemma-4-26b-a4b-it:free"),
      chatFallbacks: list(env, "CHAT_LLM_FALLBACKS", DEFAULT_CHAT_FALLBACKS),
      embed: str(env, "CHAT_EMBED_MODEL", "openai/text-embedding-3-small"),
      embedDimensions: num(env, "CHAT_EMBED_DIMENSIONS", 768),
    },
    rag: {
      vectorThreshold: num(env, "RAG_VECTOR_THRESHOLD", DEFAULT_TUNING.vectorThreshold),
      weakTop: num(env, "RAG_HYBRID_WEAK_TOP", DEFAULT_TUNING.weakTop),
      confidentTop: num(env, "RAG_HYBRID_CONFIDENT_TOP", DEFAULT_TUNING.confidentTop),
      minHits: num(env, "RAG_HYBRID_MIN_HITS", DEFAULT_TUNING.minHits),
      fetchFactor: num(env, "RAG_HYBRID_FETCH_FACTOR", DEFAULT_TUNING.fetchFactor),
      fetchLimit: num(env, "RAG_HYBRID_FETCH_LIMIT", DEFAULT_TUNING.fetchLimit),
      maxTerms: num(env, "RAG_HYBRID_MAX_TERMS", DEFAULT_TUNING.maxTerms),
      minTermLen: num(env, "RAG_HYBRID_MIN_TERM_LEN", DEFAULT_TUNING.minTermLen),
    },
    limits: {
      maxMessages: num(env, "CHAT_MAX_MESSAGES", 20),
      maxMessageChars: num(env, "CHAT_MAX_MESSAGE_CHARS", 4000),
      maxTotalChars: num(env, "CHAT_MAX_TOTAL_CHARS", 24000),
      maxTokens: num(env, "CHAT_MAX_TOKENS", 2000),
      topK: num(env, "CHAT_TOP_K", 6),
      // Reasoning токените се броят към max_tokens и при малък лимит моделът
      // изразходва всичко за „мислене“ и връща отрязан отговор с
      // finish_reason: "length". За кратък правен отговор не ни трябват.
      reasoning: bool(env, "CHAT_REASONING", false),
    },
    retry: {
      attempts: num(env, "CHAT_RETRY_ATTEMPTS", DEFAULT_RETRY_CONFIG.attempts),
      baseDelayMs: num(env, "CHAT_RETRY_BASE_MS", DEFAULT_RETRY_CONFIG.baseDelayMs),
      maxDelayMs: num(env, "CHAT_RETRY_MAX_MS", DEFAULT_RETRY_CONFIG.maxDelayMs),
    },
    cors: {
      // CHAT_ALLOWED_ORIGINS е списък, разделен със запетая. Пазим и старото
      // име CHAT_ALLOWED_ORIGIN за обратна съвместимост с вече зададени секрети.
      allowedOrigins: list(
        env,
        "CHAT_ALLOWED_ORIGINS",
        list(env, "CHAT_ALLOWED_ORIGIN", DEFAULT_ALLOWED_ORIGINS),
      ),
    },
    turnstile: {
      secretKey: env("TURNSTILE_SECRET_KEY") ?? "",
      // Действието идва от data-action на widget-а; по подразбиране "chat".
      expectedAction: env("TURNSTILE_ACTION") ?? "chat",
      // Продукция: karadere.one,www.karadere.one. Локално (в .env.local):
      // localhost,127.0.0.1. Празно = проверката се прескача.
      hostnames: list(env, "TURNSTILE_HOSTNAMES"),
    },
    rateLimit: {
      windowSeconds: num(
        env,
        "CHAT_RATE_LIMIT_WINDOW_SECONDS",
        DEFAULT_RATE_LIMIT.windowSeconds,
      ),
      limit: num(env, "CHAT_RATE_LIMIT_PER_WINDOW", DEFAULT_RATE_LIMIT.limit),
    },
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  };
}

// Сглобява зависимостите за rag.ts от заредена конфигурация.
export function ragDeps(
  cfg: AppConfig,
  fetchImpl: typeof fetch = fetch,
): RagDeps {
  return {
    fetch: fetchImpl,
    supabaseUrl: cfg.supabase.url,
    supabaseAnonKey: cfg.supabase.anonKey,
    openRouterApiKey: cfg.openRouter.apiKey,
    openRouterBase: cfg.openRouter.base,
    embedModel: cfg.models.embed,
    embedDimensions: cfg.models.embedDimensions,
    tuning: cfg.rag,
  };
}
