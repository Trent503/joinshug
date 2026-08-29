/* Shug — POST /api/leads/:id/follow-ups

   Records an intention to chase this lead. Nothing executes it — see the note
   in schema.sql. The overview surfaces what is due; a human acts.

   `scheduled_for` is an ISO-8601 instant, unlike a booking's wall-clock date
   and time. That asymmetry is deliberate: a booking is a time a human turns up
   at a house, a follow-up is a moment a future scheduler compares to now(). */

import { json, fail } from '../../../lib/http.js';
import { requireSession, readJson } from '../../../lib/guard.js';
import { getLead } from '../../../lib/store.js';
import { createFollowUp } from '../../../lib/crm.js';

export async function onRequestPost(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const businessId = gate.session.business_id;
  const leadId = context.params.id;

  const lead = await getLead(context.env, businessId, leadId);
  if (!lead) return fail('not_found', 404);

  let followUp;
  try {
    followUp = await createFollowUp(context.env, businessId, {
      lead_id: leadId,
      scheduled_for: body.value.scheduled_for,
      type: body.value.type || 'internal_task',
      status: 'pending',
      notes: body.value.notes ?? null
    });
  } catch (e) {
    const known = ['invalid_type', 'invalid_status', 'invalid_scheduled_for'];
    if (e && known.indexOf(e.message) !== -1) return fail(e.message, 400);
    throw e;
  }

  return json({ ok: true, followUp: followUp }, 201);
}
