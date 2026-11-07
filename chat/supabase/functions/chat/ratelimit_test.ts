// Офлайн тестове за лимитера (ratelimit.ts).
//
// Никаква мрежа: `fetch` се инжектира и отговаря като PostgREST RPC-то.
// Проверяваме извличането на IP (най-важната част — подправяем ли е входът),
// fail-open поведението и превръщането на отговора в RateLimitResult.

import { assert, assertEquals } from "./test_assert.ts";
import { checkRateLimit, clientIp, type RateLimitDeps } from "./ratelimit.ts";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://fn.test/chat", { method: "POST", headers });
}

// --- clientIp: редът на доверие ---------------------------------------------

Deno.test("clientIp: предпочита cf-connecting-ip", () => {
  const req = reqWith({
    "cf-connecting-ip": "203.0.113.7",
    "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    "x-real-ip": "9.9.9.9",
  });
  assertEquals(clientIp(req), "203.0.113.7");
});

Deno.test("clientIp: без cf взима ПОСЛЕДНИЯ от x-forwarded-for", () => {
  // Клиентът може да подправи началото на списъка; последният е добавен от
  // най-близкия доверен прокси и е най-достоверен.
  const req = reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" });
  assertEquals(clientIp(req), "203.0.113.9");
});

Deno.test("clientIp: подправен префикс не заблуждава", () => {
  const req = reqWith({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" });
  assertEquals(clientIp(req), "203.0.113.9");
});

Deno.test("clientIp: пада към x-real-ip", () => {
  assertEquals(clientIp(reqWith({ "x-real-ip": "198.51.100.3" })), "198.51.100.3");
});

Deno.test("clientIp: без нищо връща unknown", () => {
  assertEquals(clientIp(reqWith({})), "unknown");
});

Deno.test("clientIp: празни стойности се прескачат", () => {
  const req = reqWith({ "cf-connecting-ip": "  ", "x-forwarded-for": " , 203.0.113.9" });
  assertEquals(clientIp(req), "203.0.113.9");
});

// --- checkRateLimit ----------------------------------------------------------

function deps(
  fetchImpl: typeof fetch,
  overrides: Partial<RateLimitDeps> = {},
): RateLimitDeps {
  return {
    fetch: fetchImpl,
    supabaseUrl: "https://mock.supabase.test/rest/v1",
    serviceRoleKey: "service-key",
    config: { windowSeconds: 60, limit: 20 },
    ...overrides,
  };
}

Deno.test("checkRateLimit: изключен лимит не пипа мрежата", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("[]");
  }) as typeof fetch;
  const res = await checkRateLimit(
    reqWith({}),
    deps(fetchImpl, { config: { windowSeconds: 60, limit: 0 } }),
  );
  assertEquals(res.allowed, true);
  assertEquals(called, false);
});

Deno.test("checkRateLimit: липсващ service ключ не пипа мрежата", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("[]");
  }) as typeof fetch;
  const res = await checkRateLimit(reqWith({}), deps(fetchImpl, { serviceRoleKey: "" }));
  assertEquals(res.allowed, true);
  assertEquals(called, false);
});

Deno.test("checkRateLimit: разрешена заявка връща remaining", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify([{ allowed: true, remaining: 17, retry_after_seconds: 0 }]),
      { status: 200 },
    )) as typeof fetch;
  const res = await checkRateLimit(reqWith({ "cf-connecting-ip": "1.1.1.1" }), deps(fetchImpl));
  assertEquals(res.allowed, true);
  assertEquals(res.remaining, 17);
});

Deno.test("checkRateLimit: отказ връща Retry-After", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify([{ allowed: false, remaining: 0, retry_after_seconds: 42 }]),
      { status: 200 },
    )) as typeof fetch;
  const res = await checkRateLimit(reqWith({ "cf-connecting-ip": "1.1.1.1" }), deps(fetchImpl));
  assertEquals(res.allowed, false);
  assertEquals(res.retryAfterSeconds, 42);
});

Deno.test("checkRateLimit: праща IP-то и лимита към RPC-то", async () => {
  let captured: { url: string; body: unknown; auth: string | null } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured = {
      url,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("Authorization"),
    };
    return new Response(JSON.stringify([{ allowed: true, remaining: 19, retry_after_seconds: 0 }]));
  }) as typeof fetch;

  await checkRateLimit(reqWith({ "cf-connecting-ip": "203.0.113.5" }), deps(fetchImpl));
  assert(captured !== null, "fetch не е извикан");
  const c = captured as unknown as { url: string; body: Record<string, unknown>; auth: string | null };
  assert(c.url.endsWith("/rpc/chat_rate_limit_hit"), `грешен URL: ${c.url}`);
  assertEquals(c.body.p_ip, "203.0.113.5");
  assertEquals(c.body.p_window_seconds, 60);
  assertEquals(c.body.p_limit, 20);
  assertEquals(c.auth, "Bearer service-key");
});

Deno.test("checkRateLimit: HTTP грешка → fail-open", async () => {
  const fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const res = await checkRateLimit(reqWith({}), deps(fetchImpl));
  assertEquals(res.allowed, true);
});

Deno.test("checkRateLimit: мрежова грешка → fail-open", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await checkRateLimit(reqWith({}), deps(fetchImpl));
  assertEquals(res.allowed, true);
});

Deno.test("checkRateLimit: неочакван отговор → fail-open", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ nope: 1 }))) as typeof fetch;
  const res = await checkRateLimit(reqWith({}), deps(fetchImpl));
  assertEquals(res.allowed, true);
});
