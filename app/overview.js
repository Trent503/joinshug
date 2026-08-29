/* Shug — /app/ overview.

   One API call. The page renders from a single /api/overview response rather
   than six requests, because the first screen after signing in is the one where
   a chain of round trips is most visible. */

import {
  api, mount, shellBanners, el, esc, pill, phone, duration, when,
  bookingDate, clockTime, emptyState, skeleton, toastError
} from './app.js';

el('content').innerHTML = '<div class="card">' + skeleton(4) + '</div>';

function statCard(label, value, note, alert) {
  return '<div class="stat' + (alert ? ' is-alert' : '') + '">' +
    '<div class="k">' + esc(label) + '</div>' +
    '<div class="v">' + esc(String(value)) + '</div>' +
    (note ? '<div class="n">' + esc(note) + '</div>' : '') +
    '</div>';
}

/* The minutes card is the one a customer checks before they worry about a
   bill, so it says the whole story — used, allowance, and what is left — not
   just a percentage. */
function minutesCard(usage) {
  const high = usage.percentUsed >= 80;
  const note = usage.overage
    ? usage.overageMinutes + ' min over your 120'
    : usage.minutesRemaining + ' min left this month';

  return '<div class="stat' + (usage.overage ? ' is-alert' : '') + '">' +
    '<div class="k">AI minutes</div>' +
    '<div class="v">' + usage.minutesUsed + '<span style="font-size:20px;color:var(--dim)"> / ' +
      usage.minutesIncluded + '</span></div>' +
    '<div class="meter' + (high ? ' is-high' : '') + '">' +
      '<i style="width:' + Math.min(100, usage.percentUsed) + '%"></i></div>' +
    '<div class="n">' + esc(note) + '</div>' +
    '</div>';
}

function leadRow(lead) {
  return '<a class="row" href="/app/leads/?id=' + encodeURIComponent(lead.id) + '">' +
    '<div class="row-main">' +
      '<b>' + esc(lead.name || phone(lead.phone) || 'Unknown caller') + '</b>' +
      '<span>' + esc(lead.service || lead.job_description || 'No detail captured') + '</span>' +
    '</div>' +
    '<div class="row-side">' + pill(lead.status) + '</div>' +
    '</a>';
}

function bookingRow(booking) {
  const time = booking.start_time
    ? clockTime(booking.start_time) + (booking.end_time ? '–' + clockTime(booking.end_time) : '')
    : 'Time not set';

  return '<a class="row" href="/app/leads/?id=' + encodeURIComponent(booking.lead_id || '') + '">' +
    '<div class="row-main">' +
      '<b>' + esc(booking.lead_name || phone(booking.lead_phone) || 'Unnamed') + '</b>' +
      '<span>' + esc(booking.service || 'Visit') + ' · ' + esc(time) + '</span>' +
    '</div>' +
    '<div class="row-side">' + esc(bookingDate(booking.date) || 'No date') + '</div>' +
    '</a>';
}

function followUpRow(followUp) {
  return '<a class="row" href="/app/leads/?id=' + encodeURIComponent(followUp.lead_id || '') + '">' +
    '<div class="row-main">' +
      '<b>' + esc(followUp.lead_name || phone(followUp.lead_phone) || 'Unnamed') + '</b>' +
      '<span>' + esc(followUp.notes || String(followUp.type).replace(/_/g, ' ')) + '</span>' +
    '</div>' +
    '<div class="row-side">' + esc(when(followUp.scheduled_for)) + '</div>' +
    '</a>';
}

function activityRow(event) {
  if (event.kind === 'call') {
    const target = event.lead_id
      ? '/app/leads/?id=' + encodeURIComponent(event.lead_id)
      : '/app/calls/';
    return '<a class="row" href="' + target + '">' +
      '<div class="row-main">' +
        '<b>Call from ' + esc(event.name || phone(event.phone) || 'unknown') + '</b>' +
        '<span>' + esc(event.summary || 'No summary') + '</span>' +
      '</div>' +
      '<div class="row-side">' + esc(duration(event.duration_sec)) + ' · ' +
        esc(when(event.at)) + '</div>' +
      '</a>';
  }

  return '<a class="row" href="/app/leads/?id=' + encodeURIComponent(event.lead_id) + '">' +
    '<div class="row-main">' +
      '<b>New lead: ' + esc(event.name || phone(event.phone) || 'Unknown') + '</b>' +
      '<span>' + esc(event.service || 'No service captured') + '</span>' +
    '</div>' +
    '<div class="row-side">' + esc(when(event.at)) + '</div>' +
    '</a>';
}

function card(title, link, linkText, rows, emptyTitle, emptyNote) {
  return '<section class="card">' +
    '<div class="card-head"><h2>' + esc(title) + '</h2>' +
    (link ? '<a href="' + link + '">' + esc(linkText) + '</a>' : '') + '</div>' +
    (rows.length
      ? '<div class="rows">' + rows.join('') + '</div>'
      : emptyState(emptyTitle, emptyNote)) +
    '</section>';
}

async function render() {
  const me = await mount('/app/');
  if (!me) return;

  el('banners').innerHTML = shellBanners(me);

  const data = await api('/api/overview');
  const counts = data.counts;

  el('sub').textContent = data.business.name + ' · ' + phone(data.business.phone);

  el('content').innerHTML =
    '<div class="grid g-stats" style="margin-bottom:18px">' +
      statCard('New leads', counts.newLeads, 'waiting on you', counts.newLeads > 0) +
      statCard('Booked', counts.upcomingBookings, 'upcoming visits') +
      statCard('Follow-ups due', counts.followUpsDue, 'past their date', counts.followUpsDue > 0) +
      statCard('Calls this month', counts.callsThisMonth, counts.leadsThisMonth + ' became leads') +
      minutesCard(data.usage) +
    '</div>' +

    '<div class="grid g-2" style="margin-bottom:18px">' +
      card('New leads', '/app/leads/?status=new', 'All leads',
        data.newLeads.map(leadRow),
        'No new leads', 'When your agent captures one, it lands here.') +
      card('Upcoming bookings', null, null,
        data.bookings.map(bookingRow),
        'Nothing booked', 'Bookings appear here once a caller asks for a slot.') +
    '</div>' +

    '<div class="grid g-2" style="margin-bottom:18px">' +
      card('Follow-ups due', null, null,
        data.followUps.map(followUpRow),
        'Nothing due', 'Follow-ups you set on a lead show up here when their date arrives.') +
      card('Recent activity', '/app/calls/', 'All calls',
        data.activity.map(activityRow),
        'Nothing yet', 'Your first call will show up here.') +
    '</div>';
}

render().catch(function (e) {
  el('content').innerHTML = emptyState('Could not load your dashboard', e.message);
  toastError(e);
});
