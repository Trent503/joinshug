/* Shug — demo tenant seeder.

   Fills one business with realistic-looking data so the dashboard has
   something to show on a screen share: a dozen leads across every status, call
   records with summaries and real durations, bookings, follow-ups, notification
   rows, and partial minute usage sitting at 87 of 120.

   Usage:
     node tools/seed-demo.mjs                 # local D1 (default)
     node tools/seed-demo.mjs --remote        # production D1
     node tools/seed-demo.mjs --reset         # delete the demo tenant first

   THE DEMO TENANT IS MARKED is_demo = 1 and its id is always 'shug-demo'. That
   is what keeps fake data out of any real report and makes "delete the demo"
   one unambiguous statement. Real customers are always is_demo = 0.

   THE MINUTES NUMBER IS NOT A CONSTANT. It is the SUM of the call durations
   written below, because usage is derived from calls and never stored — a
   seeded counter would drift away from the seeded calls and the demo would
   contradict itself on screen. The script computes the durations to land on
   exactly 87 minutes and asserts it at the end. */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REMOTE = process.argv.includes('--remote');

/* See tests/lib.mjs for why local state may need to live outside the repo:
   wrangler's watcher treats .wrangler/state writes as source changes and
   reload-loops. Must match whatever `wrangler dev` was given. */
const PERSIST_TO = process.env.SHUG_PERSIST_TO || null;
function d1(extra) {
  const args = ['wrangler', 'd1', 'execute', 'shug', REMOTE ? '--remote' : '--local'];
  if (!REMOTE && PERSIST_TO) args.push('--persist-to', PERSIST_TO);
  return args.concat(extra);
}
const RESET = process.argv.includes('--reset');
const BUSINESS_ID = 'shug-demo';
const TARGET_MINUTES = 87;
const MINUTES_INCLUDED = 120;

/* The demo phone number. Deliberately in the 555 range reserved for fiction so
   it can never be a real person's line, and deliberately NOT the live demo
   number from the homepage — seeding over the number that actually rings would
   point real calls at fake data. */
const DEMO_NUMBER = '+15035550120';
const DEMO_EMAIL = 'demo@joinshug.com';

/* ---- Helpers ---------------------------------------------------------- */

function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function iso(daysAgo, hour, minute) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute || 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function localDay(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

/* The billing month the demo's calls land in, computed the same way the app
   does it: in the BUSINESS's timezone, not UTC. */
function billedMonth(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone, year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  let year = '', month = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    if (p.type === 'month') month = p.value;
  }
  return year + '-' + month;
}

const TZ = 'America/Los_Angeles';
const MONTH = billedMonth(TZ);

/* ---- The data ---------------------------------------------------------
   Written to read like one contractor's actual week: a mix of emergencies and
   quotes, some booked, some chased, one lost to a competitor, one repeat
   customer with three calls. Names and addresses are invented; every number is
   in the 555 fiction range. */

const LEADS = [
  { id: 'demo-lead-01', name: 'Marcus Webb',      phone: '+15035550101', status: 'new',
    service: 'Water heater', address: '812 SE Ash St, Portland OR',
    job: 'Water heater leaking into the garage, about an inch of water on the floor',
    urgency: 'Today if possible', wants: 'This afternoon', calls: [
      { days: 0, hour: 15, minute: 12, sec: 214, sentiment: 'Negative',
        summary: 'Caller has a leaking water heater flooding the garage. Wants someone out today. Gave address and confirmed he can be home after 2pm.' }
    ] },

  { id: 'demo-lead-02', name: 'Dana Cole',        phone: '+15035550102', status: 'new',
    service: 'Drain cleaning', address: '4417 N Missouri Ave, Portland OR',
    job: 'Kitchen sink backing up, has tried a plunger and drain cleaner',
    urgency: 'This week', wants: 'Thursday or Friday morning', calls: [
      { days: 0, hour: 11, minute: 40, sec: 168, sentiment: 'Neutral',
        summary: 'Kitchen drain blocked, plunger and store-bought cleaner did not clear it. Flexible on timing, prefers Thursday or Friday morning.' }
    ] },

  { id: 'demo-lead-03', name: 'Priya Raman',      phone: '+15035550103', status: 'contacted',
    service: 'Repipe quote', address: '2200 SW Hall St, Portland OR',
    job: 'Galvanized pipe throughout a 1948 house, wants a quote to repipe',
    urgency: 'Not urgent', wants: 'Any weekday', calls: [
      { days: 2, hour: 9, minute: 5, sec: 341, sentiment: 'Positive',
        summary: 'Homeowner of a 1948 house with original galvanized plumbing. Wants a full repipe quote. No leak currently. Happy with any weekday.' }
    ] },

  { id: 'demo-lead-04', name: 'Tom Alvarez',      phone: '+15035550104', status: 'qualified',
    service: 'Sewer scope', address: '6710 NE Fremont St, Portland OR',
    job: 'Buying a house, needs a sewer scope before closing',
    urgency: 'Before the 12th', wants: 'Weekday morning', calls: [
      { days: 3, hour: 13, minute: 22, sec: 256, sentiment: 'Positive',
        summary: 'Buyer needs a sewer scope before closing on the 12th. Asked about turnaround on the report. Confirmed the property address.' }
    ] },

  { id: 'demo-lead-05', name: 'Grace Okonkwo',    phone: '+15035550105', status: 'booked',
    service: 'Toilet replacement', address: '1145 SE Umatilla St, Portland OR',
    job: 'Two toilets running constantly, wants both replaced',
    urgency: 'This week', wants: 'Tuesday morning',
    booking: { date: localDay(3), start: '09:00', end: '12:00', status: 'confirmed',
               service: 'Replace two toilets' },
    calls: [
      { days: 4, hour: 10, minute: 15, sec: 289, sentiment: 'Positive',
        summary: 'Two constantly running toilets. Wants both replaced rather than repaired. Booked Tuesday 9am and confirmed she will be home.' }
    ] },

  { id: 'demo-lead-06', name: 'Bill Hartley',     phone: '+15035550106', status: 'booked',
    service: 'Garbage disposal', address: '3390 NE Klickitat St, Portland OR',
    job: 'Disposal humming but not turning, probably jammed',
    urgency: 'Whenever', wants: 'Next week',
    booking: { date: localDay(6), start: '13:00', end: '15:00', status: 'requested',
               service: 'Disposal repair or replace' },
    calls: [
      { days: 5, hour: 16, minute: 48, sec: 132, sentiment: 'Neutral',
        summary: 'Garbage disposal hums but does not turn. Asked whether to repair or replace. Wants an afternoon slot next week.' }
    ] },

  /* The repeat customer. Three calls, one lead — this is the row to point at
     when explaining what dedupe means. */
  { id: 'demo-lead-07', name: 'Renata Silva',     phone: '+15035550107', status: 'completed',
    service: 'Shower valve', address: '9021 SW Barbur Blvd, Portland OR',
    job: 'Shower valve replaced, then called twice about the finish',
    urgency: 'Was urgent', wants: 'Mornings',
    notes: 'Repeat customer. Third call was about the trim finish, not a new job. Paid on the day.',
    booking: { date: localDay(-6), start: '08:00', end: '11:00', status: 'completed',
               service: 'Shower valve replacement' },
    calls: [
      { days: 12, hour: 8, minute: 30, sec: 302, sentiment: 'Negative',
        summary: 'No hot water in the shower, valve suspected. Wants someone as soon as possible.' },
      { days: 8, hour: 14, minute: 10, sec: 96, sentiment: 'Neutral',
        summary: 'Calling to confirm the appointment time for the valve replacement.' },
      { days: 5, hour: 11, minute: 2, sec: 121, sentiment: 'Positive',
        summary: 'Following up about the trim finish on the new valve. Not a new job.' }
    ] },

  { id: 'demo-lead-08', name: 'Josh Feld',        phone: '+15035550108', status: 'completed',
    service: 'Hose bib', address: '540 NE 82nd Ave, Portland OR',
    job: 'Frozen and split outdoor hose bib',
    urgency: 'Soon', wants: 'Any afternoon',
    booking: { date: localDay(-9), start: '14:00', end: '15:30', status: 'completed',
               service: 'Replace outdoor hose bib' },
    calls: [
      { days: 14, hour: 9, minute: 55, sec: 178, sentiment: 'Neutral',
        summary: 'Outdoor hose bib split over the freeze. Water shut off at the main for now. Booked an afternoon slot.' }
    ] },

  { id: 'demo-lead-09', name: 'Helen Marsh',      phone: '+15035550109', status: 'lost',
    service: 'Water line', address: '7788 SE Woodstock Blvd, Portland OR',
    job: 'Main water line replacement, went with another company on price',
    urgency: 'Was this month', wants: 'Weekdays',
    notes: 'Went with a competitor — quoted $1,100 under us. Worth a call in spring about the repipe she mentioned.',
    calls: [
      { days: 18, hour: 12, minute: 30, sec: 397, sentiment: 'Neutral',
        summary: 'Main water line replacement quote. Asked about financing and about timelines. Said she was getting three quotes.' }
    ] },

  { id: 'demo-lead-10', name: 'Andre Boone',      phone: '+15035550110', status: 'contacted',
    service: 'Leak detection', address: '1602 N Killingsworth St, Portland OR',
    job: 'Water bill tripled, no visible leak',
    urgency: 'This week', wants: 'Morning',
    calls: [
      { days: 1, hour: 8, minute: 20, sec: 233, sentiment: 'Neutral',
        summary: 'Water bill tripled with no visible leak. Wants leak detection. Meter is still moving with everything off.' }
    ] },

  { id: 'demo-lead-11', name: 'Sofia Lindqvist',  phone: '+15035550111', status: 'qualified',
    service: 'Gas line', address: '2913 SE Division St, Portland OR',
    job: 'Wants a gas line run to a new range',
    urgency: 'Next month', wants: 'Flexible',
    calls: [
      { days: 6, hour: 15, minute: 44, sec: 265, sentiment: 'Positive',
        summary: 'Wants a gas line run to a new range in a kitchen remodel. Asked whether we coordinate with the electrician. Flexible on timing.' }
    ] },

  { id: 'demo-lead-12', name: 'Ray Duffy',        phone: '+15035550112', status: 'new',
    service: 'Burst pipe', address: '415 SE 12th Ave, Portland OR',
    job: 'Burst pipe under the crawlspace, water shut off at the main',
    urgency: 'EMERGENCY', wants: 'Right now',
    calls: [
      { days: 0, hour: 6, minute: 5, sec: 187, sentiment: 'Negative',
        summary: 'URGENT: burst pipe in the crawlspace. Caller has shut the water off at the main. Transferred per the urgency rules.' }
    ] }
];

/* Two calls that produced no lead — a wrong number and a robocall. Their
   presence is the point: they are billed minutes with nothing to show for
   them, and the call log should look like real traffic, not a highlight reel. */
const JUNK_CALLS = [
  { id: 'demo-call-junk-1', from: '+15035550198', days: 1, hour: 10, minute: 3, sec: 14,
    summary: 'Caller asked for a different business. Wrong number.', successful: 0 },
  { id: 'demo-call-junk-2', from: '+18005550199', days: 2, hour: 14, minute: 51, sec: 9,
    summary: 'Automated call, no speech from a human.', successful: 0 }
];

/* `inDays` is signed the way a human reads it: NEGATIVE is overdue, POSITIVE is
   upcoming. An earlier version used a `days` field that meant "days ago", which
   put the note "Spring: she mentioned a repipe" on a date in MAY and made three
   forward-looking reminders show as overdue. It was obvious the moment the
   dashboard was actually looked at and invisible until then. */
const FOLLOW_UPS = [
  { lead: 'demo-lead-03', inDays: -1, type: 'call',
    note: 'Send the repipe quote — promised it by Friday' },
  { lead: 'demo-lead-04', inDays: -2, type: 'call',
    note: 'Sewer scope report is due before the 12th' },
  { lead: 'demo-lead-10', inDays: 2, type: 'sms',
    note: 'Confirm the leak detection window' },
  { lead: 'demo-lead-09', inDays: 120, type: 'call',
    note: 'Spring: she mentioned a repipe' },
  { lead: 'demo-lead-11', inDays: 9, type: 'email',
    note: 'Send the gas line quote once the range model is confirmed' }
];

/* ---- Build the statements --------------------------------------------- */

function build() {
  const out = [];

  if (RESET) {
    out.push("DELETE FROM calls WHERE business_id = " + q(BUSINESS_ID) + ";");
    out.push("DELETE FROM businesses WHERE id = " + q(BUSINESS_ID) + ";");
  }

  out.push(
    "INSERT INTO businesses (id, name, phone_e164, timezone, trade, services_offered," +
    " services_declined, service_area, service_area_notes, hours, greeting, tone," +
    " urgency_rules, transfer_number, notify_sms, notify_email, booking_destination," +
    " booking_config, minutes_included, status, is_demo, created_at, updated_at) VALUES (" +
    [
      q(BUSINESS_ID),
      q('Cascade Plumbing Co.'),
      q(DEMO_NUMBER),
      q(TZ),
      q('plumbing'),
      q('Repairs, drain cleaning, water heaters, repipes, sewer scopes, gas lines, leak detection'),
      q('Septic tanks, well pumps, and anything commercial over four storeys'),
      q('Portland metro: Portland, Beaverton, Tigard, Lake Oswego, Milwaukie, Gresham'),
      q('We will go to Hillsboro and Oregon City but not past them — the drive eats the day'),
      q('Mon-Fri 7am-5pm, Saturday emergencies only, closed Sunday'),
      q('Thanks for calling Cascade Plumbing, this is Shug — what is going on?'),
      q('Plain-spoken and quick. No jargon, no upselling, get to the point.'),
      q('Active leak, no hot water in winter, sewage backing up, gas smell, or water shut off at the main'),
      q('+15035550150'),
      q('+15035550150'),
      q(DEMO_EMAIL),
      q('internal'),
      q('{}'),
      MINUTES_INCLUDED,
      q('active'),
      1,
      q(iso(45, 12)),   // created_at
      q(iso(45, 12))    // updated_at
    ].join(', ') + ") ON CONFLICT (id) DO NOTHING;"
  );

  out.push(
    "INSERT INTO phone_numbers (e164, business_id, label, status, created_at) VALUES (" +
    [q(DEMO_NUMBER), q(BUSINESS_ID), q('Main line'), q('active'), q(iso(45, 12))].join(', ') +
    ") ON CONFLICT (e164) DO NOTHING;"
  );

  /* The demo owner login. Password is fixed and public BY DESIGN — this is a
     demo tenant holding invented data, and a password nobody can remember
     makes the demo useless on a sales call. It is still a real PBKDF2 verifier;
     the hash is computed by the provisioning endpoint, not written here, which
     is why this script does not create the user. See the note printed at the
     end. */

  let totalSeconds = 0;
  const callRows = [];

  for (const lead of LEADS) {
    const first = lead.calls[0];
    const last = lead.calls[lead.calls.length - 1];
    const firstAt = iso(first.days, first.hour, first.minute);
    const lastAt = iso(last.days, last.hour, last.minute);

    out.push(
      "INSERT INTO leads (id, business_id, name, phone, email, address, service," +
      " job_description, urgency, preferred_time, source, status, notes," +
      " first_call_id, last_call_id, last_call_at, call_count," +
      " delivery_status, delivery_error, created_at, updated_at) VALUES (" +
      [
        q(lead.id), q(BUSINESS_ID), q(lead.name), q(lead.phone), 'NULL',
        q(lead.address), q(lead.service), q(lead.job), q(lead.urgency), q(lead.wants),
        q('seed'), q(lead.status), q(lead.notes || null),
        q(lead.id + '-call-1'), q(lead.id + '-call-' + lead.calls.length), q(lastAt),
        lead.calls.length,
        q('skipped'), q('internal_destination'),
        q(firstAt), q(lastAt)
      ].join(', ') + ") ON CONFLICT (business_id, phone) DO NOTHING;"
    );

    lead.calls.forEach(function (call, index) {
      const callId = lead.id + '-call-' + (index + 1);
      const startedAt = iso(call.days, call.hour, call.minute);
      const endedAt = new Date(new Date(startedAt).getTime() + call.sec * 1000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z');
      totalSeconds += call.sec;

      callRows.push({ id: callId, lead: lead.id, sec: call.sec });

      out.push(
        "INSERT INTO calls (retell_call_id, business_id, lead_id, from_number, to_number," +
        " direction, started_at, ended_at, duration_sec, billed_month, disconnect_reason," +
        " call_successful, user_sentiment, summary, transcript, analyzed_at," +
        " created_at, updated_at) VALUES (" +
        [
          q(callId), q(BUSINESS_ID), q(lead.id), q(lead.phone), q(DEMO_NUMBER),
          q('inbound'), q(startedAt), q(endedAt), call.sec, q(MONTH),
          q('user_hangup'), 1, q(call.sentiment), q(call.summary),
          q('Agent: Thanks for calling Cascade Plumbing, this is Shug — what is going on?\n' +
            'Caller: ' + lead.job + '\n' +
            'Agent: Got it. Let me take your address and get someone out to you.\n' +
            'Caller: ' + lead.address + '\n' +
            'Agent: Perfect. I have you down. You will get a confirmation shortly.'),
          q(endedAt), q(startedAt), q(endedAt)
        ].join(', ') + ") ON CONFLICT (retell_call_id) DO NOTHING;"
      );

      /* One notification per call, the way call_ended queues them. Marked
         'skipped' with reason 'no_provider' because that is exactly what the
         live system does today — a demo showing "sent" would be a lie the
         first customer discovers when their phone stays silent. */
      out.push(
        "INSERT INTO notifications (id, business_id, lead_id, call_id, channel, target," +
        " body, status, error, attempts, created_at) VALUES (" +
        [
          q(callId + '-notif'), q(BUSINESS_ID), q(lead.id), q(callId), q('sms'),
          q('+15035550150'),
          q('New call: ' + lead.name + ' — ' + lead.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') +
            '. ' + lead.service + '. Urgency: ' + lead.urgency + '. ' + call.summary +
            ' — Shug / Cascade Plumbing Co.').slice(0, 400),
          q('skipped'), q('no_provider'), 1, q(endedAt)
        ].join(', ') + ") ON CONFLICT (call_id, channel) DO NOTHING;"
      );
    });

    if (lead.booking) {
      out.push(
        "INSERT INTO bookings (id, business_id, lead_id, call_id, date, start_time," +
        " end_time, status, service, notes, destination, created_at, updated_at) VALUES (" +
        [
          q(lead.id + '-booking'), q(BUSINESS_ID), q(lead.id), q(lead.id + '-call-1'),
          q(lead.booking.date), q(lead.booking.start), q(lead.booking.end),
          q(lead.booking.status), q(lead.booking.service), 'NULL', q('internal'),
          q(firstAt), q(firstAt)
        ].join(', ') + ") ON CONFLICT (id) DO NOTHING;"
      );
    }
  }

  for (const junk of JUNK_CALLS) {
    const startedAt = iso(junk.days, junk.hour, junk.minute);
    const endedAt = new Date(new Date(startedAt).getTime() + junk.sec * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    totalSeconds += junk.sec;

    out.push(
      "INSERT INTO calls (retell_call_id, business_id, lead_id, from_number, to_number," +
      " direction, started_at, ended_at, duration_sec, billed_month, disconnect_reason," +
      " call_successful, user_sentiment, summary, analyzed_at, created_at, updated_at) VALUES (" +
      [
        q(junk.id), q(BUSINESS_ID), 'NULL', q(junk.from), q(DEMO_NUMBER),
        q('inbound'), q(startedAt), q(endedAt), junk.sec, q(MONTH),
        q('user_hangup'), junk.successful, q('Neutral'), q(junk.summary),
        q(endedAt), q(startedAt), q(endedAt)
      ].join(', ') + ") ON CONFLICT (retell_call_id) DO NOTHING;"
    );
  }

  for (const followUp of FOLLOW_UPS) {
    const at = new Date(Date.now() + followUp.inDays * 86400000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    out.push(
      "INSERT INTO follow_ups (id, business_id, lead_id, scheduled_for, type, status," +
      " notes, created_at) VALUES (" +
      [
        q(followUp.lead + '-fu'), q(BUSINESS_ID), q(followUp.lead), q(at),
        q(followUp.type), q('pending'), q(followUp.note), q(iso(7, 9))
      ].join(', ') + ") ON CONFLICT (id) DO NOTHING;"
    );
  }

  /* THE 87 MINUTES.

     Everything above adds up to some number of seconds; the demo needs to land
     on exactly 87 of 120 so the usage bar reads the way the pitch does. Rather
     than fudging a call length (which would make one call in the log a lie),
     the remainder goes into ONE clearly-labelled padding row representing the
     rest of the month's traffic. It is a real call row with a real duration, so
     SUM(duration_sec) and the displayed number cannot disagree. */
  const targetSeconds = TARGET_MINUTES * 60;
  const padding = targetSeconds - totalSeconds;

  if (padding > 0) {
    out.push(
      "INSERT INTO calls (retell_call_id, business_id, lead_id, from_number, to_number," +
      " direction, started_at, ended_at, duration_sec, billed_month, disconnect_reason," +
      " call_successful, user_sentiment, summary, analyzed_at, created_at, updated_at) VALUES (" +
      [
        q('demo-call-earlier-traffic'), q(BUSINESS_ID), 'NULL', q('+15035550197'),
        q(DEMO_NUMBER), q('inbound'), q(iso(20, 11)), q(iso(20, 11)), padding, q(MONTH),
        q('user_hangup'), 1, q('Neutral'),
        q('Earlier calls this month, rolled into one record so the minutes total is real.'),
        q(iso(20, 11)), q(iso(20, 11)), q(iso(20, 11))
      ].join(', ') + ") ON CONFLICT (retell_call_id) DO NOTHING;"
    );
  }

  return { statements: out, seconds: targetSeconds, padding: padding, calls: callRows.length };
}

/* ---- Run --------------------------------------------------------------- */

const built = build();
const file = join(tmpdir(), 'shug-seed-' + Date.now() + '.sql');
writeFileSync(file, built.statements.join('\n') + '\n');

const target = REMOTE ? '--remote' : '--local';

console.log('Seeding the demo tenant into ' + (REMOTE ? 'PRODUCTION' : 'local') + ' D1…');
if (RESET) console.log('  (--reset: removing the existing demo tenant first)');

try {
  execFileSync('npx', d1(['--file', file]),
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
} catch (e) {
  console.error('\nSeed failed:\n' + (e.stdout || '') + (e.stderr || ''));
  unlinkSync(file);
  process.exit(1);
}

unlinkSync(file);

/* Verify by reading BACK what the app will read, rather than trusting the
   arithmetic above. If these disagree the demo is wrong on screen, which is
   the one place it must not be. */
function readBack(command) {
  const out = execFileSync('npx', d1(['--json', '--command', command]),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start))[0].results;
}

const usage = readBack(
  "SELECT COALESCE(SUM(duration_sec),0) AS s, COUNT(*) AS n FROM calls " +
  "WHERE business_id = '" + BUSINESS_ID + "' AND billed_month = '" + MONTH + "'"
)[0];

const leadCount = readBack(
  "SELECT COUNT(*) AS n FROM leads WHERE business_id = '" + BUSINESS_ID + "'"
)[0].n;

const minutes = Math.ceil(Number(usage.s) / 60);

console.log('');
console.log('  business    ' + BUSINESS_ID + '  (is_demo = 1)');
console.log('  number      ' + DEMO_NUMBER);
console.log('  leads       ' + leadCount);
console.log('  calls       ' + usage.n);
console.log('  minutes     ' + minutes + ' / ' + MINUTES_INCLUDED +
  '  (' + Math.round((minutes / MINUTES_INCLUDED) * 100) + '%)');
console.log('');

if (minutes !== TARGET_MINUTES) {
  console.error('  \x1b[31mWARNING: minutes came back as ' + minutes +
    ', expected ' + TARGET_MINUTES + '.\x1b[0m');
  console.error('  The demo was probably seeded twice into the same month.');
  console.error('  Re-run with --reset.');
  process.exit(1);
}

console.log('  \x1b[32m✓ 87 of 120 minutes, derived from the seeded calls.\x1b[0m');
console.log('');
console.log('  The demo has no LOGIN yet — passwords are hashed by the');
console.log('  provisioning endpoint, never written by this script. Create one:');
console.log('');
console.log('    curl -sX POST http://localhost:8787/api/admin/provision \\');
console.log('      -H "Authorization: Bearer $ADMIN_TOKEN" \\');
console.log('      -H "Content-Type: application/json" -H "Origin: http://localhost:8787" \\');
console.log('      -d \'{"name":"Demo Login","phone":"+15035550121",');
console.log('           "ownerEmail":"demo@joinshug.com","isDemo":true}\'');
console.log('');
console.log('  …or attach a login to THIS demo business with tools/add-user.mjs.');
