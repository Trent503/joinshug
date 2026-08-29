/* Shug — Jobber OAuth, leg 1 of 2: hand the user off to Jobber to authorize.
   GET /api/jobber/start

   A Cloudflare Pages Function. Runs server-side at the edge. This leg needs only
   the public client id — the client secret is never referenced in this file and
   never reaches the browser.

   Required bindings (Pages -> Settings -> Variables and secrets):
     JOBBER_CLIENT_ID     plaintext variable
     JOBBER_REDIRECT_URI  plaintext variable. Must byte-for-byte match the
                          Callback URL registered in Jobber's Developer Center,
                          and is deliberately NOT derived from the request URL:
                          deriving it would silently break on preview
                          deployments and would trust a client-controlled Host.

   Optional:
     JOBBER_AUTHORIZE_URL  override the authorize endpoint (testing only)
     JOBBER_SCOPES         space-separated scopes, if your app requests them on
                           the authorize URL rather than configuring them in the
                           Developer Center

   Note: _headers does NOT apply to Pages Functions responses — Cloudflare
   applies that file to static assets only. Every header this endpoint needs is
   therefore set here, in code. */

const DEFAULT_AUTHORIZE_URL = 'https://api.getjobber.com/api/oauth/authorize';

/* Scoped to /api/jobber so the browser never attaches it to any other request
   on joinshug.com. SameSite=Lax (not Strict) is required: the browser must send
   this cookie on the top-level cross-site redirect back from Jobber, and Strict
   would drop it there and break every callback.

   The __Secure- prefix makes browsers refuse the cookie unless it is set over
   HTTPS with the Secure attribute. Production is HTTPS-only with HSTS, so this
   costs nothing there. If a local `wrangler pages dev` run over plain http ever
   rejects it, drop the prefix in both this file and callback.js — do not drop
   the Secure attribute. */
const STATE_COOKIE = '__Secure-shug_jobber_state';
const STATE_TTL_SECONDS = 600;

/* ---- Helpers --------------------------------------------------------- */

/* OAuth responses must never be cached — not by the browser, not by
   Cloudflare's edge, not by anything in between. */
function oauthHeaders(extra) {
  return Object.assign({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow'
  }, extra || {});
}

/* 32 bytes from the platform CSPRNG, base64url-encoded. crypto.getRandomValues
   is the Web Crypto CSPRNG — Math.random() would be forgeable and is never
   acceptable for an OAuth state value. */
function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stateCookie(value) {
  return STATE_COOKIE + '=' + value +
    '; Path=/api/jobber' +
    '; HttpOnly' +
    '; Secure' +
    '; SameSite=Lax' +
    '; Max-Age=' + STATE_TTL_SECONDS;
}

function fail(message, status) {
  return new Response(message + '\n', {
    status: status,
    headers: oauthHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })
  });
}

/* ---- Handler --------------------------------------------------------- */

export async function onRequestGet(context) {
  const env = context.env;

  /* Fail closed and loudly on the operator's side, vaguely on the caller's.
     The log line names the missing variable but never a value. */
  const clientId = env.JOBBER_CLIENT_ID;
  const redirectUri = env.JOBBER_REDIRECT_URI;

  const missing = [];
  if (!clientId) missing.push('JOBBER_CLIENT_ID');
  if (!redirectUri) missing.push('JOBBER_REDIRECT_URI');

  if (missing.length) {
    console.error('jobber/start: missing Pages environment variables: ' + missing.join(', '));
    return fail('Jobber integration is not configured.', 500);
  }

  const state = randomState();

  const authorize = new URL(env.JOBBER_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL);
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('state', state);
  if (env.JOBBER_SCOPES) authorize.searchParams.set('scope', env.JOBBER_SCOPES);

  /* The state lives only in the HttpOnly cookie. Nothing server-side needs to
     remember it, so there is no KV write on this leg and no way for a stale
     entry to accumulate. */
  return new Response(null, {
    status: 302,
    headers: oauthHeaders({
      'Location': authorize.toString(),
      'Set-Cookie': stateCookie(state)
    })
  });
}
