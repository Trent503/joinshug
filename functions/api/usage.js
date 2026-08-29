/* Shug — GET /api/usage

   "87 of 120 minutes." The number the dashboard shows and the number a future
   billing job will read, from the same query, so they cannot disagree.

   Derived live from SUM(calls.duration_sec) over the indexed
   (business_id, billed_month) — never a stored counter. See schema.sql.

   ?month=YYYY-MM returns a past period. Omitted, it returns the business's
   current billing month in ITS OWN timezone: a call at 5pm on the 31st in
   Portland is 01:00 UTC on the 1st, and billing it to the wrong month would be
   wrong on the only two days a month anyone checks.

   OVERAGE. This endpoint reports `overage` and `overageMinutes` but no money.
   Attaching a rate here would put pricing in a display endpoint; when overage
   billing is built it reads these same fields and applies the rate at the
   billing boundary, with no change to anything below. */

import { json, fail, isoNow } from '../lib/http.js';
import { requireSession } from '../lib/guard.js';
import { businessById, minutesUsed, usageSummary } from '../lib/store.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const env = context.env;
  const business = await businessById(env, gate.session.business_id);
  if (!business) return fail('business_not_found', 404);

  const requestedMonth = new URL(context.request.url).searchParams.get('month');

  if (requestedMonth) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)) {
      return fail('invalid_month', 400);
    }

    const used = await minutesUsed(env, business.id, requestedMonth);
    const included = Number(business.minutes_included) || 0;

    return json({
      ok: true,
      usage: {
        month: requestedMonth,
        secondsUsed: used.seconds,
        minutesUsed: used.minutes,
        minutesIncluded: included,
        minutesRemaining: Math.max(0, included - used.minutes),
        percentUsed: included > 0
          ? Math.min(100, Math.round((used.minutes / included) * 100))
          : 0,
        overage: used.minutes > included,
        overageMinutes: Math.max(0, used.minutes - included)
      }
    });
  }

  return json({ ok: true, usage: await usageSummary(env, business, isoNow()) });
}
