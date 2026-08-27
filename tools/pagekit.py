"""
pagekit — shared chrome for joinshug.com pages.

This is a SCAFFOLDING tool, not a build step. It stamps out a page once, with the
standard head / nav / breadcrumbs / CTA / footer already wired up. After that the
.html file is the source of truth — edit the HTML directly, never re-run this over
a page you have already edited.

    python3 tools/newpage.py services/gutters "Gutter marketing" "Description..."

Requires nothing but Python 3. See README.md.
"""

SITE = "https://joinshug.com"
ORG = SITE + "/#org"


def P(depth):
    """Relative prefix back to site root. Root pages get '', /pricing/ gets '../'."""
    return "../" * depth


def head(depth, title, desc, path, og_image="assets/img/og-default.jpg",
         preload=None, extra=""):
    p = P(depth)
    url = SITE + path
    og = SITE + "/" + og_image
    pre = ""
    if preload:
        pre = ('<link rel="preload" as="image" href="%s%s" fetchpriority="high">\n'
               % (p, preload))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{url}">
<meta name="theme-color" content="#C0552A">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Shug">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{p}assets/img/favicon-32.png" type="image/png">
<link rel="apple-touch-icon" href="{p}assets/img/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
{pre}<link href="https://fonts.googleapis.com/css2?family=Anton&family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{p}assets/site.css">
<!-- ANALYTICS — Cloudflare Web Analytics. Paste your token below and uncomment.
     Get one at dash.cloudflare.com > Analytics > Web Analytics > Add a site.
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{{"token": "YOUR_TOKEN_HERE"}}'></script>
     END ANALYTICS -->{extra}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
"""


def nav(depth, current="", cta_href="#apply"):
    """cta_href: pages with no #apply section (legal pages) must pass a real URL."""
    p = P(depth)
    def link(href, label, key):
        cur = ' aria-current="page"' if key == current else ""
        return f'<a class="navlink" href="{p}{href}"{cur}>{label}</a>'
    return f"""
<nav class="nav" aria-label="Primary">
  <a class="brand" href="{p}" aria-label="Shug home"><span>shug</span></a>
  <div class="navlinks">
    {link("services/websites/", "Services", "services")}
    {link("pricing/", "Pricing", "pricing")}
    {link("about/", "About", "about")}
    <a class="navcta" href="{cta_href}">Get My Call</a>
  </div>
</nav>
"""


def crumbs(depth, trail):
    """trail: list of (label, href-relative-to-root or None for current page)."""
    p = P(depth)
    items = [f'<li><a href="{p}">Home</a></li>']
    for label, href in trail:
        if href is None:
            items.append(f'<li><span aria-current="page">{label}</span></li>')
        else:
            items.append(f'<li><a href="{p}{href}">{label}</a></li>')
    return ('<nav class="crumbs" aria-label="Breadcrumb"><ol>'
            + "".join(items) + "</ol></nav>\n")


def breadcrumb_ld(trail):
    """trail: list of (label, path) with path like '/services/' — current page included."""
    items = [{"name": "Home", "item": SITE + "/"}]
    items += [{"name": lbl, "item": SITE + path} for lbl, path in trail]
    parts = []
    for i, it in enumerate(items, 1):
        parts.append(
            '{"@type":"ListItem","position":%d,"name":%s,"item":%s}'
            % (i, _j(it["name"]), _j(it["item"])))
    return ('<script type="application/ld+json">\n'
            '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":['
            + ",".join(parts) + "]}\n</script>\n")


def faq_ld(qas):
    """qas: list of (question, answer_plaintext) — must match the visible copy verbatim."""
    parts = []
    for q, a in qas:
        parts.append(
            '{"@type":"Question","name":%s,"acceptedAnswer":{"@type":"Answer","text":%s}}'
            % (_j(q), _j(a)))
    return ('<script type="application/ld+json">\n'
            '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":['
            + ",".join(parts) + "]}\n</script>\n")


def org_ld():
    return ('<script type="application/ld+json">\n'
            '{"@context":"https://schema.org","@type":"Organization","@id":"%s",'
            '"name":"Shug","url":"%s/","logo":"%s/assets/img/logo-512.png",'
            '"slogan":"Blue-collar trade. White-collar profit.",'
            '"founder":{"@type":"Person","@id":"%s/about/#trent","name":"Trent Delgadillo",'
            '"jobTitle":"Founder"}}\n</script>\n' % (ORG, SITE, SITE, SITE))


def service_ld(name, service_type, desc, price, path):
    return ('<script type="application/ld+json">\n'
            '{"@context":"https://schema.org","@type":"Service","name":%s,'
            '"serviceType":%s,"description":%s,"url":%s,'
            '"provider":{"@id":"%s"},'
            '"areaServed":{"@type":"Country","name":"United States"},'
            '"offers":{"@type":"Offer","price":"%s","priceCurrency":"USD",'
            '"availability":"https://schema.org/InStock","url":%s}}\n</script>\n'
            % (_j(name), _j(service_type), _j(desc), _j(SITE + path), ORG, price,
               _j(SITE + "/pricing/")))


def faq_html(qas):
    """Renders the visible FAQ. Pair with faq_ld(qas) so markup matches copy."""
    out = []
    for q, a in qas:
        out.append(f"""        <details class="faq">
          <summary>{q}</summary>
          <div class="faq-body"><p>{a}</p></div>
        </details>""")
    return "\n".join(out)


def cta(depth, source, heading="Let's get your phone ringing.",
        sub="Drop your name and number — I'll personally call you within 24 hours. "
            "No card, no pressure."):
    return f"""
  <section id="apply" class="sec bg-orange on-orange">
    <div class="wrap-narrow center">
      <h2 class="h-lg" style="font-size:clamp(30px,5vw,48px);line-height:1.04;margin:0;">{heading}</h2>
      <p style="font-size:clamp(16px,2.1vw,19px);line-height:1.5;font-weight:500;color:var(--on-orange);margin:16px 0 0;">{sub}</p>

      <form class="lead-form" data-lead-form data-done="cta-done" data-source="{source}" style="margin:30px 0 0;">
        <p class="form-err" data-err hidden></p>
        <div class="form-row" style="justify-content:center;">
          <label class="vh" for="cta-name">Your name</label>
          <input id="cta-name" name="name" type="text" required autocomplete="name" placeholder="Your name" style="flex:1 1 160px;">
          <label class="vh" for="cta-phone">Phone number</label>
          <input id="cta-phone" name="phone" type="tel" required autocomplete="tel" placeholder="Phone" style="flex:1 1 160px;">
        </div>
        <div class="form-row" style="justify-content:center;">
          <label class="vh" for="cta-trade">Your trade</label>
          <input id="cta-trade" name="trade" type="text" autocomplete="organization-title" placeholder="Your trade (roofing, plumbing, HVAC…)" style="flex:1 1 220px;">
          <label class="hp" for="cta-company">Company (leave blank)</label>
          <input class="hp" id="cta-company" name="company" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
          <button class="shine" type="submit">Get My Blueprint Call</button>
        </div>
      </form>
      <div class="form-done" id="cta-done" hidden>
        <b>You're on my call list.</b>
        <span>I'll call you personally within 24 hours. Keep your phone close. — Trent</span>
      </div>
      <p data-form-aside style="font-size:13px;font-weight:600;color:var(--on-orange);margin:14px 0 0;">No contracts · Cancel anytime · Money-back guarantee · No spam</p>
    </div>
  </section>
"""


def footer(depth):
    p = P(depth)
    return f"""
<footer class="foot">
  <div class="foot-top">
    <a class="brand" href="{p}" style="padding:9px 16px;border-radius:10px;box-shadow:0 2px 0 #9C4420;" aria-label="Shug home"><span style="font-size:26px;">shug</span></a>
    <p class="foot-tag">Blue-collar trade. White-collar profit.</p>
  </div>
  <nav class="foot-nav" aria-label="Footer">
    <div>
      <h2>Services</h2>
      <ul>
        <li><a href="{p}services/websites/">Trade websites</a></li>
        <li><a href="{p}services/local-seo/">Local SEO</a></li>
        <li><a href="{p}services/google-ads/">Google Ads &amp; LSA</a></li>
        <li><a href="{p}services/automations/">Automations</a></li>
      </ul>
    </div>
    <div>
      <h2>Industries</h2>
      <ul>
        <li><a href="{p}industries/roofing/">Roofing</a></li>
        <li><a href="{p}industries/plumbing/">Plumbing</a></li>
        <li><a href="{p}industries/hvac/">HVAC</a></li>
        <li><a href="{p}industries/exterior-cleaning/">Exterior cleaning</a></li>
        <li><a href="{p}industries/landscaping/">Landscaping</a></li>
      </ul>
    </div>
    <div>
      <h2>Company</h2>
      <ul>
        <li><a href="{p}pricing/">Pricing</a></li>
        <li><a href="{p}about/">About Trent</a></li>
        <li><a href="{p}guarantee/">The guarantee</a></li>
        <li><a href="{p}contact/">Contact</a></li>
      </ul>
    </div>
    <div>
      <h2>Learn</h2>
      <ul>
        <li><a href="{p}blog/">Blog</a></li>
        <li><a href="{p}blog/trades-website-that-books-jobs/">What a trades website needs</a></li>
        <li><a href="{p}blog/get-more-google-reviews/">Getting more Google reviews</a></li>
        <li><a href="{p}blog/missed-calls-are-your-biggest-leak/">Your missed-call leak</a></li>
      </ul>
    </div>
    <div>
      <h2>Legal</h2>
      <ul>
        <li><a href="{p}privacy/">Privacy</a></li>
        <li><a href="{p}terms/">Terms</a></li>
      </ul>
    </div>
  </nav>
  <div class="foot-base">
    <p>joinshug.com — the online growth partner for blue-collar trades.</p>
    <p>© 2026 Shug · Trent Delgadillo</p>
  </div>
</footer>

<script src="{p}assets/site.js" defer></script>
"""


def toc(entries):
    """entries: list of (anchor_id, label). Renders the in-post table of contents."""
    items = "\n".join(f'    <li><a href="#{a}">{l}</a></li>' for a, l in entries)
    return ('<nav class="toc" aria-label="On this page">\n'
            '  <b>On this page</b>\n  <ol>\n' + items + "\n  </ol>\n</nav>\n")


def article_ld(headline, desc, slug, published, modified=None):
    return ('<script type="application/ld+json">\n'
            '{"@context":"https://schema.org","@type":"Article","headline":%s,'
            '"description":%s,"datePublished":"%s","dateModified":"%s",'
            '"image":"%s/assets/img/og-default.jpg",'
            '"author":{"@id":"%s/about/#trent"},'
            '"publisher":{"@id":"%s"},'
            '"mainEntityOfPage":{"@type":"WebPage","@id":"%s/blog/%s/"},'
            '"inLanguage":"en-US"}\n</script>\n'
            % (_j(headline), _j(desc), published, modified or published,
               SITE, SITE, ORG, SITE, slug))


def post(slug, title, desc, h1, dek, published, published_label, entries, prose,
         cta_heading="Want this handled for you?",
         cta_sub="Drop your name and number. I'll call you personally within 24 hours "
                 "— free, 15 minutes, no card."):
    """Assemble a blog post. `prose` is the article body HTML (h2/p/ul)."""
    import os
    body = f"""
  <article class="sec bg-bone">
    <div class="wrap">
      <p class="post-meta">Blog · {published_label}</p>
      <h1 class="h-md" style="margin:12px 0 0;max-width:24ch;">{h1}</h1>
      <p class="lede mt-3">{dek}</p>
    </div>
  </article>

  <section class="bg-white" style="padding:clamp(40px,6vw,72px) var(--gut) clamp(56px,8vw,96px);border-top:1px solid var(--line);">
    <div class="wrap prose">
{toc(entries)}
{prose}
    </div>
  </section>
{cta(2, "Blog — " + title, cta_heading, cta_sub)}
"""
    return write(
        os.path.join("blog", slug, "index.html"), 2, title + " | Shug", desc,
        f"/blog/{slug}/", body,
        trail=[("Blog", "blog/"), (h1, None)],
        ld=breadcrumb_ld([("Blog", "/blog/"), (h1, f"/blog/{slug}/")])
           + article_ld(h1, desc, slug, published),
    )


def write(path, depth, title, desc, canonical, body, trail=None, ld="",
          current="", preload=None, og_image="assets/img/og-default.jpg",
          cta_href="#apply"):
    """Assemble and write one page. `body` is everything inside <main>."""
    import os
    html = head(depth, title, desc, canonical, og_image=og_image, preload=preload)
    html += nav(depth, current, cta_href)
    if trail:
        html += crumbs(depth, trail)
    html += '\n<main id="main">\n' + body + "\n</main>\n"
    html += footer(depth)
    html += org_ld()
    html += ld
    html += "</body>\n</html>\n"
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(html)
    return html


def _j(s):
    """JSON string literal — escapes quotes/backslashes/control chars."""
    import json
    return json.dumps(s, ensure_ascii=False)
