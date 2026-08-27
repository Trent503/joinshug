#!/usr/bin/env python3
"""
Add the founder portrait to /about/ and the homepage founder section.

    python3 tools/add-portrait.py ~/Downloads/trent-portrait.jpg

Generates assets/img/trent-600.jpg and trent-1200.jpg at the right sizes,
then swaps the "TD" initials block for a real <picture> on both pages.

Safe to re-run: it regenerates the images and leaves already-patched markup
alone. Uses macOS `sips`, which is built in — no dependencies.
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "assets", "img")

ALT = ("Trent Delgadillo in a Blue Heron Services shirt beside his pressure "
       "washing truck.")

PICTURE = """<img src="{p}assets/img/trent-600.jpg"
             srcset="{p}assets/img/trent-600.jpg 600w, {p}assets/img/trent-1200.jpg 1200w"
             sizes="(max-width:900px) 92vw, 380px"
             width="600" height="800" loading="lazy" decoding="async"
             alt="{alt}"
             style="display:block;width:100%;max-width:380px;border-radius:18px;box-shadow:0 24px 48px rgba(33,30,27,0.18);">"""


def sips(src, dst, size, quality):
    subprocess.run(
        ["sips", "-Z", str(size), "-s", "format", "jpeg",
         "-s", "formatOptions", str(quality), src, "--out", dst],
        check=True, capture_output=True)
    return os.path.getsize(dst) // 1024


def patch(page, depth):
    """Replace the TD initials circle with the portrait, above the name block."""
    path = os.path.join(ROOT, page)
    s = open(path).read()
    if "trent-600.jpg" in s:
        print(f"  {page}: already has the portrait, left alone")
        return
    p = "../" * depth
    pic = PICTURE.format(p=p, alt=ALT)

    # The name block starts with the TD avatar span; insert the photo before it.
    marker = ('<div style="display:flex;align-items:center;gap:14px;'
              'margin:30px 0 0;">')
    if marker not in s:
        print(f"  {page}: founder block not found, skipped")
        return
    s = s.replace(marker, f'<div style="margin:32px 0 0;">{pic}</div>\n      ' + marker, 1)
    open(path, "w").write(s)
    print(f"  {page}: portrait added")


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    src = os.path.abspath(os.path.expanduser(argv[1]))
    if not os.path.exists(src):
        print(f"no such file: {src}")
        return 1

    os.makedirs(IMG, exist_ok=True)
    a = sips(src, os.path.join(IMG, "trent-1200.jpg"), 1200, 60)
    b = sips(src, os.path.join(IMG, "trent-600.jpg"), 600, 62)
    print(f"assets/img/trent-1200.jpg ({a} KB), trent-600.jpg ({b} KB)")

    patch("about/index.html", 1)
    patch("index.html", 0)

    print("\nnow run:  python3 tools/check.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
