/* Shug — GET / PATCH /api/settings

   Deliberately minimal, and deliberately not a configuration console. The
   fields the owner can change here are the ones they will actually need to
   change without calling us: what the business is called, where urgent calls
   transfer to, and where notifications go.

   The full agent configuration — services, service area, urgency rules, tone,
   greeting — is what the $199 setup call produces. It is returned here so the
   owner can SEE it, but rewriting it is a conversation, not a form field, and
   a half-edited urgency rule is a missed emergency.

   A settings change busts the number->business KV cache (in updateBusiness),
   so a new transfer number is live on the next call rather than up to five
   minutes later. */

import { json, fail } from '../lib/http.js';
import { requireSession, readJson } from '../lib/guard.js';
import { businessById, updateBusiness } from '../lib/store.js';

/* What the settings FORM posts. store.js has its own, wider allow-list for
   fields provisioning may write; this narrower one is what a signed-in owner
   may change through the dashboard. Both are allow-lists, so a field is
   writable only by being named in one. */
const FORM_FIELDS = ['name', 'transfer_number', 'notify_sms', 'notify_email', 'timezone'];

function present(business) {
  return {
    id: business.id,
    name: business.name,
    phone: business.phone_e164,
    timezone: business.timezone,
    trade: business.trade,
    transferNumber: business.transfer_number,
    notifySms: business.notify_sms,
    notifyEmail: business.notify_email,
    minutesIncluded: business.minutes_included,
    status: business.status,
    bookingDestination: business.booking_destination,
    isDemo: business.is_demo === 1,

    /* Read-only here. Shown so the owner can confirm what the agent was told,
       and so a wrong answer on a sales call is visible rather than buried. */
    readOnly: {
      servicesOffered: business.services_offered,
      servicesDeclined: business.services_declined,
      serviceArea: business.service_area,
      serviceAreaNotes: business.service_area_notes,
      hours: business.hours,
      greeting: business.greeting,
      tone: business.tone,
      urgencyRules: business.urgency_rules
    }
  };
}

export async function onRequestGet(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const business = await businessById(context.env, gate.session.business_id);
  if (!business) return fail('business_not_found', 404);

  return json({ ok: true, settings: present(business) });
}

export async function onRequestPatch(context) {
  const gate = await requireSession(context);
  if (gate.response) return gate.response;

  const body = await readJson(context.request);
  if (body.response) return body.response;

  const patch = {};
  for (const field of FORM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body.value, field)) {
      patch[field] = body.value[field];
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const name = String(patch.name || '').trim();
    /* The one field that cannot be blanked: it is spoken aloud on every call.
       An empty business name would make the agent greet callers with silence. */
    if (!name) return fail('name_required', 400);
    if (name.length > 120) return fail('name_too_long', 400);
    patch.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'timezone')) {
    /* Validated by asking Intl, which is the thing that has to understand it
       later when a call is billed to a month. A zone Intl rejects would
       silently degrade every future billing boundary to UTC. */
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: patch.timezone }).format(new Date());
    } catch (e) {
      return fail('invalid_timezone', 400);
    }
  }

  let updated;
  try {
    updated = await updateBusiness(context.env, gate.session.business_id, patch);
  } catch (e) {
    if (e && e.message === 'invalid_email') return fail('invalid_email', 400);
    throw e;
  }
  if (!updated) return fail('business_not_found', 404);

  return json({ ok: true, settings: present(updated) });
}
