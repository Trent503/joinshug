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
