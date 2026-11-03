#!/usr/bin/env python3
"""Query the Supabase pgvector RAG store using only the Python stdlib.

Hybrid retrieval:
  1. Vector search (cosine similarity over pgvector) via the
     `match_document_sections` RPC.
  2. If the semantic result is weak -- no hits, top similarity below a cutoff,
     or fewer than N hits -- fall back to keyword search over PostgREST using
     `ilike` OR filters, ranked by how many distinct terms matched.

Mirrors the TLS/proxy handling in ingest_text.py (clear VERIFY_X509_STRICT,
use the OpenClaw egress proxy CA bundle) but with http.client so no third-party
packages are required.

Usage:
    python3 rag_query.py "question text" [match_count] [--mode auto|vector|keyword]

Secrets are read from the environment only and never printed.
"""
from __future__ import annotations

import base64
import http.client
import json
import os
import re
import ssl
import sys
import urllib.parse

EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings"
MODEL = "openai/text-embedding-3-small"
DIMENSIONS = 768

# --- hybrid tuning (override via environment) -------------------------------
# Cosine similarity floor for vector hits that are kept at all.
VECTOR_THRESHOLD = float(os.environ.get("RAG_VECTOR_THRESHOLD", "0.20"))
# Below this top similarity the vector result is considered weak.
WEAK_TOP_SIMILARITY = float(os.environ.get("RAG_HYBRID_WEAK_TOP", "0.38"))
# A similarity this low is never a confident answer, however many hits there
# are. Below it the keyword path is always consulted.
CONFIDENT_TOP_SIMILARITY = float(
    os.environ.get("RAG_HYBRID_CONFIDENT_TOP", "0.62")
)
# Minimum number of vector hits before the result counts as well covered.
WEAK_MIN_HITS = int(os.environ.get("RAG_HYBRID_MIN_HITS", "2"))
# How many rows to pull for keyword ranking before trimming to match_count.
KEYWORD_FETCH_FACTOR = int(os.environ.get("RAG_HYBRID_FETCH_FACTOR", "4"))
# Floor for the keyword candidate set. PostgREST returns rows in arbitrary
# order, so truncating before ranking lets row order decide the answer; fetch a
# generous set, rank locally, then trim.
KEYWORD_FETCH_LIMIT = int(os.environ.get("RAG_HYBRID_FETCH_LIMIT", "200"))
# Max distinct keyword terms used in the OR filter.
MAX_TERMS = int(os.environ.get("RAG_HYBRID_MAX_TERMS", "8"))
# Shortest keyword term worth querying for.
MIN_TERM_LEN = int(os.environ.get("RAG_HYBRID_MIN_TERM_LEN", "3"))

BULGARIAN_STOPWORDS = {
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
}

ENGLISH_STOPWORDS = {
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "as",
    "at", "be", "been", "but", "by", "can", "could", "did", "do", "does",
    "for", "from", "get", "had", "has", "have", "how", "if", "in", "into",
    "is", "it", "its", "just", "me", "more", "most", "my", "no", "not", "of",
    "on", "or", "our", "out", "should", "so", "some", "such", "than", "that",
    "the", "their", "them", "then", "there", "these", "they", "this", "to",
    "too", "up", "was", "we", "were", "what", "when", "which", "who", "why",
    "will", "with", "would", "you", "your",
}

STOPWORDS = BULGARIAN_STOPWORDS | ENGLISH_STOPWORDS

# Legal synonyms: the question is phrased in everyday language, the statute in
# legal language. Expanding the query with these terms fixes both retrieval
# paths at once -- the embedding points at the camping provisions, and the
# keyword fallback searches for the words the law actually uses.
LEGAL_SYNONYMS = {
    "лагеруване": ("палатки", "кемпери", "каравани", "преместваеми обекти"),
    "лагерувам": ("палатки", "кемпери", "каравани"),
    "палатка": ("палатки", "кемпери", "каравани"),
    "плаж": ("морски плажове", "извън територията на морските плажове"),
    "плажа": ("морски плажове", "извън територията на морските плажове"),
    "плажове": ("морски плажове",),
}

WORD_RE = re.compile(r"[0-9a-zA-Z\u0400-\u04FF]+")


def expand_question(question):
    """Append legal synonyms for any trigger word found in the question.

    Returns the question unchanged when no trigger matches, so callers can
    detect a no-op by comparing strings.
    """
    lowered = question.lower()
    extra = []
    for trigger, synonyms in LEGAL_SYNONYMS.items():
        if trigger in lowered:
            extra.extend(synonyms)
    if not extra:
        return question
    return question + " " + " ".join(dict.fromkeys(extra))


# --- transport ---------------------------------------------------------------
def build_ctx() -> ssl.SSLContext:
    bundle = None
    for var in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "CURL_CA_BUNDLE"):
        path = os.environ.get(var)
        if path and os.path.exists(path):
            bundle = path
            break
    ctx = ssl.create_default_context(cafile=bundle)
    strict = getattr(ssl, "VERIFY_X509_STRICT", 0)
    if strict:
        ctx.verify_flags &= ~strict
    return ctx


def proxy_config():
    """Return (host, port, connect_headers) for the egress proxy.

    Credentials come from the proxy URL userinfo; they are used only for the
    CONNECT tunnel and never printed or logged.
    """
    raw = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    raw = raw or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy")
    if not raw:
        return None
    u = urllib.parse.urlsplit(raw)
    if not u.hostname:
        return None
    headers = {}
    if u.username:
        userinfo = urllib.parse.unquote(u.username)
        if u.password:
            userinfo += ":" + urllib.parse.unquote(u.password)
        token = base64.b64encode(userinfo.encode("utf-8")).decode("ascii")
        headers["Proxy-Authorization"] = "Basic " + token
    return u.hostname, (u.port or 80), headers


def request_json(url, headers, payload, ctx, method="POST"):
    u = urllib.parse.urlsplit(url)
    pc = proxy_config()
    if pc:
        # Connect to the PROXY, then tunnel to the target. set_tunnel() takes
        # the tunnel destination; the proxy address is the connection's own
        # host/port. (Swapping these makes the proxy answer 400.)
        conn = http.client.HTTPSConnection(
            pc[0], pc[1], context=ctx, timeout=90
        )
        conn.set_tunnel(u.hostname, u.port or 443, headers=pc[2])
    else:
        conn = http.client.HTTPSConnection(
            u.hostname, u.port or 443, context=ctx, timeout=90
        )
    path = u.path + (("?" + u.query) if u.query else "")
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    status = resp.status
    conn.close()
    return status, data


def supabase_base():
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        sys.exit("error: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    return base, key


def supabase_headers(key):
    return {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }


# --- vector path -------------------------------------------------------------
def embed(text, ctx):
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("error: OPENROUTER_API_KEY is not set")
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    }
    payload = {"model": MODEL, "input": [text], "dimensions": DIMENSIONS}
    status, data = request_json(EMBED_ENDPOINT, headers, payload, ctx)
    if status != 200:
        sys.exit("error: embedding HTTP %s: %r" % (status, data[:300]))
    obj = json.loads(data)
    items = obj.get("data", [])
    items.sort(key=lambda d: d.get("index", 0))
    vec = items[0]["embedding"]
    if len(vec) != DIMENSIONS:
        sys.exit("error: expected %s dims, got %s" % (DIMENSIONS, len(vec)))
    return vec


def rpc_match(vec, threshold, count, ctx):
    base, key = supabase_base()
    url = base + "/rpc/match_document_sections"
    payload = {
        "query_embedding": vec,
        "match_threshold": threshold,
        "match_count": count,
    }
    status, data = request_json(url, supabase_headers(key), payload, ctx)
    if status != 200:
        sys.exit("error: rpc HTTP %s: %r" % (status, data[:300]))
    return json.loads(data)


# --- keyword fallback --------------------------------------------------------
def extract_terms(question, limit=None):
    """Pull meaningful search terms from the question, longest first.

    Keeps numbers intact (article/paragraph numbers matter for legal text) and
    drops stopwords. Longest-first because specific terms discriminate better.
    """
    if limit is None:
        limit = MAX_TERMS
    seen = set()
    terms = []
    for raw in WORD_RE.findall(question):
        word = raw.strip().lower()
        if word in seen or word in STOPWORDS:
            continue
        if len(word) < MIN_TERM_LEN and not word.isdigit():
            continue
        seen.add(word)
        terms.append(word)
    terms.sort(key=lambda w: (-len(w), w))
    return terms[:limit]


def escape_filter_value(value):
    """Escape a value for a PostgREST `ilike` filter.

    `%` and `_` are LIKE wildcards that must not leak from user input; `,` and
    `)` would break the OR filter structure, and `*` is PostgREST's own
    wildcard. Backslash and double quotes follow PostgREST quoting rules.
    """
    out = []
    for ch in value:
        if ch in ("\\", '"'):
            out.append("\\" + ch)
        elif ch in ("%", "_", "*", ",", "(", ")"):
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def keyword_search(terms, count, ctx):
    """Search title/content for any of `terms`, ranked by distinct matches."""
    if not terms:
        return []
    base, key = supabase_base()
    clauses = []
    for term in terms:
        safe = escape_filter_value(term)
        clauses.append("content.ilike.%" + safe + "%")
        clauses.append("title.ilike.%" + safe + "%")
    params = {
        "or": "(" + ",".join(clauses) + ")",
        "select": "id,document_id,title,content,metadata",
        "limit": str(max(count * KEYWORD_FETCH_FACTOR, KEYWORD_FETCH_LIMIT)),
    }
    url = base + "/document_sections?" + urllib.parse.urlencode(
        params, quote_via=urllib.parse.quote, safe="(),.*"
    )
    status, data = request_json(url, supabase_headers(key), None, ctx, method="GET")
    if status not in (200, 206):
        sys.exit("error: keyword query HTTP %s: %r" % (status, data[:300]))
    rows = json.loads(data)

    lowered = [(t, t.lower()) for t in terms]
    ranked = []
    for row in rows:
        haystack = " ".join(
            str(row.get(field) or "") for field in ("title", "content")
        ).lower()
        matched = [t for t, low in lowered if low in haystack]
        if not matched:
            continue
        row["matched_terms"] = matched
        row["keyword_score"] = len(matched)
        ranked.append(row)
    ranked.sort(key=lambda r: (-r["keyword_score"], -len(r.get("content") or "")))
    return ranked[:count]


# --- hybrid orchestration ----------------------------------------------------
def vector_is_weak(hits, count):
    if not hits:
        return True, "no vector hits"
    top = max((h.get("similarity") or 0.0) for h in hits)
    if top < CONFIDENT_TOP_SIMILARITY:
        return True, "top similarity %.3f < confident %.2f" % (
            top, CONFIDENT_TOP_SIMILARITY
        )
    if top < WEAK_TOP_SIMILARITY:
        return True, "top similarity %.3f < %.2f" % (top, WEAK_TOP_SIMILARITY)
    want = min(WEAK_MIN_HITS, count)
    if len(hits) < want:
        return True, "only %s hit(s), wanted %s" % (len(hits), want)
    return False, "top similarity %.3f" % top


def annotate(hits, source):
    for hit in hits:
        hit["matched_by"] = source
    return hits


def run_query(question, count=5, mode="auto", ctx=None):
    """Run the hybrid pipeline and return (trace, hits).

    Single source of truth for the orchestration: main() and the tests both
    call this, so the tests exercise the production path instead of a private
    reimplementation that can silently drift from it.
    """
    if ctx is None:
        ctx = build_ctx()
    trace = {"question": question, "mode": mode, "match_count": count}

    expanded = expand_question(question)
    if expanded != question:
        trace["expanded"] = expanded

    if mode == "keyword":
        terms = extract_terms(expanded)
        trace["terms"] = terms
        hits = annotate(keyword_search(terms, count, ctx), "keyword")
        trace["path"] = "keyword"
    else:
        vec = embed(expanded, ctx)
        hits = annotate(rpc_match(vec, VECTOR_THRESHOLD, count, ctx), "vector")
        weak, why = vector_is_weak(hits, count)
        trace["vector_state"] = why
        if mode == "vector" or not weak:
            trace["path"] = "vector"
        else:
            terms = extract_terms(expanded)
            trace["terms"] = terms
            fallback = annotate(keyword_search(terms, count, ctx), "keyword")
            trace["path"] = "vector+keyword" if hits else "keyword"
            trace["fallback_hits"] = len(fallback)
            # The vector result is weak, so the keyword hits -- which matched
            # actual query terms -- lead. Vector hits fill any remaining slots.
            # (Appending them after the vector hits would let the weak vector
            # result fill the quota and silently drop the fallback.)
            seen = set(h["id"] for h in fallback)
            merged = fallback + [h for h in hits if h["id"] not in seen]
            hits = merged[:count]

    trace["returned"] = len(hits)
    return trace, hits


def main():
    argv = sys.argv[1:]
    positional = []
    mode = "auto"
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--mode="):
            mode = arg.split("=", 1)[1].strip()
        elif arg == "--mode":
            i += 1
            if i < len(argv):
                mode = argv[i].strip()
        elif arg == "--vector":
            mode = "vector"
        elif arg == "--keyword":
            mode = "keyword"
        elif not arg.startswith("--"):
            positional.append(arg)
        i += 1
    if not positional or mode not in ("auto", "vector", "keyword"):
        sys.exit(
            'usage: rag_query.py "question" [match_count] [--mode auto|vector|keyword]'
        )

    question = positional[0]
    count = int(positional[1]) if len(positional) > 1 else 5

    trace, hits = run_query(question, count, mode)
    print(json.dumps({"trace": trace, "results": hits},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()