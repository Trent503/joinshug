/* Shug — PATCH /api/follow-ups/:id

   Tick it off, reschedule it, or drop it. Rendered inside lead detail and on
   the overview's "due" list; no page of its own.

   completed_at is derived from status inside updateFollowUp rather than
   accepted from the client, so the two can never disagree. */

import { json, fail } from '../../lib/http.js';
import { requireSession, readJson } from '../../lib/guard.js';
import { getFollowUp, updateFollowUp } from '../../lib/crm.js';

export async function onRequestPatch(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const businessId = gate.session.business_id;
  const id = context.params.id;

  const existing = await getFollowUp(context.env, businessId, id);
  if (!existing) return fail('not_found', 404);

  let followUp;
  try {
    followUp = await updateFollowUp(context.env, businessId, id, body.value);
  } catch (e) {
    const known = ['invalid_type', 'invalid_status', 'invalid_scheduled_for'];
    if (e && known.indexOf(e.message) !== -1) return fail(e.message, 400);
    throw e;
  }

  return json({ ok: true, followUp: followUp });
}
