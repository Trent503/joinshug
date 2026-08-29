/* Shug — owner notifications: "someone just called you, here is who".

   THE SHAPE OF THIS MODULE IS THE POINT.

   Queueing and sending are separate steps, and queueing is the one that runs
   inside the Retell webhook. A notification row is durable in D1 before any
   provider is contacted, so:

     * a dead or slow SMS provider can never make the webhook 5xx, which would
       make Retell retry the whole analysis;
     * a notification that failed to send is a row with status='failed' that
       can be retried, not a log line nobody reads;
     * "we have no SMS provider configured" is status='skipped' — a distinct
       state from 'failed', so a missing credential can never hide inside
       "sending is broken".

   NO SMS PROVIDER IS CONFIGURED TODAY. Nothing here signs up for one. The
   queue is complete and tested; `deliver()` dispatches to an adapter chosen by
   the SMS_PROVIDER variable, and with none set every notification lands in
   'skipped' with reason 'no_provider'. See NEEDS_CONFIG.md for exactly which
   variables turn it on.

   This module exports no onRequest* handler, so it is not routable. */

import { isoNow } from './http.js';
import { formatPhone } from './store.js';

function requireDb(env) {
  if (!env.DB) throw new Error('db_not_bound');
  return env.DB;
}

/* ---- Message body ----------------------------------------------------- */

/* Two SMS segments. Past ~320 characters a message splits again and costs more
   for information the owner will not read on a lock screen anyway. */
const MAX_BODY = 320;

/* Written to be read on a phone screen at a job site, in the two seconds
   before the owner decides whether to pull off a roof to call back. Name and
   number first, because those are what they act on; everything else is
   supporting detail and is dropped first if the message runs long. */
export function buildCallNotification(business, lead, call) {
  const parts = [];

  const who = (lead && lead.name) || 'Unknown caller';
  const number = formatPhone((lead && lead.phone) || (call && call.from_number)) || 'no number';

  parts.push('New call: ' + who + ' — ' + number);

  const service = (lead && (lead.service || lead.job_description)) || null;
  if (service) parts.push(service);

  if (lead && lead.urgency) parts.push('Urgency: ' + lead.urgency);
  if (lead && lead.preferred_time) parts.push('Wants: ' + lead.preferred_time);
  if (lead && lead.address) parts.push(lead.address);

  /* The agent's own read on how the call went. Useful precisely because it is
     not derived from the extraction — a call can capture every field and still
     have gone badly. */
  if (call && call.summary) parts.push(call.summary);

  let body = parts.join('. ').replace(/\.\./g, '.');
  const tail = ' — Shug' + (business && business.name ? ' / ' + business.name : '');

  if (body.length + tail.length > MAX_BODY) {
    body = body.slice(0, MAX_BODY - tail.length - 1).replace(/[\s.,;:—-]+$/, '') + '…';
  }

  return body + tail;
}

/* ---- Queue ------------------------------------------------------------ */

/* One row per configured channel. A business with both an SMS number and an
   email address gets one of each; a business with neither still gets a ROW,
   marked 'skipped', so the record of "this call should have told you" exists
   even when there was nowhere to send it.

   ON CONFLICT DO NOTHING against ux_notifications_call_channel makes this
   idempotent: a retried call_analyzed re-runs it and the owner is not texted
   twice about the same call.

   Returns the ids that were queued (possibly empty on a retry, which is the
   correct signal that there was nothing new to do). */
export async function queueCallNotification(env, business, lead, call) {
  const db = requireDb(env);
  const body = buildCallNotification(business, lead, call);
  const now = isoNow();

  const targets = [];
  if (business.notify_sms) targets.push({ channel: 'sms', target: business.notify_sms });
  if (business.notify_email) targets.push({ channel: 'email', target: business.notify_email });

  /* Nowhere to send it. Still recorded, still visible, explicitly not an
     error — the business simply has not told us where to reach them. */
  if (targets.length === 0) {
    targets.push({ channel: 'sms', target: null, skip: 'no_target' });
  }

  const statements = targets.map(function (t) {
    return db.prepare(
      `INSERT INTO notifications (
         id, business_id, lead_id, call_id, channel, target, body, status, error, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (call_id, channel) DO NOTHING`
    ).bind(
      crypto.randomUUID(),
      business.id,
      (lead && lead.id) || null,
      (call && call.retell_call_id) || null,
      t.channel,
      t.target,
      body,
      t.skip ? 'skipped' : 'queued',
      t.skip || null,
      now
    );
  });

  await db.batch(statements);

  return targets.length;
}

/* Replaces the body of a notification that has NOT been sent yet.

   The call lifecycle gives us two chances to tell the owner about a call, and
   they carry different quality of information. `call_ended` fires the moment
   the call drops and knows who rang and for how long. `call_analyzed` fires a
   few seconds later and knows what the caller actually wanted.

   So the webhook queues at call_ended — guaranteeing the owner is told even if
   analysis never lands — and calls this at call_analyzed to upgrade the text
   to the good version. `status = 'queued'` in the WHERE is what makes it safe:
   a notification already sent is never rewritten, so the record always matches
   what the owner actually received. */
export async function upgradeQueuedNotification(env, callId, body, leadId) {
  if (!callId) return;
  await requireDb(env).prepare(
    `UPDATE notifications
        SET body = ?2, lead_id = COALESCE(?3, lead_id)
      WHERE call_id = ?1 AND status = 'queued'`
  ).bind(callId, body, leadId || null).run();
}

export async function listPendingNotifications(env, limit) {
  const result = await requireDb(env).prepare(
    `SELECT n.*, b.notify_sms, b.notify_email
       FROM notifications n
       JOIN businesses b ON b.id = n.business_id
      WHERE n.status IN ('queued', 'failed')
        AND n.attempts < 5
      ORDER BY n.created_at ASC
      LIMIT ?`
  ).bind(Math.min(Number(limit) || 25, 200)).all();
  return (result && result.results) || [];
}

export async function markNotification(env, id, status, error) {
  await requireDb(env).prepare(
    `UPDATE notifications
        SET status   = ?2,
            error    = ?3,
            attempts = attempts + 1,
            sent_at  = CASE WHEN ?2 = 'sent' THEN ?4 ELSE sent_at END
      WHERE id = ?1`
  ).bind(id, status, error || null, isoNow()).run();
}

export async function listNotificationsForBusiness(env, businessId, limit) {
  const result = await requireDb(env).prepare(
    `SELECT * FROM notifications
      WHERE business_id = ?
      ORDER BY created_at DESC
      LIMIT ?`
  ).bind(businessId, Math.min(Number(limit) || 20, 100)).all();
  return (result && result.results) || [];
}

/* ---- Send ------------------------------------------------------------- */

/* The provider seam.

   Adding a provider is adding a function here and a case in deliver(). Nothing
   above this line changes, and nothing that CALLS this module changes. */

/* Twilio's Messages API. Written out in full so that the day credentials are
   added, sending works without another build.

   UNVERIFIED AGAINST THE LIVE API. No Twilio account exists for this project
   and none was created. The request shape below is from Twilio's documented
   REST contract; it has never been executed. Treat the first real send as the
   test. See NEEDS_CONFIG.md. */
async function sendViaTwilio(env, notification) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from) {
    return { ok: false, status: 'skipped', error: 'twilio_not_configured' };
  }

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' +
    encodeURIComponent(sid) + '/Messages.json';

  const form = new URLSearchParams();
  form.set('To', notification.target);
  form.set('From', from);
  form.set('Body', notification.body);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      /* Basic auth. btoa is fine here: the value is an auth header, not
         something being stored or logged. */
      'Authorization': 'Basic ' + btoa(sid + ':' + token),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  if (response.ok) return { ok: true, status: 'sent', error: null };

  /* Twilio's error body carries a code and a message and no credential, so it
     is safe to keep — but it is truncated and stored on the ROW, never logged,
     because the row is scoped to a tenant and the log is not. */
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch (e) {
    detail = '';
  }

  return {
    ok: false,
    status: 'failed',
    error: 'twilio_' + response.status + (detail ? ': ' + detail : '')
  };
}

/* Sends one notification and records the outcome. Never throws: a provider
   failure is a row state, not an exception for the caller to handle. */
export async function deliver(env, notification) {
  let outcome;

  try {
    if (!notification.target) {
      outcome = { ok: false, status: 'skipped', error: 'no_target' };
    } else if (notification.channel === 'sms') {
      const provider = (env.SMS_PROVIDER || '').toLowerCase();
      if (provider === 'twilio') {
        outcome = await sendViaTwilio(env, notification);
      } else {
        /* The honest default. No provider is configured, so nothing was sent,
           and the row says exactly that rather than pretending otherwise. */
        outcome = { ok: false, status: 'skipped', error: 'no_provider' };
      }
    } else if (notification.channel === 'email') {
      /* No email provider either. Cloudflare Email Routing sends INBOUND mail
         only; outbound needs a real provider. See NEEDS_CONFIG.md. */
      outcome = { ok: false, status: 'skipped', error: 'no_provider' };
    } else {
      outcome = { ok: false, status: 'failed', error: 'unknown_channel' };
    }
  } catch (e) {
    /* Network failure, DNS, provider timeout. Retryable, so 'failed' not
       'skipped'. The message is truncated and carries no credential. */
    outcome = {
      ok: false,
      status: 'failed',
      error: String((e && e.message) || 'send_failed').slice(0, 200)
    };
  }

  await markNotification(env, notification.id, outcome.status, outcome.error);
  return outcome;
}

/* Drains the queue. Called by the protected /api/admin/notifications endpoint,
   which is what a cron trigger would hit once one is added.

   Sequential, not parallel: the batch is small, and a provider rate limit is
   far more likely to be hit by 25 simultaneous requests than by 25 in a row. */
export async function drainQueue(env, limit) {
  const pending = await listPendingNotifications(env, limit);
  const counts = { sent: 0, failed: 0, skipped: 0, total: pending.length };

  for (const notification of pending) {
    const outcome = await deliver(env, notification);
    counts[outcome.status] = (counts[outcome.status] || 0) + 1;
  }

  return counts;
}
