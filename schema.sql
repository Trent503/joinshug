-- Shug — D1 schema for the AI receptionist.
--
-- Apply with:
--   wrangler d1 execute shug --local  --file=./schema.sql   (local dev)
--   wrangler d1 execute shug --remote --file=./schema.sql   (production)
--
-- Design notes that are not obvious from the DDL:
--
-- * One row per business in `businesses`. Today that is one row (the demo
--   line). The product sells per-business configuration, so the $198 setup is
--   modelled as a record here rather than as manual work in the Retell
--   dashboard. A second customer is an INSERT, not a re-configuration.
--
-- * Minute usage is DERIVED from `calls`, never stored as a running total.
--   A counter column would need read-modify-write and two concurrent calls
--   ending at once would lose an increment. `SUM(duration_sec)` over an
--   indexed (business_id, billed_month) cannot drift.
--
-- * `calls.retell_call_id` is the primary key so webhook delivery is
--   idempotent. Retell retries a failed webhook up to 3 times; every write
--   path below is an upsert keyed on it, so a retry cannot double-bill a call
--   or duplicate a lead.
--
-- * No secrets live in this database. API keys and OAuth tokens are Pages
--   secrets and KV respectively.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- businesses — what the $198 setup call actually produces.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS businesses (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,

  -- The Retell number that rings for this business, E.164. This is the join
  -- key for the inbound-call webhook: Retell hands us `to_number` and this is
  -- how we know whose business is being called. UNIQUE because two businesses
  -- sharing a number would make that resolution ambiguous.
  phone_e164          TEXT NOT NULL UNIQUE,

  -- IANA zone, e.g. 'America/Los_Angeles'. Needed to answer "are you open
  -- right now" correctly; the edge runs in UTC and the caller does not.
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

  -- Where a booking should land. `booking_destination` is the adapter name
  -- ('email', 'sms', 'jobber', 'gohighlevel'); `booking_config` is JSON read
  -- only by that adapter. Adding a CRM adds a value here, not a schema change.
  booking_destination TEXT NOT NULL DEFAULT 'email',
  booking_config      TEXT NOT NULL DEFAULT '{}',

  -- Billing. 120 minutes is what /agent/ and /pricing/ promise for $99.
  minutes_included    INTEGER NOT NULL DEFAULT 120,

  -- 'active' answers calls. 'suspended' is the hook for non-payment: the
  -- inbound webhook can reject rather than answer a call we will not bill for.
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'setup')),

  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- calls — one row per Retell call. The billing record and the lead's parent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS calls (
  retell_call_id  TEXT PRIMARY KEY,
  business_id     TEXT REFERENCES businesses(id) ON DELETE SET NULL,

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

-- ---------------------------------------------------------------------------
-- leads — what the call was actually worth.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leads (
  id              TEXT PRIMARY KEY,

  -- UNIQUE, not just a reference: one call produces at most one lead, so a
  -- webhook retry re-runs the upsert instead of inserting a duplicate lead.
  retell_call_id  TEXT NOT NULL UNIQUE
                    REFERENCES calls(retell_call_id) ON DELETE CASCADE,
  business_id     TEXT REFERENCES businesses(id) ON DELETE SET NULL,

  -- The fields /agent/ promises are captured "in the same order every time".
  name            TEXT,
  phone           TEXT,
  address         TEXT,
  job_description TEXT,
  urgency         TEXT,
  preferred_time  TEXT,

  -- Delivery to the business's booking destination, tracked separately from
  -- capture: a lead we captured but failed to deliver is the one failure mode
  -- that loses a customer their job, so it must be queryable.
  delivery_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'skipped')),
  delivery_error  TEXT,
  delivered_at    TEXT,
  booking_ref     TEXT,   -- id returned by Jobber/GHL once those adapters exist

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_business
  ON leads (business_id, created_at DESC);

-- Finds leads that still need delivering, for a retry sweep.
CREATE INDEX IF NOT EXISTS idx_leads_undelivered
  ON leads (delivery_status, created_at)
  WHERE delivery_status IN ('pending', 'failed');
