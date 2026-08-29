-- Shug — business seed TEMPLATE.
--
--   cp seed.example.sql seed.sql     # then fill in the real values
--   wrangler d1 execute shug --local  --file=./seed.sql
--   wrangler d1 execute shug --remote --file=./seed.sql
--
-- EVERY VALUE MARKED <<< FILL IN >>> IS A PLACEHOLDER, NOT A REAL SETTING.
-- Nothing here was inferred from the Retell account — that account could not
-- be inspected (no API key was available), so inventing a service area or an
-- urgency rule would have been a guess dressed up as configuration.
--
-- These fields ARE the $198 setup. What goes here is what the agent says and
-- how it decides, so it is worth writing carefully rather than quickly. The
-- questions to answer are the ones /agent/ already promises to cover:
--
--   * which services you want calls about, and which you do not
--   * your service area, including the edges you would rather not drive to
--   * how you want calls handled: tone, what it offers, what it declines
--   * what counts as urgent enough to interrupt you, in your trade's language
--   * where a booking should land so you will actually see it
--
-- Text is spoken by, or reasoned over by, the agent. Write it as instructions
-- to a competent new front-desk hire, not as database values.

INSERT INTO businesses (
  id,
  name,
  phone_e164,
  timezone,
  trade,
  services_offered,
  services_declined,
  service_area,
  service_area_notes,
  hours,
  greeting,
  tone,
  urgency_rules,
  transfer_number,
  booking_destination,
  booking_config,
  minutes_included,
  status
) VALUES (
  'shug-demo',

  -- Spoken aloud on every call, so write it the way you answer the phone.
  '<<< FILL IN — business name as the agent should say it >>>',

  -- The live demo line from /agent/ and the homepage hero. This is the join
  -- key: Retell sends it as `to_number` and the inbound webhook resolves it
  -- to this row. It must match the number in Retell exactly, in E.164.
  '+15033768729',

  'America/Los_Angeles',

  '<<< FILL IN — e.g. roofing, plumbing, hvac, electrical >>>',

  '<<< FILL IN — services you DO want calls about >>>',
  '<<< FILL IN — services to decline, so the agent turns them away politely >>>',

  '<<< FILL IN — cities/counties served >>>',
  '<<< FILL IN — the edges you would rather not drive to >>>',

  '<<< FILL IN — business hours, plainly: "Mon-Fri 7am-5pm, Sat by appointment" >>>',

  -- The first thing a caller hears.
  '<<< FILL IN — opening line >>>',

  '<<< FILL IN — how it should sound: plain-spoken, warm, brief, etc. >>>',

  -- Be specific and concrete. "Urgent" alone is not actionable; "active water
  -- leak, no heat below 40F, sparking panel, gas smell" is.
  '<<< FILL IN — what is urgent enough to interrupt you >>>',

  -- E.164. Where urgent calls bridge to.
  '<<< FILL IN — +1XXXXXXXXXX >>>',

  -- Adapter name: 'email' | 'sms' | 'jobber' | 'gohighlevel'.
  --
  -- 'email' is the only one implemented today. Jobber is a draft and is not
  -- deployed; GoHighLevel is planned and has no code in this repo. Setting
  -- either of those now would leave leads sitting at delivery_status='pending'
  -- with nothing to deliver them.
  'email',

  -- JSON, read only by that adapter. For 'email':
  --   {"to": "you@example.com"}
  '<<< FILL IN — {"to": "you@example.com"} >>>',

  -- 120 minutes is what /agent/ and /pricing/ promise for $99/mo.
  120,

  -- 'setup' until the configuration above is real. 'active' answers calls.
  -- 'suspended' makes the inbound webhook reject rather than answer a call
  -- that will not be billed.
  'setup'
);
