/* Shug — the notification cron trigger and the provider gate it depends on.

   Usage:
     node tests/cron.mjs

   NO SERVER, NO DATABASE, NO CREDENTIAL. This suite imports worker/index.js and
   functions/lib/notify.js directly and drives them with fabricated `env`
   objects, so it runs anywhere `node` runs — including before `wrangler dev` is
   up, which is the point: the thing under test is what the worker does on a
   timer when nobody is watching.

   WHY THIS FILE EXISTS

   wrangler.toml now carries a two-minute cron schedule, and it deliberately
   did NOT before, on the grounds that a cron running every two minutes to skip
   every row for want of an SMS provider is noise rather than a feature.
   What makes the trigger shippable ahead of the credentials is one gate:
   scheduled() asks hasDeliveryProvider(env) first and returns without touching
   a binding when the answer is no.

   That gate is load-bearing and completely invisible in production — a broken
   one costs a D1 query every two minutes forever and nothing ever fails. So it
   is asserted here, mechanically: the "no provider" case is given an `env`
   whose DB binding THROWS if it is so much as read.

   The other half is drift. deliver() dispatches on the adapter table and
   hasDeliveryProvider() reads the same table to answer for the cron; if those
   two ever disagree the failure is silent and expensive — a configured
   provider whose queue the cron has quietly decided to skip. Both directions
   are asserted below against the one table. */

import { group, check, checkEqual, summary } from './lib.mjs';
import worker from '../worker/index.js';
import { hasDeliveryProvider, deliver, drainQueue } from '../functions/lib/notify.js';

/* ---- Fakes ------------------------------------------------------------ */

/* Minimal D1 stand-in. Records every statement so a test can assert what the
   code did, and returns empty result sets so drainQueue finds nothing to send.
   Nothing here talks to a real database, local or remote. */
function fakeDb() {
  const statements = [];

  return {
    statements,
    prepare(sql) {
      const record = { sql, bindings: [] };
      statements.push(record);
      const stmt = {
        bind(...args) { record.bindings = args; return stmt; },
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
        first: async () => null
      };
      return stmt;
    }
  };
}

/* An env whose bindings cannot be read without it being noticed. This is how
   "the cron did nothing" is proved rather than assumed. */
function trapEnv(extra) {
  const trap = { touched: false };
  const env = Object.assign({}, extra);

  Object.defineProperty(env, 'DB', {
    get() {
      trap.touched = true;
      throw new Error('cron read the DB binding with no provider configured');
    }
  });
  Object.defineProperty(env, 'CONFIG_CACHE', {
    get() {
      trap.touched = true;
      throw new Error('cron read the KV binding with no provider configured');
    }
  });

  return { env, trap };
}

/* The scheduled() contract, as the runtime supplies it. */
function cronContext() {
  const waited = [];
  return {
    event: { scheduledTime: Date.now(), cron: '*/2 * * * *' },
    ctx: {
      waitUntil(p) { waited.push(p); return p; },
      passThroughOnException() {}
    },
    waited
  };
}

function notification(overrides) {
  return Object.assign({
    id: 'ntf_test',
    business_id: 'biz_test',
    channel: 'sms',
    target: '+15035559000',
    body: 'Missed call from Ana Rivera, +1 503 555 1111 — water heater, urgent.',
    status: 'queued',
    attempts: 0
  }, overrides || {});
}

/* ---- 1. The gate ------------------------------------------------------ */

function testGate() {
  group('1. hasDeliveryProvider — configuration only, no bindings');

  check('unset is no provider', hasDeliveryProvider({}) === false);
  check('empty string is no provider', hasDeliveryProvider({ SMS_PROVIDER: '' }) === false);
  check('whitespace is no provider', hasDeliveryProvider({ SMS_PROVIDER: '   ' }) === false);
  check('a missing env is no provider', hasDeliveryProvider(undefined) === false);
  check('and null is no provider', hasDeliveryProvider(null) === false);

  /* An unrecognised NAME must not read as "configured". Someone setting
     SMS_PROVIDER="none" or "twillio" is one typo from a cron that drains every
     two minutes and skips every row — the exact noise the gate prevents. */
  check('an unknown provider name is not a provider',
    hasDeliveryProvider({ SMS_PROVIDER: 'none' }) === false);
  check('and a misspelled one is not either',
    hasDeliveryProvider({ SMS_PROVIDER: 'twillio' }) === false);

  check('twilio is a provider', hasDeliveryProvider({ SMS_PROVIDER: 'twilio' }) === true);
  check('provider names are case-insensitive',
    hasDeliveryProvider({ SMS_PROVIDER: 'Twilio' }) === true);
  check('and are trimmed — a trailing space in a dashboard field is not a typo',
    hasDeliveryProvider({ SMS_PROVIDER: ' twilio ' }) === true);

  /* THE EMPTY EMAIL TABLE, ASSERTED. There is no outbound email adapter, so
     EMAIL_PROVIDER cannot turn one on. If an adapter is ever added, this
     assertion fails and is the reminder to update it — which is preferable to
     a gate that silently starts claiming email works. */
  check('no email provider exists yet, so EMAIL_PROVIDER cannot enable one',
    hasDeliveryProvider({ EMAIL_PROVIDER: 'resend' }) === false);

  check('an email setting does not mask a missing SMS provider',
    hasDeliveryProvider({ EMAIL_PROVIDER: 'postmark', SMS_PROVIDER: '' }) === false);
}

/* ---- 2. The cron does nothing when nothing can be sent ---------------- */

async function testCronGated() {
  group('2. scheduled() with no provider — the reason the trigger can ship early');

  const { env, trap } = trapEnv();
  const { event, ctx } = cronContext();

  let threw = null;
  try {
    await worker.scheduled(event, env, ctx);
  } catch (e) {
    threw = e;
  }

  check('the cron tick completes without throwing',
    threw === null, threw && threw.message);
  check('AND IT NEVER TOUCHED A BINDING — no D1 query, no KV read',
    trap.touched === false,
    'the gate is not holding; every tick is now costing a database round trip');

  /* Same again with the variable present but empty, which is what an operator
     who half-configured it would leave behind. */
  const half = trapEnv({ SMS_PROVIDER: '' });
  await worker.scheduled(event, half.env, half.ctx || cronContext().ctx);
  check('an empty SMS_PROVIDER is still gated', half.trap.touched === false);
}

/* ---- 3. The cron does work when a provider exists --------------------- */

async function testCronActive() {
  group('3. scheduled() with a provider — the same schedule starts delivering');

  const db = fakeDb();
  const env = { DB: db, SMS_PROVIDER: 'twilio' };
  const { event, ctx } = cronContext();

  let threw = null;
  try {
    await worker.scheduled(event, env, ctx);
  } catch (e) {
    threw = e;
  }

  check('the tick completes without throwing', threw === null, threw && threw.message);
  check('it queried the database', db.statements.length > 0,
    'setting SMS_PROVIDER did not wake the drain up');

  const select = db.statements[0];
  check('and the query it ran is the pending-notification read',
    Boolean(select) && /FROM\s+notifications/i.test(select.sql),
    select && select.sql);

  /* The batch size reaches the query. A limit that silently became NaN or
     undefined would fall back to a default and nobody would notice. */
  checkEqual('one tick attempts 25 notifications',
    select && select.bindings[0], 25);
}

/* ---- 4. A failing database ends the tick cleanly ---------------------- */

async function testCronSurvivesDbFailure() {
  group('4. scheduled() when D1 is unavailable');

  const env = {
    SMS_PROVIDER: 'twilio',
    DB: {
      prepare() { throw new Error('D1_ERROR: network'); }
    }
  };
  const { event, ctx } = cronContext();

  let threw = null;
  try {
    await worker.scheduled(event, env, ctx);
  } catch (e) {
    threw = e;
  }

  /* A cron that throws is a cron run marked failed in the dashboard; the work
     is not lost either way, because nothing is dequeued destructively and the
     next tick re-reads the same rows. Swallowing it keeps the failure in the
     logs where it belongs instead of in an alert that means nothing. */
  check('the failure is contained, not thrown at the runtime',
    threw === null, threw && threw.message);
}

/* ---- 5. deliver() and the gate read the same table -------------------- */

async function testNoDrift() {
  group('5. deliver() and hasDeliveryProvider() cannot disagree');

  /* Unconfigured: the gate says no, and deliver() agrees by skipping. */
  const unconfigured = { DB: fakeDb() };
  const skipped = await deliver(unconfigured, notification());

  checkEqual('with no provider, deliver() skips', skipped.status, 'skipped');
  checkEqual('and names the reason exactly', skipped.error, 'no_provider');
  check('which is the same answer the gate gives the cron',
    hasDeliveryProvider(unconfigured) === false);

  /* 'skipped' must stay distinct from 'failed'. This is the distinction that
     stops a missing credential from hiding inside "delivery is broken". */
  check("and 'skipped' is not 'failed'", skipped.status !== 'failed');

  /* A notification with nowhere to go is a different fact from one with no
     provider, and the row has to say which. */
  const noTarget = await deliver(unconfigured, notification({ target: null }));
  checkEqual('no target is its own reason, not no_provider', noTarget.error, 'no_target');

  /* A channel the system does not have a table for is a bad row — a real
     failure, not a missing credential. */
  const bogus = await deliver(unconfigured, notification({ channel: 'carrier_pigeon' }));
  checkEqual('an unknown channel fails', bogus.status, 'failed');
  checkEqual('and says so', bogus.error, 'unknown_channel');

  /* Email is queued and skipped, because the email table is empty. */
  const email = await deliver(unconfigured,
    notification({ channel: 'email', target: 'ana@riveraplumbing.com' }));
  checkEqual('email skips for want of an adapter', email.status, 'skipped');
  checkEqual('with the same honest reason', email.error, 'no_provider');

  /* Every outcome above was written to the row. A delivery attempt that does
     not record itself is indistinguishable from one that never ran. */
  const writes = unconfigured.DB.statements.filter(function (s) {
    return /UPDATE\s+notifications/i.test(s.sql);
  });
  checkEqual('all four attempts recorded their outcome on the row', writes.length, 4);
}

/* ---- 6. drainQueue counts what it did --------------------------------- */

async function testDrainCounts() {
  group('6. drainQueue reports honestly');

  const env = { DB: fakeDb(), SMS_PROVIDER: 'twilio' };
  const counts = await drainQueue(env, 10);

  checkEqual('an empty queue drains zero', counts.total, 0);
  checkEqual('and sends nothing', counts.sent, 0);
  check('the shape the cron logs is present',
    typeof counts.sent === 'number' &&
    typeof counts.failed === 'number' &&
    typeof counts.skipped === 'number');
}

/* ---- Run -------------------------------------------------------------- */

async function main() {
  console.log('\n\x1b[1mShug — cron trigger and provider gate\x1b[0m');
  console.log('No server, no database, no credentials.\n');

  testGate();
  await testCronGated();
  await testCronActive();
  await testCronSurvivesDbFailure();
  await testNoDrift();
  await testDrainCounts();

  process.exit(summary());
}

main().catch(function (e) {
  console.error('\n\x1b[31mSuite crashed: ' + (e && e.stack) + '\x1b[0m');
  process.exit(1);
});
