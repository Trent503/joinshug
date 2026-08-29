/* Shug — /app/leads/

   Two views in one page, chosen by ?id=. A separate route for detail would
   need either a server-side rewrite or a client router, and both are more
   machinery than a query parameter for a page that has exactly two states.

   LEAD DETAIL IS THE WORKHORSE. A contractor lives here: who called, what they
   want, where it is, every call they have made with summaries and transcripts,
   the booking, the follow-ups, and their own notes — one screen, one request. */

import {
  api, mount, shellBanners, el, esc, pill, phone, duration, when,
  bookingDate, clockTime, emptyState, skeleton, toast, toastError,
  formValues, submitting
} from './app.js';

const STATUSES = ['new', 'contacted', 'qualified', 'booked', 'completed', 'lost'];
const root = el('page');

let me = null;

/* ---- List -------------------------------------------------------------- */

function listShell(activeStatus, query) {
  const chips = ['<button class="chip" type="button" data-status="" aria-pressed="' +
    (!activeStatus) + '">All</button>'];

  for (const status of STATUSES) {
    chips.push('<button class="chip" type="button" data-status="' + status +
      '" aria-pressed="' + (activeStatus === status) + '">' +
      esc(status.charAt(0).toUpperCase() + status.slice(1)) + '</button>');
  }

  return '<div class="top">' +
      '<div><h1>Leads</h1><p class="sub" id="sub">&nbsp;</p></div>' +
      '<button class="btn" type="button" data-new-lead>Add a lead</button>' +
    '</div>' +
    '<div id="banners">' + shellBanners(me) + '</div>' +
    '<div id="newlead"></div>' +
    '<div class="filters">' + chips.join('') +
      '<div class="search"><label class="vh" for="q">Search leads</label>' +
      '<input id="q" type="search" placeholder="Search name, number, service…" value="' +
        esc(query || '') + '"></div>' +
    '</div>' +
    '<section class="card" style="padding:18px 6px 6px"><div id="rows">' +
      skeleton(5) + '</div></section>';
}

function leadRowHtml(lead) {
  const detail = lead.service || lead.job_description || '';
  return '<tr data-id="' + esc(lead.id) + '" tabindex="0">' +
    '<td class="name">' + esc(lead.name || 'Unknown caller') +
      (detail ? '<div class="sub-line">' + esc(detail) + '</div>' : '') + '</td>' +
    '<td class="num">' + esc(phone(lead.phone)) + '</td>' +
    '<td class="tight">' + pill(lead.status) + '</td>' +
    '<td class="num">' + (lead.call_count || 0) + '</td>' +
    '<td class="num">' + esc(when(lead.last_call_at || lead.created_at)) + '</td>' +
    '</tr>';
}

async function loadList(status, query) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (query) params.set('q', query);
  params.set('limit', '200');

  const data = await api('/api/leads?' + params.toString());
  const rowsNode = el('rows');

  el('sub').textContent = data.total === 1 ? '1 lead' : data.total + ' leads';

  if (data.leads.length === 0) {
    rowsNode.innerHTML = emptyState(
      status || query ? 'No leads match that' : 'No leads yet',
      status || query
        ? 'Try a different filter.'
        : 'When your agent answers a call and captures a name or a job, it lands here.'
    );
    return;
  }

  rowsNode.innerHTML = '<div class="tablewrap"><table>' +
    '<thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Calls</th><th>Last activity</th></tr></thead>' +
    '<tbody>' + data.leads.map(leadRowHtml).join('') + '</tbody></table></div>';
}

function openLead(id) {
  location.search = '?id=' + encodeURIComponent(id);
}

function renderList() {
  const params = new URLSearchParams(location.search);
  const status = params.get('status') || '';
  const query = params.get('q') || '';

  root.innerHTML = listShell(status, query);

  root.addEventListener('click', function (event) {
    const chip = event.target.closest('[data-status]');
    if (chip) {
      const next = new URLSearchParams(location.search);
      if (chip.dataset.status) next.set('status', chip.dataset.status);
      else next.delete('status');
      location.search = next.toString();
      return;
    }

    if (event.target.closest('[data-new-lead]')) { showNewLeadForm(); return; }

    const row = event.target.closest('tr[data-id]');
    if (row) openLead(row.dataset.id);
  });

  /* Rows are clickable, so they must also be operable from the keyboard. */
  root.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-id]');
    if (!row) return;
    event.preventDefault();
    openLead(row.dataset.id);
  });

  /* Debounced so typing does not fire a query per keystroke. */
  let searchTimer = null;
  el('q').addEventListener('input', function (event) {
    clearTimeout(searchTimer);
    const value = event.target.value.trim();
    searchTimer = setTimeout(function () {
      loadList(status, value).catch(toastError);
    }, 250);
  });

  loadList(status, query).catch(function (e) {
    el('rows').innerHTML = emptyState('Could not load leads', e.message);
  });
}

function showNewLeadForm() {
  const host = el('newlead');
  if (host.innerHTML) { host.innerHTML = ''; return; }

  host.innerHTML = '<section class="card" style="margin-bottom:16px">' +
    '<div class="card-head"><h2>Add a lead</h2></div>' +
    '<form id="lead-form">' +
      '<div class="row-2">' +
        '<div class="field"><label for="nl-name">Name</label>' +
          '<input id="nl-name" name="name" autocomplete="off"></div>' +
        '<div class="field"><label for="nl-phone">Phone</label>' +
          '<input id="nl-phone" name="phone" type="tel" autocomplete="off"></div>' +
      '</div>' +
      '<div class="row-2">' +
        '<div class="field"><label for="nl-service">Service</label>' +
          '<input id="nl-service" name="service" autocomplete="off"></div>' +
        '<div class="field"><label for="nl-address">Address</label>' +
          '<input id="nl-address" name="address" autocomplete="off"></div>' +
      '</div>' +
      '<div class="field"><label for="nl-notes">Notes</label>' +
        '<textarea id="nl-notes" name="notes"></textarea></div>' +
      '<button class="btn" type="submit" id="nl-save">Add lead</button>' +
    '</form></section>';

  el('lead-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const values = formValues(event.target);

    if (!values.name && !values.phone) {
      toast('A lead needs at least a name or a phone number.', true);
      return;
    }

    await submitting(el('nl-save'), async function () {
      try {
        const created = await api('/api/leads', { method: 'POST', body: values });
        toast('Lead added.');
        openLead(created.lead.id);
      } catch (e) { toastError(e); }
    });
  });

  el('nl-name').focus();
}

/* ---- Detail ------------------------------------------------------------ */

function kvRow(label, value) {
  const blank = !value;
  return '<dt>' + esc(label) + '</dt>' +
    '<dd class="' + (blank ? 'blank' : '') + '">' +
      (blank ? 'Not captured' : esc(value)) + '</dd>';
}

function callBlock(call) {
  const transcript = call.transcript
    ? '<details class="call-more"><summary>Transcript</summary>' +
      '<div class="transcript">' + esc(call.transcript) + '</div></details>'
    : '';

  const sentiment = call.user_sentiment
    ? ' · ' + esc(call.user_sentiment)
    : '';

  return '<div class="call">' +
    '<div class="call-head">' +
      '<b>' + esc(when(call.started_at)) + '</b>' +
      '<span>' + esc(duration(call.duration_sec)) + sentiment + '</span>' +
    '</div>' +
    '<div class="call-sum">' + esc(call.summary || 'No summary was produced for this call.') + '</div>' +
    transcript +
    '</div>';
}

function bookingBlock(booking) {
  const time = booking.start_time
    ? clockTime(booking.start_time) + (booking.end_time ? '–' + clockTime(booking.end_time) : '')
    : 'Time not set';

  const actions = booking.status === 'requested' || booking.status === 'confirmed'
    ? '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">' +
      (booking.status === 'requested'
        ? '<button class="btn btn-sm" type="button" data-booking="' + esc(booking.id) +
          '" data-to="confirmed">Confirm</button>' : '') +
      '<button class="btn btn-sm btn-ghost" type="button" data-booking="' + esc(booking.id) +
        '" data-to="completed">Mark done</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-booking="' + esc(booking.id) +
        '" data-to="cancelled">Cancel</button>' +
      '</div>'
    : '';

  return '<div class="row" style="display:block">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">' +
      '<b>' + esc(bookingDate(booking.date) || 'No date') + ' · ' + esc(time) + '</b>' +
      pill(booking.status) +
    '</div>' +
    (booking.service ? '<span style="display:block;font-size:12.5px;color:var(--muted);margin-top:3px">' +
      esc(booking.service) + '</span>' : '') +
    actions +
    '</div>';
}

function followUpBlock(followUp) {
  const overdue = followUp.status === 'pending' &&
    followUp.scheduled_for <= new Date().toISOString();

  const actions = followUp.status === 'pending'
    ? '<div style="display:flex;gap:6px;margin-top:8px">' +
      '<button class="btn btn-sm" type="button" data-followup="' + esc(followUp.id) +
        '" data-to="completed">Done</button>' +
      '<button class="btn btn-sm btn-ghost" type="button" data-followup="' + esc(followUp.id) +
        '" data-to="cancelled">Cancel</button>' +
      '</div>'
    : '';

  return '<div class="row" style="display:block">' +
    '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">' +
      '<b>' + esc(String(followUp.type).replace(/_/g, ' ')) + ' · ' +
        esc(when(followUp.scheduled_for)) + '</b>' +
      pill(overdue ? 'pending' : followUp.status) +
    '</div>' +
    (followUp.notes ? '<span style="display:block;font-size:12.5px;color:var(--muted);margin-top:3px">' +
      esc(followUp.notes) + '</span>' : '') +
    actions +
    '</div>';
}

function detailShell(data) {
  const lead = data.lead;
  const title = lead.name || phone(lead.phone) || 'Unknown caller';

  const statusOptions = STATUSES.map(function (status) {
    return '<option value="' + status + '"' +
      (lead.status === status ? ' selected' : '') + '>' +
      status.charAt(0).toUpperCase() + status.slice(1) + '</option>';
  }).join('');

  return '<a class="back" href="/app/leads/">← All leads</a>' +
    '<div class="top">' +
      '<div><h1>' + esc(title) + '</h1>' +
        '<p class="sub">' + esc(phone(lead.phone)) +
        (lead.call_count ? ' · ' + lead.call_count + ' call' + (lead.call_count === 1 ? '' : 's') : '') +
        ' · added ' + esc(when(lead.created_at)) + '</p></div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<label class="vh" for="status">Status</label>' +
        '<select id="status" style="width:auto">' + statusOptions + '</select>' +
        (lead.phone ? '<a class="btn" href="tel:' + esc(lead.phone) + '">Call back</a>' : '') +
      '</div>' +
    '</div>' +
    '<div id="banners">' + shellBanners(me) + '</div>' +

    '<div class="detail">' +
      '<div style="display:flex;flex-direction:column;gap:18px">' +

        '<section class="card">' +
          '<div class="card-head"><h2>Customer</h2></div>' +
          '<dl class="kv">' +
            kvRow('Name', lead.name) +
            kvRow('Phone', phone(lead.phone)) +
            kvRow('Email', lead.email) +
            kvRow('Address', lead.address) +
            kvRow('Service', lead.service) +
            kvRow('The job', lead.job_description) +
            kvRow('Urgency', lead.urgency) +
            kvRow('Wants', lead.preferred_time) +
            kvRow('Source', lead.source) +
          '</dl>' +
        '</section>' +

        '<section class="card">' +
          '<div class="card-head"><h2>Calls</h2>' +
            '<a href="/app/calls/">All calls</a></div>' +
          (data.calls.length
            ? data.calls.map(callBlock).join('')
            : emptyState('No calls on this lead',
                'This lead was added by hand rather than captured from a call.')) +
        '</section>' +

      '</div>' +

      '<div style="display:flex;flex-direction:column;gap:18px">' +

        '<section class="card">' +
          '<div class="card-head"><h2>Your notes</h2></div>' +
          '<textarea id="notes" placeholder="What you agreed, what you quoted, anything the agent could not know.">' +
            esc(lead.notes || '') + '</textarea>' +
          '<button class="btn btn-sm" type="button" id="save-notes" style="margin-top:10px">Save notes</button>' +
        '</section>' +

        '<section class="card">' +
          '<div class="card-head"><h2>Bookings</h2></div>' +
          '<div id="bookings">' +
            (data.bookings.length
              ? data.bookings.map(bookingBlock).join('')
              : emptyState('Nothing booked', 'Add a visit below.')) +
          '</div>' +
          '<form id="booking-form" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">' +
            '<div class="row-2">' +
              '<div class="field"><label for="b-date">Date</label>' +
                '<input id="b-date" name="date" type="date" required></div>' +
              '<div class="field"><label for="b-start">Start</label>' +
                '<input id="b-start" name="start_time" type="time"></div>' +
            '</div>' +
            '<div class="row-2">' +
              '<div class="field"><label for="b-end">End</label>' +
                '<input id="b-end" name="end_time" type="time"></div>' +
              '<div class="field"><label for="b-service">Service</label>' +
                '<input id="b-service" name="service" value="' + esc(lead.service || '') + '"></div>' +
            '</div>' +
            '<button class="btn btn-sm" type="submit" id="b-save">Add booking</button>' +
          '</form>' +
        '</section>' +

        '<section class="card">' +
          '<div class="card-head"><h2>Follow-ups</h2></div>' +
          '<div id="followups">' +
            (data.followUps.length
              ? data.followUps.map(followUpBlock).join('')
              : emptyState('Nothing scheduled', 'Set a reminder to chase this one.')) +
          '</div>' +
          '<form id="followup-form" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">' +
            '<div class="row-2">' +
              '<div class="field"><label for="f-when">When</label>' +
                '<input id="f-when" name="scheduled_for" type="datetime-local" required></div>' +
              '<div class="field"><label for="f-type">Type</label>' +
                '<select id="f-type" name="type">' +
                  '<option value="call">Call</option>' +
                  '<option value="sms">Text</option>' +
                  '<option value="email">Email</option>' +
                  '<option value="internal_task">Task</option>' +
                '</select></div>' +
            '</div>' +
            '<div class="field"><label for="f-notes">Note</label>' +
              '<input id="f-notes" name="notes" placeholder="What to chase"></div>' +
            '<button class="btn btn-sm" type="submit" id="f-save">Add follow-up</button>' +
          '</form>' +
        '</section>' +

        (data.notifications.length ? notificationsCard(data.notifications) : '') +

      '</div>' +
    '</div>';
}

/* Shown so an owner can see that Shug tried to tell them — and, right now, that
   no SMS provider is configured so it could not. Hiding that would make a
   missing credential look like a missing feature. */
function notificationsCard(notifications) {
  const rows = notifications.slice(0, 5).map(function (n) {
    const reason = n.status === 'skipped' && n.error === 'no_provider'
      ? 'No SMS provider connected yet'
      : (n.error || '');
    return '<div class="row">' +
      '<div class="row-main"><b>' + esc(n.channel.toUpperCase()) + '</b>' +
        (reason ? '<span>' + esc(reason) + '</span>' : '') + '</div>' +
      '<div class="row-side">' + pill(n.status) + '</div>' +
      '</div>';
  }).join('');

  return '<section class="card">' +
    '<div class="card-head"><h2>Notifications</h2></div>' +
    '<div class="rows">' + rows + '</div></section>';
}

async function renderDetail(id) {
  root.innerHTML = '<div class="card">' + skeleton(6) + '</div>';

  let data;
  try {
    data = await api('/api/leads/' + encodeURIComponent(id));
  } catch (e) {
    root.innerHTML = '<a class="back" href="/app/leads/">← All leads</a>' +
      emptyState(e.status === 404 ? 'That lead is not here' : 'Could not load this lead',
        e.status === 404 ? 'It may have been removed.' : e.message);
    return;
  }

  root.innerHTML = detailShell(data);

  el('status').addEventListener('change', async function (event) {
    try {
      await api('/api/leads/' + encodeURIComponent(id), {
        method: 'PATCH', body: { status: event.target.value }
      });
      toast('Status updated.');
    } catch (e) { toastError(e); }
  });

  el('save-notes').addEventListener('click', async function () {
    await submitting(el('save-notes'), async function () {
      try {
        await api('/api/leads/' + encodeURIComponent(id), {
          method: 'PATCH', body: { notes: el('notes').value }
        });
        toast('Notes saved.');
      } catch (e) { toastError(e); }
    });
  });

  el('booking-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const values = formValues(event.target);
    await submitting(el('b-save'), async function () {
      try {
        await api('/api/leads/' + encodeURIComponent(id) + '/bookings', {
          method: 'POST', body: values
        });
        toast('Booking added.');
        renderDetail(id);
      } catch (e) { toastError(e); }
    });
  });

  el('followup-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const values = formValues(event.target);

    /* <input type="datetime-local"> gives a LOCAL wall-clock string with no
       zone. The API stores an instant, so it is converted here — sending the
       raw value would be read as UTC and land the reminder hours out. */
    if (values.scheduled_for) {
      const local = new Date(values.scheduled_for);
      if (Number.isNaN(local.getTime())) { toast('Pick a date and time.', true); return; }
      values.scheduled_for = local.toISOString();
    }

    await submitting(el('f-save'), async function () {
      try {
        await api('/api/leads/' + encodeURIComponent(id) + '/follow-ups', {
          method: 'POST', body: values
        });
        toast('Follow-up added.');
        renderDetail(id);
      } catch (e) { toastError(e); }
    });
  });

  /* Delegated, so the handlers survive renderDetail() replacing the markup. */
  root.addEventListener('click', async function (event) {
    const booking = event.target.closest('[data-booking]');
    if (booking) {
      try {
        await api('/api/bookings/' + encodeURIComponent(booking.dataset.booking), {
          method: 'PATCH', body: { status: booking.dataset.to }
        });
        toast('Booking ' + booking.dataset.to + '.');
        renderDetail(id);
      } catch (e) { toastError(e); }
      return;
    }

    const followUp = event.target.closest('[data-followup]');
    if (followUp) {
      try {
        await api('/api/follow-ups/' + encodeURIComponent(followUp.dataset.followup), {
          method: 'PATCH', body: { status: followUp.dataset.to }
        });
        toast('Follow-up ' + followUp.dataset.to + '.');
        renderDetail(id);
      } catch (e) { toastError(e); }
    }
  });
}

/* ---- Entry ------------------------------------------------------------- */

(async function () {
  me = await mount('/app/leads/');
  if (!me) return;

  const id = new URLSearchParams(location.search).get('id');
  if (id) await renderDetail(id);
  else renderList();
})().catch(function (e) {
  root.innerHTML = emptyState('Could not load leads', e.message);
  toastError(e);
});
