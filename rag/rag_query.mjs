// Query the Supabase pgvector RAG store from Node.
// Node's fetch honours NODE_USE_ENV_PROXY / HTTP(S)_PROXY and
// NODE_EXTRA_CA_CERTS, so the OpenClaw egress proxy is used without extra code.
// Secrets come only from the environment.
//
// Hybrid retrieval:
//   1. Vector search via the `match_document_sections` RPC.
//   2. If the semantic result is weak (no hits, top similarity below a cutoff,
//      or too few hits), fall back to keyword search over PostgREST `ilike`
//      OR filters, ranked by how many distinct terms matched.
//
// Usage:
//   node rag_query.mjs "question" [match_count] [--mode auto|vector|keyword]

const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const MODEL = "openai/text-embedding-3-small";
const DIMENSIONS = 768;

// --- hybrid tuning (override via environment) -------------------------------
const VECTOR_THRESHOLD = num("RAG_VECTOR_THRESHOLD", 0.2);
const WEAK_TOP_SIMILARITY = num("RAG_HYBRID_WEAK_TOP", 0.38);
const WEAK_MIN_HITS = num("RAG_HYBRID_MIN_HITS", 2);
const KEYWORD_FETCH_FACTOR = num("RAG_HYBRID_FETCH_FACTOR", 4);
const MAX_TERMS = num("RAG_HYBRID_MAX_TERMS", 8);
const MIN_TERM_LEN = num("RAG_HYBRID_MIN_TERM_LEN", 3);

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
const WORD_RE = /[0-9a-zA-Z\u0400-\u04FF]+/g;

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

// --- vector path -------------------------------------------------------------
async function embed(text) {
  const key = env("OPENROUTER_API_KEY");
  const resp = await fetch(EMBED_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: [text], dimensions: DIMENSIONS }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`error: embedding HTTP ${resp.status}: ${body.slice(0, 300)}`);
    process.exit(2);
  }
  const obj = await resp.json();
  const items = obj.data ?? [];
  items.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vec = items[0].embedding;
  if (vec.length !== DIMENSIONS) {
    console.error(`error: expected ${DIMENSIONS} dims, got ${vec.length}`);
    process.exit(2);
  }
  return vec;
}

function supabaseBase() {
  const base = env("SUPABASE_URL").replace(/\/+$/, "");
  return base;
}

function supabaseHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function rpcMatch(vec, threshold, count) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${supabaseBase()}/rpc/match_document_sections`, {
    method: "POST",
    headers: supabaseHeaders(key),
    body: JSON.stringify({
      query_embedding: vec,
      match_threshold: threshold,
      match_count: count,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`error: rpc HTTP ${resp.status}: ${body.slice(0, 300)}`);
    process.exit(2);
  }
  return resp.json();
}

// --- keyword fallback --------------------------------------------------------
function extractTerms(question, limit = MAX_TERMS) {
  // Longest-first: specific terms discriminate better. Numbers are always kept
  // because article/paragraph numbers matter for legal text.
  const seen = new Set();
  const terms = [];
  for (const raw of question.match(WORD_RE) ?? []) {
    const word = raw.trim().toLowerCase();
    if (seen.has(word) || STOPWORDS.has(word)) continue;
    if (word.length < MIN_TERM_LEN && !/^\d+$/.test(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  terms.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return terms.slice(0, limit);
}

function escapeFilterValue(value) {
  // `%` and `_` are LIKE wildcards that must not leak from user input; `,` and
  // `)` would break the OR filter structure, and `*` is PostgREST's own
  // wildcard. Backslash and double quotes follow PostgREST quoting rules.
  return value.replace(/[\\"%_*,()]/g, (ch) => `\\${ch}`);
}

async function keywordSearch(terms, count) {
  if (terms.length === 0) return [];
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const clauses = [];
  for (const term of terms) {
    const safe = escapeFilterValue(term);
    clauses.push(`content.ilike.%${safe}%`);
    clauses.push(`title.ilike.%${safe}%`);
  }
  const params = new URLSearchParams({
    or: `(${clauses.join(",")})`,
    select: "id,document_id,title,content,metadata",
    limit: String(Math.max(count * KEYWORD_FETCH_FACTOR, count)),
  });
  const url = `${supabaseBase()}/document_sections?${params.toString()}`;
  const resp = await fetch(url, { headers: supabaseHeaders(key) });
  if (!resp.ok) {
    const body = await resp.text();
    console.error(`error: keyword query HTTP ${resp.status}: ${body.slice(0, 300)}`);
    process.exit(2);
  }
  const rows = await resp.json();

  const lowered = terms.map((t) => [t, t.toLowerCase()]);
  const ranked = [];
  for (const row of rows) {
    const haystack = `${row.title ?? ""} ${row.content ?? ""}`.toLowerCase();
    const matched = lowered.filter(([, low]) => haystack.includes(low)).map(([t]) => t);
    if (matched.length === 0) continue;
    ranked.push({ ...row, matched_terms: matched, keyword_score: matched.length });
  }
  ranked.sort(
    (a, b) =>
      b.keyword_score - a.keyword_score ||
      (b.content?.length ?? 0) - (a.content?.length ?? 0),
  );
  return ranked.slice(0, count);
}

// --- hybrid orchestration ----------------------------------------------------
function vectorIsWeak(hits, count) {
  if (hits.length === 0) return [true, "no vector hits"];
  const top = Math.max(...hits.map((h) => h.similarity ?? 0));
  if (top < WEAK_TOP_SIMILARITY) {
    return [true, `top similarity ${top.toFixed(3)} < ${WEAK_TOP_SIMILARITY.toFixed(2)}`];
  }
  const want = Math.min(WEAK_MIN_HITS, count);
  if (hits.length < want) {
    return [true, `only ${hits.length} hit(s), wanted ${want}`];
  }
  return [false, `top similarity ${top.toFixed(3)}`];
}

function annotate(hits, source) {
  return hits.map((h) => ({ ...h, matched_by: source }));
}

function parseArgs(argv) {
  let mode = "auto";
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--mode=")) mode = arg.slice(7).trim();
    else if (arg === "--mode") {
      if (i + 1 < argv.length) mode = argv[++i].trim();
    } else if (arg === "--vector") mode = "vector";
    else if (arg === "--keyword") mode = "keyword";
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  return { mode, positional };
}

const { mode, positional } = parseArgs(process.argv.slice(2));
if (positional.length === 0 || !["auto", "vector", "keyword"].includes(mode)) {
  console.error('usage: node rag_query.mjs "question" [match_count] [--mode auto|vector|keyword]');
  process.exit(2);
}

const question = positional[0];
const count = positional[1] ? parseInt(positional[1], 10) : 5;

const trace = { question, mode, match_count: count };
let hits;

if (mode === "keyword") {
  const terms = extractTerms(question);
  trace.terms = terms;
  hits = annotate(await keywordSearch(terms, count), "keyword");
  trace.path = "keyword";
} else {
  const vec = await embed(question);
  hits = annotate(await rpcMatch(vec, VECTOR_THRESHOLD, count), "vector");
  const [weak, why] = vectorIsWeak(hits, count);
  trace.vector_state = why;
  if (mode === "vector" || !weak) {
    trace.path = "vector";
  } else {
    const terms = extractTerms(question);
    trace.terms = terms;
    const fallback = annotate(await keywordSearch(terms, count), "keyword");
    trace.path = hits.length > 0 ? "vector+keyword" : "keyword";
    trace.fallback_hits = fallback.length;
    const seen = new Set(hits.map((h) => h.id));
    hits = [...hits, ...fallback.filter((h) => !seen.has(h.id))].slice(0, count);
  }
}

trace.returned = hits.length;
console.log(JSON.stringify({ trace, results: hits }, null, 2));