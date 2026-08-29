/* Shug — PATCH /api/bookings/:id

   Confirm it, move it, cancel it, mark it done. Rendered inside lead detail —
   there is no bookings page and this endpoint is not a collection.

   No GET: a booking is only ever read as part of its lead, and an endpoint
   that exists but nothing calls is an endpoint nobody keeps correct. */

import { json, fail } from '../../lib/http.js';
import { requireSession, readJson } from '../../lib/guard.js';
import { getBooking, updateBooking } from '../../lib/crm.js';
import { updateLead, getLead } from '../../lib/store.js';

export async function onRequestPatch(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const businessId = gate.session.business_id;
  const id = context.params.id;

  const existing = await getBooking(context.env, businessId, id);
  if (!existing) return fail('not_found', 404);

  let booking;
  try {
    booking = await updateBooking(context.env, businessId, id, body.value);
  } catch (e) {
    const known = ['invalid_date', 'invalid_start_time', 'invalid_end_time',
                   'invalid_status', 'invalid_destination'];
    if (e && known.indexOf(e.message) !== -1) return fail(e.message, 400);
    throw e;
  }

  /* Finishing the job finishes the lead. Only from 'booked', so this cannot
     overwrite an owner who has already moved the lead somewhere deliberate. */
  if (booking && booking.status === 'completed' && existing.lead_id) {
    const lead = await getLead(context.env, businessId, existing.lead_id);
    if (lead && lead.status === 'booked') {
      await updateLead(context.env, businessId, existing.lead_id, { status: 'completed' });
    }
  }

  return json({ ok: true, booking: booking });
}
