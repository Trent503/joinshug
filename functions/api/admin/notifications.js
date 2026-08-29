/* Shug — GET / POST /api/admin/notifications

   The queue drain. GET reports what is waiting; POST attempts to send it.

   Separate from the Retell webhook on purpose: a provider outage must never be
   able to fail the webhook and make Retell retry a whole call analysis. The
   webhook's only job is to make the notification durable; this is what tries
   to deliver it, and it can be run again as often as needed.

   This is the endpoint a Cloudflare Cron Trigger would call once one is added.
   Until then it is run by hand — which is honest, because with no SMS provider
   configured there is currently nothing for it to send. Every notification
   comes back 'skipped' with reason 'no_provider'. See NEEDS_CONFIG.md. */

import { json } from '../../lib/http.js';
import { requireAdmin } from '../../lib/guard.js';
import { listPendingNotifications, drainQueue } from '../../lib/notify.js';

export async function onRequestGet(context) {
  const gate = await requireAdmin(context);
  if (gate.response) return gate.response;

  const pending = await listPendingNotifications(context.env, 50);

  /* Targets are redacted. This endpoint is for checking that the queue is
     moving, and a queue-health check does not need to print every customer's
     phone number. */
  return json({
    ok: true,
    pending: pending.length,
    notifications: pending.map(function (n) {
      return {
        id: n.id,
        business_id: n.business_id,
        channel: n.channel,
        hasTarget: Boolean(n.target),
        status: n.status,
        error: n.error,
        attempts: n.attempts,
        created_at: n.created_at
      };
    })
  });
}

export async function onRequestPost(context) {
  const gate = await requireAdmin(context);
  if (gate.response) return gate.response;

  const limit = Number(new URL(context.request.url).searchParams.get('limit')) || 25;
  const counts = await drainQueue(context.env, limit);

  return json({ ok: true, drained: counts });
}
