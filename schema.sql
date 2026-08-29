-- Shug — D1 schema for the AI receptionist.
--
-- Apply with:
--   wrangler d1 execute shug --local  --file=./schema.sql   (local dev)
--   wrangler d1 execute shug --remote --file=./schema.sql   (production)
--
-- Every statement is idempotent (CREATE ... IF NOT EXISTS), so re-running this
-- file is safe and is the supported way to bring a database up to date.
-- Changes to an ALREADY-POPULATED database go in migrations/ as numbered,
-- additive steps; this file stays the canonical shape of a fresh database.
--
-- ---------------------------------------------------------------------------
-- Design notes that are not obvious from the DDL
-- ---------------------------------------------------------------------------
--
-- * MULTI-TENANT FROM ROW ONE. Every business-owned table carries business_id
--   and every query in functions/lib/ is scoped by it. business_id is NEVER
--   read from a client request — it comes from the authenticated session
--   (functions/lib/auth.js) or from the number Retell dialed.
--
-- * A LEAD IS A PERSON, NOT A CALL. leads is keyed UNIQUE on
--   (business_id, phone) and calls.lead_id points at the lead. A customer who
--   calls three times is one lead with three calls, which is what a contractor
--   means by "that guy who keeps calling". The reverse (one lead per call)
--   would make the leads list unusable within a week of real traffic.
--
-- * MINUTE USAGE IS DERIVED, NEVER STORED. SUM(duration_sec) over an indexed
--   (business_id, billed_month). A running counter would need
--   read-modify-write, and two calls ending in the same instant would lose an
--   increment. A SUM cannot drift.
--
-- * calls.retell_call_id IS THE PRIMARY KEY so webhook delivery is idempotent.
--   Retell retries a failed webhook up to 3 times; every write path is an
--   upsert keyed on it, so a retry cannot double-bill a call or duplicate a
--   lead.
--
-- * NO SECRETS LIVE HERE. Password *verifiers* do (PBKDF2 hash + salt, which
--   are not secrets). API keys are Worker secrets; OAuth tokens are KV.

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- businesses — what the $199 setup call actually produces.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS businesses (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,

  -- The business's PRIMARY Retell number, E.164. Kept here as well as in
  -- phone_numbers because it is the one a human means by "your Shug number",
  -- and settings/provisioning both want a single obvious field. phone_numbers
  -- is the routing table; this is the display value.
  phone_e164          TEXT NOT NULL UNIQUE,

  -- IANA zone, e.g. 'America/Los_Angeles'. Needed to answer "are you open
  -- right now" correctly, and to bill a call to the month the BUSINESS was in.
  -- The edge runs in UTC and the caller does not.
  timezone            TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  trade               TEXT,

  -- Configuration the agent speaks from. Stored as TEXT because Retell
  -- dynamic variables must be strings — anything structured would have to be
  -- flattened at read time anyway, and flattening twice invites drift.
  services_offered    TEXT,
  services_declined   TEXT,   -- "the ones you do not want calls about"
  service_area        TEXT,
  service_area_notes  TEXT,   -- "the edges you would rather not drive to"
  hours               TEXT,
  greeting            TEXT,
  tone                TEXT,

  -- What is urgent enough to interrupt the owner, in the trade's own language,
  -- and the number to bridge to when it happens.
  urgency_rules       TEXT,
  transfer_number     TEXT,

  -- Where the owner is told a call came in. notify_sms is E.164, notify_email
  -- is an address. Either, both, or neither may be set; a business with
  -- neither still gets notification ROWS, they just cannot be sent.
  -- See functions/lib/notify.js.
  notify_sms          TEXT,
  notify_email        TEXT,

  -- Where a booking should land. 'internal' means "it lives in Shug and the
  -- owner reads it in /app/", which is the whole MVP. The others are adapter
  -- names for later; adding one is a value here, not a schema change.
  booking_destination TEXT NOT NULL DEFAULT 'internal',
  booking_config      TEXT NOT NULL DEFAULT '{}',

  -- Billing. 120 minutes is what /agent/ and /pricing/ promise for $99.
  minutes_included    INTEGER NOT NULL DEFAULT 120,

  -- 'active' answers calls. 'suspended' is the hook for non-payment: the
  -- inbound webhook rejects rather than answer a call we will not bill for.
  -- 'setup' answers, but flags that configuration is not finished.
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'setup')),

  -- 1 for the seeded demo tenant. Keeps fake data out of any real report and
  -- makes "delete the demo" a one-line, unambiguous query. Real customers are
  -- always 0.
  is_demo             INTEGER NOT NULL DEFAULT 0,

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- phone_numbers — the routing table: which number rings for which business.
--
-- Separate from businesses.phone_e164 because a business will eventually have
-- more than one (a ported main line plus a tracking number for ads), and
-- because number -> business is the lookup on the path of every ringing phone.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS phone_numbers (
  e164        TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label       TEXT,
  -- 'active' routes. 'inactive' is a number we still own but is not in
  -- service; it resolves to nothing and the caller gets the default agent.
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_business
  ON phone_numbers (business_id);

-- ===========================================================================
-- users — dashboard logins. One business can have several; a user belongs to
-- exactly one business, which is what makes tenant isolation a single join.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Lower-cased and trimmed before insert. UNIQUE across the whole table, not
  -- per business: an email must identify one login, or /api/auth/login would
  -- have to ask which tenant you meant.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,

  -- PBKDF2-HMAC-SHA256. All three columns are required to verify, and the
  -- iteration count is stored per row so it can be raised later without
  -- invalidating existing passwords. See functions/lib/auth.js.
  -- These are verifiers, not secrets: they cannot be replayed as a password.
  password_hash TEXT NOT NULL,          -- base64, 32 bytes derived
  password_salt TEXT NOT NULL,          -- base64, 16 random bytes, per user
  password_iterations INTEGER NOT NULL,

  role          TEXT NOT NULL DEFAULT 'owner'
                  CHECK (role IN ('owner', 'staff')),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),

  -- Online-guess throttling. Cleared on a successful login.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,

  -- Set when provisioning generates a password. The dashboard nags until the
  -- owner changes it.
  must_change_password INTEGER NOT NULL DEFAULT 0,

  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_business ON users (business_id);

-- ===========================================================================
-- sessions — server-side, so a logout or a suspension takes effect instantly.
--
-- id is the SHA-256 of the session token, NOT the token. The token exists only
-- in the user's cookie. A dump of this table therefore cannot be replayed as a
-- login, which is the entire reason to hash it.
--
-- business_id is denormalised onto the row so authorising a request is one
-- indexed primary-key read with no join.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,        -- sha256(token), hex
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT,
  user_agent   TEXT                      -- truncated; for "sign out other devices"
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
-- Supports the expiry sweep.
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ===========================================================================
-- leads — a PERSON who called, not a call. See the design note at the top.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS leads (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name            TEXT,
  -- E.164, normalised by normalizeE164() on every write path. The dedupe key.
  -- NULL is allowed for a caller with blocked caller ID who never gave a
  -- number; SQLite treats NULLs as distinct in a UNIQUE index, so those
  -- correctly become one lead per call rather than all collapsing into one.
  phone           TEXT,
  email           TEXT,
  address         TEXT,

  -- What they want. `service` is the short label the dashboard lists
  -- ("water heater"); `job_description` is what they actually said.
  service         TEXT,
  job_description TEXT,
  urgency         TEXT,
  preferred_time  TEXT,

  source          TEXT NOT NULL DEFAULT 'call'
                    CHECK (source IN ('call', 'web', 'manual', 'seed')),

  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'qualified',
                                      'booked', 'completed', 'lost')),

  -- Owner's own notes, edited in the dashboard. Never overwritten by a webhook.
  notes           TEXT,

  -- Denormalised so the leads LIST can sort by real recency and show "3 calls"
  -- without a correlated subquery per row.
  first_call_id   TEXT,
  last_call_id    TEXT,
  last_call_at    TEXT,
  call_count      INTEGER NOT NULL DEFAULT 0,

  -- Delivery to an external booking destination, tracked separately from
  -- capture: a lead we captured but failed to deliver is the one failure mode
  -- that costs a customer a job, so it must be queryable. 'internal' businesses
  -- are marked 'skipped' — there is nowhere to deliver to and pending would be
  -- a lie.
  delivery_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped')),
  delivery_error  TEXT,
  delivered_at    TEXT,
  booking_ref     TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- THE DEDUPE KEY. Also the conflict target for the upsert in store.js, which
-- is why it is a plain (not partial) unique index: ON CONFLICT can only name
-- a partial index by repeating its WHERE clause, and that is a footgun.
CREATE UNIQUE INDEX IF NOT EXISTS ux_leads_business_phone
  ON leads (business_id, phone);

CREATE INDEX IF NOT EXISTS idx_leads_business_recent
  ON leads (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_business_status
  ON leads (business_id, status, created_at DESC);

-- Finds leads that still need delivering, for a retry sweep.
CREATE INDEX IF NOT EXISTS idx_leads_undelivered
  ON leads (delivery_status, created_at)
  WHERE delivery_status IN ('pending', 'failed');

-- ===========================================================================
-- calls — one row per Retell call. The billing record.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS calls (
  retell_call_id  TEXT PRIMARY KEY,
  business_id     TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  -- Set once the call produces or matches a lead. SET NULL rather than CASCADE:
  -- deleting a lead must not delete the billing record for the call.
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,

  from_number     TEXT,
  to_number       TEXT,
  direction       TEXT CHECK (direction IN ('inbound', 'outbound')),

  started_at      TEXT,
  ended_at        TEXT,
  duration_sec    INTEGER NOT NULL DEFAULT 0,

  -- 'YYYY-MM' in the BUSINESS's timezone, not UTC. A 5pm PST call on the 31st
  -- is 01:00 UTC on the 1st — billing it to the wrong month would be wrong on
  -- the only two days a month anyone checks.
  billed_month    TEXT,

  disconnect_reason TEXT,
  call_successful   INTEGER,   -- 0/1 from call_analyzed, NULL until analyzed
  user_sentiment    TEXT,
  summary           TEXT,
  recording_url     TEXT,
  transcript        TEXT,

  -- Set once the call has been through `call_analyzed`. Until then the row is
  -- a partial record written by call_started/call_ended.
  analyzed_at     TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The metering query is SUM(duration_sec) WHERE business_id = ? AND
-- billed_month = ?. This index is what keeps that from scanning the table.
CREATE INDEX IF NOT EXISTS idx_calls_billing
  ON calls (business_id, billed_month);

CREATE INDEX IF NOT EXISTS idx_calls_started
  ON calls (business_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_calls_lead
  ON calls (lead_id, started_at DESC);

-- ===========================================================================
-- bookings — an appointment, or a request for one.
--
-- Deliberately NOT a calendar. No recurrence, no availability, no conflict
-- detection, no timezone maths on the slot: `date` and the times are the
-- business's local wall clock, exactly as the caller and the owner would say
-- them out loud. Shug is not becoming a scheduling SaaS.
--
-- `destination` is the seam. Today every row is 'internal' and lives here.
-- Google Calendar, Jobber, and GoHighLevel each become a value plus an adapter
-- that fills destination_ref — the receptionist path never changes.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS bookings (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id     TEXT REFERENCES leads(id) ON DELETE CASCADE,
  -- Which call asked for it, when a call did.
  call_id     TEXT REFERENCES calls(retell_call_id) ON DELETE SET NULL,

  date        TEXT,   -- 'YYYY-MM-DD', business-local
  start_time  TEXT,   -- 'HH:MM', 24h, business-local
  end_time    TEXT,   -- 'HH:MM', business-local

  status      TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'confirmed', 'completed',
                                  'cancelled', 'no_show')),
  service     TEXT,
  notes       TEXT,

  destination     TEXT NOT NULL DEFAULT 'internal'
                    CHECK (destination IN ('internal', 'google_calendar',
                                           'jobber', 'gohighlevel')),
  -- The id the external system gave back, once an adapter exists.
  destination_ref TEXT,

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_business_date
  ON bookings (business_id, date, start_time);

CREATE INDEX IF NOT EXISTS idx_bookings_lead
  ON bookings (lead_id, created_at DESC);

-- ===========================================================================
-- follow_ups — "chase this one on Thursday".
--
-- A record of intent, not a scheduler. Nothing executes these yet and nothing
-- in this session pretends to. The dashboard shows what is due; a human acts.
-- An execution engine reads `status = 'pending' AND scheduled_for <= now`,
-- which needs no schema change to add.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS follow_ups (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,

  scheduled_for TEXT NOT NULL,   -- ISO-8601 UTC
  type          TEXT NOT NULL DEFAULT 'internal_task'
                  CHECK (type IN ('sms', 'call', 'email', 'internal_task')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'completed', 'cancelled')),
  notes         TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

-- Drives the "follow-ups due" count on the overview.
CREATE INDEX IF NOT EXISTS idx_follow_ups_due
  ON follow_ups (business_id, status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_follow_ups_lead
  ON follow_ups (lead_id, scheduled_for);

-- ===========================================================================
-- notifications — "someone just called you, here is who and what they want".
--
-- A queue, written synchronously by the call_analyzed handler so the record is
-- durable before any send is attempted. Sending is a separate, retryable step
-- (functions/lib/notify.js) precisely so a dead SMS provider can never make the
-- Retell webhook fail and trigger a re-analysis.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id     TEXT REFERENCES leads(id) ON DELETE SET NULL,
  call_id     TEXT REFERENCES calls(retell_call_id) ON DELETE SET NULL,

  channel     TEXT NOT NULL DEFAULT 'sms'
                CHECK (channel IN ('sms', 'email')),
  -- Snapshotted at queue time, not read from businesses at send time: the
  -- notification should go where the owner asked when the call happened.
  target      TEXT,
  body        TEXT NOT NULL,

  --  queued  -> waiting for a send attempt
  --  sent    -> the provider accepted it
  --  failed  -> the provider rejected it; `error` says why; retryable
  --  skipped -> there was nowhere to send it (no target, or no provider
  --             configured). NOT an error, and deliberately distinct from
  --             'failed' so "we are missing credentials" never hides inside
  --             "delivery is broken".
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications (status, created_at)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_notifications_business
  ON notifications (business_id, created_at DESC);

-- IDEMPOTENCY. call_analyzed can be delivered more than once (Retell retries a
-- failed webhook up to 3 times), and the owner must not get the same "you have
-- a new call" text three times. The queue insert is ON CONFLICT DO NOTHING
-- against this index. NULLs are distinct in SQLite, so notifications that are
-- not tied to a call are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_call_channel
  ON notifications (call_id, channel);

-- ===========================================================================
-- usage_monthly — minutes per business per billing month.
--
-- A VIEW, not a table, so it cannot disagree with `calls`. This is the "87 of
-- 120 minutes" the dashboard reads. Overage billing bolts on by reading this
-- and comparing to businesses.minutes_included — no rewrite, no backfill.
--
-- Whole minutes ROUNDED UP per month, matching how /pricing/ words the
-- allowance. Rounding the monthly total (not each call) is deliberate:
-- rounding per call would charge 60s for six 10s hangups.
-- ===========================================================================

CREATE VIEW IF NOT EXISTS usage_monthly AS
SELECT
  c.business_id                                   AS business_id,
  c.billed_month                                  AS billed_month,
  COUNT(*)                                        AS call_count,
  COALESCE(SUM(c.duration_sec), 0)                AS seconds_used,
  CAST((COALESCE(SUM(c.duration_sec), 0) + 59) / 60 AS INTEGER) AS minutes_used
FROM calls c
WHERE c.business_id IS NOT NULL
  AND c.billed_month IS NOT NULL
GROUP BY c.business_id, c.billed_month;
