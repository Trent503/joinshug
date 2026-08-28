# joinshug.com

The marketing site for **Shug** — an online growth agency for blue-collar trades.
Founder: Trent Delgadillo.

Static HTML, CSS, and JavaScript. No framework, no build step, no npm
dependencies. The repo root **is** the deployable folder.

---

## Run it locally

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Use a server rather than opening `index.html` directly. Assets are referenced
with relative paths so a single page will style correctly from the filesystem,
but navigation between pages uses clean trailing-slash URLs (`/pricing/`), which
only resolve over HTTP.

---

## Structure

```
index.html                          Homepage
404.html                            Styled 404 (noindex, root-absolute links)
robots.txt  sitemap.xml             Crawl + index
_headers  _redirects                Cloudflare Pages: security headers, caching, clean URLs
assets/site.css                     Every style on the site
assets/site.js                      Forms, sticky bar, nudge, stat counters
assets/img/                         Photos, logo, favicons, OG image
agent/                              Shug Agent — 24/7 front desk (flagship product)
services/       + 4 subpages        Websites, local SEO, Google Ads, automations
industries/     + 5 subpages        Roofing, plumbing, HVAC, exterior cleaning, landscaping
pricing/ about/ guarantee/ contact/
privacy/ terms/
blog/           + 3 posts
tools/                              Maintenance scripts (redirected away, see Tools)
```

Every page is a directory containing `index.html`, so every URL is clean and
trailing-slash canonical.

---

## Don't break these

**The Formspree endpoint** lives in exactly one place — `assets/site.js`, the
`ENDPOINT` constant:

```js
var ENDPOINT = 'https://formspree.io/f/xbdvybew';
```

**The three Stripe payment links** appear on the homepage and `/pricing/`:

| Tier | Price | Link |
|---|---|---|
| The Template | $297/mo | `buy.stripe.com/7sYaEW5c5cYq5cp6zi04801` |
| The Foundation | $697/mo | `buy.stripe.com/6oU3cu5c5gaCfR36zi04802` |
| The Monopoly | $1,297/mo | `buy.stripe.com/00w5kC4813nQdIV0aU04803` |

**Brand tokens** are the `:root` block at the top of `assets/site.css`. Three of
them were darkened from the source design to pass WCAG AA — see
*Accessibility* below before reverting any colour.

---

## Tools

All zero-dependency Python 3. Cloudflare Pages deploys every file in the repo,
so `tools/` is technically reachable — it holds no secrets, and `_redirects`
sends `/tools/*` to the homepage while `robots.txt` disallows it.

```bash
python3 tools/check.py       # pre-flight: links, titles, schema, h1s, images
python3 tools/sitemap.py     # regenerate sitemap.xml from the file tree
python3 tools/newpage.py <path> "<title>" "<description>"
python3 tools/add-portrait.py <image>   # add the founder photo
python3 tools/set-demo-number.py "+1 555 555 0123"   # set the Agent demo line
```

**Always run `tools/check.py` before deploying.** It fails on broken internal
links, duplicate or missing `<h1>`, titles over 60 characters, descriptions
outside 140–158, dead in-page anchors, unparseable JSON-LD, FAQ schema that does
not match the visible copy, missing image dimensions, and missing assets.

### Adding a page

```bash
python3 tools/newpage.py services/gutters \
  "Gutter Marketing for Trades" \
  "A description between 140 and 158 characters, written as a benefit plus a reason to click."
```

That scaffolds the page **once** with the standard chrome. After that, the HTML
file is the source of truth — edit it directly and never re-run the scaffold
over it. Then:

1. Write the content (900–1400 words for a service or industry page).
2. Add the page to the footer nav — it is hard-coded in every page, and
   `check.py` will not catch its absence.
3. `python3 tools/sitemap.py`
4. `python3 tools/check.py`

`tools/pagekit.py` holds the shared chrome the scaffold stamps out. Editing it
changes new pages only, not existing ones.

### The sitemap

`tools/sitemap.py` walks the tree for `index.html` files, converts each to its
trailing-slash URL, and takes `<lastmod>` from that file's last git commit date
(falling back to filesystem mtime when uncommitted). Re-run it after adding,
removing, or meaningfully editing a page, and commit the result.

The build brief asked for a Node version (`tools/sitemap.mjs`). Node is not
installed on the machine this was built on, so it is Python — same output, and
it actually runs. Port it if you prefer.

---

## Placeholders that still need filling

`tools/check.py` warns while either of these is unset. Neither blocks a build,
but the first one ships a dead phone link if ignored.

| What | Where | How to set it |
|---|---|---|
| **Shug Agent demo number** | `/agent/` hero + demo section | `python3 tools/set-demo-number.py "+1 555 555 0123"` |
| **Booking / calendar URL** | "Book a Demo" buttons | Currently point at the Formspree lead form in `#apply`, which works. Swap the hrefs if you'd rather send people to a calendar. |

The demo number appears twice on `/agent/` — a `tel:` href and the visible
number on the button. The script rewrites both, and is safe to re-run.

---

## Products

The site now carries two products under one brand:

- **Shug Agent** (`/agent/`) — 24/7 front desk, $99/mo + $199 setup. Flagship;
  gets the featured card treatment and first slot in the Products menu.
- **Shug Websites** (`/services/websites/`) — the original offer, $297+/mo,
  with local SEO, ads, and automations as add-on service pages.

Both are reachable from the Products dropdown in the nav and from `/pricing/`,
which lists Agent first and the three website tiers below it.

The Products menu opens on hover, on focus, and on click. The CSS `:focus-within`
rule is the no-JS path — **do not remove it**, or the flagship product becomes
unreachable by keyboard when `site.js` fails to load. Escape sets an
`is-dismissed` class because `:focus-within` alone would otherwise re-open the
menu the instant focus returned to the button.

---

## Analytics

Cloudflare Web Analytics — cookie-free, so no consent banner, which is why there
isn't one.

**Turn it on in the dashboard, not in the code.** Cloudflare Pages project →
**Settings** → **Web Analytics** → **Enable**. Pages injects the beacon at the
edge. No token in the repo, nothing to keep in sync across 23 pages.

Every page still carries a commented `<!-- ANALYTICS -->` block as a fallback if
the site ever moves off Cloudflare Pages. Paste a token there and uncomment.

`_headers` already allows `static.cloudflareinsights.com` in `script-src` and
`cloudflareinsights.com` in `connect-src`. **Any other third-party script needs
that CSP updated too, or the browser blocks it silently** — check the console
before assuming a tag is broken.

---

## Accessibility

Three colours from the source design failed WCAG AA contrast and were darkened.
Reverting them reintroduces the failure:

| Was | Now | Where | Before → After |
|---|---|---|---|
| `#8A7C68` | `#6F6350` | small muted text on bone/sand | 3.58 → 5.17 |
| `#C0552A` | `#9C4420` | small orange labels on light | 4.04 → 5.67 |
| `#6E6356` | `#91846F` | footer text on ink | 2.83 → 4.53 |

Body copy on the orange CTA section uses pure black (`--on-orange`). Against
`#C0552A` that is 4.57:1 — the only value that clears 4.5:1. Ink (`#211E1B`)
gets 3.61 and fails.

Also in place: skip-to-content link, real `<nav>`/`<main>`/`<footer>` landmarks,
visible orange focus rings, visually-hidden `<label>`s on every form field, and
`prefers-reduced-motion` honoured.

---

## Deploying to Cloudflare Pages

No build step. Cloudflare Pages serves the repo root as-is.

1. Push to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → pick the repo.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
4. **Save and Deploy.** You get a `<project>.pages.dev` URL immediately.
5. **Custom domains** → add `joinshug.com` and `www.joinshug.com`.
6. **Settings → Web Analytics → Enable.**

`_headers` and `_redirects` are read from the output directory on every deploy.
Cloudflare strips both from the served output — they configure the edge, they
are not public files.

### DNS

If `joinshug.com` is already on Cloudflare DNS, adding the custom domain in
Pages creates the records automatically. Nothing to do by hand.

If the domain is registered elsewhere, point its nameservers at the pair
Cloudflare gives you, then add the custom domain in Pages.

Verify after it propagates:

```bash
curl -sI https://joinshug.com/ | grep -i -E 'strict-transport|content-security|x-frame'
curl -sI https://joinshug.com/pricing | grep -i -E '^HTTP|^location'   # expect 301 -> /pricing/
curl -s  https://joinshug.com/sitemap.xml | head -3
```

### HSTS

`_headers` sets `Strict-Transport-Security: max-age=31536000; includeSubDomains`
— deliberately **without** `preload`. Do not add `preload` until HTTPS is
confirmed working on the apex *and* every subdomain you will ever use. Preload
submission is effectively irreversible for months.

Cloudflare can also manage HSTS at **SSL/TLS → Edge Certificates → HSTS**. Use
one or the other, not both.

## What still needs a human

- **`tools/add-portrait.py` has not been run.** `/about/` and the homepage
  founder section show the "TD" initials block instead of a photo.
- **Privacy and terms reference `trent@joinshug.com`**, which may not exist yet.
  Both pages need a working contact route, and the terms have not been reviewed
  by a lawyer.
- **No WebP.** The machine this was built on has no WebP encoder — `sips` reads
  the format but cannot write it, and there is no `cwebp`, ImageMagick, or
  Pillow. Images are JPEG at two widths. To add WebP later:
  `brew install webp`, then `cwebp -q 72 assets/img/hero-crew-1600.jpg -o
  assets/img/hero-crew-1600.webp`, and wrap the `<img>` in `<picture>` with a
  `<source type="image/webp">`.
- **No Lighthouse run.** Node is not installed here, so performance was never
  measured — only structure was. Run it once the site is on a real URL.
- **`sameAs` is omitted** from the Organization schema because no social URLs
  were supplied. Add them to the JSON-LD block on every page when they exist.
- **Geo is national.** No city or service-area copy anywhere, by decision. Look
  for `TODO: geo` if you later scope to specific markets.
