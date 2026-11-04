/**
 * The coach as an opponent.
 *
 * A built bot plays like a real player (the mimic in `mimic.ts`). The coach bot
 * is deliberately simpler: Stockfish itself, strength-limited to the level the
 * user picked, so "play the coach at 1600" means exactly one thing and the
 * opponent cannot drift from it. The coaching layer — hints, position
 * explanations, chess-only chat — is the `coach/` runtime, not this file.
 *
 * The engine's UCI_Elo floor is 1320 (the host clamps to it), so the levels
 * start at 1400 rather than pretending a 600 is available and silently playing
 * at 1320. Every level here is real, not a label over the same opponent.
 */

import { Chess } from 'chess.js';
import type { Move, PieceSymbol } from 'chess.js';

import { BOT_MOVE_MOVETIME_MS, linesFromEval } from './play';
import type { BotAnalyse, BotMoveResult } from './play';
import type { BotProfile, MoveTypeStats, PhaseRates } from './types';

export interface CoachLevel {
  elo: number;
  label: string;
}

/** The pickable strengths, weakest first. All inside the engine's support. */
export const COACH_LEVELS: readonly CoachLevel[] = [
  { elo: 1400, label: 'Beginner' },
  { elo: 1600, label: 'Improver' },
  { elo: 1800, label: 'Club' },
  { elo: 2000, label: 'Strong club' },
  { elo: 2200, label: 'Expert' },
  { elo: 2400, label: 'Master' },
  { elo: 2600, label: 'Grandmaster' },
  { elo: 2800, label: 'Maximum' },
] as const;

export const DEFAULT_COACH_ELO = COACH_LEVELS[0].elo;

/** The id this opponent travels through the shell under (never a stored bot). */
export const COACH_BOT_ID = 'coach';

const PIECE_NAME: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

function emptyStats(): MoveTypeStats {
  return {
    total: 0,
    capture: 0,
    check: 0,
    castle: 0,
    centralPawn: 0,
    develop: 0,
    sac: 0,
    byPiece: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
}

function emptyRates(): PhaseRates {
  return { opening: emptyStats(), middle: emptyStats(), end: emptyStats() };
}

/**
 * A complete `BotProfile` for the play screen, which was written around stored
 * profiles. The parts a real profile carries (book, fingerprints, record) are
 * empty on purpose: this opponent is defined by its engine level alone.
 */
export function coachProfile(elo: number): BotProfile {
  return {
    id: COACH_BOT_ID,
    name: 'Coach',
    source: 'coach',
    meta: { name: 'Coach', key: COACH_BOT_ID, source: 'coach' },
    recipe: { kind: 'coach', query: COACH_BOT_ID, games: 0, timeClass: 'rapid' },
    gamesAnalyzed: 0,
    rating: elo,
    ratingLabel: 'Coach level',
    wins: 0,
    draws: 0,
    losses: 0,
    openings: [],
    style: { aggression: 50, kingSafety: 50, pieceActivity: 50, endgame: 50, castlePly: null, avgGameLength: 0 },
    book: {},
    typeRates: emptyRates(),
    firstMoves: [],
    repliesToE4: [],
    repliesToD4: [],
    timeControlMix: [],
    dateRange: {},
    fetchedAt: '1970-01-01T00:00:00.000Z',
    createdAt: 0,
  };
}

/** The sentence under the board. It describes the move, never an invented plan. */
export function coachMoveReason(mv: Move, elo: number): string {
  if (mv.san.includes('#')) return 'delivers mate';
  if (mv.captured) return `takes the ${PIECE_NAME[mv.captured]} — material first`;
  if (mv.promotion) return `promotes to a ${PIECE_NAME[mv.promotion]}`;
  if (mv.san.startsWith('O-O')) return 'castles the king to safety';
  if (mv.san.includes('+')) return 'checks the king and gains a tempo';
  return `the strongest move the engine sees at level ${elo}`;
}

/**
 * One coach move: the engine's best move with strength limiting on.
 *
 * MultiPV stays at 1 because the coach plays one line, unlike the mimic which
 * needs alternatives to imitate a person. `uci` is converted on a throwaway
 * board, so the caller can show SAN and the move log stays in sync even if the
 * engine ever answers with a promotion the UI did not ask about.
 */
export async function coachMoveFor(
  analyse: BotAnalyse,
  fen: string,
  elo: number,
  opts: { movetime?: number } = {},
): Promise<BotMoveResult | null> {
  const ev = await analyse(fen, {
    movetime: opts.movetime ?? BOT_MOVE_MOVETIME_MS,
    elo,
    multipv: 1,
  });
  const uci = ev.bestMoveUci;
  if (!uci || uci.length < 4) return null;

  let mv: Move;
  try {
    const board = new Chess(fen);
    mv = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }

  return {
    decision: {
      uci,
      san: mv.san,
      reason: coachMoveReason(mv, elo),
      scores: { e: 1, h: 1, p: 0, s: 1 },
      engineRank: 1,
    },
    lines: linesFromEval(ev),
    depth: ev.depth,
    evalTop: { scoreCp: ev.scoreCp ?? null, mateIn: ev.mateIn ?? null },
  };
}
