#!/usr/bin/env python3
"""Query the Supabase pgvector RAG store using only the Python stdlib.

Mirrors the TLS/proxy handling in ingest_text.py (clear VERIFY_X509_STRICT,
use the OpenClaw egress proxy CA bundle) but with http.client so no third-party
packages are required.

Usage: python3 rag_query.py "question text" [match_count]
Secrets are read from the environment only and never printed.
"""
from __future__ import annotations

import http.client
import json
import os
import sys
import urllib.parse

EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings"
MODEL = "openai/text-embedding-3-small"
DIMENSIONS = 768


def build_ctx() -> ssl_ctx:
    import ssl

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


def proxy_config() -> tuple[str, int, dict] | None:
    """Return (host, port, connect_headers) for the egress proxy.

    Credentials come from the proxy URL userinfo; they are used only for the
    CONNECT tunnel and never printed or logged.
    """
    import base64

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
        headers["Proxy-Authorization"] = f"Basic {token}"
    return u.hostname, (u.port or 80), headers


def post_json(url: str, headers: dict, payload: dict, ctx) -> tuple[int, bytes]:
    u = urllib.parse.urlsplit(url)
    conn = http.client.HTTPSConnection(
        u.hostname, u.port or 443, context=ctx, timeout=90
    )
    pc = proxy_config()
    if pc:
        conn.set_tunnel(pc[0], pc[1], headers=pc[2])
    path = u.path + (("?" + u.query) if u.query else "")
    body = json.dumps(payload).encode("utf-8")
    conn.request("POST", path, body=body, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    status = resp.status
    conn.close()
    return status, data


def embed(text: str, ctx) -> list[float]:
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("error: OPENROUTER_API_KEY is not set")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {"model": MODEL, "input": [text], "dimensions": DIMENSIONS}
    status, data = post_json(EMBED_ENDPOINT, headers, payload, ctx)
    if status != 200:
        sys.exit(f"error: embedding HTTP {status}: {data[:300]!r}")
    obj = json.loads(data)
    items = obj.get("data", [])
    items.sort(key=lambda d: d.get("index", 0))
    vec = items[0]["embedding"]
    if len(vec) != DIMENSIONS:
        sys.exit(f"error: expected {DIMENSIONS} dims, got {len(vec)}")
    return vec


def rpc_match(vec: list[float], threshold: float, count: int, ctx) -> list[dict]:
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not base or not key:
        sys.exit("error: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")
    url = f"{base}/rpc/match_document_sections"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "query_embedding": vec,
        "match_threshold": threshold,
        "match_count": count,
    }
    status, data = post_json(url, headers, payload, ctx)
    if status != 200:
        sys.exit(f"error: rpc HTTP {status}: {data[:300]!r}")
    return json.loads(data)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('usage: rag_query.py "question" [match_count]')
    question = sys.argv[1]
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    ctx = build_ctx()
    vec = embed(question, ctx)
    hits = rpc_match(vec, 0.0, count, ctx)
    print(json.dumps(hits, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
