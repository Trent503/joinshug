/* Shug — attach a dashboard login to an EXISTING business.

   Usage:
     node tools/add-user.mjs <business-id> <email> [password] [--remote]

   With no password, one is generated and printed once.

   WHY THIS EXISTS ALONGSIDE /api/admin/provision: provisioning creates a whole
   customer — business, phone routing, and owner — in one batch, and that is the
   path for a real signup. This is the narrow case of adding a second login to a
   business that already exists (a partner, an office manager, or the demo
   tenant, which is seeded by SQL and therefore has no user).

   It imports hashPassword() from functions/lib/auth.js rather than
   reimplementing it, so a login created here verifies against exactly the same
   PBKDF2 parameters as one created by the API. The password itself is never
   written to disk or into a SQL file that lingers — only the verifier is. */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword, normalizeEmail } from '../functions/lib/auth.js';

const args = process.argv.slice(2).filter(function (a) { return a !== '--remote'; });
const REMOTE = process.argv.includes('--remote');

const businessId = args[0];
const rawEmail = args[1];
let password = args[2];

if (!businessId || !rawEmail) {
  console.error('Usage: node tools/add-user.mjs <business-id> <email> [password] [--remote]');
  process.exit(1);
}

const email = normalizeEmail(rawEmail);
if (!email) {
  console.error('That does not look like an email address: ' + rawEmail);
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY346789';
let generated = false;

if (!password) {
  generated = true;
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = '';
    while (group.length < 4) {
      for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
        if (group.length >= 4) break;
        if (byte >= 252) continue;          // rejection sampling; 252 = 28 * 9
        group += ALPHABET[byte % ALPHABET.length];
      }
    }
    groups.push(group);
  }
  password = groups.join('-');
}

if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const target = REMOTE ? '--remote' : '--local';

/* See tests/lib.mjs for why local state may need to live outside the repo. */
const PERSIST_TO = process.env.SHUG_PERSIST_TO || null;
function d1(extra) {
  const args = ['wrangler', 'd1', 'execute', 'shug', target];
  if (!REMOTE && PERSIST_TO) args.push('--persist-to', PERSIST_TO);
  return args.concat(extra);
}

function run(command) {
  const out = execFileSync('npx', d1(['--json', '--command', command]),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const business = run("SELECT id, name FROM businesses WHERE id = '" +
  businessId.replace(/'/g, "''") + "' LIMIT 1");

if (business.length === 0) {
  console.error('No business with id "' + businessId + '" in ' +
    (REMOTE ? 'production' : 'local') + ' D1.');
  process.exit(1);
}

const existing = run("SELECT id FROM users WHERE email = '" + email.replace(/'/g, "''") + "' LIMIT 1");
if (existing.length > 0) {
  console.error('A user with that email already exists. Emails are unique across all businesses.');
  process.exit(1);
}

const hashed = await hashPassword(password);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/* Written through a temp file rather than --command so the password's VERIFIER
   (never the password) is what touches disk, and only for the moment it takes
   wrangler to read it. */
const sql =
  "INSERT INTO users (id, business_id, email, name, password_hash, password_salt," +
  " password_iterations, role, status, must_change_password, created_at, updated_at) VALUES (" +
  ["'" + crypto.randomUUID() + "'",
   "'" + businessId.replace(/'/g, "''") + "'",
   "'" + email.replace(/'/g, "''") + "'",
   'NULL',
   "'" + hashed.password_hash + "'",
   "'" + hashed.password_salt + "'",
   hashed.password_iterations,
   "'owner'", "'active'",
   generated ? 1 : 0,
   "'" + now + "'", "'" + now + "'"].join(', ') + ");";

const file = join(tmpdir(), 'shug-user-' + Date.now() + '.sql');
writeFileSync(file, sql + '\n');

try {
  execFileSync('npx', d1(['--file', file]),
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
} catch (e) {
  console.error('Failed: ' + (e.stdout || '') + (e.stderr || ''));
  unlinkSync(file);
  process.exit(1);
} finally {
  try { unlinkSync(file); } catch (e) { /* already gone */ }
}

console.log('');
console.log('  Login created for ' + business[0].name + ' (' + businessId + ')');
console.log('');
console.log('    email     ' + email);
console.log('    password  ' + password + (generated ? '   (generated — shown once)' : ''));
console.log('');
console.log('  Sign in at ' + (REMOTE ? 'https://joinshug.com/app/login/' : 'http://localhost:8787/app/login/'));
console.log('');
