# Retell Voice Agents

This directory contains the Shug voice agent configurations, synced from Retell API. The repo is the source of truth for agent specs and phone routing — not the Retell dashboard.

## Agents

### Agent 1: Single-Prompt Agent (Client Estimate Agent)
- **ID:** `agent_5d5affcf93c8f419535c5181f2`
- **Purpose:** Books in-person estimate visits for customers calling provisioned businesses
- **Status:** Published ✓
- **LLM:** Retell-managed (`llm_79fdbc782cacebfe0ec617536586`)
- **Voice Settings:** See `agents/agent_5d5affcf93c8f419535c5181f2.json`
- **Behavior Rules:** See `AGENT_SPEC.md`
- **Phone Numbers:** See `phone-numbers/` directory

**Key Behaviors:**
- Books ONLY 60-minute in-person estimate visits (Cal.com "Estimate Visit")
- One question per turn, reads back address/phone before booking
- Handles complaints, spam, out-of-specialty routing
- Every call logged to D1 via log_lead webhook

### Agent 2: Conversation Flow Agent (Demo Agent)
- **ID:** `agent_e39ae1be308af25c025f736efb`
- **Purpose:** Explains Shug to prospects and books demo calls
- **Status:** Not published yet (under review)
- **Conversation Flow:** Managed in Retell dashboard
- **Behavior Rules:** See `AGENT_SPEC.md`
- **Phone Numbers:** `(503) 376-8729` — joinshug.com/agent/ demo line

**Key Behaviors:**
- Natural conversation flow explaining Shug's product
- Collects: first name, business name, trade, phone, city, preferred time
- Transparency: "Yep. I'm the SHUG Agent." when asked about AI
- Books demos (not estimates)

## Sync Workflow

### Pull agents and phone numbers from Retell
```bash
node retell/sync.mjs pull
```

This downloads:
- All agents to `retell/agents/{id}.json`
- Phone number configs to `retell/phone-numbers/{id}.json`

Commit changes:
```bash
git add retell/
git commit -m "Pull Retell agents and phone config"
```

### Push agent changes back to Retell (manual for now)
1. Edit agent JSON in `retell/agents/{id}.json`
2. Go to dashboard.retellai.com/agents/{id}
3. Paste updated config
4. Re-run `pull` to verify

## Phone Numbers

| Number | Business | Agent | Webhook Routes |
|--------|----------|-------|-----------------|
| `(503) 376-8729` | SHUG Demo | `agent_e39ae1be308af25c025f736efb` | inbound, webhook |
| *provisioned numbers* | Customer businesses | `agent_5d5affcf93c8f419535c5181f2` | inbound, webhook |

**Webhook URLs:**
- Inbound: `https://joinshug.com/api/retell/inbound`
- Call events: `https://joinshug.com/api/retell/webhook`

Both must be configured on each number in Retell dashboard.

## Tests

See `tests/` directory for transcript-based persona tests:
- `tests/personas.mjs` — test scripts for each agent scenario
- `tests/transcript-parser.mjs` — parse agent turns, validate one-question rule
- `tests/run.mjs` — execute tests against live agent

### Running Tests

**Text-based (before phone calls):**
```bash
node retell/tests/run.mjs --text-only --agent 1
node retell/tests/run.mjs --text-only --agent 2
```

**With Web Chat (Retell UI):**
1. Go to dashboard.retellai.com
2. Click agent > "Test Agent" > Web Chat
3. Run through each persona scenario
4. Verify transcript behavior

**Phone calls (after web tests pass):**
```bash
node retell/tests/run.mjs --agent 1 --call real
```

## Spec & Rules

See `AGENT_SPEC.md` for complete behavior rules. Every rule has a test case in `tests/`.

## Configuration Reference

### Voice Settings (in agent JSON)

- **interruption_sensitivity:** How quickly the agent allows caller interruption (1-10, higher = more interruptible)
- **responsiveness:** Response latency (milliseconds)
- **backchanneling:** "mm-hmm", "yeah" interjections to feel natural
- **filler_words:** "um", "uh", "like" usage for realism

These are tuned per agent to balance responsiveness (demo needs quick replies) vs. completion (estimate calls need time to think).

### Dynamic Variables (passed at call time)

From `functions/api/retell/inbound.js`, available to both agents as `{{placeholder}}`:

```
business_name              "Rivera Plumbing"
trade                      "plumbing"
services_offered           "Repairs, drain cleaning, water heaters"
services_declined          "Septic, well pumps"
service_area               "Portland metro, 15 min radius"
service_area_notes         "No service calls on SW Corbett"
hours                      "Mon-Fri 7am-5pm, Saturday emergencies"
greeting                   "Thanks for calling Rivera Plumbing, this is Shug."
tone                       "Plain-spoken and quick"
urgency_rules              "Active leak, no hot water, sewage backing up, gas smell"
transfer_number            "+15035559000"
booking_destination        "internal" | "jobber" | "gohighlevel" | "google_calendar"
current_local_time         "Friday, 3:45 PM"
```

## Deployment Checklist

- [ ] Agent 1 prompt tuned and tested with 7 persona scenarios
- [ ] Agent 2 published in Retell (currently unpublished)
- [ ] Both agents configured with correct voice settings
- [ ] Phone numbers point to correct inbound/webhook URLs
- [ ] Cal.com integration verified (bookings land on calendar)
- [ ] D1 schema verified (calls, leads, bookings tables exist)
- [ ] All tests passing (text, web chat, then phone)
- [ ] SESSION_LOG.md updated
- [ ] NEEDS_CONFIG.md updated

## Troubleshooting

### "Webhook rejected with 401"
- Check RETELL_API_KEY is set to the key WITH WEBHOOK BADGE in Retell dashboard
- Any other key authenticates API calls but fails signature verification

### "Inbound call goes straight to dead air"
- Check inbound webhook URL is correct: `https://joinshug.com/api/retell/inbound`
- Check Worker is deployed and responding
- Check wrangler tail logs for errors

### "Bookings not landing in Cal.com"
- Verify Agent 1 extracts a real YYYY-MM-DD date (not "next Tuesday")
- Check webhook.js is mapping booking fields correctly (line 64-69)
- Confirm Cal.com integration is wired at Retell level

### "Lead not appearing in dashboard"
- Check call_analyzed event was received (check wrangler tail)
- Verify agent extracted `name` OR `address` OR `service` (phone-only = no lead)
- Check D1: `SELECT * FROM calls WHERE retell_call_id = '...'` should have a row

