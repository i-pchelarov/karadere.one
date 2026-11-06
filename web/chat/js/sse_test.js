// Офлайн тестове за SSE клиента (sse.js).
//
// Никаква мрежа: `fetch` се инжектира и връща ReadableStream от байтове, които
// сами сглобяваме. Пуска се с:
//   deno test --allow-env --allow-net --allow-read sse_test.js
// (от директорията web/chat/js)

import { createSseParser, streamChat } from "./sse.js";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "../../../chat/supabase/functions/chat/test_assert.ts";

const enc = new TextEncoder();

// Сглобява Response с тяло, което идва на посочените парчета (за да тестваме
// кадър, разцепен между два chunk-а).
function responseFromChunks(chunks, init = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, ...init });
}

// fetch, който връща предварително зададен отговор и записва заявката.
function mockFetch(response, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return response;
  };
}

// --- парсерът сам по себе си -------------------------------------------------

Deno.test("парсер: чете именувани събития и данни", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push("event: meta\ndata: {\"hits\":2}\n\n");
  p.push("event: delta\ndata: {\"text\":\"Здравей\"}\n\n");
  p.flush();
  assertEquals(seen, [
    ["meta", "{\"hits\":2}"],
    ["delta", "{\"text\":\"Здравей\"}"],
  ]);
});

Deno.test("парсер: кадър, разцепен между два chunk-а", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push("event: del");
  p.push("ta\ndata: {\"text\":\"ok\"}\n\n");
  p.flush();
  assertEquals(seen, [["delta", "{\"text\":\"ok\"}"]]);
});

Deno.test("парсер: CRLF редове", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push("event: done\r\ndata: {\"finish\":\"stop\"}\r\n\r\n");
  p.flush();
  assertEquals(seen, [["done", "{\"finish\":\"stop\"}"]]);
});

Deno.test("парсер: keepalive коментар се игнорира", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push(": ping\n\n");
  p.push("event: delta\ndata: {\"text\":\"x\"}\n\n");
  p.flush();
  assertEquals(seen, [["delta", "{\"text\":\"x\"}"]]);
});

Deno.test("парсер: многоредови data се събират с нов ред", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push("event: delta\ndata: ред1\ndata: ред2\n\n");
  p.flush();
  assertEquals(seen, [["delta", "ред1\nред2"]]);
});

Deno.test("парсер: flush доставя последен кадър без финален празен ред", () => {
  const seen = [];
  const p = createSseParser((event, data) => seen.push([event, data]));
  p.push("event: done\ndata: {\"finish\":\"stop\"}");
  assertEquals(seen, []); // още не е диспатчнат
  p.flush();
  assertEquals(seen, [["done", "{\"finish\":\"stop\"}"]]);
});

// --- streamChat: пълният поток ----------------------------------------------

Deno.test("streamChat: meta → delta → done", async () => {
  const calls = [];
  const resp = responseFromChunks([
    "event: meta\ndata: {\"articles\":[\"10а\"],\"hits\":1}\n\n",
    "event: delta\ndata: {\"text\":\"Според \"}\n\n",
    "event: delta\ndata: {\"text\":\"Чл. 10а\"}\n\n",
    "event: done\ndata: {\"finish\":\"stop\"}\n\n",
  ]);
  const metas = [];
  const deltas = [];
  let done = null;

  const res = await streamChat({
    url: "https://example.test/chat",
    body: { messages: [{ role: "user", content: "въпрос" }] },
    fetchImpl: mockFetch(resp, calls),
    onMeta: (m) => metas.push(m),
    onDelta: (d) => deltas.push(d.text),
    onDone: (d) => (done = d),
  });

  assertEquals(res.ok, true);
  assertEquals(res.done, true);
  assertEquals(metas.length, 1);
  assertEquals(metas[0].articles, ["10а"]);
  assertEquals(deltas, ["Според ", "Чл. 10а"]);
  assertEquals(done, { finish: "stop" });

  // заявката е POST с правилните хедъри и тяло
  assertEquals(calls.length, 1);
  assertEquals(calls[0].opts.method, "POST");
  assertEquals(calls[0].opts.headers.Accept, "text/event-stream");
  assertStringIncludes(calls[0].opts.headers["Content-Type"], "application/json");
  assertEquals(JSON.parse(calls[0].opts.body).messages[0].content, "въпрос");
});

Deno.test("streamChat: warning не спира потока", async () => {
  const resp = responseFromChunks([
    "event: warning\ndata: {\"message\":\"retrieval: timeout\"}\n\n",
    "event: delta\ndata: {\"text\":\"Отговор без цитати\"}\n\n",
    "event: done\ndata: {\"finish\":\"stop\"}\n\n",
  ]);
  const warnings = [];
  const deltas = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onWarning: (w) => warnings.push(w.message),
    onDelta: (d) => deltas.push(d.text),
  });
  assertEquals(res.ok, true);
  assertEquals(res.done, true);
  assertEquals(warnings, ["retrieval: timeout"]);
  assertEquals(deltas, ["Отговор без цитати"]);
});

Deno.test("streamChat: HTTP грешка → onError със статус, ok=false", async () => {
  const resp = new Response("твърде много заявки", { status: 429 });
  const errors = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onError: (e) => errors.push(e),
  });
  assertEquals(res.ok, false);
  assertEquals(res.status, 429);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].status, 429);
  assertStringIncludes(errors[0].message, "429");
});

Deno.test("streamChat: мрежова грешка при fetch → ok=false", async () => {
  const errors = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: async () => {
      throw new Error("мрежата падна");
    },
    onError: (e) => errors.push(e),
  });
  assertEquals(res.ok, false);
  assertEquals(res.done, false);
  assertStringIncludes(errors[0].message, "мрежата падна");
});

Deno.test("streamChat: event: error → ok=false, но done се отчита", async () => {
  const resp = responseFromChunks([
    "event: delta\ndata: {\"text\":\"частично\"}\n\n",
    "event: error\ndata: {\"message\":\"LLM HTTP 500\"}\n\n",
  ]);
  const errors = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onError: (e) => errors.push(e),
  });
  assertEquals(res.ok, false);
  assertEquals(res.done, false);
  assertEquals(errors[0].message, "LLM HTTP 500");
});

Deno.test("streamChat: не-JSON данни не чупят потока", async () => {
  const resp = responseFromChunks([
    "event: delta\ndata: не-е-json\n\n",
    "event: done\ndata: {\"finish\":\"stop\"}\n\n",
  ]);
  const deltas = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onDelta: (d) => deltas.push(d),
  });
  assertEquals(res.ok, true);
  assertEquals(res.done, true);
  assertEquals(deltas, [{ raw: "не-е-json" }]);
});

Deno.test("streamChat: непознато събитие се прескача", async () => {
  const resp = responseFromChunks([
    "event: непознато\ndata: {\"x\":1}\n\n",
    "event: done\ndata: {\"finish\":\"stop\"}\n\n",
  ]);
  let touched = false;
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onMeta: () => (touched = true),
    onDelta: () => (touched = true),
  });
  assertEquals(res.ok, true);
  assertEquals(res.done, true);
  assertEquals(touched, false);
});

Deno.test("streamChat: отговор без тяло → ok=false", async () => {
  const resp = new Response(null, { status: 200 });
  const errors = [];
  const res = await streamChat({
    url: "https://example.test/chat",
    body: {},
    fetchImpl: mockFetch(resp),
    onError: (e) => errors.push(e),
  });
  assertEquals(res.ok, false);
  assert(errors.length === 1, "очаквана е една грешка");
});
