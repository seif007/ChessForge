/*
 * DOES `solvingPiece` ACTUALLY NAME A PIECE?
 *
 * The device says the hint rings NOTHING on the live tab, while before this change it rang every
 * movable piece. So the function that replaced it is either wrong or being fed the wrong thing, and
 * reading the code has not settled it. This runs the real provider payload through the real helpers.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks += 1;
  if (cond) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label}`); }
}

/*
 * A byte-for-byte copy of `solvingPiece` from src/lib/hint.ts. It is copied rather than imported
 * because hint.ts is TypeScript and this gate is plain node — and if the copy and the shipped one
 * ever differ, that is a gap this gate cannot see, which is stated rather than hidden.
 */
function solvingPiece(fen, san) {
  if (!san) return [];
  try {
    const board = new Chess(fen);
    const move = board.move(san);
    if (!move) return [];
    return [move.from];
  } catch {
    return [];
  }
}

console.log('1. THE FUNCTION ITSELF, ON A POSITION WE KNOW');
{
  /*
   * BLACK TO MOVE, so `Nf6` is a legal answer and the square must be g8.
   *
   * The first version of this gate said so after `1.e4 e5 2.Nf3 Nc6`, which is four plies and
   * therefore still WHITE to move — chess.js threw "Invalid move: Nf6" and the gate failed for a
   * reason that had nothing to do with the code under test. Written down here because a gate that
   * fails for the wrong reason is worse than one that does not run.
   */
  const c = new Chess();
  c.move('e4'); c.move('e5'); c.move('Nf3'); c.move('Nc6'); c.move('Bb5');   // 5 plies
  const fen = c.fen();
  ok(fen.split(' ')[1] === 'b',
    `the fixture really is Black to move (the gate must not lie about this — got ${fen.split(' ')[1]})`);
  ok(solvingPiece(fen, 'Nf6')[0] === 'g8', `names the piece that plays Nf6 (got ${solvingPiece(fen, 'Nf6')[0]})`);
  ok(solvingPiece(fen, 'Nf6').length === 1, 'exactly one square comes back');

  /*
   * AND IT MUST REFUSE A MOVE THE SIDE TO MOVE CANNOT MAKE.
   *
   * Four plies — `e4 e5 Nf3 Nc6` — is WHITE to move, so `Nf6` is Black's move and White cannot
   * play it. Three plies, which this gate also used once, is BLACK to move and `Nf6` is perfectly
   * legal there; both counts were wrong at different times and each produced a confident FAIL about
   * something other than the thing under test.
   */
  const w = new Chess();
  w.move('e4'); w.move('e5'); w.move('Nf3'); w.move('Nc6');   // 4 plies, White to move
  ok(w.fen().split(' ')[1] === 'w', `the CONTROL fixture really is White to move (got ${w.fen().split(' ')[1]})`);
  const wrongSide = solvingPiece(w.fen(), 'Nf6');
  ok(wrongSide.length === 0,
    `CONTROL: a move the side to move cannot make rings NOTHING (got ${JSON.stringify(wrongSide)})`);

  ok(solvingPiece(fen, 'd5')[0] === 'd7', `it follows the SAN, not a fixed square (got ${solvingPiece(fen, 'd5')[0]})`);
  ok(solvingPiece(fen, null).length === 0, 'a null SAN rings nothing rather than throwing');
  ok(solvingPiece(fen, 'Zz9').length === 0, 'an illegal SAN rings nothing rather than throwing');
  ok(solvingPiece('', 'Nf3').length === 0, 'an empty FEN rings nothing rather than throwing');
  ok(solvingPiece('not a fen at all', 'Nf3').length === 0, 'a junk FEN rings nothing');
}

console.log('');
console.log('2. AGAINST REAL PROVIDER PAYLOADS');
{
  const cache = path.join(process.env.TEMP ?? '.', 'cf-puzzle-probe.json');
  let payloads = [];
  if (fs.existsSync(cache)) {
    payloads = JSON.parse(fs.readFileSync(cache, 'utf8'));
    console.log(`  using ${payloads.length} cached payload(s)`);
  } else {
    console.log('  no cache — run scripts/probe-puzzles.mjs first');
  }

  for (const p of payloads) {
    const fen = p.fen;
    const san = Array.isArray(p.solutionSan) ? p.solutionSan[0] : undefined;
    const got = solvingPiece(fen, san);
    ok(typeof fen === 'string' && fen.length > 10, `payload ${p.id}: it has a FEN`);
    ok(Array.isArray(p.solutionSan) && p.solutionSan.length > 0, `payload ${p.id}: it has a solution`);
    ok(got.length === 1,
      `payload ${p.id}: solvingPiece names exactly one piece (got ${JSON.stringify(got)} for ${san} in ${fen})`);
  }
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);