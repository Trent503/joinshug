/* Shug — POST /api/auth/password

   Changes the signed-in user's password.

   Requires the CURRENT password even though the caller already holds a valid
   session. That is what stops someone who walked up to an unlocked laptop from
   locking the owner out of their own account.

   On success every OTHER session for that user is revoked, so a session
   obtained with the old password does not outlive it. The caller's own session
   survives — signing someone out of the tab they just used to change their
   password is a bug, not a security feature. */

import { json, fail } from '../../lib/http.js';
import { requireSession, readJson } from '../../lib/guard.js';
import {
  findUserByEmail, verifyPassword, setUserPassword,
  passwordProblem, revokeAllSessionsForUser
} from '../../lib/auth.js';

export async function onRequestPost(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const { currentPassword, newPassword } = body.value;

  const problem = passwordProblem(newPassword);
  if (problem) return fail(problem, 400);

  const user = await findUserByEmail(context.env, gate.session.email);
  if (!user) return fail('unauthenticated', 401);

  const valid = await verifyPassword(currentPassword, user);
  if (!valid) return fail('invalid_credentials', 401);

  await setUserPassword(context.env, user.id, newPassword);
  await revokeAllSessionsForUser(context.env, user.id, gate.session.session_id);

  return json({ ok: true });
}
