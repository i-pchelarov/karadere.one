// Хибридно търсене в RAG хранилището (Supabase pgvector) — порт на
// rag/rag_query.mjs за Deno / Supabase Edge Functions.
//
// Разлики спрямо Node варианта:
//   * няма глобални константи — всичко идва през `deps` (RagDeps);
//   * използва SUPABASE_ANON_KEY + read RLS вместо service_role;
//   * хвърля грешки вместо process.exit — викащият решава как да отговори.
//
// Стратегия (същата като оригинала):
//   1. Векторно търсене през RPC `match_document_sections`.
//   2. Ако семантичният резултат е слаб (няма попадения, top similarity под
//      прага или твърде малко попадения) — пада към keyword търсене по
//      PostgREST `ilike` OR филтри, ранкирано по брой съвпаднали термини.

import type { RagDeps } from "./config.ts";

// --- типове ------------------------------------------------------------------
export type Mode = "auto" | "vector" | "keyword";

export interface Hit {
  id: string;
  document_id: string;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  similarity?: number;
  matched_terms?: string[];
  keyword_score?: number;
  matched_by?: "vector" | "keyword";
}

export interface Trace {
  question: string;
  mode: Mode;
  match_count: number;
  expanded?: string;
  terms?: string[];
  path?: "vector" | "keyword" | "vector+keyword";
  vector_state?: string;
  fallback_hits?: number;
  returned?: number;
}

export interface QueryResult {
  trace: Trace;
  hits: Hit[];
}

// --- стопдуми ----------------------------------------------------------------
const BULGARIAN_STOPWORDS = new Set([
  "ако", "али", "ама", "бе", "без", "беше", "би", "бил", "била", "били",
  "било", "близо", "бъдат", "бъде", "бъдеш", "биват", "във", "върху",
  "всички", "всичко", "всеки", "всяка", "всяко", "где", "да", "дали",
  "до", "докато", "дори", "друг", "друга", "други", "друго", "е", "едва",
  "един", "една", "едно", "за", "зад", "заедно", "заради", "защо", "и",
  "или", "им", "има", "имам", "имаш", "имаше", "искам", "как", "каква",
  "какви", "какво", "какъв", "кога", "когато", "кого", "което", "които",
  "кой", "който", "коя", "която", "към", "където", "ли", "ме", "между",
  "ми", "много", "може", "можем", "можеш", "моя", "моят", "моята", "на",
  "над", "най", "нас", "не", "него", "негов", "нея", "ни", "ние", "нищо",
  "но", "обаче", "около", "онзи", "от", "пак", "по", "под", "поне",
  "после", "при", "просто", "преди", "през", "с", "са", "сам", "само",
  "се", "сега", "си", "сме", "со", "сред", "срещу", "сте", "съм", "със",
  "също", "така", "там", "те", "тези", "ти", "то", "това", "тогава",
  "този", "той", "толкова", "тоя", "тук", "тъй", "тя", "тях", "у", "ха",
  "хайде", "що", "ще", "я",
]);

const ENGLISH_STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as",
  "at", "be", "been", "but", "by", "can", "could", "did", "do", "does",
  "for", "from", "get", "had", "has", "have", "how", "if", "in", "into",
  "is", "it", "its", "just", "me", "more", "most", "my", "no", "not", "of",
  "on", "or", "our", "out", "should", "so", "some", "such", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "to",
  "too", "up", "was", "we", "were", "what", "when", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

const STOPWORDS = new Set([...BULGARIAN_STOPWORDS, ...ENGLISH_STOPWORDS]);

// Правни синоними: въпросът е на битов език, законът — на юридически.
// Разширяването поправя и двата пътя наведнъж — embedding-ът сочи към
// лагерните разпоредби, а keyword fallback-ът търси думите, които законът
// реално използва.
const LEGAL_SYNONYMS: Record<string, string[]> = {
  "лагеруване": ["палатки", "кемпери", "каравани", "преместваеми обекти"],
  "лагерувам": ["палатки", "кемпери", "каравани"],
  "палатка": ["палатки", "кемпери", "каравани"],
  "плаж": ["морски плажове", "извън територията на морските плажове"],
  "плажа": ["морски плажове", "извън територията на морските плажове"],
  "плажове": ["морски плажове"],
};

const WORD_RE = /[0-9a-zA-Z\u0400-\u04FF]+/g;

// --- чисти функции -----------------------------------------------------------
export function expandQuestion(question: string): string {
  const lowered = question.toLowerCase();
  const extra: string[] = [];
  for (const [trigger, synonyms] of Object.entries(LEGAL_SYNONYMS)) {
    if (lowered.includes(trigger)) extra.push(...synonyms);
  }
  if (extra.length === 0) return question;
  return `${question} ${[...new Set(extra)].join(" ")}`;
}

export function extractTerms(
  question: string,
  limit: number,
  minTermLen: number,
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of question.match(WORD_RE) ?? []) {
    const word = raw.trim().toLowerCase();
    if (seen.has(word) || STOPWORDS.has(word)) continue;
    if (word.length < minTermLen && !/^\d+$/.test(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  terms.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return terms.slice(0, limit);
}

export function escapeFilterValue(value: string): string {
  // `%` и `_` са LIKE wildcards и не бива да изтичат от user input; `,` и `)`
  // биха счупили OR филтъра, а `*` е wildcard на самия PostgREST.
  return value.replace(/[\\"%_*,()]/g, (ch) => `\\${ch}`);
}

export function vectorIsWeak(
  hits: Array<{ similarity?: number }>,
  count: number,
  tuning: RagDeps["tuning"],
): [boolean, string] {
  if (hits.length === 0) return [true, "no vector hits"];
  const top = Math.max(...hits.map((h) => h.similarity ?? 0));
  if (top < tuning.confidentTop) {
    return [
      true,
      `top similarity ${top.toFixed(3)} < confident ${
        tuning.confidentTop.toFixed(2)
      }`,
    ];
  }
  if (top < tuning.weakTop) {
    return [
      true,
      `top similarity ${top.toFixed(3)} < ${tuning.weakTop.toFixed(2)}`,
    ];
  }
  const want = Math.min(tuning.minHits, count);
  if (hits.length < want) {
    return [true, `only ${hits.length} hit(s), wanted ${want}`];
  }
  return [false, `top similarity ${top.toFixed(3)}`];
}

// --- HTTP помощни ------------------------------------------------------------
function supabaseBase(deps: RagDeps): string {
  return deps.supabaseUrl.replace(/\/+$/, "");
}

function supabaseHeaders(deps: RagDeps): Record<string, string> {
  return {
    apikey: deps.supabaseAnonKey,
    Authorization: `Bearer ${deps.supabaseAnonKey}`,
    "Content-Type": "application/json",
  };
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

// --- векторен път ------------------------------------------------------------
export async function embed(text: string, deps: RagDeps): Promise<number[]> {
  const resp = await deps.fetch(`${deps.openRouterBase}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: deps.embedModel,
      input: [text],
      dimensions: deps.embedDimensions,
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `embedding HTTP ${resp.status}: ${await readErrorBody(resp)}`,
    );
  }
  const obj = await resp.json();
  const items: Array<{ index?: number; embedding: number[] }> = obj.data ?? [];
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vec = items[0]?.embedding;
  if (!vec) throw new Error("embedding response had no data[0].embedding");
  if (vec.length !== deps.embedDimensions) {
    throw new Error(
      `expected ${deps.embedDimensions} dims, got ${vec.length}`,
    );
  }
  return vec;
}

export async function rpcMatch(
  vec: number[],
  threshold: number,
  count: number,
  deps: RagDeps,
): Promise<Hit[]> {
  const resp = await deps.fetch(
    `${supabaseBase(deps)}/rpc/match_document_sections`,
    {
      method: "POST",
      headers: supabaseHeaders(deps),
      body: JSON.stringify({
        query_embedding: vec,
        match_threshold: threshold,
        match_count: count,
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`rpc HTTP ${resp.status}: ${await readErrorBody(resp)}`);
  }
  return await resp.json();
}

// --- keyword fallback --------------------------------------------------------
export async function keywordSearch(
  terms: string[],
  count: number,
  deps: RagDeps,
): Promise<Hit[]> {
  if (terms.length === 0) return [];
  const clauses: string[] = [];
  for (const term of terms) {
    const safe = escapeFilterValue(term);
    clauses.push(`content.ilike.%${safe}%`);
    clauses.push(`title.ilike.%${safe}%`);
  }
  const params = new URLSearchParams({
    or: `(${clauses.join(",")})`,
    select: "id,document_id,title,content,metadata",
    limit: String(
      Math.max(count * deps.tuning.fetchFactor, deps.tuning.fetchLimit),
    ),
  });
  const resp = await deps.fetch(
    `${supabaseBase(deps)}/document_sections?${params.toString()}`,
    { headers: supabaseHeaders(deps) },
  );
  if (!resp.ok) {
    throw new Error(
      `keyword query HTTP ${resp.status}: ${await readErrorBody(resp)}`,
    );
  }
  const rows: Hit[] = await resp.json();

  const lowered = terms.map((t) => [t, t.toLowerCase()] as const);
  const ranked: Hit[] = [];
  for (const row of rows) {
    const haystack = `${row.title ?? ""} ${row.content ?? ""}`.toLowerCase();
    const matched = lowered.filter(([, low]) => haystack.includes(low)).map(
      ([t]) => t,
    );
    if (matched.length === 0) continue;
    ranked.push({
      ...row,
      matched_terms: matched,
      keyword_score: matched.length,
    });
  }
  ranked.sort(
    (a, b) =>
      (b.keyword_score ?? 0) - (a.keyword_score ?? 0) ||
      (b.content?.length ?? 0) - (a.content?.length ?? 0),
  );
  return ranked.slice(0, count);
}

// --- хибридна оркестрация ----------------------------------------------------
function annotate(hits: Hit[], source: "vector" | "keyword"): Hit[] {
  return hits.map((h) => ({ ...h, matched_by: source }));
}

export async function runQuery(
  question: string,
  count: number,
  mode: Mode,
  deps: RagDeps,
): Promise<QueryResult> {
  const trace: Trace = { question, mode, match_count: count };
  let hits: Hit[];

  const expanded = expandQuestion(question);
  if (expanded !== question) trace.expanded = expanded;

  if (mode === "keyword") {
    const terms = extractTerms(
      expanded,
      deps.tuning.maxTerms,
      deps.tuning.minTermLen,
    );
    trace.terms = terms;
    hits = annotate(await keywordSearch(terms, count, deps), "keyword");
    trace.path = "keyword";
  } else {
    const vec = await embed(expanded, deps);
    hits = annotate(
      await rpcMatch(vec, deps.tuning.vectorThreshold, count, deps),
      "vector",
    );
    const [weak, why] = vectorIsWeak(hits, count, deps.tuning);
    trace.vector_state = why;
    if (mode === "vector" || !weak) {
      trace.path = "vector";
    } else {
      const terms = extractTerms(
        expanded,
        deps.tuning.maxTerms,
        deps.tuning.minTermLen,
      );
      trace.terms = terms;
      const fallback = annotate(
        await keywordSearch(terms, count, deps),
        "keyword",
      );
      trace.path = hits.length > 0 ? "vector+keyword" : "keyword";
      trace.fallback_hits = fallback.length;
      // Векторният резултат е слаб, затова keyword попаденията водят. Векторните
      // пълнят остатъка. (Ако се добавят след тях, слабият векторен резултат
      // би запълнил квотата и fallback-ът щеше да отпадне тихо.)
      const seen = new Set(fallback.map((h) => h.id));
      hits = [...fallback, ...hits.filter((h) => !seen.has(h.id))].slice(
        0,
        count,
      );
    }
  }

  trace.returned = hits.length;
  return { trace, hits };
}
