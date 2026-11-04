#!/usr/bin/env python3
"""
RAG ingestion: PDF (Google Drive or local) -> text -> embeddings -> Supabase.

This is the PDF sibling of ``ingest_text.py``. It reuses that module's
embedding, chunking, legal-splitting and PostgREST helpers unchanged, and adds
only the front of the pipeline:

    Google Drive (Composio CLI)  ->  signed S3 URL  ->  PDF bytes
        ->  text extraction (pypdf)  ->  ingest_text.build_units()  ->  store

No post-processing is applied to the extracted text: the PDF's text layer is
used as-is, exactly like the first manual run.

Design notes
------------
* The Drive download goes through the local Composio CLI
  (``GOOGLEDRIVE_DOWNLOAD_FILE``). Composio stages the file and returns a
  short-lived signed ``s3url``; we fetch that URL with the same egress-aware
  session used for embeddings.
* Text extraction uses ``pypdf`` (pure Python, no system deps). It is imported
  lazily so the module still loads when only ``--file``/``--query`` are used.
* Secrets are read from the environment only and never printed.

Expected environment (injected by the OpenClaw host):
  OPENROUTER_API_KEY          - embeddings
  SUPABASE_URL                - e.g. https://<ref>.supabase.co/rest/v1/
  SUPABASE_SERVICE_ROLE_KEY   - write access (bypasses RLS)

Usage
-----
  # from a Google Drive file (URL or id); title/document_id auto-filled
  python3 ingest_pdf.py --drive-file "https://drive.google.com/file/d/<id>/view"

  # from a local PDF
  python3 ingest_pdf.py --file ./naredba.pdf --document-id doc-001 --title "Наредба"

  # embed only, do not write
  python3 ingest_pdf.py --drive-file <id> --dry-run

  # smoke-test retrieval after writing
  python3 ingest_pdf.py --document-id doc-001 --query "какво съдържа регистърът"

  # re-ingest replacing an existing document
  python3 ingest_pdf.py --drive-file <id> --replace
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# Reuse the text pipeline verbatim. The module lives next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ingest_text import (  # noqa: E402
    DEFAULT_DIMENSIONS,
    DEFAULT_MODEL,
    Config,
    build_units,
    delete_document,
    die,
    embed,
    insert_rows,
    rpc_match,
    session,
)

# Composio tool that stages a Drive file and returns a signed download URL.
GOOGLEDRIVE_DOWNLOAD_TOOL = "GOOGLEDRIVE_DOWNLOAD_FILE"


# --------------------------------------------------------------------------- #
# Google Drive (via the Composio CLI)
# --------------------------------------------------------------------------- #
def extract_file_id(value: str) -> str:
    """Accept a full Google Drive URL or a bare file id."""
    m = re.search(r"/(?:file|document)/d/([A-Za-z0-9_-]+)", value)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([A-Za-z0-9_-]+)", value)
    return m.group(1) if m else value.strip()


def fetch_drive_file(file_id_or_url: str, composio_bin: str | None = None) -> dict:
    """Stage a Drive file through the Composio CLI.

    Returns ``{"file_id", "name", "mimetype", "s3url"}``. The file id is passed
    as structured data so the command never waits on stdin.
    """
    file_id = extract_file_id(file_id_or_url)
    binary = composio_bin or shutil.which("composio")
    if not binary:
        die("composio CLI not found on PATH; pass --composio /path/to/composio")

    payload = json.dumps({"fileId": file_id})
    proc = subprocess.run(
        [binary, "execute", GOOGLEDRIVE_DOWNLOAD_TOOL, "-d", payload],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        die(
            f"composio execution failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()[:400]}"
        )
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        die(f"composio returned non-JSON output: {exc}")

    if str(result.get("successful")).lower() != "true":
        die(f"composio reported failure: {str(result.get('error'))[:300]}")

    data = result.get("data") or {}
    content = data.get("downloaded_file_content") or {}
    s3url = content.get("s3url")
    if not s3url:
        die("composio response has no data.downloaded_file_content.s3url")

    return {
        "file_id": data.get("id") or file_id,
        "name": content.get("name") or data.get("name"),
        "mimetype": content.get("mimetype") or data.get("mimeType"),
        "s3url": s3url,
    }


def download_bytes(url: str) -> bytes:
    """Fetch a (signed) URL with the egress-aware session."""
    resp = session().get(url, timeout=180)
    if resp.status_code != 200:
        die(f"download failed: HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.content


# --------------------------------------------------------------------------- #
# PDF text extraction
# --------------------------------------------------------------------------- #
def extract_pdf_text(data: bytes) -> str:
    """Extract the text layer of a PDF with pypdf (no post-processing)."""
    try:
        from pypdf import PdfReader
    except ImportError:
        die("pypdf is not installed; run: pip install pypdf")

    import io

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            die("PDF is encrypted and could not be opened")

    pages = [(page.extract_text() or "") for page in reader.pages]
    return "\n".join(pages)


# --------------------------------------------------------------------------- #
# Input
# --------------------------------------------------------------------------- #
def read_input(args: argparse.Namespace) -> tuple[str, dict]:
    """Return ``(text, extra)`` where extra carries title/url/document_id."""
    if args.drive_file:
        info = fetch_drive_file(args.drive_file, args.composio)
        if info.get("mimetype") and "pdf" not in info["mimetype"].lower():
            die(f"not a PDF: mimetype={info['mimetype']!r}")
        data = download_bytes(info["s3url"])
        if args.keep_pdf:
            with open(args.keep_pdf, "wb") as fh:
                fh.write(data)
            print(f"saved PDF: {args.keep_pdf} ({len(data)} bytes)", file=sys.stderr)
        text = extract_pdf_text(data)
        return text, {
            "document_id": info.get("file_id"),
            "title": info.get("name"),
            "url": f"https://drive.google.com/file/d/{info.get('file_id')}/view",
            "source": "google-drive-pdf",
        }
    if args.file:
        with open(args.file, "rb") as fh:
            data = fh.read()
        text = extract_pdf_text(data)
        return text, {"source": "pdf"}
    die("no input: pass --drive-file or --file")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest a PDF (Google Drive or local) into the Supabase pgvector RAG store.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--drive-file",
        help="Google Drive file URL or id (downloaded via the Composio CLI)",
    )
    parser.add_argument("--file", help="path to a local PDF file")
    parser.add_argument("--composio", help="path to the composio CLI binary")
    parser.add_argument(
        "--keep-pdf",
        help="save the downloaded PDF to this path (Drive input only)",
    )
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
    if not raw.strip():
        die("PDF produced no text (scanned image without a text layer?)")

    if not args.document_id:
        args.document_id = source.get("document_id")
    if not args.document_id:
        die("--document-id is required (or use --drive-file, which supplies it)")
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
    metadata.setdefault("source", source.get("source", "pdf"))
    metadata["split"] = kind

    rows = []
    for i, (unit, vec) in enumerate(zip(units, vectors)):
        meta = {**metadata, "chunk_index": i, "chunks_total": len(units)}
        if kind == "legal":
            meta["article"] = unit.get("article")
            meta["article_number"] = unit.get("article_number")
            if unit.get("section"):
                meta["section"] = unit["section"]
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
        print(
            json.dumps(
                {**rows[0], "embedding": f"<{len(rows[0]['embedding'])} floats>"},
                ensure_ascii=False,
                indent=2,
            )
        )
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
