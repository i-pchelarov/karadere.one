#!/usr/bin/env python3
"""Render a boundary map (SVG) from a coordinate register CSV.

Reads a CSV with columns ``number,x,y`` (UTM easting/northing, decimal point or
decimal comma), projects the points to WGS84, detects the closed rings, and
writes a self-contained SVG with an optional tiled basemap embedded as base64
``<image>`` elements. No third-party dependencies — Python stdlib only.

Usage:
  make_boundary_map.py --csv coords.csv --out map.svg
  make_boundary_map.py --csv coords.csv --source esri --east-extra 0.25 --out map.svg
  make_boundary_map.py --csv coords.csv --source none --out plain.svg
"""
from __future__ import annotations

import argparse
import base64
import csv
import math
import os
import statistics
import sys
import urllib.request

TILE = 256
R = 6378137.0  # WGS84 semi-major axis

SOURCES = {
    "osm": {
        "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "ext": "png",
        "mime": "image/png",
        "attr": "© OpenStreetMap contributors",
    },
    "esri": {
        "url": "https://server.arcgisonline.com/ArcGIS/rest/services/"
               "World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "ext": "jpg",
        "mime": "image/jpeg",
        "attr": "Esri, Maxar, Earthstar Geographics",
    },
}
UA = "karadere.one-boundary-map/1.0"


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def parse_number(raw: str) -> float:
    """Accept both ``571424.070`` and ``571424,070`` (and ``1.234,56``)."""
    s = raw.strip().replace("\u00a0", "").replace(" ", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    return float(s)


def read_points(path: str):
    """Return [(number, x, y)] sorted by number; tolerates a header row."""
    pts = []
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.reader(fh):
            if len(row) < 3:
                continue
            try:
                n = int(row[0].strip())
                x = parse_number(row[1])
                y = parse_number(row[2])
            except ValueError:
                continue  # header or junk
            pts.append((n, x, y))
    if not pts:
        raise SystemExit(f"no coordinate rows found in {path}")
    pts.sort(key=lambda p: p[0])
    return pts


# --------------------------------------------------------------------------- #
# Projection: UTM -> WGS84 (own inverse Transverse Mercator)
# --------------------------------------------------------------------------- #
class UTM:
    def __init__(self, zone: int = 35, south: bool = False):
        self.A = 6378137.0
        f = 1.0 / 298.257223563
        self.E2 = f * (2.0 - f)
        self.EP2 = self.E2 / (1.0 - self.E2)
        self.K0 = 0.9996
        self.LON0 = math.radians(zone * 6 - 183)
        self.FALSE_NORTH = 10000000.0 if south else 0.0

    def to_latlon(self, e: float, n: float):
        A, E2, EP2, K0 = self.A, self.E2, self.EP2, self.K0
        m = (n - self.FALSE_NORTH) / K0
        mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))
        e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
        phi1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
                + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
                + (151 * e1**3 / 96) * math.sin(6 * mu)
                + (1097 * e1**4 / 512) * math.sin(8 * mu))
        sp, cp, tp = math.sin(phi1), math.cos(phi1), math.tan(phi1)
        c1 = EP2 * cp**2
        t1 = tp**2
        n1 = A / math.sqrt(1 - E2 * sp**2)
        r1 = A * (1 - E2) / (1 - E2 * sp**2) ** 1.5
        d = (e - 500000.0) / (n1 * K0)
        lat = phi1 - (n1 * tp / r1) * (
            d**2 / 2
            - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * EP2) * d**4 / 24
            + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * EP2 - 3 * c1**2)
            * d**6 / 720)
        lon = self.LON0 + (
            d - (1 + 2 * t1 + c1) * d**3 / 6
            + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * EP2 + 24 * t1**2)
            * d**5 / 120) / cp
        return math.degrees(lat), math.degrees(lon)


def lonlat_to_merc(lon: float, lat: float):
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


# --------------------------------------------------------------------------- #
# Rings
# --------------------------------------------------------------------------- #
def split_rings(pts, tol: float | None = None):
    """Split the register into closed rings.

    A register may hold several rings (e.g. an outer boundary plus an excluded
    hole). Each ring closes on itself: its last point coincides with its first
    (e.g. ``#1999 -> #1`` and ``#2872 -> #2000`` are 0 m apart). Walk the
    sequence and cut a ring whenever the current point returns to the ring's
    start. Gaps *inside* a ring can be large (coarse boundary), so distance
    alone is not a reliable separator.

    ``tol`` is the closure tolerance in metres; by default a quarter of the
    median gap (at least 0.5 m), which is well below the spacing between
    distinct vertices.
    """
    if len(pts) < 3:
        return [pts]
    gaps = [math.dist((pts[i][1], pts[i][2]), (pts[i + 1][1], pts[i + 1][2]))
            for i in range(len(pts) - 1)]
    if tol is None:
        tol = max(statistics.median(gaps) * 0.25, 0.5)

    rings, start = [], 0
    i = 1
    while i < len(pts):
        if math.dist((pts[i][1], pts[i][2]),
                     (pts[start][1], pts[start][2])) <= tol:
            rings.append(pts[start:i + 1])
            start = i + 1
            i = start + 1
        else:
            i += 1
    if start < len(pts):
        rings.append(pts[start:])
    return [r for r in rings if len(r) >= 3]


def ring_area_m2(ring) -> float:
    """Signed shoelace area in the projected (metre) plane."""
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i][1], ring[i][2]
        x2, y2 = ring[(i + 1) % len(ring)][1], ring[(i + 1) % len(ring)][2]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def _point_in_ring(px: float, py: float, ring) -> bool:
    """Ray-casting point-in-polygon test in the projected plane."""
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][1], ring[i][2]
        x2, y2 = ring[(i + 1) % n][1], ring[(i + 1) % n][2]
        if (y1 > py) != (y2 > py):
            xin = (x2 - x1) * (py - y1) / (y2 - y1) + x1
            if px < xin:
                inside = not inside
    return inside


def net_area_m2(rings) -> float:
    """Net area: outer rings add, rings nested inside another ring subtract.

    The register's first ring is the outer boundary and later rings are
    excluded territories (holes). Winding order is not trusted, so nesting is
    decided by containment instead of by the sign of the shoelace area.
    """
    areas = [abs(ring_area_m2(r)) for r in rings]
    total = 0.0
    for i, ring in enumerate(rings):
        cx = sum(p[1] for p in ring) / len(ring)
        cy = sum(p[2] for p in ring) / len(ring)
        # A ring is a hole only if it sits inside a *larger* ring; comparing
        # areas keeps concentric rings from cancelling each other out.
        nested = any(
            j != i and areas[j] > areas[i] and _point_in_ring(cx, cy, other)
            for j, other in enumerate(rings))
        total += -areas[i] if nested else areas[i]
    return total


# --------------------------------------------------------------------------- #
# Tiles
# --------------------------------------------------------------------------- #
def fetch_tile(source: str, z: int, x: int, y: int, cache: str) -> bytes:
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"{source}_{z}_{x}_{y}.{SOURCES[source]['ext']}")
    if not os.path.exists(path):
        url = SOURCES[source]["url"].format(z=z, x=x, y=y)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        with open(path, "wb") as fh:
            fh.write(data)
    with open(path, "rb") as fh:
        return fh.read()


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Render a boundary map SVG from a coordinate register CSV.")
    ap.add_argument("--csv", required=True,
                    help="CSV with columns number,x,y (UTM easting/northing)")
    ap.add_argument("--out", help="output SVG (default: <csv>.svg)")
    ap.add_argument("--source", choices=["osm", "esri", "none"], default="osm",
                    help="basemap tiles (default: osm)")
    ap.add_argument("--zone", type=int, default=35, help="UTM zone (default: 35)")
    ap.add_argument("--south", action="store_true", help="southern hemisphere")
    ap.add_argument("--width", type=int, default=1800,
                    help="target map width in px (default: 1800)")
    ap.add_argument("--east-extra", type=float, default=0.20,
                    help="extra frame width on the east, as a fraction of the "
                         "bbox width (default: 0.20)")
    ap.add_argument("--margin", type=int, default=60,
                    help="frame margin in px (default: 60)")
    ap.add_argument("--closure-tol", type=float, default=None,
                    help="ring closure tolerance in metres (default: auto)")
    ap.add_argument("--title", default=None, help="map title")
    ap.add_argument("--subtitle", default=None, help="map subtitle")
    ap.add_argument("--cache", default=os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "karadere-map-tiles"),
        help="tile cache directory")
    args = ap.parse_args(argv)

    out = args.out or (os.path.splitext(args.csv)[0] + ".svg")

    pts = read_points(args.csv)
    utm = UTM(zone=args.zone, south=args.south)
    rings = split_rings(pts, args.closure_tol)

    # project every ring to lat/lon then to Web Mercator
    ll_rings = [[utm.to_latlon(x, y) for _, x, y in ring] for ring in rings]
    merc_rings = [[lonlat_to_merc(lon, lat) for lat, lon in ring]
                  for ring in ll_rings]
    all_ll = [p for ring in ll_rings for p in ring]
    all_merc = [p for ring in merc_rings for p in ring]

    xs = [p[0] for p in all_merc]
    ys = [p[1] for p in all_merc]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)

    # pick the highest zoom whose bbox width still fits the target width
    z = 9
    for cand in range(19, 8, -1):
        scale = TILE * (2 ** cand) / (2 * math.pi * R)
        if (x_max - x_min) * scale <= args.width:
            z = cand
            break
    scale = TILE * (2 ** z) / (2 * math.pi * R)

    margin = args.margin
    east_extra = int((x_max - x_min) * scale * args.east_extra)
    img_w = int((x_max - x_min) * scale) + 2 * margin + east_extra
    img_h = int((y_max - y_min) * scale) + 2 * margin
    ox = x_min - margin / scale
    oy = y_max + margin / scale

    def px(x):
        return (x - ox) * scale

    def py(y):
        return (oy - y) * scale

    # areas (outer rings add, nested rings subtract)
    areas = [ring_area_m2(r) for r in rings]
    net_area = net_area_m2(rings)

    print(f"points: {len(pts)}  rings: {len(rings)} "
          f"({', '.join(str(len(r)) for r in rings)})")
    for i, a in enumerate(areas):
        print(f"  ring {i + 1}: {len(rings[i])} pts, {abs(a) / 1e6:.3f} km²")
    print(f"net area: {net_area / 1e6:.3f} km²")
    print(f"zoom {z}, image {img_w}x{img_h}")

    # ---- basemap tiles ---------------------------------------------------- #
    images = []
    if args.source != "none":
        world = TILE * (2 ** z)
        tx0 = int((ox + math.pi * R) / (2 * math.pi * R) * world // TILE)
        tx1 = int((ox + img_w / scale + math.pi * R) / (2 * math.pi * R)
                  * world // TILE)
        ty0 = int((math.pi * R - oy) / (2 * math.pi * R) * world // TILE)
        ty1 = int((math.pi * R - (oy - img_h / scale)) / (2 * math.pi * R)
                  * world // TILE)
        print(f"tiles x {tx0}..{tx1} y {ty0}..{ty1}")
        n = 0
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                data = fetch_tile(args.source, z, tx, ty, args.cache)
                b64 = base64.b64encode(data).decode("ascii")
                tmx = tx * TILE / scale - math.pi * R
                tmy = math.pi * R - ty * TILE / scale
                images.append(
                    f'<image x="{px(tmx):.1f}" y="{py(tmy):.1f}" '
                    f'width="{TILE}" height="{TILE}" preserveAspectRatio="none" '
                    f'href="data:{SOURCES[args.source]["mime"]};base64,{b64}"/>')
                n += 1
        print(f"tiles embedded: {n}")

    # ---- graticule -------------------------------------------------------- #
    lats = [p[0] for p in all_ll]
    lons = [p[1] for p in all_ll]
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)

    def nice_step(span):
        for s in (0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2):
            if span / s <= 12:
                return s
        return 0.5

    lat_step = nice_step(lat_max - lat_min)
    lon_step = nice_step(lon_max - lon_min)
    grat = ['<g stroke="#ffffff" stroke-opacity="0.55" stroke-width="1" '
            'fill="none">']
    labels = []
    t = math.floor(lat_min / lat_step) * lat_step
    while t <= lat_max + 1e-12:
        if t >= lat_min:
            _, ym = lonlat_to_merc(lon_min, t)
            y = py(ym)
            grat.append(f'<line x1="0" y1="{y:.1f}" x2="{img_w}" y2="{y:.1f}"/>')
            labels.append(
                f'<text x="6" y="{y - 4:.1f}" font-size="13" fill="#fff" '
                f'stroke="#000" stroke-width="3" paint-order="stroke" '
                f'font-family="Helvetica,Arial">{t:.4f}°N</text>')
        t += lat_step
    t = math.floor(lon_min / lon_step) * lon_step
    while t <= lon_max + 1e-12:
        if t >= lon_min:
            xm, _ = lonlat_to_merc(t, lat_min)
            x = px(xm)
            grat.append(f'<line x1="{x:.1f}" y1="0" x2="{x:.1f}" y2="{img_h}"/>')
            labels.append(
                f'<text x="{x + 4:.1f}" y="{img_h - 8:.1f}" font-size="13" '
                f'fill="#fff" stroke="#000" stroke-width="3" '
                f'paint-order="stroke" font-family="Helvetica,Arial">'
                f'{t:.4f}°E</text>')
        t += lon_step
    grat.append("</g>")

    # ---- polygon ---------------------------------------------------------- #
    subpaths = []
    for ring in merc_rings:
        pts_s = " ".join(f"{px(x):.2f},{py(y):.2f}" for x, y in ring)
        subpaths.append(f"M {pts_s.replace(' ', ' L ')} Z")
    path_d = " ".join(subpaths)

    # ---- title / legend --------------------------------------------------- #
    title = args.title or "Граница на защитена зона"
    if args.subtitle is None:
        attr = SOURCES[args.source]["attr"] if args.source != "none" else "без фон"
        args.subtitle = (f"{len(pts)} точки · {len(rings)} контура · WGS84 · "
                         f"площ {net_area / 1e6:.3f} km² · {attr}")

    legend = []
    if len(rings) > 1:
        legend.append(
            f'<rect x="{img_w - 360}" y="{img_h - 64}" width="360" height="64" '
            f'fill="#000" fill-opacity="0.55"/>')
        legend.append(
            f'<rect x="{img_w - 348}" y="{img_h - 52}" width="14" height="14" '
            f'fill="#ffd400" fill-opacity="0.28" stroke="#ff2d2d" '
            f'stroke-width="2"/>')
        legend.append(
            f'<text x="{img_w - 328}" y="{img_h - 40}" font-size="13" '
            f'fill="#fff">външен контур ({len(rings[0])} т.)</text>')
        legend.append(
            f'<rect x="{img_w - 348}" y="{img_h - 30}" width="14" height="14" '
            f'fill="#000" fill-opacity="0.2" stroke="#ff2d2d" stroke-width="2"/>')
        legend.append(
            f'<text x="{img_w - 328}" y="{img_h - 18}" font-size="13" '
            f'fill="#fff">изключена територия ({len(rings[1])} т.)</text>')

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{img_w}" height="{img_h}" viewBox="0 0 {img_w} {img_h}">
<rect width="{img_w}" height="{img_h}" fill="#dfe7ee"/>
{chr(10).join(images)}
{chr(10).join(grat)}
{chr(10).join(labels)}
<path d="{path_d}" fill="#ffd400" fill-opacity="0.28" fill-rule="evenodd"
      stroke="#ff2d2d" stroke-width="2.6" stroke-linejoin="round"/>
<g font-family="Helvetica,Arial">
  <rect x="0" y="0" width="{img_w}" height="58" fill="#000" fill-opacity="0.55"/>
  <text x="{img_w / 2:.0f}" y="26" font-size="21" font-weight="bold" text-anchor="middle" fill="#fff">{title}</text>
  <text x="{img_w / 2:.0f}" y="47" font-size="13" text-anchor="middle" fill="#e8eef4">{args.subtitle}</text>
  {chr(10).join(legend)}
</g>
</svg>
'''
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"wrote: {out} ({len(svg)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
