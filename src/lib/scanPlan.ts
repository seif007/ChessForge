/**
 * WHAT ONE LICHESS IMPORT IS — one definition, run by anything that asks for it.
 *
 * WHY THIS EXISTS AS A MODULE
 * ---------------------------
 * The scan first lived inside the Stats screen. The owner's later request was that the other
 * screens that need it — "From your games" in Puzzles, the empty state of Your openings — let the
 * user connect and import IN PLACE instead of being told to go to Stats. Two screens running
 * their own copy of a 200-game engine scan would drift the moment either one was tuned: a depth
 * changed on one side, a cap on the other, and the two decks would disagree about the same
 * account.
 *
 * So the plan lives here. It is `keptScanGames` (what a scan reads), the depth/ply/cap constants
 * (how hard it looks), `mergeMinedPuzzles` (how the deck grows), and `importGames` (the driver
 * itself). Progress and cancellation are callbacks rather than state, so Stats can keep its
 * detailed progress UI while a small empty-state card shows a plain bar — same scan, two surfaces.
 */

import type { LichessGame } from '@/lib/lichess';
import {
  runGameScan, minePuzzles, type ScanRecord, type MinedPuzzle,
} from '@/lib/gameScan';
import {
  loadScanState, saveScanState, saveScanRecords, clearCachedPositions,
} from '@/lib/lichessStore';
import { isMinedPuzzlePlayable } from '@/lib/puzzleLine';

/** How many of the most recent kept games a scan covers. */
export const SCAN_GAMES = 200;

/**
 * Engine depth per analysed position.
 *
 * Deliberately cheap, and the number is the point: this ran at depth 10, which on a phone is a
 * minute or more for ONE game, so the scan produced no visible progress for minutes at a time. At
 * depth 8 a blunder is still a blunder — the classification pass is for finding positions worth
 * training, not for settling them exactly.
 */
export const SCAN_DEPTH = 8;

/**
 * Positions analysed per game, and the single biggest lever on how long a scan takes.
 *
 * 40 plies is 20 of the user's own moves, which is enough to place a game's quality profile and to
 * mine its most instructive positions. It was 120 — a minute or more per game on a phone, across
 * 200 games, with no feedback until a whole game finished. Raising this is the first thing to try
 * if the analysis is ever judged too coarse; the cost is linear in this number.
 */
export const SCAN_MAX_PLIES = 40;

/**
 * Cap on the mined puzzle deck.
 *
 * Deliberately small. The point of "From your games" is recognition — the user must look at a
 * position and think "this was MY game" — so a deck of 10,000 positions is strictly worse than
 * one of 240: it buries the memorable ones and costs a second engine pass over every game.
 */
export const MINED_PUZZLE_LIMIT = 240;

/** Mining depth. Slightly deeper than classification: a puzzle wants a fair, findable answer. */
export const MINE_DEPTH = 12;

/** Plies mining looks at per game — opening and middlegame only. A "blunder" at move 45 is not a
 *  training position. */
export const MINE_MAX_PLY = 40;

/**
 * Games between mid-scan mining passes.
 *
 * Twenty is the trade-off measured against the complaint this fixes: small enough that the first
 * puzzles show up within a minute or two of starting (a game takes a few seconds, so 20 games is
 * ~1-2 minutes), large enough that mining's own engine pass does not dominate the scan. Every pass
 * is idempotent, so this is a quality-of-experience knob, not a correctness one.
 */
export const MINE_EVERY = 20;

/**
 * The games a scan is willing to read, newest first.
 *
 * `fetchAllGames` already sorts newest first, and the filter keeps only rated non-bullet games
 * with real moves — a bullet game is noise the user never had time to think in, and the owner's
 * rule was "rated + rapid/blitz only".
 */
export function keptScanGames(games: readonly LichessGame[]): LichessGame[] {
  return games
    .filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 4)
    .slice(0, SCAN_GAMES);
}

/**
 * Merge freshly mined puzzles into the stored deck: newest-hardest first, capped.
 *
 * Ids are `${gameId}:${ply}`, so a repeated pass replaces items in place and cannot duplicate
 * them, and a rescan of a longer history cannot grow the deck without bound.
 */
export function mergeMinedPuzzles(previous: readonly MinedPuzzle[], mined: readonly MinedPuzzle[]): MinedPuzzle[] {
  const byId = new Map<string, MinedPuzzle>();
  for (const p of previous) byId.set(p.id, p);
  for (const p of mined) byId.set(p.id, p);
  /*
   * A LEGACY ONE-MOVE RECORD MUST NOT CROWD OUT A REAL PUZZLE.
   *
   * The deck is capped, and the old format sorted purely by loss. A 240-position legacy deck
   * could therefore fill every slot with the one-move quiz this change retires, hiding the new
   * multi-move positions no matter how many were mined. Playable lines come first; legacy records
   * only fill whatever room is left (and the screen hides them until a re-import replaces them).
   * When every record is legacy - as in the gate's synthetic deck - this is exactly the old
   * loss-sorted order.
   */
  const all = [...byId.values()].sort((a, b) => b.lossCp - a.lossCp);
  const playable = all.filter(isMinedPuzzlePlayable);
  const legacy = all.filter((p) => !isMinedPuzzlePlayable(p));
  return [...playable, ...legacy].slice(0, MINED_PUZZLE_LIMIT);
}

/** One progress report, shaped so either surface can render it (Stats maps it onto its
 *  `FetchProgress` row, the inline card shows phase + bar). */
export interface ImportProgress {
  /** Human-readable phase, safe to show directly. */
  phase: string;
  /** 0..1 when the total is known, otherwise null (indeterminate). */
  fraction: number | null;
  /** Games finished so far, for absence-of-progress detection. */
  gamesSoFar: number;
  /** Size of the merged mined deck, when the report comes from a mining pass. */
  puzzles: number | null;
}

export interface ImportOptions {
  /** The caller's persisted map, keyed by game id — passed back so a run resumes. */
  records: Record<string, ScanRecord>;
  /** Called as records accumulate, so the caller's own UI can follow the run. Not the storage
   *  write: that happens here, on every game, and is what makes a killed app resume. */
  onRecords?: (records: Record<string, ScanRecord>) => void;
  onProgress?: (p: ImportProgress) => void;
  /** Polled at game boundaries; true stops cleanly between games, leaving a consistent state. */
  shouldStop?: () => boolean;
}

export interface ImportOutcome {
  records: Record<string, ScanRecord>;
  scanned: number;
  failed: number;
  skipped: number;
  stopped: boolean;
  /** Games the scan was willing to read (the kept list length). */
  totalGames: number;
  /** Size of the mined deck when the run finished. */
  puzzles: number;
}

/**
 * Run one import: classify the kept games, mine puzzles as it goes, persist at every boundary.
 *
 * The callbacks make this reusable; everything else — resumption by game id, mid-scan mining,
 * the `complete` flag that distinguishes "stopped" from "done", clearing the derived opens cache
 * when the truth changes — is the scan's contract, and it must be identical wherever the scan is
 * started from.
 */
export async function importGames(
  username: string,
  games: readonly LichessGame[],
  opts: ImportOptions,
): Promise<ImportOutcome> {
  const kept = keptScanGames(games);
  const shouldStop = () => opts.shouldStop?.() === true;

  // Accumulate into a local map rather than reading the caller's state inside the
  // loop: the closure would capture the value at call time, so every onGame would
  // merge into the same stale object and lose all but the last record. This map is
  // the source of truth during a run; the caller and kv-store are both updated
  // from it.
  const next: Record<string, ScanRecord> = { ...opts.records };

  // Read ONCE, before the run. The mid-scan mining passes need the already stored
  // deck to merge into, and re-reading it per batch would mean a kv-store round
  // trip every 20 games for a value that only changes because we changed it.
  const previous = await loadScanState(username);

  /*
   * MINE WHILE THE SCAN RUNS, NOT ONLY AFTER IT.
   *
   * The complaint: *"we have to click on analyse games in stats and wait too long
   * time to get these puzzles"*. A 200-game scan is ~13,000 engine searches —
   * measured near 1.6/s on a phone, so hours — and puzzles were mined ONCE at the
   * very end. The user watched a bar for the whole run and then got everything at
   * once.
   *
   * So the mining pass is run every `MINE_EVERY` games over everything scanned so
   * far, and each pass is merged into what is already stored. The user can open
   * Puzzles and start solving while the scan continues.
   */
  const mineBatch = async (batchRecords: Record<string, ScanRecord>) => {
    if (shouldStop()) return;
    const mined = await minePuzzles([...kept], batchRecords, {
      limit: MINED_PUZZLE_LIMIT,
      depth: MINE_DEPTH,
      maxPly: MINE_MAX_PLY,
      // Each batch re-reads the whole scanned archive, but a position already in the deck as a
      // verified line must not be searched again. This keeps the line-verification searches from
      // multiplying across batches.
      known: previous.puzzles,
      shouldStop,
      onProgress: (made) => {
        opts.onProgress?.({
          phase: `Analysing your games. Puzzles so far: ${made}`,
          fraction: null,
          gamesSoFar: kept.length,
          puzzles: made,
        });
      },
    });
    const merged = mergeMinedPuzzles(previous.puzzles, mined);
    // `complete` stays FALSE: this is mid-run, and a process killed here must
    // resume rather than look finished.
    await saveScanState(username, {
      records: batchRecords,
      puzzles: merged,
      totalGames: kept.length,
      complete: false,
      updatedAt: Date.now(),
    });
    previous.puzzles = merged;
    opts.onProgress?.({
      phase: `Analysing your games. Puzzles so far: ${merged.length}`,
      fraction: null,
      gamesSoFar: kept.length,
      puzzles: merged.length,
    });
  };

  const { records: finalRecords, summary } = await runGameScan(kept, next, {
    depth: SCAN_DEPTH,
    maxPliesPerGame: SCAN_MAX_PLIES,
    shouldStop,
    batchEvery: MINE_EVERY,
    onBatch: mineBatch,
    onGame: (rec, done, total) => {
      next[rec.gameId] = rec;
      opts.onRecords?.({ ...next });
      opts.onProgress?.({
        phase: `Analysing your games… (${done}/${total})`,
        fraction: total ? done / total : null,
        gamesSoFar: done,
        puzzles: null,
      });
      // Persist every game, not only every batch: the scan is hours long and a
      // process killed mid-batch must resume at the game, not at the batch.
      void saveScanRecords(username, next, kept.length, false);
    },
    onFail: (done, total) => {
      opts.onProgress?.({
        phase: `Analysing your games… (${done}/${total}) — some games could not be read`,
        fraction: total ? done / total : null,
        gamesSoFar: done,
        puzzles: null,
      });
    },
    onPly: (gameId, ply, totalPlies, done, total) => {
      /*
       * THE FRACTION IS THE FRACTION OF THE WHOLE JOB.
       *
       * A fraction of the current game alone resets to zero every game — the bar
       * would sawtooth 20 times an hour, which reads as broken rather than as
       * progress. Games done, plus the part of the current game played, over the
       * game total, moves forward at every ply and is due for the full run.
       */
      const perGame = totalPlies > 0 ? ply / totalPlies : 0;
      opts.onProgress?.({
        phase: `Analysing game ${done + 1} of ${total} — move ${ply} of ${totalPlies}`,
        fraction: total ? (done + perGame) / total : null,
        gamesSoFar: done,
        puzzles: null,
      });
    },
  });

  await saveScanState(username, {
    records: finalRecords,
    puzzles: previous.puzzles,
    totalGames: kept.length,
    complete: !summary.stopped,
    updatedAt: Date.now(),
  });

  /*
   * THE DERIVED CACHE IS NOW WRONG, AND THE TRUTH IS HERE.
   *
   * The openings/positions caches are what the other screens paint from. They were built from a
   * game list that has not changed, but the analysis behind them just did — so they are dropped,
   * and the screens rebuild from the new scan rather than showing a stale verdict.
   */
  await clearCachedPositions(username);

  if (!summary.stopped) {
    // The final pass is what guarantees every game is mined, including a tail shorter than a batch.
    await mineBatch(finalRecords);
    const done = await loadScanState(username);
    await saveScanState(username, {
      records: done.records,
      puzzles: done.puzzles,
      totalGames: kept.length,
      complete: true,
      updatedAt: Date.now(),
    });
    previous.puzzles = done.puzzles;
  }

  return {
    records: finalRecords,
    scanned: summary.scanned,
    failed: summary.failed,
    skipped: summary.skipped,
    stopped: summary.stopped,
    totalGames: kept.length,
    puzzles: previous.puzzles.length,
  };
}
