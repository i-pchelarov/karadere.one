#!/usr/bin/env python3
"""Behavioural tests for the RAG query pipeline.

The contract under test is not "the request returns rows" but "the answer
contains the provisions that actually govern camping on the beach". A query
about camping conditions must surface the camping articles (Чл. 10а, Чл. 24в,
Чл. 17а) rather than an unrelated article that merely shares vocabulary
(Чл. 4, which is about free access to beaches).

Run from this directory:

    python3 -m unittest test_rag_query -v

Requires OPENROUTER_API_KEY, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
environment. Tests are skipped (not failed) when those are absent, so the suite
stays green in environments without credentials.

Optional knobs:
    RAG_TEST_COUNT   how many hits to inspect (default 5)
"""
from __future__ import annotations

import os
import unittest

import rag_query as rq

QUESTION = "При какви условия са разрешени свободното лагеруване на плажа?"

# Articles that genuinely regulate camping / temporary placement of tents,
# campers and caravans under the Black Sea Coast Development Act.
CAMPING_ARTICLES = {"10а", "24в", "17а"}

# Vocabulary that must appear in a usable answer about camping conditions.
CAMPING_VOCABULARY = ("палатки", "кемпери", "каравани")

RESULT_COUNT = int(os.environ.get("RAG_TEST_COUNT", "5"))

HAVE_CREDENTIALS = all(
    os.environ.get(name)
    for name in ("OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
)


def run_query(question=QUESTION, count=RESULT_COUNT, mode="auto"):
    """Execute the production pipeline and return (trace, results).

    Delegates to rq.run_query -- the same entry point the CLI uses -- so the
    tests exercise the real orchestration instead of a private copy that can
    drift from it.
    """
    return rq.run_query(question, count, mode)


def article_of(hit):
    """Article number of a hit, normalised (metadata wins over the text)."""
    meta = hit.get("metadata") or {}
    number = meta.get("article_number")
    if number:
        return str(number).strip().rstrip(".")
    article = (meta.get("article") or "").strip().rstrip(".")
    return article.replace("Чл.", "").replace("чл.", "").strip()


@unittest.skipUnless(HAVE_CREDENTIALS, "RAG credentials not configured")
class CampingQueryTest(unittest.TestCase):
    """The camping question must be answered with the camping provisions."""

    @classmethod
    def setUpClass(cls):
        cls.trace, cls.results = run_query()

    def test_returns_requested_number_of_hits(self):
        self.assertEqual(
            self.trace["returned"], RESULT_COUNT,
            "expected %s hits, got %s (trace: %s)"
            % (RESULT_COUNT, self.trace["returned"], self.trace),
        )
        self.assertEqual(len(self.results), RESULT_COUNT)

    def test_every_hit_has_required_fields(self):
        for hit in self.results:
            with self.subTest(hit=hit.get("id")):
                self.assertTrue(hit.get("id"))
                self.assertIn("content", hit)
                self.assertIsInstance(hit.get("metadata"), dict)
                self.assertTrue(
                    (hit.get("content") or "").strip(),
                    "hit has empty content",
                )
                self.assertIn(hit.get("matched_by"), ("vector", "keyword"))

    def test_results_contain_a_camping_article(self):
        """At least one hit must be an article that regulates camping."""
        found = [article_of(hit) for hit in self.results]
        camping_hits = [a for a in found if a in CAMPING_ARTICLES]
        self.assertTrue(
            camping_hits,
            "no camping provision (Чл. 10а / 24в / 17а) in the top %s results; "
            "articles returned: %s" % (RESULT_COUNT, found),
        )

    def test_conditions_article_reaches_the_top_three(self):
        """Чл. 10а states the conditions, so it must not be buried."""
        top_three = [article_of(hit) for hit in self.results[:3]]
        self.assertIn(
            "10а", top_three,
            "Чл. 10а (conditions for placing tents/campers/caravans) missing "
            "from top 3; top 3 articles: %s" % (top_three,),
        )

    def test_answer_uses_camping_vocabulary(self):
        """A usable answer talks about tents, campers or caravans."""
        blob = " ".join((hit.get("content") or "") for hit in self.results).lower()
        self.assertTrue(
            any(word in blob for word in CAMPING_VOCABULARY),
            "none of %s appear in the returned content" % (CAMPING_VOCABULARY,),
        )

    def test_camping_hit_is_not_a_dune_prohibition_only(self):
        """Чл. 17а alone is the prohibition; the conditions must also be present.

        Guards against a cheap pass where the dune ban shows up but the
        permitted-conditions article is still missing.
        """
        articles = [article_of(hit) for hit in self.results]
        self.assertTrue(
            "10а" in articles or "24в" in articles,
            "only prohibition-type provisions returned, no conditions article: %s"
            % (articles,),
        )


@unittest.skipUnless(HAVE_CREDENTIALS, "RAG credentials not configured")
class KeywordPathTest(unittest.TestCase):
    """The keyword fallback alone must locate the camping provisions."""

    @classmethod
    def setUpClass(cls):
        cls.trace, cls.results = run_query(mode="keyword")

    def test_keyword_path_is_used(self):
        self.assertEqual(self.trace["path"], "keyword")
        self.assertTrue(self.trace.get("terms"))

    def test_keyword_finds_conditions_article(self):
        articles = [article_of(hit) for hit in self.results]
        self.assertIn(
            "10а", articles,
            "keyword search missed Чл. 10а; articles: %s" % (articles,),
        )


@unittest.skipUnless(HAVE_CREDENTIALS, "RAG credentials not configured")
class AutoModeRoutingTest(unittest.TestCase):
    """Auto mode must not stop at a weak vector result."""

    def test_auto_mode_reports_its_path(self):
        trace, results = run_query()
        self.assertIn(trace["path"], ("vector", "keyword", "vector+keyword"))
        self.assertEqual(trace["returned"], len(results))

    def test_auto_mode_does_not_trust_weak_vector_result(self):
        trace, results = run_query()
        weak, _ = rq.vector_is_weak(
            [r for r in results if r.get("matched_by") == "vector"], RESULT_COUNT
        )
        if weak:
            self.assertNotEqual(
                trace["path"], "vector",
                "vector result was weak (%s) but auto mode returned it alone"
                % (trace.get("vector_state"),),
            )


class PureFunctionTest(unittest.TestCase):
    """Unit-level checks that need no network or credentials."""

    def test_extract_terms_drops_stopwords_and_keeps_the_subject(self):
        terms = rq.extract_terms(QUESTION)
        self.assertIn("лагеруване", terms)
        self.assertIn("плажа", terms)
        for stopword in ("при", "са", "на"):
            self.assertNotIn(stopword, terms, "stopword leaked into terms")

    def test_expand_question_adds_camping_synonyms(self):
        expanded = rq.expand_question(QUESTION)
        for word in ("палатки", "кемпери", "каравани"):
            self.assertIn(word, expanded)

    def test_expand_question_adds_beach_legal_phrase(self):
        expanded = rq.expand_question(QUESTION)
        self.assertIn("извън територията на морските плажове", expanded)

    def test_expand_question_is_noop_without_triggers(self):
        self.assertEqual(rq.expand_question("Колко е часът?"), "Колко е часът?")

    def test_expand_question_does_not_duplicate_synonyms(self):
        expanded = rq.expand_question(QUESTION)
        self.assertEqual(expanded.count("палатки"), 1)

    def test_extract_terms_keeps_article_numbers(self):
        terms = rq.extract_terms("Чл. 10а за палатки")
        self.assertTrue(
            any(t for t in terms if "10" in t),
            "article number dropped from terms: %s" % (terms,),
        )

    def test_escape_filter_value_neutralises_like_wildcards(self):
        escaped = rq.escape_filter_value("100%_a,b")
        self.assertNotIn("%", escaped.replace("\\%", ""))
        self.assertNotIn(",", escaped.replace("\\,", ""))

    def test_vector_is_weak_on_empty_result(self):
        weak, reason = rq.vector_is_weak([], 5)
        self.assertTrue(weak)
        self.assertIn("no vector hits", reason)

    def test_vector_is_weak_below_top_similarity(self):
        hits = [{"similarity": 0.30}, {"similarity": 0.29}]
        weak, _ = rq.vector_is_weak(hits, 5)
        self.assertTrue(weak, "low top similarity must count as weak")

    def test_vector_is_strong_for_high_similarity_with_enough_hits(self):
        hits = [{"similarity": 0.80}, {"similarity": 0.70}]
        weak, _ = rq.vector_is_weak(hits, 5)
        self.assertFalse(weak, "high similarity with enough hits must not be weak")


if __name__ == "__main__":
    unittest.main(verbosity=2)