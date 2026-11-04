#!/usr/bin/env python3
"""Behavioural tests for the PDF ingestion pipeline (``ingest_pdf.py``).

Two layers, mirroring ``test_rag_query.py``:

* A hermetic layer that builds a tiny PDF *in memory* and checks the
  extraction contract. It needs no network and no credentials, so it always
  runs in CI. The generated PDF deliberately reproduces the real defect it
  guards against: its Type0 font is a ``CIDFontType2`` with neither ``/W``
  widths nor ``/DW``, which is what makes pypdf's default extractor split
  words with stray spaces. A tool-generated PDF with proper widths would not
  reproduce it, which is why the fixture is hand-built here (and kept in
  memory, so no binary fixture lands in git).
* A live layer that runs the same dry-run the operator runs by hand --
  ``ingest_pdf.py --drive-file <link> --dry-run`` -- against a real Google
  Drive PDF and verifies the result. It needs the Composio CLI plus
  ``OPENROUTER_API_KEY``; without them it skips (not fails), so the suite
  stays green on forks and on repos without secrets.

Run from this directory:

    python3 -m unittest test_ingest_pdf -v

Optional knobs:
    RAG_TEST_DRIVE_URL   override the Google Drive PDF used by the live test
    COMPOSIO_BIN         path to the composio CLI (default: PATH lookup)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest

import ingest_pdf as ip

HERE = os.path.dirname(os.path.abspath(__file__))
INGEST = os.path.join(HERE, "ingest_pdf.py")

# The State Gazette PDF that first exposed the extraction bug.
DEFAULT_DRIVE_URL = (
    "https://drive.google.com/file/d/1wqZu8ShjnVr7Ay05uE5gFuRjBplNEp1R/view"
)
DRIVE_URL = os.environ.get("RAG_TEST_DRIVE_URL", DEFAULT_DRIVE_URL)


# --------------------------------------------------------------------------- #
# In-memory fixture: a minimal PDF whose Type0 font has no /W and no /DW
# --------------------------------------------------------------------------- #
def build_minimal_pdf(text: str, offset: int = 900) -> bytes:
    """Return a tiny one-page PDF with a widthless Type0 (CIDFontType2) font.

    ``offset`` is the horizontal advance, in text space, emitted after each
    glyph with ``Td``. With no ``/W``/``/DW`` the default extractor cannot know
    the real advance and reads the offset as a word gap, splitting the words --
    exactly the defect under test.
    """
    chars = list(dict.fromkeys(text))
    code_of = {c: 0x0100 + i for i, c in enumerate(chars)}

    bfchar = "\n".join(f"<{code_of[c]:04X}> <{ord(c):04X}>" for c in chars)
    cmap = (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        f"{len(chars)} beginbfchar\n{bfchar}\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
    ).encode("latin-1")

    parts = [f"<{code_of[c]:04X}> Tj {offset} 0 Td" for c in text]
    content = ("BT /F0 12 Tf 72 720 Td " + " ".join(parts) + " ET").encode("latin-1")

    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F0 4 0 R >> >> /Contents 5 0 R >>"
        ),
        4: (
            b"<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+TestFont "
            b"/Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"
        ),
        5: b"<< /Length "
        + str(len(content)).encode()
        + b" >>\nstream\n"
        + content
        + b"\nendstream",
        # No /W and no /DW -- the quirk the extractor must cope with.
        6: (
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+TestFont "
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            b"/FontDescriptor 8 0 R /CIDToGIDMap /Identity >>"
        ),
        7: b"<< /Length "
        + str(len(cmap)).encode()
        + b" >>\nstream\n"
        + cmap
        + b"\nendstream",
        8: (
            b"<< /Type /FontDescriptor /FontName /AAAAAA+TestFont /Flags 4 "
            b"/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 "
            b"/CapHeight 700 /StemV 80 >>"
        ),
    }

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for num in sorted(objs):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + objs[num] + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in sorted(objs):
        out += f"{offsets[num]:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode()
    return bytes(out)


SAMPLE = "Издадена от министъра"


class PdfExtractionTest(unittest.TestCase):
    """The widthless-Type0 defect must not leak spaces into the text."""

    @classmethod
    def setUpClass(cls):
        cls.pdf = build_minimal_pdf(SAMPLE)
        cls.ours = ip.extract_pdf_text(cls.pdf)

    def test_fixture_reproduces_the_defect_with_pypdf_default(self):
        """Guard the guard: the default extractor must still mangle the words.

        If a future pypdf release stops splitting these words, this fixture no
        longer exercises the bug and should be revisited.
        """
        from pypdf import PdfReader
        import io

        default = "\n".join(
            (p.extract_text() or "") for p in PdfReader(io.BytesIO(self.pdf)).pages
        )
        self.assertNotIn(
            SAMPLE, default,
            "pypdf default unexpectedly produced clean text; the fixture no "
            "longer reproduces the defect: %r" % (default,),
        )

    def test_extractor_returns_the_clean_text(self):
        self.assertIn(SAMPLE, self.ours)

    def test_extractor_does_not_split_words_with_spaces(self):
        # A widthless font makes the default extractor insert a gap after a
        # lone capital ("И здадена"). In clean text, a single capital followed
        # by a lowercase word is only ever a real one-letter word (В, С, К...).
        import re

        artifacts = re.findall(r"(?<![А-Яа-я])[А-Я] (?=[а-я])", self.ours)
        real_words = {"В", "С", "К", "П", "И", "О", "Н", "Д"}
        self.assertTrue(
            all(a.strip() in real_words for a in artifacts),
            "intra-word space artifact in: %r" % (self.ours,),
        )

    def test_fixture_is_small(self):
        """The in-memory fixture must stay tiny (no binary blob in git)."""
        self.assertLess(len(self.pdf), 8192, "fixture grew unexpectedly large")


class DriveIdTest(unittest.TestCase):
    """The Drive URL/id parser accepts the forms the operator pastes."""

    def test_extracts_id_from_file_view_url(self):
        self.assertEqual(
            ip.extract_file_id(
                "https://drive.google.com/file/d/1wqZu8ShjnVr7Ay05uE5gFuRjBplNEp1R/view"
            ),
            "1wqZu8ShjnVr7Ay05uE5gFuRjBplNEp1R",
        )

    def test_extracts_id_from_open_query_url(self):
        self.assertEqual(
            ip.extract_file_id("https://drive.google.com/open?id=ABC123xyz"),
            "ABC123xyz",
        )

    def test_passes_through_a_bare_id(self):
        self.assertEqual(ip.extract_file_id("ABC123xyz"), "ABC123xyz")


# --------------------------------------------------------------------------- #
# Live dry-run against a real Google Drive PDF
# --------------------------------------------------------------------------- #
def _composio_available() -> bool:
    return bool(os.environ.get("COMPOSIO_BIN") or shutil.which("composio"))


HAVE_LIVE = _composio_available() and bool(os.environ.get("OPENROUTER_API_KEY"))


@unittest.skipUnless(HAVE_LIVE, "composio CLI and/or OPENROUTER_API_KEY not configured")
class DriveDryRunTest(unittest.TestCase):
    """End-to-end: run the CLI exactly as the operator does, check the result."""

    @classmethod
    def setUpClass(cls):
        proc = subprocess.run(
            [sys.executable, INGEST, "--drive-file", DRIVE_URL, "--dry-run"],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=HERE,
        )
        cls.returncode = proc.returncode
        cls.stdout = proc.stdout
        cls.stderr = proc.stderr
        # The CLI prints progress lines, then the JSON blob -- parse from "{".

    def _payload(self) -> dict:
        self.assertEqual(
            self.returncode, 0,
            "dry-run failed (%s):\n%s\n%s"
            % (self.returncode, self.stdout[-2000:], self.stderr[-2000:]),
        )
        start = self.stdout.find("{")
        self.assertNotEqual(start, -1, "no JSON payload in output:\n%s" % self.stdout)
        return json.loads(self.stdout[start:])

    def test_reports_legal_split(self):
        self.assertIn("detected legal text", self.stdout)
        self.assertIn("dry-run: not writing to Supabase", self.stdout)

    def test_payload_uses_legal_metadata(self):
        payload = self._payload()
        meta = payload["metadata"]
        self.assertEqual(meta["split"], "legal")
        self.assertEqual(meta["source"], "google-drive-pdf")
        self.assertTrue(meta.get("article"), "missing article label")
        self.assertTrue(meta.get("article_number"), "missing article number")
        self.assertTrue(meta.get("chapter"), "missing chapter")

    def test_payload_content_is_clean(self):
        payload = self._payload()
        content = payload["content"]
        self.assertIn("Чл. 1.", content)
        # The defect split words such as "Издадена от министъра".
        self.assertNotIn("И здадена", content)
        self.assertIn("(1)", content)

    def test_payload_carries_an_embedding_of_the_expected_dimension(self):
        payload = self._payload()
        self.assertEqual(payload["embedding"], "<768 floats>")


if __name__ == "__main__":
    unittest.main(verbosity=2)
