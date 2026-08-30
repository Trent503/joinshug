# How Shug Works — System Architecture for Owners

This document explains what the Shug system does, where each piece lives, and how a phone call becomes a lead in your dashboard.

---

## The Big Picture

Shug is an AI receptionist that answers your phone 24/7. When a customer calls:

1. **The call reaches Shug** on the phone number you were assigned
2. **Shug answers and talks to the caller** (it can hear their name, what they want, when they're available, and whether it's urgent)
3. **Information goes to a database** (D1, run by Cloudflare)
4. **You get notified** (text and/or email, if configured)
5. **You log into `/app/` and see every lead**, call history, and booking requests
6. **You respond** from the dashboard or by calling them back

---

## Where Things Live

This system runs on **Cloudflare Workers** — Google Cloud equivalent for a website. It costs pennies per month and scales automatically.

| What | Where | Purpose |
|---|---|---|
| **Marketing site** (joinshug.com) | Cloudflare Workers + static assets | The pages people see to learn about Shug |
| **Your dashboard** (/app/) | Cloudflare Workers + static HTML/CSS/JS | Where you log in and see leads, calls, and history |
| **Database** (D1) | Cloudflare's SQLite database | Every customer, lead, call, booking, and notification ever created |
| **API endpoints** (/api/*) | Cloudflare Workers | The brain — handles login, lead creation, call analysis, notifications, everything |
| **Voice cache** (KV) | Cloudflare's key-value store | Fast lookup: "what business owns this phone number?" |
| **Retell agent** | Retell's servers | The actual AI voice on the phone |

All of this is **multi-tenant**, meaning one database safely holds 10, 100, or 1,000 different contractors' data, each one completely isolated. Your leads never show up on another business's dashboard.

---

## How a Call Travels Through the System

### The Moment a Call Arrives (under 1 second)

1. **Incoming call** → Retell's servers see the call land on a phone number
2. **"Who owns this number?"** → Shug's `/api/retell/inbound` endpoint is called
   - We look up the number in the cache (KV)
   - If cache misses, we ask the database (D1)
3. **Load business configuration** → How does this business want to be called? Hours? Services? Who is the owner?
4. **Send to Retell** → "Here's how to talk to this customer"
5. **Retell speaks the greeting** → Owner's business name, services they offer, hours, etc.

**If this endpoint fails:** Retell waits 6 seconds then falls back to the default agent for that number. No dead air.

### During the Call (1-10 minutes)

1. **Retell's AI talks to the caller**
   - Understands what service they need
   - Captures their name, phone, address, and when they want service
   - Tries to book an appointment
2. **Call is recorded** (by Retell)
3. **Call duration is tracked** (for billing against your 120-minute monthly allowance)

### When the Call Ends (immediately)

1. **Shug writes a `calls` row** to the database with the recording link and duration
2. **Notification is queued** — "Someone just called. Here's who."
3. **"Wait, when did this person last call?"** → Look up their phone number in `leads` table
   - If first time: create a new lead
   - If called before: update existing lead (add call to call_count, update last_call_at)

**This is critical:** A lead is a PERSON, not a call. If the same customer calls three times, that's one lead with three calls. The dashboard calls this "that guy who keeps calling" — one row, one conversation history.

### Retell Analyzes the Call (30 seconds - 2 minutes later)

1. **Retell's AI listens** to the recording and fills out a form
   - Caller's name → `leads.name`
   - What they want → `leads.service` / `leads.job_description`
   - Urgency → `leads.urgency`
   - Preferred appointment time → could become a `bookings` row
2. **Webhook arrives** at `/api/retell/webhook`
3. **Lead is updated** with everything Retell extracted
4. **If an appointment was discussed:** Create a `bookings` row (if the date is explicit, not "next Tuesday")
5. **Notification is rewritten** now that we know the caller's name and what they want
6. **Notification is sent** to you (text/email, if you configured it)

---

## The Dashboard (/app/)

When you log in to `/app/`:

- **Overview**: New leads, waiting on you. Hours used this month vs. your 120-minute allowance. Upcoming bookings and follow-ups.
- **Leads list**: Every person who ever called, grouped by status (new, contacted, qualified, booked, completed, lost)
  - **"New"** = just called, you haven't looked at it yet
  - **"Waiting on you"** = new leads that you haven't opened yet (this count reaches zero when you deal with them)
  - Phone number and quick actions: **Call** (tel:) and **Text** (SMS) buttons on every lead
- **Lead detail**: Full history of this person. Every call they made. What they said. Recording links. Notes. Appointment requests.
- **Calls**: All 320+ calls, with transcripts and summaries
- **Settings**: Change your phone number, business name, hours, services offered, what "urgent" means, where appointments should go (Jobber, Google Calendar, or just stay in Shug)

All of this is **your data only**. Nobody else sees it.

---

## The Numbers: Billing and Quotas

**You get 120 AI voice minutes per month**, included in your $99/month subscription.

### How minutes are measured

- Every call is timed from the moment Retell answers until the caller hangs up
- Fractional minutes round UP (a 30-second call counts as 1 minute)
- Monthly total is rounded up: six 10-second calls = 60 seconds = 1 minute (not 6 minutes)

**Where to check**: `/app/` → Overview → "87 of 120 minutes used"

### If you exceed 120 minutes

Overage pricing applies (see `/pricing/`). Retell **does not reject calls** when you exceed quota — you just pay more. This means you never miss a lead because you ran out of minutes. That would break your business.

---

## Notifications: How You Get Told

When a call ends and Retell finishes analyzing it, you can be notified via:

- **SMS (text)** → Requires Twilio API credentials (not yet configured)
- **Email** → Requires an email provider like Resend (not yet configured)
- **Dashboard badge** → "New leads: 3, waiting on you" appears on `/app/`

**Current status:** Notifications are **queued durably in the database** but SMS and email are **not being sent**. This is intentional — everything is built and tested, but your SMS provider (Twilio) and email provider have not been connected yet. See `NEEDS_CONFIG.md` for exactly what to configure.

The Dashboard notification badge works right now.

---

## External Services Connected to Shug

| Service | What it does | Configured? |
|---|---|---|
| **Retell** | The AI voice that answers calls | ✅ (mostly — see Secrets below) |
| **Cloudflare** | Hosts everything — Workers, database, cache | ✅ |
| **Twilio** | Sends text notifications | ❌ Not set up |
| **Email provider** | Sends email notifications | ❌ Not set up |
| **Jobber** | Optional: send bookings directly to Jobber CRM | ❌ Built but not enabled |
| **Google Calendar** | Optional: send bookings directly to your calendar | ❌ Built but not enabled |

---

## Secrets and Credentials

These are the keys that make the system work. **They are set in Cloudflare's dashboard, not in any file.**

| Secret | What it does | Status |
|---|---|---|
| **RETELL_API_KEY** | Proves to Retell that we own the AI agent | ⚠️ **NOT SET** |
| **ADMIN_TOKEN** | Used to provision new customers (the $199 setup call) | ⚠️ **NOT SET** |
| **TWILIO_ACCOUNT_SID** | Identifies your Twilio account | ❌ Not needed yet |
| **TWILIO_AUTH_TOKEN** | Proves to Twilio we can send SMS | ❌ Not needed yet |
| **TWILIO_FROM_NUMBER** | The number texts come from | ❌ Not needed yet |

**Critical issue:** `RETELL_API_KEY` and `ADMIN_TOKEN` are not set in production. This means:
- Retell webhooks will fail (already discovered in previous session — endpoints returned 404)
- You cannot provision new customers from sales calls

This has been fixed in the code (the router now exists), but the credentials still need to be set in Cloudflare's dashboard. See `RUNBOOK.md` for how to fix this.

---

## The Database Schema: What's Stored

### businesses

One row per customer contractor.

| Column | Meaning |
|---|---|
| `name` | "Acme Plumbing" |
| `phone_e164` | "+15035551234" — the main Shug number |
| `timezone` | "America/Los_Angeles" — needed to bill calls to the right month |
| `status` | 'active' (answers calls), 'suspended' (down for non-payment), 'setup' (answers but flag in dashboard) |
| `hours` | "Mon-Fri 8am-5pm, Sat 9am-2pm" — what the agent says |
| `services_offered` | "plumbing, water heaters, drain cleaning" |
| `services_declined` | "septic tank work" |
| `notify_sms` | Your phone number (if you want texts) |
| `notify_email` | Your email (if you want emails) |
| `booking_destination` | Where appointments go: 'internal' (Shug only), 'jobber', 'google_calendar', 'gohighlevel' |

### leads

One row per unique caller (deduplicated by phone number).

| Column | Meaning |
|---|---|
| `name` | "John Smith" (from Retell extraction or manual entry) |
| `phone` | "+15035551111" — the caller's number (E.164 format) |
| `email` | "john@example.com" |
| `address` | Where they want service |
| `service` | What they want: "water heater" |
| `urgency` | How fast: "today", "this week", "no rush" |
| `preferred_time` | When they're available |
| `status` | 'new', 'contacted', 'qualified', 'booked', 'completed', 'lost' |
| `viewed_at` | When you first opened their lead detail (NULL = you haven't seen it) |
| `last_call_at` | When they most recently called |
| `call_count` | How many times they called |
| `delivery_status` | 'pending' (not sent to Jobber/Calendar yet), 'sent', 'failed', 'skipped' |

### calls

One row per phone call (the billing record).

| Column | Meaning |
|---|---|
| `retell_call_id` | Retell's unique ID for this call |
| `business_id` | Which contractor owns this number |
| `lead_id` | The person who called (might be NULL for first-time callers until analyzed) |
| `duration_sec` | How long the call lasted |
| `billed_month` | "2024-08" — for billing (in the business's timezone, not UTC) |
| `summary` | Retell's summary of the call |
| `transcript` | The full conversation |
| `recording_url` | Link to the audio file |

### bookings

One row per requested or confirmed appointment.

| Column | Meaning |
|---|---|
| `date` | "2024-08-15" (the business's local date) |
| `start_time` | "14:00" (2pm) |
| `end_time` | "16:00" (4pm) |
| `status` | 'requested', 'confirmed', 'completed', 'cancelled', 'no_show' |
| `destination` | 'internal' (Shug only), 'jobber', 'google_calendar', 'gohighlevel' |
| `destination_ref` | The ID Jobber/Calendar gave back (so we don't create it twice) |

### notifications

Queue of "tell the owner" messages.

| Column | Meaning |
|---|---|
| `channel` | 'sms' or 'email' |
| `target` | Phone number or email address |
| `body` | The message |
| `status` | 'queued' (waiting to send), 'sent', 'failed', 'skipped' (no provider) |

### users

Login accounts for people on your team.

| Column | Meaning |
|---|---|
| `email` | Login email |
| `password_hash` | Not the password — a PBKDF2-HMAC-SHA256 hash (100,000 iterations) |
| `role` | 'owner' or 'staff' |
| `status` | 'active' or 'disabled' |

### sessions

Server-side logins (so logout takes effect instantly).

| Column | Meaning |
|---|---|
| `id` | SHA-256 of the session token (not the token itself) |
| `user_id` | Which person |
| `expires_at` | When it expires (30 days from login) |
| `revoked_at` | When the person logged out (if they did) |

---

## Multi-Tenancy: The Safety Guarantee

**Every table has `business_id`, and every query filters by it.**

When you log in:
1. Your session row is looked up (by session token)
2. `business_id` is read from the session
3. That `business_id` is used in every subsequent query

Your leads can never be read by another business. Your settings can never be changed by another business. Even if someone stole a user's password, they would only see that business's data. The database enforces it at the query level, not in the application layer.

---

## Deployment

### How code reaches production

1. **Developer** pushes code to GitHub
2. **Cloudflare** automatically pulls and deploys (`wrangler deploy`)
3. **API endpoints** update (new or fixed behavior)
4. **Database schema** does NOT auto-update — migrations must be run manually (see `RUNBOOK.md`)
5. **Your data** is never touched in a deploy (code-only updates)

### What gets deployed

| Part | Deployed by wrangler? | How |
|---|---|---|
| Marketing site (joinshug.com) | Yes | Static files from repo root |
| Dashboard (/app/) | Yes | Static HTML/CSS/JS |
| API code (functions/) | Yes | JavaScript |
| Database schema | **NO** | Manual `wrangler d1 execute` command |
| Secrets (API keys) | **NO** | Cloudflare dashboard or `wrangler secret put` |

---

## The Two Recent Changes

### 1. The Worker Router (Session Log entry: Phase 1)

**What changed:** The project was incorrectly documented as a "Cloudflare Pages" project. It's actually a **Worker with static assets**, which means the API endpoints live in code (`worker/index.js`), not in a special `functions/` directory that Pages auto-routes.

**Impact on you:** Nothing, if this was fixed in code. But credentials (`RETELL_API_KEY`, `ADMIN_TOKEN`) still need to be set in Cloudflare's dashboard or the system still won't work.

### 2. The "Viewed At" Column (Migration 001)

**What changed:** When you open a lead's detail in the dashboard, the system now remembers you saw it. This fixes the "new leads: 3" badge — it stops showing 3 if you've read all 3 but just didn't change their status.

**Impact on you:** Your migration must be run on production before this works. See `RUNBOOK.md`.

---

## Summary: The Pieces

```
Caller's Phone
      ↓
Retell (Answers & Records)
      ↓
Cloudflare Worker (Router)
      ↓
/api/retell/inbound (Lookup business config)
      ↓
Retell Agent (Speaks using your settings)
      ↓
Call ends
      ↓
/api/retell/webhook (Analysis arrives)
      ↓
D1 Database (Lead created or updated)
      ↓
Notifications (SMS/Email queue)
      ↓
Your Dashboard (/app/) (You see everything)
```

Everything is on Cloudflare's global network, runs in 200ms, costs pennies, and scales automatically. The system is designed to handle 1,000 contractors on one database without any performance degradation.
