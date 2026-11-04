'use client';

/**
 * MINED PUZZLES ARE LINES, NOT SINGLE MOVES.
 *
 * The first version of "From your games" stored one engine move per position: the user saw the
 * move they played, the move they should have played, and the puzzle ended. The report was exact:
 * *"the puzzles from the user games in our app dont seem like they are puzzle, but just a mistake
 * and what to play instead and that's it."*
 *
 * A Lichess puzzle is a forced sequence. The solver finds a move, the opponent answers with the
 * best defence, and the solver has to find the follow-up. The sequence is only a puzzle because
 * the opponent's replies are not chosen by the app to be convenient - they are the engine's best
 * defence - and because each solver move is checked to be the move that works, not merely one of
 * several good moves.
 *
 * This module is the pure part of that idea: replay a principal variation into a legal line, trim
 * it to the solver's turns, and (with an injected analyser) verify the later solver moves are
 * unique. The engine and the game-scan budget stay in `gameScan.ts`; nothing here touches React
 * Native or the engine WebView, so the line rules can be tested with a fake analyser.
 */

import { Chess } from 'chess.js';

/** One move of a mined solution, in both notations the app needs. */
export interface PuzzleMove {
  /** UCI, so the screen can compare a played move without re-rendering SAN. */
  uci: string;
  /** SAN in the position before the move, for hints and the move list. */
  san: string;
}

/** A replayed move also knows the position it produced. */
export interface ReplayedPuzzleMove extends PuzzleMove {
  fenAfter: string;
}

/**
 * The smallest line that is still a puzzle rather than a one-move quiz.
 *
 * Three plies is solver, opponent, solver: one reply to read, one follow-up to find. A one-move
 * answer is the thing the user complained about, so it is not a mined puzzle at all.
 */
export const MIN_PUZZLE_PLIES = 3;

/**
 * The longest line the on-device miner will keep.
 *
 * Five plies is three solver moves and two opponent replies. It is long enough to feel like a
 * combination, and short enough that a depth-12 scan does not turn one position into a tournament.
 * The screen can play any length; this is a mining budget, not a UI limit.
 */
export const MAX_PUZZLE_PLIES = 5;

/**
 * Replay a UCI principal variation from `fen`.
 *
 * Stops at the first illegal or unrenderable move instead of throwing, because a truncated PV is
 * normal at a fixed depth and a partly usable line is still useful. The caller decides whether
 * the legal prefix is long enough to be a puzzle.
 */
export function replayPuzzlePv(
  fen: string,
  pvUci: readonly string[],
  maxPlies: number = MAX_PUZZLE_PLIES,
): ReplayedPuzzleMove[] {
  const board = new Chess(fen);
  const out: ReplayedPuzzleMove[] = [];
  const limit = Math.max(0, Math.min(maxPlies, pvUci.length));
  for (let i = 0; i < limit; i += 1) {
    const uci = pvUci[i];
    if (!uci || uci.length < 4) break;
    try {
      const move = board.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) break;
      out.push({
        uci: move.from + move.to + (move.promotion ?? ''),
        san: move.san,
        fenAfter: board.fen(),
      });
    } catch {
      break;
    }
  }
  return out;
}

/** Trim a replayed line to an odd number of plies and reject anything shorter than a puzzle. */
function trimToPuzzle(line: readonly ReplayedPuzzleMove[]): ReplayedPuzzleMove[] {
  const plies = line.length % 2 === 0 ? line.length - 1 : line.length;
  return plies >= MIN_PUZZLE_PLIES ? line.slice(0, plies) : [];
}

/**
 * The line a PV describes, if it is a puzzle.
 *
 * Odd plies only: the solver starts and finishes. A PV that ends on the opponent's reply is not a
 * complete question, so the trailing reply is dropped; if that leaves fewer than three plies there
 * is no puzzle.
 */
export function buildPuzzleSolution(
  fen: string,
  pvUci: readonly string[],
  maxPlies: number = MAX_PUZZLE_PLIES,
): PuzzleMove[] {
  return trimToPuzzle(replayPuzzlePv(fen, pvUci, maxPlies)).map(({ uci, san }) => ({ uci, san }));
}

/**
 * The minimum engine report this module needs.
 *
 * Deliberately structural rather than imported from `engine.ts`: the line rules are pure and must
 * stay testable without the React Native engine wrapper, and `EngineEval` is assignable to this.
 */
export interface PuzzleEngineEval {
  bestMoveUci: string | null;
  scoreCp: number | null;
  mateIn: number | null;
  lines?: {
    uci: string;
    scoreCp: number | null;
    mateIn: number | null;
    pvUci: string[];
  }[];
}

/** Fold a mate score onto the centipawn scale used by the rest of the scan. */
function cpOf(e: { scoreCp: number | null; mateIn: number | null }): number | null {
  if (e.mateIn != null) {
    const magnitude = 10000 - Math.min(e.mateIn, 60) * 100;
    return e.mateIn > 0 ? magnitude : -magnitude;
  }
  return e.scoreCp;
}

/** Gap between the best and second MultiPV lines, or null when there is no second line. */
function gapBetween(
  best: { scoreCp: number | null; mateIn: number | null } | null,
  second: { scoreCp: number | null; mateIn: number | null } | null,
): number | null {
  if (!best || !second) return null;
  const a = cpOf(best);
  const b = cpOf(second);
  if (a == null || b == null) return null;
  return a - b;
}

export interface CookMinedLineOptions {
  /**
   * The gap between the first move and its runner-up, measured by the caller's initial search.
   * The first move is the position's whole question, so it must already be the only move.
   */
  firstGap: number | undefined;
  /** A later solver move must clear this gap too. Same evidence, same scale. */
  onlyMoveGap?: number;
  maxPlies?: number;
  /** Polled between engine searches so a cancelled scan stops cleanly. */
  isCancelled?: () => boolean;
}

/**
 * Turn a principal variation into a verified forced line.
 *
 * The first move is checked by the caller (it already has the MultiPV gap from the search that
 * found the position). Every later solver move is re-analysed with MultiPV 2 and must be the
 * engine's best move with the same kind of gap. If a later move fails, the line is trimmed back to
 * the previous solver turn; if the FIRST follow-up fails, there is no multi-move puzzle and the
 * position is rejected.
 *
 * Opponent moves are not re-analysed here: they are the PV's best defence, which is exactly what
 * the opponent should play in a puzzle. Re-analysing them would cost another search without
 * changing the question being asked of the solver.
 */
export async function cookMinedLine(
  fen: string,
  pvUci: readonly string[],
  bestUci: string,
  analyse: (fen: string) => Promise<PuzzleEngineEval>,
  opts: CookMinedLineOptions,
): Promise<PuzzleMove[]> {
  const onlyMoveGap = opts.onlyMoveGap ?? 150;
  const maxPlies = opts.maxPlies ?? MAX_PUZZLE_PLIES;
  const isCancelled = opts.isCancelled ?? (() => false);

  if (opts.firstGap == null || opts.firstGap < onlyMoveGap) return [];

  const replayed = replayPuzzlePv(fen, pvUci, maxPlies);
  if (replayed.length < MIN_PUZZLE_PLIES) return [];
  // The PV must actually start with the move the caller is asking the user to find. A mismatch
  // means the report and the line describe different searches; the puzzle would show one answer
  // and accept another.
  if (replayed[0].uci !== bestUci) return [];

  let plies = replayed.length % 2 === 0 ? replayed.length - 1 : replayed.length;
  if (plies < MIN_PUZZLE_PLIES) return [];

  for (let i = 2; i < plies; i += 2) {
    const before = replayed[i - 1].fenAfter;
    const report = await analyse(before);
    if (isCancelled()) return [];

    const legalBest = report.bestMoveUci === replayed[i].uci;
    const gap = gapBetween(report.lines?.[0] ?? report, report.lines?.[1] ?? null);
    if (!legalBest || gap == null || gap < onlyMoveGap) {
      /*
       * A failed second solver move leaves no multi-move puzzle at all. A failed later move
       * leaves the shorter line that ended on the previous solver turn - which was already
       * verified, so it is still a complete puzzle.
       */
      if (i === 2) return [];
      plies = i - 1;
      break;
    }
  }

  return replayed.slice(0, plies).map(({ uci, san }) => ({ uci, san }));
}

/**
 * The solution the screen should play.
 *
 * Old decks stored only `bestUci` / `bestSan`. They are returned as a one-move line so the data
 * still reads, but `isMinedPuzzlePlayable` rejects them: the UI retires them rather than showing
 * the one-move quiz the user complained about. New mined records carry `solution`.
 */
export function puzzleSolution(p: {
  solution?: readonly PuzzleMove[];
  bestUci?: string;
  bestSan?: string;
}): PuzzleMove[] {
  if (p.solution && p.solution.length > 0) return [...p.solution];
  if (p.bestUci && p.bestSan) return [{ uci: p.bestUci, san: p.bestSan }];
  return [];
}

/** True when this record is a real multi-move puzzle, not a legacy one-move position. */
export function isMinedPuzzlePlayable(p: {
  solution?: readonly PuzzleMove[];
  bestUci?: string;
  bestSan?: string;
}): boolean {
  const line = puzzleSolution(p);
  return line.length >= MIN_PUZZLE_PLIES && line.length % 2 === 1;
}
