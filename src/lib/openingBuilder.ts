'use client';

/**
 * THE OPENING BUILDER — group the user's games into opening families, and let
 * them PLAY each family's line move by move, keeping either their own move or
 * our recommendation.
 *
 * WHAT THE USER ASKED FOR
 * -----------------------
 * "before showing anything you should show him the names of his openings and
 *  when he click on one of them for example sicilian then we show him what he
 *  played and what we suggest and continue the line and give him many other
 *  lines on the sicilian so he could train. then he should be able to train on
 *  them (his repertoire and his moves based on what he choosed)."
 *
 * "in 'your openings' i want the user to be able to move the piece to decide
 *  whether to keep his move or what the app suggests not just clicking on the
 *  buttons."
 *
 * "you have to complete the line with him before passing to the next opening"
 *
 * "whenever you can suggest him to choose the app suggests to him else just
 *  just show him the move."
 *
 * "he doesnt need to wait for the app to read his openings each time he click
 *  on 'your openings' — the app just does that one time."
 *
 * THE SHAPE THAT SATISFIES ALL SIX
 * --------------------------------
 * The previous implementation showed a FLAT LIST OF POSITIONS and asked for one
 * tap per position. That is wrong on three counts: it never lets the user play,
 * it has no notion of "this line is finished", and it opens on `move 6 of a
 * game` with no idea which opening you are even in.
 *
 * So the unit is now a **family** (Sicilian Defence / Italian Game / ...) and
 * the experience inside a family is a **played line**:
 *
 *   1. `groupGameOpenings()` buckets the analysed positions by opening family.
 *   2. A family becomes a `FamilyLine` by rotating its positions into a single
 *      legal move order — one concrete line you can actually play from move 1.
 *   3. `advance()` walks that line ply by ply. Where the user's own move and our
 *      recommendation DIFFER, the user plays the move on the board — either one
 *      — and that choice is what gets saved. Where they agree, or where there is
 *      no choice worth making, the move is played for them and the line simply
 *      continues. That is the "whenever we can suggest a choice, offer it;
 *      otherwise just show the move" rule.
 *   4. Only when a line reaches its end does the UI move on — "complete the line
 *      with him before passing to the next opening".
 *
 * WHY A FAMILY LINE IS A ROTATION, NOT A UNION
 * --------------------------------------------
 * The positions in a family come from MANY different games. Naively
 * concatenating their prefixes produces an illegal move list. But every position
 * in a family shares the family's opening stem, and each subsequent position's
 * prefix extends it by one move. So the whole family can be replayed as
 * `prefix(p0) + [move(p0)] + [move(p1)] + ... + [move(pn)]` PROVIDED each
 * successive position is reached legally from the previous one.
 *
 * Real game data does not cooperate perfectly: move orders transpose, and two
 * games can reach "the same family" by genuinely different routes. So the
 * rotation is built greedily — take the next position only if it is legally
 * playable from the line as it stands — and the ones that do not fit are
 * reported in `orphans` rather than silently dropped or force-fitted into an
 * illegal sequence. A subset that plays legally is worth far more than the whole
 * set that does not.
 *
 * WHY A DECISION IS STILL A SINGLE MOVE
 * -------------------------------------
 * Adoption is stored per POSITION (`CustomLine`), because chess transposes: the
 * same choice must be honoured whether the user arrived at the position via one
 * move order or another. Rotating positions into a line is therefore only a
 * PRESENTATION decision — one move is shown at a time, in a playable order —
 * it does not change what a decision means on disk. `buildCustomExercises`
 * (in `gameOpenings.ts`) then turns those per-position decisions back into
 * drillable one-move exercises, and nothing there needs to change.
 */

import { Chess } from 'chess.js';
import type { LichessGame } from '@/lib/lichess';
import { bestCoverageAcrossOpenings, bestOpeningForLine, bookContinuationFromPosition, AVAILABLE_OPENINGS } from '@/lib/openings';
// Only `chess.js` is imported by the engine module — the WebView host is attached at runtime —
// so reaching the engine from here does not drag a native module into the start-up path that
// this file's other lazy bindings exist to keep clear.
import { getEngine, uciToSan } from '@/lib/engine';
import type { RepMove, RepStudy, Repertoire, TrainExercise } from '@/lib/repertoire';
import { buildTrainExercises } from '@/lib/repertoire';
import {
  analysedPositionsFromGames,
  registerDrillContinuation,
  type CustomLine,
  type GamePosition,
  type MoveOption,
} from '@/lib/gameOpenings';

/**
 * One ply of a family line, plus what the user may do there.
 *
 * `choice` is the whole point: it is non-null ONLY when there is a real decision
 * to make. When it is null the UI plays `moveSan` for the user and moves on.
 */
export interface BuilderStep {
  /** The position before the move, in this line's own move order. */
  fen: string;
  ply: number;
  /** Whose turn it is here. */
  side: 'w' | 'b';
  /** The move this line plays, in SAN. */
  moveSan: string;
  moveUci: string;
  /** True when it is the trained side's turn - only then can they decide. */
  isUserMove: boolean;
  /**
   * Which shipped opening this line belongs to, e.g. `sicilian`.
   *
   * The id, not the display name, because this is a JOIN KEY: it is how a move played
   * in "Your openings" is attributed to an opening, and therefore how practising your
   * own games moves that opening's rank. The display name is Lichess's, and it does
   * not match the registry's (`"Sicilian Defense"` vs `"sicilian"`).
   *
   * Stamped on the book tail too, which required computing it BEFORE `withBookTail`
   * ran — the tail used to have no way of knowing which opening it was teaching.
   */
  openingId?: string | null;
  /**
   * Which shipped opening this line belongs to, e.g. `Sicilian Defense`.
   *
   * Needed to build a `CustomLine` from a step with no game position, because
   * `CustomLine.opening` is how the per-opening rank knows that practising "Your
   * openings" counts towards the Sicilian at all. Without it, a completed line
   * recorded fine but the rank could never move.
   */
  opening?: string;
  /**
   * The position record this step was derived from, when there was one.
   *
   * Null for any step with no underlying game position — which is every step
   * `withBookTail` appends, i.e. most of a typical line. Callers must therefore never
   * require it: reading `position.x` unguarded silently drops the majority of a line.
   */
  position: GamePosition | null;
  /**
   * A real decision, or null when there is nothing to choose.
   *
   * Non-null requires: it is the user's turn, we have a recommendation, and the
   * recommendation differs from what they played. If they are the same move
   * there is nothing to decide — asking "keep yours or take ours?" when ours IS
   * yours is the kind of fake choice that makes an app feel thoughtless.
   */
  choice: {
    /** What the user actually played in their game. */
    playedSan: string | null;
    playedUci: string | null;
    /** What we recommend (book move when we ship the opening, else engine best). */
    recommendSan: string | null;
    recommendUci: string | null;
    /** Engine alternatives, excluding the two above. */
    alternatives: MoveOption[];
    /** Why we recommend it, in words a player can act on. */
    why: string;
    inBook: boolean;
    /**
     * Every move a book for the side to move offers at this position.
     *
     * Carried onto the choice because the screen has to answer "is the move YOU
     * played one of ours?" and `inBook` cannot answer it — that flag is about the
     * position. See `GamePosition.bookReplies`.
     */
    bookReplies: string[];
    /** True when the RECOMMENDATION is itself one of our book moves here. */
    recommendIsBookMove: boolean;
    /**
     * How bad the move the user actually played was, when the engine has judged it.
     *
     * THE REQUEST: *"show me some positions where I played a mistake and say a
     * message to me that it is a mistake … (not just giving me positions where I
     * played a good move and suggest another move)"*.
     *
     * Until now a decision was framed as a neutral either/or — "you played Nf6, we
     * play e6" — which is the right frame when his move was FINE and merely
     * different, and completely the wrong frame when he dropped a piece. Nothing
     * in the type could even express the difference, because the loss was on the
     * option and nobody read it.
     *
     * `verdict` is that verdict, taken from the engine's own centipawn loss for the
     * move he played, and `null` when the move was fine or has not been judged —
     * which is the common case for a position the engine has not reached yet, so
     * the UI must not accuse the user of anything it has not measured.
     */
    verdict: 'mistake' | 'blunder' | null;
    /** Centipawns lost by playing his move rather than the best one. */
    lossCp: number;
    /**
     * The engine's score for HIS move and for OURS, from the mover's point of view.
     *
     * The request: *"show the engine eval (for example +0.3) for his move and for
     * the suggested move"*. Null means the engine did not judge that move — which
     * is normal for a position it has not reached yet, and must render as a dash
     * rather than as `0.00`.
     */
    playedCp: number | null;
    recommendCp: number | null;
  } | null;
  /**
   * The shipped study this step came from, when the book carried the line.
   *
   * Set only on the steps `continueFromBook` contributed — i.e. the tail of a
   * line the user's own games could not finish. Undefined everywhere else,
   * including on the steps replayed from the user's own games, so the UI can
   * say "your games" versus "our study" without guessing.
   */
  fromStudy?: string;
  /**
   * True when the ENGINE chose this move, because no book we ship teaches the position.
   *
   * Set by `continueLineWithEngine`, and deliberately distinct from `fromStudy`: a step with
   * `fromStudy` is ours to stand behind, and a step with this flag is the engine's opinion
   * filling a gap in the corpus. The screen has to be able to say which is which, because
   * presenting an engine move as though it came from the study the user is drilling would be
   * teaching them the wrong thing about where the line came from.
   */
  fromEngine?: boolean;
}

/** A whole opening family, ready to play through from move 1. */
export interface FamilyLine {
  /** Stable id — the opening family name. Used as the SRS-ish continuity key. */
  id: string;
  /** Display name, e.g. "Sicilian Defense". */
  name: string;
  /** Which colour the user played in this family's games. */
  side: 'w' | 'b';
  /** Which opening family Lichess labelled these games as (may equal `name`). */
  sourceName: string;
  /**
   * EVERY Lichess label this family absorbed.
   *
   * `sourceName` is a display string, and after several Lichess labels are merged into
   * one card it becomes "Queen's Gambit + Queen's Pawn" - which is fine to read and useless
   * to search with. Both places that recover this family's games from the user's archive
   * compared a single game's `opening` against that string with `===`, so a merged family
   * matched nothing at all: `deriveFamilyCandidates` returned an empty list, the engine pass
   * had nothing to analyse, and the screen showed no evaluation for the move the user played
   * or the move it recommended.
   *
   * So the labels are kept as a SET and both filters test membership. The display string is
   * derived from it, which means the two can never disagree about what the family is.
   */
  sourceNames: string[];
  /** True when we ship a book for this family. */
  inBook: boolean;
  /** How many of the user's games landed in this family. */
  games: number;
  /** The opening entry id we matched, when we ship it. */
  openingId: string | null;
  /**
   * The MAIN playable line — the one the user meets most often.
   *
   * `steps[0]` may be a PREFIX step (the opponent's earlier moves) — those are
   * played automatically so the user lands on the first real decision with the
   * board already in the right position. That is why the UI always starts at
   * `firstDecisionIndex`, never at 0.
   */
  steps: BuilderStep[];
  /** Index of the first step with a decision, or -1 when there is none. */
  firstDecisionIndex: number;
  /** How many decisions this family offers. */
  decisions: number;
  /**
   * SIBLING lines.
   *
   * The user asked for "many other lines on the Sicilian so he could train".
   * A family's positions come from many games with many move orders, so one
   * spine can only represent one of them — every other game's move order is a
   * genuinely different line the user played and should be able to drill.
   *
   * So the orphans from the main rotation are rotated AGAIN, and whatever forms
   * a legal second line becomes `alternates[0]`, then a third, and so on, up to
   * `maxAlternates`. This is the difference between "here is your Sicilian line"
   * and "here are your `n` Sicilian lines".
   */
  alternates: BuilderStep[][];
  /** Total decisions across the main line and every alternate. */
  totalDecisions: number;
  /**
   * Positions in this family where the user actually went wrong - the engine measured a
   * real centipawn loss on the move he played.
   *
   * Deliberately separate from `totalDecisions`, which counts every move that differs from
   * the recommendation. A difference is not an error: the user often plays a sound move the
   * engine happens to rank second, and those positions are the majority. `mistakes` is the
   * number that answers "what do I need to revise in this opening", and it is the primary
   * sort key for the family list.
   */
  mistakes: number;
  /**
   * EVERY position in this family -- placed and orphaned alike.
   *
   * The rotation needs the whole pool to work: orphans are exactly what the
   * sibling lines are rotated OUT OF, so a caller that keeps only the placed
   * positions can never rebuild the family faithfully. That is not theoretical.
   * The screen's engine pass used to reconstruct the family from `steps` alone,
   * re-rotate the smaller pool, and get a DIFFERENT (shorter) line back -- losing
   * depth every time the engine answered. Carrying the pool here is what makes
   * "analyse, then rebuild" idempotent.
   */
  positions: GamePosition[];
  /** Positions in this family that could not be rotated into ANY legal line. */
  orphans: number;
}

export interface BuildOptions {
  /** Cap on games read, so a huge account does not take forever. */
  maxGames?: number;
  /** Opening plies only. */
  maxPly?: number;
  /** Positions per family, so one favourite opening does not swamp the list. */
  maxPerFamily?: number;
  /**
   * How many sibling lines to build per family.
   *
   * "give him many other lines on the sicilian so he could train" — a family
   * whose games diverged has several genuinely different lines, and drilling one
   * of them is not the same as knowing the opening.
   *
   * The default is 8 because that is where the measured curve bends. Across the
   * reference corpus (39 families), raising it from 3 to 8 took the decisions on
   * offer from 249 to 285 and cut stranded positions from 254 to 99, at a cost of
   * only ~30 extra lines in total — under one more line per family, so it does
   * not turn the family screen into an endless list. Going on to 12 buys a
   * further 18 decisions for 8 more lines each, which is much worse value.
   */
  maxAlternates?: number;
}
/** The colour the user played, from the position's own side-to-move field. */
function sideOf(p: GamePosition): 'w' | 'b' {
  const c = p.fen.split(' ')[1];
  return c === 'w' ? 'w' : 'b';
}

/**
 * Apply a SAN move to a board, returning the UCI, or null when illegal.
 *
 * A private `Chess` is used rather than threading one through, because the
 * legality of a rotation step is exactly what we are testing and a shared board
 * would make a failed step corrupt every later one.
 */
function play(fen: string, san: string): { uci: string; fenAfter: string } | null {
  try {
    const c = new Chess(fen);
    const m = c.move(san);
    if (!m) return null;
    return { uci: m.from + m.to + (m.promotion ?? ''), fenAfter: c.fen() };
  } catch {
    return null;
  }
}

/**
 * A board that ADVANCES, so a line is replayed ONCE instead of once per step.
 *
 * WHY THIS EXISTS — THE MEASURED COST OF RE-PARSING
 * --------------------------------------------------
 * `play(fen, san)` builds a brand-new `Chess` from the FEN string for every
 * single ply. Two costs are paid per move: `new Chess(fen)` parses the whole
 * position, and `c.move(san)` regenerates every legal move — which chess.js does
 * for a move regardless of how cheap the move itself is. Measured on the
 * reference corpus: **~0.2 ms per ply**, so a 30-ply book tail costs 6 ms and
 * every rotation step costs a board rebuild.
 *
 * That is the same trap the project already hit twice — `MEMORY.md`:
 * "Never derive state with a `new Chess()` replay per value. Each value used to
 * be its own replay, quadratic in `ply` -> ~10.5 ms/render." It was fixed in
 * `replayLine` and in the Train screen and never in this builder, which is
 * where the remaining 1.4 s of "Your openings" lives.
 *
 * The rule here: a line is a SEQUENCE, so it gets one board that walks down it.
 * `play` stays for the genuinely one-off cases (a legality probe, a book's
 * verification move) where there is no sequence to amortise over.
 */
class Walker {
  private c: Chess;
  private cur: string;

  constructor(fen: string) {
    this.c = new Chess(fen);
    this.cur = fen;
  }

  /** The position the next move would be played from. */
  get fen(): string { return this.cur; }

  /** Whose turn it is here — read off the board, which is the authority. */
  side(): 'w' | 'b' { return this.c.turn() === 'w' ? 'w' : 'b'; }

  /**
   * Play a move and advance. Null (and NO advance) when the move is illegal, so
   * a caller can walk a speculative line and reset if it turns out to be a dead
   * end — which is exactly what the rotation does at every step.
   */
  play(san: string): { uci: string; fenAfter: string } | null {
    try {
      const m = this.c.move(san);
      if (!m) return null;
      this.cur = this.c.fen();
      return { uci: m.from + m.to + (m.promotion ?? ''), fenAfter: this.cur };
    } catch {
      return null;
    }
  }

  /** Play a list, stopping at the first illegal move. Returns the steps taken. */
  playAll(sans: string[]): { san: string; uci: string; fenBefore: string; fenAfter: string }[] {
    const out: { san: string; uci: string; fenBefore: string; fenAfter: string }[] = [];
    for (const san of sans) {
      const before = this.cur;
      const m = this.play(san);
      if (!m) break;
      out.push({ san, uci: m.uci, fenBefore: before, fenAfter: m.fenAfter });
    }
    return out;
  }

  /**
   * Can this move be played here? Non-destructive.
   *
   * chess.js has no undo and no clone, so "ask without committing" means a
   * throwaway board — which is exactly what the module-level `play` does, so it
   * is not duplicated here. Kept as a note because it looks like a method the
   * class should have: the rotation never needs it, since it discovers an
   * illegal move by WALKING onto it and resetting.
   */

  /** Rewind to a position, so a failed attempt costs one parse, not a whole line. */
  reset(fen: string): void {
    this.c = new Chess(fen);
    this.cur = fen;
  }
}

/**
 * Rotate a family's positions into one legal line.
 *
 * THE ALGORITHM: PICK THE MOST-PLAYED MOVE AT EACH PLY, IN ORDER
 * -------------------------------------------------------------
 * A family's positions come from many games, and each game has its own move
 * order. Concatenating them is illegal. But they all share the family's opening
 * stem, so the natural spine is reached by walking FORWARD one ply at a time and
 * asking: "among the positions in this line, which one is the continuation of
 * what I have played so far?"
 *
 * So the walk is:
 *
 *   fen = start; played = []
 *   loop:
 *     candidates = positions whose `prefixSan` EQUALS `played`
 *                  (i.e. this position is exactly where we are now)
 *     if none: stop
 *     pick the one reached by most of the user's games (`timesSeen`), breaking
 *     ties by shallower ply then by key so the result is deterministic
 *     append its move; played.push(move); fen = after the move
 *
 * `prefixSan` is what makes this possible and it is the reason it is stored on
 * every position: it is a full move list from the start of the game, so
 * "does this position sit exactly here?" is a plain array comparison rather than
 * a search. (An earlier version compared `ply` alone; that accepted a position
 * reached by a DIFFERENT move order and produced a line that stopped after one
 * move — which is exactly the 34-plies-across-19-families symptom the harness
 * showed.)
 *
 * Anything whose prefix never matches the walked spine is an orphan: the user
 * reached it by a transposition, and it belongs on a SIBLING line rather than in
 * this one. Counting it honestly (instead of force-fitting it) is what keeps the
 * board consistent with the arrows drawn on it.
 */
function rotateLine(startFen: string, positions: GamePosition[], seedPlayed: string[] = []): {
  steps: BuilderStep[];
  orphans: number;
  used: Set<string>;
} {
  const steps: BuilderStep[] = [];
  const used = new Set<string>();

  /** How many of the user's games reached this position — the selection weight. */
  const weight = (p: GamePosition) => p.timesSeen ?? 1;

  /*
   * SEEDING — why the walk does not necessarily start from `[]`.
   *
   * A position's `prefixSan` is the OPPONENT's build-up before the user's own
   * move. For White that can be empty (White moves first), but for Black it
   * never is: Black's earliest decision is at ply 1, whose prefix is `["e4"]`.
   *
   * So a Black family has NO position with an empty prefix, and a walk that
   * demands `prefixSan === []` at step 0 matches nothing and stops immediately —
   * which is exactly the one-ply line the harness caught. The fix is to seed the
   * line from the shallowest position's own prefix: those moves are played
   * AUTOMATICALLY (they are the opponent's, so the user has nothing to decide),
   * and the walk then hands over on the user's first real move.
   *
   * The seed is the most-played position of the shallowest ply, so the stem is
   * the variation the user actually meets most often.
   */
  const seed = [...positions].sort(
    (a, b) => a.ply - b.ply || weight(b) - weight(a) || a.key.localeCompare(b.key),
  )[0];

  let fen = startFen;
  const played: string[] = [];

  /*
   * RESUMING FROM A KNOWN POSITION — why `seedPlayed` exists.
   *
   * The walk above always starts at move 1, which is right when building a
   * family's lines from scratch. It is WRONG when the user has just diverged
   * from the line we gave them: the board is somewhere else entirely, and
   * replaying the family stem from move 1 would rebuild a line from the wrong
   * position.
   *
   * So when the caller already knows the moves played (the user's real history
   * plus the move they just made), the walk resumes THERE instead of seeding,
   * and simply rotates the pool forward from that point. Everything downstream —
   * the prefix matching, the opponent-gap auto-play, the legality checks — works
   * unchanged and stays honest, because the pool is the authority on what can
   * legally follow.
   */
  if (seedPlayed.length > 0) {
    // Replay the resume prefix FORWARD, emitting each ply as a step. Emitting
    // them matters: the caller slices `steps` by the anchor length to get the
    // tail, so a `steps` array that omitted the anchor would return the
    // anchor's own moves as if they were new — which re-plays `d5` on top of
    // `d5` and is the very illegal move this whole function exists to prevent.
    //
    // ONE `Walker` for the whole prefix, not a fresh board per ply (see `Walker`).
    const w = new Walker(startFen);
    for (const san of seedPlayed) {
      // The side is read BEFORE the move, because the step describes the move
      // and the position it is played FROM.
      const before = w.fen;
      const side = w.side();
      const m = w.play(san);
      if (!m) break;
      steps.push({
        fen: before, ply: played.length, side, moveSan: san, moveUci: m.uci,
        isUserMove: false,
        position: null,
        choice: null,
      });
      played.push(san);
    }
    // If the prefix did not fully replay we are mid-way and the walk would be
    // built on sand; a partial resume is worse than none, so bail out cleanly.
    if (played.length !== seedPlayed.length) return { steps: [], orphans: 0, used };
    fen = w.fen;
  } else if (seed && seed.prefixSan.length > 0) {
    const w = new Walker(fen);
    for (const san of seed.prefixSan) {
      const before = w.fen;
      const side = w.side();
      const m = w.play(san);
      if (!m) break;
      steps.push({
        fen: before, ply: played.length, side, moveSan: san, moveUci: m.uci,
        // The opponent's move: shown and played for the user, never decided.
        isUserMove: false,
        position: null,
        choice: null,
      });
      played.push(san);
    }
    fen = w.fen;
  }

  // A generous bound: a family's line can never be longer than its deepest
  // position, plus a little slack. Guards against a pathological self-extending
  // dataset looping forever.
  const maxSteps = positions.reduce((m, p) => Math.max(m, p.ply), 0) + 4;

  for (let guard = 0; guard <= maxSteps; guard++) {
    /*
     * RE-SEEDING AT EVERY PLY -- the fix for a one-ply spine.
     *
     * The walk above assumes that after playing a move, some position starts
     * exactly where we now are. That is true only when decisions were on
     * consecutive plies. They are not: every position belongs to a SINGLE side,
     * so a White family's positions carry EVEN-length prefixes (0, 2, 4, ...).
     *
     * Concretely: the walk takes `e4` (ply 0, prefix []), so `played` becomes
     * `["e4"]` -- and then demands a position with prefix `["e4"]`. None exists,
     * because the next White position has prefix `["e4", "c5"]`. The walk died
     * one ply in and stranded 28 of Closed Sicilian's 29 positions.
     *
     * The missing move is the OPPONENT'S. So instead of asking "is there a
     * position exactly here?", ask "is there a position whose prefix STARTS WITH
     * what we have played?" -- and if it is deeper, auto-play the extra plies
     * (they are the opponent's, so the user has nothing to decide) to reach the
     * next real decision.
     *
     * This is the same idea as the opening seed, applied continuously rather
     * than once: the opponent's moves are always played for the user.
     */
    const here = positions.filter((p) => !used.has(p.key) && startsWithPrefix(p.prefixSan, played));
    if (here.length === 0) break;

    // Shallowest first: a position whose prefix IS `played` is the immediate
    // continuation, and we must consume it before skipping past it. Ties broken
    // by weight then key so two runs agree.
    here.sort(
      (a, b) => a.prefixSan.length - b.prefixSan.length
        || weight(b) - weight(a) || a.key.localeCompare(b.key),
    );

    /*
     * Take the shallowest position that is LEGAL here (its prefix plies replay
     * cleanly, and so does its own move). A position can have a matching prefix
     * and still be illegal when a previous step came from a different branch.
     *
     * ONE `Walker` per attempt, and it walks the WHOLE continuation — the
     * opponent's gap plies and then the user's own move — so the connecting
     * plies are never replayed a second time to emit their steps. The old shape
     * paid for that twice over: `playSequence` walked the gap on a throwaway
     * board, `play` then rebuilt a board to test the user's move, and the emit
     * loop below rebuilt a board PER GAP PLY to re-derive FENs it had just
     * computed. Measured, that emit loop alone was the largest single cost in
     * "Your openings".
     *
     * A failed attempt resets the same walker rather than allocating a new one,
     * so a candidate that turns out to be illegal costs one parse, not a line.
     */
    const w = new Walker(fen);
    let chosen: GamePosition | null = null;
    let moved: { uci: string; fenAfter: string } | null = null;
    let gapSteps: { san: string; uci: string; fenBefore: string; fenAfter: string }[] = [];
    for (const p of here) {
      if (!p.playedSan) continue;
      // Every extra move is the opponent's (the position is the user's to move)
      // -- but be defensive and skip the position if any of them is illegal.
      const extra = p.prefixSan.slice(played.length);
      w.reset(fen);
      const gapWalked = w.playAll(extra);
      if (gapWalked.length !== extra.length) continue;   // an illegal gap ply
      const m = w.play(p.playedSan);
      if (!m) continue;                                 // an illegal user move
      chosen = p;
      gapSteps = gapWalked;
      moved = m;
      break;
    }
    if (!chosen || !moved) break;

    // Emit the connecting plies (the opponent's) as auto-steps. The FENs come
    // from the walk that already happened, so this is a push, not a replay.
    for (const g of gapSteps) {
      steps.push({
        fen: g.fenBefore, ply: played.length, side: g.fenBefore.split(' ')[1] === 'w' ? 'w' : 'b',
        moveSan: g.san, moveUci: g.uci,
        isUserMove: false,
        position: null,
        choice: null,
      });
      played.push(g.san);
    }
    const gapFen = gapSteps.length > 0 ? gapSteps[gapSteps.length - 1].fenAfter : fen;

    // The position's own side-to-move is the authority on whose move this is --
    // NOT the board's, because the board now sits one ply later than the step
    // the position describes when the previous ply was the opponent's.
    const userSide = chosen.fen.split(' ')[1] === 'w' ? 'w' : 'b';
    steps.push(stepFor(chosen, gapFen, userSide, chosen.playedSan!, moved.uci, true));
    used.add(chosen.key);
    played.push(chosen.playedSan!);
    fen = moved.fenAfter;
  }

  const orphans = positions.length - used.size;
  return { steps, orphans, used };
}

/**
 * Is `played` a prefix of `prefix` — i.e. is this position somewhere DOWNSTREAM
 * of where we have walked?
 *
 * This replaced a strict `samePrefix` equality test, and the difference is the
 * whole reason a family line is longer than one ply. Positions only ever exist
 * on the trained side's moves, so a White family's prefixes have even length
 * (0, 2, 4, ...). After playing White's `e4` the walked list is `["e4"]` --
 * odd -- and an equality test matches nothing, so the walk stopped one ply in
 * and stranded the rest of the family. A prefix test lets the walk reach the
 * next White decision by playing the opponent's reply in between.
 */
function startsWithPrefix(prefix: string[], played: string[]): boolean {
  if (played.length > prefix.length) return false;
  for (let i = 0; i < played.length; i++) {
    if (prefix[i] !== played[i]) return false;
  }
  return true;
}

/**
 * (A standalone "replay this list and tell me where it lands" helper used to live
 * here, next to `play`. It is gone: every caller was replaying a SEQUENCE, and
 * `Walker` does that with one board instead of a rebuild per ply. `Walker.playAll`
 * returns the per-ply FENs, which is strictly more information than the FEN the
 * old helper returned, and the rotation — the only caller that needed it — now
 * reads those FENs instead of recomputing them.)
 */

/**
 * Build a `BuilderStep` for one position.
 *
 * `choice` is populated ONLY when the user's move and our recommendation really
 * differ, which is what makes "just show the move" and "let them choose" two
 * outcomes of one code path rather than two screens.
 */
function stepFor(
  p: GamePosition,
  fen: string,
  side: 'w' | 'b',
  moveSan: string,
  moveUci: string,
  isUserMove: boolean,
): BuilderStep {
  const alternatives = p.options.filter(
    (o) => o.uci !== p.recommendUci && o.uci !== p.playedUci,
  );

  const differs = isUserMove
    && p.recommendUci != null
    && p.playedUci != null
    && p.recommendUci !== p.playedUci;

  const recOpt = p.options.find((o) => o.uci === p.recommendUci);
  const bookReplies = p.bookReplies ?? [];
  const recommendIsBookMove = p.recommendSan != null && bookReplies.includes(p.recommendSan);

  /*
   * WAS THE MOVE HE PLAYED ACTUALLY BAD?
   *
   * The engine's centipawn loss for the played move is the only measurement we
   * have, so it is the only thing that may drive this. Two rules matter:
   *
   *   - `NaN` means the engine did not judge that move (it sat outside the MultiPV
   *     window), and `NaN` is NOT zero. A position that has not been analysed must
   *     not be labelled a mistake, so the verdict is `null` and the screen keeps
   *     the neutral "keep yours or ours" framing.
   *   - The thresholds are the ones `describeDelta` already uses, so the number in
   *     the comparison and the word on the headline can never disagree: >= 250cp is
   *     a blunder, >= 110cp a mistake.
   */
  const playedOpt = p.options.find((o) => o.uci === p.playedUci);
  const playedLoss = playedOpt && Number.isFinite(playedOpt.lossCp) ? playedOpt.lossCp : NaN;
  const verdict: 'mistake' | 'blunder' | null =
    !Number.isFinite(playedLoss) ? null
      : playedLoss >= 250 ? 'blunder'
        : playedLoss >= 110 ? 'mistake'
          : null;

  /*
   * `why` is the sentence under the comparison, so it has to be true.
   *
   * It used to be chosen from `inBook`, which says a book for this colour has SOME
   * move here — and then called the recommendation "our book move" even when the
   * engine's move was being recommended and no book contained it. That is how a
   * Black user met "our book move — the best in the position" next to an engine
   * recommendation of `e6` in a position where our Black books offer `c5`, `c6`
   * and `e6` and he had played `Nf6`.
   *
   * So the sentence follows the RECOMMENDATION, not the position, and it names
   * the actual book moves when we have any. The user is being taught a repertoire;
   * being vague about whose move it is defeats the point.
   */
  const why = !recommendIsBookMove
    ? (p.inBook
      ? 'not a book move here — this is the engine’s pick'
      : 'we do not have a book for this line yet — this is the engine’s pick')
    : recOpt && Number.isFinite(recOpt.lossCp) && recOpt.lossCp > 0
      ? 'our book move'
      : 'our book move — the best in the position';

  return {
    fen,
    ply: p.ply,
    side,
    moveSan,
    moveUci,
    isUserMove,
    position: p,
    /*
     * A CHOICE EXISTS ONLY WHERE THE TWO MOVES ACTUALLY DIFFER - AND THAT IS NOT A BUG.
     *
     * This condition was changed once, to `p.playedUci && p.recommendUci`, and that was wrong. The
     * reason is written into `gameOpenings`, where the recommendation is produced:
     *
     *     recommendSan: c.inBook && c.bookSan ? c.bookSan : c.playedSan
     *
     * Out of book, the recommendation IS THE USER'S OWN MOVE, on purpose, because there is nothing
     * better to say before a search has run. The family list is built engine-free and the user starts
     * playing immediately, so inventing an "ours" for a position the books do not cover would put an
     * arrow on the board pointing at a move nobody chose.
     *
     * A choice built unconditionally is therefore a comparison of the user's move against ITSELF, and
     * it took the reference corpus from "every decision comes from the book" (285 of 285) to 50 of
     * 559. The feature had quietly become load-bearing on an engine run that has not happened yet -
     * the exact failure `openingbuilder.playloop` exists to catch.
     *
     * So `differs` stays, and "why are almost all my lines without any choice?" has a real answer
     * rather than a bug: a position where the user found the book's move has nothing to correct, and
     * a card reading "your move: d4, you played this, this line plays d4" is noise.
     *
     * WHAT ANSWERS THAT REPORT IS A JOIN, NOT A COMPARISON. `buildDecisionIndex` in `yourOpenings`
     * keys the user's OWN moves by POSITION, so any view of an opening - a course line, a drill
     * line, a line derived from their correct play - can ask "what did I play here, and what should
     * I have played" without the line having been derived from a mistake in the first place. That is
     * what puts both arrows on every line, and what puts a real decision back in front of the user
     * at positions the books are silent about.
     *
     * `differs` is still read for the framing further down, so nothing else here is dead code.
     */
    choice: differs
      ? {
          playedSan: p.playedSan,
          playedUci: p.playedUci,
          recommendSan: p.recommendSan,
          recommendUci: p.recommendUci,
          alternatives,
          why,
          inBook: p.inBook,
          bookReplies,
          recommendIsBookMove,
          verdict,
          lossCp: Number.isFinite(playedLoss) ? playedLoss : 0,
          playedCp: playedOpt && Number.isFinite(playedOpt.cp) ? playedOpt.cp : null,
          recommendCp: recOpt && Number.isFinite(recOpt.cp) ? recOpt.cp : null,
        }
      : null,
  };
}

/**
 * Attach fresh engine verdicts to a line that is ALREADY on the board.
 *
 * THE REPORT: *"in your openings it never shows me a bad move in the opening and suggest a good
 * move, it only shows me my good move and suggests another good move"*.
 *
 * The list is painted from ENGINE-FREE positions, so at the moment the user opens a family every
 * step has `verdict: null` and no evaluations — "your move / another move", both neutral. The
 * engine pass then runs and `publish` records the analysed positions… and the screen could not use
 * them: `buildFamilyLines` re-runs the pool rotation, so swapping the family in mid-session moves
 * the line under the user (that is the whole `lineloop` family of bugs), and `publish` therefore
 * refuses to rebuild while a session is live. The verdicts were only picked up the next time the
 * family was opened, so within a session the mistake he actually made was never shown.
 *
 * This is the missing half: match the steps to the analysed positions BY POSITION KEY and rebuild
 * each step's `position`/`choice` in place. The moves, the plies, the FENs and the ORDER are
 * untouched — nothing can drift, because nothing moves. What changes is the data the compare box
 * and the correction path read: `verdict`, `lossCp`, the evaluations, and — out of book — a new
 * recommendation, which is what turns "the engine found a better move here" into a real question
 * on the step where the user is standing.
 *
 * Returns the SAME array when nothing matched, so callers can use identity to stay quiet.
 */
export function withVerdicts(steps: BuilderStep[], analysed: GamePosition[]): BuilderStep[] {
  if (analysed.length === 0 || steps.length === 0) return steps;
  const byKey = new Map(analysed.map((p) => [p.key, p]));
  let changed = false;
  const out = steps.map((s) => {
    const p = s.position ? byKey.get(s.position.key) : undefined;
    if (!p || p === s.position) return s;
    changed = true;
    // Re-derive the position record and the choice with the same rules `stepFor`
    // used when the line was built, keeping the step's own identity fields.
    const rebuilt = stepFor(p, s.fen, s.side, s.moveSan, s.moveUci, s.isUserMove);
    return { ...s, position: rebuilt.position, choice: rebuilt.choice };
  });
  return changed ? out : steps;
}

/**
 * Turn analysed positions into playable opening families, best first.
 *
 * Family keys are the Lichess opening string, which is exactly the label the
 * user already sees on their games ("Sicilian Defense: Najdorf Variation" is
 * reported by Lichess as `opening: "Sicilian Defense"` with the full name in
 * `openingVariation`, so grouping on `opening` gives the family).
 */
export function buildFamilyLines(
  positions: GamePosition[],
  opts: BuildOptions = {},
): FamilyLine[] {
  const maxPerFamily = opts.maxPerFamily ?? 24;
  const maxAlternates = opts.maxAlternates ?? 8;

  const byFamily = new Map<string, GamePosition[]>();
  for (const p of positions) {
    const key = p.opening || 'Unknown opening';
    let arr = byFamily.get(key);
    if (!arr) { arr = []; byFamily.set(key, arr); }
    arr.push(p);
  }

  /*
   * ONE CARD PER OPENING, NOT PER (OPENING, COLOUR).
   *
   * The report, in the user's own words after two earlier attempts: "still seeing 2 queens
   * gambit, 2 kings indian attack, 2 polish opening". Reading the screen properly showed
   * what those two actually were:
   *
   *     Queen's Gambit       (black)  18 games
   *     Queen's Gambit       (white)  56 games
   *
   * The colour was in the key. Anyone who plays the Queen's Gambit with both colours - which
   * is most people, since 1.d4 d5 can be reached by either side - got two cards for one
   * opening, and the earlier fixes never touched it because they all keyed on the opening
   * and kept the side.
   *
   * The original justification was "they are genuinely two different repertoires", and for
   * the LINE that is true: our Queen's Gambit studies for White and for Black are different
   * books, and mixing them into one playable sequence would be wrong. So the sides are not
   * merged into one line - they are merged into one CARD, and the colour the user plays most
   * in that opening becomes the main line while the other colour's line is kept as a
   * sibling. Nothing is lost and the list stops repeating itself.
   */
  const byOpening = new Map<string, { name: string; labels: Set<string>; positions: GamePosition[] }>();
  for (const [label, group] of byFamily) {
    for (const p of group) {
      const side = sideOf(p);
      const matched = openingIdFor(group.filter((q) => sideOf(q) === side));
      // The key carries the OPENING and nothing else. Matching is still done per
      // (label, side) because a Black 1.d4 game and a White 1.d4 game can belong to
      // different openings, and only one lookup per pair avoids repeating the coverage
      // walk once per position.
      const key = matched ?? 'unmatched:' + label;
      let entry = byOpening.get(key);
      if (!entry) {
        // The name comes from the REGISTRY, not from a list written down here, so an
        // opening added to the app later names its own card with no change to this file.
        const canonical = matched ? openingDisplayName(matched) : label;
        entry = { name: canonical, labels: new Set<string>(), positions: [] };
        byOpening.set(key, entry);
      }
      entry.labels.add(label);
      entry.positions.push(p);
    }
  }

  const families: FamilyLine[] = [];

  for (const [openingKey, entry] of byOpening) {
    const name = entry.name;

    // A family is played as one colour. If a user somehow has both (a Sicilian
    // as White and as Black), they are genuinely two different repertoires, so
    // the family is split rather than pretending they are one line.
    //
    // The keys in `byOpening` already carry the side, so each entry holds one side - but
    // they are regrouped here anyway rather than assumed, because a single Lichess label
    // can merge into two library openings and a wrong assumption about the contents of a
    // group would silently mix White and Black moves into one line.
    const bySide = new Map<'w' | 'b', GamePosition[]>();
    for (const p of entry.positions) {
      const s = sideOf(p);
      let arr = bySide.get(s);
      if (!arr) { arr = []; bySide.set(s, arr); }
      arr.push(p);
    }
    void openingKey;

    /*
     * ONE CARD, BOTH COLOURS: the side the user plays MOST becomes the main line, and the
     * other colour is built afterwards and attached as a sibling.
     *
     * `bySide` is ordered by size, descending, and only the FIRST entry becomes a family.
     * The rest are collected and appended to `extraSides` so the loop below can be reused
     * for them without creating a second card.
     */
    const orderedSides = [...bySide.entries()].sort((a, b) => b[1].length - a[1].length);
    const mainSide = orderedSides[0];
    if (!mainSide) continue;
    const extraSides = orderedSides.slice(1);

    for (const [side, sidePositions] of [mainSide]) {
      // Positions the SIBLING colour contributed, folded into the pool below. See the sibling block.
      let siblingPositions: GamePosition[] = [];
      /*
       * NOTE: the cap is applied to the LINE, not to the positions fed into the
       * rotation.
       *
       * Trimming the position list first looks equivalent and is not: the walk
       * needs the SHALLOW positions to build the opening stem, so dropping them
       * leaves the line unable to start. The cap therefore trims the finished
       * line instead, keeping the deep end (where the real decisions are) and
       * enough of the stem to stay playable from move 1.
       */
      const main = rotateLine(new Chess().fen(), sidePositions);
      if (main.steps.length === 0) continue;

      /*
       * LET THE BOOK FINISH WHAT THE USER'S GAMES STARTED.
       *
       * A user's games are a thin sample, so a line very often stops after the
       * opening moves — the user plays the first eight plies and no game of his
       * ever went further in that particular move order. That is what "it doesn't
       * complete the line, i just played one move and that's it" is describing,
       * and it happens on the SPINE too, not only after a divergence.
       *
       * We ship full 30-ply studies for these openings. Appending the book's
       * remainder is precisely "the user gets trained on his repertoire AND ours
       * — in the course too, not just in training": the opening his games begin
       * is carried to the end of our teaching line, and each appended step is
       * tagged with the study it came from so the screen can credit it.
       *
       * Only done when the book actually continues from here; a line the book
       * does not know is left exactly as it was rather than padded with guesses.
       */
      /*
       * BEFORE `withBookTail`, deliberately.
       *
       * This used to be computed on line 873, after the tail was built — so the tail
       * could not stamp `openingId` and every book move was unattributable. Moving it
       * up is the whole fix; the value is unchanged.
       */
      const matchedOpeningId = openingIdFor(sidePositions);
      const spine = trimLine(main.steps, maxPerFamily);
      const steps = withBookTail(spine, side, matchedOpeningId);

      /*
       * SIBLING LINES.
       *
       * Everything the main spine could not use is a move order the user really
       * played, so it is a real line rather than noise. Rotating the leftovers
       * again yields the second-most-common continuation, and repeating the
       * process yields the third. A line only counts if it contains a DECISION
       * or at least two plies — otherwise it is a stray first move, not a line
       * worth a card.
       */
      const alternates: BuilderStep[][] = [];
      let remaining = sidePositions.filter((p) => !main.used.has(p.key));
      let orphans = 0;
      for (let i = 0; i < maxAlternates && remaining.length > 0; i++) {
        const next = rotateLine(new Chess().fen(), remaining);
        // No progress (nothing was consumed) would loop forever.
        if (next.used.size === 0) break;
        remaining = remaining.filter((p) => !next.used.has(p.key));
        const trimmed = trimLine(next.steps, maxPerFamily);
        const asLine = withBookTail(trimmed, side, matchedOpeningId);
        if (asLine.filter((s) => s.choice != null).length === 0 && asLine.length < 2) continue;
        // A sibling identical to the main line would be a duplicate card.
        if (sameLine(asLine, steps)) continue;
        if (alternates.some((a) => sameLine(a, asLine))) continue;
        alternates.push(asLine);
      }
      orphans = remaining.length;

      const firstDecisionIndex = steps.findIndex((s) => s.choice != null);
      const decisions = steps.filter((s) => s.choice != null).length;
      /*
       * MISTAKES, COUNTED SEPARATELY FROM DECISIONS.
       *
       * A decision is "your move differs from ours", which includes the many positions where
       * the user played a sound move the engine merely ranked second. A mistake is where the
       * engine measured a real loss - `verdict` is 'mistake' at >= 110cp and 'blunder' at
       * >= 250cp, and it is `null` when the move was never scored. Only the former is an
       * error worth revising, so it gets its own count and its own place in the ordering.
       */
      const countMistakes = (line: BuilderStep[]) =>
        line.filter((s) => s.choice?.verdict != null).length;
      const mistakes = countMistakes(steps);
      const totalDecisions = decisions
        + alternates.reduce((n, a) => n + a.filter((s) => s.choice != null).length, 0);
      const games = new Set(sidePositions.map((p) => p.gameId)).size;
      const inBook = sidePositions.some((p) => p.inBook);

      /*
       * ATTACH THE OTHER COLOUR AS A SIBLING LINE, NOT AS A SECOND CARD.
       *
       * This is the "one card per opening" rule made concrete. The user plays the Queen's
       * Gambit with both colours; the colour they play most becomes `steps`, and the other
       * colour's games are rotated into one extra line appended to `alternates`, so it is
       * still reachable from the same card.
       *
       * Only ONE extra colour is attached, not a line per colour: a user who has played
       * three colours in an opening has not asked for three extra lines, and the siblings
       * are capped elsewhere anyway.
       */
      for (const [, otherPositions] of extraSides.slice(0, 1)) {
        const other = rotateLine(new Chess().fen(), otherPositions);
        if (other.steps.length === 0) continue;
        /*
         * The pool keeps every position even when the sibling line adds no new
         * sequence: the same moves played from the other colour still produced
         * different decisions, and a rebuild must be able to rotate them.
         */
        siblingPositions = siblingPositions.concat(otherPositions);
        const asLine = withBookTail(trimLine(other.steps, maxPerFamily), otherPositions[0] ? sideOf(otherPositions[0]) : side, matchedOpeningId);
        if (asLine.length === 0) continue;
        if (sameLine(asLine, steps)) continue;
        if (alternates.some((a) => sameLine(a, asLine))) continue;
        alternates.push(asLine);
        /*
         * AND THE SIBLING COLOUR'S POSITIONS JOIN THE POOL.
         *
         * They were not here before, and that is where the position loss came from. The card is one
         * card - that is the "one card per opening" rule and it is right - but the POOL was the main
         * colour's positions only, so every position the user reached with the other colour was kept
         * as a single sibling LINE and then dropped as data. On the reference corpus that was 52 of 996
         * positions, every one of them a Black move in an `e4` opening the user also plays with White:
         * 34 Sicilian, 9 Ruy Lopez, 9 Scandinavian.
         *
         * The cost was not only the count. A rebuild re-derives the family from `positions`, so on the
         * next rebuild those 52 positions could not be re-rotated at all - the sibling line was not
         * merely unrepresented, it was unrecoverable. That is the "rebuild siblings: 2 -> 1" and
         * "rebuild is idempotent: 3 drifted" failures behind this, and both are the same cause.
         */
      }

      // A family with no decisions at all is still worth listing — the user
      // played it, and "you are already playing our line here" is real
      // information, not an empty screen. But it sorts last.

      families.push({
        id: `${name}|${side}`,
        name,
        side,
        // The Lichess label(s) this family absorbed, NOT the display name. A merged
        // family can stand for two of them - "Queen's Gambit" and "Queen's Pawn" - and
        // keeping the labels means the screen can say which names were folded together
        // instead of quietly losing the fact. `name` is the app's name for the opening.
        sourceName: entry.labels.size === 1 ? [...entry.labels][0] : [...entry.labels].join(' + '),
        sourceNames: [...entry.labels],
        inBook,
        games,
        openingId: matchedOpeningId,
        steps,
        firstDecisionIndex,
        decisions,
        alternates,
        totalDecisions,
        mistakes,
        positions: sidePositions.concat(siblingPositions),
        orphans,
      });
    }
  }

  // Families WITH decisions first (a trainer should lead with the work), then by
  // how much of the user's play they represent, then alphabetically so the order
  // is stable between runs.
  //
  // MISTAKES FIRST, THEN DECISIONS.
  //
  // The user's report: "make sure the app gives me positions where I made a mistake in the
  // opening and suggest a good move and then complete the line (not just showing me a good
  // move I played and a suggestion)".
  //
  // A `totalDecisions` count cannot answer that, because a decision is ANY move that differs
  // from the recommendation - including the ones where the user played a perfectly good move
  // the engine simply ranked second. Those are the majority, so sorting by decision count
  // leads with the least interesting work and buries the actual errors.
  //
  // So `mistakes` counts only the positions where the engine measured a real loss (>= 110cp),
  // and that is the primary key. `totalDecisions` stays the secondary key, so a family with
  // no errors but plenty of choices still sorts above a family the user barely touched, and
  // the ordering is still stable.
  families.sort((a, b) => {
    if ((a.mistakes > 0) !== (b.mistakes > 0)) return a.mistakes > 0 ? -1 : 1;
    if (a.mistakes !== b.mistakes) return b.mistakes - a.mistakes;
    if ((a.totalDecisions > 0) !== (b.totalDecisions > 0)) return a.totalDecisions > 0 ? -1 : 1;
    if (a.totalDecisions !== b.totalDecisions) return b.totalDecisions - a.totalDecisions;
    if (a.games !== b.games) return b.games - a.games;
    return a.name.localeCompare(b.name);
  });

  return families;
}

/**
 * Trim a line to `max` plies without cutting its head off.
 *
 * The head is the opening stem: it is what makes the line playable from move 1,
 * so it is never dropped. The middle is what goes, because a long stretch of
 * forced opening moves is the least informative part of a line.
 */
function trimLine(steps: BuilderStep[], max: number): BuilderStep[] {
  if (steps.length <= max) return steps;
  const headLen = Math.max(1, Math.floor(max / 2));
  const tailLen = max - headLen;
  return [...steps.slice(0, headLen), ...steps.slice(steps.length - tailLen)];
}

/**
 * Append the shipped book's continuation to a line whose own games stop early.
 *
 * WHY THIS EXISTS
 * ---------------
 * The user's games are a sample, and a small one: measured on the reference
 * corpus, most families' lines end well inside the opening because no game of
 * his went further *in that exact move order*. Left alone, the course shows a
 * handful of plies and then declares the line complete — which the user
 * reported, correctly, as "it doesn't complete the line".
 *
 * We ship 30-ply studies for these openings. So the remainder comes from the
 * book, and every appended step carries `fromStudy` with the study's title, so
 * the screen can tell the user where the rest of the line came from instead of
 * passing our teaching off as his own play.
 *
 * THE JOIN MUST BE AT THE LINE'S LAST PLY — NOT DEEPER.
 * -----------------------------------------------------
 * `continueFromBook` is deliberately forgiving: it resyncs at the deepest ply
 * the book's tree follows, which may be SHALLOWER than the move list handed to
 * it (that is what makes transposed move orders work at all). Using its answer
 * blindly is what produced this:
 *
 *     ... a6 Bd3 Nf6 Nc3 Qc7 | Nc6 ...
 *
 * The line ends after White's `Qc7` — no wait, after Black's `Qc7`, so it is
 * White's turn — and the book resumes with `Nc6`, a BLACK move. The book's
 * resync point was somewhere earlier, its continuation was replayed onto the
 * line's real end FEN, and every move in the tail was illegal there. 30 of 30
 * tails were broken this way; the bench caught it because it replays the line
 * move by move and checks legality the same way the board does.
 *
 * So the book is asked with an explicit `requireExactDepth`. Only when the walk
 * reaches the line's own position exactly does the continuation legitimately
 * follow it. A line the book cannot join exactly is left as it was: a short
 * honest line beats a long illegal one.
 *
 * WHEN IT DOES NOT APPLY AT ALL
 * -----------------------------
 *   * No book for this line, or the book cannot join at this exact ply.
 *   * The line already reaches `maxPerFamily` — nothing to append to.
 *   * The book's next move duplicates the line's last move.
 */
/**
 * Does this whole move list actually replay from this position?
 *
 * The guard that makes the forgiving book walk safe to use. `stepsForSans` stops at the first
 * illegal move and returns a SHORT list, which is how a resync one ply out of step used to
 * append a truncated - and on a real board, illegal - tail. Checking the full sequence up
 * front means a bad answer is rejected instead of quietly half-applied.
 */
function replaysCleanly(fen: string, moves: string[]): boolean {
  const c = new Chess(fen);
  for (const san of moves) {
    try { c.move(san); } catch { return false; }
  }
  return true;
}

function withBookTail(steps: BuilderStep[], side: 'w' | 'b', openingId?: string | null): BuilderStep[] {
  if (steps.length === 0) return steps;
  const last = steps[steps.length - 1];

  /*
   * `last.fen` is the position the move at `steps.length - 1` is played FROM, so
   * the book's continuation must be replayed from the FEN AFTER that move. Using
   * `last.fen` directly would re-play the line's own last move as the first move
   * of the tail — and passing that same FEN as the verification point is what
   * lets the lookup reject a transposed resync whose answer is not playable here.
   */
  // One move, so a `Walker` would be ceremony: `play` is the right tool for a
  // single lookup and the walker's advantage is amortising over a SEQUENCE.
  const after = play(last.fen, last.moveSan);
  if (!after) return steps;

  const sans = steps.map((s) => s.moveSan);

  /*
   * THE EXACT WALK FIRST, THEN THE FORGIVING ONE - AND BOTH MUST START FROM THIS LINE.
   *
   * THE BUG: *"i tried sicilian in your openings and the same problem - i only played one move
   * and thats it!"*
   *
   * Only the EXACT walk was used here, and it is strict by design: the book's tree must
   * contain every ply of this move order, not a transposition of it. A user's Sicilian is
   * `e4 c5 Nf3 d6 c4 d5 Nc3 a6 d4` - a move order the Sicilian book does not contain
   * verbatim, so the exact lookup returned nothing, no tail was appended, and the family was
   * only as long as the user's own games happened to run. One move in, the line ended and the
   * board went dead. Same shape as the London report, and the scoping fix did not touch it
   * because the walk policy, not the book choice, was the reason there was no answer.
   *
   * THE PART THAT ACTUALLY MATTERS, and the mistake in the first attempt at this fix.
   *
   * The forgiving walk answers the transposition question, but it resyncs at the deepest ply
   * the tree does not break before, so on its own it returns moves that are one ply OUT OF STEP
   * with the line - not playable where the line actually stopped. Measured, for the Najdorf
   * above: the walk offered `d4` next, and White is not to move.
   *
   * The first version of this fix guarded that with `replaysCleanly` alone and threw the
   * answer away whenever any ply was illegal - which, by the measurement above, was almost
   * always. The gate caught it: the built card came out exactly as long as the user's own
   * games, so nothing had been fixed at all.
   *
   * `verifyFrom` is the missing piece and it was already implemented. Given the FEN the line
   * really reached, `walkStudy` walks its resync depth DOWN until the book's next move is
   * actually legal in that position, and returns only from the join that is playable. So the
   * forgiving walk is asked a different, answerable question - "where does the book rejoin MY
   * line?" - instead of the unanswerable one it asks without it.
   *
   * `replaysCleanly` is kept as the outer guard. It is the stronger check, because a legal
   * first move does not strictly imply the rest of the sequence is: two positions can offer the
   * same next move and differ afterwards. It now rejects rarely, because it is no longer being
   * handed answers that were never joined to the line.
   */
  const exact = continueFromBook(sans, true, after.fenAfter, openingId);
  let book = exact && exact.moves.length > 0 ? exact : null;

  if (!book) {
    const loose = continueFromBook(sans, false, after.fenAfter, openingId);
    if (loose && loose.moves.length > 0 && loose.moves[0] !== last.moveSan
      && replaysCleanly(after.fenAfter, loose.moves)) {
      book = loose;
    }
  }

  /*
   * AND FINALLY BY POSITION — the step that actually answers the user's report.
   *
   * Both walks above are move-order indexes. A real game is not a prefix of any study, and once
   * it leaves the study's move order there is nothing for either of them to find: the reported
   * Najdorf matches the SAN trie for two plies, and `walkStudy` finds no depth at which the
   * book's next move is legal in the position the user actually reached. Measured, and the
   * result was NOTHING at every depth from `matchedPly` down to 1.
   *
   * But the POSITION is an ordinary Najdorf position that the book very likely teaches, reached
   * by a different route. That is a transposition, and a move-order index is structurally blind
   * to one. So this asks the question directly, by position, and it is asked LAST so that it can
   * only add continuations — it cannot change which study identifies the opening or which book
   * teaches a line the index above already covers.
   */
  if (!book) {
    const byPosition = bookContinuationFromPosition(after.fenAfter, openingId);
    if (byPosition && byPosition.moves.length > 0 && byPosition.moves[0] !== last.moveSan
      && replaysCleanly(after.fenAfter, byPosition.moves)) {
      book = byPosition;
    }
  }

  if (!book) return steps;
  if (book.moves[0] === last.moveSan) return steps;

  const tail = stepsForSans(after.fenAfter, book.moves, side)
    .map((s) => ({
      ...s,
      ply: steps.length + s.ply,
      fromStudy: book.studyTitle,
      // Stamped so a book move is attributable to an opening. Without it, every step
      // with no game position also had no opening, and a completed line recorded
      // moves that could not be counted towards anything.
      openingId,
    }));
  if (tail.length === 0) return steps; // the book move was illegal on the real board
  return [...steps, ...tail];
}

/** Do two lines play the same moves? Used to reject duplicate sibling cards. */
function sameLine(a: BuilderStep[], b: BuilderStep[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].moveSan !== b[i].moveSan) return false;
  }
  return true;
}

/**
 * Which shipped opening entry do these positions belong to?
 *
 * Read off the positions themselves rather than re-running the matcher: a
 * position already knows whether it is in book, and `bookMoveAt` only sets that
 * when a real repertoire matched. The entry id is recovered by asking the
 * registry which entry covers the position's own prefix; that is one lookup per
 * family, not per position, so it stays cheap.
 */
function openingIdFor(positions: GamePosition[]): string | null {
  /*
   * DECIDED BY DEPTH, NOT BY REGISTRY ORDER.
   *
   * This used to take the FIRST position with `inBook` and ask the global matcher about it,
   * and the global matcher breaks ties by registry order. `inBook` is true as soon as ANY book
   * has a move at a position, so the first such position in a family's list is typically the
   * shared opening stem — `d4 d5`, which is two plies into both the London System and the
   * Queen's Gambit Declined. The Queen's Gambit is second in the registry and London is
   * seventh, so the family was named Queen's Gambit, its card read "Queen's Gambit", its line
   * was finished from the Queen's Gambit book, and the move recommended inside it was `c4`.
   *
   * Scoping the book lookups to the family's opening id did not help, because the id was the
   * thing that was wrong. `bestOpeningForLine` scores each opening by the deepest ply ITS OWN
   * studies follow this family's line, which is evidence rather than enumeration order, and it
   * needs no per-opening configuration to stay right as the library grows.
   */
  const best = bestOpeningForLine(positions.map((p) => p.prefixSan));
  return best?.id ?? null;
}

/**
 * The app's own name for an opening, so a merged family is labelled by the app rather
 * than by Lichess.
 *
 * The registry id is what `openingIdFor` returns, and the registry is what already decides
 * what things are called everywhere else - so a card reading "Queen's Gambit" here and
 * "Queen's Pawn" in the Openings tab was never going to be right.
 */
function openingDisplayName(id: string): string {
  return AVAILABLE_OPENINGS.find((o) => o.id === id)?.name ?? id;
}

/*
 * THE LAZY `matchOpeningId` BINDING IS GONE, AND IT SHOULD NEVER COME BACK.
 *
 * It was a mutable `let` wired at the bottom of this file, so that naming an opening would
 * not import `openings.ts` eagerly at the top. `openingIdFor` was its only reader, and when
 * that was rewritten to ask `bestOpeningForLine` the binding became dead code: nothing reads
 * it, and only the assignment survives in a release bundle.
 *
 * It is being removed because the app CRASHED ON LAUNCH with
 *
 *     [runtime not ready]: ReferenceError: Property 'matchOpeningId' doesn't exist
 *
 * while every check said the code was fine - `tsc` clean, all four behaviour gates green, a
 * release bundle built from this source containing no readable reference to the name, and
 * the same bundle byte-for-byte on the device. Dead code cannot be the cause of anything,
 * and a symbol that exists only to be written is not worth keeping in exchange for a crash
 * that names it. Whatever the mechanism was, it cannot name a binding that is not there.
 *
 * If an opening lookup is ever needed from a module that must not import `openings.ts`
 * eagerly, use the same pattern as `bookStudyLookup` below - which IS read - rather than
 * reviving this one.
 */


// ---------------------------------------------------------------------------
// Reading the family list out of raw games
// ---------------------------------------------------------------------------
/**
 * The whole pipeline: games in, playable families out, with no engine.
 *
 * Deliberately engine-free so the list of opening NAMES paints immediately. The
 * engine work (recommendations, alternatives, deltas) happens only for the
 * family the user actually opens — see `analyseFamily`. That is what makes
 * "show the names first" instant instead of a two-minute wait.
 */
export function familiesFromGames(
  games: LichessGame[],
  opts: BuildOptions = {},
): FamilyLine[] {
  const maxPly = opts.maxPly ?? 16;
  const maxGames = opts.maxGames ?? 160;
  const positions = analysedPositionsFromGames(games, { maxPly, maxGames });
  return buildFamilyLines(positions, opts);
}

// ---------------------------------------------------------------------------
// The Train bridge: the user's own decisions + the app's lines for the same openings
// ---------------------------------------------------------------------------

/**
 * The app's OWN lines for the openings the user actually plays.
 *
 * The request: *"by default the user should train on the lines he choosed in the
 * practice and practiced them + adding lines from the already app repertoire (if we
 * have that opening. note: i will always update the app and add more opening so in
 * your algo make consideration of that)"*.
 *
 * HOW IT STAYS TRUE AS THE LIBRARY GROWS — THE PART THAT MATTERS
 * --------------------------------------------------------------
 * Nothing here names an opening. For each decision the user made, its own move
 * order is looked up against the library and whatever study teaches it is added.
 * So:
 *
 *   - a move order we already ship is matched today;
 *   - one we do not ship yet is skipped now and matched AUTOMATICALLY the day it
 *     is authored, with no change to this function;
 *   - a move order reached by transposition still matches, because the lookup
 *     follows the line rather than comparing first moves.
 *
 * That is the entire reason this is derived rather than configured. A hard-coded
 * list of opening ids would be wrong the first time an opening was added and would
 * need editing on every release — and the app gains openings every release.
 *
 * It lives here, not in `gameOpenings.ts`, because it needs `studyForLine` and
 * `gameOpenings` is imported BY this module. Putting it there would be a cycle.
 */
export function buildBookExercisesForAdoptions(
  adopted: Record<string, CustomLine>,
  max = 8,
): TrainExercise[] {
  const studies = new Set<string>();
  for (const line of Object.values(adopted)) {
    // The decision is made IN the position, so the move order to match is the
    // prefix plus the move that was chosen.
    const sans = [...(line.prefixSan ?? []), line.adoptedSan];
    if (sans.length < 2) continue;
    const hit = studyForLine(sans);
    if (hit) studies.add(hit.id);
  }
  if (studies.size === 0) return [];

  const out: TrainExercise[] = [];
  for (const entry of AVAILABLE_OPENINGS) {
    const rep = entry.repertoire as Repertoire;
    if (!rep) continue;

    /*
     * ONLY THE OPENING THAT ACTUALLY HOLDS THE STUDIES.
     *
     * This loop used to ask EVERY opening for exercises using the matched study ids. `studyForLine`
     * matches against the whole registry, so an adoption made in a position the app does not ship can
     * land on some other opening's study - and then every other opening was asked to produce lines for
     * that id, which is where invented content came from. The measured inversion is the gate's own
     * fixture: an unshipped move order produced SEVEN exercises where the Sicilian, which we really
     * teach, produced four. A decision the user made in one opening was producing drills from
     * openings they had never reached.
     *
     * The set is checked against the repertoire's OWN studies, so a study id can only be satisfied by
     * the book that contains it.
     */
    const here = new Set(rep.chapters.flatMap((c) => c.studies).map((s) => s.id));
    const mine = [...studies].filter((id) => here.has(id));
    if (mine.length === 0) continue;

    const color: 'w' | 'b' = entry.side === 'white' ? 'w' : 'b';
    // `includeUnlearned`: "you have never drilled this study" is not a reason to
    // refuse a line the user asked for.
    out.push(...buildTrainExercises(
      rep,
      {},
      {},
      max,
      { studyIds: mine, includeUnlearned: true },
      color,
    ));
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// Continuing a line after the user diverges from it
// ---------------------------------------------------------------------------

/**
 * Continue a family line from the moves the user actually played.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * The screen used to advance a line after a decision like this:
 *
 *     for (let k = 0; k < stepIdx; k++) sans.push(steps[k].moveSan);
 *     sans.push(san);                                  // what the user played
 *     let i = next;
 *     while (i < steps.length && steps[i].choice == null) {
 *       sans.push(steps[i].moveSan); i++;               // the ORIGINAL line
 *     }
 *
 * Every ply after the decision came from the ORIGINAL line. That is sound only
 * when the user played the original line's own move. The moment they take our
 * recommendation — the entire point of the feature — the branches have diverged
 * and `steps[i].moveSan` is a move from a position that no longer exists. The
 * board then refuses it, `boardFen`'s `catch` breaks the replay, and the line
 * "just stops after one move".
 *
 * Measured on the reference corpus before this function existed: 40 of 227
 * decisions went illegal and 30 truncated. The failing example was the Modern
 * Defense, where our recommendation `d5` was accepted and the original line's
 * `d5` was then appended — the same move twice, from different positions.
 *
 * HOW THE FIX WORKS
 * -----------------
 * The remainder is RE-DERIVED, not patched. The family's position pool is the
 * authority on what can legally follow anything, because every entry in it is a
 * real continuation somebody reached in a real game. So the walk is resumed at
 * the deepest point of the user's history the pool recognises, and it rotates
 * forward from there under the ordinary rules.
 *
 * MOVE PARITY, WHICH IS THE SUBTLE PART
 * A family's pool holds only positions where the TRAINED side is to move, so a
 * Black family's `prefixSan` lengths are all ODD (3, 5, 7, ... — White has just
 * moved). After the user answers a decision, `playedSans` has EVEN length. A
 * strict "does a pool prefix start with this?" test then matches nothing, every
 * single time, because index 3 of a length-5 prefix is Black's own move and
 * cannot equal a White ply. That is not a rare edge case — it is EVERY decision.
 * Hence the anchor search below rather than a plain prefix test.
 *
 * When the pool does not know the user's move at all — which is the normal case
 * for a book recommendation, since a recommendation is precisely a move they
 * have never played — the move is still replayed so the board stays correct, and
 * the rotation's own continuation is appended after it when one exists.
 *
 * @param line      The family the user is playing.
 * @param playedSans Every move played so far, INCLUDING the user's last move.
 * @returns A COMPLETE, self-contained step list: it starts at move 1 and already
 *          contains `playedSans`, so the caller adopts it wholesale as the active
 *          line. Returning the whole list rather than a tail is what stops the
 *          board and the step index from drifting apart — the failure mode that
 *          put an illegal move on the board. Empty when there is nothing honest
 *          to continue with.
 */
export function continueLine(line: FamilyLine, playedSans: string[]): BuilderStep[] {
  if (playedSans.length === 0) return line.steps;
  if (line.positions.length === 0) return [];

  /*
   * The resume anchor: the longest prefix of `playedSans` that the pool knows.
   *
   * Searching from the longest down means we resume as deep as the pool allows.
   * The user's own last move is included in the search, so when that move IS a
   * move the pool knows we resume exactly there and the continuation is the real
   * one. When it is not — which is the NORMAL case for a book recommendation,
   * because a recommendation is precisely a move the user has never played — we
   * fall back to the position before it. The move itself is still replayed as
   * part of the returned list, so the board stays correct.
   */
  let anchorLen = 0;
  for (let n = playedSans.length; n >= 1; n--) {
    const stem = playedSans.slice(0, n);
    if (line.positions.some((p) => startsWithPrefix(p.prefixSan, stem))) { anchorLen = n; break; }
  }
  if (anchorLen === 0) return [];

  const anchor = playedSans.slice(0, anchorLen);

  /*
   * Rotate forward from the anchor. `seedPlayed` resumes the walk there rather
   * than at move 1, and emits the anchor plies as steps, so the returned list
   * already carries the whole game from its first move — but only if the anchor
   * replayed cleanly. A partial replay means the walk started from a position
   * the user was never in, so everything after it is suspect and we bail.
   */
  const { steps } = rotateLine(new Chess().fen(), line.positions, anchor);
  if (steps.length < anchorLen) return [];
  for (let i = 0; i < anchorLen; i++) {
    if (steps[i].moveSan !== anchor[i]) return [];
  }

  if (anchorLen === playedSans.length) {
    /*
     * The pool knows the user's position exactly — the anchor IS everything they
     * played — so the rotation's own continuation is the answer and there is
     * nothing to splice.
     */
    return steps;
  }

  /*
   * The user's move (and the opponent's reply after it) is a ply the pool did
   * not recognise — the normal case for a book recommendation, because a
   * recommendation is precisely a move the user has never played. Everything the
   * rotation produced from the anchor ONWARD continues from the position the user
   * did NOT reach, so it is REPLACED rather than appended to.
   *
   * The replacement is replayed so its steps carry real FENs — a bare SAN list
   * would put the arrows on the wrong board.
   */
  const head = steps.slice(0, anchorLen);
  const unknown: BuilderStep[] = [];
  const w = new Walker(new Chess().fen());
  // The anchor is the moves the pool recognises, replayed forward so the board
  // the user's own moves are played onto is the one they actually reached.
  if (w.playAll(anchor).length !== anchorLen) return steps;
  for (const san of playedSans.slice(anchorLen)) {
    const before = w.fen;
    const side = w.side();
    const m = w.play(san);
    if (!m) break;
    unknown.push({
      fen: before, ply: anchorLen + unknown.length, side, moveSan: san, moveUci: m.uci,
      isUserMove: side === line.side,
      position: null,
      choice: null,
    });
  }
  if (unknown.length === 0) return steps; // nothing replayed; keep the rotation

  /*
   * WHERE THE BOOK PICKS UP — AND WHY IT IS `w.fen`, NOT THE ANCHOR'S FEN.
   *
   * The book continues from the position the USER ACTUALLY REACHED, which is the
   * walker's position after replaying their own move, not the position before it.
   * These differ by exactly one ply, and using the wrong one is not a subtle
   * degradation: the tail is then built on a board one move behind, so
   * `stepsForSans` replays the book's first move onto a position it is illegal
   * in, the tail comes back empty, and every decision the user takes ends the
   * line where they took it.
   *
   * Caught by `.bench/openingbuilder.divergence.test.mjs`: with the anchor's FEN,
   * 1 of 30 decisions continued into any further chess and 26 of 30 alternatives
   * went illegal. The regression was introduced while making the replay cheap, so
   * it is recorded here rather than only in the test.
   */
  const afterUser = w.fen;

  /*
   * Now pick the line up again. `unknown` ends with the opponent to move, so the
   * ordinary walk can continue from there: it is asked the same question as ever
   * — "is there a position whose prefix starts with everything played?" — and the
   * opponent's reply plus the user's next decisions fall out of it.
   *
   * This is a fresh walk from the ROOT (replaying `playedSans` in full), because
   * `rotateLine`'s walk is root-anchored: it needs the whole move list to match
   * prefixes against, and handing it a mid-game FEN would make every prefix look
   * like a mismatch. Its result therefore already contains `playedSans`, and only
   * what comes after is taken.
   *
   * No match means the user's branch is one no game of theirs continued — the
   * line ends there honestly rather than inventing moves.
   */
  const resumed = rotateLine(new Chess().fen(), line.positions, playedSans);
  const beyond = resumed.steps.slice(playedSans.length);

  /*
   * THE BOOK PICKS UP WHERE THE USER'S OWN GAMES RUN OUT.
   *
   * The user's games are a thin sample, so a divergence very often has no
   * continuation in the pool at all — measured case: after the Modern Defense's
   * `Nf3 g6 c4` only four of his games continued, all with `Bg7`, none with the
   * book's `d5`. A line that stops there is honest but reads as broken ("i just
   * played one move and that is it").
   *
   * For those moves we ship a full 30-ply study, and following it is exactly
   * what the user asked for when he asked to train on his repertoire AND ours.
   */
  if (beyond.length === 0) {
    /*
     * SCOPED TO THIS FAMILY'S OPENING.
     *
     * Unscoped, this is the exact path that produced the wrong opening on the device: the
     * user diverged inside the London System, this lookup answered with the Queen's Gambit
     * book (they share `1.d4 d5`, so the tie went to registry order), and the rest of the
     * line was taught from the wrong book. `line.openingId` is the opening that NAMED this
     * family, so it is also the opening that should be teaching it.
     */
    /*
     * `afterUser` IS THE THIRD ARGUMENT, and that is the fix.
     *
     * It was `undefined` here, which turns off `walkStudy`'s own guard - the one that walks the
     * resync depth down until the book's next move is actually legal in the position the user's
     * move left behind. Without it the forgiving walk answers "where does the tree stop
     * breaking", which is not a question about this position at all, and its answer is
     * routinely a move for the other side: measured on the Najdorf, the walk offered `d4` with
     * White to move, and on the London it offered `Bg3` from a bishop that had already left that
     * square. `stepsForSans` then stops at the first illegal move and returns a truncated tail,
     * so the card grew by a move or two and then the board went dead - "one move and that's it".
     *
     * With `afterUser` supplied, `walkStudy` returns only from a join that is playable here, and
     * `replaysCleanly` below is the outer check that the join holds for the whole sequence and
     * not merely its first ply.
     */
    const book = continueFromBook(playedSans, false, afterUser, line.openingId);
    // Still required, and not redundant: a legal FIRST move does not strictly imply a legal
    // rest. Two positions can offer the same next move and differ afterwards, so the whole
    // sequence is replayed before any of it is trusted. It now rejects rarely, because it is no
    // longer being handed answers that were never joined to the line in the first place.
    //
    // And when it STILL cannot — which is the common case for a real game, because both walks
    // are move-order indexes and the user's move order is not a prefix of any study — the
    // position itself is looked up. Same third step as `withBookTail`, same reason, and the
    // answer is scoped to `line.openingId` for the same reason: this is the book that should be
    // teaching this family, and not whichever one happens to pass through the position.
    const byPosition = book
      ? null
      : bookContinuationFromPosition(afterUser, line.openingId);
    const tail = book ?? byPosition;

    if (tail && tail.moves.length > 0 && replaysCleanly(afterUser, tail.moves)) {
      const bookSteps = stepsForSans(afterUser, tail.moves, line.side).map((s) => ({
        ...s,
        // Keep the ply numbering continuous with the rest of the line.
        ply: playedSans.length + s.ply,
        /*
         * Say WHERE these moves came from.
         *
         * The user asked to train on "his repertoire AND ours ... in the course
         * also not just in training", and a course that quietly swaps sources
         * mid-line teaches the wrong thing: he would think the rest of the line
         * is what he plays, when it is what ChessForge teaches. So the study title
         * rides along on every step it owns and the UI can credit it.
         */
        fromStudy: tail.studyTitle,
      }));
      return [...head, ...unknown, ...bookSteps];
    }
  }

  return [...head, ...unknown, ...beyond];
}

/**
 * Continue a line the user has just played, falling back to the ENGINE where no book reaches.
 *
 * THE REPORT: *"i tried sicilian in your openings and the same problem that you keep
 * repeating each time : i only played one move and thats it!"*
 *
 * WHY THE BOOK ALONE CANNOT ANSWER THIS, and this was measured rather than assumed. The
 * shipped content is 692 studies of specific lines. A real game is not a prefix of any of them,
 * and the move-order indexes cannot help: for the reported Najdorf
 * `e4 c5 Nf3 d6 c4 d5 Nc3 a6 d4` the SAN trie matches TWO plies, `walkStudy` finds no resync
 * depth at which the book's next move is legal in the position actually reached, and the
 * position index — which can see transpositions, and does work, giving the QGD 21 playable
 * moves where there had been none — also comes back empty. An independent walk of the raw study
 * trees, using each node's own `fenAfter` and sharing no code with either index, agrees: 7,322
 * nodes across the Sicilian's 114 studies, and that position is not one of them.
 *
 * So the position is a perfectly ordinary Sicilian position that WE DO NOT TEACH. No amount of
 * index work will invent it, and the rule is that content comes from real sources and the user
 * curates the openings himself — so the book is not the answer, and pretending otherwise is what
 * produced three rounds of "I fixed it" that did not fix it.
 *
 * THE ENGINE IS A REAL SOURCE, and it is already in this app: the same screen runs an engine
 * pass over the family's own positions to produce its recommendations. So where the corpus runs
 * out, the engine plays the next move, and the moment the line reaches a position a book DOES
 * teach, the book takes it back over and the engine stops. That is the shape of the promise the
 * screen already makes — "his repertoire AND ours" — with the gap filled by something real
 * rather than by a guess.
 *
 * Two rules keep this honest:
 *
 *   - An engine move is marked `fromEngine`, never given a `fromStudy`. The screen can say
 *     where each move came from, and the user is not taught that an engine's choice is one of
 *     our lines.
 *   - The engine is asked for at most `maxEnginePlies` moves, defaulting to 4, and the search
 *     is abandoned the moment the book resumes. A long engine run would drift out of the
 *     opening entirely and turn a repertoire card into a general engine game.
 */
export async function continueLineWithEngine(
  line: FamilyLine,
  playedSans: string[],
  opts: { movetime?: number; maxEnginePlies?: number; isAlive?: () => boolean } = {},
): Promise<BuilderStep[]> {
  /*
   * A CONTINUATION MUST BEGIN WITH THE MOVES ACTUALLY PLAYED.
   *
   * THE REPORT: *"i tried a line in an opening and i played 2 moves and it jumped to another position
   * (i think it automatically skipped some moves)"*.
   *
   * `continueLine` resumes the family walk at the DEEPEST point of the user history that the pool
   * recognises, and rotates forward from there. When the user has deviated, that resync point is deeper
   * than their actual position and the returned list starts somewhere else - so the caller, which sets
   * the whole line and puts the board at played.length, renders a position the user never reached. Two
   * moves in and the board is somewhere else entirely, which is what was reported.
   *
   * So the book answer is accepted only if it actually replays what was played. If it does not, this
   * falls through to the path below, which builds the head from playedSans explicitly and therefore
   * cannot drift. A shorter line the user can follow beats a longer one that teleports.
   */
  const fromBook = continueLine(line, playedSans);
  const bookStartsWherePlayed = fromBook.length > playedSans.length
    && fromBook.slice(0, playedSans.length).every((s, i) => s.moveSan === playedSans[i]);
  if (bookStartsWherePlayed) return fromBook;

  const maxPlies = opts.maxEnginePlies ?? 4;
  const movetime = opts.movetime ?? 200;

  // The moves actually played, as steps, so the returned list is a COMPLETE line from move 1 —
  // the same shape `continueLine` returns, and the reason the board and the step index cannot
  // drift apart. (That drift was a real bug: patching a line instead of re-deriving it is what
  // produced illegal moves.)
  const head = stepsForSans(new Chess().fen(), playedSans, line.side);
  if (head.length !== playedSans.length) return fromBook;   // unplayable history; do not compound it

  const engineSteps: BuilderStep[] = [];
  let soFar = [...playedSans];

  for (let i = 0; i < maxPlies; i++) {
    // The screen can be closed or the family changed while the engine thinks. Abandoning here
    // returns what is already known rather than a half-built line, which the caller would
    // otherwise show as though it were complete.
    if (opts.isAlive && !opts.isAlive()) return [];

    const c = new Chess();
    let playable = true;
    for (const san of soFar) { try { c.move(san); } catch { playable = false; break; } }
    if (!playable) break;

    // Does a book take over from here? Asked BEFORE the engine, so a line that has drifted back
    // into taught territory is handed straight back to the book rather than answered by Stockfish.
    const byPosition = bookContinuationFromPosition(c.fen(), line.openingId);
    if (byPosition && byPosition.moves.length > 0 && replaysCleanly(c.fen(), byPosition.moves)) {
      const bookSteps = stepsForSans(c.fen(), byPosition.moves, line.side).map((s) => ({
        ...s,
        ply: soFar.length + s.ply,
        fromStudy: byPosition.studyTitle,
        openingId: line.openingId,
      }));
      return [...head, ...engineSteps, ...bookSteps];
    }

    let san: string | null = null;
    try {
      const uci = await getEngine().bestMove(c.fen(), movetime);
      if (uci) san = uciToSan(c.fen(), uci);
    } catch { break; }   // no engine host, or it is busy: an honest short line beats a fake long one
    if (!san) break;

    const step = stepsForSans(c.fen(), [san], line.side)[0];
    if (!step) break;

    engineSteps.push({
      ...step,
      ply: soFar.length + step.ply,
      openingId: line.openingId,
      fromEngine: true,
    });
    soFar.push(san);
  }

  return [...head, ...engineSteps];
}

/**
 * (Gone: `fenAfter(startFen, sans)` replayed a list on a throwaway board. Its one
 * caller now uses a `Walker`, which both validates the list and leaves the board
 * on the position the following steps are played from, so it no longer has to
 * replay the anchor to get back to where it already was.)
 */

// ---------------------------------------------------------------------------
// Continuing a line from the SHIPPED BOOK
// ---------------------------------------------------------------------------

/**
 * The book lookup, wired at the bottom of this file.
 *
 * The lazy-binding trick: importing `openings.ts` eagerly here would pull ten
 * repertoire JSON files into the start-up path of every screen that touches
 * openings. This is the pattern to copy if another such lookup is ever needed —
 * `matchOpeningId` used to be a second copy of it, and has been deleted.
 */
/**
 * The forgiving walk.
 *
 * `verifyFrom` is a real parameter, and it was MISSING once - which is the whole of the
 * *"i tried sicilian and i only played one move and thats it"* bug:
 *
 *   `continueFromBook(sans, false, someFen, openingId)` looked like it asked the forgiving walk
 *   to join `someFen`, and it did not. The argument was accepted by `continueFromBook`, never
 *   passed on, and the registered callback did not even declare it - so the walk ran with
 *   `verifyFrom` permanently `undefined` and answered a question nobody had asked: "where does
 *   the tree stop breaking", rather than "where does the book rejoin MY line".
 *
 *   The difference is not academic. Unverified, the Najdorf `e4 c5 Nf3 d6 c4 d5 Nc3 a6 d4` was
 *   answered with `d4` — White's move, offered with Black to move — and the London with `Bg3`
 *   from a bishop that had already left that square. `stepsForSans` then stops at the first
 *   illegal move, so the card grew by a ply or two and the board died: one move, then nothing.
 *
 * An argument that is accepted and discarded is worse than one that is absent, because the call
 * site reads as though the question was asked. It is declared here so that a second omission
 * cannot be silent.
 */
let bookContinuation: (
  sans: string[],
  openingId?: string | null,
  verifyFrom?: string,
) => { studyTitle: string; moves: string[] } | null
  = () => null;

/**
 * The exact-depth walk, for appending a tail. Wired alongside the forgiving one.
 *
 * Kept separate rather than parameterising the registered callback so the two
 * policies are impossible to confuse at the call site: different functions, and
 * `continueFromBook` picks between them by name.
 */
let bookExactLookup: (
  sans: string[],
  verifyFrom?: string,
  openingId?: string | null,
) => { studyTitle: string; moves: string[] } | null
  = () => null;

/** Wire the real book lookup. Runs once, at module load. */
export function registerBookContinuation(
  fn: (
    sans: string[],
    openingId?: string | null,
    verifyFrom?: string,
  ) => { studyTitle: string; moves: string[] } | null,
): void {
  bookContinuation = fn;
}

/** Wire the exact-depth book lookup. Runs once, at module load. */
export function registerBookExact(
  fn: (
    sans: string[],
    verifyFrom?: string,
    openingId?: string | null,
  ) => { studyTitle: string; moves: string[] } | null,
): void {
  bookExactLookup = fn;
}

/**
 * THE COURSE LINK — which shipped study covers this line?
 *
 * Requested explicitly: "you can refer to what we have in the openings studies
 * also in 'your openings', so the user get trained on his repertoire and ours
 * (in the course also not just in training)". The builder plays the book tail
 * inline, but the user must also be able to reach the STUDY — the full lesson,
 * with its comments and branches — from an opening he has just discovered he
 * plays. Otherwise "ours" is only ever the anonymous couple of moves we tacked
 * onto the end of "his".
 *
 * Separate from `continueFromBook` on purpose: that answers "what comes next?",
 * this answers "which study is this?". Same lazy-binding wiring, for the same
 * reason — `openings.ts` must not enter every screen's start-up path.
 */
let bookStudyLookup: (sans: string[]) => { id: string; title: string } | null = () => null;

/** Wire the study lookup. Runs once, at module load. */
export function registerBookStudy(
  fn: (sans: string[]) => { id: string; title: string } | null,
): void {
  bookStudyLookup = fn;
}

/** The shipped study covering a line, by id and title, or null. */
export function studyForLine(sans: string[]): { id: string; title: string } | null {
  if (sans.length === 0) return null;
  return bookStudyLookup(sans);
}

/**
 * The shipped book's continuation from a position, as a SAN list.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE ANSWER TO "it doesn't complete the line"
 * ---------------------------------------------------------------------------
 * The user's own games are a thin sample. Measured on the reference corpus, the
 * Modern Defense position after `Nf3 g6 c4` has only FOUR continuations in his
 * games, all of them `Bg7` — none played the book's `d5`. So when he accepts our
 * recommendation, the pool of his own games has genuinely nothing to say, and a
 * line that stops there is *honest* but feels broken: "i just played one move
 * and that is it".
 *
 * The book does have something to say. We ship full 30-ply studies for these
 * openings, and that is exactly what the user asked to train alongside his own
 * repertoire: "you can refer to what we have in the openings studies also in
 * 'your openings', so the user gets trained on his repertoire and ours (in the
 * course also not just in training)".
 *
 * So a line that has run out of the user's own games falls back to the book, and
 * the book carries it to the end. That is the difference between a repertoire
 * that stops after one move and a course that teaches an opening.
 */
export function continueFromBook(
  sans: string[],
  requireExactDepth = false,
  verifyFrom?: string,
  /**
   * Restrict the answer to ONE opening's studies.
   *
   * Without it the tie between two books that share a prefix is broken by registry order,
   * which is how a London System line got finished with the Queen's Gambit's `c4`. The caller
   * already knows which opening the family is - it named the card - so the book that finishes
   * the line should be that opening's, not whichever happens to come first in the registry.
   */
  openingId?: string | null,
): { studyTitle: string; moves: string[] } | null {
  if (sans.length === 0) return null;
  if (requireExactDepth) return bookExactLookup(sans, verifyFrom, openingId);
  return bookContinuation(sans, openingId, verifyFrom);
}

/**
 * Replay a SAN list into `BuilderStep`s with honest FENs and no decisions.
 *
 * One `Walker` for the whole list (see its note): this is the function that
 * materialises every book tail, so it runs once per family line, and rebuilding
 * a `Chess` per ply made each 30-ply tail cost ~6 ms of pure parse.
 */
export function stepsForSans(startFen: string, sans: string[], userSide: 'w' | 'b'): BuilderStep[] {
  const out: BuilderStep[] = [];
  const w = new Walker(startFen);
  for (const san of sans) {
    const fen = w.fen;
    const side = w.side();
    const m = w.play(san);
    if (!m) break;
    out.push({
      fen, ply: out.length, side, moveSan: san, moveUci: m.uci,
      isUserMove: side === userSide,
      position: null,
      choice: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The registry wiring — at the BOTTOM, where every binding above is initialised.
// ---------------------------------------------------------------------------

/*
 * EVERY opening identification in the app goes through `bestOpeningForLine`, not through the
 * global matcher's registry tie-break.
 *
 * The tie-break only ever had one defensible use — "which of our books follows this line
 * furthest" — and it is not the answer to "which opening is this". At `d4 d5` both the London
 * System and the Queen's Gambit Declined follow two plies and the registry picked one, which is
 * how a London System card ended up recommending `c4`. Every caller that only wanted a label
 * inherited that, so the fix had to go here rather than at one call site, or the next consumer
 * would quietly reintroduce it.
 *
 * This used to be `registerOpeningMatcher(...)`, storing the matcher in a module-level `let`.
 * It is a plain import now: `bestOpeningForLine` does not pull in the repertoires eagerly at
 * module scope, because `openings.ts` is already imported at the top of this file, and the
 * registration dance existed only to avoid an import that is in fact unavoidable here.
 */
export const identifyOpening = (sans: string[]): string | null => bestOpeningForLine([sans])?.id ?? null;

/**
 * Advance one ply through a study tree.
 *
 * Returns the node list to continue from AFTER consuming `san`, or null when
 * the tree has no such move at this point. Prefers a VARIATION when that
 * variation is the move actually played: a variation is an alternative that
 * replaces the node's move, so once taken the rest of the line lives inside the
 * variation, not in the parent list.
 */
function descendTree(nodes: RepMove[], san: string): RepMove[] | null {
  const idx = nodes.findIndex((n) => n.san === san);
  if (idx >= 0) return nodes.slice(idx + 1);
  for (const n of nodes) {
    for (const v of n.variations) {
      if (v.length > 0 && v[0].san === san) return v.slice(1);
    }
  }
  return null;
}

/**
 * Walk the shipped study's tree from `sans`, resyncing at the deepest ply the
 * tree does NOT break before.
 *
 * `deepest` caps how far the tree may be asked to follow. The forgiving policy
 * passes `matchedPly` — `bestCoverage` has already established that the book
 * covers the line that deep, transpositions included, which is exactly what a
 * move-order difference is. The EXACT policy passes `sans.length`, and then a
 * shallow answer is a failure rather than a resync point: it is used only where
 * the continuation must start from the line's own last position (`withBookTail`).
 *
 * `verifyFrom` — when given, the continuation is only accepted if its FIRST move
 * is legal from that FEN. THIS IS THE GUARD THAT MAKES THE JOIN SOUND, and it is
 * not a formality. A tree match at depth N proves the book contains those N
 * plies; it does NOT prove the book's position after N is the position the line
 * actually reached, because `sans` may include plies the tree does not contain
 * (the very transposition the forgiving walk exists to allow). Measured case:
 *
 *   line:  ... Qd2 h6 Rad1 e5 Bg5 b5      (Black has just played b5)
 *   book:  "Study 8.5 — Kan" -> Bg5 b5 Nxc6 ...
 *
 * The book is a ply behind: it offers `Bg5 b5` as the NEXT two moves, but the
 * line already played both. Empty in the exact walk — and 108 of 134 lines were
 * rejected for exactly this, so without the guard the tail is always empty and
 * with it trusted blindly the board gets an illegal move. Both halves are needed:
 * the guard is what lets the walk be permissive.
 *
 * Returns null when the tree cannot follow a single ply, or when `verifyFrom` is
 * given and the continuation does not actually follow from it.
 */
function walkStudy(
  study: RepStudy,
  sans: string[],
  deepest: number,
  verifyFrom?: string,
): RepMove[] | null {
  const limit = Math.min(sans.length, Math.max(0, deepest));
  for (let n = limit; n >= 1; n--) {
    let nodes: RepMove[] | null = study.tree;
    for (const san of sans.slice(0, n)) {
      nodes = descendTree(nodes as RepMove[], san);
      if (nodes === null) break;
    }
    if (nodes === null) continue;
    if (nodes.length === 0) continue;
    if (verifyFrom !== undefined && !play(verifyFrom, nodes[0].san)) continue;
    return nodes;
  }
  return null;
}

/** Resolve the study and walk it, or null when nothing covers the line. */
function bookFrom(
  sans: string[],
  deepest: (matchedPly: number) => number,
  verifyFrom?: string,
  openingId?: string | null,
): { studyTitle: string; moves: string[] } | null {
  const hit = bestCoverageAcrossOpenings(sans, openingId);
  if (!hit || hit.coverage.matchedPly === 0) return null;
  const study = hit.coverage.study as RepStudy;
  const nodes = walkStudy(study, sans, deepest(hit.coverage.matchedPly), verifyFrom);
  if (nodes === null) return null;
  const moves = nodes.map((n) => n.san);
  if (moves.length === 0) return null;
  return { studyTitle: study.title, moves };
}

/*
 * THE FORGIVING WALK — resyncs, so it carries a DIVERGED line forward.
 *
 * The first version walked the whole move list and bailed at the first ply the
 * tree did not contain. That reads as obviously right and made the feature
 * nearly dead: measured on the reference corpus, ZERO of 122 built lines got a
 * book tail, even though `inBook` was true for almost all of them.
 *
 * The reason is that these lines are real games, not studies. A user's 16-ply
 * Sicilian is `e4 c5 b4 d5 exd5 cxb4 Nf3 Nf6 a3 …` — a gambit the book does
 * not teach inside its own `1...c5` study tree. So the merge never happened at
 * ply 1, and every later ply was a mismatch by construction.
 *
 * `bestCoverageAcrossOpenings` has ALREADY established that the book covers the
 * line to `matchedPly`, so the honest reading is: walk as deep as the tree
 * follows, and continue from there. What is given up is only the pretence that
 * the two move orders are identical.
 *
 * `verifyFrom` IS FORWARDED, which it was not until this was found by measurement rather than by
 * reading. It is what makes "continue from there" mean *here*: with no FEN, the resync depth is
 * the deepest ply the tree follows, and the answer is a continuation of the BOOK's position
 * rather than of the caller's. `walkStudy` already knows how to walk that depth down until the
 * book's next move is legal in a given position, and this is the only caller that supplies one.
 */
registerBookContinuation((sans, openingId, verifyFrom) =>
  bookFrom(sans, (matchedPly) => matchedPly, verifyFrom, openingId));

/*
 * HOW A "YOUR OPENINGS" DRILL CONTINUES.
 *
 * A drill built from one of the user's own decisions used to be that single move, so the
 * trainer asked one question and moved on — and the question was very often a recapture. This
 * is what turns it into a short opening sequence instead: OUR book picks the line up after the
 * user's move and the trainer asks again, several times, on moves that belong to the opening.
 *
 * The FORGIVING walk, deliberately. The user's move is by definition a move the book's tree may
 * not contain — that is why it needed a decision — so the exact-depth policy, which is what
 * `withBookTail` needs, returns nothing here far more often than it returns a line.
 */
registerDrillContinuation((sans, openingId) => {
  const book = continueFromBook(sans, false, undefined, openingId);
  return book && book.moves.length > 0 ? book.moves : null;
});

/**
 * THE EXACT WALK — the tree must follow every ply, and its answer must actually
 * be playable from where the line ends.
 *
 * Used to APPEND a tail to a finished line. Two distinct things go wrong without
 * it, and both were observed rather than imagined:
 *
 *   1. **The resync is shallower than the line ends.** The book then answers for
 *      a DIFFERENT position, and replaying its continuation onto the line's real
 *      end FEN makes every appended move illegal. That broke all 30 tails on the
 *      first attempt: the book offered `Nc6`, a Black move, where it was White
 *      to move.
 *   2. **The resync is a transposition, not the same position.** A tree match at
 *      depth N proves the book contains those N plies; it does NOT prove the
 *      book's position after N equals the line's position after all of `sans`.
 *      Measured: a line ending `... e5 Bg5 b5` was answered with the book's
 *      `Bg5 b5 Nxc6 ...` — a ply behind, offering as "next" two moves the line
 *      had already played. 108 of 134 lines hit this.
 *
 * The second is why the depth limit alone cannot work: the answer is only valid
 * if its first move is legal where the line stops. `withBookTail` performs that
 * check by replaying the tail onto the real board, so an invalid answer is
 * dropped rather than shown. The result is that a tail is appended only when the
 * book genuinely continues from the line's own position.
 */
registerBookExact((sans, verifyFrom, openingId) =>
  bookFrom(sans, () => sans.length, verifyFrom, openingId));

/**
 * Which study covers this line — the "ours" half of "his and ours".
 *
 * Uses the same forgiving match as the continuation, so a line the book can
 * carry is also a line the book can TEACH. Returned by `id`, because that is
 * what the course screen opens with (`onCourse(studyId)`).
 */
registerBookStudy((sans) => {
  const hit = bestCoverageAcrossOpenings(sans);
  if (!hit || hit.coverage.matchedPly === 0) return null;
  const study = hit.coverage.study as RepStudy;
  if (!study || !study.id) return null;

  /*
   * A STUDY ONLY ANSWERS FOR THE SIDE THAT HAS TO MOVE.
   *
   * `bestCoverageAcrossOpenings` scores books by how deep their line matches, and a shared prefix is
   * all it compares. So a position with BLACK to move could be matched to a WHITE study whose moves
   * happen to be legal there, and the caller would then build a drill out of it.
   *
   * This is not hypothetical. Measured on the reference corpus, `e4 e5 Nc3 Nf6 Bc4` with Black to
   * move matched `bio7.2` - "Bishop's Opening: the Vienna Hybrid, Spielmann Attack", chapter 7 of the
   * WHITE bishops-opening book. The user decided as Black and was handed White lines, which is
   * exactly the invented content the caller is supposed to refuse.
   *
   * The side is read from the move order rather than taken as an argument, because every caller already
   * passes `prefix + the move that was chosen`, and the decision sits after all but the last of them.
   * A caller that passed an empty list gets no study, which is the honest answer for a position with
   * nothing before it.
   */
  const turn = sans.length % 2 === 1 ? 'w' : 'b';   // the decision is the LAST ply of `sans`
  const bookSide = hit.opening?.side === 'white' ? 'w' : 'b';
  if (bookSide !== turn) return null;

  return { id: study.id, title: study.title };
});

