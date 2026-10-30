// Query the Supabase pgvector RAG store from Node.
// Node's fetch honours NODE_USE_ENV_PROXY / HTTP(S)_PROXY and
// NODE_EXTRA_CA_CERTS, so the OpenClaw egress proxy is used without extra code.
// Secrets come only from the environment.
//
// Usage: node rag_query.mjs "question" [match_count]

const EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const MODEL = "openai/text-embedding-3-small";
const DIMENSIONS = 768;

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`error: ${name} is not set`);
    process.exit(2);
  }
  return v;
}

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

async function rpcMatch(vec, threshold, count) {
  const base = env("SUPABASE_URL").replace(/\/+$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const resp = await fetch(`${base}/rpc/match_document_sections`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
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

const question = process.argv[2];
if (!question) {
  console.error('usage: node rag_query.mjs "question" [match_count]');
  process.exit(2);
}
const count = process.argv[3] ? parseInt(process.argv[3], 10) : 5;

const vec = await embed(question);
const hits = await rpcMatch(vec, 0.0, count);
console.log(JSON.stringify(hits, null, 2));
