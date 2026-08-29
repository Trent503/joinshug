/* Shug — GET /api/overview

   Everything /app/ renders above the fold, in one request. The dashboard makes
   exactly one call for this page rather than six, because six sequential
   round trips to the edge is the difference between a page that feels instant
   and one that visibly assembles itself.

   All "this month" / "today" boundaries are computed in the BUSINESS's
   timezone, so the lead count, the call count and the minutes figure sitting
   next to each other on screen all cover the same period. */

import { json, fail, isoNow, localDate, monthStartUtc } from '../lib/http.js';
import { requireSession } from '../lib/guard.js';
import { businessById, usageSummary, listLeads } from '../lib/store.js';
import { overviewCounts, recentActivity, listUpcomingBookings, listDueFollowUps } from '../lib/crm.js';

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const env = context.env;
  const businessId = gate.session.business_id;

  const business = await businessById(env, businessId);
  /* The session join already proved the business exists, so this is a
     "deleted between two queries" case rather than a missing tenant. */
  if (!business) return fail('business_not_found', 404);

  const now = isoNow();
  const todayLocal = localDate(now, business.timezone);
  const monthStart = monthStartUtc(business.timezone, now);

  const [counts, usage, activity, bookings, followUps, newLeads] = await Promise.all([
    overviewCounts(env, businessId, monthStart, now, todayLocal),
    usageSummary(env, business, now),
    recentActivity(env, businessId, 12),
    listUpcomingBookings(env, businessId, todayLocal, 6),
    listDueFollowUps(env, businessId, now, 6),
    listLeads(env, businessId, { status: 'new', limit: 6 })
  ]);

  return json({
    ok: true,
    business: {
      id: business.id,
      name: business.name,
      phone: business.phone_e164,
      timezone: business.timezone,
      status: business.status,
      isDemo: business.is_demo === 1
    },
    today: todayLocal,
    counts: counts,
    usage: usage,
    newLeads: newLeads,
    bookings: bookings,
    followUps: followUps,
    activity: activity
  });
}
