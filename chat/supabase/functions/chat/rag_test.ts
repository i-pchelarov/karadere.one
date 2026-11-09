// Тестове за хибридното търсене — порт на rag/test_rag_query.py.
//
// Договорът не е „заявката връща редове“, а „отговорът съдържа разпоредбите,
// които реално уреждат лагеруването на плажа“. Въпрос за условията трябва да
// извади лагерните членове (Чл. 10а, Чл. 24в, Чл. 17а), а не несвързан член,
// който просто дели лексика (Чл. 4 — за свободния достъп до плажове).
//
// Пусни от тази директория:
//   deno task test
//
// Всичко върви офлайн: assert-ите са локални (test_assert.ts), а базата е
// локален mock (test_mock.ts) с реален корпус и реална косинусова близост.
// Няма мрежа, няма OpenRouter ключ, няма Supabase.

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./test_assert.ts";

import {
  escapeFilterValue,
  expandQuestion,
  extractTerms,
  runQuery,
  vectorIsWeak,
  type Hit,
} from "./rag.ts";

import { DEFAULT_TUNING } from "./config.ts";
import { CORPUS, makeMockDeps } from "./test_mock.ts";

const QUESTION = "При какви условия са разрешени свободното лагеруване на плажа?";

// Членове, които наистина уреждат лагеруване / временно поставяне на палатки,
// кемпери и каравани по Закона за устройство на Черноморското крайбрежие.
const CAMPING_ARTICLES = new Set(["10а", "24в", "17а"]);

// Лексика, която трябва да присъства в използваем отговор за лагеруване.
const CAMPING_VOCABULARY = ["палатки", "кемпери", "каравани"];

const RESULT_COUNT = 5;

function articleOf(hit: Hit): string {
  const meta = (hit.metadata ?? {}) as Record<string, unknown>;
  const number = meta.article_number;
  if (number) return String(number).trim().replace(/\.$/, "");
  const article = String(meta.article ?? "").trim().replace(/\.$/, "");
  return article.replace("Чл.", "").replace("чл.", "").trim();
}

// --- чисти функции (без мрежа) ----------------------------------------------
Deno.test("extractTerms маха стопдумите и пази предмета", () => {
  const terms = extractTerms(
    QUESTION,
    DEFAULT_TUNING.maxTerms,
    DEFAULT_TUNING.minTermLen,
  );
  assert(terms.includes("лагеруване"), `няма „лагеруване“: ${terms}`);
  assert(terms.includes("плажа"), `няма „плажа“: ${terms}`);
  for (const stopword of ["при", "са", "на"]) {
    assert(!terms.includes(stopword), `стопдума изтече: ${stopword}`);
  }
});

Deno.test("extractTerms пази номерата на членове", () => {
  const terms = extractTerms("Чл. 10а за палатки", 8, 3);
  assert(terms.some((t) => t.includes("10")), `номерът е изгубен: ${terms}`);
});

Deno.test("extractTerms спазва лимита", () => {
  const terms = extractTerms(QUESTION, 2, 3);
  assertEquals(terms.length, 2);
});

Deno.test("expandQuestion добавя лагерни синоними", () => {
  const expanded = expandQuestion(QUESTION);
  for (const word of CAMPING_VOCABULARY) {
    assertStringIncludes(expanded, word);
  }
});

Deno.test("expandQuestion добавя правната фраза за плажове", () => {
  assertStringIncludes(
    expandQuestion(QUESTION),
    "извън територията на морските плажове",
  );
});

Deno.test("expandQuestion не прави нищо без тригер", () => {
  assertEquals(expandQuestion("Колко е часът?"), "Колко е часът?");
});

Deno.test("expandQuestion не дублира синоними", () => {
  const expanded = expandQuestion(QUESTION);
  assertEquals(expanded.split("палатки").length - 1, 1);
});

Deno.test("escapeFilterValue неутрализира LIKE wildcards", () => {
  const escaped = escapeFilterValue("100%_a,b");
  assert(!escaped.replace("\\%", "").includes("%"), "неекраниран %");
  assert(!escaped.replace("\\,", "").includes(","), "неекранирана ,");
});

Deno.test("vectorIsWeak е weak при празен резултат", () => {
  const [weak, reason] = vectorIsWeak([], 5, DEFAULT_TUNING);
  assert(weak);
  assertStringIncludes(reason, "no vector hits");
});

Deno.test("vectorIsWeak е weak под прага за top similarity", () => {
  const [weak] = vectorIsWeak(
    [{ similarity: 0.30 }, { similarity: 0.29 }],
    5,
    DEFAULT_TUNING,
  );
  assert(weak, "ниската top similarity трябва да е weak");
});

Deno.test("vectorIsWeak не е weak при висока similarity и достатъчно попадения", () => {
  const [weak] = vectorIsWeak(
    [{ similarity: 0.80 }, { similarity: 0.70 }],
    5,
    DEFAULT_TUNING,
  );
  assert(!weak, "висока similarity с достатъчно попадения не е weak");
});

// --- срещу локалната mock база (без мрежа) -----------------------------------
Deno.test("лагерният въпрос връща лагерните разпоредби", async () => {
  const { deps } = makeMockDeps();
  const { trace, hits } = await runQuery(QUESTION, RESULT_COUNT, "auto", deps);

  assertEquals(trace.returned, RESULT_COUNT);
  assertEquals(hits.length, RESULT_COUNT);

  for (const hit of hits) {
    assert(hit.id, "попадение без id");
    assert(typeof hit.content === "string", "попадение без content");
    assert(hit.content.trim().length > 0, "празен content");
    assert(
      hit.matched_by === "vector" || hit.matched_by === "keyword",
      `невалиден matched_by: ${hit.matched_by}`,
    );
  }

  const articles = hits.map(articleOf);
  assert(
    articles.some((a) => CAMPING_ARTICLES.has(a)),
    `няма лагерна разпоредба в топ ${RESULT_COUNT}; членове: ${
      articles.join(", ")
    }`,
  );

  const blob = hits.map((h) => h.content ?? "").join(" ").toLowerCase();
  assert(
    CAMPING_VOCABULARY.some((w) => blob.includes(w)),
    `нито една от ${CAMPING_VOCABULARY.join(", ")} не се среща в резултата`,
  );
});

Deno.test("keyword пътят сам намира члена за условията", async () => {
  const { deps } = makeMockDeps();
  const { trace, hits } = await runQuery(QUESTION, RESULT_COUNT, "keyword", deps);

  assertEquals(trace.path, "keyword");
  assert(trace.terms && trace.terms.length > 0, "липсват термини в trace");

  const articles = hits.map(articleOf);
  assert(
    articles.includes("10а"),
    `keyword търсенето пропусна Чл. 10а; членове: ${articles.join(", ")}`,
  );
});

Deno.test("vector пътят намира лагерните членове по смисъл", async () => {
  const { deps } = makeMockDeps();
  const { trace, hits } = await runQuery(QUESTION, RESULT_COUNT, "vector", deps);

  assertEquals(trace.path, "vector");
  const articles = hits.map(articleOf);
  assert(
    articles.some((a) => CAMPING_ARTICLES.has(a)),
    `векторното търсене не намери лагерна разпоредба; членове: ${
      articles.join(", ")
    }`,
  );
});

Deno.test("auto режимът не спира на слаб векторен резултат", async () => {
  const { deps } = makeMockDeps();
  const { trace, hits } = await runQuery(QUESTION, RESULT_COUNT, "auto", deps);

  assert(
    trace.path === "vector" || trace.path === "keyword" ||
      trace.path === "vector+keyword",
    `невалиден path: ${trace.path}`,
  );
  assertEquals(trace.returned, hits.length);

  const [weak] = vectorIsWeak(
    hits.filter((h) => h.matched_by === "vector"),
    RESULT_COUNT,
    DEFAULT_TUNING,
  );
  if (weak) {
    assert(
      trace.path !== "vector",
      `векторният резултат беше слаб (${
        trace.vector_state ?? "?"
      }), но auto режимът го върна сам`,
    );
  }
});

Deno.test("празен корпус връща празен резултат, без да гърми", async () => {
  const { deps } = makeMockDeps({ corpus: [] });
  const { trace, hits } = await runQuery(QUESTION, RESULT_COUNT, "auto", deps);
  assertEquals(hits.length, 0);
  assertEquals(trace.returned, 0);
});

Deno.test("грешка в embeddings се покачва нагоре", async () => {
  const { deps } = makeMockDeps({ failOn: "embeddings" });
  let caught = false;
  try {
    await runQuery(QUESTION, RESULT_COUNT, "auto", deps);
  } catch (err) {
    caught = true;
    assertStringIncludes(String(err), "embedding HTTP 500");
  }
  assert(caught, "грешката от embeddings не се покачи");
});

Deno.test("грешка в keyword заявката се покачва нагоре", async () => {
  const { deps } = makeMockDeps({ failOn: "keyword" });
  let caught = false;
  try {
    await runQuery(QUESTION, RESULT_COUNT, "keyword", deps);
  } catch (err) {
    caught = true;
    assertStringIncludes(String(err), "keyword query HTTP 500");
  }
  assert(caught, "грешката от keyword заявката не се покачи");
});

Deno.test("корпусът съдържа лагерните членове", () => {
  const articles = CORPUS.map((s) => String(s.metadata.article_number));
  for (const a of CAMPING_ARTICLES) {
    assert(articles.includes(a), `липсва Чл. ${a} в mock корпуса`);
  }
});

Deno.test("assertThrows хваща хвърлена грешка", () => {
  assertThrows(() => {
    throw new Error("boom");
  });
});
