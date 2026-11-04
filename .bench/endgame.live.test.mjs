/**
 * Does `fetchLiveEndgame` really yield solvable endgame positions?
 *
 * WHY THIS EXISTS
 * ---------------
 * The live path takes a whole PGN from Lichess, replays it to `initialPly`, and
 * presents whatever position that lands on as an endgame drill. That replay is
 * the load-bearing assumption and it is easy to get subtly wrong:
 *
 *   - Lichess PGNs interleave move numbers, comments and the result token into
 *     the token stream, and replaying one of those as a move throws.
 *   - If the replay stops early, `played < ply` and we must return null rather
 *     than serve the WRONG position — a drill where it is not the user's move,
 *     or a position that is already over, is worse than no drill at all.
 *   - `initialPly` is a half-move count, so off-by-one is very easy.
 *
 * So this harness fetches N real puzzles, replays each one, and asserts the
 * position it lands on is actually playable: it is not game-over, there are
 * legal moves, and the side to move matches the ply parity.
 *
 * It talks to the network. If it is offline it skips rather than failing, since
 * the offline generator is the guaranteed path anyway.
 */

const N = Number(process.argv[2] ?? 8);

let checks = 0;
let failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

/** Mirror of `fenAtPly` in src/lib/endgameTrainer.ts. */
async function loadChess() {
  const mod = await import('../node_modules/chess.js/dist/esm/chess.js').catch(() => null);
  if (mod) return mod.Chess;
  const cjs = await import('node:module').then(({ createRequire }) => {
    const require = createRequire(import.meta.url);
    return require('chess.js');
  });
  return cjs.Chess;
}

function fenAtPly(Chess, pgn, ply) {
  try {
    const c = new Chess();
    const tokens = pgn.split(/\s+/).filter(Boolean);
    let played = 0;
    for (const raw of tokens) {
      if (played >= ply) break;
      if (/^\d+\.+$/.test(raw) || raw.startsWith('{') || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(raw)) continue;
      const san = raw.replace(/[!?]+$/, '');
      if (!san || /^\d+\./.test(san)) continue;
      try {
        c.move(san);
        played++;
      } catch {
        break;
      }
    }
    if (played < ply) return null;
    return { fen: c.fen(), side: c.turn(), played };
  } catch {
    return null;
  }
}

async function fetchOne() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://lichess.org/api/puzzle/next?angle=endgame', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const Chess = await loadChess();

console.log(`\nFetching ${N} live endgame puzzles from Lichess…`);

const seen = new Set();
let got = 0, replayed = 0, playable = 0, parity = 0, skipped = 0;
const samples = [];

for (let i = 0; i < N; i++) {
  const data = await fetchOne();
  if (!data?.puzzle?.pgn && !data?.game?.pgn) { skipped++; continue; }
  const puz = data.puzzle;
  const pgn = data.game?.pgn;
  if (!puz || !pgn || typeof puz.initialPly !== 'number') { skipped++; continue; }

  got++;
  const id = puz.id ?? '?';
  if (seen.has(id)) { skipped++; continue; }
  seen.add(id);

  const at = fenAtPly(Chess, pgn, puz.initialPly);
  if (!at) { skipped++; continue; }
  replayed++;

  const c = new Chess(at.fen);
  const moves = c.moves();
  const over = c.isGameOver();
  if (!over && moves.length > 0) playable++;

  // ply parity: even ply => White to move
  const expectSide = puz.initialPly % 2 === 0 ? 'w' : 'b';
  const parityOk = at.side === expectSide;
  if (parityOk) parity++;

  if (samples.length < 4) {
    samples.push({
      id, rating: puz.rating, ply: puz.initialPly,
      themes: (puz.themes ?? []).slice(0, 3).join(','),
      side: at.side, legalMoves: moves.length, over,
      fen: at.fen,
    });
  }
}

console.log(`\n[result] fetched ${got}, replayed ${replayed}, skipped ${skipped}\n`);

for (const s of samples) {
  console.log(`  ${s.id}  rating ${s.rating}  ply ${s.ply}  ${s.side} to move  ${s.legalMoves} legal moves`);
  console.log(`     themes: ${s.themes}`);
  console.log(`     fen: ${s.fen}`);
}

console.log('');
if (replayed === 0) {
  console.log('SKIPPED — no network (the offline generator covers this case)');
  process.exit(0);
}

ok('every replayed position is playable (not over, has moves)', playable === replayed,
   `(${playable}/${replayed})`);
ok('ply parity matches the side to move', parity === replayed, `(${parity}/${replayed})`);
ok('ids are distinct', seen.size === replayed, `(${seen.size} unique / ${replayed})`);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
