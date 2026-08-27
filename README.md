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
netlify.toml                        Headers, caching, clean-URL redirects
assets/site.css                     Every style on the site
assets/site.js                      Forms, sticky bar, nudge, stat counters
assets/img/                         Photos, logo, favicons, OG image
services/       + 4 subpages        Websites, local SEO, Google Ads, automations
industries/     + 5 subpages        Roofing, plumbing, HVAC, exterior cleaning, landscaping
pricing/ about/ guarantee/ contact/
privacy/ terms/
blog/           + 3 posts
tools/                              Maintenance scripts (never shipped to visitors)
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

All zero-dependency Python 3. None of it ships to visitors.

```bash
python3 tools/check.py       # pre-flight: links, titles, schema, h1s, images
python3 tools/sitemap.py     # regenerate sitemap.xml from the file tree
python3 tools/newpage.py <path> "<title>" "<description>"
python3 tools/add-portrait.py <image>   # add the founder photo
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

## Analytics

Cloudflare Web Analytics is wired but **commented out**. Every page has this
block in `<head>`:

```html
<!-- ANALYTICS — Cloudflare Web Analytics. Paste your token below and uncomment.
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token": "YOUR_TOKEN_HERE"}'></script>
     END ANALYTICS -->
```

Get a token at **dash.cloudflare.com → Analytics → Web Analytics → Add a site**,
paste it into every page, and uncomment. It is cookie-free, so it needs no
consent banner — which is why there isn't one.

The Content-Security-Policy in `netlify.toml` already allows
`static.cloudflareinsights.com`. Adding any other third-party script means
updating that CSP too, or the browser will block it silently.

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

## Deploying to Netlify

`netlify.toml` sets `publish = "."` with no build command.

1. Push to GitHub.
2. Netlify → **Add new site** → **Import an existing project** → pick the repo.
3. Accept the settings from `netlify.toml`. Deploy.
4. Netlify → **Domain management** → add `joinshug.com`.

### DNS

Point `joinshug.com` at Netlify. Either delegate the whole zone:

```
NS  joinshug.com  ->  dns1.p0X.nsone.net.
                      dns2.p0X.nsone.net.
                      dns3.p0X.nsone.net.
                      dns4.p0X.nsone.net.
```

(Netlify gives you the exact `p0X` values.) Or keep your registrar's DNS:

```
A      joinshug.com      ->  75.2.60.5
CNAME  www.joinshug.com  ->  <your-site>.netlify.app.
```

Enable HTTPS in Netlify after DNS propagates. The `Strict-Transport-Security`
header in `netlify.toml` includes `preload`, so do not enable it until HTTPS is
confirmed working on the apex domain.

---

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
