/* Shug — GET / PATCH /api/leads/:id

   THE WORKHORSE ENDPOINT. Lead detail is the page a contractor actually lives
   in, and it needs the customer, every call they have made, the bookings, and
   the follow-ups all at once — so this returns all of it in one request rather
   than making the page assemble itself from four.

   Every query is scoped by the session's business_id. The lead is fetched
   first and a miss returns 404: asking for another tenant's lead id is
   indistinguishable, to the caller, from asking for one that does not exist,
   which is the point. */

import { json, fail } from '../../lib/http.js';
import { requireSession, readJson } from '../../lib/guard.js';
import { getLead, updateLead } from '../../lib/store.js';
import { listBookingsForLead, listFollowUpsForLead } from '../../lib/crm.js';

/* The lead's own calls, with the transcript included — this is the one screen
   where reading it is the point. Scoped by business_id as well as lead_id:
   belt and braces, since lead_id was already proven to belong to this tenant. */
async function callsForLead(env, businessId, leadId) {
  const result = await env.DB.prepare(
    `SELECT retell_call_id, from_number, to_number, direction, started_at, ended_at,
            duration_sec, disconnect_reason, call_successful, user_sentiment,
            summary, recording_url, transcript, analyzed_at
       FROM calls
      WHERE business_id = ? AND lead_id = ?
      ORDER BY COALESCE(started_at, created_at) DESC`
  ).bind(businessId, leadId).all();
  return (result && result.results) || [];
}

async function notificationsForLead(env, businessId, leadId) {
  const result = await env.DB.prepare(
    `SELECT id, channel, target, status, error, created_at, sent_at
       FROM notifications
      WHERE business_id = ? AND lead_id = ?
      ORDER BY created_at DESC`
  ).bind(businessId, leadId).all();
  return (result && result.results) || [];
}

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const env = context.env;
  const businessId = gate.session.business_id;
  const leadId = context.params.id;

  const lead = await getLead(env, businessId, leadId);
  if (!lead) return fail('not_found', 404);

  const [calls, bookings, followUps, notifications] = await Promise.all([
    callsForLead(env, businessId, leadId),
    listBookingsForLead(env, businessId, leadId),
    listFollowUpsForLead(env, businessId, leadId),
    notificationsForLead(env, businessId, leadId)
  ]);

  return json({
    ok: true,
    lead: lead,
    calls: calls,
    bookings: bookings,
    followUps: followUps,
    notifications: notifications
  });
}

export async function onRequestPatch(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const businessId = gate.session.business_id;
  const leadId = context.params.id;

  /* Existence AND ownership, checked before the update. updateLead's WHERE
     already carries business_id so a cross-tenant PATCH would be a harmless
     no-op — but a no-op that answered 200 would tell the caller their id was
     wrong rather than that it was not theirs. */
  const existing = await getLead(context.env, businessId, leadId);
  if (!existing) return fail('not_found', 404);

  let updated;
  try {
    updated = await updateLead(context.env, businessId, leadId, body.value);
  } catch (e) {
    if (e && e.message === 'invalid_status') return fail('invalid_status', 400);
    throw e;
  }

  return json({ ok: true, lead: updated });
}
