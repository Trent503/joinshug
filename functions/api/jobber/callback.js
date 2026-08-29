/* Shug — Jobber OAuth, leg 2 of 2: verify state, exchange the code, store tokens.
   GET /api/jobber/callback

   A Cloudflare Pages Function. Everything in this file runs server-side at the
   edge. JOBBER_CLIENT_SECRET is read from the Pages environment, used only in a
   server-to-server POST to Jobber, and never written to a response, a log line,
   or KV.

   This file is also the token store for the rest of the app. It exports
   getValidJobberAccessToken() and refreshJobberTokens() so future Functions can
   call Jobber without each one re-implementing refresh-token rotation. (Those
   exports are plain functions, not onRequest* handlers, so they add no route.
   Pages routes a module only via its onRequest* exports.)

   Required bindings (Pages -> Settings):
     Variables and secrets:
       JOBBER_CLIENT_ID       plaintext variable
       JOBBER_CLIENT_SECRET   SECRET — encrypt this one
       JOBBER_REDIRECT_URI    plaintext variable, identical to start.js
     Bindings:
       JOBBER_TOKENS          KV namespace binding

   Optional:
     JOBBER_TOKEN_URL, JOBBER_API_URL, JOBBER_GRAPHQL_VERSION

   Note: _headers does NOT apply to Pages Functions responses. Headers are set
   here, in code. */

const DEFAULT_TOKEN_URL = 'https://api.getjobber.com/api/oauth/token';
const DEFAULT_API_URL = 'https://api.getjobber.com/api/graphql';

/* Jobber requires this header on every GraphQL request. 2025-04-16 is the
   current version at the time of writing; confirm it in the Developer Center
   and override with the JOBBER_GRAPHQL_VERSION variable when you upgrade. */
const DEFAULT_GRAPHQL_VERSION = '2025-04-16';

const STATE_COOKIE = '__Secure-shug_jobber_state';

/* One KV key per connected Jobber account, so no account can read or clobber
   another's tokens, and `wrangler kv key list --prefix jobber:account:`
   enumerates every connection. */
const KEY_PREFIX = 'jobber:account:';

/* Refresh this far before the access token actually expires, so a request that
   is in flight when the clock runs out does not fail. */
const REFRESH_SKEW_MS = 120 * 1000;

/* ---- Response helpers ------------------------------------------------- */

function oauthHeaders(extra) {
  return Object.assign({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }, extra || {});
}

/* Clearing the state cookie must use the same Path and attributes it was set
   with, or the browser keeps the original. */
function clearedStateCookie() {
  return STATE_COOKIE + '=; Path=/api/jobber; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* A deliberately plain page. It borrows nothing from assets/site.css so the
   marketing site's design is untouched and cannot drift with it. */
function page(status, heading, body) {
  const html = '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    '<title>' + escapeHtml(heading) + '</title>\n' +
    '<style>body{margin:0;padding:3rem 1.5rem;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#211E1B;background:#F7F5F1}' +
    'main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0 0 .75rem}code{font-size:.9em}</style>\n' +
    '</head>\n<body>\n<main>\n<h1>' + escapeHtml(heading) + '</h1>\n' + body + '</main>\n</body>\n</html>\n';

  return new Response(html, {
    status: status,
    headers: oauthHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': clearedStateCookie()
    })
  });
}

function errorPage(status, detail) {
  return page(status, 'Could not connect Jobber',
    '<p>' + escapeHtml(detail) + '</p>\n' +
    '<p>Nothing was saved. Start the connection again from the beginning; if it keeps failing, send this page along with the time it happened.</p>\n');
}

/* ---- Request helpers -------------------------------------------------- */

function readCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) continue;
    if (parts[i].slice(0, eq).trim() === name) return parts[i].slice(eq + 1).trim();
  }
  return null;
}

/* Length-independent comparison. The state value is high-entropy and the window
   is short, so a timing oracle here is largely theoretical — but comparing
   secrets in constant time costs three lines. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Jobber access tokens are JWTs carrying an `exp` claim. We read it only to
   schedule our own refresh — never to make an authorization decision — so
   decoding without verifying the signature is correct here. `expires_in` is
   preferred when the token response supplies it. */
function expiryFromTokens(tokens) {
  const expiresIn = Number(tokens.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) return Date.now() + expiresIn * 1000;

  try {
    const segment = String(tokens.access_token).split('.')[1];
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (segment.length % 4)) % 4);
    const exp = Number(JSON.parse(atob(padded)).exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1000;
  } catch (e) {
    /* Fall through. Never log the token or the decode error's payload. */
  }

  /* Jobber access tokens live 60 minutes. Assume the floor, not the ceiling. */
  return Date.now() + 55 * 60 * 1000;
}

/* ---- KV: one isolated record per connected Jobber account -------------- */

function accountKey(accountId) {
  return KEY_PREFIX + accountId;
}

async function readAccount(env, accountId) {
  const raw = await env.JOBBER_TOKENS.get(accountKey(accountId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('jobber: unparseable KV record for account ' + accountId);
    return null;
  }
}

/* The single write path for tokens, used by both the initial code exchange and
   every subsequent refresh — so rotation cannot be handled correctly in one
   place and forgotten in the other.

   Rotation: Jobber issues a new refresh token on refresh and the old one is
   single-use. Whenever the response carries a refresh_token we replace the
   stored one. When it does not, we keep what we have rather than blanking the
   field, which would strand the connection permanently. */
async function saveAccountTokens(env, account, tokens) {
  const previous = await readAccount(env, account.id);
  const now = new Date().toISOString();

  const refreshToken = tokens.refresh_token || (previous && previous.refreshToken) || null;
  const rotated = Boolean(tokens.refresh_token && previous && previous.refreshToken &&
    tokens.refresh_token !== previous.refreshToken);

  const record = {
    accountId: account.id,
    accountName: account.name || (previous && previous.accountName) || null,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: expiryFromTokens(tokens),
    refreshToken: refreshToken,
    tokenType: tokens.token_type || 'bearer',
    scope: tokens.scope || (previous && previous.scope) || null,
    connectedAt: (previous && previous.connectedAt) || now,
    updatedAt: now,
    refreshCount: (previous && previous.refreshCount) || 0
  };
  if (rotated) record.refreshCount += 1;

  await env.JOBBER_TOKENS.put(accountKey(account.id), JSON.stringify(record));

  /* Counts and identifiers only. No token material reaches the log. */
  console.log('jobber: stored tokens for account ' + account.id +
    ' (rotated=' + rotated + ', refreshCount=' + record.refreshCount + ')');

  return record;
}

/* ---- Jobber calls ----------------------------------------------------- */

function requireEnv(env, names) {
  const missing = names.filter(function (n) { return !env[n]; });
  if (missing.length) {
    console.error('jobber: missing Pages environment variables: ' + missing.join(', '));
  }
  return missing;
}

/* Both grants post to the same endpoint and differ only in the grant-specific
   fields, so they share one function and one error path. `params` never appears
   in a log line — it carries the client secret and the refresh token. */
async function postTokenRequest(env, params) {
  const body = new URLSearchParams(params);
  body.set('client_id', env.JOBBER_CLIENT_ID);
  body.set('client_secret', env.JOBBER_CLIENT_SECRET);

  const response = await fetch(env.JOBBER_TOKEN_URL || DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body.toString()
  });

  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (e) { /* handled below */ }

  if (!response.ok || !payload || !payload.access_token) {
    /* Log the status and Jobber's own error code, never the response body —
       a token endpoint's body is exactly where token material lives. */
    const code = (payload && (payload.error || payload.error_description)) || 'unparseable response';
    console.error('jobber: token request failed (HTTP ' + response.status + '): ' + String(code).slice(0, 200));
    throw new Error('token_request_failed');
  }

  return payload;
}

/* Jobber's own guidance: after receiving tokens, query the account to learn
   which Jobber account they belong to. That id is what isolates the KV record. */
async function fetchJobberAccount(env, accessToken) {
  const response = await fetch(env.JOBBER_API_URL || DEFAULT_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': env.JOBBER_GRAPHQL_VERSION || DEFAULT_GRAPHQL_VERSION
    },
    body: JSON.stringify({ query: '{ account { id name } }' })
  });

  let payload = null;
  try { payload = await response.json(); } catch (e) { /* handled below */ }

  const account = payload && payload.data && payload.data.account;
  if (!response.ok || !account || !account.id) {
    const code = (payload && payload.errors && payload.errors[0] && payload.errors[0].message) || 'no account in response';
    console.error('jobber: account lookup failed (HTTP ' + response.status + '): ' + String(code).slice(0, 200));
    throw new Error('account_lookup_failed');
  }

  return account;
}

/* ---- Exported token access for the rest of the app -------------------- */

/* Trades the stored refresh token for a fresh access token and persists
   whatever Jobber returns, including a rotated refresh token.

   Known limitation: KV has no compare-and-set, so two refreshes racing on the
   same account can both present the same single-use refresh token and one will
   lose the connection. Single-writer callers (a cron, a queue consumer) are
   safe; if concurrent refresh ever becomes real, move the record behind a
   Durable Object and take a lock there. */
export async function refreshJobberTokens(env, accountId) {
  const record = await readAccount(env, accountId);
  if (!record || !record.refreshToken) throw new Error('jobber_not_connected');

  const tokens = await postTokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: record.refreshToken
  });

  return saveAccountTokens(env, { id: record.accountId, name: record.accountName }, tokens);
}

/* The accessor every Jobber API call should go through. */
export async function getValidJobberAccessToken(env, accountId) {
  const record = await readAccount(env, accountId);
  if (!record) throw new Error('jobber_not_connected');

  if (record.accessToken && record.accessTokenExpiresAt - REFRESH_SKEW_MS > Date.now()) {
    return record.accessToken;
  }

  const refreshed = await refreshJobberTokens(env, accountId);
  return refreshed.accessToken;
}

/* ---- Handler ---------------------------------------------------------- */

export async function onRequestGet(context) {
  const env = context.env;
  const url = new URL(context.request.url);

  /* Whatever happens below, the one-shot state cookie is cleared — every
     response from this file goes out through page()/errorPage(). */

  const missing = requireEnv(env, ['JOBBER_CLIENT_ID', 'JOBBER_CLIENT_SECRET', 'JOBBER_REDIRECT_URI']);
  if (missing.length) return errorPage(500, 'The Jobber integration is not configured on the server.');
  if (!env.JOBBER_TOKENS) {
    console.error('jobber: KV binding JOBBER_TOKENS is not bound to this Pages project');
    return errorPage(500, 'The Jobber integration is not configured on the server.');
  }

  /* 1. Jobber reported an error, or the user declined. Nothing to exchange. */
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    console.warn('jobber/callback: authorization denied or failed: ' + oauthError.slice(0, 100));
    return errorPage(400, oauthError === 'access_denied'
      ? 'The connection was declined in Jobber.'
      : 'Jobber rejected the authorization request.');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return errorPage(400, 'That callback link is incomplete.');

  /* 2. Verify state BEFORE the code is exchanged. A callback that does not
        carry the cookie we set is either a CSRF attempt or an expired flow;
        either way the code is never sent to Jobber. */
  const expected = readCookie(context.request, STATE_COOKIE);
  if (!expected) return errorPage(400, 'This connection attempt expired. It is only valid for ten minutes.');
  if (!safeEqual(state, expected)) {
    console.warn('jobber/callback: OAuth state mismatch — rejected before code exchange');
    return errorPage(403, 'This connection attempt could not be verified.');
  }

  /* 3. Exchange, identify, store. */
  try {
    const tokens = await postTokenRequest(env, {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: env.JOBBER_REDIRECT_URI
    });

    const account = await fetchJobberAccount(env, tokens.access_token);
    const record = await saveAccountTokens(env, account, tokens);

    return page(200, 'Jobber connected',
      '<p><strong>' + escapeHtml(record.accountName || record.accountId) + '</strong> is now connected to SHUG.</p>\n' +
      '<p>You can close this tab.</p>\n');
  } catch (e) {
    /* e.message is one of our own short codes; provider text never lands here. */
    if (e && e.message === 'account_lookup_failed') {
      return errorPage(502, 'Jobber authorized the connection but would not identify the account, so nothing was stored.');
    }
    console.error('jobber/callback: ' + ((e && e.message) || 'unknown failure'));
    return errorPage(502, 'Jobber did not complete the connection.');
  }
}
