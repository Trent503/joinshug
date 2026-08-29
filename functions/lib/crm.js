/* Shug — bookings, follow-ups, and the dashboard's aggregate reads.

   SCOPE NOTE. Shug is not becoming a calendar product or a CRM. There is no
   availability model, no conflict detection, no recurrence, and no scheduler.
   A booking is "the caller asked for Tuesday at 2" written down where the owner
   will see it; a follow-up is "chase this one on Thursday" written down the
   same way. Both render inside the lead detail page and on the overview, and
   neither has a page of its own. Everything here exists to make the receptionist
   useful, not to become the thing the receptionist feeds.

   TENANCY: as in store.js, every function takes businessId first and every
   statement carries `business_id = ?`. Nothing here accepts a business id from
   a request body.

   This module exports no onRequest* handler, so it is not routable. */

import { isoNow } from './http.js';

function requireDb(env) {
  if (!env.DB) throw new Error('db_not_bound');
  return env.DB;
}

/* ---- Bookings --------------------------------------------------------- */

export const BOOKING_STATUSES = [
  'requested', 'confirmed', 'completed', 'cancelled', 'no_show'
];

/* The seam that keeps Google Calendar / Jobber / GoHighLevel from ever
   requiring a change to the receptionist. Today everything is 'internal'. */
export const BOOKING_DESTINATIONS = [
  'internal', 'google_calendar', 'jobber', 'gohighlevel'
];

/* Wall-clock validation only. `date` and the times are the BUSINESS's local
   clock, exactly as the caller and the owner say them out loud — deliberately
   not converted to UTC. Converting would mean a booking silently moves when
   someone edits the business timezone, which is worse than the ambiguity it
   would fix. */
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function validTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function createBooking(env, businessId, booking) {
  const db = requireDb(env);
  const now = isoNow();
  const id = booking.id || crypto.randomUUID();

  if (booking.date && !validDate(booking.date)) throw new Error('invalid_date');
  if (booking.start_time && !validTime(booking.start_time)) throw new Error('invalid_start_time');
  if (booking.end_time && !validTime(booking.end_time)) throw new Error('invalid_end_time');

  const status = booking.status || 'requested';
  if (BOOKING_STATUSES.indexOf(status) === -1) throw new Error('invalid_status');

  const destination = booking.destination || 'internal';
  if (BOOKING_DESTINATIONS.indexOf(destination) === -1) throw new Error('invalid_destination');

  await db.prepare(
    `INSERT INTO bookings (
       id, business_id, lead_id, call_id, date, start_time, end_time,
       status, service, notes, destination, destination_ref, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`
  ).bind(
    id,
    businessId,
    booking.lead_id ?? null,
    booking.call_id ?? null,
    booking.date ?? null,
    booking.start_time ?? null,
    booking.end_time ?? null,
    status,
    booking.service ?? null,
    booking.notes ?? null,
    destination,
    booking.destination_ref ?? null,
    now
  ).run();

  return getBooking(env, businessId, id);
}

export async function getBooking(env, businessId, id) {
  const row = await requireDb(env)
    .prepare('SELECT * FROM bookings WHERE id = ? AND business_id = ? LIMIT 1')
    .bind(id, businessId).first();
  return row || null;
}

export async function listBookingsForLead(env, businessId, leadId) {
  const result = await requireDb(env).prepare(
    `SELECT * FROM bookings
      WHERE business_id = ? AND lead_id = ?
      ORDER BY COALESCE(date, '9999-12-31') ASC, COALESCE(start_time, '99:99') ASC`
  ).bind(businessId, leadId).all();
  return (result && result.results) || [];
}

/* Drives the overview's "booked appointments" list. `fromDate` is a
   business-local 'YYYY-MM-DD'; the caller computes it in the business's
   timezone so "today" means the owner's today. */
export async function listUpcomingBookings(env, businessId, fromDate, limit) {
  const result = await requireDb(env).prepare(
    `SELECT b.*, l.name AS lead_name, l.phone AS lead_phone
       FROM bookings b
       LEFT JOIN leads l ON l.id = b.lead_id
      WHERE b.business_id = ?
        AND b.status IN ('requested', 'confirmed')
        AND (b.date IS NULL OR b.date >= ?)
      ORDER BY COALESCE(b.date, '9999-12-31') ASC, COALESCE(b.start_time, '99:99') ASC
      LIMIT ?`
  ).bind(businessId, fromDate, Math.min(Number(limit) || 10, 100)).all();
  return (result && result.results) || [];
}

const BOOKING_WRITABLE = [
  'date', 'start_time', 'end_time', 'status', 'service', 'notes', 'destination'
];

export async function updateBooking(env, businessId, id, patch) {
  const sets = [];
  const values = [];

  for (const field of BOOKING_WRITABLE) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    let value = patch[field];
    if (typeof value === 'string') value = value.trim();
    if (value === '') value = null;

    if (field === 'status' && BOOKING_STATUSES.indexOf(value) === -1) {
      throw new Error('invalid_status');
    }
    if (field === 'destination' && BOOKING_DESTINATIONS.indexOf(value) === -1) {
      throw new Error('invalid_destination');
    }
    if (field === 'date' && value !== null && !validDate(value)) {
      throw new Error('invalid_date');
    }
    if ((field === 'start_time' || field === 'end_time') && value !== null && !validTime(value)) {
      throw new Error('invalid_' + field);
    }

    sets.push(field + ' = ?');
    values.push(value);
  }

  if (sets.length === 0) return getBooking(env, businessId, id);

  sets.push('updated_at = ?');
  values.push(isoNow(), id, businessId);

  await requireDb(env).prepare(
    'UPDATE bookings SET ' + sets.join(', ') + ' WHERE id = ? AND business_id = ?'
  ).bind(...values).run();

  return getBooking(env, businessId, id);
}

/* ---- Follow-ups ------------------------------------------------------- */

export const FOLLOW_UP_TYPES = ['sms', 'call', 'email', 'internal_task'];
export const FOLLOW_UP_STATUSES = ['pending', 'completed', 'cancelled'];

export async function createFollowUp(env, businessId, followUp) {
  const db = requireDb(env);
  const id = followUp.id || crypto.randomUUID();

  const type = followUp.type || 'internal_task';
  if (FOLLOW_UP_TYPES.indexOf(type) === -1) throw new Error('invalid_type');

  const status = followUp.status || 'pending';
  if (FOLLOW_UP_STATUSES.indexOf(status) === -1) throw new Error('invalid_status');

  /* scheduled_for is ISO-8601 UTC — unlike a booking, this one IS an instant,
     because whatever eventually executes follow-ups will compare it to now(). */
  const scheduledFor = followUp.scheduled_for;
  if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) {
    throw new Error('invalid_scheduled_for');
  }

  await db.prepare(
    `INSERT INTO follow_ups (
       id, business_id, lead_id, scheduled_for, type, status, notes, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(
    id, businessId, followUp.lead_id ?? null,
    scheduledFor, type, status, followUp.notes ?? null, isoNow()
  ).run();

  return getFollowUp(env, businessId, id);
}

export async function getFollowUp(env, businessId, id) {
  const row = await requireDb(env)
    .prepare('SELECT * FROM follow_ups WHERE id = ? AND business_id = ? LIMIT 1')
    .bind(id, businessId).first();
  return row || null;
}

export async function listFollowUpsForLead(env, businessId, leadId) {
  const result = await requireDb(env).prepare(
    `SELECT * FROM follow_ups
      WHERE business_id = ? AND lead_id = ?
      ORDER BY scheduled_for ASC`
  ).bind(businessId, leadId).all();
  return (result && result.results) || [];
}

/* "Follow-ups due" on the overview: pending AND already scheduled for a moment
   that has passed. A follow-up scheduled for next week is not due and must not
   be counted, or the badge becomes noise the owner learns to ignore. */
export async function listDueFollowUps(env, businessId, nowIso, limit) {
  const result = await requireDb(env).prepare(
    `SELECT f.*, l.name AS lead_name, l.phone AS lead_phone
       FROM follow_ups f
       LEFT JOIN leads l ON l.id = f.lead_id
      WHERE f.business_id = ? AND f.status = 'pending' AND f.scheduled_for <= ?
      ORDER BY f.scheduled_for ASC
      LIMIT ?`
  ).bind(businessId, nowIso, Math.min(Number(limit) || 10, 100)).all();
  return (result && result.results) || [];
}

export async function updateFollowUp(env, businessId, id, patch) {
  const sets = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    if (FOLLOW_UP_STATUSES.indexOf(patch.status) === -1) throw new Error('invalid_status');
    sets.push('status = ?');
    values.push(patch.status);
    /* completed_at is derived from status rather than accepted from the
       client, so the two can never disagree. */
    sets.push('completed_at = ?');
    values.push(patch.status === 'completed' ? isoNow() : null);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'scheduled_for')) {
    if (Number.isNaN(new Date(patch.scheduled_for).getTime())) {
      throw new Error('invalid_scheduled_for');
    }
    sets.push('scheduled_for = ?');
    values.push(patch.scheduled_for);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    sets.push('notes = ?');
    values.push(patch.notes === '' ? null : patch.notes);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'type')) {
    if (FOLLOW_UP_TYPES.indexOf(patch.type) === -1) throw new Error('invalid_type');
    sets.push('type = ?');
    values.push(patch.type);
  }

  if (sets.length === 0) return getFollowUp(env, businessId, id);

  values.push(id, businessId);

  await requireDb(env).prepare(
    'UPDATE follow_ups SET ' + sets.join(', ') + ' WHERE id = ? AND business_id = ?'
  ).bind(...values).run();

  return getFollowUp(env, businessId, id);
}

/* ---- Overview aggregates ---------------------------------------------- */

/* One batch, one round trip. The overview is the first thing a customer sees
   after logging in, so it is the page where a chain of sequential awaits would
   be most noticeable.

   `monthStartIso` / `nowIso` / `todayLocal` are computed by the caller in the
   BUSINESS's timezone — this function does no timezone maths so there is
   exactly one place (functions/lib/http.js) where that can be got wrong. */
export async function overviewCounts(env, businessId, monthStartIso, nowIso, todayLocal) {
  const db = requireDb(env);

  const rows = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS n FROM leads
        WHERE business_id = ? AND status = 'new'`
    ).bind(businessId),

    db.prepare(
      `SELECT COUNT(*) AS n FROM leads
        WHERE business_id = ? AND created_at >= ?`
    ).bind(businessId, monthStartIso),

    db.prepare(
      `SELECT COUNT(*) AS n FROM bookings
        WHERE business_id = ? AND status IN ('requested', 'confirmed')
          AND (date IS NULL OR date >= ?)`
    ).bind(businessId, todayLocal),

    db.prepare(
      `SELECT COUNT(*) AS n FROM follow_ups
        WHERE business_id = ? AND status = 'pending' AND scheduled_for <= ?`
    ).bind(businessId, nowIso),

    db.prepare(
      `SELECT COUNT(*) AS n FROM calls
        WHERE business_id = ? AND COALESCE(started_at, created_at) >= ?`
    ).bind(businessId, monthStartIso),

    db.prepare(
      `SELECT COUNT(*) AS n FROM leads
        WHERE business_id = ? AND status = 'booked'`
    ).bind(businessId)
  ]);

  function n(index) {
    const r = rows[index];
    const first = r && r.results && r.results[0];
    return (first && Number(first.n)) || 0;
  }

  return {
    newLeads:        n(0),
    leadsThisMonth:  n(1),
    upcomingBookings: n(2),
    followUpsDue:    n(3),
    callsThisMonth:  n(4),
    bookedLeads:     n(5)
  };
}

/* The overview's activity feed. Calls and leads interleaved, newest first.

   Built as two small queries merged in JS rather than a UNION: the two rows
   have almost no columns in common, so a UNION would need a column of NULLs
   per side and would be harder to read than this for no measurable gain at
   these row counts. */
export async function recentActivity(env, businessId, limit) {
  const db = requireDb(env);
  const cap = Math.min(Number(limit) || 12, 50);

  const rows = await db.batch([
    db.prepare(
      `SELECT c.retell_call_id, c.from_number, c.started_at, c.created_at,
              c.duration_sec, c.summary, c.lead_id, l.name AS lead_name
         FROM calls c
         LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.business_id = ?
        ORDER BY COALESCE(c.started_at, c.created_at) DESC
        LIMIT ?`
    ).bind(businessId, cap),

    db.prepare(
      `SELECT id, name, phone, service, status, created_at
         FROM leads
        WHERE business_id = ?
        ORDER BY created_at DESC
        LIMIT ?`
    ).bind(businessId, cap)
  ]);

  const calls = (rows[0] && rows[0].results) || [];
  const leads = (rows[1] && rows[1].results) || [];

  const events = [];

  for (const c of calls) {
    events.push({
      kind: 'call',
      at: c.started_at || c.created_at,
      call_id: c.retell_call_id,
      lead_id: c.lead_id,
      name: c.lead_name,
      phone: c.from_number,
      duration_sec: c.duration_sec,
      summary: c.summary
    });
  }

  for (const l of leads) {
    events.push({
      kind: 'lead',
      at: l.created_at,
      lead_id: l.id,
      name: l.name,
      phone: l.phone,
      service: l.service,
      status: l.status
    });
  }

  /* ISO-8601 UTC to second precision sorts correctly as a string, which is
     why isoNow() in http.js normalises to exactly that format. */
  events.sort(function (a, b) {
    return String(b.at || '').localeCompare(String(a.at || ''));
  });

  return events.slice(0, cap);
}
