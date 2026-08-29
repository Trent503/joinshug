# SHUG — Build Session Log

Append-only. Newest phase at the bottom. A new session should be able to read
this top-to-bottom and resume in under a minute.

**Resume protocol:** read this file → `git log --oneline -20` → continue from
the last "NEXT" line.

---

## Orientation (read this first)

**What SHUG is:** an AI receptionist for home-service contractors.
$199 setup, $99/month, 120 AI voice minutes included.

**The whole MVP, in one sentence:** a contractor's phone rings → SHUG answers
24/7 → knows the business → captures and qualifies the lead → books or requests
the appointment → records the call → queues the owner a notification → meters
minutes against 120/month → the contractor logs into `/app/` and sees all of it
→ and a new contractor can be provisioned in under a minute.

**Repo root:** `/Users/trentdelgadillo/SHUG/joinshug` (always `pwd` first — the
parent path has shifted between sessions).

---

## Phase 1 — Inspection (no modifications)

### THE HEADLINE FINDING: this is a Worker, not Pages

Every document in this repo — `README.md`, `wrangler.toml`, the header comment
in every file under `functions/` — states that joinshug.com is a **Cloudflare
Pages** project. **It is not.** It is a **Cloudflare Worker with static
assets**, named `joinshug`.

Evidence gathered (all read-only):

| Check | Result |
|---|---|
| `wrangler pages project list` | empty — **no Pages projects exist on this account** |
| `wrangler pages deployment list --project-name=joinshug` | `Project not found [code: 8000007]` |
| `wrangler deployments list` (worker `joinshug`) | returns real deployments, timestamps match site updates |
| `curl https://joinshug.com/api/retell/inbound` | **404** |
| `curl -I https://joinshug.com/` | 200, `_headers` CSP is being applied |
| `curl https://joinshug.com/tools/check.py` | 301 → `/`, so `_redirects` is applied too |

**Consequence:** `functions/` is a *Pages-only* routing convention. A Worker
does not auto-route it. So `functions/api/retell/inbound.js` and
`functions/api/retell/webhook.js` **have never been reachable in production**,
which the live 404 confirms. Retell has nothing to call. The backend written in
the previous session is, as deployed, dead code.

Workers Static Assets *does* honour `_headers` and `_redirects` (both verified
live above), which is why the marketing site behaves correctly today.

### The fix (decided, non-destructive, executed in Phase 2)

Do **not** migrate to Pages. joinshug.com's custom domain is attached to the
Worker; moving it is a DNS change and is explicitly off-limits.

Instead: keep the Worker and give it an entry point.

```toml
name = "joinshug"
main = "worker/index.js"
[assets]
directory = "."
binding = "ASSETS"
run_worker_first = ["/api/*"]
```

`run_worker_first = ["/api/*"]` means the Worker script only runs for API
routes; every other request is served straight from the asset store exactly as
it is today — same behaviour, same cost, marketing site untouched.

The router imports the existing `functions/`-shaped modules and calls their
`onRequestGet` / `onRequestPost` exports with a Pages-compatible `context`
object. Handler code stays in Pages form, so if the site ever *does* move to
Pages, that is a config change and a directory move, not a rewrite.

### Existing code — assessment

Quality is high. This is not scaffolding to be thrown away.

- **`functions/lib/retell.js`** — HMAC-SHA256 webhook verification transcribed
  from `retell-sdk` source rather than prose docs. Constant-time compare via
  `crypto.subtle.verify`. Reads the raw body exactly once and never
  re-serialises before verifying. Fails closed on an unset key. **Correct as
  written. Keep it.**
- **`functions/lib/http.js`** — API headers (`_headers` correctly noted as not
  applying to function responses), `billedMonth()` via `Intl` in the business's
  timezone, `stringifyVars()` dropping nulls so Retell falls back to
  agent-level defaults. **Correct. Keep.**
- **`functions/lib/store.js`** — KV strictly as a read-through cache for
  number→business (negative caching included), D1 as source of truth, idempotent
  `upsertCall` using `COALESCE(excluded.x, calls.x)` so out-of-order events can
  only ADD facts, `MAX()` on duration. Metering derived via `SUM(duration_sec)`,
  never a stored counter. **Architecture correct. Keep; extend.**
- **`functions/api/retell/inbound.js`** — 6s budget racing D1 so a slow lookup
  answers with the default agent instead of leaving dead air. Every failure path
  returns 200 pass-through. Only deliberate non-answer is a suspended account.
  **Correct. Keep.**
- **`functions/api/retell/webhook.js`** — fails closed, idempotent upserts,
  5xx-to-trigger-retry, voicemail excluded from leads, extraction aliases so the
  Retell dashboard schema need not match byte-for-byte. **Correct. Keep; extend.**
- **`schema.sql`** — `businesses`, `calls`, `leads`. Good comments, real
  reasoning. Needs extension (below).

### Schema gap found

`leads.retell_call_id` is `NOT NULL UNIQUE` — the model is **one lead per
call**. The product needs **one lead per (business, phone)**, so a repeat caller
updates their existing lead instead of creating a duplicate.

Smallest correct fix: invert the relation. `leads` becomes keyed on
`(business_id, phone)`; `calls` gains a `lead_id` pointing at its lead. Many
calls → one lead, which is what a repeat customer actually is.

This is safe to do outright because **no D1 database exists yet** (see below) —
there is no production data to migrate.

Also missing entirely: `phone_numbers`, `bookings`, `follow_ups`,
`notifications`, `users`, `sessions`, and lead `status` / `email` / `service` /
`source` / `notes`.

### Cloudflare resources — current state

- **D1 databases: NONE.** `wrangler d1 list` is empty.
- **KV namespaces: NONE.** `wrangler kv namespace list` returns `[]`.
- `wrangler.toml` `database_id` / KV `id` are literal
  `REPLACE_WITH_ID_FROM_...` placeholders.
- Account: `Trent@joinshug.com's Account` / `4e47602e5a39e0ddd86cf0fe44927e9c`,
  authenticated as `trent@joinshug.com` with `d1 (write)`, `workers_kv (write)`,
  `workers (write)`, `pages (write)`.

Creating these is purely **additive** — nothing exists to overwrite.

### Marketing site — do not break

28 HTML pages, `assets/site.css` (391 lines), `assets/site.js` (198 lines), zero
build step, deployed from repo root.

- Lead form posts to Formspree `xbdvybew`, `assets/site.js:6`.
- **`_headers` sets `Content-Security-Policy: default-src 'self'; script-src
  'self' ...`.** No `'unsafe-inline'` for scripts. **The dashboard must
  therefore use external `.js` files only — no inline `<script>` blocks, no
  inline event handlers.** `connect-src 'self'` already permits the dashboard's
  same-origin `fetch` calls, and `style-src` already allows `'unsafe-inline'`.
  No `_headers` change is needed for `/app/`.
- `_redirects` has no rule touching `/app/` or `/api/`. Clear.
- `assets/site.css` is stamped with a content hash by `tools/stamp-assets.py`
  and cached `immutable`. The dashboard gets its **own** stylesheet so the
  marketing CSS is never touched.

Brand tokens to reuse (from `assets/site.css`):
`--orange:#C0552A` · `--orange-dark:#9C4420` · `--ink:#211E1B` ·
`--bone:#F4F0EA` · `--sand:#ECE4D8` · `--line:#E4D9C7` · `--muted:#5C5346`
Fonts: Bricolage Grotesque (display), Hanken Grotesk (sans), Anton (numerals).

### Jobber — untouched, documentation only

`functions/api/jobber/start.js` (122 lines) and `callback.js` (373 lines).
Read, not modified. Full write-up goes in `NEEDS_CONFIG.md` in Phase 14.

### Toolchain

node v26.8.1 · npm 12.0.2 · wrangler 4.127.1 (authenticated).
No `package.json`, no `node_modules` — and none is wanted. Everything stays
zero-dependency; tests run on node's built-in `fetch` and Web Crypto.

### Housekeeping

Removed a stray 0-byte untracked file named `Bash` at repo root — an accidental
shell artifact from a previous session, not work. It would otherwise have been
deployed as a static asset.

### Status

- **Done:** full inspection, platform identified, fix decided, schema gap found.
- **Blocked:** nothing.
- **NEXT:** Phase 2 — Worker entry point + `[assets]` config, corrected and
  extended D1 schema, data layer, local dev running.
