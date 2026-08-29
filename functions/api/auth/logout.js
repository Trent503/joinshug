/* Shug — POST /api/auth/logout

   Revokes the session row, then clears the cookie. That order matters: the
   session is dead server-side even if the Set-Cookie never reaches the browser,
   which is what makes "log out" mean something on a shared or stolen device.

   Always answers 200. Logging out of a session that is already gone is the
   outcome the caller wanted. */

import { json } from '../../lib/http.js';
import { revokeSession, sessionClearCookies, requireOrigin } from '../../lib/auth.js';
import { fail } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const originProblem = requireOrigin(request);
  if (originProblem) return fail(originProblem, 403);

  await revokeSession(env, request);

  /* Both cookie names are cleared; only one is ever set, but which one depends
     on the scheme and clearing the wrong one would leave the user signed in. */
  const cookies = sessionClearCookies(request);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: headers });
}
