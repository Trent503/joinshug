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

ALT = ("Trent Delgadillo, soaked from a job, beside his Blue Heron pressure "
       "washing truck and hose reels.")

PICTURE = """<img src="{p}assets/img/trent-600.jpg"
             srcset="{p}assets/img/trent-600.jpg {w1}w, {p}assets/img/trent-1200.jpg {w2}w"
             sizes="(max-width:900px) 92vw, {maxw}px"
             width="{w1}" height="{h1}" loading="{load}" decoding="async"
             alt="{alt}"
             style="display:block;width:100%;max-width:{maxw}px;border-radius:18px;box-shadow:0 24px 48px rgba(33,30,27,0.18);">"""


def dims(path):
    """Actual pixel dimensions of a file on disk."""
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                         check=True, capture_output=True, text=True).stdout
    g = dict(l.strip().split(": ") for l in out.splitlines() if ": " in l)
    return int(g["pixelWidth"]), int(g["pixelHeight"])


def sips(src, dst, size, quality):
    # -Z fits the LONGEST side to `size`. For a portrait photo that caps the
    # height, so the resulting width is smaller than `size` — never assume the
    # output is `size` wide. Read the real dimensions back instead.
    subprocess.run(
        ["sips", "-Z", str(size), "-s", "format", "jpeg",
         "-s", "formatOptions", str(quality), src, "--out", dst],
        check=True, capture_output=True)
    w, h = dims(dst)
    return w, h, os.path.getsize(dst) // 1024


# The homepage kept the original design's inline-styled founder block; /about/
# was built on the class-based chrome. They need different anchors — a single
# marker silently matched only the homepage and skipped the story page.
ANCHORS = [
    # page, depth, regex, insert, max-width, loading
    ("index.html", 0,
     r'<div style="display:flex;align-items:center;gap:14px;margin:30px 0 0;">',
     "before", 380, "lazy"),
    ("about/index.html", 1,
     r'<p class="lede mt-3">.*?</p>',
     "after", 420, "eager"),
]


def patch(page, depth, pattern, where, maxw, load, w1, h1, w2):
    path = os.path.join(ROOT, page)
    s = open(path).read()
    if "trent-600.jpg" in s:
        print(f"  {page}: already has the portrait, left alone")
        return True

    m = re.search(pattern, s, re.S)
    if not m:
        print(f"  {page}: ANCHOR NOT FOUND -- portrait not added")
        return False

    pic = PICTURE.format(p="../" * depth, alt=ALT, w1=w1, h1=h1, w2=w2,
                         maxw=maxw, load=load)
    block = f'<div style="margin:32px 0 0;">{pic}</div>'
    at = m.start() if where == "before" else m.end()
    s = s[:at] + (block + "\n      " if where == "before" else "\n      " + block) + s[at:]
    open(path, "w").write(s)
    print(f"  {page}: portrait added")
    return True


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    src = os.path.abspath(os.path.expanduser(argv[1]))
    if not os.path.exists(src):
        print(f"no such file: {src}")
        return 1

    os.makedirs(IMG, exist_ok=True)
    # The large variant displays at 420 CSS px, so it is downscaled ~2x on
    # retina and tolerates heavy compression. The small variant serves 1x
    # screens at close to 1:1, where artifacts would show -- keep it higher.
    w2, h2, kb2 = sips(src, os.path.join(IMG, "trent-1200.jpg"), 1200, 45)
    w1, h1, kb1 = sips(src, os.path.join(IMG, "trent-600.jpg"), 600, 55)
    print(f"assets/img/trent-1200.jpg  {w2}x{h2}  {kb2} KB")
    print(f"assets/img/trent-600.jpg   {w1}x{h1}  {kb1} KB")

    ok = [patch(pg, d, pat, wh, mw, ld, w1, h1, w2)
          for pg, d, pat, wh, mw, ld in ANCHORS]
    if not all(ok):
        print("\nSome pages were not patched. Fix ANCHORS before committing.")
        return 1

    print("\nnow run:  python3 tools/check.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
