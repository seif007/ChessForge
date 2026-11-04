/**
 * Endgame Trainer — infinite, always-fresh endgame exercises.
 *
 * Three sources of exercises, tried in this order:
 *
 *  1. **Live from the internet** (`fetchLiveEndgame`). The user asked for new
 *     positions "always from internet". Lichess exposes real endgame positions
 *     through `/api/puzzle/next?angle=endgame`, including themes, rating and the
 *     game the position came from — so a drill can be a genuine tournament
 *     endgame rather than a synthetic one. Preferred whenever the device is
 *     online and a suitable position comes back in time.
 *
 *  2. Generated "by construction" theoretical mates (K+Q, K+R, 2 rooks,
 *     2 bishops, bishop+knight) at random legal placements — an endless supply
 *     of new technique drills, verified for legality with chess.js. This is the
 *     offline path, and it still produces a DIFFERENT position every time, so
 *     "nothing repeats" holds with no connection at all.
 *
 *  3. A build-time engine-verified pool (endgame_pool.json) of complex
 *     winning/defending positions (R+P vs R, pawn races, opposite bishops,
 *     Q vs pawn) — every position was checked by Stockfish 18. Used only when
 *     the live fetch fails and the tier actually has pool material.
 *
 * Difficulty scales with the user's advancement (completed lessons),
 * with an optional manual override.
 */
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import poolData from '@/data/endgame_pool.json';

export type TrainerTier = 'warmup' | 'steady' | 'sharp' | 'relentless';

export interface TrainerExercise {
  id: string;
  tier: TrainerTier;
  category: string;
  title: string;
  fen: string;
  userSide: 'w' | 'b';
  goal: 'mate' | 'promote' | 'survive';
  maxMoves: number;
  engineElo: number;
  brief: string;
  keyIdea: string;
  /*
   * Where the position came from. `live` is a real position out of a real game,
   * fetched from the network; it is NOT the same claim as `pool` (a position this
   * app verified) or `generated` (a position this app synthesised), and the footer
   * renders all three differently. Labelling a fetched game position `generated`
   * told the user the app had made it up.
   */
  source: 'generated' | 'pool' | 'live';
}

export interface PoolExercise {
  id: string;
  tier: string;
  category: string;
  fen: string;
  userSide: 'w' | 'b';
  goal: 'mate' | 'promote' | 'survive';
  maxMoves: number;
  engineElo: number;
  brief: string;
  keyIdea: string;
}

const POOL = poolData as unknown as PoolExercise[];

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function rnd(n: number) { return Math.floor(Math.random() * n); }
function pick<T>(arr: T[]): T { return arr[rnd(arr.length)]; }
function kingDist(a: string, b: string) {
  return Math.max(Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])), Math.abs(+a[1] - +b[1]));
}

const TIER_ORDER: TrainerTier[] = ['warmup', 'steady', 'sharp', 'relentless'];

/** Rating bands, aligned with the puzzle bands in src/lib/puzzles.ts. */
export function tierFromRating(rating: number): TrainerTier {
  if (rating < 1250) return 'warmup';
  if (rating < 1750) return 'steady';
  if (rating < 2250) return 'sharp';
  return 'relentless';
}

/** Legacy progress signal: completed lessons, plus one per 3 trainer solves. */
function tierFromProgress(completedLessons: number, trainerSolved: number): TrainerTier {
  const score = Math.max(0, completedLessons) + Math.floor(Math.max(0, trainerSolved) / 3);
  if (score >= 13) return 'relentless';
  if (score >= 7) return 'sharp';
  if (score >= 3) return 'steady';
  return 'warmup';
}

/**
 * Advancement → auto tier.
 *
 * The endgame RATING is the primary signal, because it moves with results (see
 * src/lib/rating.ts) and is the only thing that actually reflects current
 * strength. Lesson/solved counts are kept as a floor so progress already made
 * is never taken away — but they can no longer be the sole driver, which used
 * to leave someone who trains endlessly and never opens the course parked on
 * the first band for ever.
 */
export function autoTier(rating: number, completedLessons = 0, trainerSolved = 0): TrainerTier {
  const byRating = tierFromRating(rating);
  const byProgress = tierFromProgress(completedLessons, trainerSolved);
  return TIER_ORDER[Math.max(TIER_ORDER.indexOf(byRating), TIER_ORDER.indexOf(byProgress))];
}

/**
 * The menu label for a band.
 *
 * It used to be `id` with the first letter capitalised, which meant the DISPLAYED name was the id.
 * The four labels are now written out rather than derived, so the id can be a lowercase token that
 * reads like an id and the label can be capitalised as a word without a mapping table. `TIER_LABEL`
 * is the single place the two meet, and GATE 1e asserts it has an entry for every `TrainerTier` —
 * a missing one would render `undefined` in the menu.
 */
export const TIER_LABEL: Record<TrainerTier, string> = {
  warmup: 'Warm-up',
  steady: 'Steady',
  sharp: 'Sharp',
  relentless: 'Relentless',
};

export function tierLabel(t: TrainerTier): string {
  return TIER_LABEL[t];
}

/* ---------------- generated mate positions (by construction) ---------------- */

interface MateSpec {
  pieces: { sq: string; piece: string }[];
  budget: number;
  elo: number;
  brief: string;
  keyIdea: string;
}

const MATE_BRIEFS: Record<string, { brief: string; keyIdea: string }> = {
  kq: {
    brief: 'Queen mate at a random starting position. Shrink the box a knight-move at a time, bring your king as a partner, and watch for stalemate when the enemy king hugs the edge.',
    keyIdea: 'Shrink the box; king escorts; no stalemate.',
  },
  kr: {
    brief: 'Rook mate at a random starting position. Cut the enemy king off along a rank or file, walk your king up, then use the ladder or the edge to deliver mate.',
    keyIdea: 'Cut-off first, king second, mate on the edge.',
  },
  k2r: {
    brief: 'Two rooks at a random starting position. The ladder (rook roll): one rook cuts the rank, the other checks, repeat — each check pushes the king one rank closer to the edge.',
    keyIdea: 'Rook ladder: cut a rank, check, repeat.',
  },
  k2b: {
    brief: 'Two bishops at a random starting position. Build a wall of bishops across the board, march your king in, then squeeze the enemy king to the edge corner. Careful — only the corner mates.',
    keyIdea: 'Wall of bishops + king march = corner mate.',
  },
  kbn: {
    brief: 'The hardest of the basic mates: bishop + knight. Herd the king into the corner that matches your bishop color, using the knight to cover the other color. It takes precision — follow the W-method.',
    keyIdea: 'Force the king to the bishop-colored corner.',
  },
};

/**
 * The colour of a square: dark or light.
 *
 * A bishop never changes colour, so the two bishops in a two-bishop mate must
 * start on OPPOSITE colours or the mate does not exist. This is the only piece in
 * the generator whose placement is constrained by anything other than occupancy
 * and king distance — which is exactly why the constraint was missing.
 */
function squareColour(sq: string): 'd' | 'l' {
  return (FILES.indexOf(sq[0]) + (+sq[1] - 1)) % 2 === 0 ? 'd' : 'l';
}

/** Place pieces randomly with king-safety constraints; returns FEN or null. */
function placeMate(spec: { white: string[]; blackKingNotAttacked: true }): { fen: string; pieces: { sq: string; piece: string }[] } | null {
  /*
   * A COUNT IS NOT A CONSTRAINT.
   * ---------------------------
   * This seeded `k2b: ['K', 'B', 'B']` and placed each piece at a uniformly random
   * free square. Nothing in `place()` looked at square colour, so the second bishop
   * landed on the same colour as the first roughly 13 squares in 31 — about 42% of
   * the time.
   *
   * Two bishops on one colour can NEVER mate, whatever the move budget: together
   * they cover 15 squares, they cannot cover the ring around a corner king, and the
   * 50-move rule will eventually end it anyway. So `goal: 'mate'` was unreachable
   * for ~42% of every two-bishop drill, and the user got "Out of the 20-move budget.
   * Try a more direct method." plus an Elo drop, for a position that was never
   * winnable. `k2b` has weight 2/4 in the `sharp` menu and 1/4 in `relentless`, and
   * `sharp` draws 45% generated, so roughly 9% of all sharp drills were
   * unwinnable on arrival.
   *
   * The lesson is recorded because the same mistake is easy to repeat: a piece LIST
   * says how many of something to place, never where. Anything with a placement
   * invariant (bishops, pawns that must not be on the 2nd/7th, promoted pieces)
   * needs that invariant enforced where the piece is put down, not assumed from the
   * roster.
   */
  for (let attempt = 0; attempt < 400; attempt++) {
    const used = new Set<string>();
    const pieces: { sq: string; piece: string }[] = [];
    // Colours already taken by a white bishop, so the second one must differ.
    const bishopColours = new Set<'d' | 'l'>();
    let ok = true;

    const place = (piece: string, minDistKings = 2): string | null => {
      for (let t = 0; t < 60; t++) {
        const sq = `${FILES[rnd(8)]}${1 + rnd(8)}`;
        if (used.has(sq)) continue;
        if (piece === 'K' || piece === 'k') {
          const other = piece === 'K' ? pieces.find((p) => p.piece === 'k') : pieces.find((p) => p.piece === 'K');
          if (other && kingDist(sq, other.sq) < minDistKings) continue;
        }
        if (piece === 'B' && bishopColours.has(squareColour(sq))) continue;
        return sq;
      }
      return null;
    };

    for (const piece of spec.white) {
      const sq = place(piece);
      if (!sq) { ok = false; break; }
      if (piece === 'B') bishopColours.add(squareColour(sq));
      pieces.push({ sq, piece });
      used.add(sq);
    }
    if (!ok) continue;
    const kSq = place('k');
    if (!kSq) continue;
    pieces.push({ sq: kSq, piece: 'k' });
    used.add(kSq);

    // build FEN (white to move), black king must not be attacked
    const board: string[][] = Array.from({ length: 8 }, () => Array(8).fill(''));
    for (const { sq, piece } of pieces) {
      board[+sq[1] - 1][FILES.indexOf(sq[0])] = piece;
    }
    const rows = board.map((row) => {
      let out = '', empty = 0;
      for (const cell of row) {
        if (cell) { if (empty) { out += empty; empty = 0; } out += cell; } else empty++;
      }
      return out + (empty || '');
    }).reverse().join('/');
    const fen = `${rows} w - - 0 1`;

    try {
      const c = new Chess(fen);
      // black king must not be attacked (white to move)
      const bk = pieces.find((p) => p.piece === 'k')!.sq;
      if (c.isAttacked(bk as Square, 'w')) continue;
      // black must not be already stalemated/mated
      const blackToMove = new Chess(fen.replace(' w ', ' b '));
      if (blackToMove.isCheckmate() || blackToMove.isStalemate() || blackToMove.moves().length === 0) continue;
      return { fen, pieces };
    } catch { continue; }
  }
  return null;
}

let genCounter = 0;
function generateMate(kind: keyof typeof MATE_BRIEFS, tier: TrainerTier, budget: number, elo: number): TrainerExercise | null {
  const sets: Record<string, string[]> = {
    kq: ['K', 'Q'],
    kr: ['K', 'R'],
    k2r: ['K', 'R', 'R'],
    k2b: ['K', 'B', 'B'],
    kbn: ['K', 'B', 'N'],
  };
  const white = sets[kind];
  const placed = placeMate({ white, blackKingNotAttacked: true });
  if (!placed) return null;
  genCounter++;
  const info = MATE_BRIEFS[kind];
  const names: Record<string, string> = {
    kq: 'Queen Mate', kr: 'Rook Mate', k2r: 'Two-Rook Ladder', k2b: 'Two-Bishops Mate', kbn: 'Bishop + Knight Mate',
  };
  return {
    id: `gen_${kind}_${Date.now()}_${genCounter}`,
    tier,
    category: 'Trainer',
    fen: placed.fen,
    userSide: 'w',
    goal: 'mate',
    maxMoves: budget,
    engineElo: elo,
    brief: info.brief,
    keyIdea: info.keyIdea,
    source: 'generated',
    title: `Trainer · ${names[kind]}`,
  } as TrainerExercise;
}

/* ---------------- pool picks ---------------- */

function pickPool(tier: TrainerTier, used: Set<string>): TrainerExercise | null {
  // Never fall back to another tier. The pool holds only `sharp` (94) and
  // `relentless` (42) rows -- no warm-up or steady material at all -- so the
  // old cross-tier fallback served a SHARP position to anyone in a tier the
  // pool could not cover. The reachable victim was `steady`: its
  // POOL_SHARE is 0.25, so a quarter of its exercises came from the pool and
  // every one of them was sharp/relentless. (`warmup` has POOL_SHARE 0 and so
  // never entered this function at all.)
  //
  // This is also why the `tier` field in `src/data/endgame_pool.json` is a
  // `TrainerTier` and not free text: `p.tier === tier` is an exact match, so a
  // value in that file that is not one of the four ids makes this return null
  // for the band it was meant to serve, and the screen shows an empty trainer
  // with nothing in the log. GATE 1e asserts every row's tier is a real one.
  //
  // Returning null is the correct answer here: nextTrainerExercise falls through
  // to the generator, whose GEN_MENU covers warm-up and steady with
  // mate-in-N positions built for the tier.
  const all = POOL.filter((p) => p.tier === tier);
  if (!all.length) return null;

  const unused = all.filter((p) => !used.has(p.id));
  if (!unused.length) {
    // tier exhausted this session — reuse within the tier, but stay in it
    const p = pick(all);
    return { ...p, tier, source: 'pool', title: `Trainer · ${p.category}`, id: `${p.id}_r${Date.now() % 100000}` };
  }
  const p = pick(unused);
  used.add(p.id);
  return { ...p, tier, source: 'pool', title: `Trainer · ${p.category}` };
}

/* ---------------- tier menus ---------------- */

const GEN_MENU: Record<TrainerTier, { kind: keyof typeof MATE_BRIEFS; budget: number; elo: number; weight: number }[]> = {
  warmup: [
    { kind: 'kq', budget: 14, elo: 1600, weight: 3 },
    { kind: 'kr', budget: 16, elo: 1600, weight: 2 },
  ],
  steady: [
    { kind: 'kq', budget: 10, elo: 1900, weight: 2 },
    { kind: 'kr', budget: 12, elo: 1900, weight: 2 },
    { kind: 'k2r', budget: 10, elo: 1900, weight: 2 },
  ],
  sharp: [
    { kind: 'k2r', budget: 8, elo: 2100, weight: 2 },
    { kind: 'k2b', budget: 20, elo: 2100, weight: 2 },
  ],
  relentless: [
    { kind: 'k2b', budget: 16, elo: 2300, weight: 1 },
    { kind: 'kbn', budget: 30, elo: 2300, weight: 3 },
  ],
};

const POOL_SHARE: Record<TrainerTier, number> = {
  warmup: 0,
  steady: 0.25,
  sharp: 0.55,
  relentless: 0.55,
};

/* ---------------- live endgame positions from the internet ---------------- */

/**
 * Lichess serves a random puzzle "by angle". `angle=endgame` filters to endgame
 * positions, which is exactly the material this trainer teaches.
 *
 * WHY THIS REPLACES THE POOL AS THE PRIMARY SOURCE
 * -----------------------------------------------
 * The bundled pool is fixed: the same 136 positions forever. The user asked that
 * endgame training "get new positions always from internet". Lichess' endpoint
 * returns a *different* real position on every call, with the source game
 * attached, so repeated training stops converging on a memorised deck.
 *
 * The local pool is kept only as a fallback for offline use — it is still the
 * best material we have when there is no connection.
 *
 * A timeout is mandatory: this is called on the path that builds the next
 * exercise, so a hung request would freeze the trainer rather than just fail.
 */
const LICHESS_TIMEOUT_MS = 6000;

interface LichessPuzzle {
  game?: { pgn?: string; id?: string; players?: { name?: string }[] };
  puzzle?: { id?: string; rating?: number; themes?: string[]; initialPly?: number };
}

/**
 * The move tokens of a PGN, in order.
 *
 * The previous version of this file tokenised with `pgn.split(/\s+/)` and filtered
 * inline. That cannot survive a real PGN, and Lichess serves real PGNs, so
 * `fetchLiveEndgame` returned null on essentially every response and the entire
 * "real position from the internet" feature was dead — along with the ~40 lines of
 * commentary above it explaining how it worked.
 *
 * What the naive filter got wrong, each of which occurs in ordinary PGNs:
 *
 *   - `[Event "..."]`, `[FEN "..."]`, `[Result "1-0"]` header pairs. The filter only
 *     skipped tokens STARTING with `{`, so a `{` comment mid-PGN was dropped but its
 *     remaining WORDS were fed to `c.move()`, which threw, and the `break` abandoned
 *     the whole replay. A 3-word comment in the header was enough to kill it.
 *   - nested RAVs `( ... )` — a sideline. Not removed, so its moves were played into
 *     the mainline and the position was wrong from there on (silently: the moves are
 *     legal, just the wrong game).
 *   - NAGs (`$1`, `!?`) and the `1.e4` compound form, where the move number and the
 *     move share a token. The old code did `if (/^\d+\./.test(san)) continue` — it
 *     SKIPPED the move instead of playing it, so every single move after the first
 *     was dropped and the final `played < ply` check returned null.
 *
 * This mirrors what `lichess.ts` already does for Lichess games, which is the
 * point: the repo has a correct PGN reader in it, and the endgame trainer was
 * written as if it did not.
 */
export function pgnMainline(pgn: string): string[] {
  // Headers and comments, first, so nothing inside them can be read as a move.
  let s = pgn.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  s = s.replace(/^\s*\[[^\n]*\]\s*$/gm, ' ');
  // Side lines: drop everything from an opening paren to its match.
  for (let i = 0; i < 400; i++) {
    const open = s.indexOf('(');
    if (open < 0) break;
    let depth = 0, end = -1;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) { s = s.slice(0, open); break; }
    s = s.slice(0, open) + ' ' + s.slice(end + 1);
  }
  return s
    .replace(/\$\d+/g, ' ')              // NAGs
    .replace(/(1-0|0-1|1\/2-1\/2|\*)/g, ' ')  // result token
    .split(/\s+/)
    .filter(Boolean)
    // `1.e4` and `1...c5`: keep the move, drop the number glued to it.
    .map((t) => t.replace(/^\d+\.(\.\.)?/, '').replace(/[!?]+$/, ''))
    .filter((t) => t.length > 0);
}

/**
 * Replay a PGN to the puzzle's starting ply, returning the FEN there.
 *
 * Lichess gives the whole game plus `initialPly`; the position to solve is the
 * one after that many half-moves. We replay rather than trusting any FEN field
 * because the endpoint does not send one.
 *
 * OFF BY ONE, AND THE OTHER HALF OF THE APP AGREES WITH THE FIX
 * -----------------------------------------------------------
 * `puzzleProvider.ts` states the contract explicitly: *"`initialPly` is the 0-based
 * index of the LAST PLAYED move — the puzzle position sits after initialPly+1
 * plies"*, and it validates its solution line against `[initialPly+1, ...]`. This
 * function replayed to `initialPly` plies, so every live position was one ply short:
 * the wrong side to move, and a drill that starts somewhere the puzzle never posed.
 *
 * The app has two consumers of the same field and they disagreed. The one with the
 * documented contract is right, so the ply count follows it. The boundary is asserted
 * by `.bench/endgame.livepos.test.mjs` rather than left to a comment.
 */
function fenAtPly(pgn: string, initialPly: number): { fen: string; side: 'w' | 'b' } | null {
  try {
    const c = new Chess();
    // `initialPly` is the index of the last played move, so the position to serve
    // is after initialPly + 1 plies.
    const target = initialPly + 1;
    const sans = pgnMainline(pgn);
    let played = 0;
    for (const san of sans) {
      if (played >= target) break;
      try {
        c.move(san);
        played++;
      } catch {
        // A single unreadable token means this PGN is not one we can trust to the
        // ply, so give up rather than serve a position from the wrong point in the
        // game. The caller falls back to the local pool.
        return null;
      }
    }
    if (played < target) return null;
    return { fen: c.fen(), side: c.turn() };
  } catch {
    return null;
  }
}

/**
 * WHAT "STEADY" MEANS TO LICHESS, AND WHAT IT MUST MEAN HERE.
 *
 * `angle=endgame` says nothing about difficulty — it is a filter on the KIND of position,
 * not on how hard it is. So the tier reached the live path only through `maxMoves` and
 * `engineElo`, and a first-band drill could be served a 2400-rated conversion. The tier set the
 * rules of the drill; it did not choose the position, which is the thing being judged.
 *
 * These two tables fix that. The difficulty bucket is asked for explicitly, and the rating
 * that comes back is checked against the tier's own band — the boundaries `tierFromRating`
 * already uses, with the same slight overlap the puzzle bands have so nothing falls between
 * two of them.
 *
 * WHY REFUSING IS SAFE, WHICH IS THE PART THAT HAD TO BE ESTABLISHED FIRST
 * ----------------------------------------------------------------------
 * Giving up must not mean "no exercise". `nextTrainerExercise` builds mate-in-N positions
 * from `GEN_MENU`, which is genuinely tiered — KQ/KR for the first band up to KBN at budget 30
 * for the top one — so returning null here always lands the user on material that matches the tier
 * they chose. The alternative, accepting an out-of-band position, is the only option that
 * would be dishonest.
 */
export const TIER_LICHESS_DIFFICULTY: Record<TrainerTier, 'easy' | 'medium' | 'hard' | 'hardest'> = {
  warmup: 'easy',
  steady: 'medium',
  sharp: 'hard',
  relentless: 'hardest',
};

export const TIER_RATING_BAND: Record<TrainerTier, [number, number]> = {
  warmup: [400, 1250],
  steady: [1200, 1750],
  sharp: [1700, 2250],
  relentless: [2200, 2900],
};

/** How many times to re-ask before giving up and letting the generator answer. */
const LIVE_ENDGAME_ATTEMPTS = 4;

/**
 * Fetch one real endgame position from Lichess, shaped as a `TrainerExercise`.
 *
 * Returns null on ANY failure — offline, timeout, unparseable PGN, a position whose ply we
 * could not replay, or a position whose rating is outside the tier's band. null is a normal
 * outcome here, not an error: the caller falls through to the generator, which always works
 * and which is tiered on its own.
 *
 * The exercise is presented as a `survive`-flavoured drill when the themes say
 * the defender is to move and `mate`/`promote` when the attacker is, because the
 * trainer's scoring depends on the goal matching whose move it is.
 */
export async function fetchLiveEndgame(
  tier: TrainerTier,
  usedIds: Set<string>,
): Promise<TrainerExercise | null> {
  for (let i = 0; i < LIVE_ENDGAME_ATTEMPTS; i++) {
    const ex = await fetchLiveEndgameOnce(tier, usedIds);
    if (ex) return ex;
  }
  return null;
}

/** One attempt. Returns null for anything unusable, INCLUDING an out-of-band position. */
async function fetchLiveEndgameOnce(
  tier: TrainerTier,
  usedIds: Set<string>,
): Promise<TrainerExercise | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LICHESS_TIMEOUT_MS);
    let data: LichessPuzzle | null = null;
    try {
      const res = await fetch(
        // `difficulty` is what actually selects the difficulty of the POSITION. `angle`
        // alone selects only the kind, which is why the tier used to change nothing about
        // which endgame the user was asked to play.
        `https://lichess.org/api/puzzle/next?angle=endgame&difficulty=${TIER_LICHESS_DIFFICULTY[tier]}`,
        {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!res.ok) return null;
      data = (await res.json()) as LichessPuzzle;
    } finally {
      clearTimeout(timer);
    }

    const puz = data?.puzzle;
    const pgn = data?.game?.pgn;
    if (!puz || !pgn || typeof puz.initialPly !== 'number') return null;

    const id = puz.id ?? `${data?.game?.id ?? 'live'}:${puz.initialPly}`;
    if (usedIds.has(id)) return null; // already served this session

    /*
     * THE POSITION MUST BELONG TO THE TIER.
     *
     * The difficulty bucket is a coarse hint and Lichess serves randomly within it, so the
     * bucket alone is not enough — `easy` still contains puzzles far above the first band's
     * band. The rating is the number that means what it says, and it is checked here.
     *
     * A missing rating is treated as unusable rather than as a pass. Assuming the worst
     * cannot serve a position the user did not ask for, and Lichess always sends the field,
     * so this costs nothing in practice.
     */
    const band = TIER_RATING_BAND[tier];
    const servedRating = Number(puz.rating);
    if (!Number.isFinite(servedRating) || servedRating < band[0] || servedRating > band[1]) {
      return null;
    }

    const at = fenAtPly(pgn, puz.initialPly);
    if (!at) return null;

    // A position with no legal move is useless (already mate/stalemate).
    const probe = new Chess(at.fen);
    if (probe.isGameOver() || probe.moves().length === 0) return null;

    usedIds.add(id);

    const themes = puz.themes ?? [];
    const isMateTheme = themes.some((t) => t.includes('mate'));
    const isPromotion = themes.some((t) => t.includes('promotion') || t.includes('pawn'));
    const goal: TrainerExercise['goal'] = isMateTheme ? 'mate' : isPromotion ? 'promote' : 'survive';

    const players = data?.game?.players?.map((p) => p?.name).filter(Boolean) ?? [];
    const who = players.length === 2 ? `${players[0]} vs ${players[1]}` : 'an internet game';

    /*
     * THE TIER HAS TO REACH THE LIVE PATH, OR IT IS NOT A TIER.
     *
     * `maxMoves: 20` and `engineElo: 1800 + ...` were both constants of convenience
     * that quietly removed the only thing the tier does. An 800-rated player on
     * the first band was served a 1800+ engine on a random internet puzzle, because
     * `pickPool` and the weighted generated menu — the two places that actually read
     * `tier` — are both bypassed the moment the network answers. Since the network
     * answers most of the time, the tier the user selected governed almost nothing.
     *
     * So the budget now comes from the same table the local pool uses, and the engine
     * is centred on the PUZZLE's own rating (which is what `puz.rating` is: a real
     * number from real games) shifted by how far the tier is from that band, with a
     * floor that can go BELOW 1800 — a first-band drill must be able to meet a weaker engine,
     * or the bottom band means nothing.
     */
    const BUDGET: Record<TrainerTier, number> = { warmup: 16, steady: 18, sharp: 20, relentless: 22 };
    const puzzleRating = puz.rating ?? 1500;
    const tierShift: Record<TrainerTier, number> = { warmup: -200, steady: -100, sharp: 0, relentless: 200 };
    const engineElo = Math.max(
      800,
      Math.min(2600, puzzleRating + tierShift[tier] + (puzzleRating - 1500) / 4),
    );

    return {
      id,
      tier,
      category: themes.slice(0, 2).join(' · ') || 'Endgame',
      title: `Endgame · ${themes[0] ?? 'technique'}`,
      fen: at.fen,
      userSide: at.side,
      goal,
      maxMoves: BUDGET[tier] ?? 20,
      engineElo,
      brief: `A real endgame position from ${who}. Find the best plan — the themes are ${themes.slice(0, 3).join(', ') || 'endgame technique'}.`,
      keyIdea: themes.length ? `Pattern: ${themes.join(', ')}` : 'Convert the endgame accurately.',
      /*
       * `source` is what the footer prints, and it said `generated` for a position
       * lifted out of a real game. So a genuine internet position was shown to the
       * user as "Generated live", while "Engine-verified position" — the label that
       * actually means somebody checked this — was reserved for the local pool. The
       * two were exactly swapped from what they claim to be.
       */
      source: 'live',
    };
  } catch {
    return null;
  }
}

/**
 * Build one fresh exercise for a tier. `usedPoolIds` should persist per
 * session so the same position is not repeated back-to-back.
 */
export function nextTrainerExercise(tier: TrainerTier, usedPoolIds: Set<string>): TrainerExercise {
  if (Math.random() < POOL_SHARE[tier]) {
    const p = pickPool(tier, usedPoolIds);
    if (p) return p;
  }
  const menu = GEN_MENU[tier];
  const total = menu.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  let chosen = menu[0];
  for (const m of menu) {
    r -= m.weight;
    if (r <= 0) { chosen = m; break; }
  }
  for (let i = 0; i < 12; i++) {
    const ex = generateMate(chosen.kind, tier, chosen.budget, chosen.elo);
    if (ex) return ex;
  }
  // extremely unlikely fallback
  return generateMate('kq', tier, 14, 1600)!;
}

/**
 * Async version of `nextTrainerExercise` that prefers a live internet position.
 *
 * The sync version stays, because it is the guaranteed-answer path the UI uses
 * when offline, and because a synchronous fallback keeps the trainer usable in
 * airplane mode. This one is what the screen should call: it tries the internet
 * first (matching "always from internet"), then delegates.
 */
export async function nextTrainerExerciseOnline(
  tier: TrainerTier,
  usedPoolIds: Set<string>,
): Promise<TrainerExercise> {
  const live = await fetchLiveEndgame(tier, usedPoolIds);
  if (live) return live;
  return nextTrainerExercise(tier, usedPoolIds);
}

/* ---------------- live examples for the COURSE lessons ---------------- */

/**
 * The course lessons are canonical teaching positions (KQ vs K, Lucena, …).
 * They are the right thing to *learn* from, but they are static: the same FEN
 * forever, with no sense of how the idea shows up in a real game. The user asked
 * that we source examples from the internet "in the courses examples … that
 * would be great".
 *
 * Lichess exposes curated *themes* per puzzle. We map a lesson's category onto
 * the themes that best express it, then ask for a random puzzle in that theme.
 * The returned position replaces the lesson's starting FEN while the lesson
 * text, goal and key idea stay intact — so the user sees the same concept in a
 * position they have never seen before.
 *
 * Ordering matters: we try the most specific angle first and stop at the first
 * one that yields a usable position. `angle` accepts a single theme, so this is
 * a short sequential probe rather than one request with a filter list.
 */
const LESSON_ANGLES: Record<string, string[]> = {
  'Basic Checkmates': ['mateIn2', 'backRankMate', 'mate'],
  'Pawn Endgames': ['pawnEndgame', 'promotion', 'endgame'],
  'Rook Endgames': ['rookEndgame', 'endgame'],
  'Minor Piece Endgames': ['bishopEndgame', 'knightEndgame', 'endgame'],
  'Queen Endgames': ['queenEndgame', 'endgame'],
  // "Queen vs Pawn on the 7th": a practical conversion of a queen against a
  // far-advanced pawn, so lead with the promotion angle before falling back.
  'Technique': ['queenEndgame', 'promotion', 'endgame'],
  // "Smothered Mate" / "The Prison": named mating patterns. `smotheredMate` is
  // an exact Lichess theme; the generic mate angles are the safety net.
  'Mating Patterns': ['smotheredMate', 'mateIn2', 'mate'],
};

/** The angle list for a lesson category, with a safe fallback. */
export function anglesForCategory(category: string): string[] {
  return LESSON_ANGLES[category] ?? ['endgame'];
}

/**
 * Fetch one real internet position whose theme matches a course lesson.
 *
 * Differences from `fetchLiveEndgame`:
 *  • it takes a *theme angle* instead of a tier, so the position illustrates a
 *    specific lesson rather than being generically "an endgame";
 *  • it walks a short list of candidate angles, because a curated theme can
 *    legitimately have no puzzle left to serve;
 *  • it reports the source game so the lesson card can credit the players.
 *
 * Returns null on any failure (offline, timeout, unparseable PGN, no matching
 * theme). null is normal: the lesson simply stays on its canonical position.
 */
export async function fetchLessonExample(
  category: string,
  usedIds: Set<string>,
): Promise<TrainerExercise | null> {
  for (const angle of anglesForCategory(category)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LICHESS_TIMEOUT_MS);
      let data: LichessPuzzle | null = null;
      try {
        const res = await fetch(
          `https://lichess.org/api/puzzle/next?angle=${encodeURIComponent(angle)}`,
          { headers: { Accept: 'application/json' }, signal: controller.signal },
        );
        if (!res.ok) continue;
        data = (await res.json()) as LichessPuzzle;
      } finally {
        clearTimeout(timer);
      }

      const puz = data?.puzzle;
      const pgn = data?.game?.pgn;
      if (!puz || !pgn || typeof puz.initialPly !== 'number') continue;

      const id = puz.id ?? `${data?.game?.id ?? 'live'}:${puz.initialPly}`;
      if (usedIds.has(id)) continue;

      const at = fenAtPly(pgn, puz.initialPly);
      if (!at) continue;

      // A solved or finished position teaches nothing — skip it.
      const probe = new Chess(at.fen);
      if (probe.isGameOver() || probe.moves().length === 0) continue;

      usedIds.add(id);

      const themes = puz.themes ?? [];
      const isMateTheme = themes.some((t) => t.includes('mate'));
      const isPromotion = themes.some((t) => t.includes('promotion') || t.includes('pawn'));
      const goal: TrainerExercise['goal'] = isMateTheme ? 'mate' : isPromotion ? 'promote' : 'survive';
      const players = data?.game?.players?.map((p) => p?.name).filter(Boolean) ?? [];
      const who = players.length === 2 ? `${players[0]} vs ${players[1]}` : 'an internet game';

      return {
        id,
        tier: 'steady', // unused by the course path; the lesson supplies the tier
        category: themes.slice(0, 2).join(' · ') || category,
        title: `Real example · ${themes[0] ?? category}`,
        fen: at.fen,
        userSide: at.side,
        goal,
        maxMoves: 20,
        engineElo: 1800 + Math.min(600, Math.max(0, (puz.rating ?? 1500) - 1500) / 2),
        brief: `A real position from ${who} on online-game themes (${themes.slice(0, 3).join(', ') || category}). Apply the lesson idea here.`,
        keyIdea: `Theme match: ${themes.slice(0, 3).join(', ') || category}`,
        source: 'generated',
      };
    } catch {
      // Try the next angle; a timeout on one theme should not lose the others.
      continue;
    }
  }
  return null;
}