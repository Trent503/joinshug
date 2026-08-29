/* Shug — data access for the AI receptionist.

   Every read and write of business config, calls, and leads goes through here,
   so the storage split is decided in one file:

     D1 (env.DB)            source of truth. Anything queried or aggregated:
                            businesses, calls, leads, minute totals.
     KV (env.CONFIG_CACHE)  read-through cache for number -> business only.
                            The inbound-call webhook has a 10-second budget and
                            is on the path of every ringing phone; KV is single
                            digit ms at the edge where D1 is tens.

   KV is a cache here and nothing else. It is never written to as a source of
   truth, so a cold or wiped namespace costs latency, never correctness.

   This module exports no onRequest* handler, so Pages adds no route for it. */

import { billedMonth, isoNow } from './http.js';

const CACHE_PREFIX = 'number:';
const CACHE_TTL_SECONDS = 300;

/* KV's minimum expirationTtl is 60s; anything lower is rejected outright. 300s
   bounds how long a config edit can take to reach live calls. bustNumberCache()
   is the immediate path — this is only the backstop. */

/* ---- Phone numbers ---------------------------------------------------- */

/* Retell sends E.164 ("+15033768729"). Normalising both sides of the lookup
   means a business row entered as "(503) 376-8729" still resolves instead of
   silently never matching — which would present as "the agent answers with
   default config" rather than as an error, and is the single easiest way for
   this system to be quietly broken in production. */
export function normalizeE164(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');

  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10) return '+1' + bare;            // US, no country code
  if (bare.length === 11 && bare.startsWith('1')) return '+' + bare;
  return '+' + bare;
}

/* ---- Businesses ------------------------------------------------------- */

function requireDb(env) {
  if (!env.DB) {
    console.error('store: D1 binding DB is not bound to this Pages project');
    throw new Error('db_not_bound');
  }
  return env.DB;
}

async function businessByNumberFromDb(env, e164) {
  const row = await requireDb(env)
    .prepare('SELECT * FROM businesses WHERE phone_e164 = ? LIMIT 1')
    .bind(e164)
    .first();
  return row || null;
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
           wrong-number or scanner hitting the webhook cannot make D1 the
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
       retell_call_id, business_id, from_number, to_number, direction,
       started_at, ended_at, duration_sec, billed_month,
       disconnect_reason, call_successful, user_sentiment, summary,
       recording_url, transcript, analyzed_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       business_id       = COALESCE(excluded.business_id,       calls.business_id),
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

/* ---- Leads ------------------------------------------------------------ */

/* Upsert keyed on retell_call_id (UNIQUE), so a webhook retry updates the
   lead it already created instead of inserting a second one.

   Delivery state is deliberately NOT touched on conflict: re-running analysis
   must never reset a lead that has already been delivered back to 'pending'
   and cause a duplicate booking on the customer's side. */
export async function upsertLead(env, lead) {
  const db = requireDb(env);

  await db.prepare(
    `INSERT INTO leads (
       id, retell_call_id, business_id, name, phone, address,
       job_description, urgency, preferred_time, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       name            = COALESCE(excluded.name,            leads.name),
       phone           = COALESCE(excluded.phone,           leads.phone),
       address         = COALESCE(excluded.address,         leads.address),
       job_description = COALESCE(excluded.job_description, leads.job_description),
       urgency         = COALESCE(excluded.urgency,         leads.urgency),
       preferred_time  = COALESCE(excluded.preferred_time,  leads.preferred_time),
       updated_at      = excluded.updated_at`
  ).bind(
    lead.id,
    lead.retell_call_id,
    lead.business_id ?? null,
    lead.name ?? null,
    lead.phone ?? null,
    lead.address ?? null,
    lead.job_description ?? null,
    lead.urgency ?? null,
    lead.preferred_time ?? null,
    isoNow()
  ).run();
}

export async function markLeadDelivery(env, retellCallId, status, detail) {
  await requireDb(env).prepare(
    `UPDATE leads
        SET delivery_status = ?2,
            delivery_error  = ?3,
            booking_ref     = COALESCE(?4, booking_ref),
            delivered_at    = CASE WHEN ?2 = 'sent' THEN ?5 ELSE delivered_at END,
            updated_at      = ?5
      WHERE retell_call_id = ?1`
  ).bind(
    retellCallId,
    status,
    (detail && detail.error) ?? null,
    (detail && detail.bookingRef) ?? null,
    isoNow()
  ).run();
}

/* ---- Metering --------------------------------------------------------- */

/* Derived, never stored — see schema.sql. Returns whole minutes rounded up,
   which is how the 120-minute allowance on /agent/ and /pricing/ is worded. */
export async function minutesUsed(env, businessId, month) {
  const row = await requireDb(env).prepare(
    'SELECT COALESCE(SUM(duration_sec), 0) AS seconds FROM calls WHERE business_id = ? AND billed_month = ?'
  ).bind(businessId, month).first();

  const seconds = (row && Number(row.seconds)) || 0;
  return Math.ceil(seconds / 60);
}

export async function usageSummary(env, business, atIso) {
  const month = billedMonth(atIso, business.timezone);
  const used = await minutesUsed(env, business.id, month);
  const included = Number(business.minutes_included) || 0;

  return {
    month: month,
    minutesUsed: used,
    minutesIncluded: included,
    minutesRemaining: Math.max(0, included - used),
    overage: used > included
  };
}
