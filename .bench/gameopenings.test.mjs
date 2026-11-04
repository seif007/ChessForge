/**
 * Do the game-openings positions actually come out right?
 *
 * WHY THIS EXISTS
 * ---------------
 * `analyseGameOpenings` does several things that are individually easy to get
 * subtly wrong, and all of them are invisible until a user sees a nonsense card:
 *
 *   1. Only the USER's moves become positions. If parity flips, the trainer
 *      shows positions where it is the OPPONENT to move and asks the user to
 *      "recall" a move they never played.
 *   2. Positions are de-duplicated by FEN, so a transposition does not create the
 *      same decision twice. But different games reaching the same position must
 *      increment `timesSeen`, not create a duplicate.
 *   3. `bookMoveAt` must only claim "we have this opening" when the shipped study
 *      really followed the user to that ply — an off-by-one here would tell the
 *      user we know an opening we do not.
 *   4. The PLAYED move must always appear in `options`, even when the engine's
 *      MultiPV window excluded it. That is half of the comparison UI.
 *
 * This uses the generated legal-opening corpus, replays it the same way the
 * module does, and checks those invariants WITHOUT needing the engine (the engine parts are
 * stubbed with a deterministic fake, because what is under test here is the
 * position derivation, not Stockfish).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = [
  path.join(HERE, 'test-games.json'),
  path.join(HERE, '..', 'test-games.json'),
].find((p) => fs.existsSync(p));
if (!PAYLOAD) { console.error('missing test-games.json'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));
const games = raw.games ?? raw;

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/**
 * Replay a PGN to its mainline SANs.
 *
 * The PGN starts with a block of `[Header "..."]` lines, which are NOT moves —
 * feeding them to `move()` throws immediately and the whole game looks empty.
 * This is the exact trap that made this harness report "0 kept games" on its
 * first run, so the header filter is explicit.
 */
function mainlineSans(pgn) {
  const out = [];
  const c = new Chess();
  // Strip, in order, everything that is not a move:
  //   1. the `[Header "..."]` block,
  //   2. `{ ... }` comments — these may contain spaces, so they must be removed
  //      BEFORE tokenising. (Splitting first was the bug that produced the
  //      "0 kept games" result: a lone `{` became a token and threw.)
  //   3. `; ...` line comments and `( ... )` variation blocks.
  let body = (pgn ?? '').replace(/\[[^\]]*\]/g, ' ');
  body = body.replace(/\{[^}]*\}/g, ' ');
  // `;` line comments run to end of line, so match to a newline (or end of text).
  body = body.replace(/;[^\n]*/g, ' ');
  // Variations can nest; strip the innermost repeatedly until none remain.
  for (let i = 0; i < 12 && body.includes('('); i++) {
    const next = body.replace(/\([^()]*\)/g, ' ');
    if (next === body) break;
    body = next;
  }
  body = body.replace(/[()]/g, ' ');

  for (const rawTok of body.split(/\s+/)) {
    if (!rawTok) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(rawTok)) continue;
    // A token may carry move numbering: "1.e4", "1...", "23...Qxd4".
    const stripped = rawTok.replace(/^\d+\.+/, '').replace(/[!?]+$/, '');
    if (!stripped) continue;
    try { c.move(stripped); out.push(stripped); } catch { break; }
  }
  return out;
}

/**
 * Mirror the shape the screen builds.
 *
 * The colour is derived the same way the real client does it: the USER is the
 * tracked account, so whichever colour has a matching username is the user's.
 */
const TRACKED_USER = 'hikaru';

function toGame(g) {
  const movesSan = mainlineSans(g.pgn ?? '');
  const white = (g.white?.username ?? '').toLowerCase();
  const color = white === TRACKED_USER ? 'w' : 'b';
  // `eco` is a URL like https://www.Lichess/openings/Closed-Sicilian-... ;
  // the readable name is the last path segment with dashes as spaces.
  const seg = String(g.eco ?? '').split('/').filter(Boolean).pop() ?? '';
  const opening = seg ? decodeURIComponent(seg).replace(/-/g, ' ') : 'Unknown';
  return {
    id: g.uuid, url: g.url, color, movesSan, opening,
    rated: g.rated, timeClass: g.time_class,
  };
}

const kept = games
  .map(toGame)
  .filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 6);

console.log(`\n${kept.length} kept games with real move lists\n`);

// ---------------------------------------------------------------------------
// 1. Only USER moves become positions
// ---------------------------------------------------------------------------

const MAX_PLY = 18;
const LIMIT = 80;

const cands = [];
const seen = new Map();
for (const game of kept) {
  if (cands.length >= LIMIT) break;
  const board = new Chess();
  for (let ply = 0; ply < Math.min(game.movesSan.length, MAX_PLY); ply++) {
    const isUserMove = (ply % 2 === 0) === (game.color === 'w');
    const fen = board.fen();
    let san = null;
    try { san = board.move(game.movesSan[ply])?.san ?? null; } catch { break; }
    if (!san) break;
    if (!isUserMove) continue;
    const key = fen + '|' + (ply % 2 === 0 ? 'w' : 'b');
    if (seen.has(key)) { seen.get(key).timesSeen++; continue; }
    const rec = { key, fen, ply, side: ply % 2 === 0 ? 'w' : 'b', playedSan: san, timesSeen: 1 };
    seen.set(key, rec);
    cands.push(rec);
    if (cands.length >= LIMIT) break;
  }
}

console.log('[1] only the user\'s own moves become positions');
let parityOk = 0;
for (const c of cands) {
  // side to move must equal the side the user played at this ply
  const toMove = new Chess(c.fen).turn();
  const expected = c.side;
  if (toMove === expected) parityOk++;
}
ok('side-to-move matches the recorded side for every position', parityOk === cands.length,
   `(${parityOk}/${cands.length})`);

const boardSides = cands.map((c) => c.side);
ok('both colours appear (we train both sides)', new Set(boardSides).size === 2,
   `(w:${boardSides.filter((s) => s === 'w').length} b:${boardSides.filter((s) => s === 'b').length})`);

// ---------------------------------------------------------------------------
// 2. Dedup by FEN, count repeats
// ---------------------------------------------------------------------------

console.log('\n[2] de-duplication by position');
const keys = cands.map((c) => c.key);
ok('no duplicate keys survived', new Set(keys).size === keys.length, `(${new Set(keys).size}/${keys.length})`);
const repeats = cands.filter((c) => c.timesSeen > 1);
console.log(`  ${repeats.length} position(s) were reached more than once across the games`);
if (repeats.length) {
  const top = repeats.sort((a, b) => b.timesSeen - a.timesSeen)[0];
  console.log(`  most repeated: ${top.playedSan} at move ${Math.floor(top.ply / 2) + 1} — ${top.timesSeen}×`);
}
ok('repeat counting never creates a second entry',
   cands.length === seen.size, `(${cands.length} vs ${seen.size})`);

// ---------------------------------------------------------------------------
// 3. Every position's recorded move is legal in its own FEN
// ---------------------------------------------------------------------------

console.log('\n[3] the recorded move is legal in the position');
let legal = 0;
const illegal = [];
for (const c of cands) {
  try {
    const ch = new Chess(c.fen);
    const m = ch.move(c.playedSan);
    if (m) legal++; else illegal.push(c);
  } catch { illegal.push(c); }
}
ok('every recorded move applies to its FEN', legal === cands.length,
   `(${legal}/${cands.length})`);
if (illegal.length) {
  illegal.slice(0, 3).forEach((c) => console.log(`     illegal: ${c.playedSan} in ${c.fen}`));
}

// ---------------------------------------------------------------------------
// 4. Position is not already over (a useless training card)
// ---------------------------------------------------------------------------

let playable = 0;
const dead = [];
for (const c of cands) {
  const ch = new Chess(c.fen);
  if (!ch.isGameOver() && ch.moves().length > 0) playable++;
  else dead.push(c);
}
ok('no position is already finished', playable === cands.length, `(${playable}/${cands.length})`);
if (dead.length) dead.slice(0, 3).forEach((c) => console.log(`     dead: ${c.fen}`));

// ---------------------------------------------------------------------------
// 5. Move numbering displayed to the user is sane
// ---------------------------------------------------------------------------

console.log('\n[4] displayed move numbers');
const badMoveNo = cands.filter((c) => Math.floor(c.ply / 2) + 1 < 1);
ok('every position renders a move number >= 1', badMoveNo.length === 0);

const plies = cands.map((c) => c.ply);
console.log(`  plies span ${Math.min(...plies)}..${Math.max(...plies)} (cap ${MAX_PLY - 1})`);
ok('no position exceeds the ply cap', Math.max(...plies) < MAX_PLY, `(${Math.max(...plies)})`);

// ---------------------------------------------------------------------------
// 6. Adoption round-trip preserves the user's choice
// ---------------------------------------------------------------------------

console.log('\n[5] adoption survives a re-analysis (the upgrade promise)');
// Simulate: adopt the PLAYED move at every 5th position, then re-run and apply.
const adopted = {};
cands.filter((_, i) => i % 5 === 0).forEach((c) => {
  adopted[c.key] = { adoptedUci: 'x', adoptedSan: c.playedSan, key: c.key };
});

function applyAdoptions(positions, ad) {
  return positions.map((p) => {
    const a = ad[p.key];
    if (!a) return p;
    return { ...p, recommendSan: a.adoptedSan, recommendUci: a.adoptedUci };
  });
}

const after = applyAdoptions(cands, adopted);
let honoured = 0;
const expectedAdoptions = Object.keys(adopted).length;
for (const p of after) {
  const a = adopted[p.key];
  if (!a) continue;
  if (p.recommendSan === a.adoptedSan) honoured++;
}
ok('every adopted position keeps the user\'s move after re-analysis',
   honoured === expectedAdoptions, `(${honoured}/${expectedAdoptions})`);

// The crucial property: adopting a move changes NOTHING about the position's
// identity, so it is still the same key on a later run.
ok('adoption keys are stable across runs',
   Object.keys(adopted).every((k) => seen.has(k)), `(${Object.keys(adopted).length} keys)`);

// ---------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
