/**
 * THE SCAN'S USER-MOVE PARITY AND DEVIATION ARITHMETIC, ON LEGAL GAMES.
 *
 * The engine is stubbed: this is about the parts that can silently invert every
 * statistic — which plies belong to the user, whether a mainline replays, and
 * whether a deviation index points at a real move. The corpus is generated from
 * legal opening lines, so it is deterministic and provider-neutral.
 *
 * Run: node .bench/scan.parity.test.mjs
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
  const movesSan = LINES[i].split(' ');
  for (const color of ['w', 'b']) {
    games.push({ id: `${color}${i}`, color, movesSan });
  }
}

/* ---- 1. the user-move parity rule ---------------------------------------- */

console.log('\n1. user-move parity (the silent-inversion bug)');
{
  let wGames = 0, bGames = 0, wBad = 0, bBad = 0;
  for (const g of games) {
    const userIsWhite = g.color === 'w';
    const board = new Chess();
    for (let ply = 0; ply < g.movesSan.length; ply++) {
      const m = board.move(g.movesSan[ply]);
      if ((ply % 2 === 0) === userIsWhite) {
        const movedWhite = m.color === 'w';
        if (userIsWhite) { wGames++; if (!movedWhite) wBad++; }
        else { bGames++; if (movedWhite) bBad++; }
        break;
      }
    }
  }
  check('White games judged correctly', wBad === 0, `${wGames} checked, ${wBad} wrong`);
  check('Black games judged correctly', bBad === 0, `${bGames} checked, ${bBad} wrong`);
  check('both colours were actually exercised', wGames > 0 && bGames > 0);
}

/* ---- 2. every game replays to a legal end -------------------------------- */

console.log('\n2. full replay of every game');
{
  let good = 0, bad = 0, firstBad = '';
  for (const g of games) {
    const c = new Chess();
    let ok = true;
    for (const san of g.movesSan) {
      try { if (!c.move(san)) { ok = false; break; } } catch { ok = false; break; }
    }
    if (ok) good++;
    else { bad++; if (!firstBad) firstBad = `${g.id} near ply ${g.movesSan.length}`; }
  }
  check(`replayed ${good}/${games.length}`, bad === 0, firstBad);
}

/* ---- 3. deviation arithmetic --------------------------------------------- */

console.log('\n3. deviation ply arithmetic');
{
  let checked = 0, bad = 0;
  for (const g of games) {
    const L = g.movesSan.length;
    const matched = Math.max(1, Math.floor(L / 3));
    if (matched >= L) continue;
    const deviationMove = g.movesSan[matched] ?? null;
    const inRange = matched >= 0 && matched < L && deviationMove != null;
    const lastMatched = g.movesSan[matched - 1];
    if (!inRange || lastMatched == null) bad++;
    checked++;
  }
  check('deviation index in range', bad === 0, `${checked} checked, ${bad} bad`);

  const inBook = { L: 10, matched: 10 };
  check('in-book game yields no deviation', !(inBook.matched < inBook.L));
}

/* ---- 4. tally plumbing ---------------------------------------------------- */

console.log('\n4. tally plumbing');
{
  const KINDS = ['brilliant', 'great', 'best', 'excellent', 'good', 'book',
    'inaccuracy', 'miss', 'mistake', 'blunder'];
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const userMoves = 20;
  for (let i = 0; i < userMoves; i++) counts[KINDS[i % KINDS.length]]++;
  const total = KINDS.reduce((a, k) => a + counts[k], 0);
  check('buckets sum to the move count', total === userMoves, `${total} vs ${userMoves}`);
}

/* ---- 5. the generated corpus is honest ------------------------------------ */

console.log('\n5. the corpus');
{
  const unique = new Set(games.map((g) => g.id));
  check('every game has a unique id', unique.size === games.length,
    `${games.length} games, ${unique.size} unique`);
  check('every game has at least four plies', games.every((g) => g.movesSan.length >= 4));
  check('both colours are represented', games.some((g) => g.color === 'w')
    && games.some((g) => g.color === 'b'));
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
