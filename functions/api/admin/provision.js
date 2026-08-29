/* Shug — POST /api/admin/provision

   ===========================================================================
   THIS IS A PRODUCT FEATURE, NOT AN ADMIN CHORE.
   ===========================================================================

   When a contractor says yes on a sales call, this is what puts them live
   before the call ends. One request creates, in a single D1 batch:

     1. the business record — the configuration the agent speaks from
     2. the phone_numbers row — which makes the number actually route
     3. the owner's login, with a generated password if none was supplied
     4. the notification target
     5. sane defaults for everything not supplied

   All five in ONE batch, so a half-provisioned customer is not a state that
   can exist. A failure part-way leaves nothing behind rather than a business
   whose phone rings into a config that has no owner attached.

   AUTHENTICATION is a bearer token (ADMIN_TOKEN), not a session. Provisioning
   happens before the customer has a login, so there is no session to authorise
   it with — and letting one tenant's session create another tenant would be
   exactly the privilege escalation the rest of this codebase prevents.

   RESPONSE. The generated password is returned ONCE, here, and is never
   retrievable again — only its PBKDF2 verifier is stored. Read it to the
   customer on the call, or send it to them; if it is lost, provision a new
   password rather than trying to recover this one. */

import { json, fail, isoNow } from '../../lib/http.js';
import { requireAdmin, readJson } from '../../lib/guard.js';
import { normalizeE164, businessById, bustNumberCache } from '../../lib/store.js';
import { hashPassword, normalizeEmail, passwordProblem } from '../../lib/auth.js';

/* Unambiguous over a phone line. No 0/O, no 1/l/I, no 5/S, no 2/Z — every
   pair a contractor writing on the back of an invoice would get wrong. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY346789';
const PASSWORD_GROUPS = 4;
const PASSWORD_GROUP_LENGTH = 4;

/* 16 characters from a 28-symbol alphabet is ~77 bits. Rejection sampling
   rather than a modulo, because `byte % 28` is biased toward the low end of
   the alphabet and a biased generated password is a smaller keyspace than it
   looks. */
function generatePassword() {
  const groups = [];
  for (let g = 0; g < PASSWORD_GROUPS; g++) {
    let group = '';
    while (group.length < PASSWORD_GROUP_LENGTH) {
      const bytes = crypto.getRandomValues(new Uint8Array(PASSWORD_GROUP_LENGTH * 2));
      for (const byte of bytes) {
        if (group.length >= PASSWORD_GROUP_LENGTH) break;
        /* 252 = 28 * 9. Discarding 252..255 makes the remainder uniform. */
        if (byte >= 252) continue;
        group += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      }
    }
    groups.push(group);
  }
  return groups.join('-');
}

/* A readable, stable id derived from the business name: "Rivera Plumbing" ->
   "rivera-plumbing". Human-legible ids make every log line and every support
   conversation easier than a UUID would.

   A four-character random suffix is appended ONLY on collision, so the common
   case stays clean and two businesses with the same name still both work. */
function slugify(name) {
  const slug = String(name).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'business';
}

async function uniqueBusinessId(env, name) {
  const base = slugify(name);

  const taken = await env.DB.prepare('SELECT 1 FROM businesses WHERE id = ? LIMIT 1')
    .bind(base).first();
  if (!taken) return base;

  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    const candidate = base + '-' + suffix;
    const clash = await env.DB.prepare('SELECT 1 FROM businesses WHERE id = ? LIMIT 1')
      .bind(candidate).first();
    if (!clash) return candidate;
  }

  return base + '-' + crypto.randomUUID().slice(0, 8);
}

export async function onRequestPost(context) {
  const gate = await requireAdmin(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const env = context.env;
  const input = body.value;

  /* ---- Validate before writing anything ------------------------------- */

  const name = String(input.name || '').trim();
  if (!name) return fail('name_required', 400);
  if (name.length > 120) return fail('name_too_long', 400);

  const phone = normalizeE164(input.phone);
  if (!phone) return fail('phone_required', 400);

  const ownerEmail = normalizeEmail(input.ownerEmail);
  if (!ownerEmail) return fail('owner_email_required', 400);

  const timezone = input.timezone || 'America/Los_Angeles';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch (e) {
    return fail('invalid_timezone', 400);
  }

  /* A supplied password must clear the same bar as one set through the
     dashboard. A generated one always does. */
  const generated = !input.password;
  const password = generated ? generatePassword() : String(input.password);
  if (!generated) {
    const problem = passwordProblem(password);
    if (problem) return fail(problem, 400);
  }

  const status = input.status || 'setup';
  if (['active', 'setup', 'suspended'].indexOf(status) === -1) {
    return fail('invalid_status', 400);
  }

  /* ---- Conflicts ------------------------------------------------------ */

  /* Checked explicitly so the answer is a useful 409 naming the existing
     business, rather than a UNIQUE constraint violation surfacing as a 500.
     Provisioning the same number twice is a normal mistake on a busy sales
     day, not an exceptional one. */
  const numberTaken = await env.DB.prepare(
    `SELECT b.id, b.name FROM businesses b WHERE b.phone_e164 = ?1
     UNION
     SELECT b.id, b.name FROM phone_numbers p JOIN businesses b ON b.id = p.business_id
      WHERE p.e164 = ?1
     LIMIT 1`
  ).bind(phone).first();

  if (numberTaken) {
    return json({
      ok: false,
      error: 'phone_already_provisioned',
      business: { id: numberTaken.id, name: numberTaken.name }
    }, 409);
  }

  const emailTaken = await env.DB.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
    .bind(ownerEmail).first();
  if (emailTaken) return fail('owner_email_already_registered', 409);

  /* ---- Write ---------------------------------------------------------- */

  const businessId = await uniqueBusinessId(env, name);
  const userId = crypto.randomUUID();
  const hashed = await hashPassword(password);
  const now = isoNow();

  const notifySms = normalizeE164(input.notifySms) || null;
  const transferNumber = normalizeE164(input.transferNumber) || null;

  /* One batch. D1 runs a batch as a transaction, so either the customer is
     fully live or nothing was created — never a business whose number routes
     to a config with no owner. */
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO businesses (
         id, name, phone_e164, timezone, trade,
         services_offered, services_declined, service_area, service_area_notes,
         hours, greeting, tone, urgency_rules, transfer_number,
         notify_sms, notify_email,
         booking_destination, booking_config, minutes_included, status, is_demo,
         created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`
    ).bind(
      businessId, name, phone, timezone, input.trade ?? null,
      input.servicesOffered ?? null, input.servicesDeclined ?? null,
      input.serviceArea ?? null, input.serviceAreaNotes ?? null,
      input.hours ?? null, input.greeting ?? null, input.tone ?? null,
      input.urgencyRules ?? null, transferNumber,
      notifySms, normalizeEmail(input.notifyEmail) || null,
      input.bookingDestination || 'internal',
      input.bookingConfig ? JSON.stringify(input.bookingConfig) : '{}',
      Number(input.minutesIncluded) > 0 ? Number(input.minutesIncluded) : 120,
      status,
      input.isDemo ? 1 : 0,
      now, now
    ),

    env.DB.prepare(
      `INSERT INTO phone_numbers (e164, business_id, label, status, created_at)
       VALUES (?1, ?2, ?3, 'active', ?4)`
    ).bind(phone, businessId, input.phoneLabel || 'Main line', now),

    env.DB.prepare(
      `INSERT INTO users (
         id, business_id, email, name, password_hash, password_salt,
         password_iterations, role, status, must_change_password,
         created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,'owner','active',?8,?9,?9)`
    ).bind(
      userId, businessId, ownerEmail, input.ownerName ?? null,
      hashed.password_hash, hashed.password_salt, hashed.password_iterations,
      /* A password we generated must be changed; one the owner chose must not. */
      generated ? 1 : 0,
      now
    )
  ]);

  /* The KV cache may hold a negative entry for this number from a test call
     placed before provisioning. Clearing it means the first real call resolves
     immediately rather than after the 5-minute TTL. */
  await bustNumberCache(env, phone);

  const business = await businessById(env, businessId);
  const origin = new URL(context.request.url).origin;

  console.log('provision: created business ' + businessId + ' on ' + phone);

  return json({
    ok: true,
    business: {
      id: business.id,
      name: business.name,
      phone: business.phone_e164,
      timezone: business.timezone,
      status: business.status,
      minutesIncluded: business.minutes_included,
      isDemo: business.is_demo === 1
    },
    owner: {
      id: userId,
      email: ownerEmail,
      /* Returned exactly once. Only the verifier is stored; this value cannot
         be read back from anywhere, including by us. */
      password: password,
      passwordWasGenerated: generated,
      mustChangePassword: generated
    },
    loginUrl: origin + '/app/login/',
    /* The remaining manual step, stated rather than assumed. Nothing in this
       system can point a Retell number at a webhook on the customer's behalf. */
    nextStep: 'In Retell, point ' + phone + ' at ' + origin +
      '/api/retell/inbound (inbound webhook) and ' + origin +
      '/api/retell/webhook (call events).'
  }, 201);
}
