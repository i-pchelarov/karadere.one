#!/usr/bin/env python3
"""
RAG ingestion: plain text -> embeddings (OpenRouter) -> Supabase pgvector.

Design notes
------------
* Embeddings come from OpenRouter's OpenAI-compatible /v1/embeddings endpoint
  using `openai/text-embedding-3-small` (or any model passed via --model).
  `dimensions` is a *native* Matryoshka reduction, not a post-hoc truncation.
* Storage goes through Supabase PostgREST (the table `document_sections`) so we
  only need `requests`; no Postgres driver required. Egress is handled by the
  OpenClaw secrets egress proxy (HTTP(S)_PROXY is already set in the env).
* Secrets are read from the environment only. They are never printed.

Expected environment (injected by the OpenClaw host):
  OPENROUTER_API_KEY          - embeddings
  SUPABASE_URL                - e.g. https://<ref>.supabase.co/rest/v1/
  SUPABASE_SERVICE_ROLE_KEY   - write access (bypasses RLS)

Usage
-----
  # from a file
  python3 ingest_text.py --file notes.txt --document-id doc-001 --title "Notes"

  # from a literal string
  python3 ingest_text.py --text "Some text" --document-id doc-002

  # from stdin
  cat notes.txt | python3 ingest_text.py --document-id doc-003

  # from a Google Doc (URL or id); title/document_id/url are auto-filled
  python3 ingest_text.py --google-doc "https://docs.google.com/document/d/<id>/edit"

  # force plain chunking even if the text looks legal
  python3 ingest_text.py --google-doc <id> --split plain --replace

  # embed only, do not write
  python3 ingest_text.py --file notes.txt --dry-run

  # smoke-test retrieval after writing
  python3 ingest_text.py --document-id doc-001 --query "how do I camp?"

  # re-ingest replacing an existing document
  python3 ingest_text.py --file notes.txt --document-id doc-001 --replace

Legal splitting
---------------
With ``--split auto`` (default) a document is treated as legal when it contains
article markers (``Чл. 4.``) plus alineas (``(1)``), and is then split so each
article becomes one chunk. Article label/number and the enclosing
``Глава``/``Раздел`` are stored in ``metadata`` for citation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time

import requests

EMBED_ENDPOINT = "https://openrouter.ai/api/v1/embeddings"
DEFAULT_MODEL = "openai/text-embedding-3-small"
DEFAULT_DIMENSIONS = 768

# Composio tool that returns the plain text of a Google Doc.
GOOGLEDOCS_TOOL = "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT"

# Legal-text markers: "Чл. 7.", "Чл. 7а." (article) and "(1)" (alinea).
ARTICLE_RE = re.compile(r"(?m)^[ \t]*(Чл\.\s*\d+[а-я]?\.)")
ALINEA_RE = re.compile(r"(?m)^[ \t]*\(\d+[а-я]?\)")
CHAPTER_RE = re.compile(r"(?m)^[ \t]*((?:Глава|Раздел|Част)\b[^\n]*)")


# --------------------------------------------------------------------------- #
# HTTP session
# --------------------------------------------------------------------------- #
def _ca_bundle() -> str | None:
    for var in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "CURL_CA_BUNDLE"):
        path = os.environ.get(var)
        if path and os.path.exists(path):
            return path
    return None


def build_session() -> requests.Session:
    """A Session that trusts the OpenClaw egress proxy CA.

    Two OpenClaw-environment quirks have to be handled:

    1. Python 3.15 / OpenSSL 4.x enable ``VERIFY_X509_STRICT`` by default, which
       requires an Authority Key Identifier on every certificate. The egress
       proxy mints leaf certs without an AKI, so strict verification fails even
       though the chain is otherwise valid. We build a context with the same CA
       bundle and clear only the strict flag, keeping full chain + hostname
       verification.

    2. ``requests`` rebuilds its own SSLContext internally, discarding any
       ``session.verify`` context object. A small adapter injects our context
       into the connection pool keyword arguments so urllib3 actually uses it.

    ``trust_env`` is disabled and the proxy is copied over manually, for the
    same reason: otherwise requests overwrites ``verify`` from
    ``REQUESTS_CA_BUNDLE`` and rebuilds a strict-verifying context.
    """
    bundle = _ca_bundle()
    ctx = ssl.create_default_context(cafile=bundle)
    strict = getattr(ssl, "VERIFY_X509_STRICT", 0)
    if strict:
        ctx.verify_flags &= ~strict

    class _TLSAdapter(requests.adapters.HTTPAdapter):
        def build_connection_pool_key_attributes(self, request, verify, cert=None):
            host_params, pool_kwargs = super().build_connection_pool_key_attributes(
                request, verify, cert
            )
            pool_kwargs["ssl_context"] = ctx
            pool_kwargs["cert_reqs"] = "CERT_REQUIRED"
            return host_params, pool_kwargs

    session = requests.Session()
    session.trust_env = False  # we wire the proxy explicitly below
    session.verify = bundle  # path string; the adapter supplies the real context
    adapter = _TLSAdapter()
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    proxies = {}
    for scheme, var in (("http", "HTTP_PROXY"), ("https", "HTTPS_PROXY")):
        value = os.environ.get(var) or os.environ.get(var.lower())
        if value:
            proxies[scheme] = value
    if proxies:
        session.proxies.update(proxies)
    return session


_SESSION: requests.Session | None = None


def session() -> requests.Session:
    global _SESSION
    if _SESSION is None:
        _SESSION = build_session()
    return _SESSION


# --------------------------------------------------------------------------- #
# Google Docs (via the Composio CLI)
# --------------------------------------------------------------------------- #
def extract_doc_id(value: str) -> str:
    """Accept a full Google Docs URL or a bare document id."""
    m = re.search(r"/document/d/([A-Za-z0-9_-]+)", value)
    return m.group(1) if m else value.strip()


def fetch_google_doc(doc_id_or_url: str, composio_bin: str | None = None) -> dict:
    """Fetch a Google Doc's plain text through the local Composio CLI.

    Returns ``{"document_id", "title", "text", "url"}``. The CLI is invoked
    directly and the document id is passed as structured data so the command
    never waits on stdin.
    """
    doc_id = extract_doc_id(doc_id_or_url)
    binary = composio_bin or shutil.which("composio")
    if not binary:
        die("composio CLI not found on PATH; pass --composio /path/to/composio")

    payload = json.dumps({"document_id": doc_id})
    proc = subprocess.run(
        [binary, "execute", GOOGLEDOCS_TOOL, "-d", payload],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        die(
            f"composio execution failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()[:400]}"
        )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        die(f"could not parse composio output as JSON: {exc}")

    # Large results are spilled to a file by the CLI; the inline payload then
    # carries only metadata (`storedInFile`, `outputFilePath`).
    if result.get("storedInFile") and result.get("outputFilePath"):
        path = result["outputFilePath"]
        if not os.path.exists(path):
            die(f"composio spilled output to {path} but it does not exist")
        with open(path, "r", encoding="utf-8") as fh:
            result = json.load(fh)

    if not result.get("successful"):
        die(f"composio reported failure: {json.dumps(result.get('error'))[:300]}")

    data = result.get("data") or {}
    text = data.get("plain_text")
    if not text or not text.strip():
        die("the Google Doc is empty or has no readable text")
    return {
        "document_id": data.get("document_id") or doc_id,
        "title": data.get("title") or None,
        "text": text,
        "url": data.get("display_url")
        or f"https://docs.google.com/document/d/{doc_id}/edit",
    }


# --------------------------------------------------------------------------- #
# Legal-text detection and splitting
# --------------------------------------------------------------------------- #
def is_legal(text: str) -> bool:
    """A document is legal when it has article markers AND alineas."""
    return len(ARTICLE_RE.findall(text)) >= 2 and len(ALINEA_RE.findall(text)) >= 1


def split_articles(text: str) -> list[dict]:
    """Split law text into one unit per article (Чл.).

    Each unit carries its article label/number and the enclosing chapter/раздел
    so retrieval can cite the source precisely.
    """
    articles = list(ARTICLE_RE.finditer(text))
    if not articles:
        return []
    chapters = list(CHAPTER_RE.finditer(text))

    units: list[dict] = []
    for i, match in enumerate(articles):
        start = match.start()
        end = articles[i + 1].start() if i + 1 < len(articles) else len(text)
        label = match.group(1).strip()
        number = re.search(r"\d+[а-я]?", label).group(0)

        chapter = None
        for c in chapters:
            if c.start() < start:
                chapter = c.group(1).strip()
            else:
                break

        units.append(
            {
                "content": text[start:end].strip(),
                "article": label,
                "article_number": number,
                "chapter": chapter,
            }
        )
    return units


def split_plain(text: str, size: int, overlap: int) -> list[dict]:
    return [{"content": c} for c in chunk_text(text, size, overlap)]


def build_units(
    raw: str, mode: str, size: int, overlap: int, legal_max: int
) -> tuple[list[dict], str]:
    """Choose plain vs legal splitting.

    Returns ``(units, kind)``. In ``auto`` mode the legal splitter is used only
    when :func:`is_legal` matches.
    """
    if mode == "auto":
        mode = "legal" if is_legal(raw) else "plain"

    if mode == "plain":
        return split_plain(raw, size, overlap), "plain"

    units = split_articles(raw)
    if not units:
        # Asked for legal but no articles found; fall back to plain chunking.
        return split_plain(raw, size, overlap), "plain"

    # Keep one chunk per article, but sub-split exceptionally long ones so the
    # embedding model's context window is respected.
    expanded: list[dict] = []
    for unit in units:
        if len(unit["content"]) <= legal_max:
            expanded.append(unit)
            continue
        parts = chunk_text(unit["content"], legal_max, 0)
        for j, part in enumerate(parts):
            # Part 1 already starts with the article label; tag continuations so
            # the chunk stays self-describing after splitting.
            if j == 0:
                content = part
            else:
                content = f"{unit['article']} (продължение) {part}"
            expanded.append(
                {
                    **unit,
                    "content": content,
                    "part": j + 1,
                    "parts_total": len(parts),
                }
            )
    return expanded, "legal"


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
class Config:
    def __init__(self, args: argparse.Namespace):
        self.api_key = os.environ.get("OPENROUTER_API_KEY")
        self.supabase_url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        self.anon_key = os.environ.get("SUPABASE_ANON_KEY")

        self.model = args.model
        self.dimensions = args.dimensions
        self.chunk_size = args.chunk_size
        self.chunk_overlap = args.chunk_overlap

    def require_embed(self) -> None:
        if not self.api_key:
            die("OPENROUTER_API_KEY is not set.")

    def require_db(self) -> None:
        if not self.supabase_url:
            die("SUPABASE_URL is not set.")
        if not self.service_key:
            die("SUPABASE_SERVICE_ROLE_KEY is not set.")


def die(msg: str, code: int = 2) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(code)


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #
def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    """Paragraph-aware chunker with character-level fallback.

    Splits on blank lines, packs paragraphs into chunks of at most `size`
    chars, and prepends `overlap` chars of the previous chunk for context.
    """
    text = text.replace("\r\n", "\n").strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

    pieces: list[str] = []
    for para in paragraphs:
        if len(para) <= size:
            pieces.append(para)
            continue
        # Hard-split an oversized paragraph on sentence-ish boundaries.
        for i in range(0, len(para), size):
            pieces.append(para[i : i + size].strip())

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}\n\n{piece}".strip() if current else piece
        if len(candidate) <= size:
            current = candidate
            continue
        if current:
            chunks.append(current)
        current = piece
    if current:
        chunks.append(current)

    if overlap <= 0 or len(chunks) <= 1:
        return chunks

    with_overlap = [chunks[0]]
    for prev, cur in zip(chunks, chunks[1:]):
        tail = prev[-overlap:]
        with_overlap.append(f"{tail}\n\n{cur}".strip())
    return with_overlap


# --------------------------------------------------------------------------- #
# Embeddings
# --------------------------------------------------------------------------- #
def embed(texts: list[str], cfg: Config, batch_size: int = 64) -> list[list[float]]:
    cfg.require_embed()
    headers = {
        "Authorization": f"Bearer {cfg.api_key}",
        "Content-Type": "application/json",
    }
    out: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        batch = texts[start : start + batch_size]
        payload = {
            "model": cfg.model,
            "input": batch,
            "dimensions": cfg.dimensions,
        }
        for attempt in range(4):
            resp = session().post(
                EMBED_ENDPOINT, headers=headers, json=payload, timeout=60
            )
            if resp.status_code == 200:
                break
            if resp.status_code in (429, 500, 502, 503) and attempt < 3:
                wait = 2 ** attempt
                print(
                    f"  retry {attempt + 1}/3 after HTTP {resp.status_code} "
                    f"(sleep {wait}s)",
                    file=sys.stderr,
                )
                time.sleep(wait)
                continue
            die(f"embedding request failed: HTTP {resp.status_code}: {resp.text[:300]}")

        data = resp.json().get("data", [])
        if len(data) != len(batch):
            die(f"expected {len(batch)} vectors, got {len(data)}")
        # OpenRouter returns objects with an `index`; order defensively.
        data.sort(key=lambda d: d.get("index", 0))
        out.extend([d["embedding"] for d in data])

    return out


# --------------------------------------------------------------------------- #
# Supabase PostgREST
# --------------------------------------------------------------------------- #
def _db_headers(cfg: Config) -> dict:
    return {
        "apikey": cfg.service_key,
        "Authorization": f"Bearer {cfg.service_key}",
        "Content-Type": "application/json",
    }


def delete_document(cfg: Config, document_id: str) -> int:
    cfg.require_db()
    url = f"{cfg.supabase_url}/document_sections"
    params = {"document_id": f"eq.{document_id}"}
    headers = {**_db_headers(cfg), "Prefer": "return=representation"}
    resp = session().delete(url, headers=headers, params=params, timeout=60)
    if resp.status_code not in (200, 204):
        die(f"delete failed: HTTP {resp.status_code}: {resp.text[:300]}")
    try:
        return len(resp.json())
    except ValueError:
        return 0


def insert_rows(cfg: Config, rows: list[dict]) -> list[dict]:
    cfg.require_db()
    url = f"{cfg.supabase_url}/document_sections"
    headers = {**_db_headers(cfg), "Prefer": "return=representation"}
    resp = session().post(url, headers=headers, json=rows, timeout=120)
    if resp.status_code not in (200, 201):
        die(f"insert failed: HTTP {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def rpc_match(cfg: Config, embedding: list[float], threshold: float, count: int) -> list[dict]:
    cfg.require_db()
    url = f"{cfg.supabase_url}/rpc/match_document_sections"
    headers = _db_headers(cfg)
    payload = {
        "query_embedding": embedding,
        "match_threshold": threshold,
        "match_count": count,
    }
    resp = session().post(url, headers=headers, json=payload, timeout=60)
    if resp.status_code != 200:
        die(f"rpc failed: HTTP {resp.status_code}: {resp.text[:300]}")
    return resp.json()


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #
def read_input(args: argparse.Namespace) -> tuple[str, dict]:
    """Return ``(text, extra)`` where extra carries title/url/document_id."""
    if args.google_doc:
        doc = fetch_google_doc(args.google_doc, args.composio)
        return doc["text"], doc
    if args.text is not None:
        return args.text, {}
    if args.file:
        with open(args.file, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read(), {}
    if not sys.stdin.isatty():
        return sys.stdin.read(), {}
    die("no input: pass --google-doc, --text, --file, or pipe text on stdin")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest text or Google Docs into the Supabase pgvector RAG store.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--text", help="literal text to ingest")
    parser.add_argument("--file", help="path to a UTF-8 text file")
    parser.add_argument(
        "--google-doc",
        help="Google Docs URL or document id (fetched via the Composio CLI)",
    )
    parser.add_argument("--composio", help="path to the composio CLI binary")
    parser.add_argument(
        "--split",
        choices=["auto", "plain", "legal"],
        default="auto",
        help="auto = detect legal text (articles + alineas) and split per article",
    )
    parser.add_argument(
        "--legal-max",
        type=int,
        default=6000,
        help="max chars per article before it is sub-split",
    )
    parser.add_argument("--document-id", help="stable document identifier")
    parser.add_argument("--title", default=None, help="document title")
    parser.add_argument("--metadata", help="extra metadata as a JSON object string")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dimensions", type=int, default=DEFAULT_DIMENSIONS)
    parser.add_argument("--chunk-size", type=int, default=1200)
    parser.add_argument("--chunk-overlap", type=int, default=150)
    parser.add_argument(
        "--replace",
        action="store_true",
        help="delete existing rows for this document_id before inserting",
    )
    parser.add_argument("--dry-run", action="store_true", help="embed but do not write")
    parser.add_argument("--query", help="run a similarity search instead of ingesting")
    parser.add_argument("--match-count", type=int, default=5)
    parser.add_argument("--match-threshold", type=float, default=0.0)
    args = parser.parse_args()

    cfg = Config(args)

    # Query mode ----------------------------------------------------------- #
    if args.query is not None:
        embedding = embed([args.query], cfg)[0]
        hits = rpc_match(cfg, embedding, args.match_threshold, args.match_count)
        print(json.dumps(hits, ensure_ascii=False, indent=2))
        return

    # Ingest mode ---------------------------------------------------------- #
    raw, source = read_input(args)

    if not args.document_id:
        args.document_id = source.get("document_id")
    if not args.document_id:
        die("--document-id is required (or use --google-doc, which supplies it)")
    if args.title is None and source.get("title"):
        args.title = source["title"]

    units, kind = build_units(
        raw, args.split, args.chunk_size, args.chunk_overlap, args.legal_max
    )
    if not units:
        die("input produced no chunks")

    if kind == "legal":
        print(
            f"detected legal text: {len(units)} article chunk(s) "
            f"(Чл. split, article<= {args.legal_max} chars)"
        )
    else:
        print(
            f"plain text: {len(units)} chunk(s) "
            f"(size<= {args.chunk_size}, overlap {args.chunk_overlap})"
        )

    vectors = embed([u["content"] for u in units], cfg)
    dims = {len(v) for v in vectors}
    print(f"embeddings: {len(vectors)} vectors, dims={sorted(dims)}")
    if dims != {cfg.dimensions}:
        die(f"dimension mismatch: expected {cfg.dimensions}, got {sorted(dims)}")

    metadata: dict = {}
    if args.metadata:
        try:
            metadata = json.loads(args.metadata)
        except json.JSONDecodeError as exc:
            die(f"--metadata is not valid JSON: {exc}")
    if source.get("url"):
        metadata.setdefault("url", source["url"])
    metadata.setdefault("source", "google-doc" if args.google_doc else "text")
    metadata["split"] = kind

    rows = []
    for i, (unit, vec) in enumerate(zip(units, vectors)):
        meta = {**metadata, "chunk_index": i, "chunks_total": len(units)}
        if kind == "legal":
            meta["article"] = unit.get("article")
            meta["article_number"] = unit.get("article_number")
            if unit.get("chapter"):
                meta["chapter"] = unit["chapter"]
            if unit.get("part"):
                meta["part"] = unit["part"]
                meta["parts_total"] = unit.get("parts_total")
        rows.append(
            {
                "document_id": args.document_id,
                "title": args.title,
                "content": unit["content"],
                "metadata": meta,
                "embedding": vec,
            }
        )

    if args.dry_run:
        print("dry-run: not writing to Supabase")
        print(json.dumps({**rows[0], "embedding": f"<{len(rows[0]['embedding'])} floats>"},
                         ensure_ascii=False, indent=2))
        return

    if args.replace:
        removed = delete_document(cfg, args.document_id)
        print(f"replace: removed {removed} existing row(s)")

    inserted = insert_rows(cfg, rows)
    print(f"inserted: {len(inserted)} row(s) for document_id={args.document_id!r}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
