# Shug Runbook — Troubleshooting at 2am with an Angry Client

When something breaks, use this guide. Each section tells you the symptoms, the most likely cause, and the exact steps to fix it.

---

## Before You Start

**Do this once:**

1. Go to https://dash.cloudflare.com
2. Log in
3. Look for "Workers" on the left sidebar
4. Click "joinshug"
5. Bookmark the page
6. Come back here

**Right now (check these first):**

1. Is the internet working? (Open Google in a new tab)
2. Is joinshug.com up? (Open https://joinshug.com in a new tab — if you get an error, the marketing site is down)
3. Is the dashboard up? (Open https://joinshug.com/app/ — if you get "Cannot GET /app/", the dashboard is down)

---

## Issue 1: Site Is Completely Down (White Screen, 500 Error, Cannot Load)

### Symptoms
- https://joinshug.com returns an error or hangs
- https://joinshug.com/app/ returns an error
- The marketing pages don't load
- Nothing works

### Most Likely Causes
1. **Cloudflare Worker crashed** — A code bug was deployed
2. **Database connection failed** — D1 is having trouble
3. **Network issue** — Your internet or Cloudflare's edge is down

### What to Do (in order)

**Step 1: Check Cloudflare's status**

1. Go to https://www.cloudflarestatus.com
2. Look for "🔴 Red" incidents
3. **If you see a red incident**: Wait. There's nothing you can do until Cloudflare fixes it. Estimated time is usually shown.
4. **If everything is green**: Continue to Step 2

**Step 2: Check the Worker logs**

1. Go to https://dash.cloudflare.com → Workers → joinshug
2. Click **Logs** at the top
3. Look for red error messages in the last minute
4. If you see errors: **screenshot this and send to the developer**

**Step 3: Test each piece**

1. **Can you reach the marketing site?**
   ```
   curl -I https://joinshug.com/
   ```
   Look for `HTTP/1.1 200`. If you get anything else, the Worker is down.

2. **Can you reach an API endpoint?**
   ```
   curl -I https://joinshug.com/api/auth/me
   ```
   Should return `HTTP/1.1 401` (unauthorized, but the server responded). If you get a different error, the Worker is broken.

**Step 4: Restart the Worker**

1. Go to https://dash.cloudflare.com → Workers → joinshug
2. Click **Deployments**
3. Find the most recent deployment (top of the list)
4. Click the **⋮** menu next to it
5. Click **Rollback**
6. Choose the previous version
7. Click **Rollback to this version**
8. Go to https://joinshug.com and test
9. **If that fixes it**: The latest deploy broke something. Don't deploy again until the developer reviews it.
10. **If that doesn't fix it**: Continue to Step 5

**Step 5: Check the Database**

1. Go to https://dash.cloudflare.com → D1
2. Look for "shug" in the database list
3. Click it
4. Look for any error messages or status warnings
5. **If it says "Migrating" or "Initializing"**: Wait 5 minutes and try again
6. **If it says "Error"**: **Call the developer** — this requires database repair

**Step 6: Last resort**

1. Go to https://dash.cloudflare.com → Workers → joinshug
2. Click **Settings**
3. Look for "Routes"
4. Make sure `joinshug.com/api/*` is there
5. Make sure the Worker "main" is set to `worker/index.js`
6. If anything is missing or wrong: **Call the developer**

---

## Issue 2: Phone Doesn't Ring (Caller Gets Voicemail, Dead Air, or "Not in Service")

### Symptoms
- You give someone the number and it goes to voicemail
- They call and hear nothing (dead air)
- They call and hear a generic voicemail
- They can't reach you at all

### Most Likely Causes
1. **Retell webhooks are not configured** — Retell doesn't know where to send calls
2. **Retell API key is not set** — Shug can't talk to Retell
3. **Business is suspended** — You've been marked as not paying
4. **Number is not routing** — Retell never got pointed at Shug

### What to Do (in order)

**Step 1: Is the number even assigned to you?**

1. Log into Retell at https://dashboard.retellai.com
2. Click **Phone Numbers** on the left
3. Look for your number (it starts with +1)
4. **If you don't see it**: You were never provisioned. Call the sales team.
5. **If you see it**: Continue to Step 2

**Step 2: Are the webhooks pointed at Shug?**

In Retell dashboard:

1. Click **Phone Numbers**
2. Click your number
3. Look at these two fields:
   - **Inbound call webhook**: Should be `https://joinshug.com/api/retell/inbound`
   - **Call events webhook**: Should be `https://joinshug.com/api/retell/webhook`
4. **If either is wrong or blank**: Update it to the correct URL
5. **If both are correct**: Continue to Step 3

**Step 3: Does Shug know your number?**

1. Log into https://joinshug.com/app/
2. Click **Settings** (at the bottom)
3. Look for "Phone Number"
4. **If it's blank**: Fill it in with your Shug number (+1 format)
5. **If it's set**: Continue to Step 4

**Step 4: Is your business active?**

1. This requires the developer to check the database
2. The developer should run:
   ```
   wrangler d1 execute shug --remote --command "SELECT id, name, status FROM businesses WHERE phone_e164 = '+your-number-here';"
   ```
3. Look for `status`
   - `'active'` = should work
   - `'suspended'` = you're down for non-payment or manual suspension
   - `'setup'` = you're live but marked as still configuring

**Step 5: Test the number**

1. Call the number from a different phone
2. Wait 15 seconds
3. **If you hear Shug**: The system works. The issue is elsewhere.
4. **If you hear voicemail or dead air**: Go to Retell dashboard
   - Click **Phone Numbers**
   - Click your number
   - Click **Test Call**
   - A test call should ring your phone or connect you
   - **If the test call works but your real number doesn't**: The webhooks are pointed wrong. Go back to Step 2.

---

## Issue 3: Calls Come In But Shug Won't Talk (Voicemail Only, or Silent Call)

### Symptoms
- The phone rings (good!)
- Shug doesn't answer (bad)
- Caller hears voicemail or silence
- The call doesn't appear in your dashboard

### Most Likely Causes
1. **Shug can't look up your business config** — D1 timeout or network issue
2. **Retell agent is down** — Retell's voice service is broken
3. **Inbound webhook is failing** — `/api/retell/inbound` is returning an error

### What to Do (in order)

**Step 1: Check Retell's status**

Go to https://www.retellstatus.com and look for red incidents. If you see one: Wait.

**Step 2: Check for errors in the logs**

1. Go to https://dash.cloudflare.com → Workers → joinshug
2. Click **Logs**
3. Look for errors in the last 5 minutes
4. If you see `retell: inbound webhook`, screenshot it and send to developer

**Step 3: Test a call with debug mode**

1. Call the number again
2. Immediately go to Cloudflare Logs (above)
3. Look for your incoming call
4. See if there's an error message
5. Send the error to the developer

**Step 4: Check if your config is complete**

1. Go to https://joinshug.com/app/ → Settings
2. Check these fields are filled in:
   - **Phone Number** (you need this)
   - **Business Name** (Shug says this)
   - At least one of: **Services Offered**, **Hours**
3. **If any are blank**: Fill them in
4. Wait 30 seconds
5. Call the number again and test

**Step 5: Rebuild the config cache**

The system caches your config (for speed). Sometimes the cache gets stale. To rebuild it:

1. Go to https://joinshug.com/app/ → Settings
2. Click **Business Name** field
3. Edit it (add a space at the end)
4. Save
5. Wait 10 seconds
6. Undo the edit and save again
7. Call the number again

---

## Issue 4: Calls Don't Appear in Dashboard (Calls Arriving But No Record)

### Symptoms
- People call and Shug answers
- You hear the recording on Retell (Retell sees the call)
- But it never shows up in your Shug dashboard
- No notification
- No lead created

### Most Likely Causes
1. **Call webhook is not getting to Shug** — Retell is not calling `/api/retell/webhook`
2. **Call webhook is failing** — Shug gets the webhook but crashes writing to D1
3. **Number is not in the database** — Retell sent the call but Shug doesn't know it's yours
4. **Retell API key is wrong** — The webhook signature can't be verified

### What to Do (in order)

**Step 1: Check the webhook URL in Retell**

In Retell dashboard:

1. Click **Phone Numbers**
2. Click your number
3. Look at **Call events webhook**
4. Should be exactly: `https://joinshug.com/api/retell/webhook`
5. **If wrong**: Fix it

**Step 2: Check Shug's logs for webhook delivery**

1. Go to https://dash.cloudflare.com → Workers → joinshug → Logs
2. Call the number (make a test call)
3. Wait 30 seconds
4. Look for a log line that says `retell: webhook`
5. **If you see it**: Shug got the webhook. Look for errors after that line.
6. **If you don't see it**: Retell isn't sending it. Check Retell's logs.

**Step 3: Check Retell's webhook logs**

In Retell dashboard:

1. Click **Developers** (at the bottom)
2. Click **Webhooks**
3. Look for recent events
4. Click on the most recent call event
5. Look for the response code
   - `200` = Shug received it OK
   - `4xx` = Shug rejected it (probably a signature mismatch)
   - `5xx` = Shug crashed
6. If it's not `200`: Click it and see the error
7. Send the error to the developer

**Step 4: Verify the webhook signature**

This is technical but critical. The developer must confirm:

1. The `RETELL_API_KEY` secret in Cloudflare matches the **webhook key** in Retell (not just any key)
2. In Retell dashboard, the key must have a **"WEBHOOK"** badge
3. To check:
   - In Cloudflare: `wrangler secret list` (shows if RETELL_API_KEY is set, but not its value)
   - In Retell: Click the API key and check for "WEBHOOK" badge

**If the badge is missing**: Generate a new key in Retell with the WEBHOOK badge, then tell the developer to update it.

---

## Issue 5: SMS / Email Notifications Aren't Sending

### Symptoms
- Calls come in and create leads (good)
- But you never get a text or email
- Dashboard badge works ("new leads: 3")
- But your phone stays silent

### Most Likely Cause
**SMS and email are not configured yet.** This is normal. See `NEEDS_CONFIG.md`.

### What to Do

**If you want texts:**

1. Get a Twilio account (https://www.twilio.com)
2. Get these from Twilio:
   - Account SID
   - Auth Token
   - From Number (the number texts come from)
3. Give those to the developer
4. Developer runs:
   ```
   npx wrangler secret put TWILIO_ACCOUNT_SID
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM_NUMBER
   ```
5. Developer updates `wrangler.toml` to add `SMS_PROVIDER = "twilio"`
6. Developer deploys
7. You get a text on the next call

**If you want emails:**

Similar process, but pick an email provider (Resend, Postmark, SendGrid, or AWS SES). No adapter exists yet, so the developer needs to write ~40 lines of code.

**Until then:** Rely on the dashboard badge ("new leads: 3") to know when someone called.

---

## Issue 6: I Changed My Phone Number / Business Name / Hours / Prices — Changes Don't Show on the Site or to Callers

### Symptoms
- You update settings in `/app/`
- Settings save (no error)
- But the dashboard still shows the old value
- Or Shug still speaks the old hours
- Or the landing page still shows the old price

### Most Likely Causes
1. **Browser cache** — Your browser is showing an old copy
2. **Server-side cache** — Shug cached your config and hasn't refreshed it yet
3. **Deploy needed** — If you changed prices in HTML, the marketing site needs to be redeployed

### What to Do

**For dashboard settings (hours, business name, services, etc.):**

1. Go to https://joinshug.com/app/
2. Press **Ctrl+Shift+R** (or **Cmd+Shift+R** on Mac) — this clears the browser cache
3. The settings should update immediately
4. Call yourself to test (Shug should speak the new hours)

**For prices or marketing copy:**

1. Go to https://joinshug.com
2. Press **Ctrl+Shift+R** (or **Cmd+Shift+R** on Mac)
3. If the change is on the page, it should show
4. **If it's still old**: The marketing site needs a code deploy (the developer changed HTML). This happens automatically when code is pushed to GitHub.

**If your settings save in the dashboard but don't take effect when you call:**

1. Go to Settings
2. Edit any field (add a space)
3. Save
4. The cache is being refreshed
5. Call yourself 5 seconds later
6. Should work now

---

## Issue 7: I Need to Change a Phone Number or Move to a Different Number

### Symptoms
- You want a new Shug number (ported from another carrier, or a new area code)
- Or you want to remove a number
- Or you want multiple numbers for tracking ads

### What to Do

This requires a developer (me). Here's what needs to happen:

**To add a new number:**

1. You provision it in Retell (you get a new number from Retell)
2. Tell me the new number
3. I add it to the database:
   ```
   wrangler d1 execute shug --remote --command "INSERT INTO phone_numbers (e164, business_id, label, status) VALUES ('+1-new-number', 'your-business-id', 'Ad Tracking', 'active');"
   ```
4. Point the webhooks in Retell at `/api/retell/inbound` and `/api/retell/webhook` (same URLs as your old number — they work for all numbers)
5. Test by calling the new number

**To change your primary number:**

1. Get the new number from Retell
2. Tell me the new number and your old number
3. I update the database to mark the old number inactive and make the new one primary
4. Update your dashboard Settings to show the new number
5. Test

**For multiple numbers (ad tracking, etc.):**

The system supports this. Each number routes to your business. Tell me the numbers and I'll add them.

---

## Issue 8: A Call Doesn't Appear or Appears Wrong (Duplicate Lead, Wrong Info, Missing Recording)

### Symptoms
- The same lead appears twice
- Lead info is wrong (wrong name, wrong service)
- Recording link is broken
- Call shows in Retell but not in Shug

### Most Likely Causes
1. **Caller had a weird phone number** (blocked ID, VoIP, etc.) — Shug couldn't deduplicate it
2. **Retell extraction failed** — Retell didn't understand the caller
3. **Network issue during webhook delivery** — Webhook arrived late or twice

### What to Do

**If the lead info is wrong:**

1. Open the lead in https://joinshug.com/app/
2. Edit the fields that are wrong
3. Click **Save**
4. The info is now yours to control

**If the lead appears twice:**

This is rare, but here's what to do:

1. Check if they're actually the same person (same phone number)
2. If yes: Pick the one with better info, add notes to it, then delete the other
   - Open the empty one
   - Click **Delete** at the bottom
   - Confirm
3. If no: They're actually two different callers (one had blocked ID, one gave a real number)

**If the recording link is broken:**

This is a Retell issue, not a Shug issue. The recording may have been deleted by Retell (they keep them for 90 days). There's nothing to fix.

---

## Issue 9: Database Migration Needs to Be Run ("Viewed At" Column)

### Symptoms
- You see this error: `no such column: leads.viewed_at`
- Or "New leads" badge doesn't work correctly
- Or you see this message somewhere: "Migration 001 required"

### What to Do

**This needs to be run once on production (not locally):**

Ask the developer to run this command:

```bash
wrangler d1 execute shug --remote --file=./migrations/001-leads-viewed-at.sql
```

That's it. This adds the `viewed_at` column to existing leads and indexes it. It's safe to run multiple times (after the first time, subsequent runs do nothing).

**Why this matters:** Without it, the "new leads: 3" badge counts all new leads, even ones you've already dealt with. With it, the count only shows leads you haven't opened yet.

---

## Issue 10: I Need to Roll Back a Deploy (Something Was Deployed That Broke Things)

### Symptoms
- Something worked yesterday, broke today
- You know a deploy went out in the last few hours
- You want to undo it

### What to Do

**Step 1: Go to Cloudflare**

1. https://dash.cloudflare.com → Workers → joinshug
2. Click **Deployments**
3. You'll see a list. The top one is the most recent (the broken one).

**Step 2: Find the last good deploy**

1. Look through the list for a deploy from before the problem started
2. Click it
3. It will show the timestamp and commit message
4. Click the **⋮** menu

**Step 3: Rollback**

1. Click **Rollback to this version**
2. Confirm
3. Wait 30 seconds
4. Test: https://joinshug.com/app/
5. Should work now

**After rollback:** Don't deploy again until the developer figures out what broke. The issue is in the code, not the infrastructure.

---

## Issue 11: Someone Can't Log In (Wrong Password, Locked Out, Etc.)

### Symptoms
- A team member can't log into https://joinshug.com/app/
- They get "Wrong password" even though they're sure it's right
- Or the account is locked

### What to Do

**Reset the password:**

1. Go to https://joinshug.com/app/
2. Click **Forgot password?**
3. Enter their email
4. They'll get a reset link (check spam folder)
5. They click it and set a new password
6. Try logging in again

**If they're locked out (too many failed attempts):**

The account is temporarily locked for security. Wait 30 minutes and try again. The lock automatically lifts.

**If you need to manually reset their password (they lost email access, etc.):**

This requires the developer. They can reset any password by:

```bash
wrangler d1 execute shug --remote --command "UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE email = 'person@example.com';"
```

Then the person can use "Forgot password" normally.

---

## Issue 12: Overage Billing (Used More Than 120 Minutes)

### Symptoms
- Your "87 of 120 minutes" shows over 100
- You got a lot of calls this month
- You want to know if you'll be charged extra

### How Overage Works

- You get 120 minutes per month (included in $99)
- Everything over 120 minutes is $0.40/minute overage
- Minutes round UP (a 30-second call = 1 minute)
- Monthly total is rounded up (so 121-180 seconds = 2 minutes, not 3)

### What to Do

1. Go to https://joinshug.com/app/ → Overview
2. Look at "Usage"
3. If it says "127 of 120 minutes", you've used 127 minutes and will be charged for 7 minutes of overage
4. Calculate: 7 minutes × $0.40 = $2.80 extra this month

**To reduce future overages:**
- Have Shug transfer calls to you earlier (don't let it try to solve everything)
- Hang up on calls that are clearly not prospects
- Set office hours so Shug doesn't answer after hours (if you prefer)

---

## Issue 13: Retell Agent Behavior Is Wrong (Says Wrong Hours, Books Wrong Dates, etc.)

### Symptoms
- Shug says you're open when you're closed
- Shug books appointments on the wrong day
- Shug says "press 1 for plumbing, press 2 for HVAC" (wrong menu)
- Shug is acting weird (says wrong business name, doesn't transfer correctly)

### What to Do

**Step 1: Check your dashboard settings**

1. Go to https://joinshug.com/app/ → Settings
2. Verify:
   - **Business Name** is correct (Shug says this)
   - **Hours** are correct (Shug says this)
   - **Services Offered** are correct
   - **Transfer Number** is your actual phone (if you have one set)
   - **Timezone** is correct (affects how Shug bills calls)
3. If anything is wrong: **Fix it**
4. Clear your browser cache and test: **Ctrl+Shift+R**, then call

**Step 2: Check your Retell agent prompt**

This is advanced, but Shug's behavior is defined in two places:

- **Dynamic variables** (your business settings) — handled above
- **Retell agent prompt** — the detailed instructions Retell's AI follows

If your settings are correct but Shug still acts wrong:

1. Go to https://dashboard.retellai.com
2. Click **Agents**
3. Look for the agent connected to your number
4. The prompt probably says something like "You work for **{{business_name}}** in **{{service_area}}**..."
5. This prompt was set up when you were provisioned
6. **If the prompt is wrong**: The developer needs to update it in Retell (this is out of scope for an owner)

**Step 3: If the agent is genuinely broken**

Tell the developer: "The Retell agent is saying X but should say Y." They can:

1. Update the prompt in Retell
2. Or rebuild the agent entirely from scratch

---

## Issue 14: Jobber Integration Not Working (Appointments Not Appearing in Jobber)

### Symptoms
- You have Jobber CRM
- You set dashboard "Send bookings to Jobber"
- But appointments never show up in Jobber
- Dashboard shows "Delivery failed" for leads

### What to Do

**Step 1: Check the setting**

1. Go to https://joinshug.com/app/ → Settings
2. Look for "Where should appointments go?"
3. Is it set to "Jobber"?
4. **If not**: Set it to Jobber

**Step 2: Check if Jobber is connected**

The developer needs to check if you have OAuth credentials set up. Run:

```bash
wrangler secret list
```

Look for:
- `JOBBER_CLIENT_ID`
- `JOBBER_CLIENT_SECRET`

**If they're not set:** You need to connect Jobber. This is in `NEEDS_CONFIG.md` — the developer needs to:

1. Get your Jobber client credentials
2. Register the redirect URL: `https://joinshug.com/api/jobber/callback`
3. Set the secrets
4. Test

**Step 3: Test the connection**

Once set up, the developer should:

1. Manually create a lead with a booking in Shug
2. Check if it appeared in Jobber
3. If not: Check the `leads` table for `delivery_error` column (shows what went wrong)

---

## Issue 15: Google Calendar Integration Not Working (Appointments Not Appearing in Calendar)

### Symptoms
- Similar to Jobber above
- You set dashboard to Google Calendar
- But appointments don't show up

### What to Do

**Currently:** Google Calendar integration is built in code but never tested end-to-end. Ask the developer to:

1. Connect to Google Calendar using OAuth (similar to Jobber setup)
2. Test by creating a booking
3. Verify it appears in your calendar

---

## Issue 16: I Lost Credentials for Cloudflare, Retell, Twilio, etc.

### What to Do

**For Cloudflare:** Go to https://dash.cloudflare.com and log in with your email

**For Retell:** Go to https://dashboard.retellai.com and log in

**For Twilio:** Go to https://www.twilio.com and log in

If you forgot your password, each service has a "Forgot password" link. Use it to reset.

**For developer access (wrangler commands):**

You shouldn't need this — the developer has it. But if you do:

```bash
wrangler login
```

Your browser will open and ask you to authorize. That's all you need.

---

## Issue 17: Production Data Issue (Leading to Data Loss, Corruption, Duplicate Records)

### Symptoms
- Leads are disappearing
- Call records are getting messed up
- Multiple copies of the same lead
- Data in the dashboard is wrong and won't update

### What to Do

**Stop. Call the developer immediately.**

These issues require direct database inspection and possibly manual data repair. Don't try to fix this yourself — you can make it worse.

The developer will:

1. Connect to D1 and inspect the tables
2. Identify what went wrong
3. Repair the data (via direct SQL or by reprocessing webhooks)
4. Verify everything is consistent

---

## Reference: Critical Credentials (For the Developer)

| Name | Where it's used | Set? | How to check |
|---|---|---|---|
| `RETELL_API_KEY` | Webhooks, call setup | ⚠️ CHECK | `wrangler secret list` |
| `ADMIN_TOKEN` | Provision customers | ⚠️ CHECK | `wrangler secret list` |
| `TWILIO_ACCOUNT_SID` | SMS sending | ❌ Not yet | `wrangler secret list` |
| `TWILIO_AUTH_TOKEN` | SMS sending | ❌ Not yet | `wrangler secret list` |
| `TWILIO_FROM_NUMBER` | SMS sending | ❌ Not yet | Check `wrangler.toml` |

---

## Reference: Key URLs

| What | URL |
|---|---|
| **Marketing site** | https://joinshug.com |
| **Dashboard** | https://joinshug.com/app/ |
| **Pricing** | https://joinshug.com/pricing/ |
| **Cloudflare dashboard** | https://dash.cloudflare.com |
| **Retell dashboard** | https://dashboard.retellai.com |
| **Retell status** | https://www.retellstatus.com |
| **Cloudflare status** | https://www.cloudflarestatus.com |

---

## Reference: Common Commands (For the Developer)

```bash
# Deploy code
npx wrangler deploy

# Check live logs
npx wrangler tail

# Run migrations
wrangler d1 execute shug --remote --file=./migrations/001-leads-viewed-at.sql

# Run tests locally
npx wrangler dev --port 8787 &
node tests/run.mjs

# Set a secret
npx wrangler secret put SECRET_NAME

# List secrets
npx wrangler secret list

# Check what's running
wrangler deployments list
```

---

## When to Call the Developer

- Anything in the database is broken or missing
- A deploy broke something
- Cloudflare/Retell/Twilio credentials need to be configured
- You see error messages in the logs
- The system is getting slow or timing out
- You need to add a feature or change the system design
- You can't fix it with the steps above

---

## Summary: The 3-Step Debug Process

1. **Is it the Internet?** — Can you reach Google? Can you reach joinshug.com?
2. **Is it Shug?** — Can you reach Cloudflare Logs? Are there errors?
3. **Is it your config?** — Are your Settings filled in? Are the Retell webhooks right?

Most issues fall into one of these three buckets. 80% of the time, it's #3 (something in your Settings).
