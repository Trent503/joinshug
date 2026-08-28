#!/usr/bin/env python3
"""
Pre-flight check for joinshug.com. Zero dependencies.

    python3 tools/check.py

Verifies, across every page:
  - exactly one <h1>, a <title>, a meta description, and a canonical
  - title <= 60 chars, description 140-158 chars
  - every internal link resolves to a real file on disk
  - every JSON-LD block parses, and FAQPage answers match the visible copy
  - every in-page #anchor target exists
  - required head tags (viewport, lang, og:*, twitter:card, theme-color)
  - <img> tags carry width, height, and alt

Exit code 1 if anything fails. This is not a substitute for Lighthouse — it
checks structure and correctness, not performance.
"""

import html as htmllib
import json
import os
import re
import sys
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []
warnings = []


def err(page, msg):
    errors.append(f"{page}: {msg}")


def warn(page, msg):
    warnings.append(f"{page}: {msg}")


def pages():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "tools", ".github")]
        for fn in filenames:
            if fn.endswith(".html"):
                out.append(os.path.relpath(os.path.join(dirpath, fn), ROOT))
    return sorted(out)


def strip_tags(s):
    s = re.sub(r"<(script|style).*?</\1>", " ", s, flags=re.S)
    return re.sub(r"<[^>]+>", " ", s)


def check(page):
    path = os.path.join(ROOT, page)
    s = open(path).read()
    is404 = page == "404.html"

    # ---- structure -------------------------------------------------------
    if s.count("<h1") != 1:
        err(page, f"expected 1 <h1>, found {s.count('<h1')}")
    if '<html lang="en">' not in s:
        err(page, "missing <html lang=\"en\">")
    if 'name="viewport"' not in s:
        err(page, "missing viewport meta")
    if 'name="theme-color"' not in s:
        err(page, "missing theme-color")
    for prop in ("og:title", "og:description", "og:url", "og:image", "og:type", "og:site_name"):
        if f'property="{prop}"' not in s:
            err(page, f"missing {prop}")
    if 'name="twitter:card"' not in s:
        err(page, "missing twitter:card")

    # ---- title / description --------------------------------------------
    m = re.search(r"<title>(.*?)</title>", s, re.S)
    if not m:
        err(page, "no <title>")
    else:
        t = htmllib.unescape(m.group(1)).strip()
        if len(t) > 60:
            err(page, f"title {len(t)} chars (max 60): {t!r}")

    m = re.search(r'<meta name="description" content="(.*?)">', s, re.S)
    if not m:
        err(page, "no meta description")
    else:
        d = htmllib.unescape(m.group(1)).strip()
        if not (140 <= len(d) <= 158):
            err(page, f"description {len(d)} chars (want 140-158)")

    if is404:
        if 'name="robots" content="noindex"' not in s:
            err(page, "404 should be noindex")
    else:
        m = re.search(r'<link rel="canonical" href="(.*?)">', s)
        if not m:
            err(page, "no canonical")
        else:
            c = m.group(1)
            expected = "https://joinshug.com/" if page == "index.html" \
                else "https://joinshug.com/" + os.path.dirname(page) + "/"
            if c != expected:
                err(page, f"canonical {c} != expected {expected}")

    # ---- images ----------------------------------------------------------
    for tag in re.findall(r"<img\b[^>]*>", s):
        for attr in ("width=", "height=", "alt="):
            if attr not in tag:
                err(page, f"<img> missing {attr.rstrip('=')}: {tag[:70]}")

    # ---- internal links --------------------------------------------------
    base = os.path.dirname(path)
    anchors = set(re.findall(r'\bid="([^"]+)"', s))
    for href in re.findall(r'href="([^"]+)"', s):
        if href.startswith(("http://", "https://", "mailto:", "tel:", "data:")):
            continue
        if href.startswith("#"):
            if href[1:] and href[1:] not in anchors:
                err(page, f"dead in-page anchor {href}")
            continue
        target, _, frag = href.partition("#")
        if not target:
            continue
        if target.startswith("/"):
            # root-absolute (404.html only)
            fs = os.path.join(ROOT, target.lstrip("/"))
        else:
            fs = os.path.normpath(os.path.join(base, target))
        if target.endswith("/") or os.path.isdir(fs):
            fs = os.path.join(fs, "index.html")
        if not os.path.exists(fs):
            err(page, f"broken link {href} -> {os.path.relpath(fs, ROOT)}")

    # ---- JSON-LD ---------------------------------------------------------
    visible = " ".join(strip_tags(s).split())
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S):
        try:
            data = json.loads(block)
        except json.JSONDecodeError as e:
            err(page, f"JSON-LD parse error: {e}")
            continue
        if data.get("@type") == "FAQPage":
            for qa in data.get("mainEntity", []):
                q = qa.get("name", "")
                a = qa.get("acceptedAnswer", {}).get("text", "")
                for label, text in (("question", q), ("answer", a)):
                    norm = " ".join(htmllib.unescape(text).split())
                    if norm and norm not in visible:
                        err(page, f"FAQ {label} not in visible copy: {norm[:60]!r}")

    # ---- unfilled placeholders -------------------------------------------
    # A dead tel: link on the demo CTA is worse than no CTA, so make it loud.
    if "tel:+15550000000" in s or "(555) 000-0000" in s:
        warn(page, "demo phone number is still the placeholder "
                   "-- run tools/set-demo-number.py before deploying")

    # ---- assets referenced ----------------------------------------------
    for src in re.findall(r'(?:src|href)="((?:\.\./)*assets/[^"]+)"', s):
        fs = os.path.normpath(os.path.join(base, src))
        if not os.path.exists(fs):
            err(page, f"missing asset {src}")
    for src in re.findall(r'(?:src|href)="(/assets/[^"]+)"', s):
        if not os.path.exists(os.path.join(ROOT, src.lstrip("/"))):
            err(page, f"missing asset {src}")


def main():
    ps = pages()
    for p in ps:
        check(p)

    print(f"checked {len(ps)} pages\n")
    for w in warnings:
        print("WARN  " + w)
    for e in errors:
        print("FAIL  " + e)
    if not errors:
        print("all checks passed")
    print(f"\n{len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
