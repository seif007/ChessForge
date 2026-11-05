/**
 * The long Lichess jobs, detached from StatsScreen.
 *
 * Two things here take minutes on a phone: downloading/refreshing the game
 * list and running the engine scan that produces move quality and mined
 * puzzles. Both used to be component-owned promises. Navigating away unmounted
 * the screen, so its progress vanished; the scan's early `aliveRef` return could
 * stop the work outright, and a refresh that had already downloaded the games
 * discarded them before writing the cache. The jobs below own the work and
 * persist their results at the normal storage boundaries. Stats (and the inline
 * import card) only observe.
 */

import { runJob } from '@/lib/background';
import {
  LichessError, clearGameCache, fetchAllGames, fetchProfile, lichessAccountError,
  type LichessGame, type FetchProgress, type LichessProfile, type LichessRatings,
} from '@/lib/lichess';
import {
  clearCachedPositions, gamesCacheIsStale, loadAccount, loadActiveUsername,
  loadCachedGames, loadScanState, saveAccount, saveCachedGames,
} from '@/lib/lichessStore';
import { getEngine } from '@/lib/engine';
import { importGames, SCAN_GAMES, type ImportOutcome, type ImportProgress } from '@/lib/scanPlan';
import type { ScanRecord } from '@/lib/gameScan';

export const GAMES_REFRESH_JOB = 'stats-games';
export const SCAN_JOB = 'stats-scan';

/**
 * The slice of the Refresh bar's travel spent downloading the games.
 *
 * The read reports 100% when it finishes, but saving the cache and refreshing
 * the openings come after — so a bar that reached the end and then dropped back
 * to "Saving your games..." looked like it had restarted. Ninety leaves room for
 * those steps to finish the bar in one direction.
 */
const GAMES_DOWNLOAD_SHARE = 90;

/** Keep only the ratings Lichess actually supplied. */
export function ratingsRecord(ratings: LichessRatings): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(ratings)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

export interface GamesRefreshResult {
  username: string;
  games: LichessGame[];
  before: number | null;
  after: number;
  shortRead: string | null;
  note: string | null;
}

/**
 * Explicit "Refresh games". Unlike the quiet boot refresh, this is a job so
 * the user can leave the tab and come back to either live progress or the
 * finished count. The game cache is written before the job reports done.
 */
export function startGamesRefresh(
  username: string,
  opts: { force?: boolean; before?: number | null } = {},
): Promise<GamesRefreshResult | null> {
  const name = username.trim().toLowerCase();
  return runJob<GamesRefreshResult>(
    GAMES_REFRESH_JOB,
    'Refreshing games',
    async ({ signal, progress }) => {
      if (opts.force) clearGameCache();
      let shortRead: string | null = null;
      progress({ pct: 0, label: 'Looking up the account…', indeterminate: true });

      /*
       * One request at a time, in the order Lichess asks for: the profile
       * first, then the games. The profile is what refreshes the rating header;
       * a not-found account stops here with the same message the screen uses.
       */
      let profile: LichessProfile;
      try {
        profile = await fetchProfile(name, signal);
      } catch (e) {
        throw new Error(lichessAccountError(name, e));
      }
      if (profile.disabled) {
        throw new Error(lichessAccountError(name, new LichessError('closed', 'disabled')));
      }

      progress({ pct: 2, label: 'Reading your Lichess games...', indeterminate: true });

      let all: LichessGame[];
      try {
        all = await fetchAllGames(name, {
          force: opts.force === true,
          signal,
          expected: profile.gameCount,
          disabledHint: profile.disabled,
          onProgress: (p: FetchProgress) => {
            if (/could not be read/.test(p.phase)) shortRead = p.phase;
            progress({
              /*
               * THE DOWNLOAD OWNS MOST OF THE BAR, NOT ALL OF IT.
               *
               * The read reports 100% when it finishes, but saving the cache and
               * refreshing the openings come after — and a bar that reaches the
               * end and then drops back to "Saving your games..." looks like it
               * restarted. Ninety leaves room for those steps to finish the bar
               * in one direction.
               */
              pct: p.fraction != null ? Math.round(p.fraction * GAMES_DOWNLOAD_SHARE) : 0,
              label: p.phase,
              detail: `${p.gamesSoFar} game${p.gamesSoFar === 1 ? '' : 's'} read`,
              indeterminate: p.fraction == null,
            });
          },
        });
      } catch (e) {
        throw new Error(lichessAccountError(name, e));
      }

      progress({ pct: 95, label: 'Saving your games…' });
      await saveCachedGames(name, all);

      /*
       * THE ACTIVE KEY IS NOT THIS JOB'S TO STEAL.
       *
       * A refresh that finishes after the user switched accounts must still
       * keep the downloaded cache for its own username, but it must not make
       * that old account active again. `saveAccount` writes the active key, so
       * only call it when the account is still the active one.
       */
      if ((await loadActiveUsername()) === name) {
        const prev = await loadAccount(name);
        await saveAccount({
          username: profile.username,
          joined: profile.joined ?? prev?.joined ?? null,
          ratings: ratingsRecord(profile.ratings),
          lastRefresh: Date.now(),
        });
      }

      const before = opts.before ?? null;
      if (before != null && all.length !== before) {
        progress({ pct: 98, label: 'Updating your openings…' });
        await clearCachedPositions(name);
      }

      const after = all.length;
      const note = before == null
        ? null
        : after === before
          ? `Up to date — ${after} games, no new results on Lichess.`
          : after > before
            ? `Added ${after - before} new game${after - before === 1 ? '' : 's'} — ${after} in total.`
            : `Now ${after} games (was ${before}).`;

      return { username: name, games: all, before, after, shortRead, note };
    },
    { owner: name },
  );
}

export interface ScanJobResult extends ImportOutcome {
  username: string;
  records: Record<string, ScanRecord>;
  puzzles: number;
}

/**
 * Engine scan + puzzle mining. One job for both Stats and the inline import
 * card, so there cannot be two scans of the same account racing each other.
 *
 * The engine boot check is here rather than in the screen: it is part of the
 * job's success condition, and it has to happen even if the screen unmounts in
 * the same tick as the tap.
 */
export function startScanJob(
  username: string,
  games?: readonly LichessGame[],
): Promise<ScanJobResult | null> {
  const name = username.trim().toLowerCase();
  return runJob<ScanJobResult>(
    SCAN_JOB,
    'Analysing your games',
    async ({ signal, progress }) => {
      progress({ pct: 0, label: 'Starting up…', indeterminate: true });

      if (!getEngine().isReady) getEngine().restart('retry from the Stats scan');
      await getEngine().init();
      if (!getEngine().isReady) {
        throw new Error(
          'The chess engine did not start, so games cannot be analysed. Tap Analyse again to '
          + 'restart it — everything else on this screen still works without it.',
        );
      }

let list = games ?? null;
      if (list == null) {
        const cached = await loadCachedGames(name);
        list = cached && !gamesCacheIsStale(cached) ? cached.games : null;
        if (list == null) {
          /*
           * VALIDATE THE HANDLE BEFORE ANY GAME WORK, and say why if it is
           * closed. This is the first request in the run, so the bar is put on
           * screen before it is sent rather than after the first twenty games.
           */
          progress({ pct: 0, label: 'Looking up the account...', indeterminate: true });
          let disabled = false;
          let expected: number | null = null;
          try {
            const profile = await fetchProfile(name, signal);
            disabled = profile.disabled;
            expected = profile.gameCount;
          } catch (e) {
            throw new Error(lichessAccountError(name, e));
          }
          if (disabled) {
            throw new Error(lichessAccountError(name, new LichessError('closed', 'disabled')));
          }
          progress({ pct: 0, label: 'Reading your games...', indeterminate: true });
          try {
            list = await fetchAllGames(name, {
              maxGames: SCAN_GAMES,
              signal,
              expected,
              disabledHint: disabled,
              onProgress: (p: FetchProgress) =>
                progress({
                  pct: p.fraction != null ? Math.round(p.fraction * 100) : 0,
                  label: p.phase,
                  detail: `${p.gamesSoFar} game${p.gamesSoFar === 1 ? '' : 's'} read`,
                  indeterminate: p.fraction == null,
                }),
            });
          } catch (e) {
            throw new Error(lichessAccountError(name, e));
          }
          await saveCachedGames(name, [...list]);
        }
      }

      const stored = await loadScanState(name);
      progress({ pct: 0, label: 'Reading your games...', indeterminate: true });

      const outcome = await importGames(name, list, {
        records: stored.records,
        onProgress: (p: ImportProgress) => {
          progress({
            pct: p.fraction != null ? Math.round(p.fraction * 100) : 0,
            label: p.phase,
            detail: `${p.gamesSoFar} game${p.gamesSoFar === 1 ? '' : 's'} finished`,
            indeterminate: p.fraction == null,
          });
        },
        shouldStop: () => signal.aborted,
      });

      progress({ pct: 100, label: 'Saving results…' });
      return {
        ...outcome,
        username: name,
        records: outcome.records,
        puzzles: outcome.puzzles,
      };
    },
    { owner: name },
  );
}


