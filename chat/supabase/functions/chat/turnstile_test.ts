// Офлайн тестове за Turnstile проверката (turnstile.ts).
//
// Никаква мрежа: `fetch` се инжектира и отговаря като /siteverify.
// Проверяваме: изключване без secret, отказ при липсващ токен, успех/неуспех
// от Cloudflare и fail-closed при мрежова грешка.

import { assert, assertEquals } from "./test_assert.ts";
import { verifyTurnstile, type TurnstileDeps } from "./turnstile.ts";

function deps(fetchImpl: typeof fetch, secretKey = "secret"): TurnstileDeps {
  return { fetch: fetchImpl, secretKey, verifyUrl: "https://verify.test/siteverify" };
}

Deno.test("turnstile: без secret проверката се прескача", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  const res = await verifyTurnstile(undefined, "1.1.1.1", deps(fetchImpl, ""));
  assertEquals(res.ok, true);
  assertEquals(called, false);
});

Deno.test("turnstile: липсващ токен → отказ", async () => {
  const fetchImpl = (async () => new Response("{}")) as typeof fetch;
  const res = await verifyTurnstile(undefined, "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, false);
});

Deno.test("turnstile: празен токен → отказ", async () => {
  const fetchImpl = (async () => new Response("{}")) as typeof fetch;
  const res = await verifyTurnstile("   ", "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, false);
});

Deno.test("turnstile: успешна проверка", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
  const res = await verifyTurnstile("tok", "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, true);
});

Deno.test("turnstile: отказ от Cloudflare носи причина", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
      { status: 200 },
    )) as typeof fetch;
  const res = await verifyTurnstile("tok", "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, false);
  assert((res.reason ?? "").includes("invalid-input-response"), "причината липсва");
});

Deno.test("turnstile: праща secret, response и remoteip", async () => {
  let captured: { url: string; form: FormData } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured = { url, form: init?.body as FormData };
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch;

  await verifyTurnstile("tok-123", "203.0.113.9", deps(fetchImpl, "s3cret"));
  assert(captured !== null, "fetch не е извикан");
  const c = captured as unknown as { url: string; form: FormData };
  assertEquals(c.url, "https://verify.test/siteverify");
  assertEquals(c.form.get("secret"), "s3cret");
  assertEquals(c.form.get("response"), "tok-123");
  assertEquals(c.form.get("remoteip"), "203.0.113.9");
});

Deno.test("turnstile: unknown IP не се праща като remoteip", async () => {
  let form: FormData | null = null;
  const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
    form = init?.body as FormData;
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch;
  await verifyTurnstile("tok", "unknown", deps(fetchImpl));
  assertEquals((form as unknown as FormData).get("remoteip"), null);
});

Deno.test("turnstile: HTTP грешка → fail-closed", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 502 })) as typeof fetch;
  const res = await verifyTurnstile("tok", "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, false);
});

Deno.test("turnstile: мрежова грешка → fail-closed", async () => {
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const res = await verifyTurnstile("tok", "1.1.1.1", deps(fetchImpl));
  assertEquals(res.ok, false);
});

// --- action + hostname проверки ---------------------------------------------

function okFetch(payload: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success: true, ...payload }), { status: 200 })) as typeof fetch;
}

Deno.test("turnstile: съвпадащо action минава", async () => {
  const d = { ...deps(okFetch({ action: "chat" })), expectedAction: "chat" };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, true);
});

Deno.test("turnstile: чуждо action → отказ", async () => {
  const d = { ...deps(okFetch({ action: "signup" })), expectedAction: "chat" };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, false);
  assert((res.reason ?? "").includes("action"), "причината липсва");
});

Deno.test("turnstile: липсващо action при зададено очаквано → отказ", async () => {
  const d = { ...deps(okFetch({})), expectedAction: "chat" };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, false);
});

Deno.test("turnstile: празно очаквано action не проверява", async () => {
  const d = { ...deps(okFetch({ action: "каквото" })), expectedAction: "" };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, true);
});

Deno.test("turnstile: разрешен hostname минава", async () => {
  const d = {
    ...deps(okFetch({ hostname: "karadere.one" })),
    expectedHostnames: ["karadere.one", "www.karadere.one"],
  };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, true);
});

Deno.test("turnstile: чужд hostname → отказ", async () => {
  const d = {
    ...deps(okFetch({ hostname: "evil.example" })),
    expectedHostnames: ["karadere.one"],
  };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, false);
  assert((res.reason ?? "").includes("hostname"), "причината липсва");
});

Deno.test("turnstile: празен allowlist не проверява hostname", async () => {
  const d = { ...deps(okFetch({ hostname: "каквото" })), expectedHostnames: [] };
  const res = await verifyTurnstile("tok", "1.1.1.1", d);
  assertEquals(res.ok, true);
});
