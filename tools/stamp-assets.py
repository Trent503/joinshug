#!/usr/bin/env python3
"""
Stamp assets/site.css and assets/site.js with a content-hash query string.

    python3 tools/stamp-assets.py

Why this exists: the HTML is served with max-age=0 (always revalidated) but the
assets carry max-age=86400. A deploy that changes both leaves returning
visitors with NEW html and DAY-OLD css for up to 24 hours -- which renders the
nav as an unstyled button and a raw bullet list, because the markup references
classes their cached stylesheet has never heard of.

Stamping the URL with a hash of the file contents means new markup always
points at a URL the browser has not cached. Re-run after editing site.css or
site.js, before committing.
"""

import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = ("site.css", "site.js")


def digest(name):
    p = os.path.join(ROOT, "assets", name)
    return hashlib.sha256(open(p, "rb").read()).hexdigest()[:8]


def main():
    stamps = {n: digest(n) for n in ASSETS}
    for n, h in stamps.items():
        print(f"assets/{n}  ->  ?v={h}")

    changed = 0
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in (".git", "tools", "assets")]
        for f in fn:
            if not f.endswith(".html"):
                continue
            path = os.path.join(dp, f)
            s = before = open(path).read()
            for n, h in stamps.items():
                # matches the asset with or without an existing ?v= stamp
                s = re.sub(rf'((?:\.\./)*|/)assets/{re.escape(n)}(\?v=[0-9a-f]+)?"',
                           rf'\g<1>assets/{n}?v={h}"', s)
            if s != before:
                open(path, "w").write(s)
                changed += 1
    print(f"\n{changed} pages stamped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
