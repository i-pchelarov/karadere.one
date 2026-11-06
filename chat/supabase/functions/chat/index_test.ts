// E2E тестове за Edge Function `chat` — целият поток без мрежа.
//
// Подаваме фалшив fetch, който отговаря на retrieval заявките (чрез mock
// корпуса) и на `/chat/completions` с истински SSE поток. Проверяваме, че
// клиентът получава meta → delta… → done и че контекстът е стигнал до модела.

import { assert, assertEquals, assertStringIncludes } from "./test_assert.ts";
import { handleChat, modelChain, type HandlerOverrides } from "./index.ts";
import type { AppConfig } from "./config.ts";
import { DEFAULT_TUNING } from "./config.ts";
import { makeMockDeps } from "./test_mock.ts";

function testConfig(): AppConfig {
  return {
    supabase: { url: "https://mock.supabase.test/rest/v1", anonKey: "mock-anon" },
    openRouter: { apiKey: "mock-key", base: "https://mock.openrouter.test/api/v1" },
    models: {
      chat: "mock/chat",
      chatFallbacks: ["mock/chat-2", "mock/chat-3"],
      embed: "mock/embed",
      embedDimensions: 768,
    },
    rag: DEFAULT_TUNING,
    limits: { maxMessages: 20, maxMessageChars: 4000, maxTokens: 1200, topK: 5, reasoning: false },
    cors: { allowedOrigin: "https://karadere.one" },
    turnstile: { secretKey: "" },
  };
}

// Сглобява fetch, който: (1) обслужва retrieval през mock-а, (2) отговаря на
// chat/completions със SSE поток от подадените парчета.
function makeFetch(chunks: string[], captured?: { body?: unknown }) {
  const mock = makeMockDeps();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;

    if (url.endsWith("/chat/completions")) {
      if (captured) captured.body = JSON.parse(String(init?.body ?? "{}"));
      const lines = chunks.map((c) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
      ).join("") + "data: [DONE]\n\n";
      return new Response(lines, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return await mock.fetch(input as string, init);
  }) as typeof fetch;
}

// Чете SSE потока и връща списък от { event, data }.
async function readSse(resp: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await resp.text();
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    out.push({ event, data: data ? JSON.parse(data) : null });
  }
  return out;
}

function post(body: unknown): Request {
  return new Request("https://fn.test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const QUESTION = "При какви условия е разрешено лагеруването на плажа?";

Deno.test("e2e: потокът дава meta → delta → done", async () => {
  const overrides: HandlerOverrides = {
    config: testConfig(),
    fetch: makeFetch(["Лагеруването ", "на плажа ", "е забранено."]),
  };
  const resp = await handleChat(post({ messages: [{ role: "user", content: QUESTION }] }), overrides);

  assertEquals(resp.status, 200);
  assertStringIncludes(resp.headers.get("Content-Type") ?? "", "text/event-stream");
  assertEquals(resp.headers.get("Access-Control-Allow-Origin"), "https://karadere.one");

  const events = await readSse(resp);
  const names = events.map((e) => e.event);
  assertEquals(names[0], "meta");
  assertEquals(names[names.length - 1], "done");
  assert(names.includes("delta"), "няма delta събития");

  const text = events.filter((e) => e.event === "delta")
    .map((e) => (e.data as { text: string }).text).join("");
  assertEquals(text, "Лагеруването на плажа е забранено.");
});

Deno.test("e2e: meta носи намерените членове", async () => {
  const overrides: HandlerOverrides = {
    config: testConfig(),
    fetch: makeFetch(["ок"]),
  };
  const resp = await handleChat(post({ messages: [{ role: "user", content: QUESTION }] }), overrides);
  const events = await readSse(resp);
  const meta = events.find((e) => e.event === "meta")!.data as {
    articles: string[];
    hits: number;
  };
  assert(meta.hits > 0, "няма попадения");
  assert(meta.articles.length > 0, "няма членове в meta");
});

Deno.test("e2e: контекстът стига до модела", async () => {
  const captured: { body?: unknown } = {};
  const overrides: HandlerOverrides = {
    config: testConfig(),
    fetch: makeFetch(["ок"], captured),
  };
  const resp = await handleChat(post({ messages: [{ role: "user", content: QUESTION }] }), overrides);
  await readSse(resp); // изчитаме потока, за да се изпълни start() докрай

  const body = captured.body as { messages: Array<{ role: string; content: string }>; stream: boolean };
  assertEquals(body.stream, true);
  assertEquals(body.messages[0].role, "system");
  assertStringIncludes(body.messages[0].content, "Извадки от нормативни актове");
  assertEquals(body.messages[body.messages.length - 1].content, QUESTION);
});

Deno.test("e2e: грешка В ПОТОКА на LLM стига до клиента като error", async () => {
  // Точно случаят, който даваше meta → done без delta: OpenRouter праща
  // грешката като `data: {"error":{...}}` и после [DONE].
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      const body = `data: ${
        JSON.stringify({ error: { message: "upstream rate-limited", code: 429 } })
      }\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return await makeMockDeps().fetch(input as string, init);
  }) as typeof fetch;

  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: fetchImpl },
  );
  const events = await readSse(resp);
  const names = events.map((e) => e.event);
  assert(names.includes("error"), "грешката в потока трябва да стигне като error");
  const err = events.find((e) => e.event === "error")!.data as { message: string };
  assertStringIncludes(err.message, "upstream rate-limited");
  assertEquals(names.includes("done"), false, "не бива да има done след error");
});

Deno.test("e2e: празен отговор дава warning, не мълчалив done", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      // Само finish_reason, без нито един content chunk.
      const body = `data: ${
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })
      }\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return await makeMockDeps().fetch(input as string, init);
  }) as typeof fetch;

  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: fetchImpl },
  );
  const events = await readSse(resp);
  const names = events.map((e) => e.event);
  assert(names.includes("warning"), "празният отговор трябва да даде warning");
  const done = events.find((e) => e.event === "done")!.data as { deltas: number; finish: string };
  assertEquals(done.deltas, 0);
  assertEquals(done.finish, "length");
});

Deno.test("e2e: не-SSE JSON отговор не се губи", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "обикновен JSON" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return await makeMockDeps().fetch(input as string, init);
  }) as typeof fetch;

  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: fetchImpl },
  );
  const events = await readSse(resp);
  const text = events.filter((e) => e.event === "delta")
    .map((e) => (e.data as { text: string }).text).join("");
  assertEquals(text, "обикновен JSON");
});

Deno.test("e2e: заявката изключва reasoning по подразбиране", async () => {
  const captured: { body?: unknown } = {};
  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: makeFetch(["ок"], captured) },
  );
  await readSse(resp);

  const body = captured.body as { reasoning?: { enabled?: boolean }; usage?: unknown };
  assertEquals(body.reasoning, { enabled: false });
  assertEquals(body.usage, { include: true });
});

Deno.test("e2e: при CHAT_REASONING=1 reasoning не се изключва", async () => {
  const captured: { body?: unknown } = {};
  const cfg = testConfig();
  cfg.limits.reasoning = true;
  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: cfg, fetch: makeFetch(["ок"], captured) },
  );
  await readSse(resp);

  const body = captured.body as { reasoning?: unknown };
  assertEquals(body.reasoning, undefined, "не бива да праща reasoning при включен");
});

Deno.test("e2e: отрязан отговор дава warning и usage в done", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      const body = `data: ${
        JSON.stringify({ choices: [{ delta: { content: "отрязан" } }] })
      }\n\ndata: ${
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "length" }],
          usage: { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 900 } },
        })
      }\n\ndata: [DONE]\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return await makeMockDeps().fetch(input as string, init);
  }) as typeof fetch;

  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: fetchImpl },
  );
  const events = await readSse(resp);
  const names = events.map((e) => e.event);
  assert(names.includes("warning"), "отрязаният отговор трябва да даде warning");

  const done = events.find((e) => e.event === "done")!.data as {
    finish: string;
    deltas: number;
    usage: { completion?: number; reasoning?: number } | null;
  };
  assertEquals(done.finish, "length");
  assertEquals(done.deltas, 1);
  assertEquals(done.usage?.completion, 1200);
  assertEquals(done.usage?.reasoning, 900);
});

Deno.test("e2e: retrieval грешка дава warning, но отговорът продължава", async () => {
  const mock = makeMockDeps({ failOn: "embeddings" });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/chat/completions")) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "без цитати" } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return await mock.fetch(input as string, init);
  }) as typeof fetch;

  const resp = await handleChat(
    post({ messages: [{ role: "user", content: QUESTION }] }),
    { config: testConfig(), fetch: fetchImpl },
  );
  const events = await readSse(resp);
  const names = events.map((e) => e.event);
  assert(names.includes("warning"), "няма warning при паднал retrieval");
  assert(names.includes("done"), "потокът не завърши с done");
  assertEquals(names.includes("meta"), false, "meta не бива да излиза при грешка");
});

Deno.test("валидация: празно тяло → 400", async () => {
  const resp = await handleChat(post({}), { config: testConfig(), fetch: makeFetch(["x"]) });
  assertEquals(resp.status, 400);
});

Deno.test("валидация: невалидна роля → 400", async () => {
  const resp = await handleChat(
    post({ messages: [{ role: "hacker", content: "x" }] }),
    { config: testConfig(), fetch: makeFetch(["x"]) },
  );
  assertEquals(resp.status, 400);
});

Deno.test("валидация: твърде дълго съобщение → 400", async () => {
  const resp = await handleChat(
    post({ messages: [{ role: "user", content: "а".repeat(5000) }] }),
    { config: testConfig(), fetch: makeFetch(["x"]) },
  );
  assertEquals(resp.status, 400);
});

Deno.test("валидация: без user съобщение → 400", async () => {
  const resp = await handleChat(
    post({ messages: [{ role: "assistant", content: "здравей" }] }),
    { config: testConfig(), fetch: makeFetch(["x"]) },
  );
  assertEquals(resp.status, 400);
});

Deno.test("OPTIONS връща 204 с CORS", async () => {
  const req = new Request("https://fn.test/chat", { method: "OPTIONS" });
  const resp = await handleChat(req, { config: testConfig(), fetch: makeFetch(["x"]) });
  assertEquals(resp.status, 204);
  assertEquals(resp.headers.get("Access-Control-Allow-Origin"), "https://karadere.one");
});

Deno.test("GET връща 405", async () => {
  const req = new Request("https://fn.test/chat", { method: "GET" });
  const resp = await handleChat(req, { config: testConfig(), fetch: makeFetch(["x"]) });
  assertEquals(resp.status, 405);
});

Deno.test("modelChain: основният е пръв, после резервните", () => {
  assertEquals(modelChain(testConfig()), ["mock/chat", "mock/chat-2", "mock/chat-3"]);
});

Deno.test("modelChain: без резервни връща само основния", () => {
  const cfg = testConfig();
  cfg.models.chatFallbacks = [];
  assertEquals(modelChain(cfg), ["mock/chat"]);
});

Deno.test("modelChain: отрязва до 3 модела (лимит на OpenRouter)", () => {
  const cfg = testConfig();
  cfg.models.chatFallbacks = ["mock/chat-2", "mock/chat-3", "mock/chat-4", "mock/chat-5"];
  const chain = modelChain(cfg);
  assertEquals(chain.length, 3);
  assertEquals(chain, ["mock/chat", "mock/chat-2", "mock/chat-3"]);
});

Deno.test("e2e: заявката към LLM праща `models` масив, не `model`", async () => {
  const captured: { body?: unknown } = {};
  const overrides: HandlerOverrides = {
    config: testConfig(),
    fetch: makeFetch(["ок"], captured),
  };
  const resp = await handleChat(post({ messages: [{ role: "user", content: QUESTION }] }), overrides);
  await readSse(resp);

  const body = captured.body as { models?: string[]; model?: string };
  assertEquals(body.models, ["mock/chat", "mock/chat-2", "mock/chat-3"]);
  assertEquals(body.model, undefined, "не бива да праща `model` заедно с `models`");
});
