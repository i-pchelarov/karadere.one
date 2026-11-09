// Тестове за сглобяването на промпта — чисти функции, без мрежа.

import { assert, assertEquals, assertStringIncludes } from "./test_assert.ts";
import {
  articleOf,
  buildContext,
  buildMessages,
  SYSTEM_PROMPT,
  uniqueArticles,
} from "./prompt.ts";
import type { Hit } from "./rag.ts";

function hit(over: Partial<Hit> = {}): Hit {
  return {
    id: "s-1",
    document_id: "zuchk",
    title: "Чл. 10а. Условия за лагеруване",
    content: "Лагеруването на плажа е забранено.",
    metadata: { article_number: "10а" },
    ...over,
  };
}

Deno.test("articleOf чете article_number", () => {
  assertEquals(articleOf(hit()), "10а");
});

Deno.test("articleOf пада към article и маха „Чл.“", () => {
  const h = hit({ metadata: { article: "Чл. 24в." } });
  assertEquals(articleOf(h), "24в");
});

Deno.test("articleOf връща null без номер", () => {
  assertEquals(articleOf(hit({ metadata: {} })), null);
  assertEquals(articleOf(hit({ metadata: null })), null);
});

Deno.test("buildContext номерира извадките", () => {
  const ctx = buildContext([hit(), hit({ id: "s-2", metadata: { article_number: "17а" } })]);
  assertStringIncludes(ctx, "[1] Чл. 10а");
  assertStringIncludes(ctx, "[2] Чл. 17а");
});

Deno.test("buildContext е празен без попадения", () => {
  assertEquals(buildContext([]), "");
});

Deno.test("buildMessages слага системния промпт първи", () => {
  const msgs = buildMessages([{ role: "user", content: "Здравей" }], []);
  assertEquals(msgs.length, 2);
  assertEquals(msgs[0].role, "system");
  assertEquals(msgs[0].content, SYSTEM_PROMPT);
  assertEquals(msgs[1].role, "user");
});

Deno.test("buildMessages вгражда контекста в системното съобщение", () => {
  const msgs = buildMessages([{ role: "user", content: "Може ли да лагерувам?" }], [hit()]);
  assertStringIncludes(msgs[0].content, "Извадки от нормативни актове");
  assertStringIncludes(msgs[0].content, "Чл. 10а");
  assertEquals(msgs[1].content, "Може ли да лагерувам?");
});

Deno.test("buildMessages пази историята непокътната", () => {
  const history = [
    { role: "user" as const, content: "А" },
    { role: "assistant" as const, content: "Б" },
    { role: "user" as const, content: "В" },
  ];
  const msgs = buildMessages(history, []);
  assertEquals(msgs.length, 4);
  assertEquals(msgs.slice(1), history);
});

Deno.test("uniqueArticles маха повторенията и празните", () => {
  const hits = [
    hit({ id: "a", metadata: { article_number: "10а" } }),
    hit({ id: "b", metadata: { article_number: "10а" } }), // дубликат
    hit({ id: "c", metadata: { article_number: "17а" } }),
    hit({ id: "d", metadata: {} }), // без номер
  ];
  assertEquals(uniqueArticles(hits), ["10а", "17а"]);
});

Deno.test("uniqueArticles пази реда на първата поява", () => {
  const hits = [
    hit({ id: "a", metadata: { article_number: "17а" } }),
    hit({ id: "b", metadata: { article_number: "10а" } }),
    hit({ id: "c", metadata: { article_number: "17а" } }),
  ];
  assertEquals(uniqueArticles(hits), ["17а", "10а"]);
});

Deno.test("uniqueArticles е празен без попадения", () => {
  assertEquals(uniqueArticles([]), []);
});

Deno.test("assert работи", () => {
  assert(true);
});
