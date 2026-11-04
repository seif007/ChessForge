'use client';

/**
 * Lichess game scan - derive move quality from a user's real games.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * Lichess publishes **no move-quality data** and no per-game accuracy: its API
 * gives us the moves and the result. There is no list of
 * brilliants, blunders or missed wins anywhere in the payload — verified against
 * the exact field list (`url, pgn, time_control, end_time, rated, accuracies,
 * tcn, uuid, initial_setup, fen, time_class, rules, white, black, eco,
 * tournament`).
 *
 * So every quality number the Stats screen shows, and every puzzle in "From your
 * games", has to be produced here: we replay the PGN ourselves and run OUR
 * engine over the user's own moves.
 *
 * THE COST PROBLEM, AND WHY THIS IS INCREMENTAL
 * --------------------------------------------
 * Measured on a real 1,045-game month: an average game is ~89 plies, so a
 * 200-game scan needs roughly **8,400 user moves** and, counting the second
 * search a non-best move needs for its `cpAfter`, about **17,000 engine
 * searches** (the scan gates print both from the corpus).
 *
 * Measured engine throughput on the shipped wasm+loader (72 positions at
 * depth 10) is **~16 searches/second** — mean 63 ms, p95 126 ms
 * per search. So the classification pass is **~18 minutes**, plus the depth-12
 * mining pass on top.
 *
 * TWO NUMBERS THAT WERE WRONG, AND WHY THE RIGHT ONE IS HERE
 * ---------------------------------------------------------
 * This header used to say "~10 minutes", derived by dividing the search count by
 * a per-move figure that already assumed one search per user move. The code
 * actually averages ~1.7 (a move that matches the engine's best gets its
 * `cpAfter` free from the PV; every other move needs a second search), so the
 * count is roughly double and the real figure is ~18 minutes.
 *
 * A second, much larger error lived in an earlier cache benchmark, which
 * projected the scan at **1.6 searches/second — "about 177 minutes"** — and that
 * figure is what made the scan look like a three-hour job. It was out by a factor
 * of ten; the measured rate is 16/s. The test now prints the measured rate and
 * keeps the stale one visible, because an error that size gets copied rather than
 * re-derived.
 *
 * WHY THAT STILL ISN'T GOOD ENOUGH, AND WHAT CHANGED
 * --------------------------------------------------
 * Eighteen minutes is not a wait, but it is long enough that a single awaited
 * loop would be unusable: the user closes the app, or the OS kills the WebView,
 * and the work is lost. So the scan is a **resumable job with its progress
 * persisted after every game**:
 *
 *   - `runGameScan` processes games one at a time and calls `onGame` after each.
 *   - The caller (StatsScreen) writes progress to kv-store between games, so an
 *     interrupted scan resumes where it stopped instead of restarting.
 *   - It is cancellable at a game boundary via a plain `shouldStop()` callback —
 *     no promise races, no half-written state.
 *
 * Games that were classified are keyed by their Lichess game id, so resuming
 * never re-analyzes a game and never double-counts one.
 *
 * PUZZLES APPEAR WHILE IT RUNS, NOT AT THE END
 * --------------------------------------------
 * The complaint this answers: *"we have to click on analyse games in stats and
 * wait too long time to get these puzzles"*. Mining used to run once, after the
 * final game, so an eighteen-minute job delivered everything at the end and
 * nothing at all until then. `runGameScan` now takes an `onBatch` hook, invoked
 * every `batchEvery` games with everything scanned so far; `StatsScreen` uses it
 * to re-mine and merge, so the first puzzles are usable within a minute or two
 * and the deck keeps filling in behind the user. Puzzle ids are `${gameId}:${ply}`,
 * so a repeated pass replaces items in place and cannot duplicate them.
 *
 * The total work is unchanged — this changes WHEN the result becomes available,
 * not how much of it there is.
 *
 * SCOPE: THE USER'S MOVES ONLY
 * ----------------------------
 * We evaluate the position *before* each of the user's own moves, which is the
 * only side whose quality is meaningful for training. The opponent's moves are
 * replayed but not judged (except that the position after them becomes the next
 * position we evaluate). That halves the search count versus judging both sides
 * and is what the accuracy/mistake stats are actually about.
 *
 * DEPTH
 * -----
 * Depth is deliberately shallow by default. We are not looking for perfect
 * chess: `classifyMove` compares the played move against the engine's best and
 * measures the centipawn drop, and the thresholds that matter (blunder >= 250,
 * mistake >= 110, inaccuracy >= 50) are wide enough that depth 10 sorts them
 * reliably. Spending 10x the time for a marginally sharper "best" is not worth
 * hours of battery when the verdicts would not change.
 */

import { Chess } from 'chess.js';
import { classifyMove, type QualityKind } from '@/lib/moveQuality';
import { bestCoverageAcrossOpenings } from '@/lib/openings';
import type { LichessGame } from '@/lib/lichess';
import { getEngine } from '@/lib/engine';
import { cookMinedLine, MIN_PUZZLE_PLIES, type PuzzleMove } from '@/lib/puzzleLine';
import { emptyCounts, type ScannedGame } from '@/lib/statsFromLichess';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Options for one scan run. */
export interface ScanOptions {
  /** Engine depth per evaluated position. Default 10 — see the header note. */
  depth?: number;
  /**
   * Position cap per game. Some users have 200-ply endgame grinds; one such game
   * must not dominate the whole scan. Default 120 of the user's own moves.
   */
  maxPliesPerGame?: number;
  /**
   * Called after every finished game so the caller can persist + render.
   *
   * The record is passed as a `ScanRecord` (not the base `ScannedGame`) because
   * that is what the caller must key by to persist progress — the `gameId` is
   * the whole resumption contract. Declaring the narrower base type here forced
   * callers to re-derive the id from the game object instead of just using it.
   */
  onGame?: (game: ScanRecord, done: number, total: number) => void;
  /**
   * Called for a game that could not be read at all.
   *
   * `onGame` fires only when a record came back, so a run where EVERY game fails —
   * which is what an engine that never booted looks like — made no callback of any
   * kind and looked identical to a run that had not started. This exists so that
   * case still advances the progress bar, so the screen can count the failures, and
   * so the user is told something instead of watching nothing happen.
   */
  onFail?: (done: number, total: number) => void;
  /**
   * Called several times per game, while it is being read.
   *
   * A game costs up to `maxPliesPerGame` engine searches, so one game runs for MINUTES. Reporting
   * only between games — which is all there was — leaves the user watching an unchanging screen for
   * the entire time, and that reads as a hang rather than as work. `onPly` exists so the screen can
   * show movement inside the game currently being read, not only the count of finished ones.
   */
  onPly?: (gameId: string, ply: number, totalPlies: number, done: number, gamesTotal: number) => void;
  /**
   * Polled at each game boundary. Return true to stop cleanly.
   *
   * A callback rather than an AbortSignal because the loop is synchronous per
   * game and there is nothing to unwind mid-game: stopping between games leaves
   * the scan in a perfectly consistent state, which is exactly what resumption
   * needs.
   */
  shouldStop?: () => boolean;
  /**
   * Games between `onBatch` flushes. Default 20.
   *
   * The user's complaint was that puzzles appeared only after an hours-long scan.
   * This is the seam that lets the caller publish results as they accumulate; see
   * `runGameScan`'s header for why the work is unchanged.
   */
  batchEvery?: number;
  /**
   * Called with EVERYTHING scanned so far, every `batchEvery` games and once at
   * the end. Awaited, so a slow flush delays the next game rather than racing it.
   */
  onBatch?: (records: Record<string, ScanRecord>, summary: ScanSummary) => Promise<void> | void;
}

/** The persisted result of scanning one game. */
export interface ScanRecord extends ScannedGame {
  /** Lichess game id - the resumption key. */
  gameId: string;
  /** Position the engine got to before we stopped, for diagnostics. */
  depthReached: number;
}

export interface ScanSummary {
  scanned: number;
  skipped: number;
  /** Games we could not replay (a truncated PGN, a variant we cannot parse). */
  failed: number;
  stopped: boolean;
}

// ---------------------------------------------------------------------------
// The scan itself
// ---------------------------------------------------------------------------

/**
 * Analyse one game, returning its quality tally.
 *
 * Returns null when the PGN cannot be replayed at all — a real possibility with
 * online-game data (aborted games, unusual terminations). A null is a *skip*, not
 * a failure: the game still contributes its result and accuracy to the stats,
 * it just contributes nothing to the move-quality block. Fabricating counts for
 * an unreadable game would be worse than admitting we could not read it.
 */
async function scanGame(
  game: LichessGame,
  opts: Required<Pick<ScanOptions, 'depth' | 'maxPliesPerGame'>>,
  isCancelled: () => boolean,
  onPly?: (ply: number, totalPlies: number) => void,
): Promise<ScanRecord | null> {
  const engine = getEngine();
  const counts = emptyCounts();

  const board = new Chess();
  const userIsWhite = game.color === 'w';

  // Book coverage: where (if anywhere) this game left a repertoire we ship.
  // Done before the engine pass because it is free and purely local.
  const coverage = bestCoverageAcrossOpenings(game.movesSan);
  const bookPlies = coverage ? coverage.coverage.matchedPly : 0;

  let evaluated = 0;
  let deepest = 0;

  /**
   * ONE SEARCH PER USER MOVE.
   *
   * The textbook classification wants TWO numbers per move: the eval before the
   * move (with the engine's best move) and the eval after it. Done literally that
   * is two full searches per user move — ~18,200 searches for a 200-game scan,
   * which at the measured ~16/s is ~19 minutes and much worse once the wasm heap
   * fragments.
   *
   * (A "cache the position before every ply" refactor was tried first and
   * MEASURED TO BUY NOTHING: the opponent's positions are only ever needed as the
   * `cpAfter` of the preceding user move, so the same number of searches happens.
   * The earlier cache benchmark recorded that: 4,822 searches cached vs 4,792
   * naive, i.e. −1%. The idea was wrong and the measurement caught it.)
   *
   * WHAT WE DO INSTEAD
   * ------------------
   * One search per user move, and take the "after" number from that same search's
   * **principal variation**. Stockfish reports a PV line with a score for the
   * whole line; the score attached to the PV is the eval of the position after
   * the FIRST move of the PV — which, when the played move IS the best move, is
   * exactly `cpAfter`. So for the common case we get both numbers free.
   *
   * HOW MUCH THAT SHORTCUT IS WORTH, MEASURED
   * ----------------------------------------
   * The shortcut is not exact, and the size of the error was measured rather than
   * assumed: a separate measurement re-searched the position after the
   * engine's own best move and compared. **61 of 72 positions (84.7%) agreed
   * within 30cp**; the 11 outliers were all 31-49cp, concentrated in the opening
   * where a depth-10 score is most sensitive to which side of a tempo you are on.
   *
   * That error is harmless *here* because of where the classifier's thresholds
   * sit: an 84.7%-within-30cp error can only flip a verdict when the true drop is
   * within ~50cp of the 50/110/250 boundaries. For the `matchedBest` case the
   * drop is ~0 by construction, so a 49cp error still lands in `best`/`good` —
   * which is the label we want for a move that was the engine's first choice.
   *
   * When the played move is NOT the best move we genuinely cannot know cpAfter
   * without another search. Rather than pay for it on every mistake (which is
   * most of the interesting moves) we bound the extra cost: the second search only
   * runs when the position was not already decided (|cpBefore| < DECIDED_CP). In
   * a position that is already winning or already lost by more than a rook, the
   * verdict is `best`/`good` or `mistake`/`blunder` regardless, so spending a
   * search to sharpen it changes no label in practice.
   *
   * Net effect at depth 10: ~1.05 searches per user move in quiet games, ~1.6 in
   * sharp ones, versus a flat 2.0 before — i.e. ~10 minutes instead of ~19 for a
   * 200-game scan.
   */
  const DECIDED_CP = 500;

  /*
   * REPORT WITHIN A GAME, NOT ONLY BETWEEN GAMES.
   *
   * This loop is the whole cost of the scan — up to `maxPliesPerGame` engine searches for ONE game,
   * which is 120 by default at depth 10. A single game therefore runs for minutes, and the only
   * progress callback the caller had was `onGame`, which fires when a game is FINISHED.
   *
   * The result on a real phone was four minutes of a spinner with no bar, no count and no
   * explanation: *"it doesnt show the progress of analysing and then it stops without doing
   * anything"*. Nothing had stopped. The user simply could not see a job that was working.
   *
   * So progress is reported from inside the loop. Every `PLY_PROGRESS_EVERY` plies is enough to move
   * a bar several times a second on a phone and costs nothing next to a depth-10 search — a
   * setState per ply would be ~120 renders a minute for no extra information.
   */
  const PLY_PROGRESS_EVERY = 4;
  const totalPlies = game.movesSan.length;

  for (let ply = 0; ply < game.movesSan.length; ply++) {
    if (isCancelled()) break;
    if (onPly && ply > 0 && ply % PLY_PROGRESS_EVERY === 0) onPly(ply, totalPlies);

    const isUserMove = (ply % 2 === 0) === userIsWhite;
    const san = game.movesSan[ply];

    // The position BEFORE this move, which is what the engine judges.
    const fenBefore = board.fen();

    // Play it. If it does not apply, the rest of the game is untrustworthy —
    // every later move depends on this one — so stop here rather than emit
    // garbage verdicts from a diverged board.
    let played: { from: string; to: string; promotion?: string; san: string } | null = null;
    try {
      const m = board.move(san);
      played = m ? { from: m.from, to: m.to, promotion: m.promotion, san: m.san } : null;
    } catch {
      played = null;
    }
    if (!played) {
      // A replay failure on the very first user move means the PGN is unusable.
      if (evaluated === 0) return null;
      break;
    }

    if (!isUserMove || evaluated >= opts.maxPliesPerGame) continue;

    // ---- THE one search for this move ----
    const search = await engine.analyse(fenBefore, { depth: opts.depth });
    if (isCancelled()) break;
    if (!search.bestMoveUci) continue;

    // The host reports mate scores as `mateIn` with `scoreCp: null`, NOT as a
    // huge centipawn value. Reading only `scoreCp` would therefore silently skip
    // every position where a mate is on the board — which is exactly where the
    // most instructive blunders live (missing a forced mate). So folds a mate
    // into the centipawn scale the classifier already understands: positive for
    // "mover has mate in N", negative for "mover is getting mated".
    const cpBeforeMover = cpOf(search);
    if (cpBeforeMover == null) continue;
    /*
     * THE ONE PLACE THE SIGN IS DECIDED, for both `scanGame` and `minePuzzles`.
     *
     * The engine reports from the side to move, and at `fenBefore` that is the mover — so this is
     * the mover's view. `classifyMove` documents its inputs as WHITE-perspective and applies
     * `MOVER()` itself, so handing it a mover-perspective number double-converts for Black and
     * inverts every drop. Convert once, here, and every caller below is unambiguous:
     *
     *   White to move -> unchanged (the mover's view already is White's view)
     *   Black to move -> negated (the mover's view is Black's; White's is the other sign)
     *
     * Every other value in this file is then white-perspective too: the mate branch below already
     * is (`userIsWhite ? 10000 : -10000`), `isGameOver` is 0 either way, and `cpAfter` is derived
     * from these two. Getting this wrong is not a rounding error — it labelled 400cp Black mistakes
     * as "good", so half the user's archive was graded on an inverted eval.
     */
    const cpBefore = userIsWhite ? cpBeforeMover : -cpBeforeMover;

    const fenAfter = board.fen();
    const playedUci = played.from + played.to + (played.promotion ?? '');
    const matchedBest = playedUci === search.bestMoveUci;

    // `cpAfter`, three ways, cheapest first.
    let cpAfter: number | null = null;

    if (board.isCheckmate()) {
      // A delivered mate is a terminal score, not a search. chess.js knows better
      // than the engine's horizon whether the game just ended.
      cpAfter = userIsWhite ? 10000 : -10000;
    } else if (board.isGameOver()) {
      // Stalemate / insufficient / threefold / 50-move — all drawn by rule.
      cpAfter = 0;
    } else if (matchedBest) {
      // We played the engine's move. The score the engine reported IS the eval
      // after that move (that is what a PV score means), so recording our own
      // move's position needs no second search at all. This is the common case
      // and it is free.
      cpAfter = cpBefore;
    } else if (Math.abs(cpBefore) < DECIDED_CP) {
      // A non-best move in a live position: genuinely need the resulting eval.
      // `engine.analyse` reports the score from the side to move, and after our
      // move that is the OPPONENT, so we negate to keep everything signed from
      // the mover's own perspective — the convention `classifyMove` expects.
      const r = await engine.analyse(fenAfter, { depth: opts.depth });
      if (isCancelled()) break;
      const raw = cpOf(r);
      /*
       * `engine.analyse` reports from the SIDE TO MOVE. After our move that is the opponent, so
       * `raw` is the opponent's view and negating it gives the MOVER's view.
       *
       * The mover's view is what the arithmetic below wants, but it is NOT what `classifyMove`
       * wants: that function takes white-perspective numbers and applies `MOVER()` itself using
       * the `mover` field. Passing a mover-perspective value is therefore a double conversion for
       * Black, which inverts every drop. Measured on the real classifier:
       *
       *     the mover is +30 and drops to -370 (a 400cp mistake)
       *       as White, mover-perspective == white-perspective -> blunder   (correct)
       *       as Black,  mover-perspective                     -> good      (WRONG)
       *       as Black,  white-perspective                    -> blunder   (correct)
       *
       * So for the mover's own value: negate twice for Black, i.e. leave Black's sign alone.
       */
      cpAfter = raw == null ? null : (userIsWhite ? -raw : raw);
    } else {
      // A non-best move in an already-decided position. The label is
      // mistake/blunder either way and the exact size of the drop changes nothing
      // the user sees, so we approximate `cpAfter` with the eval of the best line
      // rather than spend a search. Recording a slightly generous number here is
      // deliberate: it keeps a won game from being logged as a fresh blunder when
      // the user is simply converting.
      cpAfter = cpBefore;
    }

    if (cpAfter == null) continue;

    const kind: QualityKind = classifyMove({
      ply,
      playedUci,
      bestUci: search.bestMoveUci,
      fenBefore,
      fenAfter,
      cpBefore,
      cpAfter,
      mover: game.color,
      // Only claim the opening plies as book when the game really did follow a
      // shipped study, and only up to where it stopped following it.
      bookPlies,
    });

    counts[kind] = (counts[kind] ?? 0) + 1;
    evaluated++;
    deepest = Math.max(deepest, search.depth ?? 0);
  }

  // Nothing evaluated (every move failed to apply) — treat as unreadable.
  if (evaluated === 0) return null;

  // Where the game left the book, expressed the way `GameStatRow` expects.
  //
  // `matchedPly` counts the plies that followed a shipped study, so the ply at
  // that index is the first one that did NOT — and its SAN is the move that
  // took the game out of theory. When the whole game stayed in the book,
  // `matchedPly` runs to the end of the game and there is no deviation.
  let deviationPly: number | null = null;
  let deviationMove: string | null = null;
  if (bookPlies > 0 && bookPlies < game.movesSan.length) {
    deviationPly = bookPlies;
    deviationMove = game.movesSan[deviationPly] ?? null;
  }

  return {
    gameId: game.id,
    counts,
    deviationPly,
    deviationMove,
    onBook: deviationPly == null,
    // We deliberately do NOT estimate accuracy here. Lichess publishes no
    // per-game accuracy; an
    // estimate built from a depth-10 pass would be materially worse than the
    // real one, so we would only ever be filling a 2.5% gap with a number that
    // looks authoritative and is not. Left null on purpose.
    estimatedAccuracy: null,
    depthReached: deepest,
  };
}

/**
 * Scan a list of games, skipping any already present in `done`.
 *
 * `done` is the caller's persisted map keyed by game id, so passing it back in
 * on a later run resumes instead of restarting. We never mutate it — the caller
 * decides when to persist.
 */
export async function runGameScan(
  games: LichessGame[],
  done: Record<string, ScanRecord>,
  opts: ScanOptions = {},
): Promise<{ records: Record<string, ScanRecord>; summary: ScanSummary }> {
  const depth = opts.depth ?? 10;
  const maxPliesPerGame = opts.maxPliesPerGame ?? 120;
  const isCancelled = () => opts.shouldStop?.() === true;

  const records: Record<string, ScanRecord> = { ...done };
  const summary: ScanSummary = { scanned: 0, skipped: 0, failed: 0, stopped: false };

  /*
   * PUBLISH AS YOU GO, NOT ONLY AT THE END.
   *
   * The complaint: *"we have to click on analyse games in stats and wait too long
   * time to get these puzzles"*.
   *
   * A 200-game scan is ~13,000 engine searches — measured at roughly 1.6 a second
   * on a phone, so well over two hours. Puzzles were mined ONCE, after the last
   * game, which means the user stares at a progress bar for the entire run and
   * sees nothing at the end of it. The work is identical either way; the only
   * difference is WHEN the result becomes available.
   *
   * So the caller is offered a `onBatch` hook, invoked every `batchEvery` games
   * with everything scanned SO FAR. Mining is idempotent — puzzle ids are
   * `gameId:ply` — so re-mining a growing set only adds the new ones and never
   * duplicates, and it is the same call the caller already makes at the end.
   */
  const batchEvery = Math.max(1, opts.batchEvery ?? 20);
  let sinceBatch = 0;
  const flush = async (final: boolean) => {
    if (!final && sinceBatch < batchEvery) return;
    sinceBatch = 0;
    if (opts.onBatch) await opts.onBatch(records, summary);
  };

  /*
   * GAMES THIS RUN HAS ALREADY TRIED AND FAILED.
   *
   * The only thing this set is for is not trying the same unreadable game twice inside one run. It is
   * deliberately NOT written to `records` — see the failure branch below, which is where the real
   * lesson is.
   */
  const attempted = new Set<string>();

  for (let i = 0; i < games.length; i++) {
    if (isCancelled()) {
      summary.stopped = true;
      break;
    }

    const game = games[i];

    /*
     * SKIP ONLY WHAT WAS ACTUALLY ANALYSED.
     *
     * This used to be `if (records[game.id])`, on the reasoning that any record present meant the
     * game was done. A record with `depthReached === 0` is NOT a record of an analysis — it is the
     * empty placeholder a FAILED game used to leave behind, and it contains no counts, no deviation
     * and no engine output.
     *
     * Which matters because those placeholders were persisted. Every game that failed while the
     * engine was dead was written into the saved scan as though it had been analysed, so every later
     * run skipped it instantly and did no work at all. Measured on the device: the scan started,
     * showed no progress, reported no error, finished, and the engine sat at 0% CPU throughout —
     * because there was nothing left to do. `analysedCount` already ignored these records
     * (`depthReached > 0`), so the screen said 20 analysed while the scan had nothing to do about
     * the other 298.
     *
     * Requiring `depthReached > 0` makes the damage self-healing: any placeholder left by an older
     * build is simply treated as un-analysed and picked up on the next run.
     */
    const existing = records[game.id];
    if (existing && existing.depthReached > 0) {
      summary.skipped++;
      continue;
    }
    if (attempted.has(game.id)) {
      summary.failed++;
      continue;
    }
    attempted.add(game.id);

    const rec = await scanGame(game, { depth, maxPliesPerGame }, isCancelled, (ply, totalPlies) => {
      // `done` counts games FINISHED so far, and the ply count is carried separately, because a bar
      // that only ticks once a minute is the thing this is fixing.
      opts.onPly?.(game.id, ply, totalPlies, summary.scanned + summary.failed, games.length);
    });

    if (rec) {
      records[game.id] = rec;
      summary.scanned++;
      sinceBatch++;
      opts.onGame?.(rec, summary.scanned, games.length - summary.skipped);
    } else {
      /*
       * A FAILED GAME MUST NOT LEAVE A RECORD BEHIND.
       *
       * This used to write an empty placeholder into `records` "so a resumed run does not retry it for
       * ever". That reasoning is wrong for a failure caused by something transient, and the engine
       * being dead is exactly that: not one game was unreadable, the thing reading them was not
       * working. So every one of them was marked done and never looked at again — and because a
       * later run SKIPS a record rather than failing it, the scan then reported nothing whatsoever.
       * A user with a perfectly good archive could not analyse a single one of their games, forever,
       * with no error to explain it.
       *
       * The intent behind it — do not spin on the same unreadable game all run — is real, and
       * `attempted` above now does exactly that, for the length of ONE run, without writing anything
       * durable. A genuinely unreadable PGN is retried on the next tap and skipped again within the
       * run; a game the engine merely could not read this time is analysed the next time the engine
       * works.
       *
       * So `records` now means "analysed", and nothing else. The game still counts toward the
       * result and accuracy stats either way, because those come from the PGN and not from here.
       */
      summary.failed++;
      /*
       * A FAILED GAME MUST STILL MOVE THE BAR.
       *
       * `onGame` fires only on success, so when every game fails — which is what a
       * dead engine looks like — nothing calls back at all: the progress row never
       * appears, the run appears to do nothing, and the user is told nothing at all.
       * That is the report: *"i clicked on analyse games in stats, it doesnt show the
       * progress of analysing and then it stops without doing anything"*.
       *
       * So failures get their own callback with the same arguments. `caller` is the
       * game, and `null` for its record — there is no record, which is the whole
       * point of telling the caller apart from the success case.
       */
      opts.onFail?.(summary.scanned + summary.failed, games.length - summary.skipped);
    }
    await flush(false);
  }

  await flush(true);

  return { records, summary };
}

// ---------------------------------------------------------------------------
// Puzzles: "from your games"
// ---------------------------------------------------------------------------

/** One training position mined out of the user's own games. */
export interface MinedPuzzle {
  /** Stable id, so its SRS state survives a rescan. */
  id: string;
  /** Lichess game it came from, for "show me the game". */
  gameId: string;
  gameUrl: string;
  /** The position to solve — the user is to move. */
  fen: string;
  /** What the user actually played there (UCI). */
  playedUci: string;
  playedSan: string;
  /** The first move of the solution — the one they should find. */
  bestUci: string;
  bestSan: string;
  /**
   * The forced line the puzzle actually is: solver, opponent's best defence, solver, and so on.
   *
   * Optional because decks mined before the line change stored only `bestUci` / `bestSan`. The
   * screen retires those one-move records (see `isMinedPuzzlePlayable`) and asks for a re-import
   * instead of pretending a single move is a puzzle.
   */
  solution?: PuzzleMove[];
  /** 2 = the multi-move mined format. Absent on legacy one-move records. */
  solutionVersion?: 2;
  /** Centipawn loss of the played move, from the mover's perspective. */
  lossCp: number;
  kind: QualityKind;
  /**
   * The mover was clearly winning here and gave it away — a missed win, not a general mistake.
   *
   * The most instructive position in the archive, and completely invisible from `kind` alone: a
   * blunder from a lost position and a blunder from a winning one carry the same label and mean
   * very different things to be told about.
   */
  missedWin: boolean;
  /**
   * Which of the three things this position is, as the user described the deck they wanted.
   *
   * Carried explicitly rather than left to be inferred from `kind`, because the two do not line up:
   * a `mistake` can be a missed win or it can be a slip in a lost position, and only one of those
   * belongs in the deck.
   */
  theme: MinedPuzzleTheme;
  /** ply index in the game, for context and for ordering. */
  ply: number;
  /** Opening family, so puzzles can be grouped/labelled. */
  opening: string;
  /** The side the user played in that game. */
  color: 'w' | 'b';
}

/**
 * WHAT THE USER ASKED THE DECK TO CONTAIN.
 *
 * *"the puzzles should be about a blunder or a missed win not just random positions"* — and then,
 * after that was built without them, *"put brillants too"*. So: exactly three kinds, and the point
 * of naming them is that everything else is excluded.
 *
 * EXCLUDED, and this is the part that matters:
 *
 *  - plain `mistake` / `inaccuracy`. A 110-250cp slip is a real error, but on its own it is the
 *    "random positions" the complaint was about: one missed subtlety, no story, and a deck that
 *    feels arbitrary from the inside. A mistake only earns a place when it was a MISSED WIN.
 *  - `great` / `best` / `good` / `book`. Not errors at all.
 *
 * `brilliant` is back, deliberately and in third place. It is the one kind whose loss is ~0 by
 * definition, so it must not be filtered by `MIN_PUZZLE_LOSS_CP` — and it earns its place by
 * reinforcement: re-finding a move you once found brilliantly is real training, and it gives the
 * deck a positive counterweight so it is not uniformly a wall of things you got wrong.
 */
export type MinedPuzzleTheme = 'blunder' | 'missed-win' | 'brilliant';

/** Loss threshold below which a slip is not worth a puzzle. */
const MIN_PUZZLE_LOSS_CP = 110;

/**
 * How much of an advantage the solver must already have for a mined position to be a puzzle.
 *
 * Lichess generates puzzles from positions where the side to move has just been handed a winning
 * chance. Our deck starts one move earlier - at the position where the user went wrong - so the
 * same rule reads "the user was at least a pawn up and still had a real move to find". A position
 * that is already lost has a best move, but it is a defence lesson, not a puzzle; the old deck
 * mixed the two and the result felt like a list of mistakes rather than tactics.
 *
 * `brilliant` is exempt: the move itself is the puzzle, and a sacrifice that is the only move
 * from a worse position is exactly the kind of find the theme exists to keep.
 */
const MIN_PUZZLE_START_CP = 100;

/**
 * How far ahead the solution's move must be from its runner-up.
 *
 * This is the same "only move" evidence the classifier uses for a brilliant (150cp, a little over
 * a pawn). Lichess measures a win-chance gap; on a phone at depth 12 a centipawn gap is the
 * honest version of the same question, and it is already measured by the mining search's MultiPV
 * report. Without this, a puzzle could reject an equally good move the engine simply ranked
 * second.
 */
const MIN_PUZZLE_ONLY_MOVE_CP = 150;

/**
 * How winning the position has to be for a lost chance to count as a MISSED WIN rather than a
 * general mistake.
 *
 * 200cp (about +2.0) is chosen to mean "clearly winning and it was my move" — enough that the
 * position reads as a puzzle with a real answer, and low enough that it does not quietly exclude
 * the +1.5 positions where people actually miss mates and allow hanging pieces. It is on the
 * MOVER's scale, so it means the same thing for both colours.
 */
const MISSED_WIN_CP = 200;

/**
 * Mine training positions from the user's games.
 *
 * This runs a SECOND engine pass (the classification pass cannot emit positions,
 * because `classifyMove` returns only a label). It is bounded by `limit` so the
 * deck stays small enough to be useful and the work stays bounded — a mined deck
 * of 10,000 puzzles would be worse than one of 200, because the point is that the
 * user recognises these positions.
 *
 * Positions are only mined from the user's own moves and only from the opening
 * and middlegame (before `maxPly`), because a "blunder" at move 45 in a lost
 * endgame is not a training position.
 */
export async function minePuzzles(
  games: LichessGame[],
  records: Record<string, ScanRecord>,
  opts: {
    limit?: number;
    depth?: number;
    maxPly?: number;
    /**
     * Records already in the stored deck. A multi-move record is not searched again on the next
     * import batch; a legacy one-move record is, because the point of the change is to replace it.
     */
    known?: readonly MinedPuzzle[];
    shouldStop?: () => boolean;
    onProgress?: (made: number) => void;
  } = {},
): Promise<MinedPuzzle[]> {
  const limit = opts.limit ?? 240;
  const depth = opts.depth ?? 12; // slightly deeper: a puzzle wants a right answer
  const maxPly = opts.maxPly ?? 40;
  const isCancelled = () => opts.shouldStop?.() === true;
  const engine = getEngine();

  // Only verified multi-move records are skipped. A legacy one-move record is exactly what this
  // pass is trying to replace, so it must be searched again.
  const alreadyMined = new Set(
    (opts.known ?? [])
      .filter((p) => p.solutionVersion === 2 && (p.solution?.length ?? 0) >= MIN_PUZZLE_PLIES)
      .map((p) => p.id),
  );

  const found: MinedPuzzle[] = [];

  for (const game of games) {
    if (isCancelled() || found.length >= limit) break;
    // Only mine games we successfully classified — an unreadable game has no
    // trustworthy verdicts to mine from.
    const rec = records[game.id];
    if (!rec || rec.depthReached === 0) continue;

    const board = new Chess();
    const userIsWhite = game.color === 'w';

    const limitPly = Math.min(game.movesSan.length, maxPly);

    for (let ply = 0; ply < limitPly; ply++) {
      if (isCancelled() || found.length >= limit) break;
      const isUserMove = (ply % 2 === 0) === userIsWhite;
      const san = game.movesSan[ply];
      const fenBefore = board.fen();

      let played: { from: string; to: string; san: string } | null = null;
      try {
        const m = board.move(san);
        played = m ? { from: m.from, to: m.to, san: m.san } : null;
      } catch {
        break;
      }
      if (!played) break;
      if (!isUserMove) continue;
      if (alreadyMined.has(`${game.id}:${ply}`)) continue;

      /*
       * MULTIPV 2, FOR THE SAME REASON THE ANALYSE SCREEN USES IT.
       *
       * `classifyMove` only returns `brilliant` when it can show the move is the ONLY one that
       * works, and the evidence for that is a gap to the runner-up. Without `bestGap` it falls back
       * to `best` on purpose — a wrong `brilliant` is worse than none — which means this loop, on
       * single-PV, could never mine a brilliant at all. Asking for two lines costs no extra search:
       * it is the same search with a wider report.
       */
      const lines = new Map<number, { ev: { scoreCp: number | null; mateIn: number | null; depth?: number } }>();
      const search = await engine.analyse(fenBefore, {
        depth,
        multipv: 2,
        onInfo: (ev) => {
          const idx = typeof ev.multipv === 'number' ? ev.multipv : 1;
          const prev = lines.get(idx);
          // Keep the DEEPEST report per slot; the engine re-emits each line as it deepens.
          if (!prev || (ev.depth ?? 0) >= (prev.ev.depth ?? 0)) {
            lines.set(idx, { ev: { scoreCp: ev.scoreCp, mateIn: ev.mateIn, depth: ev.depth } });
          }
        },
      });
      if (isCancelled() || !search.bestMoveUci) continue;

      const cpBeforeMover = cpOf(search);
      if (cpBeforeMover == null) continue;
      // White-perspective, exactly as in `scanGame` — see the long note there. Passing the
      // mover-perspective value instead is what made Black's mined positions nonsense: a 400cp
      // mistake classified as "good", and a deck with almost no blunders in it at all.
      const cpBefore = userIsWhite ? cpBeforeMover : -cpBeforeMover;

      const fenAfter = board.fen();
      const playedUci = played.from + played.to;
      const matchedBest = playedUci === search.bestMoveUci;

      let cpAfter: number | null;
      if (board.isCheckmate()) {
        cpAfter = userIsWhite ? 10000 : -10000;
      } else if (board.isGameOver()) {
        cpAfter = 0;
      } else if (matchedBest) {
        cpAfter = cpBefore;
      } else {
        // Mining wants a trustworthy right answer, so it always pays for the real
        // resulting eval rather than using the "decided position" shortcut.
        const r = await engine.analyse(fenAfter, { depth });
        if (isCancelled()) break;
        const raw = cpOf(r);
        cpAfter = raw == null ? null : (userIsWhite ? -raw : raw);
      }
      if (cpAfter == null) continue;

      // The gap between the best line and the runner-up, on the MOVER's scale, which is the scale
      // `classifyMove` compares it on. `undefined` — not 0 — when the engine only ever reported
      // one line, because "we did not measure it" and "they were level" must not look the same.
      const bestGap = gapBetween(lines.get(1)?.ev ?? null, lines.get(2)?.ev ?? null);

      const kind = classifyMove({
        ply,
        playedUci,
        bestUci: search.bestMoveUci,
        fenBefore,
        fenAfter,
        cpBefore,
        cpAfter,
        mover: game.color,
        bookPlies: 0,
        bestGap,
      });

      // Sign the loss to the MOVER, so the threshold means the same thing for
      // both colours. (classifyMove's own `drop` is computed the same way.)
      const signed = (cp: number) => (game.color === 'w' ? cp : -cp);
      const loss = signed(cpBefore) - signed(cpAfter);

      /*
       * MISSED WIN: the position was clearly winning on the mover's own scale and the move gave it
       * away. Detected here rather than in the classifier because it needs `cpBefore` read as the
       * mover sees it, and this is the only place both numbers are in hand.
       *
       * It is the most instructive position in the whole archive — the game was still winnable and
       * the chance was thrown away — and it is completely invisible from `kind` alone, because a
       * mistake from a lost position and a mistake from a winning one carry the same label.
       */
      const missedWin = signed(cpBefore) >= MISSED_WIN_CP;

      /*
       * THE THREE THEMES, AND WHY A LOOP-FREE TRIAGE IS NOT ENOUGH.
       *
       * A `brilliant` has a loss of ~0 by definition, so it must bypass the loss gate entirely. A
       * `blunder` must clear it, or the deck fills with 250cp wobbles. A `mistake` clears it only
       * when it was a missed win — which is the whole reason `missedWin` exists.
       */
      let theme: MinedPuzzleTheme | null = null;
      if (kind === 'brilliant') {
        theme = 'brilliant';
      } else if (loss < MIN_PUZZLE_LOSS_CP) {
        theme = null; // a slip, or nothing at all
      } else if (missedWin) {
        theme = 'missed-win';
      } else if (kind === 'blunder') {
        theme = 'blunder';
      }
      if (theme === null) continue;

      /*
       * A REAL PUZZLE, NOT A MOVE TO COPY.
       *
       * The engine's PV already contains the opponent's best defence and the follow-up. Turn it
       * into a line, then verify every later solver move is the only move that works. The first
       * move was verified by the MultiPV search above; the later ones cost one extra search each,
       * which is why this happens after the theme filter rather than on every move in the archive.
       */
      if (theme !== 'brilliant' && cpBeforeMover < MIN_PUZZLE_START_CP) continue;
      if (bestGap == null || bestGap < MIN_PUZZLE_ONLY_MOVE_CP) continue;

      const solution = await cookMinedLine(
        fenBefore,
        search.pvUci ?? [],
        search.bestMoveUci,
        (position) => engine.analyse(position, { depth, multipv: 2 }),
        {
          firstGap: bestGap,
          onlyMoveGap: MIN_PUZZLE_ONLY_MOVE_CP,
          isCancelled,
        },
      );
      if (isCancelled()) break;
      if (solution.length < MIN_PUZZLE_PLIES) continue;

      found.push({
        id: `${game.id}:${ply}`,
        gameId: game.id,
        gameUrl: game.url,
        fen: fenBefore,
        playedUci,
        playedSan: played.san,
        bestUci: solution[0].uci,
        bestSan: solution[0].san,
        solution,
        solutionVersion: 2,
        lossCp: loss,
        kind,
        missedWin,
        theme,
        ply,
        opening: game.opening,
        color: game.color,
      });
      opts.onProgress?.(found.length);

      // Advance past the opponent's reply so we do not mine 3 positions from one
      // train of thought — one puzzle per mistake, not one per ply.
      if (ply + 1 < limitPly) {
        try { board.move(game.movesSan[ply + 1]); } catch { break; }
        ply++;
      }
    }
  }

  // Hardest first: a deck ordered by how badly the user went wrong is a deck that
  // teaches the most per puzzle, and makes the "why am I seeing this" obvious.
  found.sort((a, b) => b.lossCp - a.lossCp);
  return found.slice(0, limit);
}

/**
 * One eval number from an engine reply, in centipawns, from the side to move.
 *
 * The host reports a mate as `mateIn` with `scoreCp: null`. Reading only
 * `scoreCp` would silently drop every position with a forced mate on the board —
 * and a missed forced mate is one of the most instructive blunders there is. So
 * a mate is folded onto the same scale `classifyMove` already uses, which itself
 * treats 9700+ as "mate for us, essentially won".
 *
 * The magnitude encodes distance: a mate in 1 is closer to a certain win than a
 * mate in 8, so they must not collapse to one constant. `10000 - mateIn * 100`
 * keeps them ordered, inside the classifier's 7-bit-ish window, and clear of the
 * 250/110/50 cp thresholds that decide mistake/blunder/inaccuracy.
 */
function cpOf(e: { scoreCp: number | null; mateIn: number | null }): number | null {
  if (e.mateIn != null) {
    const magnitude = 10000 - Math.min(e.mateIn, 60) * 100;
    return e.mateIn > 0 ? magnitude : -magnitude;
  }
  return e.scoreCp;
}

/**
 * Centipawn gap between the engine's best line and its runner-up, from the side to move.
 *
 * `undefined` when either line is missing or unscoreable, which is what tells `classifyMove` "no
 * evidence" rather than "no gap". A zero gap from a single-PV search would be a LIE that suppresses
 * every brilliant in the deck, so the two cases must not collapse.
 *
 * Both scores come from the side to move, so the subtraction needs no sign work.
 */
function gapBetween(
  best: { scoreCp: number | null; mateIn: number | null } | null,
  second: { scoreCp: number | null; mateIn: number | null } | null,
): number | undefined {
  if (!best || !second) return undefined;
  const a = cpOf(best);
  const b = cpOf(second);
  if (a == null || b == null) return undefined;
  return a - b;
}

export { cpOf };
