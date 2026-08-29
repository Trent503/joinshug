/* Shug — POST /api/leads/:id/bookings

   Creates a booking against a lead. There is no standalone bookings page and
   no bookings collection endpoint: a booking without a customer attached is
   not a thing this product has, and building the general case would be
   building a calendar.

   `destination` defaults to 'internal' — it lives in Shug and the owner reads
   it in /app/. That field is the seam for Google Calendar / Jobber / GHL
   later; nothing here needs to change when an adapter is added. */

import { json, fail } from '../../../lib/http.js';
import { requireSession, readJson } from '../../../lib/guard.js';
import { getLead, updateLead } from '../../../lib/store.js';
import { createBooking } from '../../../lib/crm.js';

export async function onRequestPost(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const businessId = gate.session.business_id;
  const leadId = context.params.id;

  const lead = await getLead(context.env, businessId, leadId);
  if (!lead) return fail('not_found', 404);

  let booking;
  try {
    booking = await createBooking(context.env, businessId, {
      lead_id: leadId,
      call_id: body.value.call_id ?? null,
      date: body.value.date ?? null,
      start_time: body.value.start_time ?? null,
      end_time: body.value.end_time ?? null,
      status: body.value.status || 'requested',
      service: body.value.service ?? lead.service ?? null,
      notes: body.value.notes ?? null,
      destination: body.value.destination || 'internal'
    });
  } catch (e) {
    /* createBooking throws only for validation, and every message it throws is
       a stable code safe to hand back. */
    const known = ['invalid_date', 'invalid_start_time', 'invalid_end_time',
                   'invalid_status', 'invalid_destination'];
    if (e && known.indexOf(e.message) !== -1) return fail(e.message, 400);
    throw e;
  }

  /* Booking a job IS the status change — making the owner set it separately
     would guarantee a leads list where half the booked jobs still say 'new'.
     A lead already past this point in the pipeline is left alone. */
  if (lead.status === 'new' || lead.status === 'contacted' || lead.status === 'qualified') {
    await updateLead(context.env, businessId, leadId, { status: 'booked' });
  }

  return json({ ok: true, booking: booking }, 201);
}
