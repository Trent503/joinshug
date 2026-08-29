/* Shug — shared HTTP helpers for Pages Functions.

   This module exports no onRequest* handler, so Pages adds no route for it.
   (Same assumption functions/api/jobber/callback.js already relies on.)

   Note: _headers does NOT apply to Pages Functions responses — Cloudflare
   applies that file to static assets only. Every header a Function needs is
   therefore set here, in code. */

/* Webhook and API responses must never be cached, by the browser, by
   Cloudflare's edge, or by anything between. */
export function apiHeaders(extra) {
  return Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow'
  }, extra || {});
}

export function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: apiHeaders(extra)
  });
}

/* Error responses carry a stable short code and nothing else. A webhook
   endpoint is unauthenticated by definition until the signature is checked,
   so its error bodies must not describe why a request failed in a way that
   helps someone iterate toward a valid one. */
export function fail(code, status) {
  return json({ ok: false, error: code }, status || 400);
}

/* ISO-8601 UTC, second precision, matching SQLite's datetime('now') format so
   values written from JS and values written by a column default sort together
   as strings. */
export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* 'YYYY-MM' in the given IANA zone. Billing a call to the calendar month the
   BUSINESS was in, not the month UTC was in — see schema.sql. Intl is the only
   correct way to do this; manual offset arithmetic gets DST wrong twice a year.

   Falls back to the UTC month if the zone is unrecognised, so a typo in a
   business record degrades to a slightly-wrong month rather than throwing
   inside a webhook handler. */
export function billedMonth(iso, timeZone) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit'
    }).formatToParts(date);

    let year = '';
    let month = '';
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      if (part.type === 'month') month = part.value;
    }
    if (year && month) return year + '-' + month;
  } catch (e) {
    console.warn('billedMonth: unusable timezone, falling back to UTC');
  }

  return date.toISOString().slice(0, 7);
}

/* Dynamic variables must all be strings — Retell requires it, and a number or
   boolean silently breaks substitution. null/undefined are dropped entirely
   rather than sent as the string "null", because an omitted key falls back to
   the agent-level default while "null" would be spoken aloud. */
export function stringifyVars(source) {
  const out = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length === 0) continue;
    out[key] = text;
  }
  return out;
}

/* 'YYYY-MM-DD' in the given IANA zone. The dashboard's "today" must be the
   OWNER's today: at 9pm in Portland it is already tomorrow in UTC, and an
   overview that hides tonight's bookings four hours early is worse than no
   overview.

   en-CA is used for the same reason billedMonth does — its short date format
   is ISO-ordered, so formatToParts gives the pieces without any assembly
   ambiguity. Falls back to the UTC date if the zone is unrecognised, so a typo
   in a business record degrades to a slightly-wrong day rather than throwing
   inside a request handler. */
export function localDate(iso, timeZone) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);

    let year = '', month = '', day = '';
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'day') day = part.value;
    }
    if (year && month && day) return year + '-' + month + '-' + day;
  } catch (e) {
    console.warn('localDate: unusable timezone, falling back to UTC');
  }

  return date.toISOString().slice(0, 10);
}

/* The UTC instant at which the business's current billing month began.

   Built by asking what the LOCAL month is, then walking back from the UTC
   midnight of its first day by more than any real UTC offset (UTC-12 to
   UTC+14) and re-checking. Doing the offset arithmetic directly would need a
   table of zones and would be wrong twice a year at the DST boundary; letting
   Intl answer "what local date is this instant" and searching for the crossing
   cannot be, because Intl is the thing that knows.

   Used to bound "leads this month" and "calls this month" so those counts
   agree with the minutes number sitting next to them on the same screen. */
export function monthStartUtc(timeZone, atIso) {
  const month = billedMonth(atIso, timeZone);        // 'YYYY-MM', business-local
  if (!month) return null;

  const firstLocalDay = month + '-01';

  /* Start 14 hours BEFORE the UTC midnight of that local date — further back
     than the largest positive offset (UTC+14) — then step forward an hour at a
     time until the local date is the first of the month. The first such
     instant is the local midnight, expressed in UTC. */
  let cursor = Date.parse(firstLocalDay + 'T00:00:00Z') - 14 * 3600 * 1000;
  const limit = cursor + 30 * 3600 * 1000;           // covers UTC+14 .. UTC-12

  while (cursor <= limit) {
    const iso = new Date(cursor).toISOString();
    if (localDate(iso, timeZone) === firstLocalDay) {
      return iso.replace(/\.\d{3}Z$/, 'Z');
    }
    cursor += 3600 * 1000;
  }

  /* Unreachable for any real zone. Degrade to UTC month start rather than
     returning null and making every caller handle it. */
  return firstLocalDay + 'T00:00:00Z';
}
