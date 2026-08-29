/* Shug — data access for businesses, phone numbers, calls, and leads.

   Every read and write of those four goes through here, so the storage split is
   decided in exactly one file:

     D1 (env.DB)            source of truth. Anything queried or aggregated.
     KV (env.CONFIG_CACHE)  read-through cache for number -> business ONLY.
                            The inbound-call webhook has a 10-second budget and
                            is on the path of every ringing phone; KV is single
                            digit ms at the edge where D1 is tens.

   KV is a cache here and nothing else. It is never written as a source of
   truth, so a cold or wiped namespace costs latency, never correctness.

   TENANCY: every function below that touches a business-owned row takes
   businessId as its FIRST argument and puts it in the WHERE clause. There is
   deliberately no "get lead by id" that does not also check the business — a
   caller cannot forget to scope a query if the unscoped version does not exist.

   Bookings, follow-ups and notifications live in crm.js and notify.js.
   This module exports no onRequest* handler, so it is not routable. */

import { billedMonth, isoNow } from './http.js';
/* auth.js imports only http.js, so this cannot create a cycle. The email
   normaliser lives there because that is where an email is a credential; it is
   reused here so a notification address entered through Settings is stored in
   exactly the same shape as one entered at provisioning time. */
import { normalizeEmail } from './auth.js';

const CACHE_PREFIX = 'number:';
const CACHE_TTL_SECONDS = 300;

/* KV's minimum expirationTtl is 60s; anything lower is rejected outright. 300s
   bounds how long a config edit can take to reach live calls. bustNumberCache()
   is the immediate path — this is only the backstop. */

/* ---- Phone numbers ---------------------------------------------------- */

/* Retell sends E.164 ("+15033768729"). Normalising both sides of every lookup
   and every write means a number entered as "(503) 376-8729" still resolves
   instead of silently never matching — which would present as "the agent
   answers with default config", not as an error, and is the single easiest way
   for this system to be quietly broken in production.

   This is also the lead dedupe key, so it has a second job: two spellings of
   the same caller's number must produce the same string, or a repeat customer
   becomes two leads. */
export function normalizeE164(value) {
  if (!value) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  /* Anonymous / blocked caller ID arrives as a word, not a number. Returning
     null here (rather than "+") is what routes those to a per-call lead
     instead of collapsing every withheld-number caller into one. */
  if (/^(anonymous|unknown|private|restricted|blocked|unavailable)$/i.test(trimmed)) {
    return null;
  }

  const hasPlus = trimmed.charAt(0) === '+';
  const bare = trimmed.replace(/\D/g, '');
  if (!bare) return null;

  if (hasPlus) return '+' + bare;
  if (bare.length === 10) return '+1' + bare;             // US, no country code
  if (bare.length === 11 && bare.charAt(0) === '1') return '+' + bare;
  return '+' + bare;
}

/* Display form for the dashboard: +15033768729 -> (503) 376-8729.
   Anything that is not a NANP number is shown as-is — inventing a format for a
   number we do not understand is worse than showing the raw E.164. */
export function formatPhone(e164) {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164));
  if (!m) return String(e164);
  return '(' + m[1] + ') ' + m[2] + '-' + m[3];
}

/* ---- Businesses ------------------------------------------------------- */

function requireDb(env) {
  if (!env.DB) {
    console.error('store: D1 binding DB is not bound to this worker');
    throw new Error('db_not_bound');
  }
  return env.DB;
}

/* Resolution order is phone_numbers first, then businesses.phone_e164.

   phone_numbers is the routing table and is authoritative — it is where a
   second number for an existing customer goes. businesses.phone_e164 is the
   fallback so a business row created before its routing row (or by hand)
   still answers its own phone. Provisioning writes both, so in practice the
   first query hits. */
async function businessByNumberFromDb(env, e164) {
  const db = requireDb(env);

  const routed = await db.prepare(
    `SELECT b.* FROM phone_numbers p
       JOIN businesses b ON b.id = p.business_id
      WHERE p.e164 = ? AND p.status = 'active'
      LIMIT 1`
  ).bind(e164).first();
  if (routed) return routed;

  const direct = await db.prepare(
    'SELECT * FROM businesses WHERE phone_e164 = ? LIMIT 1'
  ).bind(e164).first();

  return direct || null;
}

/* Read-through cache. A miss, a cold namespace, or an unparseable entry all
   fall through to D1 — the cache can never make a lookup fail, only slow. */
export async function businessByNumber(env, rawNumber) {
  const e164 = normalizeE164(rawNumber);
  if (!e164) return null;

  const cacheKey = CACHE_PREFIX + e164;

  if (env.CONFIG_CACHE) {
    try {
      const cached = await env.CONFIG_CACHE.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        /* A negative entry — the number is not ours. Cached deliberately so a
           wrong-number or a scanner hitting the webhook cannot make D1 the
           bottleneck. */
        return parsed && parsed.__miss ? null : parsed;
      }
    } catch (e) {
      console.warn('store: config cache read failed, falling through to D1');
    }
  }

  const business = await businessByNumberFromDb(env, e164);

  if (env.CONFIG_CACHE) {
    try {
      await env.CONFIG_CACHE.put(
        cacheKey,
        JSON.stringify(business || { __miss: true }),
        { expirationTtl: CACHE_TTL_SECONDS }
      );
    } catch (e) {
      console.warn('store: config cache write failed');
    }
  }

  return business;
}

/* Call after editing a business record so the change reaches live calls
   immediately instead of after the TTL. */
export async function bustNumberCache(env, rawNumber) {
  const e164 = normalizeE164(rawNumber);
  if (!e164 || !env.CONFIG_CACHE) return;
  try {
    await env.CONFIG_CACHE.delete(CACHE_PREFIX + e164);
  } catch (e) {
    console.warn('store: config cache delete failed');
  }
}

export async function businessById(env, id) {
  if (!id) return null;
  const row = await requireDb(env)
    .prepare('SELECT * FROM businesses WHERE id = ? LIMIT 1')
    .bind(id)
    .first();
  return row || null;
}

/* The only fields /app/settings/ is allowed to change. Anything not on this
   list is ignored rather than rejected, so a future field on the form cannot
   accidentally become writable by being added to the request body. */
const BUSINESS_WRITABLE = [
  'name', 'timezone', 'trade', 'services_offered', 'services_declined',
  'service_area', 'service_area_notes', 'hours', 'greeting', 'tone',
  'urgency_rules', 'transfer_number', 'notify_sms', 'notify_email'
];

export async function updateBusiness(env, businessId, patch) {
  const sets = [];
  const values = [];

  for (const field of BUSINESS_WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    let value = patch[field];
    if (typeof value === 'string') value = value.trim();
    if (value === '') value = null;

    /* Both of these are dialled or messaged by the system, so they are stored
       in the one format everything else expects. */
    if (field === 'transfer_number' || field === 'notify_sms') {
      value = normalizeE164(value);
    }

    /* Same shape as provisioning writes: lower-cased and trimmed. An address
       that does not normalise is REJECTED rather than stored as null —
       silently blanking a notification target is how an owner stops being told
       about calls without ever being told why. */
    if (field === 'notify_email' && value !== null) {
      const normalized = normalizeEmail(value);
      if (!normalized) throw new Error('invalid_email');
      value = normalized;
    }

    sets.push(field + ' = ?');
    values.push(value);
  }

  if (sets.length === 0) return businessById(env, businessId);

  sets.push('updated_at = ?');
  values.push(isoNow());
  values.push(businessId);

  await requireDb(env)
    .prepare('UPDATE businesses SET ' + sets.join(', ') + ' WHERE id = ?')
    .bind(...values)
    .run();

  const updated = await businessById(env, businessId);
  /* The agent reads this config on every call through the KV cache. An edit
     the owner just made must be audible on the next call, not five minutes
     later. */
  if (updated) await bustNumberCache(env, updated.phone_e164);
  return updated;
}

/* ---- Calls ------------------------------------------------------------ */

/* One upsert for every call webhook event.

   Idempotent by construction: the primary key is Retell's own call id, and
   COALESCE(excluded.x, calls.x) means a later event can only ADD facts. That
   matters because the events are not ordered — a retried call_ended can arrive
   after call_analyzed, and must not blank the summary the analysis wrote.

   Callers pass only the fields their event actually knows; everything else is
   left null and preserved. */
export async function upsertCall(env, call) {
  const db = requireDb(env);

  await db.prepare(
    `INSERT INTO calls (
       retell_call_id, business_id, lead_id, from_number, to_number, direction,
       started_at, ended_at, duration_sec, billed_month,
       disconnect_reason, call_successful, user_sentiment, summary,
       recording_url, transcript, analyzed_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       business_id       = COALESCE(excluded.business_id,       calls.business_id),
       lead_id           = COALESCE(excluded.lead_id,           calls.lead_id),
       from_number       = COALESCE(excluded.from_number,       calls.from_number),
       to_number         = COALESCE(excluded.to_number,         calls.to_number),
       direction         = COALESCE(excluded.direction,         calls.direction),
       started_at        = COALESCE(excluded.started_at,        calls.started_at),
       ended_at          = COALESCE(excluded.ended_at,          calls.ended_at),
       duration_sec      = MAX(excluded.duration_sec,           calls.duration_sec),
       billed_month      = COALESCE(excluded.billed_month,      calls.billed_month),
       disconnect_reason = COALESCE(excluded.disconnect_reason, calls.disconnect_reason),
       call_successful   = COALESCE(excluded.call_successful,   calls.call_successful),
       user_sentiment    = COALESCE(excluded.user_sentiment,    calls.user_sentiment),
       summary           = COALESCE(excluded.summary,           calls.summary),
       recording_url     = COALESCE(excluded.recording_url,     calls.recording_url),
       transcript        = COALESCE(excluded.transcript,        calls.transcript),
       analyzed_at       = COALESCE(excluded.analyzed_at,       calls.analyzed_at),
       updated_at        = excluded.updated_at`
  ).bind(
    call.retell_call_id,
    call.business_id ?? null,
    call.lead_id ?? null,
    call.from_number ?? null,
    call.to_number ?? null,
    call.direction ?? null,
    call.started_at ?? null,
    call.ended_at ?? null,
    /* MAX() above compares against this, so it must be a number, not null. */
    Number.isFinite(call.duration_sec) ? call.duration_sec : 0,
    call.billed_month ?? null,
    call.disconnect_reason ?? null,
    call.call_successful ?? null,
    call.user_sentiment ?? null,
    call.summary ?? null,
    call.recording_url ?? null,
    call.transcript ?? null,
    call.analyzed_at ?? null,
    isoNow()
  ).run();
}

/* Points a call at its lead and RECOMPUTES the lead's call rollup from the
   calls table.

   Recomputing rather than incrementing is the whole point: a webhook retry
   runs this again, and `call_count = call_count + 1` would inflate on every
   retry. A COUNT(*) over the calls that actually exist cannot drift, for the
   same reason minutes are a SUM and not a counter. */
export async function attachCallToLead(env, retellCallId, leadId) {
  const db = requireDb(env);
  const now = isoNow();

  await db.batch([
    db.prepare('UPDATE calls SET lead_id = ?2, updated_at = ?3 WHERE retell_call_id = ?1')
      .bind(retellCallId, leadId, now),

    db.prepare(
      `UPDATE leads SET
         call_count    = (SELECT COUNT(*) FROM calls WHERE lead_id = leads.id),
         first_call_id = (SELECT retell_call_id FROM calls WHERE lead_id = leads.id
                           ORDER BY COALESCE(started_at, created_at) ASC  LIMIT 1),
         last_call_id  = (SELECT retell_call_id FROM calls WHERE lead_id = leads.id
                           ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1),
         last_call_at  = (SELECT MAX(COALESCE(started_at, created_at)) FROM calls WHERE lead_id = leads.id),
         updated_at    = ?2
       WHERE id = ?1`
    ).bind(leadId, now)
  ]);
}

export async function getCall(env, businessId, retellCallId) {
  const row = await requireDb(env).prepare(
    `SELECT c.*, l.name AS lead_name, l.status AS lead_status
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.retell_call_id = ? AND c.business_id = ?
      LIMIT 1`
  ).bind(retellCallId, businessId).first();
  return row || null;
}

/* The transcript is deliberately excluded from the LIST query. It is the
   largest column in the database and nothing on a list view renders it;
   selecting it would move megabytes to draw a table of twenty rows. */
export async function listCalls(env, businessId, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const result = await requireDb(env).prepare(
    `SELECT c.retell_call_id, c.business_id, c.lead_id, c.from_number, c.to_number,
            c.direction, c.started_at, c.ended_at, c.duration_sec, c.billed_month,
            c.disconnect_reason, c.call_successful, c.user_sentiment, c.summary,
            c.recording_url, c.analyzed_at, c.created_at,
            l.name AS lead_name, l.status AS lead_status
       FROM calls c
       LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.business_id = ?
      ORDER BY COALESCE(c.started_at, c.created_at) DESC
      LIMIT ? OFFSET ?`
  ).bind(businessId, limit, offset).all();

  return (result && result.results) || [];
}

export async function countCalls(env, businessId) {
  const row = await requireDb(env)
    .prepare('SELECT COUNT(*) AS n FROM calls WHERE business_id = ?')
    .bind(businessId).first();
  return (row && Number(row.n)) || 0;
}

/* ---- Leads ------------------------------------------------------------ */

/* THE DEDUPE PATH. Upsert keyed on (business_id, phone).

   A repeat caller updates the lead they already are. Three rules make that
   behave the way a contractor expects:

   1. COALESCE(excluded.x, leads.x) — a new call can FILL a blank field but
      never blanks one. The agent failing to re-ask for an address must not
      erase the address we already had.

   2. `status` is never touched by a webhook, with one exception: a lead in a
      TERMINAL state ('completed' or 'lost') that calls again is a new job, so
      it goes back to 'new' and reappears at the top of the owner's list.
      A lead mid-pipeline ('contacted', 'qualified', 'booked') keeps its status
      — the owner's judgement outranks the robot's.

   3. `notes` and delivery state are never touched. Notes are the owner's.
      Resetting delivery to 'pending' on a repeat call would re-deliver a lead
      that was already sent and cause a duplicate job on the customer's side.

   A caller with withheld caller ID normalises to phone = NULL. SQLite treats
   NULLs as distinct in a UNIQUE index, so those correctly become one lead per
   call rather than every anonymous caller collapsing into a single row.

   Returns the lead id. */
export async function upsertLeadByPhone(env, lead) {
  const db = requireDb(env);
  const phone = normalizeE164(lead.phone);
  const now = isoNow();
  const newId = lead.id || crypto.randomUUID();

  const row = await db.prepare(
    `INSERT INTO leads (
       id, business_id, name, phone, email, address, service, job_description,
       urgency, preferred_time, source, status, notes, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
     ON CONFLICT (business_id, phone) DO UPDATE SET
       name            = COALESCE(excluded.name,            leads.name),
       email           = COALESCE(excluded.email,           leads.email),
       address         = COALESCE(excluded.address,         leads.address),
       service         = COALESCE(excluded.service,         leads.service),
       job_description = COALESCE(excluded.job_description, leads.job_description),
       urgency         = COALESCE(excluded.urgency,         leads.urgency),
       preferred_time  = COALESCE(excluded.preferred_time,  leads.preferred_time),
       status          = CASE WHEN leads.status IN ('completed', 'lost')
                              THEN 'new' ELSE leads.status END,
       updated_at      = excluded.updated_at
     RETURNING id`
  ).bind(
    newId,
    lead.business_id,
    lead.name ?? null,
    phone,
    lead.email ?? null,
    lead.address ?? null,
    lead.service ?? null,
    lead.job_description ?? null,
    lead.urgency ?? null,
    lead.preferred_time ?? null,
    lead.source || 'call',
    lead.status || 'new',
    lead.notes ?? null,
    now
  ).first();

  return (row && row.id) || newId;
}

export const LEAD_STATUSES = [
  'new', 'contacted', 'qualified', 'booked', 'completed', 'lost'
];

/* Scoped by business_id, always. There is no unscoped variant to reach for. */
export async function getLead(env, businessId, leadId) {
  const row = await requireDb(env)
    .prepare('SELECT * FROM leads WHERE id = ? AND business_id = ? LIMIT 1')
    .bind(leadId, businessId)
    .first();
  return row || null;
}

export async function listLeads(env, businessId, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const where = ['business_id = ?'];
  const values = [businessId];

  if (opts.status && LEAD_STATUSES.indexOf(opts.status) !== -1) {
    where.push('status = ?');
    values.push(opts.status);
  }

  if (opts.q) {
    /* LIKE with bound parameters — the search text is never concatenated into
       SQL. Escaping %, _ and the escape character itself keeps a search for
       "50%" from matching every row. One bind per column rather than a reused
       numbered parameter, so the positional ordering stays trivially correct. */
    const needle = '%' + String(opts.q).replace(/[%_\\]/g, '\\$&') + '%';
    where.push(
      "(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' " +
      "OR service LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\')"
    );
    values.push(needle, needle, needle, needle);
  }

  values.push(limit, offset);

  const result = await requireDb(env).prepare(
    `SELECT * FROM leads
      WHERE ` + where.join(' AND ') + `
      ORDER BY COALESCE(last_call_at, created_at) DESC
      LIMIT ? OFFSET ?`
  ).bind(...values).all();

  return (result && result.results) || [];
}

export async function countLeads(env, businessId) {
  const row = await requireDb(env)
    .prepare('SELECT COUNT(*) AS n FROM leads WHERE business_id = ?')
    .bind(businessId).first();
  return (row && Number(row.n)) || 0;
}

/* What a human at the dashboard may change. Webhook-owned rollup columns
   (call_count, last_call_id, delivery_*) are deliberately absent. */
const LEAD_WRITABLE = [
  'name', 'phone', 'email', 'address', 'service',
  'job_description', 'urgency', 'preferred_time', 'status', 'notes'
];

export async function updateLead(env, businessId, leadId, patch) {
  const sets = [];
  const values = [];

  for (const field of LEAD_WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    let value = patch[field];
    if (typeof value === 'string') value = value.trim();
    if (value === '') value = null;

    if (field === 'status') {
      if (LEAD_STATUSES.indexOf(value) === -1) {
        throw new Error('invalid_status');
      }
    }
    if (field === 'phone') value = normalizeE164(value);

    sets.push(field + ' = ?');
    values.push(value);
  }

  if (sets.length === 0) return getLead(env, businessId, leadId);

  sets.push('updated_at = ?');
  values.push(isoNow(), leadId, businessId);

  /* business_id in the WHERE is the tenant check. An UPDATE that matches no
     row changes nothing, so a cross-tenant id is a silent no-op here and the
     caller's subsequent getLead() returns null — which is the 404 the API
     surfaces. */
  await requireDb(env).prepare(
    'UPDATE leads SET ' + sets.join(', ') + ' WHERE id = ? AND business_id = ?'
  ).bind(...values).run();

  return getLead(env, businessId, leadId);
}

export async function markLeadDelivery(env, leadId, status, detail) {
  await requireDb(env).prepare(
    `UPDATE leads
        SET delivery_status = ?2,
            delivery_error  = ?3,
            booking_ref     = COALESCE(?4, booking_ref),
            delivered_at    = CASE WHEN ?2 = 'sent' THEN ?5 ELSE delivered_at END,
            updated_at      = ?5
      WHERE id = ?1`
  ).bind(
    leadId,
    status,
    (detail && detail.error) ?? null,
    (detail && detail.bookingRef) ?? null,
    isoNow()
  ).run();
}

/* ---- Metering --------------------------------------------------------- */

/* Derived, never stored — see schema.sql.

   Whole minutes rounded UP over the month's total seconds, which is how the
   120-minute allowance is worded on /agent/ and /pricing/. Rounding the total
   rather than each call is deliberate: per-call rounding would bill a full
   minute for each of six ten-second hangups. */
export async function minutesUsed(env, businessId, month) {
  const row = await requireDb(env).prepare(
    'SELECT COALESCE(SUM(duration_sec), 0) AS seconds FROM calls WHERE business_id = ? AND billed_month = ?'
  ).bind(businessId, month).first();

  const seconds = (row && Number(row.seconds)) || 0;
  return { seconds: seconds, minutes: Math.ceil(seconds / 60) };
}

export async function usageSummary(env, business, atIso) {
  const month = billedMonth(atIso, business.timezone);
  const used = await minutesUsed(env, business.id, month);
  const included = Number(business.minutes_included) || 0;

  return {
    month: month,
    secondsUsed: used.seconds,
    minutesUsed: used.minutes,
    minutesIncluded: included,
    minutesRemaining: Math.max(0, included - used.minutes),
    /* Guarded against a business row with minutes_included = 0, which would
       otherwise make this Infinity and render as "Infinity%" on the dashboard. */
    percentUsed: included > 0
      ? Math.min(100, Math.round((used.minutes / included) * 100))
      : 0,
    overage: used.minutes > included,
    overageMinutes: Math.max(0, used.minutes - included)
  };
}
