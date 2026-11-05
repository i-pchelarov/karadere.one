// Офлайн тестове за чистите помощни функции на chat.js.
//
// DOM-частта (initChat) не се тества тук — тя е тънка връзка към sse.js, а
// цялата логика на протокола е покрита в sse_test.js. Тук проверяваме само
// това, което може да се счупи тихо: подготвянето на тялото, рязането на
// историята и сливането на цитатите.
//
//   deno test --allow-env --allow-net --allow-read chat_test.js
// (от директорията chat/web/js)

import { buildRequestBody, mergeArticles, trimHistory } from "./chat.js";
import {
  assert,
  assertEquals,
} from "../../supabase/functions/chat/test_assert.ts";

Deno.test("buildRequestBody: мапва историята и слага режим", () => {
  const history = [
    { role: "user", content: "въпрос" },
    { role: "assistant", content: "отговор" },
  ];
  assertEquals(buildRequestBody(history), {
    messages: [
      { role: "user", content: "въпрос" },
      { role: "assistant", content: "отговор" },
    ],
    mode: "auto",
  });
});

Deno.test("buildRequestBody: не изтича вътрешни полета", () => {
  const history = [{ role: "user", content: "в", id: 42, ts: 123 }];
  const body = buildRequestBody(history);
  assertEquals(Object.keys(body.messages[0]).sort(), ["content", "role"]);
});

Deno.test("buildRequestBody: подаден режим се запазва", () => {
  assertEquals(buildRequestBody([], "keyword").mode, "keyword");
});

Deno.test("trimHistory: под лимита не пипа", () => {
  const h = [{ role: "user", content: "1" }];
  assertEquals(trimHistory(h, 5), h);
});

Deno.test("trimHistory: над лимита пази последните", () => {
  const h = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: String(i) }));
  const out = trimHistory(h, 3);
  assertEquals(out.map((m) => m.content), ["7", "8", "9"]);
});

Deno.test("trimHistory: не мутира входа", () => {
  const h = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: String(i) }));
  const before = JSON.stringify(h);
  trimHistory(h, 2);
  assertEquals(JSON.stringify(h), before);
});

Deno.test("mergeArticles: слива без дубликати, в реда на идване", () => {
  assertEquals(mergeArticles(["10а"], ["10а", "5", "12"]), ["10а", "5", "12"]);
});

Deno.test("mergeArticles: празен вход връща копие", () => {
  const prev = ["1"];
  const out = mergeArticles(prev, []);
  assertEquals(out, ["1"]);
  // Нов масив, не същата референция (assertNotEquals прави дълбоко
  // сравнение, затова тук проверяваме идентичност директно).
  assert(out !== prev, "очакван е нов масив, а не същата референция");
});

Deno.test("mergeArticles: не мутира предишния масив", () => {
  const prev = ["1"];
  mergeArticles(prev, ["2"]);
  assertEquals(prev, ["1"]);
});
