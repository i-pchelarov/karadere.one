#!/usr/bin/env python3
"""Behavioural tests for the boundary-map renderer (``make_boundary_map.py``).

Hermetic: builds a synthetic coordinate register in a temp directory, runs the
script with ``--source none`` (no network, no tiles), and checks the contract --
ring detection, areas, projection, and the SVG it writes. Always runs in CI.

Run from this directory:

    python3 -m unittest test_make_boundary_map -v
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "make_boundary_map.py")

sys.path.insert(0, HERE)
import make_boundary_map as mbm  # noqa: E402


def square(cx, cy, side, start, step=100.0):
    """A closed square ring: 4 corners plus the repeated first point."""
    h = side / 2.0
    corners = [(cx - h, cy - h), (cx + h, cy - h), (cx + h, cy + h), (cx - h, cy + h)]
    pts = [(start + i, x, y) for i, (x, y) in enumerate(corners)]
    pts.append((start + 4, corners[0][0], corners[0][1]))
    return pts


class TestNumberParsing(unittest.TestCase):
    def test_dot_decimal(self):
        self.assertAlmostEqual(mbm.parse_number("571424.070"), 571424.070)

    def test_comma_decimal(self):
        self.assertAlmostEqual(mbm.parse_number("571424,070"), 571424.070)

    def test_thousands_and_decimal(self):
        self.assertAlmostEqual(mbm.parse_number("1.234,56"), 1234.56)

    def test_plain_integer(self):
        self.assertAlmostEqual(mbm.parse_number("42"), 42.0)


class TestRingDetection(unittest.TestCase):
    def test_single_ring(self):
        pts = square(570000, 4755000, 1000, 1)
        rings = mbm.split_rings(pts)
        self.assertEqual(len(rings), 1)
        self.assertEqual(len(rings[0]), 5)

    def test_outer_plus_hole(self):
        pts = square(570000, 4755000, 1000, 1) + square(570000, 4755000, 200, 6)
        rings = mbm.split_rings(pts)
        self.assertEqual(len(rings), 2)
        self.assertEqual([len(r) for r in rings], [5, 5])

    def test_large_gap_inside_a_ring_does_not_split_it(self):
        # A coarse boundary: one edge is 1500 m while the rest are short.
        pts = [(1, 570000, 4755000), (2, 571500, 4755000),
               (3, 571500, 4755100), (4, 570000, 4755100),
               (5, 570000, 4755000)]
        rings = mbm.split_rings(pts)
        self.assertEqual(len(rings), 1)

    def test_area_of_a_square(self):
        pts = square(570000, 4755000, 1000, 1)
        self.assertAlmostEqual(abs(mbm.ring_area_m2(pts)) / 1e6, 1.0, places=6)


class TestProjection(unittest.TestCase):
    def test_utm_35n_round_trip_known_point(self):
        # Central meridian of zone 35N is 27°E; on it, northing == latitude arc.
        lat, lon = mbm.UTM(zone=35).to_latlon(500000.0, 4755000.0)
        self.assertAlmostEqual(lon, 27.0, places=6)
        self.assertAlmostEqual(lat, 42.947, places=2)


class TestEndToEnd(unittest.TestCase):
    def _run(self, csv_text, *extra):
        tmp = tempfile.mkdtemp()
        csv_path = os.path.join(tmp, "coords.csv")
        with open(csv_path, "w", encoding="utf-8") as fh:
            fh.write(csv_text)
        out = os.path.join(tmp, "map.svg")
        proc = subprocess.run(
            [sys.executable, SCRIPT, "--csv", csv_path, "--source", "none",
             "--out", out, *extra],
            capture_output=True, text=True)
        return proc, out

    def test_reports_two_rings_and_net_area(self):
        rows = ["number,x,y"]
        for n, x, y in square(570000, 4755000, 1000, 1) + square(570000, 4755000, 200, 6):
            rows.append(f"{n},{x:.3f},{y:.3f}")
        proc, out = self._run("\n".join(rows) + "\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("rings: 2", proc.stdout)
        # 1.0 km² outer minus 0.04 km² hole
        self.assertIn("net area: 0.960 km²", proc.stdout)
        self.assertTrue(os.path.exists(out))

    def test_accepts_comma_decimals(self):
        rows = ["number,x,y"]
        for n, x, y in square(570000, 4755000, 1000, 1):
            rows.append(f'{n},"{x:.3f}","{y:.3f}"'.replace(".", ","))
        proc, out = self._run("\n".join(rows) + "\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("rings: 1", proc.stdout)
        with open(out, encoding="utf-8") as fh:
            svg = fh.read()
        self.assertIn("<svg", svg)

    def test_svg_is_self_contained_and_has_the_polygon(self):
        rows = ["number,x,y"]
        for n, x, y in square(570000, 4755000, 1000, 1):
            rows.append(f"{n},{x:.3f},{y:.3f}")
        proc, out = self._run("\n".join(rows) + "\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out, encoding="utf-8") as fh:
            svg = fh.read()
        self.assertIn("<svg", svg)
        self.assertIn('fill-rule="evenodd"', svg)
        self.assertRegex(svg, r'<path d="M [\d.,\sL]+Z"')
        # No external references: everything is inline.
        self.assertNotIn("http://", svg.replace("http://www.w3.org/2000/svg", ""))
        self.assertNotIn("https://", svg)

    def test_polygon_stays_inside_the_canvas(self):
        rows = ["number,x,y"]
        for n, x, y in square(570000, 4755000, 1000, 1):
            rows.append(f"{n},{x:.3f},{y:.3f}")
        proc, out = self._run("\n".join(rows) + "\n", "--east-extra", "0.25")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out, encoding="utf-8") as fh:
            svg = fh.read()
        w = int(re.search(r'width="(\d+)"', svg).group(1))
        h = int(re.search(r'height="(\d+)"', svg).group(1))
        d = re.search(r'<path d="([^"]+)"', svg).group(1)
        nums = re.findall(r"(-?\d+\.?\d*),(-?\d+\.?\d*)", d)
        xs = [float(a) for a, b in nums]
        ys = [float(b) for a, b in nums]
        self.assertGreaterEqual(min(xs), 0)
        self.assertLessEqual(max(xs), w)
        self.assertGreaterEqual(min(ys), 0)
        self.assertLessEqual(max(ys), h)
        # The east frame must leave room for the sea.
        self.assertGreater(w - max(xs), 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
