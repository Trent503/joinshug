/* Shug — test helpers. Zero dependencies: node's built-in fetch, Web Crypto,
   and child_process for the few things that need to reach into D1 directly.

   Run against `wrangler dev` on http://127.0.0.1:8787 with the LOCAL D1 and KV
   bindings. Nothing here touches production, and nothing here needs a
   production credential. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const BASE = process.env.SHUG_TEST_BASE || 'http://127.0.0.1:8787';

/* ---- .dev.vars ---------------------------------------------------------
   Read for the Retell key (needed to forge a VALID webhook signature) and the
   admin token. Values are used and never printed — the summary at the end of a
   run reports pass/fail, never a secret. */
export function devVars() {
  const vars = {};
  let text = '';
  try {
    text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  } catch (e) {
    throw new Error('.dev.vars not found — copy .dev.vars.example and fill it in');
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/* ---- Local D1 ----------------------------------------------------------
   For the handful of assertions that must observe or manufacture database
   state the API deliberately does not expose — an expired session, a call in
   last month's billing period, the exact contents of the notification queue.

   Slow (a wrangler process per call), so it is used sparingly and never inside
   a loop. */
/* LOCAL STATE LOCATION.

   `wrangler dev` serves the repo root as its asset directory, and its file
   watcher watches that directory. The default local D1/KV state lives at
   `.wrangler/state/` — INSIDE the repo root — so every database write during a
   test run looks like a source change, triggers a reload, and the dev server
   eventually wedges in a reload loop while still holding the port. It presents
   as requests hanging against a server that is definitely listening.

   Setting SHUG_PERSIST_TO to a path outside the repo breaks that loop. Both
   `wrangler dev` and every `wrangler d1 execute --local` must be given the
   SAME directory or they will be looking at two different databases. */
export const PERSIST_TO = process.env.SHUG_PERSIST_TO || null;

function d1Args(extra) {
  const args = ['wrangler', 'd1', 'execute', 'shug', '--local'];
  if (PERSIST_TO) args.push('--persist-to', PERSIST_TO);
  return args.concat(extra);
}

export function sql(command) {
  const out = execFileSync(
    'npx',
    d1Args(['--json', '--command', command]),
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  /* wrangler prints npm/telemetry noise before the JSON. Take from the first
     bracket that begins a well-formed document to the end. */
  const start = out.indexOf('[');
  if (start === -1) throw new Error('no JSON in d1 output: ' + out.slice(0, 400));
  const parsed = JSON.parse(out.slice(start));
  return (parsed[0] && parsed[0].results) || [];
}

/* Deletes a key from the LOCAL CONFIG_CACHE namespace.

   Needed because the number -> business lookup is cached in KV for 300
   seconds. That is correct and deliberate — the inbound webhook is on the path
   of every ringing phone — but it means a business status changed by direct SQL
   keeps answering calls until the entry expires.

   An operator suspending a customer for non-payment has to do exactly this, so
   the test doing it is the test matching reality rather than working around it.
   See SESSION_LOG.md, "Suspending a customer". */
export function bustNumberCache(e164) {
  const args = ['wrangler', 'kv', 'key', 'delete', '--binding', 'CONFIG_CACHE', '--local'];
  if (PERSIST_TO) args.push('--persist-to', PERSIST_TO);
  args.push('number:' + e164);
  try {
    execFileSync('npx', args, {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    /* A key that was never cached is not an error — the next lookup goes to
       D1 either way, which is the outcome the caller wanted. */
  }
}

export function sqlFile(path) {
  execFileSync(
    'npx',
    d1Args(['--file', path]),
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/* ---- Retell signatures -------------------------------------------------
   Mirrors functions/lib/retell.js, which was transcribed from retell-sdk's
   own verify(): HMAC-SHA256 over (rawBody + timestamp), keyed with the API
   key's raw UTF-8 bytes, presented as `v={ms},d={hex}`.

   Implemented independently here rather than imported so a bug that made
   verification wrong in the SAME way in both places cannot pass the test. */
export async function retellSignature(rawBody, apiKey, timestamp) {
  const ts = timestamp || Date.now();

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(rawBody + ts)
  );

  const hex = Array.from(new Uint8Array(mac))
    .map(function (b) { return b.toString(16).padStart(2, '0'); })
    .join('');

  return 'v=' + ts + ',d=' + hex;
}

/* ---- HTTP --------------------------------------------------------------
   `jar` is a tiny cookie jar so a test can hold a session the way a browser
   would. Origin is set on every state-changing request because the API's CSRF
   check requires it — a test that omitted it would be testing the CSRF
   rejection, not the endpoint. */
export function makeClient() {
  const cookies = new Map();

  async function request(method, path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});

    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const stateChanging = ['POST', 'PATCH', 'PUT', 'DELETE'].indexOf(method) !== -1;
    if (stateChanging && !('Origin' in headers) && opts.origin !== false) {
      headers['Origin'] = BASE;
    }
    if (opts.origin && typeof opts.origin === 'string') {
      headers['Origin'] = opts.origin;
    }

    if (cookies.size > 0 && !opts.noCookies) {
      headers['Cookie'] = Array.from(cookies.entries())
        .map(function (e) { return e[0] + '=' + e[1]; }).join('; ');
    }

    const response = await fetch(BASE + path, {
      method: method,
      headers: headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      redirect: 'manual'
    });

    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      /* Node collapses multiple Set-Cookie headers into one comma-joined
         value. Splitting on the boundary between cookies (a comma followed by
         a name= that is not inside an Expires date) is fiddly; splitting on
         ", " before a token= pattern is enough for the two names this app
         ever sets. */
      for (const part of value.split(/,\s*(?=[A-Za-z_][A-Za-z0-9_-]*=)/)) {
        const pair = part.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const cookieName = pair.slice(0, eq).trim();
        const cookieValue = pair.slice(eq + 1).trim();
        if (!cookieValue || /max-age=0/i.test(part)) cookies.delete(cookieName);
        else cookies.set(cookieName, cookieValue);
      }
    }

    let body = null;
    const text = await response.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = text; }
    }

    return { status: response.status, body: body, headers: response.headers };
  }

  return {
    get:   function (p, o) { return request('GET', p, o); },
    post:  function (p, o) { return request('POST', p, o); },
    patch: function (p, o) { return request('PATCH', p, o); },
    del:   function (p, o) { return request('DELETE', p, o); },
    raw:   request,
    cookies: cookies,
    clearCookies: function () { cookies.clear(); }
  };
}

/* ---- Assertions ------------------------------------------------------- */

const state = { passed: 0, failed: 0, failures: [], group: '' };

export function group(name) {
  state.group = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

export function check(description, condition, detail) {
  if (condition) {
    state.passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + description);
  } else {
    state.failed++;
    state.failures.push(state.group + ' → ' + description +
      (detail ? '\n      ' + detail : ''));
    console.log('  \x1b[31m✗ ' + description + '\x1b[0m' +
      (detail ? '\n      \x1b[31m' + detail + '\x1b[0m' : ''));
  }
}

export function checkEqual(description, actual, expected) {
  check(description, actual === expected,
    'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

export function summary() {
  console.log('\n' + '─'.repeat(64));
  if (state.failed === 0) {
    console.log('\x1b[32m\x1b[1m' + state.passed + ' passed, 0 failed\x1b[0m');
  } else {
    console.log('\x1b[31m\x1b[1m' + state.failed + ' FAILED\x1b[0m, ' +
      state.passed + ' passed\n');
    for (const failure of state.failures) console.log('  \x1b[31m• ' + failure + '\x1b[0m');
  }
  console.log('─'.repeat(64));
  return state.failed;
}

export function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}
