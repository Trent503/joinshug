/* Shug — POST /api/auth/login

   Exchanges an email and password for a session cookie.

   Deliberately returns the SAME error for an unknown address and a wrong
   password, and deliberately spends the same CPU on both — see attemptLogin()
   in functions/lib/auth.js. A login form that distinguishes the two is an
   account-enumeration oracle, and knowing which addresses have accounts is
   most of the work of a credential-stuffing run. */

import { json, fail } from '../../lib/http.js';
import { readJson } from '../../lib/guard.js';
import { attemptLogin, createSession, sessionSetCookie, requireOrigin } from '../../lib/auth.js';
import { businessById } from '../../lib/store.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  /* Login is a state-changing POST that sets a cookie, so it gets the same
     origin check as everything else. It runs before the KDF so a cross-site
     attempt costs nothing. */
  const originProblem = requireOrigin(request);
  if (originProblem) return fail(originProblem, 403);

  const body = await readJson(request);
  if (body.response) return body.response;

  const result = await attemptLogin(env, body.value.email, body.value.password);

  if (!result.ok) {
    /* 423 Locked is distinguishable from 401 on purpose: it tells the user
       something they can act on ("wait 15 minutes") and is not an enumeration
       leak, because reaching it already required eight failed guesses against
       an address someone knew. */
    const status = result.error === 'account_locked' ? 423 : 401;
    return fail(result.error, status);
  }

  const session = await createSession(env, result.user, request);
  const business = await businessById(env, result.user.business_id);

  return json({
    ok: true,
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
      mustChangePassword: result.user.must_change_password === 1
    },
    business: business ? { id: business.id, name: business.name } : null
  }, 200, {
    'Set-Cookie': sessionSetCookie(request, session.token, session.expiresAt)
  });
}
