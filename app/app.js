/* Shug — dashboard runtime, shared by every /app/ page.

   No framework, no build step, no dependency — the same rules the marketing
   site follows.

   CSP NOTE, AND IT IS LOAD-BEARING: _headers sets
   `script-src 'self'` with no 'unsafe-inline'. So there are no inline <script>
   blocks and no inline event handlers anywhere in /app/. Everything is an
   external module and every handler is addEventListener, mostly via delegation.
   Adding an onclick= attribute to a dashboard page will silently do nothing in
   production while appearing to work nowhere. */

/* ---- API -------------------------------------------------------------- */

/* Every response is JSON and every failure is a status code plus a stable
   short code. A 401 anywhere means the session is gone, so it is handled once,
   here, rather than in each caller. */
export async function api(path, options) {
  const opts = options || {};

  const init = {
    method: opts.method || 'GET',
    headers: {},
    /* Same-origin only. The session cookie is HttpOnly, so the browser
       attaches it and this code never sees it. */
    credentials: 'same-origin'
  };

  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (e) {
    /* Offline, DNS, a dropped connection. Distinct from an API error, and the
       only sensible advice is "try again". */
    throw new ApiError('network', 0, 'Could not reach Shug. Check your connection.');
  }

  if (response.status === 401 && !opts.allow401) {
    redirectToLogin();
    throw new ApiError('unauthenticated', 401, 'Signed out.');
  }

  let body = null;
  const text = await response.text();
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = null; }
  }

  if (!response.ok) {
    const code = (body && body.error) || 'request_failed';
    throw new ApiError(code, response.status, messageFor(code, response.status));
  }

  return body;
}

export class ApiError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/* Maps the API's stable short codes to something a contractor can act on.
   An unmapped code falls back to the code itself rather than a generic
   "something went wrong", because a code we can search for beats a sentence
   that tells nobody anything. */
const MESSAGES = {
  invalid_credentials: 'That email and password do not match.',
  account_locked: 'Too many attempts. Try again in 15 minutes.',
  unauthenticated: 'Please sign in again.',
  account_suspended: 'This account is suspended. Get in touch to reactivate.',
  not_found: 'That is no longer there.',
  invalid_status: 'That status is not one of the six.',
  invalid_date: 'Use a real calendar date.',
  invalid_start_time: 'Use a time like 09:00.',
  invalid_end_time: 'Use a time like 11:00.',
  invalid_scheduled_for: 'Pick a date and time for the follow-up.',
  invalid_type: 'Pick a follow-up type.',
  invalid_email: 'That does not look like an email address.',
  invalid_timezone: 'That timezone is not one we recognise.',
  name_required: 'A business name is required — the agent says it on every call.',
  name_or_phone_required: 'A lead needs at least a name or a phone number.',
  password_too_short: 'Use at least 10 characters.',
  malformed_json: 'That request could not be read.',
  missing_origin: 'Refresh the page and try again.',
  bad_origin: 'Refresh the page and try again.',
  network: 'Could not reach Shug. Check your connection.'
};

function messageFor(code, status) {
  if (MESSAGES[code]) return MESSAGES[code];
  if (status >= 500) return 'Shug had a problem saving that. Try again.';
  return code;
}

export function redirectToLogin() {
  const here = location.pathname + location.search;
  location.href = '/app/login/?next=' + encodeURIComponent(here);
}

/* ---- Escaping ---------------------------------------------------------- */

/* EVERY value that reaches innerHTML goes through here.

   Lead names, addresses and job descriptions come from a phone call
   transcribed by a speech model and then through Retell's extraction — they
   are untrusted text from outside the system, and the dashboard renders them
   into markup. Without this, a caller who says the right thing gets to run
   script in their contractor's dashboard. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---- Formatting -------------------------------------------------------- */

export function phone(e164) {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(e164));
  return m ? '(' + m[1] + ') ' + m[2] + '-' + m[3] : String(e164);
}

/* Durations are read at a glance, so 95 seconds is "1m 35s", not "0:01:35". */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? minutes + 'm' : minutes + 'm ' + rest + 's';
}

/* Server timestamps are ISO-8601 UTC. The browser renders them in the viewer's
   own zone, which for a contractor looking at their own dashboard is the right
   one. (The BUSINESS timezone is what the server uses for billing boundaries —
   a different question, answered in functions/lib/http.js.) */
export function when(iso) {
  if (!iso) return '';
  const date = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();

  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return 'Today ' + time;
  if (yesterday) return 'Yesterday ' + time;

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], {
    month: 'short', day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  }) + ' ' + time;
}

/* A booking's date is a business-local wall-clock 'YYYY-MM-DD' with no zone.
   It is parsed as local noon rather than passed to Date(), because
   new Date('2026-09-14') is parsed as UTC midnight and renders as the 13th for
   anyone west of Greenwich — which is every customer this product has. */
export function bookingDate(ymd) {
  if (!ymd) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function clockTime(hhmm) {
  if (!hhmm) return '';
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return twelve + (m[2] === '00' ? '' : ':' + m[2]) + suffix;
}

export function pill(status) {
  if (!status) return '';
  return '<span class="pill pill-' + esc(status) + '">' +
    esc(String(status).replace(/_/g, ' ')) + '</span>';
}

/* ---- Toast ------------------------------------------------------------- */

let toastTimer = null;

export function toast(message, bad) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    /* Announced to screen readers without stealing focus. */
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
  }

  node.textContent = message;
  node.classList.toggle('is-bad', Boolean(bad));
  node.classList.add('is-on');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, 3200);
}

export function toastError(error) {
  toast((error && error.message) || 'Something went wrong.', true);
}

/* ---- Shell ------------------------------------------------------------- */

const NAV = [
  ['/app/',          'Overview', 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5'],
  ['/app/leads/',    'Leads',    'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M17 4.5a3.2 3.2 0 0 1 0 6.2M21 20v-1.5a4 4 0 0 0-3-3.8'],
  ['/app/calls/',    'Calls',    'M21.5 16.9v2.8a1.9 1.9 0 0 1-2 1.9 18.6 18.6 0 0 1-8.1-2.9 18.3 18.3 0 0 1-5.6-5.6A18.6 18.6 0 0 1 2.9 5a1.9 1.9 0 0 1 1.9-2h2.8a1.9 1.9 0 0 1 1.9 1.6c.1 1 .3 1.8.6 2.7a1.9 1.9 0 0 1-.4 2l-1.2 1.2a15 15 0 0 0 5.6 5.6l1.2-1.2a1.9 1.9 0 0 1 2-.4c.9.3 1.8.5 2.7.6a1.9 1.9 0 0 1 1.6 2Z'],
  ['/app/settings/', 'Settings', 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-3-1.2l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2.8a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-3l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V2.8a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 3 1.2l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z']
];

/* Renders the sidebar and returns the session, so a page's first line is
   `const me = await mount('/app/leads/')` and it can assume it is signed in
   from the next line on. */
export async function mount(current) {
  const me = await api('/api/auth/me', { allow401: true }).catch(function (e) {
    if (e.status === 401) { redirectToLogin(); return null; }
    throw e;
  });

  if (!me) return null;

  const business = me.business || {};
  const links = NAV.map(function (item) {
    const active = item[0] === current ? ' aria-current="page"' : '';
    return '<a class="side-link" href="' + item[0] + '"' + active + '>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + item[2] + '"/></svg>' +
      '<span>' + esc(item[1]) + '</span></a>';
  }).join('');

  const side = document.querySelector('.side');
  side.innerHTML =
    '<a class="side-brand" href="/app/" aria-label="Shug dashboard"><span>shug</span></a>' +
    '<div class="side-biz"><b>' + esc(business.name || 'Your business') + '</b>' +
    '<span>' + esc(phone(business.phone)) + '</span></div>' +
    '<nav class="side-nav" aria-label="Dashboard">' + links + '</nav>' +
    '<div class="side-foot">' +
    '<div class="side-user">' + esc(me.user.email) + '</div>' +
    '<button class="side-out" type="button" data-logout>Sign out</button>' +
    '</div>';

  side.querySelector('[data-logout]').addEventListener('click', async function () {
    try { await api('/api/auth/logout', { method: 'POST', allow401: true }); } catch (e) { /* leaving anyway */ }
    location.href = '/app/login/';
  });

  document.title = (document.title.split('·')[0] || 'Shug').trim() +
    ' · ' + (business.name || 'Shug');

  return me;
}

/* The two banners that need to appear on every page. Demo tenants are labelled
   so nobody mistakes seeded data for a real customer's, and a generated
   password nags until it is changed. */
export function shellBanners(me) {
  const parts = [];

  if (me.business && me.business.isDemo) {
    parts.push('<div class="banner banner-demo"><b>Demo data.</b>&nbsp;' +
      'This business is seeded with example leads and calls so the dashboard ' +
      'has something to show. It is not a real customer.</div>');
  }

  if (me.user && me.user.mustChangePassword) {
    parts.push('<div class="banner banner-warn"><b>Change your password.</b>&nbsp;' +
      'You are still using the one you were given when your account was set up. ' +
      '<a href="/app/settings/#password">Change it now</a>.</div>');
  }

  return parts.join('');
}

/* ---- Small helpers ----------------------------------------------------- */

export function el(id) { return document.getElementById(id); }

export function emptyState(title, note) {
  return '<div class="empty"><b>' + esc(title) + '</b>' + esc(note || '') + '</div>';
}

export function skeleton(rows) {
  let out = '';
  for (let i = 0; i < (rows || 3); i++) {
    out += '<div class="skeleton" style="width:' + (60 + (i * 13) % 35) + '%"></div>';
  }
  return out;
}

/* Turns a <form> into a plain object, trimming as it goes. Empty strings are
   kept (not dropped) because clearing a field is a real edit — the API's
   allow-lists turn '' into NULL. */
export function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form)) {
    values[key] = typeof value === 'string' ? value.trim() : value;
  }
  return values;
}

/* Guards a submit button against a double-click creating two leads. */
export async function submitting(button, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
