/* Shug — GET /api/calls

   The call log. Every call the agent took, newest first, with its duration,
   its summary, and the lead it produced.

   The transcript is NOT in this response. It is the largest column in the
   database and nothing on a list view renders it; including it would move
   megabytes to draw twenty rows. GET /api/calls/:id returns it. */

import { json } from '../../lib/http.js';
import { requireSession } from '../../lib/guard.js';
import { listCalls, countCalls } from '../../lib/store.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const params = new URL(context.request.url).searchParams;
  const businessId = gate.session.business_id;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  const [calls, total] = await Promise.all([
    listCalls(context.env, businessId, { limit: limit, offset: offset }),
    countCalls(context.env, businessId)
  ]);

  return json({ ok: true, calls: calls, total: total, limit: limit, offset: offset });
}
