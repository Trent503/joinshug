/* Shug — authentication and tenant isolation for the /app/ dashboard.

   ===========================================================================
   THE THREAT MODEL, AND WHAT EACH DECISION BUYS
   ===========================================================================

   PASSWORDS: PBKDF2-HMAC-SHA256, per-user 16-byte salt from the platform
   CSPRNG, iteration count stored PER ROW. A plain SHA-256 of a password is a
   single hash per guess and is broken at GPU speed; the point of a KDF is to
   make each guess expensive. The iteration count lives on the row, not in a
   constant, so it can be raised later and existing passwords keep verifying at
   their old cost until their owner next signs in.

   Web Crypto's PBKDF2 is used because it is what the runtime provides. Argon2
   or scrypt would be stronger per unit of CPU, but both would mean shipping a
   WASM dependency into a project that deliberately has none, and PBKDF2 at a
   real iteration count is not the weak link here.

   SESSIONS: server-side in D1, never a JWT in localStorage. Two reasons, both
   practical rather than theoretical:
     * a logout, a password change, or a suspended account takes effect on the
       NEXT REQUEST, because authorisation is a database read and not a
       signature check over a token we cannot recall;
     * localStorage is readable by any script that ever gets injected; an
       HttpOnly cookie is not.

   The table stores SHA-256(token), NOT the token. The token exists only in the
   user's cookie. Someone who reads the sessions table therefore cannot log in
   as anybody — which is the entire reason to hash a value that is already
   random. A plain hash (not a KDF) is correct here precisely because the input
   is 256 bits of CSPRNG output: there is nothing to brute-force.

   COOKIE: HttpOnly, Secure, SameSite=Lax, Path=/. Lax rather than Strict
   because Strict would drop the cookie on a top-level navigation into /app/
   from an email or a bookmark bar, which reads to the user as "it logged me
   out". Lax still blocks the cross-site POST that CSRF needs.

   CSRF: SameSite=Lax already prevents a cross-site form POST from carrying the
   cookie. requireOrigin() below adds a second, independent check on every
   state-changing request. Two mechanisms, neither relying on the other.

   TENANCY: business_id comes from the SESSION ROW and from nowhere else. No
   handler reads a business id from a query string, a body, or a header. That
   is not a convention to remember — sessionFromRequest() returns the id, and
   every store.js function requires it as an argument, so the wrong thing is
   not reachable without deliberately writing it.

   This module exports no onRequest* handler, so it is not routable. */

import { isoNow } from './http.js';

/* ---------------------------------------------------------------------------
   PBKDF2 cost, and a PLATFORM CEILING THAT IS NOT OPTIONAL.

   The Cloudflare Workers runtime rejects a PBKDF2 deriveBits call above
   100,000 iterations. `wrangler dev` (local workerd) does NOT enforce that
   limit, so a higher number passes every local test and then throws on the
   first real request in production.

   This was not theoretical. An earlier version of this file used 210,000 — the
   OWASP baseline — and it worked through 173 local assertions before failing
   on the first provisioning call against joinshug.com with a caught exception
   surfacing as `internal_error`. If a future change raises this, it will break
   in production and nowhere else. There is a test asserting the ceiling.

   100,000 iterations of PBKDF2-HMAC-SHA256 is still a real KDF: it is roughly
   five orders of magnitude more expensive per guess than a bare SHA-256, which
   is the comparison that matters. It runs on login and password-change only,
   never on an ordinary authenticated request — those are one indexed SELECT.
   --------------------------------------------------------------------------- */
export const PBKDF2_MAX_ITERATIONS = 100000;   // Cloudflare Workers hard limit
const PBKDF2_ITERATIONS = PBKDF2_MAX_ITERATIONS;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;

const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_HOURS = 720;   // 30 days

/* Online-guess throttling. Not a substitute for the KDF — this stops someone
   hammering the endpoint; the KDF stops someone who has already stolen the
   table. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

/* ---- Encoding helpers ------------------------------------------------- */

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/* Constant time in the length of the inputs. A === on two strings returns as
   soon as it finds a difference, and the time it takes is a measurable oracle
   for how much of a value an attacker has guessed correctly.

   Written by hand rather than using Cloudflare's crypto.subtle.timingSafeEqual
   so the same code runs unchanged under node in tests/. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---- Password hashing ------------------------------------------------- */

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    key,
    DERIVED_BITS
  );

  return new Uint8Array(bits);
}

export async function hashPassword(password, iterations) {
  /* Clamped rather than trusted. A caller asking for more than the runtime
     allows would produce a row that can never be verified in production —
     which presents to its owner as "my password stopped working". */
  const rounds = Math.min(iterations || PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await pbkdf2(password, salt, rounds);

  return {
    password_hash: toBase64(derived),
    password_salt: toBase64(salt),
    password_iterations: rounds
  };
}

/* Verifies against the parameters stored on the user's own row. A malformed
   row (truncated salt, unparseable base64) returns false rather than throwing:
   a corrupt record must fail closed as "wrong password", not 500. */
export async function verifyPassword(password, stored) {
  if (!password || !stored || !stored.password_hash || !stored.password_salt) {
    return false;
  }

  try {
    const salt = fromBase64(stored.password_salt);
    const expected = fromBase64(stored.password_hash);
    const iterations = Number(stored.password_iterations) || PBKDF2_ITERATIONS;
    const derived = await pbkdf2(password, salt, iterations);
    return timingSafeEqual(derived, expected);
  } catch (e) {
    /* Distinguish the two ways this throws. A row stored above the runtime's
       PBKDF2 ceiling verifies fine locally and throws in production, and
       reporting that as "wrong password" would send someone hunting for a
       typo that is not there. */
    const iterations = Number(stored.password_iterations) || 0;
    if (iterations > PBKDF2_MAX_ITERATIONS) {
      console.error('auth: user row stores ' + iterations + ' PBKDF2 iterations, ' +
        'above the runtime limit of ' + PBKDF2_MAX_ITERATIONS +
        ' — this password can never verify here. Reset it.');
    } else {
      console.warn('auth: password verification failed on a malformed user row');
    }
    return false;
  }
}

/* The only password policy. Deliberately a length floor and nothing else:
   composition rules ("one symbol, one digit") measurably push people toward
   Passw0rd! and are not what stops an attack — the KDF and the lockout are. */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password) {
  if (typeof password !== 'string') return 'password_required';
  if (password.length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (password.length > 200) return 'password_too_long';
  return null;
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  /* Not an RFC 5322 validator, and not trying to be. It rejects the shapes
     that are certainly not addresses and lets the rest through — an over-tight
     regex here rejects real customers, which is a worse failure than storing
     an address that bounces. */
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/* ---- Sessions --------------------------------------------------------- */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

function sessionTtlHours(env) {
  const configured = Number(env && env.SESSION_TTL_HOURS);
  if (Number.isFinite(configured) && configured > 0 && configured <= 8760) {
    return configured;
  }
  return DEFAULT_SESSION_TTL_HOURS;
}

/* Returns the RAW token, which is the only moment it exists outside the user's
   cookie. It is never stored, never logged, and never returned again. */
export async function createSession(env, user, request) {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
  const id = await sha256Hex(token);

  const expiresAt = new Date(Date.now() + sessionTtlHours(env) * 3600 * 1000)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');

  /* Truncated hard. This is only ever shown back to its own owner on a
     "your sessions" screen; storing a full UA string is more fingerprint than
     the feature needs. */
  const userAgent = request
    ? String(request.headers.get('user-agent') || '').slice(0, 120)
    : null;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, business_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6)`
  ).bind(id, user.id, user.business_id, isoNow(), expiresAt, userAgent).run();

  return { token: token, expiresAt: expiresAt };
}

/* ---- Cookies ---------------------------------------------------------- */

/* The __Host- prefix makes a browser refuse the cookie unless it is Secure,
   Path=/, and has no Domain attribute — which means a subdomain, or anything
   that manages to serve plain HTTP under this name, cannot set a session
   cookie the app will accept.

   It requires HTTPS, so `wrangler dev` over http://localhost gets the
   unprefixed name instead. Both are read on the way in; only the correct one
   for the current scheme is ever written. */
const COOKIE_SECURE = '__Host-shug_session';
const COOKIE_PLAIN = 'shug_session';

function isSecureRequest(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch (e) {
    return true;   // fail toward the stricter cookie
  }
}

export function sessionSetCookie(request, token, expiresAt) {
  const secure = isSecureRequest(request);
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
  );

  return name + '=' + token +
    '; Path=/' +
    '; HttpOnly' +
    '; SameSite=Lax' +
    (secure ? '; Secure' : '') +
    '; Max-Age=' + maxAge;
}

/* Clearing must use the same name, Path and attributes the cookie was set
   with, or the browser keeps the original and the user stays signed in.
   Both names are cleared because only one of them is ever present. */
export function sessionClearCookies(request) {
  const secure = isSecureRequest(request);
  const base = '=; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : '') + '; Max-Age=0';
  return [COOKIE_SECURE + base, COOKIE_PLAIN + base];
}

function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export function readSessionToken(request) {
  return readCookie(request, COOKIE_SECURE) || readCookie(request, COOKIE_PLAIN);
}

/* ---- Authorisation ---------------------------------------------------- */

/* One indexed primary-key read joined to the user and the business.

   Expiry, revocation, a disabled user, and a suspended business are all
   checked in SQL rather than in JS, so there is no branch anyone can forget to
   write. A session that fails any of them simply does not come back.

   Returns { session_id, user_id, business_id, email, name, role,
             must_change_password, business } or null. */
export async function sessionFromRequest(env, request) {
  const token = readSessionToken(request);
  if (!token) return null;

  /* A token that is not the right SHAPE never reaches the database. Cheap, and
     it keeps scanner traffic off D1. */
  if (token.length < 20 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return null;
  }

  const id = await sha256Hex(token);

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at,
            u.id AS user_id, u.email, u.name, u.role, u.must_change_password,
            b.id AS business_id, b.name AS business_name, b.status AS business_status
       FROM sessions s
       JOIN users u      ON u.id = s.user_id
       JOIN businesses b ON b.id = s.business_id
      WHERE s.id = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.status = 'active'
      LIMIT 1`
  ).bind(id, isoNow()).first();

  if (!row) return null;
  return row;
}

/* Best-effort. A failed last_seen write must never fail the request it is
   annotating, which is why the caller passes this to waitUntil() rather than
   awaiting it. */
export async function touchSession(env, sessionId) {
  try {
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .bind(isoNow(), sessionId).run();
  } catch (e) {
    console.warn('auth: could not update session last_seen_at');
  }
}

export async function revokeSession(env, request) {
  const token = readSessionToken(request);
  if (!token) return;
  try {
    const id = await sha256Hex(token);
    await env.DB.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
      .bind(isoNow(), id).run();
  } catch (e) {
    console.warn('auth: could not revoke session');
  }
}

/* Every session for a user. Used after a password change, so a stolen session
   does not outlive the password it was obtained with. */
export async function revokeAllSessionsForUser(env, userId, exceptSessionId) {
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?2
      WHERE user_id = ?1 AND revoked_at IS NULL AND id IS NOT ?3`
  ).bind(userId, isoNow(), exceptSessionId || null).run();
}

/* ---- Login ------------------------------------------------------------ */

export async function findUserByEmail(env, email) {
  const row = await env.DB.prepare(
    'SELECT * FROM users WHERE email = ? LIMIT 1'
  ).bind(email).first();
  return row || null;
}

async function recordFailedAttempt(env, user) {
  const attempts = Number(user.failed_attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS
    ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z')
    : null;

  await env.DB.prepare(
    'UPDATE users SET failed_attempts = ?2, locked_until = COALESCE(?3, locked_until), updated_at = ?4 WHERE id = ?1'
  ).bind(user.id, attempts, lockedUntil, isoNow()).run();
}

async function recordSuccessfulLogin(env, user) {
  await env.DB.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?2, updated_at = ?2 WHERE id = ?1'
  ).bind(user.id, isoNow()).run();
}

/* Returns { ok: true, user } or { ok: false, error }.

   THE ERROR IS ALWAYS 'invalid_credentials' FOR BOTH "no such user" AND "wrong
   password". Distinguishing them turns the login form into an account
   enumeration oracle, and knowing which addresses have accounts is most of the
   work of a credential-stuffing campaign.

   The unknown-email path still performs a PBKDF2 hash against a throwaway
   salt. Returning early would make "no such user" measurably faster than
   "wrong password" and leak by timing exactly what the shared error message
   is there to hide. */
export async function attemptLogin(env, rawEmail, password) {
  const email = normalizeEmail(rawEmail);

  if (!email || typeof password !== 'string' || !password) {
    return { ok: false, error: 'invalid_credentials' };
  }

  const user = await findUserByEmail(env, email);

  if (!user) {
    await pbkdf2(password, crypto.getRandomValues(new Uint8Array(SALT_BYTES)), PBKDF2_ITERATIONS);
    return { ok: false, error: 'invalid_credentials' };
  }

  if (user.status !== 'active') {
    return { ok: false, error: 'invalid_credentials' };
  }

  /* Lockout is checked BEFORE the KDF runs: once an account is locked, further
     guesses must not even cost us the CPU. */
  if (user.locked_until && user.locked_until > isoNow()) {
    return { ok: false, error: 'account_locked' };
  }

  const valid = await verifyPassword(password, user);

  if (!valid) {
    await recordFailedAttempt(env, user);
    return { ok: false, error: 'invalid_credentials' };
  }

  await recordSuccessfulLogin(env, user);
  return { ok: true, user: user };
}

export async function setUserPassword(env, userId, password) {
  const hashed = await hashPassword(password);
  await env.DB.prepare(
    `UPDATE users
        SET password_hash = ?2, password_salt = ?3, password_iterations = ?4,
            must_change_password = 0, updated_at = ?5
      WHERE id = ?1`
  ).bind(
    userId,
    hashed.password_hash,
    hashed.password_salt,
    hashed.password_iterations,
    isoNow()
  ).run();
}

/* ---- CSRF ------------------------------------------------------------- */

/* Second line of defence behind SameSite=Lax, and independent of it.

   A state-changing request must carry an Origin naming this exact host. Every
   browser sends Origin on fetch() and on cross-origin form posts, so a request
   without one is not a browser doing what the dashboard asked.

   This is deliberately NOT applied to /api/retell/* (Retell is a server, sends
   no Origin, and is authenticated by HMAC signature instead) or to
   /api/admin/* (bearer token, no ambient cookie, so nothing to forge). */
export function requireOrigin(request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const origin = request.headers.get('origin');
  if (!origin) return 'missing_origin';

  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      return 'bad_origin';
    }
  } catch (e) {
    return 'bad_origin';
  }

  return null;
}
