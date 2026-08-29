/* Shug — Retell inbound-call webhook.
   POST /api/retell/inbound

   Retell calls this the moment a call lands on one of our numbers, BEFORE the
   agent speaks. We resolve the dialed number to a business and hand its
   configuration back as dynamic variables, so one Retell agent serves every
   customer and the $198 setup is a database row rather than a hand-built agent
   in the dashboard.

   Retell's contract (docs.retellai.com/features/inbound-call-webhook):
     request   { event: 'call_inbound', call_inbound: { from_number, to_number, ... } }
     response  { call_inbound: { dynamic_variables?, metadata?,
                                 override_agent_id?, reject? } }
     timeout   10 seconds, then up to 3 retries, then it falls back to the
               agent configured on the number (or disconnects).

   THAT FALLBACK IS THE WHOLE DESIGN CONSTRAINT. A slow or failing response
   here does not produce an error page — it produces dead air on a customer's
   phone. So every failure path below returns 200 with an empty override as
   fast as it can, letting Retell answer with the number's default agent.
   The only deliberate non-answer is an explicitly suspended account.

   Required bindings (Pages -> Settings):
     Variables and secrets:
       RETELL_API_KEY   SECRET — the key with the webhook badge in Retell
     Bindings:
       DB               D1 database
       CONFIG_CACHE     KV namespace

   Optional:
     RETELL_REQUIRE_INBOUND_SIGNATURE   '1' to reject unsigned requests here.
       Retell documents X-Retell-Signature for the event webhook; whether it
       signs THIS webhook was not confirmed against their docs, so the default
       is verify-if-present rather than a hard requirement that could silently
       stop every call from being answered. Turn it on once you have confirmed
       a signature actually arrives — check the logs for the warning below.

   Note: _headers does NOT apply to Pages Functions responses. Headers are set
   in code, in functions/lib/http.js. */

import { json, stringifyVars } from '../../lib/http.js';
import { readVerifiedWebhook } from '../../lib/retell.js';
import { businessByNumber } from '../../lib/store.js';

/* Comfortably inside Retell's 10s budget. If D1 is having a bad day we would
   rather answer with the default agent at 6s than have Retell time out at 10s,
   retry three times, and leave the caller listening to silence. */
const BUDGET_MS = 6000;

/* An empty override: "you decide, Retell". Not a rejection. */
const PASS_THROUGH = { call_inbound: {} };

/* ---- Helpers ---------------------------------------------------------- */

/* The agent needs to know what time it is where the CUSTOMER is, not in UTC,
   to answer "can someone come out today". */
function localTime(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(new Date());
  } catch (e) {
    return null;
  }
}

/* Every value here is spoken by, or reasoned over by, the agent. Keys must
   match the {{placeholders}} in the Retell prompt exactly, and every value
   must be a string — stringifyVars drops nulls so an unset field falls back to
   the agent-level default instead of the agent saying "null". */
function dynamicVariables(business) {
  return stringifyVars({
    business_name: business.name,
    trade: business.trade,
    services_offered: business.services_offered,
    services_declined: business.services_declined,
    service_area: business.service_area,
    service_area_notes: business.service_area_notes,
    hours: business.hours,
    greeting: business.greeting,
    tone: business.tone,
    urgency_rules: business.urgency_rules,
    transfer_number: business.transfer_number,
    booking_destination: business.booking_destination,
    current_local_time: localTime(business.timezone)
  });
}

async function resolve(context) {
  const env = context.env;

  const result = await readVerifiedWebhook(
    context.request,
    env.RETELL_API_KEY,
    { optional: env.RETELL_REQUIRE_INBOUND_SIGNATURE !== '1' }
  );

  if (!result.ok) {
    /* Signature failures are the one case worth refusing outright: if someone
       is probing this endpoint we should not hand back customer config. */
    if (result.code === 'bad_signature' || result.code === 'unsigned') {
      return { response: json({ ok: false, error: result.code }, 401) };
    }
    /* Anything else — malformed body, missing key — is our problem, not the
       caller's. Answer with the default agent. */
    console.error('retell/inbound: ' + result.code + ' — passing through to default agent');
    return { response: json(PASS_THROUGH, 200) };
  }

  const inbound = result.body.call_inbound || {};
  const toNumber = inbound.to_number;
  const fromNumber = inbound.from_number;

  if (!toNumber) {
    console.error('retell/inbound: payload had no to_number');
    return { response: json(PASS_THROUGH, 200) };
  }

  const business = await businessByNumber(env, toNumber);

  if (!business) {
    /* Not an error — a number that rings but has no business row yet. The
       number's default agent answers. Logged because in production this
       usually means a row was never created after porting a number in. */
    console.warn('retell/inbound: no business configured for ' + toNumber);
    return { response: json(PASS_THROUGH, 200) };
  }

  if (business.status === 'suspended') {
    console.warn('retell/inbound: rejecting call for suspended business ' + business.id);
    return { response: json({ call_inbound: { reject: true } }, 200) };
  }

  /* metadata rides along on the call object and comes back on every later
     webhook, so the event handler can attribute a call without re-resolving
     the number — and still attributes correctly if the number is later moved
     to a different business. */
  const payload = {
    call_inbound: {
      dynamic_variables: dynamicVariables(business),
      metadata: {
        business_id: business.id,
        business_name: business.name
      }
    }
  };

  if (business.status === 'setup' && business.booking_destination) {
    console.log('retell/inbound: business ' + business.id + ' is still in setup');
  }

  console.log('retell/inbound: ' + business.id + ' <- ' + (fromNumber || 'unknown'));
  return { response: json(payload, 200) };
}

/* ---- Handler ---------------------------------------------------------- */

export async function onRequestPost(context) {
  /* Races the real work against the budget. Whichever settles first wins, and
     the loser's rejection is swallowed — a D1 error arriving after we have
     already answered must not become an unhandled rejection. */
  let timer = null;
  const budget = new Promise(function (resolve) {
    timer = setTimeout(function () {
      console.error('retell/inbound: exceeded ' + BUDGET_MS + 'ms budget — passing through');
      resolve({ response: json(PASS_THROUGH, 200) });
    }, BUDGET_MS);
  });

  try {
    const winner = await Promise.race([
      resolve(context).catch(function (e) {
        console.error('retell/inbound: ' + ((e && e.message) || 'unknown failure'));
        return { response: json(PASS_THROUGH, 200) };
      }),
      budget
    ]);
    return winner.response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* A GET here is almost always a human checking whether the route is live.
   Answer plainly without revealing configuration. */
export async function onRequestGet() {
  return json({ ok: true, endpoint: 'retell-inbound', method: 'POST' }, 200);
}
