/* Shug — Worker entry point and API router.

   ---------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   ---------------------------------------------------------------------------
   joinshug.com is a Cloudflare WORKER with static assets, not a Pages project.
   That was verified, not assumed:

     wrangler pages project list                     -> empty
     wrangler pages deployment list -p joinshug      -> "Project not found"
     wrangler deployments list                       -> real worker deployments
     curl https://joinshug.com/api/retell/inbound    -> 404

   `functions/` is a PAGES-only routing convention. A Worker does not auto-route
   it, which is why every endpoint under functions/ returned 404 in production
   despite being correct code. This router is the fix.

   ---------------------------------------------------------------------------
   WHY THE HANDLERS STAY IN PAGES SHAPE
   ---------------------------------------------------------------------------
   Every module under functions/ still exports `onRequestGet` / `onRequestPost`
   / `onRequestPatch` and takes a Pages-style `context` object. This router
   builds that context and calls them. Nothing about a handler knows it is
   running under a Worker.

   That is deliberate: if joinshug.com ever moves to Pages, the migration is
   deleting this file and the [assets] block in wrangler.toml. Not a rewrite.

   ---------------------------------------------------------------------------
   WHY THE MARKETING SITE IS UNAFFECTED
   ---------------------------------------------------------------------------
   wrangler.toml sets `run_worker_first = ["/api/*"]`. This script is invoked
   ONLY for /api/*. Every other request — all 28 marketing pages, the
   stylesheet, the images, /app/ — is served directly from the asset store by
   the runtime, without ever entering this file. Same behaviour as today, same
   cost, and _headers / _redirects keep applying exactly as they do now (both
   confirmed live against production).

   The `env.ASSETS.fetch` fallback at the bottom is belt-and-braces for a
   non-/api/ request arriving here anyway. */

/* ---- Retell (unauthenticated, signature-verified) ---------------------- */
import * as retellInbound from '../functions/api/retell/inbound.js';
import * as retellWebhook from '../functions/api/retell/webhook.js';

/* ---- Auth ------------------------------------------------------------- */
import * as authLogin from '../functions/api/auth/login.js';
import * as authLogout from '../functions/api/auth/logout.js';
import * as authMe from '../functions/api/auth/me.js';
import * as authPassword from '../functions/api/auth/password.js';

/* ---- Dashboard (session-authenticated) -------------------------------- */
import * as overview from '../functions/api/overview.js';
import * as usage from '../functions/api/usage.js';
import * as settings from '../functions/api/settings.js';
import * as leadsIndex from '../functions/api/leads/index.js';
import * as leadDetail from '../functions/api/leads/[id].js';
import * as leadBookings from '../functions/api/leads/[id]/bookings.js';
import * as leadFollowUps from '../functions/api/leads/[id]/follow-ups.js';
import * as bookingDetail from '../functions/api/bookings/[id].js';
import * as followUpDetail from '../functions/api/follow-ups/[id].js';
import * as callsIndex from '../functions/api/calls/index.js';
import * as callDetail from '../functions/api/calls/[id].js';

/* ---- Admin (bearer-token authenticated) ------------------------------- */
import * as adminProvision from '../functions/api/admin/provision.js';
import * as adminNotifications from '../functions/api/admin/notifications.js';

/* ---------------------------------------------------------------------------
   Route table.

   Order matters only in that a literal segment must be declared before a
   parameterised one that would also match it. Nothing here currently overlaps,
   and matchRoute() below scores literals above params anyway, so the table can
   stay readable rather than carefully ordered.

   functions/api/jobber/* is DELIBERATELY ABSENT. Those endpoints are an
   unconfigured draft; routing them would publish a half-built OAuth flow. See
   NEEDS_CONFIG.md. Leaving them unrouted is what keeps them "not deployed".
   --------------------------------------------------------------------------- */
const ROUTES = [
  ['/api/retell/inbound',            retellInbound],
  ['/api/retell/webhook',            retellWebhook],

  ['/api/auth/login',                authLogin],
  ['/api/auth/logout',               authLogout],
  ['/api/auth/me',                   authMe],
  ['/api/auth/password',             authPassword],

  ['/api/overview',                  overview],
  ['/api/usage',                     usage],
  ['/api/settings',                  settings],

  ['/api/leads',                     leadsIndex],
  ['/api/leads/:id',                 leadDetail],
  ['/api/leads/:id/bookings',        leadBookings],
  ['/api/leads/:id/follow-ups',      leadFollowUps],

  ['/api/bookings/:id',              bookingDetail],
  ['/api/follow-ups/:id',            followUpDetail],

  ['/api/calls',                     callsIndex],
  ['/api/calls/:id',                 callDetail],

  ['/api/admin/provision',           adminProvision],
  ['/api/admin/notifications',       adminNotifications]
];

/* Pre-split once at module scope. Module scope runs on isolate startup, not
   per request, so route parsing costs nothing on the hot path. */
const COMPILED = ROUTES.map(function (entry) {
  return { segments: entry[0].split('/').filter(Boolean), module: entry[1] };
});

/* ---- Matching --------------------------------------------------------- */

function matchRoute(pathname) {
  /* A trailing slash on an API route is a typo, not a different resource.
     Accept it rather than 404 on something that is obviously intended. */
  const parts = pathname.split('/').filter(Boolean);

  for (const route of COMPILED) {
    if (route.segments.length !== parts.length) continue;

    const params = {};
    let matched = true;

    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i];
      if (segment.charAt(0) === ':') {
        /* An empty segment cannot fill a parameter — filter(Boolean) above
           already dropped those, so anything here is non-empty. */
        params[segment.slice(1)] = decodeURIComponent(parts[i]);
      } else if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }

    if (matched) return { module: route.module, params: params };
  }

  return null;
}

/* Pages resolves a handler by method, falling back to the catch-all
   `onRequest`. HEAD falls back to GET, which the runtime then strips the body
   from — matching what a static asset would do. */
function resolveHandler(module, method) {
  const named = 'onRequest' +
    method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();

  if (typeof module[named] === 'function') return module[named];

  if (method === 'HEAD' && typeof module.onRequestGet === 'function') {
    return module.onRequestGet;
  }

  if (typeof module.onRequest === 'function') return module.onRequest;

  return null;
}

/* Which methods a module actually implements — for the Allow header on a 405.
   Answering "wrong method" without saying which methods are right just makes
   an integrator guess. */
function allowedMethods(module) {
  const methods = [];
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) {
    const named = 'onRequest' +
      method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
    if (typeof module[named] === 'function') methods.push(method);
  }
  if (methods.length === 0 && typeof module.onRequest === 'function') {
    return 'GET, POST, PATCH, PUT, DELETE';
  }
  if (methods.indexOf('GET') !== -1) methods.push('HEAD');
  return methods.join(', ');
}

/* Error bodies on the router itself carry a stable code and nothing else.
   Kept local rather than imported from lib/http.js so a syntax error in a
   handler module can never take out the router's own ability to respond. */
function routerError(code, status, extra) {
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow'
    }, extra || {})
  });
}

/* ---- Entry point ------------------------------------------------------ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const match = matchRoute(url.pathname);

      if (!match) return routerError('not_found', 404);

      const handler = resolveHandler(match.module, request.method);
      if (!handler) {
        return routerError('method_not_allowed', 405, {
          'Allow': allowedMethods(match.module)
        });
      }

      /* The Pages context contract. `next()` is what a Pages middleware would
         call to reach the static asset for this path; here it is the asset
         binding, which is the same thing. */
      const context = {
        request: request,
        env: env,
        params: match.params,
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException
          ? ctx.passThroughOnException.bind(ctx)
          : function () {},
        next: function () { return env.ASSETS.fetch(request); },
        data: {}
      };

      try {
        const response = await handler(context);
        if (response instanceof Response) return response;

        /* A handler that returns nothing is a bug in that handler, not a
           client error. Say so with a 500 rather than letting the runtime
           surface an opaque "Response is not a Response". */
        console.error('router: handler for ' + url.pathname + ' returned no Response');
        return routerError('handler_error', 500);
      } catch (e) {
        /* Never echo the message to the client — a stack trace or a D1 error
           string can leak schema and configuration. Log it, return a code. */
        console.error('router: unhandled error in ' + request.method + ' ' +
          url.pathname + ': ' + ((e && e.message) || 'unknown'));
        return routerError('internal_error', 500);
      }
    }

    /* Not an /api/ path. With run_worker_first = ["/api/*"] the runtime should
       never route such a request here, so this is a safety net rather than the
       normal path — but if it does happen, the asset store answers exactly as
       it would have, _headers and _redirects included. */
    return env.ASSETS.fetch(request);
  }
};
