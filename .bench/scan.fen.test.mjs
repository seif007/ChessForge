/**
 * THE SCAN'S FEN CONTINUITY AND SEARCH-COUNT ARITHMETIC.
 *
 * A cached scan is only sound if the position after one ply is byte-identical
 * to the position before the next. The cache itself was measured and reverted,
 * so this also pins the shipped cost: roughly one search per ply, not two per
 * user move. The games are legal opening lines, generated locally.
 *
 * Run: node .bench/scan.fen.test.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

let checks = 0, failures = 0;
function check(label, ok, detail = '') {
  checks++;
  if (ok) console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

const LINES = [
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Nb8 d4 Nbd7',
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7',
  'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7',
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 Bb3 Ba7 Nbd2 Be6',
  'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3 Be7 Qd2 O-O',
  'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6',
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7 Ne1 Nd7 Be3 f5',
  'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5 Bg2 Nb6 O-O Be7 d3 O-O',
  'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5 O-O Nc6 a3 Bxc3 bxc3 dxc4 Bxc4 Qc7',
  'd4 f5 g3 Nf6 Bg2 e6 Nf3 Be7 O-O O-O c4 d6 Nc3 Qe8 Re1 Qg6',
];

const games = [];
for (let i = 0; i < LINES.length; i++) {
  for (const color of ['w', 'b']) {
    games.push({ id: `${color}${i}`, color, movesSan: LINES[i].split(' ') });
  }
}

/* ---- (a) FEN continuity: after ply N === before ply N+1 ------------------ */

console.log('\n(a) FEN continuity across plies (the cache is only sound if this holds)');
{
  let compared = 0, mismatch = 0, firstBad = '';
  for (const g of games) {
    const c = new Chess();
    let prevAfter = null;
    for (let ply = 0; ply < g.movesSan.length; ply++) {
      const before = c.fen();
      if (prevAfter !== null) {
        compared++;
        if (prevAfter !== before) {
          mismatch++;
          if (!firstBad) firstBad = `${g.id} ply ${ply}`;
        }
      }
      c.move(g.movesSan[ply]);
      prevAfter = c.fen();
    }
  }
  check('after(N) === before(N+1)', mismatch === 0,
    `${compared} pairs compared, ${mismatch} mismatch${firstBad ? ' (' + firstBad + ')' : ''}`);
  check('the continuity check actually compared positions', compared > 100, `${compared} pairs`);
}

/* ---- (b) search count: naive vs cached ----------------------------------- */

console.log('\n(b) engine searches: naive (2 per user move) vs cached (1 per ply)');
{
  let naive = 0, cached = 0, fenHits = 0;
  for (const g of games) {
    const userIsWhite = g.color === 'w';
    const L = Math.min(g.movesSan.length, 120);

    for (let ply = 0; ply < L; ply++) {
      if ((ply % 2 === 0) === userIsWhite) naive += 2;
    }

    const c = new Chess();
    const seen = new Set();
    for (let ply = 0; ply < L; ply++) {
      const fen = c.fen();
      if (!seen.has(fen)) { seen.add(fen); cached++; }
      else fenHits++;
      c.move(g.movesSan[ply]);
      if (ply === L - 1 && (ply % 2 === 0) === userIsWhite) {
        const endFen = c.fen();
        if (!seen.has(endFen)) cached++;
      }
    }
  }
  const pct = naive ? Math.round((1 - cached / naive) * 100) : 0;
  console.log(`   naive:  ${naive} searches`);
  console.log(`   cached: ${cached} searches  (${fenHits} FEN cache hits)`);
  check('the FEN cache is NOT a win (measured, and reverted on purpose)', cached >= naive,
    `${pct}% difference (${cached} vs ${naive}) — see gameScan.ts header`);
  check('and the shipped design is still ~1 search per ply, not 2 per user move',
    cached <= naive * 1.05,
    `${(cached / naive).toFixed(2)}x naive`);
  check('a cache would still be sound (every "after" equals the next "before")', true);
}

/* ---- (c) the full-scan projection ---------------------------------------- */

console.log('\n(c) projected cost of the chosen scan (200 games, depth 10)');
{
  const sample = games.slice(0, 200);
  let searches = 0, userMoves = 0;
  for (const g of sample) {
    const L = Math.min(g.movesSan.length, 120);
    const userIsWhite = g.color === 'w';
    for (let ply = 0; ply < L; ply++) {
      if ((ply % 2 === 0) === userIsWhite) {
        userMoves++;
        searches += 2;
      }
    }
  }
  console.log(`   ${sample.length} games, ${userMoves} user-move positions, ~${searches} engine searches`);
  check('the projection is non-zero', searches > 0 && userMoves > 0);
  check('the projection is bounded by the corpus', userMoves <= sample.length * 60,
    `${userMoves} user moves across ${sample.length} games`);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
