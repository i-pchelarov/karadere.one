// Локална „мокра“ база за тестове — фалшив fetch, който отговаря на същите
// заявки, които rag.ts прави към Supabase (PostgREST + RPC) и OpenRouter.
//
// Защо: тестовете не бива да зависят от мрежа, от валиден OpenRouter ключ или
// от състоянието на истинската база. Тук има реален корпус, реален hashing
// embedding и реална косинусова близост — поведението е същото, само данните
// са локални.
//
// Договорът, който mock-ът спазва (същият като продукцията):
//   POST {openRouterBase}/embeddings
//     → { data: [{ index: 0, embedding: number[] }] }
//   POST {supabaseUrl}/rpc/match_document_sections
//     body: { query_embedding, match_threshold, match_count }
//     → редове с `similarity`, филтрирани по праг, подредени низходящо
//   GET  {supabaseUrl}/document_sections?or=(...)&select=...&limit=N
//     → редове, съдържащи поне един от ilike термовете

import type { RagDeps } from "./config.ts";
import { DEFAULT_TUNING } from "./config.ts";

export interface MockSection {
  id: string;
  document_id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

// Реалистични разпоредби от ЗУЧК. Лагерните членове (10а, 17а, 24в) споделят
// лексиката на въпроса, за да може и векторният, и keyword пътят да ги намерят.
export const CORPUS: MockSection[] = [
  {
    id: "s-4",
    document_id: "zuchk",
    title: "Чл. 4. Свободен достъп до морските плажове",
    content:
      "Морските плажове са публична държавна собственост и достъпът до тях е свободен за всички граждани. Никой не може да ограничава свободния достъп до плажа и до морските води.",
    metadata: { article_number: "4", source: "ЗУЧК" },
  },
  {
    id: "s-8",
    document_id: "zuchk",
    title: "Чл. 8. Строителство в крайбрежната зона",
    content:
      "В крайбрежната зона се забранява строителството на нови сгради и съоръжения, освен ако не е предвидено друго в устройствения план на общината.",
    metadata: { article_number: "8", source: "ЗУЧК" },
  },
  {
    id: "s-10a",
    document_id: "zuchk",
    title: "Чл. 10а. Условия за поставяне на палатки, кемпери и каравани",
    content:
      "Поставянето на палатки, кемпери, каравани и други преместваеми обекти за лагеруване се разрешава само на определени от общината места, извън територията на морските плажове. Лицата, които желаят да лагеруват, подават заявление до кмета на общината, в чиято територия е мястото. Свободното лагеруване на плажа е забранено.",
    metadata: { article_number: "10а", source: "ЗУЧК" },
  },
  {
    id: "s-12",
    document_id: "zuchk",
    title: "Чл. 12. Сервитутни зони и достъп",
    content:
      "Сервитутните зони осигуряват достъп до морските плажове и до водните площи. В тези зони не се разрешава поставяне на преместваеми обекти, включително палатки и каравани.",
    metadata: { article_number: "12", source: "ЗУЧК" },
  },
  {
    id: "s-15",
    document_id: "zuchk",
    title: "Чл. 15. Водни площи и акватория",
    content:
      "Водните площи се ползват за обществен достъп и водни спортове. Движението на плавателни средства се урежда с наредба на министъра.",
    metadata: { article_number: "15", source: "ЗУЧК" },
  },
  {
    id: "s-17a",
    document_id: "zuchk",
    title: "Чл. 17а. Забрана за лагеруване извън определените места",
    content:
      "Забранява се лагеруването, както и поставянето на палатки, кемпери и каравани извън местата, определени за това. Забраната важи и за територията на морските плажове.",
    metadata: { article_number: "17а", source: "ЗУЧК" },
  },
  {
    id: "s-21",
    document_id: "zuchk",
    title: "Чл. 21. Санкции за нарушения",
    content:
      "За поставяне на палатки, кемпери или каравани на забранени места се налага глоба на физическите лица и имуществена санкция на юридическите лица.",
    metadata: { article_number: "21", source: "ЗУЧК" },
  },
  {
    id: "s-24v",
    document_id: "zuchk",
    title: "Чл. 24в. Временни преместваеми обекти",
    content:
      "Временните преместваеми обекти, включително палатки, кемпери и каравани, се поставят въз основа на разрешение за поставяне и по схема, одобрена от общината. Лагеруването на плажа се забранява.",
    metadata: { article_number: "24в", source: "ЗУЧК" },
  },
];

const WORD_RE = /[0-9a-zA-Z\u0400-\u04FF]+/g;

// FNV-1a — детерминистичен hashing, за да е възпроизводим всеки тест.
function hashWord(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Bag-of-words вектор с L2 нормализация. Косинусът между два такива вектора
// е реална семантична близост по съвпадащи думи — достатъчно за тестове.
export function embedText(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const raw of text.toLowerCase().match(WORD_RE) ?? []) {
    const idx = hashWord(raw) % dims;
    vec[idx] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export interface MockOptions {
  corpus?: MockSection[];
  // Ако е зададено, mock-ът връща тази грешка вместо отговор (за тестове на
  // error пътя).
  failOn?: "embeddings" | "rpc" | "keyword";
}

export interface MockHandle {
  fetch: typeof fetch;
  calls: string[];
  deps: RagDeps;
}

export const MOCK_SUPABASE_URL = "https://mock.supabase.test/rest/v1";
export const MOCK_OPENROUTER_BASE = "https://mock.openrouter.test/api/v1";
export const MOCK_ANON_KEY = "mock-anon-key";
export const MOCK_API_KEY = "mock-openrouter-key";

export function makeMockDeps(opts: MockOptions = {}): MockHandle {
  const corpus = opts.corpus ?? CORPUS;
  const calls: string[] = [];
  const dims = DEFAULT_TUNING ? 768 : 768;

  // Кешираме векторите на корпуса — изчисляват се веднъж.
  const corpusVectors = new Map<string, number[]>();
  const vectorOf = (section: MockSection): number[] => {
    let v = corpusVectors.get(section.id);
    if (!v) {
      v = embedText(`${section.title} ${section.content}`, dims);
      corpusVectors.set(section.id, v);
    }
    return v;
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);

    // --- OpenRouter embeddings ---
    if (url.endsWith("/embeddings")) {
      if (opts.failOn === "embeddings") {
        return json({ error: { message: "mock failure", code: 500 } }, 500);
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const requested = Number(body.dimensions ?? dims);
      const text = String((body.input ?? [""])[0] ?? "");
      return json({
        data: [{ index: 0, embedding: embedText(text, requested) }],
        model: body.model,
      });
    }

    // --- RPC match_document_sections ---
    if (url.includes("/rpc/match_document_sections")) {
      if (opts.failOn === "rpc") {
        return json({ message: "mock rpc failure" }, 500);
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const query: number[] = body.query_embedding ?? [];
      const threshold = Number(body.match_threshold ?? 0);
      const count = Number(body.match_count ?? 5);

      const scored = corpus
        .map((section) => ({
          ...section,
          similarity: cosine(query, vectorOf(section)),
        }))
        .filter((row) => row.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, count);

      return json(scored);
    }

    // --- PostgREST document_sections?or=(...) ---
    if (url.includes("/document_sections")) {
      if (opts.failOn === "keyword") {
        return json({ message: "mock keyword failure" }, 500);
      }
      const parsed = new URL(url);
      const or = parsed.searchParams.get("or") ?? "";
      const limit = Number(parsed.searchParams.get("limit") ?? "100");

      // Извличаме термовете от `content.ilike.%term%` / `title.ilike.%term%`.
      const terms: string[] = [];
      for (const m of or.matchAll(/\.ilike\.%([^%]*)%/g)) {
        terms.push(m[1].replace(/\\(.)/g, "$1").toLowerCase());
      }

      const rows = corpus
        .filter((section) => {
          const hay = `${section.title} ${section.content}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        })
        .slice(0, limit)
        .map(({ id, document_id, title, content, metadata }) => ({
          id,
          document_id,
          title,
          content,
          metadata,
        }));

      return json(rows);
    }

    return json({ message: `unexpected mock URL: ${url}` }, 404);
  };

  const deps: RagDeps = {
    fetch: fetchImpl as typeof fetch,
    supabaseUrl: MOCK_SUPABASE_URL,
    supabaseAnonKey: MOCK_ANON_KEY,
    openRouterApiKey: MOCK_API_KEY,
    openRouterBase: MOCK_OPENROUTER_BASE,
    embedModel: "mock/embed",
    embedDimensions: dims,
    tuning: DEFAULT_TUNING,
  };

  return { fetch: fetchImpl as typeof fetch, calls, deps };
}
