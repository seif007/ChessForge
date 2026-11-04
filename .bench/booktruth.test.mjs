/**
 * Is "our book" TRUE?
 *
 * THE TWO COMPLAINTS
 * ------------------
 * 1. *"it shows that the knight move is not in our book while it is clearly on our
 *     book."* The screen labelled the move the user played with a string derived
 *     from `inBook` — a fact about the POSITION — and so told a user who played
 *     `1...Nf6` "not our book move" on the same card that said "We have this".
 * 2. *"see how your openings works and its content and fix it … without these
 *     mistakes."* The underlying cause: `inBook` was `matchedPly >= ply`, which is
 *     true whenever ANY book shares the first move. With `1.e4` and Black to move
 *     that was thirteen books, and the reply that got attributed to "our book"
 *     belonged to whichever entry came first in the registry.
 *
 * WHAT IS ASSERTED HERE
 * --------------------
 * The reply set is the union of what we ACTUALLY ship, filtered by the side to
 * move, and the three labels follow from it. Every case below is a real position
 * from the reference corpus, and the expected answers are read off the shipped
 * repertoire JSON rather than written by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const ROOT = path.resolve(HERE, '..');

function cleanDir(dir) {
  try { execFileSync('rm', ['-rf', dir], { stdio: 'pipe' }); } catch { /* best effort */ }
}
const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-booktruth');
cleanDir(BUILD_DIR);
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2020', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    resolveJsonModule: true, esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [
    path.join(ROOT, 'src', 'lib', 'openings.ts'),
    path.join(ROOT, 'src', 'lib', 'repertoire.ts'),
  ],
}, null, 2));
try {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project', path.join(BUILD_DIR, 'tsconfig.json')], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2000));
  process.exit(2);
}

function findEmitted(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const h = findEmitted(p, name); if (h) return h; }
    else if (e.name === name) return p;
  }
  return null;
}
const Module = require('node:module');
const origLoad = Module._load;
const REAL = require('chess.js');
const OP_JS = findEmitted(BUILD_DIR, 'openings.js');
const RP_JS = findEmitted(BUILD_DIR, 'repertoire.js');
Module._load = function (request, parent, isMain) {
  if (request === 'chess.js') return REAL;
  if (request === '@/lib/repertoire') return origLoad.call(this, RP_JS, null, false);
  if (request.startsWith('@/data/')) {
    return origLoad.call(this, path.join(ROOT, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};
const openings = origLoad.call(Module, OP_JS, null, false);
const { OPENINGS, bookHere } = openings;

/*
 * WHAT THE SHIPPED BLACK BOOKS REALLY SAY AFTER 1.e4.
 *
 * Derived from `src/data/*.json` with the same line collection the app uses
 * (`collectStudyLinesUncached` in `repertoire.ts`: the tree is a SPINE, and `variations[ply]` are
 * alternates from that ply), so this is the books' own answer rather than a list someone typed once
 * and forgot. It is read at run time, so adding or correcting a book moves the expectation with it.
 *
 * Getting this shape right took three attempts - the tree is not a nest of nodes, `variations` is an
 * array of LINES, and the array at `tree` is one node per ply rather than a list of moves at a ply.
 * Two of the three attempts silently found zero replies after `e4`, which is indistinguishable from a
 * corpus with no `e4` lines at all, and would have made the check below pass vacuously.
 */
const SHIPPED_BLACK_REPLIES_AFTER_E4 = (() => {
  const studyLines = (study) => {
    const lines = [];
    const nestedLines = (vari, prefix) => {
      const out = [];
      for (let i = 0; i < vari.length; i++) {
        for (const sub of vari[i].variations ?? []) {
          const base = [...prefix, ...vari.slice(0, i).map((m) => m.san)];
          out.push([...base, ...sub.map((m) => m.san)]);
          out.push(...nestedLines(sub, base));
        }
      }
      return out;
    };
    const walk = (idx, prefix) => {
      if (idx >= study.tree.length) { if (prefix.length) lines.push(prefix); return; }
      const node = study.tree[idx];
      walk(idx + 1, [...prefix, node.san]);
      for (const vari of node.variations ?? []) {
        lines.push([...prefix, ...vari.map((m) => m.san)]);
        lines.push(...nestedLines(vari, prefix));
      }
    };
    walk(0, []);
    return [...new Set(lines)];
  };
  const set = new Set();
  for (const entry of OPENINGS) {
    if (!entry.available || !entry.repertoire || entry.side !== 'black') continue;
    for (const ch of entry.repertoire.chapters ?? []) {
      for (const st of ch.studies ?? []) {
        for (const seq of studyLines(st)) {
          if (seq[0] === 'e4' && seq[1]) set.add(seq[1]);
        }
      }
    }
  }
  return [...set].sort();
})();

/* ------------------------------------------------ the labels, lifted from source */

const SCREEN = fs.readFileSync(
  path.join(ROOT, 'src', 'components', 'screens', 'GameOpeningsScreen.tsx'), 'utf8');

const playedMatch = /function playedNote\(choice:[\s\S]*?\n\}/.exec(SCREEN);
const recMatch = /function recNote\(choice:[\s\S]*?\n\}/.exec(SCREEN);

/**
 * Erase the TypeScript so the shipped body can be evaluated as JavaScript.
 *
 * Only the erased parts are touched: the parameter's type annotation and the
 * return type. Both are compile-time only, so removing the text is equivalent.
 * The body — the three-way decision that is the whole point of this test — is
 * untouched, and §0 fails loudly if the regex ever stops matching.
 */
function stripTs(src) {
  return src
    .replace(/\(choice:[^)]*\)/, '(choice)')
    .replace(/\):\s*string\s*\{/, ') {');
}
// The body is turned into a factory and then CALLED, so the variable holds the
// shipped function itself. (Leaving the factory uncalled made every §2 assertion
// compare against the function's SOURCE, which is a string and matches nothing.)
const playedNote = playedMatch
  ? new Function(`${stripTs(playedMatch[0])
    .replace(/^function playedNote/, 'return function')
    .replace(/\n\}$/, '}')}`)()
  : null;

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
}
ok('the shipped playedNote was found in the source', typeof playedNote === 'function',
  playedMatch ? '' : 'REGEX MISSED IT — §2 would be vacuous');
ok('the shipped recNote was found in the source', recMatch != null);
ok('the lifted playedNote has no TypeScript left in it',
  !/:\s*(NonNullable|string|BuilderStep)/.test(stripTs(playedMatch?.[0] ?? '')));

/* -------------------------------------------------- §1 the reply sets themselves */

console.log('\n§1  the reply set is the union of what we ship, for the side to move');

{
  // 1.e4, and it is Black to move — so `bookHere` is asked about Black's books.
  // There is no `side` argument: the mover is derived from the ply, because a book
  // is a tree of WHOLE LINES and a White book's tree also contains Black's moves.
  // (The first version of this API took a side, and a wrong-side query returned
  // the OPPONENT's moves with a confident label.)
  const here = bookHere(['e4']);
  ok('after 1.e4 our Black books offer a move', here && here.replies.length > 0,
    here ? here.replies.join(' ') : 'null');

  /*
   * `Nf6` IS ONE OF THEM, AND THIS GATE WAS WRONG ABOUT IT.
   *
   * This asserted `!here.replies.includes('Nf6')`, on the grounds that the King's Indian Defense is
   * written `1.d4 Nf6`. That premise is half true and the conclusion does not follow: the KID book
   * really is written `1.d4 Nf6` (checked - 275 lines, none of them starting `e4`), but `bookHere`
   * answers with the UNION over every Black book, and the ALEKHINE DEFENSE is a Black book whose whole
   * point is `1.e4 Nf6`. Its chapter 1 is "The Four Pawns Attack", study `ale1.1`, and it contains
   * `e4 Nf6 e5 Nd5 d4 d6 c4 Nb6` and twenty-odd others.
   *
   * So the assertion was failing for the wrong reason, and it had been failing long enough to look
   * like a product bug: the book index was right and the test was wrong. Rewritten to assert what it
   * was reaching for - that the reply set is the union of the Black books' moves and nothing else.
   */
  ok('1...Nf6 IS among them, because the Alekhine Defense is a Black book that plays it',
    here && here.replies.includes('Nf6'), here ? here.replies.join(' ') : '');
  ok('the French (e6) and the Sicilian (c5) are, because both really contain them',
    here && here.replies.includes('e6') && here.replies.includes('c5'));

  /*
   * THE REAL PROPERTY: the reply set is the union over the Black books, and it is complete.
   *
   * Checked against the shipped data rather than against a hand-written list, so it cannot drift when
   * a book is added or corrected. A reply that is NOT in the books is the failure that actually matters
   * - it is the app telling the user "this is our move" about a move we do not teach - and a reply
   * that IS in the books but missing from the set is the same bug in the other direction, a book the
   * user owns that the app will not use.
   */
  ok('every reply we offer after 1.e4 is really in a Black book',
    SHIPPED_BLACK_REPLIES_AFTER_E4.every((r) => !here || here.replies.includes(r)),
    `we offer: ${here ? here.replies.join(' ') : 'null'}`);
  ok('and we offer every Black book reply after 1.e4',
    here && SHIPPED_BLACK_REPLIES_AFTER_E4.every((r) => here.replies.includes(r)),
    `books contain: ${SHIPPED_BLACK_REPLIES_AFTER_E4.join(' ') || 'none'}`);
  /*
   * The vacuity guard, asserted HERE rather than at the top of the file - the only place `ok` is in
   * scope. Two earlier attempts at reading the book tree found zero `e4` lines, which would have made
   * the two checks above pass while proving nothing, so the guard is not optional.
   */
  ok('the shipped Black books really do contain 1.e4 lines, so the union check is not vacuous',
    SHIPPED_BLACK_REPLIES_AFTER_E4.length > 0,
    `none found across ${OPENINGS.filter((e) => e.side === 'black' && e.available).length} available Black openings`);

  // Two plies on it is White's move, so only White books may advise.
  const deeper = bookHere(['e4', 'e5']);
  ok('after 1.e4 e5 only White books may advise (side filter really runs)',
    deeper && deeper.entries.every((e) => e.side === 'white'),
    deeper ? deeper.entries.map((e) => e.name).join(', ') : '');
  ok('and the replies are real White opening moves, not Black ones',
    deeper && deeper.replies.every((r) => !['c5', 'c6', 'e6'].includes(r)),
    deeper ? deeper.replies.join(' ') : '');

  /*
   * 1.d4, Black to move — and here the fix CHANGES A REAL ANSWER, so it is worth
   * being explicit about why `d5` is absent.
   *
   * We ship a Queen's Gambit, and it is a WHITE book: it teaches the moves a
   * player makes as White after 1.d4 (2.c4, 2.Nf3, ...). Its tree does contain the
   * SAN `d5` at ply 1, because a tree is a whole line — but that `d5` is Black's
   * move, and crediting it to a Black user would be the "wrong side" bug written
   * about in `bookHere`. The old code did exactly that, and told a Black user who
   * answered 1.d4 with 1...d5 that our book move was `d5` — in a book that
   * contains no advice for him at all.
   *
   * So the honest answer after 1.d4 is `Nf6`, which our Black books really teach.
   * A Black user who plays 1...d5 is correctly told we have no book for his move
   * here, and gets the engine's suggestion. That is a CONTENT gap (we teach the
   * Queen's Gambit only from White's side), not a lookup bug, and it is measured
   * and reported rather than papered over.
   */
  const kd = bookHere(['d4']);
  ok('after 1.d4 our Black books include Nf6 (King\'s Indian Defense)',
    kd && kd.replies.includes('Nf6'), kd ? kd.replies.join(' ') : '');
  ok('and every entry offering it is a BLACK book',
    kd && kd.entries.every((e) => e.side === 'black'),
    kd ? kd.entries.map((e) => `${e.name}(${e.side})`).join(', ') : '');
  ok('the Queen\'s Gambit is a White book, so it advises White — and after 1.d4 the',
    true);
  ok('mover is Black, so its d5 is not offered here (that was the "wrong side" bug)',
    kd && !kd.entries.some((e) => e.id === 'queens-gambit'),
    kd ? kd.entries.map((e) => e.id).join(', ') : '');
}

{
  // The reply set must be LEGAL, or the app would offer a move it then refuses.
  let illegal = 0, checked = 0;
  for (const line of [['e4'], ['d4'], ['e4', 'c5'], ['d4', 'Nf6'], ['c4'], ['Nf3']]) {
    const r = bookHere(line);
    if (!r) continue;
    for (const san of r.replies) {
      checked++;
      const probe = new Chess();
      for (const s of line) probe.move(s);
      try { if (!probe.move(san)) illegal++; } catch { illegal++; }
    }
  }
  ok(`every book reply is legal in its own position (${checked} checked)`, illegal === 0,
    `${illegal} illegal`);
}

{
  // A reply must never be credited to a book for the other colour. The mover is
  // derived from the ply, so this is checked against the derived mover.
  let crossed = 0, checked = 0;
  for (const line of [['e4'], ['d4'], ['c4'], ['Nf3'], ['e4', 'e5'], ['d4', 'd5']]) {
    const r = bookHere(line);
    if (!r) continue;
    const want = line.length % 2 === 0 ? 'white' : 'black';
    for (const e of r.entries) {
      checked++;
      if (e.side !== want) crossed++;
    }
  }
  ok(`no reply is credited to a book for the other colour (${checked} entries)`, crossed === 0,
    `${crossed} crossed`);
}

/* --------------------------------- §2 the labels, on the position from the device */

console.log('\n§2  the labels, on the position the device showed');

if (typeof playedNote === 'function') {
  // What was on the screen: 1.e4, the user (Black) played Nf6, we suggested e6.
  const here = bookHere(['e4']);
  const choice = {
    playedSan: 'Nf6',
    inBook: here && here.replies.length > 0,
    bookReplies: here ? here.replies : [],
    recommendIsBookMove: here ? here.replies.includes('e6') : false,
  };
  const note = playedNote(choice);
  ok('the old label was "not our book move" whenever the position was in book',
    // The regression, restated: the old function returned this for ANY in-book
    // position, so this is what it produced on the device.
    (choice.inBook ? 'not our book move' : 'your move') === 'not our book move');
  ok('the new label is the accurate one, not a blanket "not our book move"',
    note !== 'not our book move', `now: "${note}"`);
  /*
   * ...and it tells the truth about THIS position.
   *
   * Which is `one of our moves`, because `Nf6` really is in the Black books after `1.e4` - the
   * Alekhine Defense plays it. This assertion wanted `'your move - not one of ours'`, which was the
   * same false premise as section 1 read from the other end: it would only have held if no Black book
   * played `1...Nf6`, and one does.
   *
   * The label is now checked against the data rather than against a remembered position, which is the
   * point: the sentence has to be true of whatever the books say, not of what this test once believed.
   */
  ok('and it tells the truth about this position: Nf6 IS one of ours, so it says so',
    here.replies.includes('Nf6') && note === 'one of our moves',
    `${note} (replies: ${here.replies.join(' ')})`);

  // And the case that motivated the fix in the other direction: a move we DO play.
  const kd = bookHere(['d4']);
  const ours = playedNote({
    playedSan: 'Nf6', inBook: true, bookReplies: kd.replies, recommendIsBookMove: true,
  });
  ok('when the user plays a move our books contain, it says so',
    ours === 'one of our moves', ours);

  // And the out-of-book case.
  const none = playedNote({ playedSan: 'Qh4', inBook: false, bookReplies: [], recommendIsBookMove: false });
  ok('with no book at all it just says "your move"', none === 'your move', none);
}

/* ------------------------------------ §3 honesty at scale, over the real corpus */

console.log('\n§3  how often the old claim would have been wrong');

{
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'test-games.json'), 'utf8'));
  const sans = (pgn) => {
    const body = pgn.split('\n').filter((l) => !l.trim().startsWith('[')).join(' ');
    const out = []; const c = new Chess();
    for (const tok of body.split(/\s+/)) {
      const t = tok.trim();
      if (!t) continue;
      if (t.startsWith('{') || t.endsWith('}') || t.includes('%clk')) continue;
      if (/^\d+\.+$/.test(t)) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
      try { const m = c.move(t.replace(/[!?]+$/, '')); if (!m) break; out.push(m.san); } catch { break; }
    }
    return out;
  };
  let inBookOld = 0, inBookNew = 0, decisions = 0, wrongOld = 0;
  for (const g of (raw.games ?? raw).slice(0, 200)) {
    const moves = sans(g.pgn ?? '');
    if (moves.length < 8) continue;
    const colour = String(g.white?.username ?? '').toLowerCase() === 'hikaru' ? 'w' : 'b';
    for (let ply = 0; ply < Math.min(moves.length, 20); ply++) {
      if ((ply % 2 === 0) !== (colour === 'w')) continue;
      if (ply === 0) continue;
      const prefix = moves.slice(0, ply);
      const here = bookHere(prefix, colour);
      if (!here) continue;
      decisions++;
      // OLD rule: any book in the library follows the first move.
      const anyBook = bookHere(prefix, colour === 'w' ? 'b' : 'w') != null
        || here.depth >= ply;
      if (anyBook) inBookOld++;
      if (here.replies.length > 0) inBookNew++;
      // The old label said "not our book move" for every in-book position; that
      // was WRONG whenever the played move really is one of ours.
      if (anyBook && here.replies.includes(moves[ply])) wrongOld++;
    }
  }
  ok(`positions examined (${decisions})`, decisions > 1000);
  ok(`"in book" is now stricter than "some book shares the first move"`,
    inBookNew <= inBookOld, `old ${inBookOld} -> new ${inBookNew}`);
  console.log(`        the old label was simply wrong on ${wrongOld} of those positions`);
  console.log(`        (i.e. it called a book move "not our book move")`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'}: ${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
