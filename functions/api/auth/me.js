/* Shug — GET /api/auth/me

   The dashboard's first call on every page load. Answers "am I signed in, who
   am I, and which business am I looking at" in one round trip, so a page can
   render its shell before any data arrives.

   A 401 here is the signal for the client to redirect to /app/login/. */

import { json } from '../../lib/http.js';
import { requireSession } from '../../lib/guard.js';
import { businessById } from '../../lib/store.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const session = gate.session;
  const business = await businessById(context.env, session.business_id);

  return json({
    ok: true,
    user: {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
      mustChangePassword: session.must_change_password === 1
    },
    business: business
      ? {
          id: business.id,
          name: business.name,
          phone: business.phone_e164,
          timezone: business.timezone,
          status: business.status,
          isDemo: business.is_demo === 1
        }
      : null
  });
}
