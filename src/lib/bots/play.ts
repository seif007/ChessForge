/**
 * The bridge between the opponent's move choice and this app's engine.
 *
 * `selectMove` wants a small list of engine lines; `getEngine().analyse` returns
 * this app's `EngineEval`. The two are translated here, in one place, so the
 * play screen only has to draw the board.
 *
 * THE FALLBACK IS DELIBERATE. A MultiPV search normally answers with `lines`
 * filled in, and the bot then picks from five candidate moves. If an engine ever
 * answers without them — a plain search, a host that dropped MultiPV — the bot
 * still moves, from the single best move, rather than refusing to play. The
 * opponent being a little less personal beats an opponent that stops.
 */

import { Chess } from 'chess.js';

import { BOT_MULTIPV, selectMove } from './mimic';
import type { BotProfile, EvalLine, MimicWeights, MoveDecision } from './types';

/** The engine result fields this module reads. `EngineEval` fits this shape. */
export interface BotEngineEval {
  bestMoveUci?: string | null;
  scoreCp?: number | null;
  mateIn?: number | null;
  pvUci?: string[];
  depth: number;
  lines?: { uci: string; scoreCp: number | null; mateIn: number | null; pvUci: string[] }[];
}

export type BotAnalyse = (
  fen: string,
  opts: { movetime: number; elo: number | null; multipv: number },
) => Promise<BotEngineEval>;

/**
 * How long one bot move thinks.
 *
 * Long enough for five lines at a sane depth, short enough that the opponent
 * does not feel frozen between your move and theirs.
 */
export const BOT_MOVE_MOVETIME_MS = 1400;

export interface BotMoveResult {
  decision: MoveDecision;
  /** every line the engine returned, for the "why" panel's detail */
  lines: EvalLine[];
  depth: number;
  /**
   * The engine's verdict on the position itself — the BOT to move — kept for
   * the resignation rule. `lines[0]` carries it when MultiPV answered; the
   * top-level fields are the fallback for a single-line host.
   */
  evalTop: { scoreCp: number | null; mateIn: number | null };
}

/** How lost the bot has to be before it resigns, in centipawns. */
export const BOT_RESIGN_CP = -900;

/**
 * How long the bot should visibly deliberate before its move appears.
 *
 * THE REPORT: *"make the bot take time also thinking not always plays
 * immediately (but not thinking in obvious things too)"*. A search that returns
 * in a few hundred milliseconds made the opponent look like a calculator that
 * had the reply pre-loaded. This adds a human beat, scaled by how much there is
 * to think about: a forced reply (one or two legal moves) gets a token pause, a
 * wide middlegame gets a real one.
 *
 * It is a pacing rule, not a strength rule — `playElo` still decides how good
 * the move is. The caller sleeps only the REMAINDER of this budget, so a slow
 * search is never padded twice.
 */
export function humanThinkDelayMs(fen: string): number {
  let legal = 0;
  try {
    legal = new Chess(fen).moves().length;
  } catch {
    return 350;
  }
  // Forced (or nearly): any human plays this instantly.
  if (legal <= 1) return 120;
  if (legal <= 3) return 260;
  // More choices take longer, up to a ceiling a human would not exceed, plus a
  // little jitter so two bots in a row do not reply on the same beat.
  const base = 420 + Math.min(900, legal * 28);
  return base + Math.floor(Math.random() * 350);
}

/** A forced mate this close is worth resigning to rather than playing out. */
const BOT_RESIGN_MATE_IN = 6;

/**
 * SHOULD THE BOT RESIGN INSTEAD OF PLAYING ON?
 *
 * `ev` is the engine's answer with the bot to move, and this app's engine
 * scores from the side to move (see `EngineEval`), so the sign is already the
 * bot's own outlook — no perspective flip. `-900` is "a queen down against
 * best play"; the mate window is deliberately short, because resigning on a
 * mate twenty moves away is a worse habit than playing a lost game out.
 */
export function botShouldResign(ev: { scoreCp?: number | null; mateIn?: number | null }): boolean {
  if (ev.mateIn !== null && ev.mateIn !== undefined && ev.mateIn < 0 && ev.mateIn >= -BOT_RESIGN_MATE_IN) {
    return true;
  }
  return ev.scoreCp !== null && ev.scoreCp !== undefined && ev.scoreCp <= BOT_RESIGN_CP;
}

/** The engine's lines, in the mimic's own field names. */
export function linesFromEval(ev: BotEngineEval): EvalLine[] {
  if (ev.lines && ev.lines.length > 0) {
    return ev.lines.map((l, i) => ({
      multipv: i + 1,
      scoreCp: l.scoreCp,
      mate: l.mateIn,
      pv: l.pvUci,
      depth: ev.depth,
    }));
  }
  if (ev.bestMoveUci) {
    return [
      {
        multipv: 1,
        scoreCp: ev.scoreCp ?? null,
        mate: ev.mateIn ?? null,
        pv: ev.pvUci && ev.pvUci.length > 0 ? ev.pvUci : [ev.bestMoveUci],
        depth: ev.depth,
      },
    ];
  }
  return [];
}

/**
 * Ask the engine about `fen` and pick the bot's move. Null when the engine had
 * nothing to say — the caller decides what a stalled opponent looks like.
 */
export async function botMoveFor(
  analyse: BotAnalyse,
  fen: string,
  profile: BotProfile,
  weights: MimicWeights,
  opts: { movetime?: number; elo?: number | null } = {},
): Promise<BotMoveResult | null> {
  const ev = await analyse(fen, {
    movetime: opts.movetime ?? BOT_MOVE_MOVETIME_MS,
    elo: opts.elo ?? null,
    multipv: BOT_MULTIPV,
  });
  const lines = linesFromEval(ev);
  const decision = selectMove(lines, fen, profile, weights);
  if (!decision) return null;
  const top = lines[0];
  return {
    decision,
    lines,
    depth: ev.depth,
    evalTop: {
      scoreCp: top ? top.scoreCp : (ev.scoreCp ?? null),
      mateIn: top ? top.mate : (ev.mateIn ?? null),
    },
  };
}
