/**
 * GATE — the Lichess User-Agent identifies the app without exposing a personal contact.
 *
 * WHAT THIS EXISTS BECAUSE OF
 * ==========================
 * The client used to put the maintainer's email in the User-Agent, and the
 * privacy notice repeated it. That address was part of the old import flow;
 * the app is Lichess-only now, so it must not ship. A Lichess client still needs
 * to identify itself, but a private repository URL is not a usable public
 * contact either. The header therefore carries the app, version and platform
 * only.
 *
 * WHY A GATE AND NOT A COMMENT
 * ===========================
 * A contact is easy to paste back in while debugging, and nothing in the
 * compiler notices. This reads the client and both public documents, so the
 * header cannot silently drift back to a personal address or a private URL.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const CLIENT = read('src/lib/lichess.ts');
const PRIVACY = read('PRIVACY.md');
const README = read('README.md');

let passed = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('   PASS  ' + msg); }
  else { failures.push(msg); console.log('   FAIL  ' + msg + (detail ? `\n          ${detail}` : '')); }
}

/* ---------------------------------------------------------------------------
 * The rule, as a function, so the controls can be fed the values it must reject.
 * ------------------------------------------------------------------------- */

/** The identity-only header. A contact suffix is a deliberate future release decision. */
const EXPECTED = 'ChessForge/1.0 (Android)';
const UA_SHAPE = /^ChessForge\/1\.0 \(Android\)$/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAILTO = /mailto:/i;

function hasPersonalContact(text) {
  return EMAIL.test(text) || MAILTO.test(text);
}

/* ---------------------------------------------------------------------------
 * 1. There is one User-Agent, in one place, and it has no personal contact.
 * ------------------------------------------------------------------------- */

const declared = CLIENT.match(/const USER_AGENT =\s*'([^']+)'/);
ok(!!declared, 'the client declares a USER_AGENT constant');

const ua = declared?.[1] ?? '';
console.log(`\n[1] the header\n    ${ua || '(none found)'}\n`);

ok(UA_SHAPE.test(ua), 'the header has the form `ChessForge/1.0 (Android)`', ua);
ok(ua === EXPECTED, 'the header is the reviewed identity string', ua);
ok(!hasPersonalContact(ua), 'the header carries no email or mailto address', ua);

/*
 * CONTROL — the gate is not a rubber stamp. The old email form and a private
 * repository URL must both be rejected by the same shape rule.
 */
ok(UA_SHAPE.test('ChessForge/1.0 (Android)'),
   'CONTROL: the identity-only header is accepted');
ok(!UA_SHAPE.test('ChessForge/1.0 (Android; +mailto:someone@example.com)'),
   'CONTROL: a mailto contact is rejected');
ok(!UA_SHAPE.test('ChessForge/1.0 (Android; +https://github.com/private/repo)'),
   'CONTROL: a private repository URL is rejected');

/* ---------------------------------------------------------------------------
 * 2. The header is actually sent — every request, not just the first one.
 * ------------------------------------------------------------------------- */

console.log('\n[2] every request sends it\n');

const fetches = [...CLIENT.matchAll(/\bfetch\(/g)].length;
const sends = [...CLIENT.matchAll(/'User-Agent':\s*USER_AGENT/g)].length;

ok(fetches > 0, `the client makes at least one request (${fetches} call sites)`);
ok(sends === fetches,
   `every request call site passes the header (${sends} of ${fetches})`,
   'a call site without the header is a 403 waiting for a code path to reach it');
ok(!hasPersonalContact(CLIENT), 'the client file contains no personal contact address');

/* ---------------------------------------------------------------------------
 * 3. The public documents say the same thing the app sends.
 * ------------------------------------------------------------------------- */

console.log('\n[3] the app and the notice agree\n');

ok(README.includes(ua), 'README.md publishes the exact User-Agent', `looking for: ${ua}`);
ok(PRIVACY.includes(ua), 'PRIVACY.md publishes the exact User-Agent', `looking for: ${ua}`);
ok(!hasPersonalContact(README), 'README.md publishes no personal contact address');
ok(!hasPersonalContact(PRIVACY), 'PRIVACY.md publishes no personal contact address');
ok(/##\s*Contact/i.test(PRIVACY), 'the notice has a Contact section to find it in');
ok(/public issue tracker/i.test(README),
   'README.md states the contact to add at the public release');
ok(/private/i.test(README) && /MIT/i.test(README),
   'and says why the contact is deferred (private now, MIT on release)');

/*
 * CONTROL — a notice carrying an address must fail the same check. This is the
 * failure mode that motivates the gate: a personal contact returning in prose
 * while the header stays clean.
 */
const stale = README.replace(ua, `${ua}\nmailto:someone@example.com`);
ok(stale !== README && hasPersonalContact(stale),
   'CONTROL: an out-of-step notice is detected by the same check');

/* --------------------------------------------------------------------------- */
console.log('\n' + '-'.repeat(60));
console.log(`User-Agent: ${ua || '(none)'}`);
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
} else {
  console.log(`${passed}/${passed} passed`);
}
process.exit(failures.length ? 1 : 0);
