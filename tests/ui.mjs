/* Shug — dashboard checks that do not need a browser.

   Three things worth catching without one:

   1. CSP COMPLIANCE. _headers sets `script-src 'self'` with no
      'unsafe-inline'. An inline <script> block or an onclick= attribute in an
      /app/ page works perfectly in `wrangler dev` (which does not enforce the
      header) and then silently does nothing in production. That is the worst
      class of bug this project can ship, so it is asserted rather than
      remembered.

   2. ESCAPING. Lead names and job descriptions come from a phone call, through
      a speech model, through Retell's extraction, and then into innerHTML.
      They are untrusted text. esc() is the only thing between a caller and
      script execution in their contractor's dashboard.

   3. FORMATTERS. bookingDate() in particular: new Date('2026-09-14') parses as
      UTC midnight and renders as the 13th for anyone west of Greenwich, which
      is every customer this product has.

   Run: node tests/ui.mjs   (needs `wrangler dev` for the served-page checks) */

import { readFileSync, readdirSync } from 'node:fs';
import { BASE, group, check, checkEqual, summary } from './lib.mjs';

const appDir = new URL('../app/', import.meta.url);

function read(relative) {
  return readFileSync(new URL(relative, appDir), 'utf8');
}

/* ---- 1. CSP compliance ------------------------------------------------- */

function htmlFiles(dir, prefix) {
  const found = [];
  for (const entry of readdirSync(new URL(dir, appDir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...htmlFiles(dir + entry.name + '/', prefix + entry.name + '/'));
    } else if (entry.name.endsWith('.html')) {
      found.push([prefix + entry.name, dir + entry.name]);
    }
  }
  return found;
}

function testCsp() {
  group('1. CSP compliance — script-src \'self\', no unsafe-inline');

  const pages = htmlFiles('', '/app/');
  check('found the dashboard pages', pages.length === 5, pages.length + ' found');

  for (const [label, path] of pages) {
    const html = read(path);

    /* A <script> with no src is an inline block. One WITH src is fine. */
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    const inline = scripts.filter(function (tag) { return !/\ssrc=/i.test(tag); });
    check(label + ' has no inline <script> block', inline.length === 0,
      inline.join(' '));

    /* onclick=, onsubmit=, onload=… all violate script-src. */
    const handlers = html.match(/\son[a-z]+\s*=\s*["']/gi) || [];
    check(label + ' has no inline event handler attributes', handlers.length === 0,
      handlers.join(' '));

    check(label + ' loads its script from a same-origin file',
      /<script[^>]+src="\/app\/[a-z-]+\.js"/.test(html), 'no module script tag found');

    check(label + ' is marked noindex',
      /<meta name="robots" content="noindex/.test(html));
  }

  /* The scripts themselves must not build script-injecting markup.

     Comments are stripped first. The header comment in app.js explains the CSP
     rule and necessarily contains the words it is warning about, so a check
     that read prose as well as code would fail on the documentation of the
     very thing it is enforcing. */
  for (const file of ['app.js', 'overview.js', 'leads.js', 'calls.js', 'settings.js', 'login.js']) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    check(file + ' never writes a <script> tag into the DOM',
      !/<script/i.test(code));
    check(file + ' uses no eval or Function constructor',
      !/\beval\s*\(|new\s+Function\s*\(/.test(code));
    check(file + ' sets no inline event handler property',
      !/\.\s*on(click|submit|load|error)\s*=/.test(code));
  }
}

/* ---- 2. Escaping and formatting --------------------------------------- */

async function testHelpers() {
  group('2. Escaping and formatting');

  /* app.js touches `document` at import time only inside functions, so it can
     be imported here — but mount() and toast() must not be called. */
  const app = await import('../app/app.js');

  const payload = '<img src=x onerror="alert(1)">';
  const escaped = app.esc(payload);
  check('esc() neutralises a script-bearing lead name',
    !escaped.includes('<') && !escaped.includes('"'), escaped);
  checkEqual('esc() encodes every dangerous character',
    app.esc('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  checkEqual('esc() renders null as empty, not the word "null"', app.esc(null), '');
  checkEqual('esc() renders undefined as empty', app.esc(undefined), '');

  /* The status pill interpolates a status into a class name AND into text. */
  const evilPill = app.pill('new"><script>x</script>');
  check('pill() escapes a status it does not recognise',
    !evilPill.includes('<script>'), evilPill);

  checkEqual('phone() formats NANP', app.phone('+15035551234'), '(503) 555-1234');
  checkEqual('phone() leaves an international number alone',
    app.phone('+442071234567'), '+442071234567');
  checkEqual('phone() renders nothing for nothing', app.phone(null), '');

  checkEqual('duration() under a minute', app.duration(45), '45s');
  checkEqual('duration() exact minutes drops the seconds', app.duration(120), '2m');
  checkEqual('duration() mixed', app.duration(95), '1m 35s');
  checkEqual('duration() of nothing is 0s', app.duration(null), '0s');
  checkEqual('duration() never goes negative', app.duration(-10), '0s');

  /* THE OFF-BY-ONE-DAY BUG. A booking date is a business-local wall-clock
     string; parsing it as UTC shows the day before for every US timezone. */
  const rendered = app.bookingDate('2026-09-14');
  check('bookingDate() shows the 14th, not the 13th',
    rendered.includes('14'), 'rendered as "' + rendered + '"');
  checkEqual('bookingDate() passes through something that is not a date',
    app.bookingDate('whenever'), 'whenever');

  checkEqual('clockTime() morning', app.clockTime('09:00'), '9am');
  checkEqual('clockTime() afternoon', app.clockTime('13:30'), '1:30pm');
  checkEqual('clockTime() noon', app.clockTime('12:00'), '12pm');
  checkEqual('clockTime() midnight', app.clockTime('00:00'), '12am');
}

/* ---- 3. Served pages --------------------------------------------------- */

async function testServed() {
  group('3. Served dashboard pages');

  const paths = ['/app/', '/app/leads/', '/app/calls/', '/app/settings/', '/app/login/',
                 '/app/app.css', '/app/app.js', '/app/overview.js', '/app/leads.js',
                 '/app/calls.js', '/app/settings.js', '/app/login.js'];

  for (const path of paths) {
    const response = await fetch(BASE + path);
    checkEqual(path + ' is served', response.status, 200);
  }

  /* An ES module served as text/plain is blocked by the browser. */
  const script = await fetch(BASE + '/app/app.js');
  check('app.js is served as JavaScript, so `type="module"` will load',
    /javascript|ecmascript/i.test(script.headers.get('content-type') || ''),
    'content-type: ' + script.headers.get('content-type'));

  const styles = await fetch(BASE + '/app/app.css');
  check('app.css is served as CSS',
    /text\/css/i.test(styles.headers.get('content-type') || ''),
    'content-type: ' + styles.headers.get('content-type'));

  /* The dashboard must not be reachable as data without a session. */
  const overview = await fetch(BASE + '/api/overview');
  checkEqual('the overview API still needs a session', overview.status, 401);

  /* robots and headers. */
  const robots = await fetch(BASE + '/robots.txt').then(function (r) { return r.text(); });
  check('robots.txt disallows /app/', robots.includes('Disallow: /app/'));
  check('robots.txt still allows the marketing site', robots.includes('Allow: /'));
}

async function main() {
  console.log('\x1b[1mShug dashboard checks\x1b[0m — ' + BASE);
  testCsp();
  await testHelpers();
  await testServed();
  process.exit(summary() === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('\x1b[31m' + (e && e.stack || e) + '\x1b[0m');
  process.exit(1);
});
