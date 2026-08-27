#!/usr/bin/env python3
"""
Scaffold one new page with the standard chrome already wired up.

    python3 tools/newpage.py services/gutters "Gutter Marketing for Trades" \
        "Description between 140 and 158 characters goes here, benefit plus a reason to click."

Creates <path>/index.html with head, nav, breadcrumbs, a placeholder body, the
shared CTA block, the footer, and Organization + BreadcrumbList JSON-LD.

This runs ONCE per page. After that the .html file is the source of truth —
open it and write the real content. Do not re-run this over a page you have
already edited, it will overwrite your work.

Afterwards:
    python3 tools/sitemap.py    # add it to sitemap.xml
    python3 tools/check.py      # verify title/description/links
and add it to the footer nav in every page (tools/check.py will not catch that).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pagekit as k

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2

    slug_path, title, desc = argv[1], argv[2], argv[3]
    slug_path = slug_path.strip("/")
    depth = len(slug_path.split("/"))
    out = os.path.join(ROOT, slug_path, "index.html")

    if os.path.exists(out):
        print(f"refusing to overwrite {out}")
        print("This tool scaffolds a page once. Edit the HTML directly instead.")
        return 1

    if not title.endswith(" | Shug"):
        title = title + " | Shug"
    if len(title) > 60:
        print(f"warning: title is {len(title)} chars, max is 60")
    if not (140 <= len(desc) <= 158):
        print(f"warning: description is {len(desc)} chars, want 140-158")

    label = slug_path.split("/")[-1].replace("-", " ").title()
    parent = slug_path.split("/")[0] if depth > 1 else None

    trail, ld_trail = [], []
    if parent:
        trail.append((parent.title(), parent + "/"))
        ld_trail.append((parent.title(), f"/{parent}/"))
    trail.append((label, None))
    ld_trail.append((label, f"/{slug_path}/"))

    body = f"""
  <section class="sec bg-bone">
    <div class="wrap">
      <p class="eyebrow">{label}</p>
      <h1 class="h-lg" style="margin:14px 0 0;max-width:20ch;">Headline goes here.</h1>
      <p class="lede mt-3">One or two sentences of deck copy. Say the offer and the price.</p>
      <p class="mt-4"><a class="btn btn-orange shine" href="#apply">Get my free blueprint call →</a></p>
    </div>
  </section>

  <section class="sec bg-white">
    <div class="wrap prose">
      <h2>First section</h2>
      <p>Write the real content here. Aim for 900-1400 words on a service or
         industry page. Link to at least two related pages and to the pricing page.</p>
    </div>
  </section>
{k.cta(depth, label)}
"""

    k.write(out, depth, title, desc, f"/{slug_path}/", body,
            trail=trail, ld=k.breadcrumb_ld(ld_trail))

    print(f"created {os.path.relpath(out, ROOT)}")
    print("next: write the content, then run tools/sitemap.py and tools/check.py")
    print("and add the page to the footer nav across the site")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
