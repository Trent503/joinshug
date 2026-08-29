/* Shug — /app/settings/

   Deliberately small. Four editable fields and a password change.

   The agent's configuration — services, service area, urgency rules, greeting,
   tone — is SHOWN but not editable. That configuration is what the $199 setup
   call produces; it is written carefully, once, with the owner on the phone. A
   half-edited urgency rule is a missed emergency, and a text box is the wrong
   place to make that change. The API enforces this too: those fields are not on
   the settings allow-list, so the form is not the only thing stopping it. */

import {
  api, mount, shellBanners, el, esc, phone, emptyState, skeleton,
  toast, toastError, formValues, submitting
} from './app.js';

function readOnlyRow(label, value) {
  return '<dt>' + esc(label) + '</dt>' +
    '<dd class="' + (value ? '' : 'blank') + '">' +
      (value ? esc(value) : 'Not set') + '</dd>';
}

function shell(settings) {
  return '<div class="grid g-2" style="align-items:start">' +

    '<section class="card">' +
      '<div class="card-head"><h2>Business</h2></div>' +
      '<form id="settings-form">' +
        '<div class="field">' +
          '<label for="s-name">Business name</label>' +
          '<input id="s-name" name="name" value="' + esc(settings.name) + '" required>' +
          '<p class="hint">Your agent says this out loud on every call.</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="s-phone">Your Shug number</label>' +
          '<input id="s-phone" value="' + esc(phone(settings.phone)) + '" disabled>' +
          '<p class="hint">The number callers reach. Changing it means porting a ' +
            'number, so get in touch rather than editing it here.</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="s-transfer">Transfer number</label>' +
          '<input id="s-transfer" name="transfer_number" type="tel" ' +
            'value="' + esc(phone(settings.transferNumber)) + '">' +
          '<p class="hint">Where an urgent call is put through to you.</p>' +
        '</div>' +
        '<div class="field">' +
          '<label for="s-sms">Notify by text</label>' +
          '<input id="s-sms" name="notify_sms" type="tel" ' +
            'value="' + esc(phone(settings.notifySms)) + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="s-email">Notify by email</label>' +
          '<input id="s-email" name="notify_email" type="email" ' +
            'autocapitalize="none" spellcheck="false" ' +
            'value="' + esc(settings.notifyEmail || '') + '">' +
          '<p class="hint">After every call, Shug writes you a message with who ' +
            'rang and what they want.</p>' +
        '</div>' +
        '<button class="btn" type="submit" id="s-save">Save changes</button>' +
      '</form>' +
    '</section>' +

    '<div style="display:flex;flex-direction:column;gap:14px">' +

      '<section class="card">' +
        '<div class="card-head"><h2>What your agent knows</h2></div>' +
        '<p style="font-size:13px;color:var(--muted);margin-bottom:14px">' +
          'Set up with you on your onboarding call. To change any of it, ' +
          'get in touch — these are the words your agent works from.</p>' +
        '<dl class="kv">' +
          readOnlyRow('Trade', settings.trade) +
          readOnlyRow('Hours', settings.readOnly.hours) +
          readOnlyRow('Services', settings.readOnly.servicesOffered) +
          readOnlyRow('Declines', settings.readOnly.servicesDeclined) +
          readOnlyRow('Area', settings.readOnly.serviceArea) +
          readOnlyRow('Area notes', settings.readOnly.serviceAreaNotes) +
          readOnlyRow('Greeting', settings.readOnly.greeting) +
          readOnlyRow('Tone', settings.readOnly.tone) +
          readOnlyRow('Urgent means', settings.readOnly.urgencyRules) +
          readOnlyRow('Timezone', settings.timezone) +
          readOnlyRow('Plan', settings.minutesIncluded + ' minutes a month') +
        '</dl>' +
      '</section>' +

      '<section class="card" id="password">' +
        '<div class="card-head"><h2>Password</h2></div>' +
        '<form id="password-form">' +
          '<div class="field">' +
            '<label for="p-current">Current password</label>' +
            '<input id="p-current" name="currentPassword" type="password" ' +
              'autocomplete="current-password" required>' +
          '</div>' +
          '<div class="field">' +
            '<label for="p-new">New password</label>' +
            '<input id="p-new" name="newPassword" type="password" ' +
              'autocomplete="new-password" minlength="10" required>' +
            '<p class="hint">At least 10 characters. Changing it signs out ' +
              'every other device.</p>' +
          '</div>' +
          '<button class="btn btn-ghost" type="submit" id="p-save">Change password</button>' +
        '</form>' +
      '</section>' +

    '</div>' +
    '</div>';
}

/* The settings form re-renders from the server's response after a save, which
   replaces its own DOM node. So the listeners are attached by a function that
   is called again after every render rather than once at start-up. */
function bind() {
  el('settings-form').addEventListener('submit', function (event) {
    event.preventDefault();
    const values = formValues(event.target);

    submitting(el('s-save'), async function () {
      try {
        const updated = await api('/api/settings', { method: 'PATCH', body: values });
        /* Re-rendered from the SERVER's copy, so the boxes show what was
           actually stored — a number typed as "503 555 0100" comes back
           formatted, which is the confirmation that it was understood. */
        el('content').innerHTML = shell(updated.settings);
        bind();
        toast('Saved.');
      } catch (e) { toastError(e); }
    });
  });

  el('password-form').addEventListener('submit', function (event) {
    event.preventDefault();
    const values = formValues(event.target);

    submitting(el('p-save'), async function () {
      try {
        /* allow401 because a 401 here means "your current password is wrong",
           not "your session expired" — the global handler would bounce the
           user to the login page and lose the message. */
        await api('/api/auth/password', { method: 'POST', body: values, allow401: true });
        event.target.reset();
        toast('Password changed.');
        /* The banner nagging about a generated password is now wrong. */
        el('banners').innerHTML = '';
      } catch (e) { toastError(e); }
    });
  });
}

async function render() {
  const me = await mount('/app/settings/');
  if (!me) return;

  el('banners').innerHTML = shellBanners(me);
  el('content').innerHTML = '<section class="card">' + skeleton(6) + '</section>';

  const data = await api('/api/settings');
  el('content').innerHTML = shell(data.settings);
  bind();

  if (location.hash === '#password') {
    el('password').scrollIntoView({ behavior: 'smooth', block: 'center' });
    el('p-current').focus();
  }
}

render().catch(function (e) {
  el('content').innerHTML = emptyState('Could not load settings', e.message);
  toastError(e);
});
