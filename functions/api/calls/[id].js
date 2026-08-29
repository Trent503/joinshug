/* Shug — GET /api/calls/:id

   One call, including the transcript. Scoped by the session's business_id, so
   a call id belonging to another tenant returns 404 and not the call. */

import { json, fail } from '../../lib/http.js';
import { requireSession } from '../../lib/guard.js';
import { getCall } from '../../lib/store.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const call = await getCall(context.env, gate.session.business_id, context.params.id);
  if (!call) return fail('not_found', 404);

  return json({ ok: true, call: call });
}
