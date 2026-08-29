/* Shug — /app/login/ */

import { api, el, toast } from './app.js';

const form = el('form');
const errorBox = el('error');
const button = el('submit');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

/* Where to go after signing in.

   `next` is read from the query string, which is attacker-controllable, so it
   is accepted ONLY as a same-origin path under /app/. Without that check this
   is an open redirect: a link to
   /app/login/?next=https://evil.example/ would bounce a freshly-authenticated
   contractor straight off the site. */
function destination() {
  const next = new URLSearchParams(location.search).get('next');
  if (!next) return '/app/';
  if (!next.startsWith('/app/')) return '/app/';
  if (next.startsWith('//')) return '/app/';
  return next;
}

form.addEventListener('submit', async function (event) {
  event.preventDefault();
  errorBox.hidden = true;

  const email = el('email').value.trim();
  const password = el('password').value;

  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Signing in…';

  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: { email: email, password: password },
      /* A 401 here is a wrong password, not an expired session, so it must not
         trigger the global redirect-to-login — that would reload this page and
         throw away the message. */
      allow401: true
    });
    location.href = destination();
  } catch (e) {
    showError(e.message);
    el('password').value = '';
    el('password').focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

/* If a valid session already exists, do not make someone sign in twice. */
api('/api/auth/me', { allow401: true })
  .then(function () { location.href = destination(); })
  .catch(function () { el('email').focus(); });
