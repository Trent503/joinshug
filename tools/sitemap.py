#!/usr/bin/env python3
"""
Regenerate sitemap.xml from the real file tree.

    python3 tools/sitemap.py

Zero dependencies. Walks the repo for index.html files, converts each to its
trailing-slash URL, and takes <lastmod> from the file's last git commit date
(falling back to filesystem mtime for files not yet committed).

The brief called for a Node version (tools/sitemap.mjs). Node is not installed
on this machine, so this is Python — same output, and it actually runs here.
Rewrite it in Node if you'd rather, the contract is just "emit sitemap.xml".
"""

import os
import subprocess
import sys
from datetime import datetime, timezone

SITE = "https://joinshug.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Pages excluded from the sitemap. 404 is noindex and has no canonical URL.
SKIP = {"404.html"}

# Crawl priority. Anything unlisted gets 0.6.
PRIORITY = {
    "/": "1.0",
    "/pricing/": "0.9",
    "/services/websites/": "0.9",
    "/services/local-seo/": "0.9",
    "/services/google-ads/": "0.8",
    "/services/automations/": "0.8",
    "/about/": "0.7",
    "/contact/": "0.7",
    "/guarantee/": "0.7",
    "/blog/": "0.6",
    "/privacy/": "0.3",
    "/terms/": "0.3",
}


def git_lastmod(path):
    """Last commit date for a file, as YYYY-MM-DD. None if untracked."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cs", "--", path],
            cwd=ROOT, capture_output=True, text=True, timeout=10)
        stamp = out.stdout.strip()
        return stamp or None
    except (OSError, subprocess.SubprocessError):
        return None


def mtime_lastmod(path):
    ts = os.path.getmtime(os.path.join(ROOT, path))
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def discover():
    """Every index.html in the tree, as (url_path, repo_relative_file)."""
    pages = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames
                       if d not in (".git", "assets", "tools", ".github")]
        if "index.html" not in filenames:
            continue
        rel = os.path.relpath(os.path.join(dirpath, "index.html"), ROOT)
        if rel in SKIP:
            continue
        url = "/" if rel == "index.html" else "/" + os.path.dirname(rel) + "/"
        pages.append((url, rel))
    return sorted(pages)


def main():
    pages = discover()
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9">'
             .replace("www.sitemap.org", "www.sitemaps.org")]
    for url, rel in pages:
        lastmod = git_lastmod(rel) or mtime_lastmod(rel)
        lines.append("  <url>")
        lines.append(f"    <loc>{SITE}{url}</loc>")
        lines.append(f"    <lastmod>{lastmod}</lastmod>")
        lines.append(f"    <priority>{PRIORITY.get(url, '0.6')}</priority>")
        lines.append("  </url>")
    lines.append("</urlset>")

    out = os.path.join(ROOT, "sitemap.xml")
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"sitemap.xml — {len(pages)} URLs")
    for url, _ in pages:
        print("  " + url)
    return 0


if __name__ == "__main__":
    sys.exit(main())
