#!/usr/bin/env python3
"""Generate a sphere-uniform land-point dataset for the /v2/ footprint globe.

Output: themes/synapsyx/assets/v2/landmask.json — a flat JSON array of
[lat, lng, lat, lng, ...] floats (1 decimal place) describing land points
on a Fibonacci sphere. globe.js reads this and draws a Stripe-style
dot-matrix landmass that rotates with the sphere.

Source: Wikipedia Commons "Equirectangular_projection_SW.jpg" — a public-
domain NASA Blue Marble derivative. The 1280px equirectangular variant is
plenty since we sample on the order of 10K times across the whole sphere.

Usage:
    python3 scripts/generate-landmask.py [N]

N = total Fibonacci sphere points (default 10000). Roughly ~30% will be
land, so N=10000 -> ~3000 dots, N=14000 -> ~4200 dots.
"""

import io
import json
import math
import os
import sys
import urllib.request

from PIL import Image

SOURCE_URL = (
    "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/"
    "Equirectangular_projection_SW.jpg/1280px-Equirectangular_projection_SW.jpg"
)
DEFAULT_N = 10000
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT = os.path.join(
    REPO_ROOT, "themes", "synapsyx", "assets", "v2", "landmask.json"
)


def fetch_image(url):
    # Wikipedia's CDN rejects vague UAs with HTTP 400; mimic a browser.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 synx-landmask/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


def is_land(r, g, b):
    # Blue-channel-dominant pixels are ocean (the bathymetric blue ramp).
    # Everything else — green vegetation, tan deserts, white snow/ice —
    # counts as land. Threshold tuned empirically against the NASA image:
    # ocean blue is roughly (10..70, 30..100, 100..190); coasts are mixed.
    if b > r + 8 and b > g + 8 and b > 60:
        return False
    return True


def fibonacci_sphere(n):
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - (i / (n - 1)) * 2
        radius = math.sqrt(max(0.0, 1 - y * y))
        theta = i * golden
        x = math.cos(theta) * radius
        z = math.sin(theta) * radius
        yield x, y, z


def vec_to_latlng(x, y, z):
    lat = math.degrees(math.asin(max(-1.0, min(1.0, y))))
    lng = math.degrees(math.atan2(z, x))
    return lat, lng


def detect_map_bounds(img):
    # Wikipedia's NASA Blue Marble JPEG has a ~3px white frame + 1px dark line
    # around the actual equirectangular map. Sampling those framing pixels makes
    # the dateline meridian and poles erroneously read as "land", so find the
    # inner map bounds by scanning from each edge until we hit a non-near-white
    # non-near-black pixel.
    w, h = img.size
    px = img.load()

    # The map is wrapped in a white border + a thin near-black frame line.
    # Find that dark line scanning inward from each edge; the actual map starts
    # one pixel beyond it. Sampling at h/2 (left/right) is safe — Antarctica
    # is white-ish and would defeat any "first non-grayscale pixel" heuristic.
    def first_dark_line(seq):
        for i, (r, g, b) in enumerate(seq):
            if r < 30 and g < 30 and b < 40:
                return i
        return 0

    left = first_dark_line(px[x, h // 2] for x in range(min(40, w // 2))) + 1
    right = w - 1 - first_dark_line(px[w - 1 - x, h // 2] for x in range(min(40, w // 2))) - 1
    top = first_dark_line(px[w // 2, y] for y in range(min(40, h // 2))) + 1
    bottom = h - 1 - first_dark_line(px[w // 2, h - 1 - y] for y in range(min(40, h // 2))) - 1
    return left, top, right + 1, bottom + 1  # right/bottom exclusive


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_N
    print(f"Fetching: {SOURCE_URL}", file=sys.stderr)
    img = fetch_image(SOURCE_URL)
    w_full, h_full = img.size
    x0, y0, x1, y1 = detect_map_bounds(img)
    w, h = x1 - x0, y1 - y0
    pixels = img.load()
    print(
        f"Image: {w_full}x{h_full}, map bounds ({x0},{y0})..({x1},{y1}) -> {w}x{h}, sampling {n} Fibonacci points",
        file=sys.stderr,
    )

    flat = []
    land = 0
    for x, y, z in fibonacci_sphere(n):
        lat, lng = vec_to_latlng(x, y, z)
        ix = x0 + (int((lng + 180.0) / 360.0 * w) % w)
        iy = y0 + int((90.0 - lat) / 180.0 * h)
        if iy < y0:
            iy = y0
        elif iy >= y1:
            iy = y1 - 1
        r, g, b = pixels[ix, iy]
        if is_land(r, g, b):
            flat.append(round(lat, 1))
            flat.append(round(lng, 1))
            land += 1

    payload = json.dumps(flat, separators=(",", ":"))
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w") as f:
        f.write(payload)
    print(
        f"Wrote {land} land points -> {OUTPUT} ({len(payload)} bytes raw)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
