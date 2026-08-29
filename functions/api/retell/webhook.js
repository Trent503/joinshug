/* Shug — Retell call event webhook.
   POST /api/retell/webhook

   Receives every call lifecycle event and turns it into two things the
   business actually needs: a billing record and a lead.

   Events (docs.retellai.com/features/webhook):
     call_started       call is live
     call_ended         duration is final       -> this is what meters minutes
     call_analyzed      summary + extraction    -> this is what produces a lead
     transcript_updated streamed mid-call, ignored here (high volume, and the
                        final transcript arrives with call_analyzed)
     transfer_started | transfer_bridged | transfer_cancelled | transfer_ended
                        logged only, for now

   Unlike the inbound webhook, this one writes to the database, so it fails
   CLOSED: an unverified request is rejected with 401 and never reaches D1.
   A 5xx from here makes Retell retry, which is what we want — every write
   below is an idempotent upsert keyed on Retell's own call id, so a retry
   cannot double-bill a call or duplicate a lead.

   Required bindings (Pages -> Settings):
     Variables and secrets:
       RETELL_API_KEY   SECRET — the key with the webhook badge in Retell
     Bindings:
       DB               D1 database
       CONFIG_CACHE     KV namespace (used only to attribute by number)

   Note: _headers does NOT apply to Pages Functions responses. Headers are set
   in code, in functions/lib/http.js. */

import { billedMonth, isoFromMs, isoNow, json, fail } from '../../lib/http.js';
import { readVerifiedWebhook } from '../../lib/retell.js';
import { businessByNumber, upsertCall, upsertLead } from '../../lib/store.js';

/* Retell's Post Call Extraction writes `custom_analysis_data` using whatever
   field names are configured on the agent in the Retell dashboard. This maps
   the fields /agent/ promises to capture onto the aliases a reasonable person
   would have named them, so the extraction schema does not have to match this
   file byte for byte to work.

   The agent's extraction schema is the contract. If leads arrive with null
   fields, the field names configured in Retell are what to check first. */
const LEAD_FIELDS = {
  name:            ['name', 'caller_name', 'customer_name', 'contact_name', 'full_name'],
  phone:           ['phone', 'phone_number', 'callback_number', 'customer_phone', 'contact_phone'],
  address:         ['address', 'service_address', 'job_address', 'street_address', 'location'],
  job_description: ['job_description', 'job', 'issue', 'problem', 'reason_for_call', 'service_needed'],
  urgency:         ['urgency', 'urgent', 'priority', 'timeline', 'how_soon'],
  preferred_time:  ['preferred_time', 'preferred_appointment_time', 'appointment_time', 'availability', 'when']
};

/* ---- Extraction ------------------------------------------------------- */

function firstString(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;
      const text = String(value).trim();
      /* Retell substitutes an unfilled placeholder as the literal "{{key}}",
         and an unanswered extraction field often comes back as these. None of
         them are a real answer. */
      if (!text) continue;
      if (/^\{\{.*\}\}$/.test(text)) continue;
      if (/^(null|undefined|n\/a|na|unknown|not provided|none)$/i.test(text)) continue;
      return text;
    }
  }
  return null;
}

/* Reads from post-call extraction first, then from variables the agent
   collected during the call — the same fact can land in either depending on
   how the agent is built, and a lead is too valuable to drop over that. */
function extractLead(call) {
  const analysis = (call.call_analysis && call.call_analysis.custom_analysis_data) || {};
  const collected = call.collected_dynamic_variables || {};
  const sources = [analysis, collected];

  const lead = {};
  for (const field of Object.keys(LEAD_FIELDS)) {
    lead[field] = firstString(sources, LEAD_FIELDS[field]);
  }

  /* Fall back to caller ID when the caller never said their number. */
  if (!lead.phone && call.from_number) lead.phone = call.from_number;

  return lead;
}

/* A lead needs at least one fact a human could act on. A robocall that hung up
   after two seconds must not become a row someone has to triage — filtering
   spam is a thing /agent/ explicitly promises. */
function isActionableLead(lead) {
  return Boolean(lead.name || lead.address || lead.job_description);
}

/* ---- Attribution ------------------------------------------------------ */

/* metadata.business_id is set by the inbound webhook and rides along on every
   later event, so it is both faster and more correct than re-resolving: if a
   number is reassigned mid-month, historic calls stay attributed to the
   business that actually took them. Falling back to the number covers outbound
   calls and any call that started before the inbound webhook was live. */
async function attribute(env, call) {
  const fromMetadata = call.metadata && call.metadata.business_id;
  if (fromMetadata) return String(fromMetadata);

  const number = call.direction === 'outbound' ? call.from_number : call.to_number;
  if (!number) return null;

  const business = await businessByNumber(env, number);
  return business ? business.id : null;
}

/* duration_ms is only present after the call ends. Deriving it from the
   timestamps is the fallback, because this number is what gets billed. */
function durationSeconds(call) {
  const ms = Number(call.duration_ms);
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / 1000);

  const start = Number(call.start_timestamp);
  const end = Number(call.end_timestamp);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.round((end - start) / 1000);
  }
  return 0;
}

/* ---- Event handlers --------------------------------------------------- */

async function handleCallStarted(env, call, businessId) {
  await upsertCall(env, {
    retell_call_id: call.call_id,
    business_id: businessId,
    from_number: call.from_number ?? null,
    to_number: call.to_number ?? null,
    direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
    started_at: isoFromMs(call.start_timestamp) || isoNow()
  });
}

async function handleCallEnded(env, call, businessId, business) {
  const endedAt = isoFromMs(call.end_timestamp) || isoNow();

  await upsertCall(env, {
    retell_call_id: call.call_id,
    business_id: businessId,
    from_number: call.from_number ?? null,
    to_number: call.to_number ?? null,
    direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
    started_at: isoFromMs(call.start_timestamp),
    ended_at: endedAt,
    duration_sec: durationSeconds(call),
    /* Billed to the month the business was in when the call ENDED, in its own
       timezone. See schema.sql. */
    billed_month: billedMonth(endedAt, business && business.timezone),
    disconnect_reason: call.disconnection_reason ?? null
  });
}

async function handleCallAnalyzed(env, call, businessId) {
  const analysis = call.call_analysis || {};

  await upsertCall(env, {
    retell_call_id: call.call_id,
    business_id: businessId,
    duration_sec: durationSeconds(call),
    call_successful: typeof analysis.call_successful === 'boolean'
      ? (analysis.call_successful ? 1 : 0)
      : null,
    user_sentiment: analysis.user_sentiment ?? null,
    summary: analysis.call_summary ?? null,
    recording_url: call.recording_url ?? null,
    transcript: call.transcript ?? null,
    analyzed_at: isoNow()
  });

  /* Voicemail is not a lead. Retell detects it; trust that over the extraction,
     which will happily pull a name out of an outgoing greeting. */
  if (analysis.in_voicemail === true) {
    console.log('retell/webhook: ' + call.call_id + ' was voicemail — no lead');
    return;
  }

  const lead = extractLead(call);
  if (!isActionableLead(lead)) {
    console.log('retell/webhook: ' + call.call_id + ' produced no actionable lead');
    return;
  }

  await upsertLead(env, {
    id: crypto.randomUUID(),
    retell_call_id: call.call_id,
    business_id: businessId,
    name: lead.name,
    phone: lead.phone,
    address: lead.address,
    job_description: lead.job_description,
    urgency: lead.urgency,
    preferred_time: lead.preferred_time
  });

  /* Delivery to the business's booking destination is deliberately NOT done
     here. The lead is durable in D1 the moment this returns, with
     delivery_status='pending'; a failing Jobber or GHL call must never make
     this webhook 5xx and cause Retell to retry the whole analysis. The
     delivery adapter reads pending leads and marks them via
     markLeadDelivery(). */
  console.log('retell/webhook: lead captured from ' + call.call_id +
    ' for business ' + (businessId || 'unattributed'));
}

/* ---- Handler ---------------------------------------------------------- */

export async function onRequestPost(context) {
  const env = context.env;

  /* Fails closed: no valid signature, no database write. */
  const result = await readVerifiedWebhook(context.request, env.RETELL_API_KEY);
  if (!result.ok) return fail(result.code, result.status);

  const event = result.body.event;
  const call = result.body.call;

  if (!event) return fail('missing_event', 400);

  /* Chat events and transcript_updated share this endpoint but need no work.
     Acknowledged so Retell does not retry them. */
  if (event === 'transcript_updated') return json({ ok: true, ignored: event }, 200);

  if (event.startsWith('transfer_')) {
    console.log('retell/webhook: ' + event +
      ' on ' + ((call && call.call_id) || 'unknown call'));
    return json({ ok: true, ignored: event }, 200);
  }

  if (!call || !call.call_id) return fail('missing_call', 400);

  try {
    const businessId = await attribute(env, call);

    /* Needed only for its timezone, and only when a month is being stamped. */
    let business = null;
    if (event === 'call_ended') {
      const number = call.direction === 'outbound' ? call.from_number : call.to_number;
      business = number ? await businessByNumber(env, number) : null;
    }

    if (event === 'call_started') {
      await handleCallStarted(env, call, businessId);
    } else if (event === 'call_ended') {
      await handleCallEnded(env, call, businessId, business);
    } else if (event === 'call_analyzed') {
      await handleCallAnalyzed(env, call, businessId);
    } else {
      return json({ ok: true, ignored: event }, 200);
    }

    return json({ ok: true }, 200);
  } catch (e) {
    /* 5xx on purpose: Retell retries, and every write above is idempotent, so
       a retry repairs the record rather than corrupting it. Never log the call
       body — it carries the transcript. */
    console.error('retell/webhook: ' + event + ' failed for ' + call.call_id +
      ': ' + ((e && e.message) || 'unknown failure'));
    return fail('processing_failed', 500);
  }
}

export async function onRequestGet() {
  return json({ ok: true, endpoint: 'retell-events', method: 'POST' }, 200);
}
