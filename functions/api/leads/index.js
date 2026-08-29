/* Shug — GET / POST /api/leads

   GET lists this business's leads, newest activity first. Supports ?status=,
   ?q=, ?limit=, ?offset=.

   POST creates one by hand — the contractor who took a call on their mobile
   and wants it in the same list as everything the agent captured. It goes
   through the SAME upsert as the webhook, so typing in a number that has
   called before updates that lead instead of creating a twin. */

import { json, fail } from '../../lib/http.js';
import { requireSession, readJson } from '../../lib/guard.js';
import { listLeads, countLeads, upsertLeadByPhone, getLead, LEAD_STATUSES } from '../../lib/store.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const params = new URL(context.request.url).searchParams;
  const status = params.get('status');

  if (status && LEAD_STATUSES.indexOf(status) === -1) {
    return fail('invalid_status', 400);
  }

  const businessId = gate.session.business_id;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  const [leads, total] = await Promise.all([
    listLeads(context.env, businessId, {
      status: status || null,
      q: params.get('q') || null,
      limit: limit,
      offset: offset
    }),
    countLeads(context.env, businessId)
  ]);

  return json({
    ok: true,
    leads: leads,
    total: total,
    limit: limit,
    offset: offset,
    statuses: LEAD_STATUSES
  });
}

export async function onRequestPost(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const value = body.value;

  /* A lead with neither a name nor a number is not something anyone can act
     on, and creating it only adds a row to triage later. */
  if (!value.name && !value.phone) return fail('name_or_phone_required', 400);

  if (value.status && LEAD_STATUSES.indexOf(value.status) === -1) {
    return fail('invalid_status', 400);
  }

  /* business_id is taken from the session, NOT from the body. A body field of
     that name is ignored entirely — this is the one place a client could try
     to write into another tenant, and the value it would need simply is not
     read from anything it controls. */
  const leadId = await upsertLeadByPhone(context.env, {
    business_id: gate.session.business_id,
    name: value.name ?? null,
    phone: value.phone ?? null,
    email: value.email ?? null,
    address: value.address ?? null,
    service: value.service ?? null,
    job_description: value.job_description ?? null,
    urgency: value.urgency ?? null,
    preferred_time: value.preferred_time ?? null,
    notes: value.notes ?? null,
    source: 'manual',
    status: value.status || 'new'
  });

  const lead = await getLead(context.env, gate.session.business_id, leadId);
  return json({ ok: true, lead: lead }, 201);
}
