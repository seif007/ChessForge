/*
 * CACHE REAL PROVIDER PAYLOADS for the hint gate.
 *
 * The hint rings nothing on the device and the code reads correctly, so the next thing to establish
 * is what the screen is actually being handed: the real `ServedPuzzle` shape, built by walking a
 * real provider payload, cached where `hint.piece.test.mjs` can read it.
 *
 * The provider is the shared unauthenticated Lichess endpoint, which rate-limits every caller. A
 * failure here is a fact about the network, not a defect, and the script says so and exits 0 —
 * otherwise a flaky network would make a gate that has nothing to do with the network go red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const OUT = path.join(process.env.TEMP ?? '.', 'cf-puzzle-probe.json');

const pgnMainlineMoves = (pgn) => {
  const body = pgn
    .replace(/^\s*\[[^\]]*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\s+/g, ' ');
  let flat = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) flat += ch;
  }
  return flat.split(/\s+/).filter((t) => t && !/^\d+\.(\.\.)?$/.test(t));
};

const playUci = (fen, u) => {
  const c = new Chess(fen);
  const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return m ? { fen: c.fen(), san: m.san } : null;
};

const results = [];
try {
  const res = await fetch('https://lichess.org/api/puzzle/next?difficulty=medium');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const games = [await res.json()];
  console.log(`endpoint returned ${games.length} puzzles`);

  for (const g of games) {
    const puz = g.puzzle ?? {};
    // The endpoint returns the PGN under `game.pgn` — `game` is an OBJECT, not the PGN string.
    // Verified against a live 200. Guessing the path wrong returns zero puzzles and looks like
    // "no data", which is how this script first reported an empty cache and nearly sent us looking
    // for the bug in the wrong place.
    const sans = pgnMainlineMoves(g.game?.pgn ?? g.pgn ?? '');
    if (!Array.isArray(puz.solution) || puz.solution.length === 0 || !sans.length) continue;

    // The puzzle position is after initialPly full moves plus White's reply.
    const c = new Chess();
    let placed = true;
    for (let i = 0; i < Number(puz.initialPly ?? 0) + 1; i += 1) {
      try { c.move(sans[i]); } catch { placed = false; break; }
    }
    if (!placed) continue;
    const fen = c.fen();
    const side = fen.split(' ')[1];

    /*
     * TRIM TO THE PLAYER'S MOVE, and do it by REPLAYING — the same discipline the app's own
     * `solutionSans` uses. A trimmed length that is merely odd is a guess; replaying proves the
     * move after last belongs to the player, which is what makes `solutionSan[0]` the move the
     * player is being asked to find.
     */
    let walk = fen;
    const kept = [];
    let cursor = side;
    for (const u of puz.solution) {
      const step = playUci(walk, u);
      if (!step) { kept.length = 0; break; }
      walk = step.fen;
      kept.push(u);
      if (cursor === side) kept.push(null);   // mark: pair complete
      cursor = cursor === 'w' ? 'b' : 'w';
    }
    // Drop a trailing opponent move if the line stopped on one.
    if (kept.length && kept[kept.length - 1] === null) kept.pop();
    const uciMoves = kept.filter(Boolean);
    if (!uciMoves.length) continue;

    const board = new Chess(fen);
    const sanList = [];
    let good = true;
    for (const u of uciMoves) {
      const m = board.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!m) { good = false; break; }
      sanList.push(m.san);
    }
    if (!good) continue;

    results.push({ id: puz.id, fen, solutionSan: sanList, side, initialPly: puz.initialPly ?? 0 });
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`cached ${results.length} usable payload(s) at ${OUT}`);
  for (const r of results.slice(0, 4)) {
    console.log(`  ${r.id}  side=${r.side}  first=${r.solutionSan[0]}  fen=${r.fen}`);
  }
} catch (e) {
  console.log(`provider unreachable: ${e.message}`);
  console.log('the hint gate will run its offline checks only — that is a network fact, not a defect');
  process.exit(0);
}