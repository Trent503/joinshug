/* Shug — end-to-end test suite.

   Usage:
     npx wrangler dev --port 8787        (in one terminal)
     node tests/run.mjs                  (in another)

   Runs against LOCAL D1 and KV. Needs no production credential and touches no
   production resource. It provisions its own throwaway tenants, exercises them,
   and deletes them at the end, so it can be run repeatedly.

   What it covers, and why each one is here rather than assumed:

     signatures      the event webhook writes to the database, so a forged
                     request reaching D1 is the worst failure in the system
     malformed input a webhook that 500s on bad JSON is a webhook Retell retries
                     forever
     dedupe          the single most visible product behaviour: a repeat caller
                     must not become a second lead
     metering        this is the billing number
     month boundary  a call at 5pm on the 31st in Portland is next month in UTC
     tenant isolation two customers on one database
     auth            wrong password, no session, expired session, CSRF
     provisioning    the thing that has to work on a sales call

   Every assertion is against observable behaviour through the HTTP API, except
   where the point is state the API deliberately does not expose (an expired
   session; a call in a past billing month), which is manufactured directly in
   local D1. */

import {
  BASE, devVars, sql, bustNumberCache, makeClient, retellSignature,
  group, check, checkEqual, summary, randomSuffix
} from './lib.mjs';

const vars = devVars();
const RETELL_KEY = vars.RETELL_API_KEY;
const ADMIN_TOKEN = vars.ADMIN_TOKEN;

if (!RETELL_KEY) { console.error('RETELL_API_KEY missing from .dev.vars'); process.exit(1); }
if (!ADMIN_TOKEN) { console.error('ADMIN_TOKEN missing from .dev.vars'); process.exit(1); }

const RUN = randomSuffix();
const admin = { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } };

/* Distinct numbers per run so repeated runs never collide on the UNIQUE
   phone_e164 constraint. */
const A_NUMBER = '+1503555' + String(1000 + Math.floor(Math.random() * 8999));
const B_NUMBER = '+1503555' + String(1000 + Math.floor(Math.random() * 8999));

const CALLER_1 = '+15035551111';
const CALLER_2 = '+15035552222';

const clientA = makeClient();
const clientB = makeClient();
const anon = makeClient();

let businessA = null;
let businessB = null;
let ownerA = null;
let ownerB = null;

/* ---- Retell helpers --------------------------------------------------- */

async function postWebhook(payload, options) {
  const opts = options || {};
  const raw = JSON.stringify(payload);

  const headers = { 'Content-Type': 'application/json' };

  if (opts.signature === 'omit') {
    /* nothing */
  } else if (opts.signature === 'invalid') {
    headers['X-Retell-Signature'] = await retellSignature(raw, 'the-wrong-key-entirely');
  } else if (opts.signature === 'stale') {
    /* Outside the 5-minute tolerance. Correctly computed, so this proves the
       tolerance check specifically and not just "a bad digest fails". */
    const stale = Date.now() - 10 * 60 * 1000;
    headers['X-Retell-Signature'] = await retellSignature(raw, RETELL_KEY, stale);
  } else if (typeof opts.signature === 'string') {
    headers['X-Retell-Signature'] = opts.signature;
  } else {
    headers['X-Retell-Signature'] = await retellSignature(raw, RETELL_KEY);
  }

  return fetch(BASE + (opts.path || '/api/retell/webhook'), {
    method: opts.method || 'POST',
    headers: headers,
    body: opts.rawBody !== undefined ? opts.rawBody : raw
  }).then(async function (r) {
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: r.status, body: body };
  });
}

function callPayload(overrides) {
  return Object.assign({
    call_id: 'test_call_' + RUN + '_' + Math.random().toString(36).slice(2, 8),
    from_number: CALLER_1,
    to_number: A_NUMBER,
    direction: 'inbound',
    start_timestamp: Date.now() - 120000,
    end_timestamp: Date.now(),
    duration_ms: 120000
  }, overrides || {});
}

/* Drives one call all the way through the lifecycle the way Retell would. */
async function runCall(options) {
  const opts = options || {};
  const call = callPayload(opts.call);

  await postWebhook({ event: 'call_started', call: call });
  await postWebhook({ event: 'call_ended', call: call });

  const analyzed = Object.assign({}, call, {
    transcript: opts.transcript || 'Agent: Thanks for calling. Caller: I need help.',
    call_analysis: Object.assign({
      call_summary: opts.summary || 'Caller requested service.',
      user_sentiment: 'Positive',
      call_successful: true,
      custom_analysis_data: opts.extraction || {}
    }, opts.analysis || {})
  });

  await postWebhook({ event: 'call_analyzed', call: analyzed });
  return call.call_id;
}

/* ---- 1. Provisioning -------------------------------------------------- */

async function testProvisioning() {
  group('1. Provisioning — a new customer live in one request');

  const noAuth = await anon.post('/api/admin/provision', { json: { name: 'X' } });
  checkEqual('rejects a request with no bearer token', noAuth.status, 401);

  const badAuth = await anon.post('/api/admin/provision', {
    json: { name: 'X' }, headers: { Authorization: 'Bearer wrong-token' }
  });
  checkEqual('rejects a wrong bearer token', badAuth.status, 401);

  const missing = await anon.post('/api/admin/provision', {
    json: { name: 'No Phone Co' }, headers: admin.headers
  });
  checkEqual('rejects a business with no phone number', missing.status, 400);

  const badEmail = await anon.post('/api/admin/provision', {
    json: { name: 'Bad Email Co', phone: A_NUMBER, ownerEmail: 'not-an-email' },
    headers: admin.headers
  });
  checkEqual('rejects a malformed owner email', badEmail.status, 400);

  const badTz = await anon.post('/api/admin/provision', {
    json: {
      name: 'Bad TZ Co', phone: A_NUMBER,
      ownerEmail: 'tz-' + RUN + '@example.com', timezone: 'Mars/Olympus_Mons'
    },
    headers: admin.headers
  });
  checkEqual('rejects an IANA timezone Intl cannot parse', badTz.status, 400);

  const a = await anon.post('/api/admin/provision', {
    json: {
      name: 'Rivera Plumbing ' + RUN,
      phone: A_NUMBER,
      timezone: 'America/Los_Angeles',
      trade: 'plumbing',
      ownerEmail: 'owner-a-' + RUN + '@example.com',
      ownerName: 'Ana Rivera',
      transferNumber: '+15035559000',
      notifySms: '+15035559000',
      status: 'active'
    },
    headers: admin.headers
  });

  checkEqual('provisions business A', a.status, 201);
  check('returns a generated password exactly once',
    Boolean(a.body && a.body.owner && a.body.owner.password &&
            a.body.owner.passwordWasGenerated));
  check('generated password avoids characters that are ambiguous aloud',
    Boolean(a.body && a.body.owner && !/[0O1lI5S2Z]/.test(a.body.owner.password)),
    'got ' + (a.body && a.body.owner && a.body.owner.password));
  check('derives a human-legible business id from the name',
    Boolean(a.body && a.body.business && /^rivera-plumbing/.test(a.body.business.id)),
    'got ' + (a.body && a.body.business && a.body.business.id));
  check('tells the operator the remaining manual Retell step',
    Boolean(a.body && a.body.nextStep && a.body.nextStep.includes('/api/retell/inbound')));

  businessA = a.body.business;
  ownerA = a.body.owner;

  const dup = await anon.post('/api/admin/provision', {
    json: {
      name: 'Someone Else', phone: A_NUMBER,
      ownerEmail: 'dup-' + RUN + '@example.com'
    },
    headers: admin.headers
  });
  checkEqual('refuses to provision the same number twice', dup.status, 409);
  check('names the business already holding that number',
    Boolean(dup.body && dup.body.business && dup.body.business.id === businessA.id));

  const dupEmail = await anon.post('/api/admin/provision', {
    json: {
      name: 'Another Co', phone: '+15035558888',
      ownerEmail: 'owner-a-' + RUN + '@example.com'
    },
    headers: admin.headers
  });
  checkEqual('refuses to reuse an owner email', dupEmail.status, 409);

  const b = await anon.post('/api/admin/provision', {
    json: {
      name: 'Delgado Roofing ' + RUN,
      phone: B_NUMBER,
      timezone: 'America/New_York',
      trade: 'roofing',
      ownerEmail: 'owner-b-' + RUN + '@example.com',
      status: 'active'
    },
    headers: admin.headers
  });
  checkEqual('provisions a second, independent business B', b.status, 201);
  businessB = b.body.business;
  ownerB = b.body.owner;

  const routing = sql(
    "SELECT business_id FROM phone_numbers WHERE e164 = '" + A_NUMBER + "'"
  );
  check('writes the phone_numbers routing row, not just businesses.phone_e164',
    routing.length === 1 && routing[0].business_id === businessA.id);
}

/* ---- 2. Auth ---------------------------------------------------------- */

async function testAuth() {
  group('2. Authentication');

  const noSession = await anon.get('/api/overview');
  checkEqual('no session → 401 on a dashboard route', noSession.status, 401);

  const wrongPassword = await clientA.post('/api/auth/login', {
    json: { email: ownerA.email, password: 'definitely-not-the-password' }
  });
  checkEqual('wrong password → 401', wrongPassword.status, 401);
  checkEqual('wrong password error is generic', wrongPassword.body.error, 'invalid_credentials');

  const unknownUser = await clientA.post('/api/auth/login', {
    json: { email: 'nobody-' + RUN + '@example.com', password: 'whatever-goes-here' }
  });
  checkEqual('unknown email → 401', unknownUser.status, 401);
  checkEqual('unknown email returns the SAME error as a wrong password ' +
    '(no account enumeration)', unknownUser.body.error, wrongPassword.body.error);

  const csrf = await clientA.post('/api/auth/login', {
    json: { email: ownerA.email, password: ownerA.password },
    origin: 'https://evil.example.com'
  });
  checkEqual('login from a foreign Origin is refused (CSRF)', csrf.status, 403);

  const login = await clientA.post('/api/auth/login', {
    json: { email: ownerA.email, password: ownerA.password }
  });
  checkEqual('correct password → 200', login.status, 200);
  check('sets a session cookie', clientA.cookies.size > 0);
  check('flags that a generated password must be changed',
    login.body.user.mustChangePassword === true);

  const cookieHeader = login.headers.get('set-cookie') || '';
  check('session cookie is HttpOnly', /HttpOnly/i.test(cookieHeader), cookieHeader);
  check('session cookie is SameSite=Lax', /SameSite=Lax/i.test(cookieHeader), cookieHeader);
  check('session cookie is not readable as a JWT payload',
    !/eyJ/.test(cookieHeader), cookieHeader);

  const me = await clientA.get('/api/auth/me');
  checkEqual('session authenticates /api/auth/me', me.status, 200);
  checkEqual('me returns the right business', me.body.business.id, businessA.id);

  /* The password verifier must never be a bare hash of the password. */
  const stored = sql("SELECT password_hash, password_salt, password_iterations " +
    "FROM users WHERE email = '" + ownerA.email + "'");
  check('password is stored with a per-user salt',
    Boolean(stored[0] && stored[0].password_salt && stored[0].password_salt.length >= 20));
  check('password uses a high PBKDF2 iteration count',
    Number(stored[0].password_iterations) >= 100000,
    'iterations = ' + (stored[0] && stored[0].password_iterations));

  /* REGRESSION GUARD. The Cloudflare Workers runtime rejects PBKDF2 above
     100,000 iterations; `wrangler dev` does not enforce that, so a higher
     value passes every test here and then throws on the first real request in
     production. It happened: 210,000 cleared 173 local assertions and failed
     on the first provisioning call against joinshug.com.

     This assertion is the only thing standing between that mistake and
     production, because the environment that would catch it honestly is the
     one the tests do not run in. */
  check('and stays at or below the Workers runtime ceiling of 100,000 — ' +
    'above it, logins throw in production and pass locally',
    Number(stored[0].password_iterations) <= 100000,
    'iterations = ' + (stored[0] && stored[0].password_iterations) +
    ' — this row can never verify on Cloudflare');
  check('stored hash is not a bare SHA-256 of the password',
    stored[0].password_hash.length > 40 && !/^[0-9a-f]{64}$/.test(stored[0].password_hash));

  /* The session token must not be recoverable from the database. */
  const cookieValue = Array.from(clientA.cookies.values())[0];
  const sessions = sql("SELECT id FROM sessions WHERE business_id = '" + businessA.id + "'");
  check('sessions table stores a hash, not the token itself',
    sessions.length > 0 && sessions.every(function (s) { return s.id !== cookieValue; }));

  await clientB.post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });
  const meB = await clientB.get('/api/auth/me');
  checkEqual('business B can sign in independently', meB.body.business.id, businessB.id);
}

async function testSessionExpiry() {
  group('3. Session expiry and revocation');

  const throwaway = makeClient();
  await throwaway.post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });

  const before = await throwaway.get('/api/auth/me');
  checkEqual('fresh session works', before.status, 200);

  /* Expire it in the database rather than waiting 30 days. The point is that
     the SQL guard on expires_at is what rejects it, not any client-side check. */
  sql("UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z' " +
      "WHERE business_id = '" + businessB.id + "' AND revoked_at IS NULL");

  const after = await throwaway.get('/api/auth/me');
  checkEqual('expired session → 401', after.status, 401);

  /* clientB's session was expired by the same statement; sign it back in. */
  clientB.clearCookies();
  await clientB.post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });

  const logoutClient = makeClient();
  await logoutClient.post('/api/auth/login', {
    json: { email: ownerA.email, password: ownerA.password }
  });
  checkEqual('second session for A works',
    (await logoutClient.get('/api/auth/me')).status, 200);

  await logoutClient.post('/api/auth/logout');
  checkEqual('after logout the session is dead',
    (await logoutClient.get('/api/auth/me')).status, 401);

  /* Revocation must be server-side: replaying the cookie after logout must
     also fail, which a stateless token could not guarantee. */
  const replay = await fetch(BASE + '/api/auth/me', {
    headers: { Cookie: 'shug_session=' + (Array.from(logoutClient.cookies.values())[0] || 'gone') }
  });
  checkEqual('a replayed post-logout cookie is refused', replay.status, 401);
}

/* ---- 4. Webhook signatures -------------------------------------------- */

async function testSignatures() {
  group('4. Retell webhook signature verification');

  const call = callPayload();

  const missing = await postWebhook({ event: 'call_started', call: call }, { signature: 'omit' });
  checkEqual('unsigned request → 401', missing.status, 401);
  checkEqual('unsigned request is not written to the database',
    sql("SELECT COUNT(*) AS n FROM calls WHERE retell_call_id = '" + call.call_id + "'")[0].n, 0);

  const invalid = await postWebhook({ event: 'call_started', call: call }, { signature: 'invalid' });
  checkEqual('signature from the wrong key → 401', invalid.status, 401);

  const malformedSig = await postWebhook({ event: 'call_started', call: call },
    { signature: 'not-even-the-right-shape' });
  checkEqual('malformed signature header → 401', malformedSig.status, 401);

  const stale = await postWebhook({ event: 'call_started', call: call }, { signature: 'stale' });
  checkEqual('correctly signed but 10 minutes old → 401 (replay window)', stale.status, 401);

  const tampered = await postWebhook({ event: 'call_started', call: call }, {
    signature: await retellSignature(JSON.stringify({ event: 'call_started', call: call }), RETELL_KEY),
    rawBody: JSON.stringify({ event: 'call_started', call: callPayload({ duration_ms: 999999 }) })
  });
  checkEqual('body tampered after signing → 401', tampered.status, 401);

  const valid = await postWebhook({ event: 'call_started', call: call });
  checkEqual('correctly signed request → 200', valid.status, 200);
  checkEqual('correctly signed request IS written',
    sql("SELECT COUNT(*) AS n FROM calls WHERE retell_call_id = '" + call.call_id + "'")[0].n, 1);
}

/* ---- 5. Malformed input and wrong methods ----------------------------- */

async function testMalformed() {
  group('5. Malformed requests and wrong methods');

  const notJson = await postWebhook(null, {
    rawBody: 'this is not json at all',
    signature: await retellSignature('this is not json at all', RETELL_KEY)
  });
  checkEqual('unparseable body → 400, not 500', notJson.status, 400);

  const noEvent = await postWebhook({ call: callPayload() });
  checkEqual('missing event field → 400', noEvent.status, 400);

  const noCall = await postWebhook({ event: 'call_ended' });
  checkEqual('missing call object → 400', noCall.status, 400);

  const unknownEvent = await postWebhook({ event: 'something_new', call: callPayload() });
  checkEqual('unknown event → 200 (acknowledged, not retried forever)', unknownEvent.status, 200);

  const transcript = await postWebhook({ event: 'transcript_updated', call: callPayload() });
  checkEqual('transcript_updated → 200 and ignored', transcript.status, 200);

  const transfer = await postWebhook({ event: 'transfer_started', call: callPayload() });
  checkEqual('transfer_* → 200 and logged only', transfer.status, 200);

  const wrongMethod = await fetch(BASE + '/api/retell/webhook', { method: 'DELETE' });
  checkEqual('DELETE on the webhook → 405', wrongMethod.status, 405);
  check('405 says which methods ARE allowed',
    Boolean(wrongMethod.headers.get('allow')),
    'Allow: ' + wrongMethod.headers.get('allow'));

  const patchOverview = await clientA.raw('PUT', '/api/overview', {});
  checkEqual('PUT on a GET-only endpoint → 405', patchOverview.status, 405);

  const unknownRoute = await anon.get('/api/does/not/exist');
  checkEqual('unknown API route → 404', unknownRoute.status, 404);

  const badJsonBody = await clientA.raw('PATCH', '/api/settings', {
    body: '{ not valid json',
    headers: { 'Content-Type': 'application/json', Origin: BASE }
  });
  checkEqual('malformed JSON on an authenticated route → 400', badJsonBody.status, 400);

  const arrayBody = await clientA.patch('/api/settings', { json: ['not', 'an', 'object'] });
  checkEqual('JSON array where an object is required → 400', arrayBody.status, 400);
}

/* ---- 6. Unknown numbers and unattributed calls ------------------------ */

async function testUnknownNumbers() {
  group('6. Unknown numbers and missing attribution');

  const raw = JSON.stringify({
    event: 'call_inbound',
    call_inbound: { from_number: CALLER_1, to_number: '+15559999999' }
  });
  const inbound = await fetch(BASE + '/api/retell/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Retell-Signature': await retellSignature(raw, RETELL_KEY)
    },
    body: raw
  });
  const inboundBody = await inbound.json();
  checkEqual('inbound call to an unknown number → 200', inbound.status, 200);
  check('unknown number passes through to the default agent rather than failing',
    inboundBody.call_inbound && !inboundBody.call_inbound.reject &&
    !inboundBody.call_inbound.dynamic_variables,
    JSON.stringify(inboundBody));

  const knownRaw = JSON.stringify({
    event: 'call_inbound',
    call_inbound: { from_number: CALLER_1, to_number: A_NUMBER }
  });
  const known = await fetch(BASE + '/api/retell/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Retell-Signature': await retellSignature(knownRaw, RETELL_KEY)
    },
    body: knownRaw
  });
  const knownBody = await known.json();
  check('a known number returns that business\'s dynamic variables',
    Boolean(knownBody.call_inbound && knownBody.call_inbound.dynamic_variables &&
            knownBody.call_inbound.dynamic_variables.business_name));
  check('and rides business_id along in metadata for later events',
    knownBody.call_inbound.metadata &&
    knownBody.call_inbound.metadata.business_id === businessA.id);
  check('every dynamic variable is a string, as Retell requires',
    Object.values(knownBody.call_inbound.dynamic_variables)
      .every(function (v) { return typeof v === 'string'; }));

  /* A number-formatting mismatch must still resolve — this is the single
     easiest way for the system to be quietly broken in production. */
  const messyRaw = JSON.stringify({
    event: 'call_inbound',
    call_inbound: {
      from_number: CALLER_1,
      to_number: A_NUMBER.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')
    }
  });
  const messy = await fetch(BASE + '/api/retell/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Retell-Signature': await retellSignature(messyRaw, RETELL_KEY)
    },
    body: messyRaw
  });
  const messyBody = await messy.json();
  check('a number sent as "(503) 555-1234" still resolves to the business',
    Boolean(messyBody.call_inbound && messyBody.call_inbound.metadata &&
            messyBody.call_inbound.metadata.business_id === businessA.id));

  const orphanId = 'orphan_' + RUN;
  await postWebhook({
    event: 'call_analyzed',
    call: callPayload({
      call_id: orphanId,
      to_number: '+15559999999',
      call_analysis: { call_summary: 'x', custom_analysis_data: { name: 'Nobody' } }
    })
  });
  const orphanLeads = sql("SELECT COUNT(*) AS n FROM leads WHERE name = 'Nobody'");
  checkEqual('a call with no resolvable business creates no lead', orphanLeads[0].n, 0);
  const orphanCall = sql("SELECT business_id FROM calls WHERE retell_call_id = '" + orphanId + "'");
  check('but the call itself is still recorded, unattributed',
    orphanCall.length === 1 && orphanCall[0].business_id === null);
}

/* ---- 7. Lead capture and dedupe --------------------------------------- */

async function testLeadDedupe() {
  group('7. Lead capture and the repeat-caller dedupe');

  await runCall({
    call: { from_number: CALLER_1, to_number: A_NUMBER },
    extraction: {
      name: 'Marcus Webb',
      address: '812 SE Ash St, Portland OR',
      job_description: 'Water heater is leaking into the garage',
      urgency: 'today',
      service: 'water heater'
    }
  });

  const leads1 = await clientA.get('/api/leads');
  const marcus = leads1.body.leads.filter(function (l) { return l.name === 'Marcus Webb'; });
  checkEqual('a call with real content creates exactly one lead', marcus.length, 1);
  checkEqual('the lead is normalised to E.164', marcus[0].phone, CALLER_1);
  checkEqual('the lead starts as "new"', marcus[0].status, 'new');
  checkEqual('the lead records one call', marcus[0].call_count, 1);

  /* SAME caller, SAME business, second call. */
  await runCall({
    call: { from_number: CALLER_1, to_number: A_NUMBER },
    extraction: {
      name: 'Marcus Webb',
      job_description: 'Following up about the water heater',
      preferred_time: 'tomorrow morning'
    }
  });

  const leads2 = await clientA.get('/api/leads');
  const marcusAgain = leads2.body.leads.filter(function (l) { return l.phone === CALLER_1; });
  checkEqual('the SAME caller calling again does NOT create a second lead',
    marcusAgain.length, 1);
  checkEqual('the existing lead now shows two calls', marcusAgain[0].call_count, 2);
  checkEqual('a field the second call did not mention is preserved',
    marcusAgain[0].address, '812 SE Ash St, Portland OR');
  checkEqual('a field only the second call supplied is filled in',
    marcusAgain[0].preferred_time, 'tomorrow morning');

  /* The same NUMBER written differently must still be the same person. */
  await runCall({
    call: { from_number: '(503) 555-1111', to_number: A_NUMBER },
    extraction: { name: 'Marcus Webb', job_description: 'third call' }
  });
  const leads3 = await clientA.get('/api/leads');
  checkEqual('the same number in a different FORMAT is still the same lead',
    leads3.body.leads.filter(function (l) { return l.phone === CALLER_1; }).length, 1);
  checkEqual('and the call count reaches three',
    leads3.body.leads.filter(function (l) { return l.phone === CALLER_1; })[0].call_count, 3);

  /* A DIFFERENT caller is a different lead. */
  await runCall({
    call: { from_number: CALLER_2, to_number: A_NUMBER },
    extraction: { name: 'Dana Cole', job_description: 'Blocked kitchen drain' }
  });
  const leads4 = await clientA.get('/api/leads');
  checkEqual('a different caller IS a separate lead',
    leads4.body.leads.filter(function (l) { return l.phone === CALLER_2; }).length, 1);

  /* Owner judgement must survive a repeat call. */
  const dana = leads4.body.leads.filter(function (l) { return l.phone === CALLER_2; })[0];
  await clientA.patch('/api/leads/' + dana.id, { json: { status: 'qualified', notes: 'Priced at $340' } });
  await runCall({
    call: { from_number: CALLER_2, to_number: A_NUMBER },
    extraction: { name: 'Dana Cole', job_description: 'calling back' }
  });
  const danaAfter = await clientA.get('/api/leads/' + dana.id);
  checkEqual('a repeat call does NOT reset a status the owner set',
    danaAfter.body.lead.status, 'qualified');
  checkEqual('and does not touch the owner\'s notes',
    danaAfter.body.lead.notes, 'Priced at $340');

  /* But a lead that was CLOSED and calls again is a new job. */
  await clientA.patch('/api/leads/' + dana.id, { json: { status: 'lost' } });
  await runCall({
    call: { from_number: CALLER_2, to_number: A_NUMBER },
    extraction: { name: 'Dana Cole', job_description: 'new job entirely' }
  });
  const danaReopened = await clientA.get('/api/leads/' + dana.id);
  checkEqual('a CLOSED lead calling back reopens as "new"',
    danaReopened.body.lead.status, 'new');

  /* Spam and voicemail must not become work. */
  const spamId = await runCall({
    call: { from_number: '+15035557777', to_number: A_NUMBER },
    extraction: {}
  });
  const spamLead = sql("SELECT COUNT(*) AS n FROM leads WHERE business_id = '" +
    businessA.id + "' AND phone = '+15035557777'");
  checkEqual('a call with no extractable content produces no lead', spamLead[0].n, 0);
  checkEqual('but the call is still billed',
    sql("SELECT COUNT(*) AS n FROM calls WHERE retell_call_id = '" + spamId + "'")[0].n, 1);

  await runCall({
    call: { from_number: '+15035556666', to_number: A_NUMBER },
    extraction: { name: 'Voicemail Greeting', job_description: 'leave a message' },
    analysis: { in_voicemail: true }
  });
  checkEqual('voicemail produces no lead even when fields extract',
    sql("SELECT COUNT(*) AS n FROM leads WHERE phone = '+15035556666'")[0].n, 0);

  /* Idempotency: replaying the same analysis must not duplicate anything. */
  const replayCall = callPayload({ from_number: '+15035554444', to_number: A_NUMBER });
  const analyzed = {
    event: 'call_analyzed',
    call: Object.assign({}, replayCall, {
      call_analysis: {
        call_summary: 'Replay test',
        custom_analysis_data: { name: 'Replay Person', job_description: 'gutter cleaning' }
      }
    })
  };
  await postWebhook({ event: 'call_ended', call: replayCall });
  await postWebhook(analyzed);
  await postWebhook(analyzed);
  await postWebhook(analyzed);

  const replayLeads = sql("SELECT call_count FROM leads WHERE phone = '+15035554444'");
  checkEqual('three identical call_analyzed deliveries create one lead', replayLeads.length, 1);
  checkEqual('and the call count is 1, not 3 (rollup is recomputed, not incremented)',
    replayLeads[0].call_count, 1);
}

/* ---- 8. Metering ------------------------------------------------------ */

async function testMetering() {
  group('8. Minute metering');

  const usage = await clientA.get('/api/usage');
  checkEqual('usage endpoint answers', usage.status, 200);
  checkEqual('allowance is the 120 minutes /pricing/ promises',
    usage.body.usage.minutesIncluded, 120);

  const seconds = sql("SELECT COALESCE(SUM(duration_sec),0) AS s FROM calls " +
    "WHERE business_id = '" + businessA.id + "' AND billed_month = '" +
    usage.body.usage.month + "'")[0].s;

  checkEqual('reported seconds match SUM(duration_sec) exactly',
    usage.body.usage.secondsUsed, Number(seconds));
  checkEqual('minutes are the monthly total rounded UP',
    usage.body.usage.minutesUsed, Math.ceil(Number(seconds) / 60));
  checkEqual('remaining is included minus used',
    usage.body.usage.minutesRemaining,
    Math.max(0, 120 - usage.body.usage.minutesUsed));
  checkEqual('percent is used/included',
    usage.body.usage.percentUsed,
    Math.min(100, Math.round((usage.body.usage.minutesUsed / 120) * 100)));

  /* Rounding is on the MONTHLY total, not per call: six ten-second hangups
     must cost one minute, not six. */
  const roundingBusiness = businessA.id;
  const before = await clientA.get('/api/usage');
  for (let i = 0; i < 6; i++) {
    const c = callPayload({ to_number: A_NUMBER, duration_ms: 10000 });
    await postWebhook({ event: 'call_ended', call: c });
  }
  const after = await clientA.get('/api/usage');
  checkEqual('six 10-second calls add 60 seconds',
    after.body.usage.secondsUsed - before.body.usage.secondsUsed, 60);
  check('and add at most one minute to the bill (not six)',
    after.body.usage.minutesUsed - before.body.usage.minutesUsed <= 1,
    'delta was ' + (after.body.usage.minutesUsed - before.body.usage.minutesUsed));

  /* Billing period boundary. A call ending at 5pm PST on the 31st is 01:00 UTC
     on the 1st; billing it to the UTC month would be wrong. */
  const boundaryCall = 'boundary_' + RUN;
  sql("INSERT INTO calls (retell_call_id, business_id, duration_sec, billed_month, " +
      "started_at, ended_at, direction) VALUES ('" + boundaryCall + "', '" +
      roundingBusiness + "', 600, '2026-07', '2026-08-01T00:30:00Z', '2026-08-01T00:40:00Z', 'inbound')");

  const july = await clientA.get('/api/usage?month=2026-07');
  checkEqual('a past month can be queried', july.status, 200);
  checkEqual('and returns only that month\'s minutes', july.body.usage.minutesUsed, 10);
  checkEqual('this month is unaffected by the July row',
    (await clientA.get('/api/usage')).body.usage.secondsUsed, after.body.usage.secondsUsed);

  const badMonth = await clientA.get('/api/usage?month=2026-13');
  checkEqual('an impossible month → 400', badMonth.status, 400);
  const badMonthShape = await clientA.get('/api/usage?month=nonsense');
  checkEqual('a malformed month → 400', badMonthShape.status, 400);

  /* Overage must be reported, not silently clamped. */
  sql("INSERT INTO calls (retell_call_id, business_id, duration_sec, billed_month, direction) " +
      "VALUES ('overage_" + RUN + "', '" + businessB.id + "', 9000, '" +
      (await clientB.get('/api/usage')).body.usage.month + "', 'inbound')");
  const over = await clientB.get('/api/usage');
  check('usage past the allowance reports overage', over.body.usage.overage === true);
  checkEqual('overage minutes are reported', over.body.usage.overageMinutes,
    over.body.usage.minutesUsed - 120);
  checkEqual('remaining floors at zero rather than going negative',
    over.body.usage.minutesRemaining, 0);
  checkEqual('percent caps at 100', over.body.usage.percentUsed, 100);

  /* The billed month itself must come from the BUSINESS's timezone. B is
     America/New_York, A is America/Los_Angeles. */
  const monthA = (await clientA.get('/api/usage')).body.usage.month;
  const monthB = (await clientB.get('/api/usage')).body.usage.month;
  check('each business gets a month computed in its own timezone',
    /^\d{4}-\d{2}$/.test(monthA) && /^\d{4}-\d{2}$/.test(monthB));
}

/* ---- 9. Bookings, follow-ups, notifications --------------------------- */

async function testRecords() {
  group('9. Bookings, follow-ups and notifications');

  const leads = await clientA.get('/api/leads');
  const lead = leads.body.leads[0];

  const booking = await clientA.post('/api/leads/' + lead.id + '/bookings', {
    json: { date: '2026-09-14', start_time: '09:00', end_time: '11:00', service: 'Water heater swap' }
  });
  checkEqual('a booking can be created against a lead', booking.status, 201);
  checkEqual('it defaults to "requested", not "confirmed"', booking.body.booking.status, 'requested');
  checkEqual('destination defaults to internal (the seam for Jobber/GHL later)',
    booking.body.booking.destination, 'internal');

  const leadAfterBooking = await clientA.get('/api/leads/' + lead.id);
  checkEqual('booking a lead moves it to "booked"', leadAfterBooking.body.lead.status, 'booked');
  checkEqual('the booking renders inside lead detail', leadAfterBooking.body.bookings.length, 1);

  const badDate = await clientA.post('/api/leads/' + lead.id + '/bookings', {
    json: { date: 'next tuesday' }
  });
  checkEqual('a non-calendar date is rejected rather than guessed', badDate.status, 400);

  const badTime = await clientA.post('/api/leads/' + lead.id + '/bookings', {
    json: { date: '2026-09-14', start_time: '25:00' }
  });
  checkEqual('an impossible time is rejected', badTime.status, 400);

  const confirmed = await clientA.patch('/api/bookings/' + booking.body.booking.id, {
    json: { status: 'confirmed' }
  });
  checkEqual('a booking can be confirmed', confirmed.body.booking.status, 'confirmed');

  const completed = await clientA.patch('/api/bookings/' + booking.body.booking.id, {
    json: { status: 'completed' }
  });
  checkEqual('completing the booking completes the lead',
    (await clientA.get('/api/leads/' + lead.id)).body.lead.status, 'completed');

  const followUp = await clientA.post('/api/leads/' + lead.id + '/follow-ups', {
    json: {
      scheduled_for: new Date(Date.now() - 3600000).toISOString(),
      type: 'call',
      notes: 'Check the install held'
    }
  });
  checkEqual('a follow-up can be created', followUp.status, 201);
  checkEqual('it starts pending', followUp.body.followUp.status, 'pending');

  const badType = await clientA.post('/api/leads/' + lead.id + '/follow-ups', {
    json: { scheduled_for: new Date().toISOString(), type: 'carrier_pigeon' }
  });
  checkEqual('an unknown follow-up type is rejected', badType.status, 400);

  const badWhen = await clientA.post('/api/leads/' + lead.id + '/follow-ups', {
    json: { scheduled_for: 'sometime', type: 'call' }
  });
  checkEqual('an unparseable scheduled_for is rejected', badWhen.status, 400);

  const overview = await clientA.get('/api/overview');
  check('a past-due follow-up shows on the overview',
    overview.body.counts.followUpsDue >= 1,
    'followUpsDue = ' + overview.body.counts.followUpsDue);

  /* A follow-up scheduled for the future must NOT be counted as due. */
  await clientA.post('/api/leads/' + lead.id + '/follow-ups', {
    json: { scheduled_for: new Date(Date.now() + 7 * 86400000).toISOString(), type: 'sms' }
  });
  const overview2 = await clientA.get('/api/overview');
  checkEqual('a follow-up scheduled for next week is NOT counted as due',
    overview2.body.counts.followUpsDue, overview.body.counts.followUpsDue);

  const doneFollowUp = await clientA.patch('/api/follow-ups/' + followUp.body.followUp.id, {
    json: { status: 'completed' }
  });
  checkEqual('a follow-up can be completed', doneFollowUp.body.followUp.status, 'completed');
  check('and completed_at is stamped from the status, not the client',
    Boolean(doneFollowUp.body.followUp.completed_at));

  /* Notifications. */
  const notifications = sql("SELECT channel, status, error, body FROM notifications " +
    "WHERE business_id = '" + businessA.id + "' ORDER BY created_at DESC LIMIT 5");
  check('every completed call queues an owner notification', notifications.length > 0,
    'found ' + notifications.length);
  check('the notification body names the caller and their number',
    notifications.some(function (n) { return /New call:/.test(n.body || ''); }),
    JSON.stringify(notifications[0] || null));

  const drain = await anon.post('/api/admin/notifications', { headers: admin.headers });
  checkEqual('the queue can be drained', drain.status, 200);
  check('with no SMS provider configured, sends are SKIPPED, not failed',
    drain.body.drained.failed === 0,
    JSON.stringify(drain.body.drained));

  const afterDrain = sql("SELECT status, error FROM notifications WHERE business_id = '" +
    businessA.id + "' AND status = 'skipped' LIMIT 3");
  check('and the reason recorded is "no_provider", not a pretend success',
    afterDrain.some(function (n) { return n.error === 'no_provider' || n.error === 'no_target'; }),
    JSON.stringify(afterDrain));

  /* A business with NO notification target must still get a notification row,
     and that row must still be attached to its lead.

     Business B was provisioned without notifySms or notifyEmail, so its rows
     are written straight to 'skipped'. An earlier version only filled in
     lead_id for rows still 'queued', which left these orphaned and invisible on
     the lead page — "we had nowhere to send this" looked identical to "nothing
     was attempted". Caught in production, not here, because business A in this
     suite HAS a target and covered the other branch. */
  {
    const bPhone = '+15085550777';
    const noTargetCall = callPayload({ to_number: B_NUMBER, from_number: bPhone });
    await postWebhook({ event: 'call_ended', call: noTargetCall });
    await postWebhook({
      event: 'call_analyzed',
      call: Object.assign({}, noTargetCall, {
        call_analysis: {
          call_summary: 'Caller with no owner notification target configured.',
          custom_analysis_data: { name: 'No Target Caller', job_description: 'roof leak' }
        }
      })
    });

    const orphan = sql("SELECT n.status, n.error, n.lead_id FROM notifications n " +
      "WHERE n.call_id = '" + noTargetCall.call_id + "'");
    check('a business with no notification target still gets a notification row',
      orphan.length === 1, JSON.stringify(orphan));
    checkEqual('recorded as skipped, not failed', orphan[0] && orphan[0].status, 'skipped');
    checkEqual('with the reason stated plainly', orphan[0] && orphan[0].error, 'no_target');
    check('AND it is attached to the lead, so the owner can see it was attempted',
      Boolean(orphan[0] && orphan[0].lead_id),
      'lead_id = ' + JSON.stringify(orphan[0] && orphan[0].lead_id));
  }

  /* One call must never text the owner twice. */
  const dupCall = callPayload({ to_number: A_NUMBER, from_number: '+15035553333' });
  await postWebhook({ event: 'call_ended', call: dupCall });
  await postWebhook({ event: 'call_ended', call: dupCall });
  await postWebhook({ event: 'call_ended', call: dupCall });
  const dupNotifications = sql("SELECT COUNT(*) AS n FROM notifications WHERE call_id = '" +
    dupCall.call_id + "' AND channel = 'sms'");
  checkEqual('a retried call_ended does not queue a second notification', dupNotifications[0].n, 1);
}

/* ---- 10. Tenant isolation --------------------------------------------- */

async function testTenantIsolation() {
  group('10. Tenant isolation — A must never see B');

  const leadsA = await clientA.get('/api/leads');
  const leadsB = await clientB.get('/api/leads');

  check('A sees its own leads', leadsA.body.leads.length > 0);

  const idsA = new Set(leadsA.body.leads.map(function (l) { return l.id; }));
  const idsB = new Set(leadsB.body.leads.map(function (l) { return l.id; }));
  check('A and B share no lead ids',
    Array.from(idsA).every(function (id) { return !idsB.has(id); }));

  /* Create something in B, then try to reach it as A. */
  const bLead = await clientB.post('/api/leads', {
    json: { name: 'B Only Customer', phone: '+15085550001', service: 'roof inspection' }
  });
  checkEqual('B can create its own lead', bLead.status, 201);
  const bLeadId = bLead.body.lead.id;

  const stolenRead = await clientA.get('/api/leads/' + bLeadId);
  checkEqual('A reading B\'s lead by id → 404', stolenRead.status, 404);

  const stolenWrite = await clientA.patch('/api/leads/' + bLeadId, {
    json: { status: 'lost', notes: 'hijacked' }
  });
  checkEqual('A writing to B\'s lead → 404', stolenWrite.status, 404);

  const stillIntact = await clientB.get('/api/leads/' + bLeadId);
  checkEqual('B\'s lead is untouched', stillIntact.body.lead.status, 'new');
  checkEqual('and its notes were not written', stillIntact.body.lead.notes, null);

  const bBooking = await clientB.post('/api/leads/' + bLeadId + '/bookings', {
    json: { date: '2026-10-01', start_time: '13:00' }
  });
  const stolenBooking = await clientA.patch('/api/bookings/' + bBooking.body.booking.id, {
    json: { status: 'cancelled' }
  });
  checkEqual('A cancelling B\'s booking → 404', stolenBooking.status, 404);

  const bFollowUp = await clientB.post('/api/leads/' + bLeadId + '/follow-ups', {
    json: { scheduled_for: new Date().toISOString(), type: 'call' }
  });
  const stolenFollowUp = await clientA.patch('/api/follow-ups/' + bFollowUp.body.followUp.id, {
    json: { status: 'cancelled' }
  });
  checkEqual('A cancelling B\'s follow-up → 404', stolenFollowUp.status, 404);

  const bCalls = await clientB.get('/api/calls');
  const aCalls = await clientA.get('/api/calls');
  const bCallIds = new Set(bCalls.body.calls.map(function (c) { return c.retell_call_id; }));
  check('A and B share no call records',
    aCalls.body.calls.every(function (c) { return !bCallIds.has(c.retell_call_id); }));

  if (bCalls.body.calls.length > 0) {
    const stolenCall = await clientA.get('/api/calls/' + bCalls.body.calls[0].retell_call_id);
    checkEqual('A reading B\'s call by id → 404', stolenCall.status, 404);
  }

  /* A body field named business_id must be ignored entirely. */
  const injected = await clientA.post('/api/leads', {
    json: { name: 'Injection Attempt', phone: '+15085559999', business_id: businessB.id }
  });
  checkEqual('creating a lead with a forged business_id succeeds...', injected.status, 201);
  const injectedRow = sql("SELECT business_id FROM leads WHERE phone = '+15085559999'");
  checkEqual('...but it lands in A\'s tenant, not the one the body asked for',
    injectedRow[0].business_id, businessA.id);

  const settingsB = await clientB.get('/api/settings');
  checkEqual('B\'s settings are B\'s', settingsB.body.settings.id, businessB.id);
  const settingsA = await clientA.get('/api/settings');
  checkEqual('A\'s settings are A\'s', settingsA.body.settings.id, businessA.id);

  const overviewA = await clientA.get('/api/overview');
  const overviewB = await clientB.get('/api/overview');
  checkEqual('overviews are scoped per tenant', overviewA.body.business.id, businessA.id);
  checkEqual('overviews are scoped per tenant (B)', overviewB.body.business.id, businessB.id);
}

/* ---- 11. Settings ----------------------------------------------------- */

async function testSettings() {
  group('11. Settings');

  const patched = await clientA.patch('/api/settings', {
    json: { transfer_number: '(503) 555-7788', notify_email: 'Owner@Example.COM ' }
  });
  checkEqual('settings can be updated', patched.status, 200);
  checkEqual('a transfer number is normalised to E.164',
    patched.body.settings.transferNumber, '+15035557788');
  checkEqual('a notification email is lower-cased and trimmed',
    patched.body.settings.notifyEmail, 'owner@example.com');

  const badEmail = await clientA.patch('/api/settings', { json: { notify_email: 'not an address' } });
  checkEqual('an unusable notification email is rejected, not silently blanked',
    badEmail.status, 400);
  checkEqual('and the previous address survives the rejection',
    (await clientA.get('/api/settings')).body.settings.notifyEmail, 'owner@example.com');

  const blankName = await clientA.patch('/api/settings', { json: { name: '   ' } });
  checkEqual('the business name cannot be blanked (it is spoken on every call)',
    blankName.status, 400);

  const badTz = await clientA.patch('/api/settings', { json: { timezone: 'Nowhere/Nothing' } });
  checkEqual('an invalid timezone is rejected', badTz.status, 400);

  const ignored = await clientA.patch('/api/settings', {
    json: { minutes_included: 99999, status: 'active', id: 'hijack' }
  });
  checkEqual('fields outside the allow-list are ignored, not applied', ignored.status, 200);
  checkEqual('minutes_included is not client-writable',
    ignored.body.settings.minutesIncluded, 120);
  checkEqual('the business id is not client-writable',
    ignored.body.settings.id, businessA.id);

  const noSessionPatch = await anon.patch('/api/settings', { json: { name: 'Nope' } });
  checkEqual('settings cannot be changed without a session', noSessionPatch.status, 401);
}

/* ---- 12. Password change ---------------------------------------------- */

async function testPasswordChange() {
  group('12. Password change');

  const client = makeClient();
  await client.post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });

  const short = await client.post('/api/auth/password', {
    json: { currentPassword: ownerB.password, newPassword: 'short' }
  });
  checkEqual('a too-short password is rejected', short.status, 400);

  const wrongCurrent = await client.post('/api/auth/password', {
    json: { currentPassword: 'not-the-current-one', newPassword: 'a-perfectly-fine-new-password' }
  });
  checkEqual('the CURRENT password is required, even with a valid session',
    wrongCurrent.status, 401);

  /* A second session, to prove the others are revoked. */
  const other = makeClient();
  await other.post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });
  checkEqual('the second session is live before the change',
    (await other.get('/api/auth/me')).status, 200);

  const newPassword = 'a-perfectly-fine-new-password';
  const changed = await client.post('/api/auth/password', {
    json: { currentPassword: ownerB.password, newPassword: newPassword }
  });
  checkEqual('the password can be changed', changed.status, 200);

  checkEqual('the changing session stays signed in',
    (await client.get('/api/auth/me')).status, 200);
  checkEqual('every OTHER session is revoked', (await other.get('/api/auth/me')).status, 401);

  const oldPassword = await makeClient().post('/api/auth/login', {
    json: { email: ownerB.email, password: ownerB.password }
  });
  checkEqual('the old password no longer works', oldPassword.status, 401);

  const relogin = makeClient();
  const withNew = await relogin.post('/api/auth/login', {
    json: { email: ownerB.email, password: newPassword }
  });
  checkEqual('the new password works', withNew.status, 200);
  check('and mustChangePassword is now cleared',
    withNew.body.user.mustChangePassword === false);

  ownerB.password = newPassword;
  clientB.clearCookies();
  await clientB.post('/api/auth/login', { json: { email: ownerB.email, password: newPassword } });
}

/* ---- 13. Lockout ------------------------------------------------------ */

async function testLockout() {
  group('13. Online-guessing lockout');

  const target = await fetch(BASE + '/api/admin/provision', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Origin: BASE }, admin.headers),
    body: JSON.stringify({
      name: 'Lockout Test ' + RUN,
      phone: '+1503555' + String(2000 + Math.floor(Math.random() * 900)),
      ownerEmail: 'lockout-' + RUN + '@example.com'
    })
  }).then(function (r) { return r.json(); });

  const email = target.owner.email;
  const client = makeClient();

  let sawLock = false;
  for (let i = 0; i < 10; i++) {
    const attempt = await client.post('/api/auth/login', {
      json: { email: email, password: 'wrong-guess-number-' + i }
    });
    if (attempt.status === 423) { sawLock = true; break; }
  }
  check('repeated wrong passwords lock the account', sawLock);

  const correctButLocked = await client.post('/api/auth/login', {
    json: { email: email, password: target.owner.password }
  });
  checkEqual('even the CORRECT password is refused while locked',
    correctButLocked.status, 423);

  sql("UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE email = '" + email + "'");
  const afterUnlock = await client.post('/api/auth/login', {
    json: { email: email, password: target.owner.password }
  });
  checkEqual('and works again once the lockout expires', afterUnlock.status, 200);

  sql("DELETE FROM businesses WHERE id = '" + target.business.id + "'");
}

/* ---- 14. Suspension --------------------------------------------------- */

async function testSuspension() {
  group('14. Suspended account behaviour');

  sql("UPDATE businesses SET status = 'suspended' WHERE id = '" + businessB.id + "'");

  /* The number -> business lookup is cached in KV for 300 seconds, so a status
     changed by direct SQL does not reach live calls until the entry expires.
     That is the documented, deliberate trade — the inbound webhook is on the
     path of every ringing phone — and an operator suspending a customer has to
     do this same bust for it to take effect now rather than in five minutes.
     Doing it here makes the test match the real procedure instead of quietly
     depending on the cache being cold. */
  bustNumberCache(B_NUMBER);

  const read = await clientB.get('/api/overview');
  checkEqual('a suspended business can still READ its own data', read.status, 200);

  const write = await clientB.patch('/api/settings', { json: { name: 'Renamed While Suspended' } });
  checkEqual('but cannot write (402, a billing state)', write.status, 402);

  /* And the phone must stop answering. */
  const raw = JSON.stringify({
    event: 'call_inbound',
    call_inbound: { from_number: CALLER_1, to_number: B_NUMBER }
  });
  const inbound = await fetch(BASE + '/api/retell/inbound', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Retell-Signature': await retellSignature(raw, RETELL_KEY)
    },
    body: raw
  });
  const body = await inbound.json();
  check('a call to a suspended business is rejected rather than answered',
    body.call_inbound && body.call_inbound.reject === true,
    JSON.stringify(body));

  sql("UPDATE businesses SET status = 'active' WHERE id = '" + businessB.id + "'");
  bustNumberCache(B_NUMBER);
  /* The inbound path caches number->business in KV for 5 minutes, so the
     un-suspend needs the cache busting to be observable. Proving the cache is
     a cache (and never a source of truth) is worth an assertion. */
  const afterRestore = await clientB.patch('/api/settings', { json: { name: businessB.name } });
  checkEqual('un-suspending restores write access', afterRestore.status, 200);
}

/* ---- 15. Cleanup ------------------------------------------------------ */

function cleanup() {
  group('15. Cleanup');
  /* ON DELETE CASCADE from businesses removes users, sessions, leads,
     bookings, follow-ups, notifications and phone_numbers. calls have
     ON DELETE SET NULL on business_id, so they are removed explicitly. */
  sql("DELETE FROM calls WHERE business_id IN ('" + businessA.id + "','" + businessB.id + "')");
  sql("DELETE FROM calls WHERE business_id IS NULL AND retell_call_id LIKE '%" + RUN + "%'");
  sql("DELETE FROM businesses WHERE id IN ('" + businessA.id + "','" + businessB.id + "')");

  const left = sql("SELECT COUNT(*) AS n FROM businesses WHERE id IN ('" +
    businessA.id + "','" + businessB.id + "')");
  checkEqual('test tenants removed', left[0].n, 0);
  const orphanUsers = sql("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%-" + RUN + "@example.com'");
  checkEqual('and their users cascaded away', orphanUsers[0].n, 0);
}

/* ---- Runner ----------------------------------------------------------- */

async function main() {
  console.log('\x1b[1mShug test suite\x1b[0m — ' + BASE + '  (run ' + RUN + ')');

  const reachable = await fetch(BASE + '/api/retell/webhook').catch(function () { return null; });
  if (!reachable) {
    console.error('\n\x1b[31mCannot reach ' + BASE +
      '. Start it with:  npx wrangler dev --port 8787\x1b[0m');
    process.exit(1);
  }

  await testProvisioning();
  await testAuth();
  await testSessionExpiry();
  await testSignatures();
  await testMalformed();
  await testUnknownNumbers();
  await testLeadDedupe();
  await testMetering();
  await testRecords();
  await testTenantIsolation();
  await testSettings();
  await testPasswordChange();
  await testLockout();
  await testSuspension();
  cleanup();

  process.exit(summary() === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('\n\x1b[31mTest run crashed: ' + (e && e.stack || e) + '\x1b[0m');
  process.exit(1);
});
