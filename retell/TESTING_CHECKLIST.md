# Retell Voice Agents — Testing & Deployment Checklist

## ✅ Completed — Text-Based Test Suite

**Status:** 51/51 transcript tests passing

### Agent 1: Client Estimate Agent
- ✅ Happy path: estimate booking with readback (phone + address)
- ✅ Out-of-specialty: callback routing (not estimate)
- ✅ Spam caller: polite exit, no lead creation
- ✅ Complaint caller: acknowledge → collect details → no estimate booking
- ✅ Rambler: patient one-question-at-a-time pacing
- ✅ Interrupter: handles mid-sentence interruptions
- ✅ Mid-call correction: address changes reflected in readback

**Validations Passing:**
- One question per agent turn (no violations across 7 personas)
- Readbacks match caller input (phone: E.164 or formatted; address, date/time)
- Lead/booking creation expectations met

### Agent 2: SHUG Front-Page Demo Agent
- ✅ Happy path: business details → demo booking
- ✅ AI question: transparent "Yep. I'm the SHUG Agent." answer
- ✅ Rambler: gentle one-question-at-a-time pacing
- ✅ Unclear info: readback for confirmation before booking

**Validations Passing:**
- One question per agent turn (no violations across 4 personas)
- Readbacks match input (phone, business name, trade, city)
- Demo booking creation expectations

---

## ⏳ Next: Web Chat Testing (Interactive)

**Timing:** Before any real phone calls

**What it tests:** Live agent responsiveness, voice quality, natural conversation flow

### Steps

1. **Log in** to dashboard.retellai.com
2. **For Agent 1** (Single-Prompt Agent):
   - Click `agent_5d5affcf93c8f419535c5181f2` → "Test Agent" → "Web Chat"
   - Role-play 2–3 personas: happy path (interior + booking), spam caller, out-of-specialty
   - Verify: agent asks one question at a time, reads back details, creates booking
3. **For Agent 2** (Conversation Flow Agent):
   - Click `agent_e39ae1be308af25c025f736efb` → "Test Agent" → "Web Chat"
   - If not published: publish it first (currently unpublished)
   - Role-play: happy path → AI question → confirm demo booking
   - Verify: natural flow, transparency answer, readback before booking

### Expected Behavior Checklist
- [ ] Agent speaks clearly (Retell-Cimo voice)
- [ ] One question per turn (no two back-to-back)
- [ ] Phone/address/date readbacks accurate
- [ ] Booking details confirmed before creating
- [ ] Transitions smooth (no awkward pauses)
- [ ] Handles "Um, let me think..." caller pauses gracefully

**Pass Criteria:** No script violations, natural conversation, correct booking data extracted

---

## 🔴 Final: End-to-End Phone Verification

**Timing:** After web chat passes

**What it tests:** Booking → Cal.com, lead → D1, call → metering, notifications

### Test Call 1: Agent 1 (Estimate Booking)

**Scenario:** Call the provisioned business number (or demo number if Agent 1 is configured there) and book an estimate

**Steps:**
1. Dial the business phone number (check `retell/phone-numbers/` or Retell dashboard for the number)
2. Provide info: "Hi, I need my gutters cleaned. I'm at 5555 SW Barbur, Portland."
3. Give phone: 555-0100
4. Receive two appointment slots; select one (e.g., "Tuesday at 10 AM")
5. Hang up after confirmation

**Verify (dashboard):**
```bash
# 1. Lead in D1
SELECT * FROM leads WHERE phone LIKE '%5550100%' LIMIT 1;
# Should show: name (if captured), phone (+15550100), address (5555 SW Barbur),
#             service (gutters), status (new)

# 2. Call logged
SELECT * FROM calls WHERE from_number LIKE '%5550100%' ORDER BY started_at DESC LIMIT 1;
# Should show: retell_call_id, business_id, lead_id, duration_sec,
#             summary, transcript, call_successful (true)

# 3. Booking created
SELECT * FROM bookings WHERE lead_id = <lead_id>;
# Should show: date (Tuesday), start_time (10:00), status (requested),
#             destination (internal or configured), created_at

# 4. Minutes metered
SELECT * FROM usage_monthly WHERE business_id = <business_id> AND billed_month = 'YYYY-MM';
# minutes_used should include this call duration rounded UP

# 5. Notification queued (if SMS provider configured)
SELECT * FROM notifications WHERE call_id = <call_id>;
# Should show: status (sent/skipped), lead_id populated, body includes name + service + address
```

**Pass Criteria:**
- [ ] Lead created with correct details
- [ ] Booking on "Estimate Visit" calendar (or configured calendar)
- [ ] Call duration > 0 and metered (rounded up to nearest minute)
- [ ] Call transcript stored and readable
- [ ] Notification queued (or marked skipped if no SMS provider)

### Test Call 2: Agent 2 (Demo Booking)

**Scenario:** Call the demo line **(503) 376-8729** and book a SHUG product demo

**Steps:**
1. Dial (503) 376-8729
2. Respond to "What kind of business do you run?" — e.g., "Roofing company in Portland"
3. Provide: name (e.g., "Alex"), business name, trade, phone (555-0200)
4. Select a demo time (e.g., "Wednesday 2 PM")
5. Hang up after confirmation

**Verify (dashboard):**
```bash
# 1. Lead in D1
SELECT * FROM leads WHERE phone LIKE '%5550200%' AND business_id = 'shug-demo' LIMIT 1;
# Should show: name (Alex), phone (+15550200), business info (roofing, Portland), status (new)

# 2. Call logged to shug-demo business
SELECT * FROM calls WHERE from_number LIKE '%5550200%' AND business_id = 'shug-demo' LIMIT 1;
# Should show call duration, transcript, summary

# 3. Demo booking created
SELECT * FROM bookings WHERE lead_id = <lead_id>;
# Should show: date (Wednesday), start_time (2:00 PM), status (requested),
#             destination (internal for demo bookings)

# 4. Minutes metered to shug-demo
SELECT * FROM usage_monthly WHERE business_id = 'shug-demo' AND billed_month = 'YYYY-MM';
# Check that minutes are accumulating across test calls
```

**Pass Criteria:**
- [ ] Demo lead created (shug-demo business)
- [ ] Booking created for demo call time
- [ ] Call duration metered
- [ ] Transcript captures business details correctly
- [ ] Notification shows in dashboard (even if SMS skipped)

### Cal.com Integration Verification

After bookings are created in D1:

1. **Check Cal.com** — Log in to the configured Cal.com account
2. **Verify calendars:**
   - "Estimate Visit" calendar should show: Tuesday estimate booking (call time + 30 min buffer)
   - Demo calendar (or default) should show: Wednesday demo booking
3. **Check event details:**
   - Title includes business name or reference
   - Time zone is correct (Pacific)
   - Attendee email is on the event (if configured)

**Pass Criteria:**
- [ ] Estimate booking appears on Cal.com
- [ ] Demo booking appears on Cal.com
- [ ] Google Calendar synced (if connected to Cal.com)

---

## Summary: Definition of Done

Production quality is achieved when:

✅ **Spec compliance:**
- Every rule in `retell/AGENT_SPEC.md` has a passing test
- All 51 text-based personas validate (one-question, readback, lead/booking creation)

✅ **Web chat verification:**
- Both agents tested interactively via Retell web chat
- Natural conversation flow, no rule violations observed

✅ **End-to-end integration:**
- Real test call books a slot in Cal.com ✓ or pending phone test
- Lead data captured correctly in D1 ✓ or pending phone test
- Call duration metered accurately ✓ or pending phone test
- Booking notification queued ✓ or pending SMS provider setup

✅ **Configuration management:**
- Agents versioned in repo (`retell/agents/*.json`)
- Sync script pulls agents and phone config
- Repo is single source of truth (not dashboard)

✅ **Documentation:**
- `retell/AGENT_SPEC.md` — complete rules (locked)
- `retell/README.md` — architecture, troubleshooting
- `retell/TESTING_CHECKLIST.md` — this document
- `SESSION_LOG.md` — phase notes and decisions

---

## Current Status

| Phase | Status | Notes |
|---|---|---|
| Text-based tests | ✅ Done | 51/51 passing |
| Web chat testing | ⏳ Ready | Use Retell dashboard UI |
| Phone call test | ⏳ Ready | Dial test numbers after web chat |
| Cal.com verification | ⏳ Ready | Check bookings after phone test |
| Production deploy | ⏳ Blocked on phone verification | Both agents technically live; need real-call validation |

---

## Rollback / Abort

If tests reveal rule violations:

1. **Update agent prompt** in Retell dashboard (LLM config)
2. **Re-test via web chat** to confirm fix
3. **Re-run text-based tests** (if test personas are updated)
4. **Pull agents** to repo with sync script: `node retell/sync.mjs pull`
5. **Commit** the updated agent configs

If Cal.com integration fails:
- Verify Retell dashboard has Cal.com connected (Settings → Integrations)
- Re-test with a new booking
- If still failing, check `functions/api/retell/webhook.js` for booking extraction logic

If metering is wrong:
- Check `functions/lib/store.js` → `minutesUsed()` function
- Verify rounding is UP (not down): `Math.ceil(duration_sec / 60)`
- Re-run test call and check D1 `usage_monthly` table

