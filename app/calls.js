/* Shug — /app/calls/

   The call log. Duration, outcome, summary, and the lead each call produced.

   The list request deliberately does not carry transcripts — GET /api/calls
   omits that column. A transcript is read one call at a time, from the lead
   detail page, not twenty at a time here. */

import {
  api, mount, shellBanners, el, esc, pill, phone, duration, when,
  emptyState, skeleton, toastError
} from './app.js';

function callRow(call) {
  const who = call.lead_name || phone(call.from_number) || 'Unknown';

  /* call_successful is Retell's own read on whether the call achieved its
     purpose. NULL means the call has not been analysed yet, which is a third
     state and must not render as "no". */
  const outcome = call.call_successful === null || call.call_successful === undefined
    ? '<span style="color:var(--dim)">Pending</span>'
    : (call.call_successful ? 'Handled' : 'Fell short');

  const link = call.lead_id
    ? ' data-lead="' + esc(call.lead_id) + '"'
    : '';

  return '<tr' + link + (call.lead_id ? ' tabindex="0"' : '') + '>' +
    '<td class="name">' + esc(who) +
      (call.summary ? '<div class="sub-line">' + esc(call.summary) + '</div>' : '') + '</td>' +
    '<td class="num">' + esc(phone(call.from_number)) + '</td>' +
    '<td class="num">' + esc(duration(call.duration_sec)) + '</td>' +
    '<td class="tight">' + outcome + '</td>' +
    '<td class="tight">' + (call.lead_status ? pill(call.lead_status) :
      '<span style="color:var(--dim);font-size:12.5px">No lead</span>') + '</td>' +
    '<td class="num">' + esc(when(call.started_at || call.created_at)) + '</td>' +
    '</tr>';
}

async function render() {
  const me = await mount('/app/calls/');
  if (!me) return;

  el('banners').innerHTML = shellBanners(me);
  el('content').innerHTML = '<section class="card">' + skeleton(6) + '</section>';

  const [calls, usage] = await Promise.all([
    api('/api/calls?limit=200'),
    api('/api/usage')
  ]);

  el('sub').textContent = calls.total === 1
    ? '1 call · ' + usage.usage.minutesUsed + ' of ' + usage.usage.minutesIncluded + ' minutes used this month'
    : calls.total + ' calls · ' + usage.usage.minutesUsed + ' of ' +
      usage.usage.minutesIncluded + ' minutes used this month';

  if (calls.calls.length === 0) {
    el('content').innerHTML = '<section class="card">' +
      emptyState('No calls yet',
        'Once your number is pointed at Shug, every call it answers shows up here.') +
      '</section>';
    return;
  }

  el('content').innerHTML = '<section class="card" style="padding:18px 6px 6px">' +
    '<div class="tablewrap"><table>' +
    '<thead><tr><th>Caller</th><th>Number</th><th>Length</th>' +
    '<th>Outcome</th><th>Lead</th><th>When</th></tr></thead>' +
    '<tbody>' + calls.calls.map(callRow).join('') + '</tbody></table></div></section>';

  function open(row) {
    if (row && row.dataset.lead) {
      location.href = '/app/leads/?id=' + encodeURIComponent(row.dataset.lead);
    }
  }

  el('content').addEventListener('click', function (event) {
    open(event.target.closest('tr[data-lead]'));
  });
  el('content').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-lead]');
    if (!row) return;
    event.preventDefault();
    open(row);
  });
}

render().catch(function (e) {
  el('content').innerHTML = emptyState('Could not load calls', e.message);
  toastError(e);
});
