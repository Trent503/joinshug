/* Shug — Retell call event webhook.
   POST /api/retell/webhook

   Receives every call lifecycle event and turns it into the four things the
   business actually needs: a billing record, a lead, a booking when the caller
   asked for one, and a notification telling the owner it happened.

   Events (docs.retellai.com/features/webhook):
     call_started       call is live
     call_ended         duration is final    -> meters minutes, queues the
                                                owner notification
     call_analyzed      summary + extraction -> produces the lead, upgrades the
                                                notification body
     transcript_updated streamed mid-call, ignored here (high volume, and the
                        final transcript arrives with call_analyzed)
     transfer_started | transfer_bridged | transfer_cancelled | transfer_ended
                        logged only, for now

   Unlike the inbound webhook, this one writes to the database, so it fails
   CLOSED: an unverified request is rejected with 401 and never reaches D1.
   A 5xx from here makes Retell retry, which is what we want — every write
   below is an idempotent upsert keyed on Retell's own call id, so a retry
   repairs the record rather than duplicating it.

   Required bindings:
     RETELL_API_KEY   SECRET — the key with the webhook badge in Retell
     DB               D1 database
     CONFIG_CACHE     KV namespace (used only to attribute by number)

   Note: _headers does NOT apply to worker responses. Headers are set in code,
   in functions/lib/http.js. */

import { billedMonth, isoFromMs, isoNow, json, fail } from '../../lib/http.js';
import { readVerifiedWebhook } from '../../lib/retell.js';
import {
  businessByNumber, businessById, upsertCall, upsertLeadByPhone,
  attachCallToLead, getLead, markLeadDelivery
} from '../../lib/store.js';
import { createBooking } from '../../lib/crm.js';
import { queueCallNotification, upgradeQueuedNotification, buildCallNotification } from '../../lib/notify.js';

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
  email:           ['email', 'email_address', 'customer_email', 'contact_email'],
  address:         ['address', 'service_address', 'job_address', 'street_address', 'location'],
  service:         ['service', 'service_type', 'job_type', 'service_requested', 'trade_service'],
  job_description: ['job_description', 'job', 'issue', 'problem', 'reason_for_call', 'service_needed'],
  urgency:         ['urgency', 'urgent', 'priority', 'timeline', 'how_soon'],
  preferred_time:  ['preferred_time', 'preferred_appointment_time', 'appointment_time', 'availability', 'when']
};

/* Booking capture is separate from lead capture because it has a much higher
   bar: a lead field can be a phrase, but a booking needs a real calendar date
   or it is not a booking. See maybeBooking(). */
const BOOKING_FIELDS = {
  date:  ['appointment_date', 'booking_date', 'scheduled_date', 'visit_date'],
  start: ['appointment_start_time', 'appointment_time', 'booking_time', 'scheduled_time', 'visit_time'],
  end:   ['appointment_end_time', 'booking_end_time'],
  confirmed: ['appointment_confirmed', 'booking_confirmed', 'appointment_booked']
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
         and an unanswered extraction field often comes back as one of these.
         None of them are a real answer. */
      if (!text) continue;
      if (/^\{\{.*\}\}$/.test(text)) continue;
      if (/^(null|undefined|n\/a|na|unknown|not provided|none|not specified)$/i.test(text)) continue;
      return text;
    }
  }
  return null;
}

function analysisSources(call) {
  const analysis = (call.call_analysis && call.call_analysis.custom_analysis_data) || {};
  const collected = call.collected_dynamic_variables || {};
  /* Post-call extraction first, then variables the agent collected during the
     call — the same fact can land in either depending on how the agent is
     built, and a lead is too valuable to drop over that. */
  return [analysis, collected];
}

function extractLead(call) {
  const sources = analysisSources(call);

  const lead = {};
  for (const field of Object.keys(LEAD_FIELDS)) {
    lead[field] = firstString(sources, LEAD_FIELDS[field]);
  }

  /* Fall back to caller ID when the caller never said their number. This is
     also the dedupe key, so it matters more than it looks: without it, every
     repeat caller who does not recite their number becomes a new lead. */
  if (!lead.phone && call.from_number) lead.phone = call.from_number;

  return lead;
}

/* A lead needs at least one fact a human could act on. A robocall that hung up
   after two seconds must not become a row someone has to triage — filtering
   spam is a thing /agent/ explicitly promises.

   A phone number alone does NOT qualify: caller ID gives us one for every call
   including wrong numbers, so treating it as sufficient would make every
   misdial a lead. */
function isActionableLead(lead) {
  return Boolean(lead.name || lead.address || lead.job_description || lead.service);
}

/* ---- Bookings --------------------------------------------------------- */

/* Only creates a booking when the agent captured a REAL calendar date.

   "Tuesday", "next week", and "whenever you're free" are all useful and are
   all kept — on the lead's preferred_time, where the owner reads them. They
   are not bookings, and inventing a date for them would put wrong appointments
   on a contractor's schedule, which is worse than putting none there. */
function maybeBooking(call) {
  const sources = analysisSources(call);

  const rawDate = firstString(sources, BOOKING_FIELDS.date);
  if (!rawDate) return null;

  /* Accept ISO 'YYYY-MM-DD', optionally with a time component the agent
     appended. Anything else is not a date we are willing to act on. */
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate.trim());
  if (!match) return null;

  const date = match[1];
  /* Rejects 2026-13-45 — the regex above only proves the shape. */
  const parsed = new Date(date + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return null;
  }

  function normalizeTime(value) {
    if (!value) return null;
    const t = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
    if (!t) return null;
    const hour = Number(t[1]);
    const minute = Number(t[2]);
    if (hour > 23 || minute > 59) return null;
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  const confirmedRaw = firstString(sources, BOOKING_FIELDS.confirmed);
  const confirmed = confirmedRaw !== null && /^(true|yes|y|1|confirmed)$/i.test(confirmedRaw);

  return {
    date: date,
    start_time: normalizeTime(firstString(sources, BOOKING_FIELDS.start)),
    end_time: normalizeTime(firstString(sources, BOOKING_FIELDS.end)),
    /* 'confirmed' only when the agent explicitly says so. Everything else is a
       REQUEST, which is the honest default: the agent taking a preference is
       not the same as the contractor agreeing to be there. */
    status: confirmed ? 'confirmed' : 'requested'
  };
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

  /* Queue the notification HERE, not only at call_analyzed.

     call_analyzed is where the good content is, but it is a second event that
     may be delayed or, if analysis fails, never arrive at all. A contractor
     not being told about a call is the failure that costs them a job, so the
     owner is told at the moment the call ends and the text is upgraded a few
     seconds later when the analysis lands. The unique index on
     (call_id, channel) makes both paths idempotent — nobody gets two texts. */
  if (business) {
    await queueCallNotification(env, business, null, {
      retell_call_id: call.call_id,
      from_number: call.from_number ?? null
    });
  }
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

  if (!businessId) {
    console.warn('retell/webhook: ' + call.call_id + ' is unattributed — call stored, no lead');
    return;
  }

  const extracted = extractLead(call);
  if (!isActionableLead(extracted)) {
    console.log('retell/webhook: ' + call.call_id + ' produced no actionable lead');
    return;
  }

  /* THE DEDUPE. Keyed on (business_id, normalised phone), so the third call
     from the same customer updates the lead they already are rather than
     creating a third row. See upsertLeadByPhone in store.js. */
  const leadId = await upsertLeadByPhone(env, {
    business_id: businessId,
    name: extracted.name,
    phone: extracted.phone,
    email: extracted.email,
    address: extracted.address,
    service: extracted.service,
    job_description: extracted.job_description,
    urgency: extracted.urgency,
    preferred_time: extracted.preferred_time,
    source: 'call'
  });

  /* Points the call at the lead and recomputes the lead's call rollup from the
     calls table — a retry recomputes the same numbers rather than inflating
     them. */
  await attachCallToLead(env, call.call_id, leadId);

  const business = await businessById(env, businessId);
  const lead = await getLead(env, businessId, leadId);

  /* A booking, but only when a real calendar date was captured. */
  const booking = maybeBooking(call);
  if (booking) {
    try {
      /* Idempotent by hand rather than by constraint: a unique index on
         (call_id) would be wrong — one call can legitimately book two visits —
         so the retry guard is "did THIS call already produce a booking". */
      const existing = await env.DB.prepare(
        'SELECT id FROM bookings WHERE business_id = ? AND call_id = ? LIMIT 1'
      ).bind(businessId, call.call_id).first();

      if (!existing) {
        await createBooking(env, businessId, {
          lead_id: leadId,
          call_id: call.call_id,
          date: booking.date,
          start_time: booking.start_time,
          end_time: booking.end_time,
          status: booking.status,
          service: extracted.service || extracted.job_description || null,
          notes: analysis.call_summary || null,
          destination: (business && business.booking_destination) || 'internal'
        });
        console.log('retell/webhook: booking ' + booking.status + ' for ' + call.call_id);
      }
    } catch (e) {
      /* A booking that fails validation must not lose the LEAD. The date is
         still on the lead's preferred_time and the owner can act on it. */
      console.warn('retell/webhook: booking not created for ' + call.call_id +
        ': ' + ((e && e.message) || 'unknown'));
    }
  }

  /* Upgrade the notification queued at call_ended to the version that knows
     who called and what they wanted. Only rewrites rows still 'queued', so a
     notification already sent is never retroactively changed. */
  if (business && lead) {
    const body = buildCallNotification(business, lead, {
      retell_call_id: call.call_id,
      from_number: call.from_number,
      summary: analysis.call_summary
    });
    await upgradeQueuedNotification(env, call.call_id, body, leadId);
  }

  /* Delivery to an EXTERNAL booking destination is deliberately not done here.
     The lead is durable in D1 the moment this returns; a failing Jobber or GHL
     call must never make this webhook 5xx and cause Retell to retry the whole
     analysis. For an 'internal' business there is nowhere to deliver to, and
     'skipped' says that honestly rather than leaving the row 'pending'
     forever against a delivery that is never coming. */
  if (business && business.booking_destination === 'internal') {
    await markLeadDelivery(env, leadId, 'skipped', { error: 'internal_destination' });
  }

  console.log('retell/webhook: lead ' + leadId + ' from ' + call.call_id +
    ' for business ' + businessId);
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

  if (typeof event === 'string' && event.startsWith('transfer_')) {
    console.log('retell/webhook: ' + event +
      ' on ' + ((call && call.call_id) || 'unknown call'));
    return json({ ok: true, ignored: event }, 200);
  }

  if (!call || !call.call_id) return fail('missing_call', 400);

  try {
    const businessId = await attribute(env, call);

    if (event === 'call_started') {
      await handleCallStarted(env, call, businessId);
    } else if (event === 'call_ended') {
      /* Needed for its timezone (to stamp the billing month) and for its
         notification targets. Fetched by id rather than by number so a call
         attributed via metadata resolves even if the number has since moved. */
      const business = businessId ? await businessById(env, businessId) : null;
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
