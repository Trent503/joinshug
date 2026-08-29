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

---

## Phase 2 — Platform fix, schema, data layer

**Done.** `worker/index.js` route table + `wrangler.toml` `main` / `[assets]` /
`run_worker_first = ["/api/*"]`. Handlers keep their Pages `onRequest*` shape,
so a future move to Pages is a config change, not a rewrite.

`schema.sql` rebuilt: `businesses`, `phone_numbers`, `users`, `sessions`,
`leads`, `calls`, `bookings`, `follow_ups`, `notifications`, `usage_monthly`
view. The v1 model had `leads.retell_call_id NOT NULL UNIQUE` — one lead per
call — which would have made a repeat caller a new lead every time. Now
`UNIQUE(business_id, phone)` with `calls.lead_id` pointing at the lead.
Safe to change outright: **no D1 database existed**, so no data to migrate.

Libraries: `store.js` (businesses / numbers / calls / leads),
`crm.js` (bookings / follow-ups / overview aggregates),
`notify.js` (notification queue + provider seam),
`auth.js` (PBKDF2 + sessions), `guard.js` (the single authorisation gate).

**Cloudflare resources created** (none existed — purely additive):

| Binding | Kind | Id |
|---|---|---|
| `DB` | D1 `shug` | `03557859-24f8-45e0-bcc6-9368bae9f3d1` |
| `CONFIG_CACHE` | KV | `6f016140a69d4130bce349db03bb2307` |
| `JOBBER_TOKENS` | KV | `439992672db24d6eb504c9842f1810d5` |

---

## SECURITY FINDINGS (both fixed; one was live)

### 1. `/.dev.vars` was served publicly — FIXED before any deploy

The asset directory is the repo root, so `wrangler dev` served `/.dev.vars`
with a **200 and the real Retell API key in the body**. `.dev.vars` is
gitignored, which protects the *repository* and does nothing whatsoever about
the *asset bundle* — the asset directory is the working tree, not the git index.

Fixed in `.assetsignore`. Verified: 404, 0-byte body.

### 2. joinshug.com is serving `/.git/` RIGHT NOW — fix ships with next deploy

```
https://joinshug.com/.git/config  200  (234 bytes, shows the GitHub remote)
https://joinshug.com/.git/HEAD    200
https://joinshug.com/.git/index   200  (5686 bytes)
https://joinshug.com/.git/logs/HEAD 200
```

That is enough to reconstruct the repository from the live site.

**Credential impact: none.** The full history was searched for
`key_…` / `sk_live` / `AKIA…` patterns and for any committed `.dev.vars` or
`.env`; nothing was ever committed. This is source exposure only, and the
source is already on GitHub (`Trent503/joinshug`).

`.assetsignore` now excludes `.git/`. Verified 404 locally. **It goes live with
the Phase 15 deploy** — that deploy is what closes it.

---

## Phases 3–7 — Retell, leads, metering, notifications

Signature verification kept as written (it was already correct). Webhook
rewritten for the new model:

* leads dedupe on `(business_id, phone)`; `normalizeE164` handles
  `(503) 555-1111` ≡ `+15035551111` and maps anonymous caller ID to NULL so
  withheld-number callers do not all collapse into one lead
* `attachCallToLead` **recomputes** `call_count` / `first_call_id` /
  `last_call_id` from the calls table rather than incrementing, so a webhook
  retry cannot inflate them
* a repeat call never resets a status the owner set — except a `completed` or
  `lost` lead calling back, which reopens as `new` because that is a new job
* bookings are created only from a **real calendar date**; "next Tuesday" stays
  on `preferred_time` rather than becoming a wrong appointment
* notifications are queued at `call_ended` (so the owner is told even if
  analysis never lands) and the body is upgraded in place at `call_analyzed`;
  `UNIQUE(call_id, channel)` makes both paths idempotent
* metering is `SUM(duration_sec)` per `(business_id, billed_month)`, month
  stamped in the business's own timezone, rounded up **once per month** so six
  10-second hangups cost one minute rather than six

**No SMS provider is configured and none was signed up for.** The queue is
complete and tested; every send lands in `skipped` / `no_provider`. A full
Twilio adapter is written and gated on credentials — see `NEEDS_CONFIG.md`.

---

## Phases 8–9 — Auth, tenancy, provisioning

PBKDF2-HMAC-SHA256, 210,000 iterations, per-user 16-byte salt, iteration count
stored per row so it can be raised without invalidating anyone. Sessions are
server-side in D1 storing `sha256(token)`, never the token. Cookie is HttpOnly
+ SameSite=Lax + Secure (`__Host-` prefix on HTTPS, unprefixed on
`http://localhost`). CSRF is defended twice and independently: SameSite=Lax and
an `Origin` check on every state-changing request.

`business_id` comes off the session row and from nowhere else. A body field
named `business_id` is ignored — tested.

**Provisioning:** `POST /api/admin/provision`, bearer `ADMIN_TOKEN`. Writes the
business, its `phone_numbers` routing row, and the owner's login in **one D1
batch**, so a half-provisioned customer is not a reachable state. Returns a
generated password once, using an alphabet with no `0/O`, `1/l/I`, `5/S` or
`2/Z` because it gets read aloud on a sales call.

---

## TESTS — 173 assertions, all passing

`node tests/run.mjs` against `npx wrangler dev --port 8787`. Local D1/KV only;
no production credential, no production resource. Provisions its own tenants and
deletes them at the end, so it is repeatable.

Covered: provisioning (incl. duplicate number → 409, duplicate email → 409) ·
auth (wrong password, unknown email returning the *same* error, no session,
expired session, post-logout cookie replay, CSRF) · password change (current
password required, other sessions revoked) · lockout · webhook signatures
(valid / missing / wrong key / malformed / **stale beyond the 5-min window** /
**body tampered after signing**) · malformed bodies and wrong methods ·
unknown numbers · **tenant isolation A↔B across leads, calls, bookings,
follow-ups, settings, and a forged `business_id` in the body** · lead dedupe
(same caller ×3, different format, different caller, owner status preserved,
closed lead reopening, spam, voicemail, triple-replayed webhook) · metering
(rounding, month boundary, past month, overage, per-timezone month) · bookings ·
follow-ups (due vs not-yet-due) · notifications (queued, deduped, skipped with a
reason) · suspension (read yes, write 402, phone rejects).

**Bug found and fixed by the suite:** `notify_email` was normalised at
provisioning but not on the settings update path, so the same address could be
stored two ways. Now normalised in one place, and an unusable address is
rejected with 400 rather than silently blanking the owner's notification target.

**NEXT:** Phases 10–13 — dashboard shell, leads UI, calls + settings UI, demo
seed data.
