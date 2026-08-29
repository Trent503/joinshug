/**
 * retell/tests/personas.mjs — Test personas and expected transcripts.
 *
 * Each persona represents a real call scenario. The expectedTranscript shows
 * what the agent should say (annotated with assertions). Tests validate:
 * - One question per agent turn
 * - Correct readbacks of critical fields
 * - Proper lead/booking creation
 * - Correct call classification
 */

export const personas = {
  agent1: [
    // Agent 1: Client Estimate Agent (exterior cleaning)

    {
      name: 'Happy Path: Estimate Booking with Readback',
      description: 'Prospect calls, provides info, books estimate visit with readback',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: 'Sarah Chen',
        phone: '+15035552847',
        address: '1247 NW Lovejoy Street, Portland, OR 97209',
        service: 'Roof moss removal',
        urgency: null,
        preferred_time: 'This week if possible'
      },
      expectedBooking: {
        calendar_name: 'Estimate Visit',
        status: 'requested', // agent books it, owner confirms
        has_date: true,
        has_start_time: true,
        has_readback: true
      },
      expectedReadbacks: [
        {
          type: 'phone',
          contains: '+15035552847'
        },
        {
          type: 'address',
          contains: '1247 NW Lovejoy'
        }
      ],
      expectedTranscript: `
Agent: Thanks for calling Clear View Exterior. What brings you in today?
Caller: We've got moss on the roof that needs to come off.
Agent: I can help with that. What's the address of the property?
Caller: 1247 NW Lovejoy Street, Portland.
Agent: Got it. And what's the best phone to reach you at?
Caller: 503-555-2847.
Agent: Got 503-555-2847. I can schedule a 60-minute estimate visit. Are Saturdays work, or weekdays better?
Caller: Weekdays. Maybe this week?
Agent: I've got Tuesday at 10 AM or Wednesday at 2 PM. Which works?
Caller: Wednesday at 2 PM.
Agent: Perfect. I've scheduled your estimate for Wednesday, September 4th at 2 PM at 1247 NW Lovejoy Street, Portland, OR. We'll call a few minutes before. Your phone is 503-555-2847, correct?
Caller: Yes, that's right.
Agent: Great. You're all set. We'll see you Wednesday at 2 PM.
      `
    },

    {
      name: 'Out-of-Specialty: Callback vs Estimate',
      description: 'Caller requests septic work (outside specialty) — books callback, not estimate',
      shouldCreateLead: true,
      shouldCreateBooking: false, // callback, not estimate
      expectedLead: {
        name: 'Mike Garcia',
        phone: '+15035551902',
        service: 'Septic system cleaning',
        status: 'callback_requested'
      },
      expectedReadbacks: [],
      expectedTranscript: `
Agent: Thanks for calling. What can we help you with today?
Caller: We need our septic tank pumped out.
Agent: I appreciate the call, but septic work isn't something we handle. I'm going to have someone from our team give you a callback to see if we can point you in the right direction. What's your number?
Caller: 503-555-1902.
Agent: 503-555-1902, got it. Someone will call you back within a couple hours. Thanks for calling.
      `
    },

    {
      name: 'Spam Caller: Polite Exit',
      description: 'GBP/SEO/ad pitch — agent ends call politely, no lead logged',
      shouldCreateLead: false,
      shouldCreateBooking: false,
      expectedReadbacks: [],
      expectedTranscript: `
Agent: Thanks for calling Clear View Exterior. How can we help?
Caller: Yeah, I'm calling about getting your business on Google Business Profile...
Agent: I appreciate the call, but we're not interested. Have a good one.
[Call ends]
      `
    },

    {
      name: 'Complaint Caller: Acknowledge, Collect, No Estimate',
      description: 'Previous customer calling about completed work — acknowledge sincerely, collect details, no estimate booking',
      shouldCreateLead: true,
      shouldCreateBooking: false,
      expectedLead: {
        name: 'David Wilson',
        phone: '+15035559213',
        address: '3401 SE Division Street',
        service: 'Gutter cleaning (completed work)',
        status: 'complaint'
      },
      expectedReadbacks: [
        { type: 'phone', contains: '+15035559213' },
        { type: 'address', contains: 'SE Division' }
      ],
      expectedTranscript: `
Agent: Thanks for calling. What's going on?
Caller: We had you guys clean our gutters last month, and now there's leaves back in them already.
Agent: I hear you. That's frustrating. Let me get some details so someone can look into this. What's your name?
Caller: David Wilson.
Agent: David. And the best number to reach you?
Caller: 503-555-9213.
Agent: 503-555-9213. And the address where the work was done?
Caller: 3401 Southeast Division.
Agent: 3401 SE Division. When did we clean the gutters?
Caller: About four weeks ago. And it's just full of leaves again.
Agent: I understand. Someone from our team will give you a call within a couple hours to look into this. Is there anything else I should note?
Caller: No, just... it feels like the work didn't stick.
Agent: I get it. We'll have someone reach out. Thanks for calling.
      `
    },

    {
      name: 'Rambler: Patient One-Question-at-a-Time',
      description: 'Caller is verbose and takes time to answer — agent waits patiently, asks one question at a time',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: null,
        phone: '+15035554401',
        address: '5555 Southwest Barbur Boulevard',
        service: 'Gutter cleaning/replacement',
        urgency: null
      },
      expectedBooking: {
        calendar_name: 'Estimate Visit',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'phone', contains: '+15035554401' }
      ],
      expectedTranscript: `
Agent: Thanks for calling. What brings you in today?
Caller: Well, you know, we've got this house, been there about eight years now, and the gutters... I don't know, they're just getting out of hand. We're talking about the whole east side of the place, and every time it rains, water's just... everywhere. It's actually causing some staining on the brick.
Agent: Okay, so you need the gutters cleaned or replaced?
Caller: I think cleaned. Or maybe both? We'd have to see. It's the whole east side, really. And maybe part of the north side too if we're being honest.
Agent: That sounds like a job we can handle. What's the address?
Caller: Oh, it's 5555 Southwest Barbur Boulevard. It's the... well, it's the one with the brick on two sides. Used to be a rental property but we live there now.
Agent: Got it. 5555 Southwest Barbur. And what's the best phone to reach you at?
Caller: 503-555-4401. That's my cell, which I pretty much always have.
Agent: 503-555-4401. Perfect. I can schedule a 60-minute estimate visit. What day would work best?
Caller: Hmm, well... weekdays are rough with work, but we could do a Saturday if that's available.
Agent: We can do Saturday. This Saturday, September 7th, I have 9 AM or 1 PM. Which works?
Caller: 9 AM would be better, gets us started early.
Agent: Great. Saturday, September 7th at 9 AM for your estimate at 5555 Southwest Barbur Boulevard. Your phone is 503-555-4401. Is that correct?
Caller: Yes, that's right.
Agent: You're all set. See you Saturday morning.
      `
    },

    {
      name: 'Interrupter: Handles Caller Interruptions Smoothly',
      description: 'Caller interrupts mid-question — agent resumes without confusion',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: null,
        phone: '+15035555500',
        address: '2020 NE Sandy Blvd',
        service: 'Gutter cleaning',
        urgency: null
      },
      expectedBooking: {
        calendar_name: 'Estimate Visit',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'phone', contains: '+15035555500' }
      ],
      expectedTranscript: `
Agent: Thanks for calling. What can we help you with?
Caller: We need—
Agent: Our service area is—
Caller: —we need the gutters cleaned before winter.
Agent: Got it. Gutters before winter. What's the address?
Caller: 2020 NE Sandy Blvd, and we're in—
Agent: 2020 NE Sandy. And the best phone to reach you?
Caller: —we're in Portland proper, yeah. 503-555-5500.
Agent: 503-555-5500. I can book a 60-minute estimate. When would you like to come in?
Caller: ASAP. Like this week?
Agent: I have Thursday at 3 PM or Friday at 10 AM. Either work?
Caller: Friday 10.
Agent: Friday, September 6th at 10 AM at 2020 NE Sandy Boulevard. Your phone is 503-555-5500, right?
Caller: Yes.
Agent: Perfect. You're all set.
      `
    },

    {
      name: 'Mid-Call Correction: Address Updated in Readback',
      description: 'Caller initially says one address, then corrects it — readback uses corrected address',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: null,
        phone: '+15035556789',
        address: '4040 NE 33rd Avenue',
        service: 'Gutter cleaning',
        urgency: null
      },
      expectedBooking: {
        calendar_name: 'Estimate Visit',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'address', contains: '4040 NE 33rd' }
      ],
      expectedTranscript: `
Agent: Thanks for calling. What do you need?
Caller: Gutter cleaning. We live at 3333 NE 32nd Avenue.
Agent: Got it. 3333 NE 32nd. And what's your phone number?
Caller: 503-555-6789. Oh wait, actually—I gave you the wrong address. It's 4040 NE 33rd, not 32nd. Sorry about that.
Agent: No problem. So it's 4040 NE 33rd. And your phone is 503-555-6789?
Caller: Yes, that's right.
Agent: Perfect. I've got an estimate slot for Monday at 2 PM. That work?
Caller: Yes, Monday is fine.
Agent: Excellent. Monday, September 9th at 2 PM at 4040 NE 33rd Avenue. We'll confirm your phone at 503-555-6789. Correct?
Caller: Correct.
Agent: Great. See you Monday.
      `
    }
  ],

  agent2: [
    // Agent 2: SHUG Front-Page Demo Agent

    {
      name: 'Happy Path: Business Info → Demo Booking',
      description: 'Prospect explains business, agent gathers details, books demo',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: 'Jessica',
        business_name: 'Phoenix Roofing',
        trade: 'roofing',
        phone: '+15035557823',
        city: 'Portland, OR',
        status: 'demo_booked'
      },
      expectedBooking: {
        calendar_name: 'SHUG Demo Call',
        status: 'requested',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'phone', contains: '503-555-7823' },
        { type: 'date_time', contains: 'Tuesday' }
      ],
      expectedTranscript: `
Agent: Hey, thanks for calling SHUG. This is the SHUG Agent. What kind of business do you run?
Caller: We do roofing, mostly residential. Been around for about five years.
Agent: Nice. Residential roofing. And where are you based?
Caller: Portland, Oregon.
Agent: Portland. And what's your first name?
Caller: Jessica.
Agent: Jessica, and the business name?
Caller: Phoenix Roofing.
Agent: Phoenix Roofing. Jessica, what's the best phone to reach you at for a demo call?
Caller: 503-555-7823.
Agent: 503-555-7823. I'd love to show you how SHUG works—that's an AI receptionist that answers calls 24/7, books appointments, qualifies leads. Would a call this week work?
Caller: Yeah, definitely. Maybe Tuesday or Wednesday?
Agent: Tuesday or Wednesday. I have Tuesday at 10 AM or Wednesday at 2 PM. Which works better?
Caller: Tuesday at 10 AM.
Agent: Perfect. So that's Tuesday, September 10th at 10 AM. We'll call you at 503-555-7823. Your business is Phoenix Roofing in Portland. Sound right?
Caller: Yes, exactly.
Agent: Great. I'll have someone from the SHUG team call you Tuesday at 10. Thanks for calling.
      `
    },

    {
      name: 'AI Question: Natural Transparency Answer',
      description: 'Prospect asks if agent is AI — gets straightforward answer and continues',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: 'Tom',
        business_name: 'T&T Plumbing',
        trade: 'plumbing',
        phone: '+15415559999',
        city: 'Eugene'
      },
      expectedBooking: {
        calendar_name: 'SHUG Demo Call',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [],
      expectedTranscript: `
Agent: Hey, thanks for calling SHUG. What kind of business do you run?
Caller: Wait, is this... are you a robot?
Agent: Yep. I'm the SHUG Agent. But I can still help you schedule a demo of how I handle customer calls for your business. What do you do?
Caller: Oh, okay. We're a plumbing company in Eugene.
Agent: Plumbing in Eugene. Nice. What's your first name?
Caller: Tom.
Agent: Tom. Your business name?
Caller: T&T Plumbing. And honestly, we've been thinking about something like this. Missing calls, you know.
Agent: That's the exact problem SHUG solves. Your phone never goes to voicemail again. What's the best number to reach you for a demo?
Caller: 541-555-9999.
Agent: 541-555-9999. And what's your city?
Caller: Eugene.
Agent: Perfect, Tom. I've got slots this Thursday or Friday. Which works?
Caller: Thursday afternoon.
Agent: Thursday at 2 PM—I can do that. So Thursday, September 12th at 2 PM, we'll call you at 541-555-9999. You're Tom with T&T Plumbing in Eugene. Sound right?
Caller: Perfect.
Agent: Great. Talk Thursday.
      `
    },

    {
      name: 'Rambler: Gentle Pacing, One Question at a Time',
      description: 'Prospect tells long story about business challenges — agent gently asks one thing at a time',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: 'Marcus',
        business_name: 'Cohen HVAC',
        trade: 'HVAC',
        phone: '+15035558844',
        city: 'Salem'
      },
      expectedBooking: {
        calendar_name: 'SHUG Demo Call',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'phone', contains: '+15035558844' }
      ],
      expectedTranscript: `
Agent: Hey, thanks for calling SHUG. What kind of business do you run?
Caller: Well, we do HVAC work, heating and cooling, and... man, I tell you, the phone situation is killing us. My wife takes calls, I take calls when I can, and we're both getting overwhelmed. Like, we got two techs in the field and someone's always having to come in just to take a message or schedule something. It's ridiculous, honestly.
Agent: Yeah, that's super common. That's actually what SHUG is designed for. What's your first name?
Caller: Oh, it's Marcus. Marcus Cohen.
Agent: Marcus. And your business name?
Caller: Cohen HVAC. We've been doing this for about twelve years, mostly residential but some commercial too.
Agent: Cohen HVAC. Where are you located?
Caller: We're in the Salem area. Oregon.
Agent: Salem. Got it. Marcus, what would be the best number to call you for a demo?
Caller: 503-555-8844. It's actually my cell but I use it for business too.
Agent: 503-555-8844. Perfect. I can schedule a call this week or next to show you how SHUG takes those calls off your plate. Would this week work?
Caller: Yeah, early next week would be better. Like Monday or Tuesday?
Agent: Monday or Tuesday—I can do that. Monday at 11 AM or Tuesday at 3 PM?
Caller: Tuesday at 3 PM sounds good.
Agent: Tuesday, September 11th at 3 PM. We'll call you at 503-555-8844. Marcus with Cohen HVAC in Salem. That right?
Caller: Perfect. Thanks for calling back the—I mean, thanks for answering. You know what I mean.
Agent: I know exactly. Talk Tuesday.
      `
    },

    {
      name: 'Unclear Info: Readback for Confirmation',
      description: 'Prospect mumbles phone number or spelling — agent reads back to confirm',
      shouldCreateLead: true,
      shouldCreateBooking: true,
      expectedLead: {
        name: 'Nguyen',
        business_name: 'Pacific Electric',
        trade: 'electrical',
        phone: '+15033331122',
        city: 'Portland'
      },
      expectedBooking: {
        calendar_name: 'SHUG Demo Call',
        has_date: true,
        has_start_time: true
      },
      expectedReadbacks: [
        { type: 'phone', contains: '+15033331122' },
        { type: 'name', contains: 'Nguyen' }
      ],
      expectedTranscript: `
Agent: Hey, thanks for calling SHUG. What kind of business do you run?
Caller: Uh, we do electrical work. Residential and commercial both.
Agent: Nice. What's your first name?
Caller: Nguyen. Well, Noo-yen, but everybody just says it different.
Agent: Okay, Nguyen. Got it. Your business name?
Caller: Pacific Electric.
Agent: Pacific Electric. And where are you?
Caller: Portland.
Agent: Portland. And Nguyen, what's the best phone for us to call you on?
Caller: Uh... 503... 333... 1122. No wait, is that 333 or 334? Let me think. 333.
Agent: Okay, so 503-333-1122. Is that right?
Caller: Yes, that's it.
Agent: Perfect. So Nguyen with Pacific Electric in Portland, we'll call you at 503-333-1122. Would this Friday or Monday work for a quick demo?
Caller: Monday is better.
Agent: Monday at 10 AM?
Caller: Yeah, 10 AM is good.
Agent: Monday, September 9th at 10 AM. We'll call you at 503-333-1122. Sound good?
Caller: Good.
Agent: Great. Talk Monday.
      `
    }
  ]
};
