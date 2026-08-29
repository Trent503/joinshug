/* Shug — the gate every dashboard endpoint goes through.

   Exists so that "is this request allowed, and whose data is it" is answered in
   ONE place. A handler either calls requireSession() and gets a business_id, or
   it has no business_id to query with. There is no third path where a handler
   authorises itself slightly differently and gets it slightly wrong.

   This module exports no onRequest* handler, so it is not routable. */

import { fail } from './http.js';
import { sessionFromRequest, touchSession, requireOrigin } from './auth.js';

/* Returns { session } on success, or { response } to return immediately.

   Callers use it as:

     const gate = await requireSession(context);
     if (gate.response) return gate.response;
     const businessId = gate.session.business_id;

   business_id comes off the SESSION ROW. It is never read from the query
   string, the body, or a header, anywhere in this codebase. */
export async function requireSession(context) {
  const { request, env } = context;

  /* CSRF, checked before anything touches the database. SameSite=Lax already
     stops the cross-site POST; this is the independent second check. */
  const originProblem = requireOrigin(request);
  if (originProblem) return { response: fail(originProblem, 403) };

  let session;
  try {
    session = await sessionFromRequest(env, request);
  } catch (e) {
    console.error('guard: session lookup failed: ' + ((e && e.message) || 'unknown'));
    return { response: fail('internal_error', 500) };
  }

  /* 401, not 403: the client has no valid identity, and the dashboard's
     response is to send the user to /app/login/. A 403 would mean "we know who
     you are and the answer is still no", which is a different fix. */
  if (!session) return { response: fail('unauthenticated', 401) };

  /* A suspended business is a billing state, not a security one. Reading is
     still allowed — the owner must be able to see their own data and their own
     invoice — but nothing may be written. */
  if (session.business_status === 'suspended') {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return { response: fail('account_suspended', 402) };
    }
  }

  /* Fire-and-forget: a failed last_seen update must never fail the request it
     is annotating. */
  if (context.waitUntil) context.waitUntil(touchSession(env, session.session_id));

  return { session: session };
}

/* Bearer-token gate for /api/admin/*.

   A separate mechanism from the session on purpose. Provisioning happens on a
   sales call, before the customer has a login — there is no session to
   authorise it with, and giving one tenant's session the power to create
   another tenant would be exactly the privilege escalation the rest of this
   file exists to prevent.

   Fails CLOSED when ADMIN_TOKEN is unset: an unconfigured secret must never
   mean "no check". */
export async function requireAdmin(context) {
  const { request, env } = context;

  const expected = env.ADMIN_TOKEN;
  if (!expected) {
    console.error('guard: ADMIN_TOKEN is not configured — refusing admin request');
    return { response: fail('not_configured', 503) };
  }

  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { response: fail('unauthorized', 401) };

  const provided = match[1];

  /* Compare SHA-256 digests, not the tokens.

     Two things fall out of that. The comparison is over two fixed 32-byte
     values, so it is constant time in the inputs AND leaks nothing about the
     expected token's LENGTH — which a byte-wise compare of unequal strings
     always does. And a plain === on the tokens would return at the first
     differing byte, handing back, one request at a time, how much of the token
     an attacker has guessed correctly. */
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);

  const a = new Uint8Array(providedDigest);
  const b = new Uint8Array(expectedDigest);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];

  if (diff !== 0) return { response: fail('unauthorized', 401) };

  return { ok: true };
}

/* Body parsing that cannot throw into a handler.

   Returns { value } or { response }. A malformed body is the client's problem
   and gets a 400; it is never allowed to become a 500. The 64KB ceiling is
   there because nothing this API accepts is legitimately larger, and an
   unbounded JSON.parse on the edge is a cheap way to burn CPU. */
const MAX_BODY_BYTES = 64 * 1024;

export async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (type && !/^application\/json\b/i.test(type.trim())) {
    return { response: fail('expected_json', 415) };
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { response: fail('body_too_large', 413) };
  }

  let text;
  try {
    text = await request.text();
  } catch (e) {
    return { response: fail('unreadable_body', 400) };
  }

  /* content-length can be absent (chunked) or wrong. Check what actually
     arrived, not what was claimed. */
  if (text.length > MAX_BODY_BYTES) {
    return { response: fail('body_too_large', 413) };
  }

  if (!text.trim()) return { value: {} };

  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { response: fail('malformed_json', 400) };
  }

  /* A JSON body that is a string, a number, or an array is not a patch, and
     letting one through would mean every handler has to re-check. Arrays are
     excluded explicitly because typeof [] === 'object'. */
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { response: fail('expected_object', 400) };
  }

  return { value: value };
}
