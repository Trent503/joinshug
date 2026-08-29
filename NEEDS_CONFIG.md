# What Shug still needs from you

Everything in this file is a credential or an external configuration step that
**cannot** be done from inside this repository. The code around each one is
built and tested; each item is the switch that turns it on.

Nothing here is faked, stubbed-with-a-lie, or hardcoded. Where a provider is
missing, the system records that fact explicitly rather than pretending to have
succeeded — see **Owner notifications** below for the clearest example.

Ordered by what blocks revenue soonest.

---

## 1. `ADMIN_TOKEN` — REQUIRED BEFORE YOU CAN SELL ANYONE

**What it is:** the bearer token for `POST /api/admin/provision`, which is how a
"yes" on a sales call becomes a live customer. It is the most powerful
credential in the system — anyone holding it can create a tenant and its owner
login.

**Where it is used:** `functions/lib/guard.js` → `requireAdmin()`, guarding
`/api/admin/provision` and `/api/admin/notifications`.

**Without it:** those endpoints return `503 not_configured`. They **fail
closed** — an unset secret never means "skip the check". Everything else works;
you simply cannot provision a new customer.

**Exactly what to do:**

```bash
# 1. Generate one. Keep it in your password manager, not in a file.
openssl rand -base64 32

# 2. Set it as a Worker secret (you will be prompted to paste the value).
npx wrangler secret put ADMIN_TOKEN

# 3. Confirm it is set.
npx wrangler secret list
```

Do **not** put it in `wrangler.toml` — that file is committed.

---

## 2. `RETELL_API_KEY` in production

**What it is:** one key doing two jobs — authenticating calls *to* Retell's API,
and verifying the HMAC-SHA256 signature on webhooks *from* Retell.

**It must be the key carrying the WEBHOOK badge in the Retell dashboard.** Any
other key authenticates API calls fine and fails every signature check, which
presents as *every webhook rejected with 401*. Check this first if that happens.

**Where it is used:** `functions/lib/retell.js` → `readVerifiedWebhook()`,
called by both `/api/retell/inbound` and `/api/retell/webhook`.

**Without it:** the event webhook returns `500 not_configured` and writes
nothing. The inbound webhook returns a pass-through so calls are still answered
by the number's default agent rather than meeting dead air.

**Status:** present in local `.dev.vars`. **Not yet set in production.**

```bash
npx wrangler secret put RETELL_API_KEY
```

---

## 3. Point the Retell number at these webhooks

This is the step no code can do for you, and until it is done **no call reaches
Shug at all**.

In the Retell dashboard, for the phone number you are selling:

| Setting | Value |
|---|---|
| Inbound call webhook | `https://joinshug.com/api/retell/inbound` |
| Call events webhook | `https://joinshug.com/api/retell/webhook` |

`POST /api/admin/provision` returns this same instruction in its `nextStep`
field, with the customer's own number filled in, so it is in front of you at the
moment you need it.

### The agent's extraction schema

`functions/api/retell/webhook.js` maps Retell's Post Call Extraction fields onto
lead columns, accepting several aliases for each so the dashboard schema does
not have to match the code byte for byte. The names it looks for:

| Lead field | Accepted names (first match wins) |
|---|---|
| `name` | `name`, `caller_name`, `customer_name`, `contact_name`, `full_name` |
| `phone` | `phone`, `phone_number`, `callback_number`, `customer_phone`, `contact_phone` |
| `email` | `email`, `email_address`, `customer_email`, `contact_email` |
| `address` | `address`, `service_address`, `job_address`, `street_address`, `location` |
| `service` | `service`, `service_type`, `job_type`, `service_requested`, `trade_service` |
| `job_description` | `job_description`, `job`, `issue`, `problem`, `reason_for_call`, `service_needed` |
| `urgency` | `urgency`, `urgent`, `priority`, `timeline`, `how_soon` |
| `preferred_time` | `preferred_time`, `preferred_appointment_time`, `appointment_time`, `availability`, `when` |

For a **booking** to be created automatically, the agent must return a real
calendar date:

| Booking field | Accepted names |
|---|---|
| date | `appointment_date`, `booking_date`, `scheduled_date`, `visit_date` |
| start | `appointment_start_time`, `appointment_time`, `booking_time`, `scheduled_time`, `visit_time` |
| end | `appointment_end_time`, `booking_end_time` |
| confirmed | `appointment_confirmed`, `booking_confirmed`, `appointment_booked` |

The date must be `YYYY-MM-DD`. **"Next Tuesday" deliberately does not create a
booking** — it is kept on the lead's `preferred_time` instead. Guessing a date
would put wrong appointments on a contractor's schedule, which is worse than
putting none there.

**If leads arrive with null fields, the field names configured in Retell are the
first thing to check.**

### Dynamic variables the agent can speak

`/api/retell/inbound` returns these, populated per business. Use them as
`{{placeholders}}` in the Retell prompt:

`business_name` · `trade` · `services_offered` · `services_declined` ·
`service_area` · `service_area_notes` · `hours` · `greeting` · `tone` ·
`urgency_rules` · `transfer_number` · `booking_destination` ·
`current_local_time`

### Optional: `RETELL_REQUIRE_INBOUND_SIGNATURE`

Currently `"0"` in `wrangler.toml`. Retell documents `X-Retell-Signature` for
the **event** webhook; whether it also signs the **inbound-call** webhook is not
documented, so inbound verifies a signature if one is present and accepts the
request if not.

Turning this on before confirming a signature actually arrives would stop every
call from being answered. To confirm: place a test call and look for
`retell: unsigned request accepted` in `npx wrangler tail`. If that line does
**not** appear, a signature is arriving and you can safely set the variable to
`"1"`.

---

## 4. Owner notifications — NO SMS PROVIDER IS CONNECTED

**This is the one gap a customer would notice.** Everything except the final
send is built and tested.

**What works today, with no credentials at all:**

* every completed call creates a `notifications` row, queued at `call_ended` so
  the record exists even if Retell's analysis never arrives
* the message body is rewritten at `call_analyzed` once the caller's name,
  number, service and urgency are known
* `UNIQUE(call_id, channel)` makes both paths idempotent — a retried webhook
  cannot text the owner twice about one call
* the queue is drained by `POST /api/admin/notifications`
* every attempt is recorded as `sent`, `failed`, or `skipped`

**What does not happen:** the text is not sent. With `SMS_PROVIDER` unset, every
notification lands in **`status = 'skipped'`, `error = 'no_provider'`**.

That state is deliberately distinct from `'failed'`, so "we have no credentials"
can never hide inside "delivery is broken". The lead detail page shows it to the
owner as *"No SMS provider connected yet"* rather than silently showing nothing.

**To turn it on** — a Twilio adapter is written in full in
`functions/lib/notify.js` → `sendViaTwilio()`:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
```

then add to `[vars]` in `wrangler.toml`:

```toml
SMS_PROVIDER = "twilio"
```

> ⚠️ **The Twilio adapter has never been executed against the live API.** No
> Twilio account exists for this project and none was created. The request shape
> follows Twilio's documented REST contract, but treat the first real send as
> the test: run `POST /api/admin/notifications` and check the row goes to
> `sent`. If Twilio is not the provider you want, the adapter is ~40 lines and
> the seam it plugs into (`deliver()`) does not change.

**Email notifications** are queued the same way and also land in `skipped`.
There is no email adapter at all. Note that Cloudflare Email Routing sends
**inbound** mail only — outbound needs a real provider (Resend, Postmark,
SendGrid, Amazon SES). Say which one you want and it is a similar ~40 lines.

**Running the queue automatically:** nothing does yet. `POST /api/admin/notifications`
is what a Cloudflare Cron Trigger would call. Adding one is:

```toml
[triggers]
crons = ["*/2 * * * *"]
```

plus a `scheduled()` export in `worker/index.js`. Deliberately not added while
there is no provider — a cron that runs every two minutes to skip everything is
noise.

---

## 5. Jobber — DOCUMENTATION ONLY. Not modified, not routed, not deployed.

`functions/api/jobber/` was read and left **byte-for-byte untouched** this
session, as instructed.

### What exists

**`start.js` (122 lines) — OAuth leg 1 of 2.** `GET /api/jobber/start`.
Redirects the user to Jobber's authorize endpoint. Generates a 32-byte CSPRNG
`state`, stores it in a `__Secure-shug_jobber_state` cookie scoped to
`/api/jobber` with a 600-second TTL, and uses `SameSite=Lax` deliberately —
`Strict` would drop the cookie on the cross-site redirect back from Jobber and
break every callback. Only the public client id is referenced; the secret never
appears in this file.

**`callback.js` (373 lines) — OAuth leg 2 of 2, and the token store.**
`GET /api/jobber/callback`. Verifies `state` with a constant-time compare,
exchanges the code for tokens server-to-server, fetches the Jobber account id
over GraphQL, and stores tokens in KV under `jobber:account:<id>` — one key per
connected account, so no account can read or clobber another's. It also exports
`getValidJobberAccessToken()` and `refreshJobberTokens()` (plain functions, not
route handlers) implementing refresh-token rotation with a 120-second skew, so
future code can call Jobber without re-implementing refresh. It renders its own
minimal HTML result page that borrows nothing from `assets/site.css`, so the
marketing design cannot drift with it.

### What is NOT built

* **No adapter delivers a Shug lead into Jobber.** The OAuth plumbing is
  complete; nothing calls it. Setting a business's `booking_destination` to
  `'jobber'` today would leave its leads at `delivery_status = 'pending'` with
  nothing to deliver them.
* **The routes are not registered.** `worker/index.js` deliberately omits
  `functions/api/jobber/*` from its route table. That is what keeps a half-built
  OAuth flow off the public internet. Adding two lines to `ROUTES` turns them on.

### What enabling it would take

1. Register the app in Jobber's Developer Center; note the client id and secret.
2. Register the callback URL **byte-for-byte** as
   `https://joinshug.com/api/jobber/callback`. It is deliberately not derived
   from the request URL — deriving it would break on preview deployments and
   would trust a client-controlled `Host`.
3. Set the secrets and variables:
   ```bash
   npx wrangler secret put JOBBER_CLIENT_SECRET
   ```
   and in `wrangler.toml` `[vars]`: `JOBBER_CLIENT_ID`, `JOBBER_REDIRECT_URI`.
   Optional overrides: `JOBBER_AUTHORIZE_URL`, `JOBBER_TOKEN_URL`,
   `JOBBER_API_URL`, `JOBBER_GRAPHQL_VERSION` (currently defaults to
   `2025-04-16` — confirm the current version in the Developer Center),
   `JOBBER_SCOPES`.
4. The `JOBBER_TOKENS` KV namespace already exists and is already bound
   (`439992672db24d6eb504c9842f1810d5`).
5. Add the two routes to `ROUTES` in `worker/index.js`.
6. Write the delivery adapter — the only genuinely new code — reading leads with
   `delivery_status = 'pending'` and `booking_destination = 'jobber'`, creating
   the Jobber request or client, and calling `markLeadDelivery()` with the
   returned id.

**Nothing built this session would need rewriting to enable it.**
`businesses.booking_destination` and `bookings.destination` are already the
seam, `leads.delivery_status` / `delivery_error` / `booking_ref` already track
per-lead delivery, and `markLeadDelivery()` is already the function an adapter
calls when it finishes.

---

## 6. GoHighLevel — planned, no code

No GoHighLevel code exists in this repository. `'gohighlevel'` is a valid value
for `businesses.booking_destination` and `bookings.destination`, and that is the
entire extent of it. When built it uses the current OAuth 2.0 / API v2
architecture, not the legacy v1 API key. Do not set a business to this
destination until an adapter exists.

---

## Reference: everything the production Worker reads

| Name | Kind | Status | Consequence if unset |
|---|---|---|---|
| `RETELL_API_KEY` | secret | **not set in prod** | event webhook 500s; inbound passes through |
| `ADMIN_TOKEN` | secret | **not set in prod** | cannot provision customers (503) |
| `SMS_PROVIDER` | var | not set | notifications queue and skip with `no_provider` |
| `TWILIO_ACCOUNT_SID` | secret | not set | as above |
| `TWILIO_AUTH_TOKEN` | secret | not set | as above |
| `TWILIO_FROM_NUMBER` | secret | not set | as above |
| `JOBBER_CLIENT_ID` | var | not set | Jobber routes are not registered anyway |
| `JOBBER_CLIENT_SECRET` | secret | not set | as above |
| `JOBBER_REDIRECT_URI` | var | not set | as above |
| `RETELL_REQUIRE_INBOUND_SIGNATURE` | var | `"0"` | inbound verifies-if-present (intended default) |
| `SESSION_TTL_HOURS` | var | `"720"` | 30-day dashboard sessions |
| `DB` | D1 binding | ✅ bound | nothing works |
| `CONFIG_CACHE` | KV binding | ✅ bound | number lookups fall through to D1 (slower only) |
| `JOBBER_TOKENS` | KV binding | ✅ bound | Jobber only |
| `ASSETS` | assets binding | ✅ bound | the marketing site |

Check what is actually set:

```bash
npx wrangler secret list
```
