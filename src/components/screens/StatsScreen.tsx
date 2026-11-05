'use client';

/**
 * Stats screen — driven by a Lichess account instead of in-app analyses.
 *
 * WHAT CHANGED AND WHY
 * -------------------
 * The web app (and this port, until now) built its stats from games the user
 * imported and analyzed in-app. The user asked to switch the source: give a
 * **Lichess username** (no login, no OAuth — their game archive is public) and
 * the stats come from the games they actually played there.
 *
 * The visible screen is deliberately close to what it was, because the previous
 * charts were already right. What is new is the *pipeline in front of them*:
 *
 *   username -> fetch public games -> [engine scan] -> GameStatRow[] -> aggregate
 *
 * The middle step is the expensive one and the reason this screen is built around
 * a resumable job rather than a spinner:
 *
 * Lichess publishes **no move-quality data**, so every brilliant/blunder/miss
 * number has to be produced by running our own engine over the user's PGNs. A
 * 200-game scan is ~8,400 user moves, i.e. tens of thousands of engine searches.
 * No user will hold the app open for that. So the scan:
 *
 *   - runs in chunks, persisting after EVERY game (see `lichessStore`),
 *   - resumes exactly where it stopped after the app is killed,
 *   - can be stopped at any time and restarted later with no lost work,
 *   - and the win-rate / opening halves of the screen are correct IMMEDIATELY,
 *     because those come from the public game feed and need no engine at all.
 *
 * That last point is the design decision that makes this usable: the screen is
 * useful after a few seconds of network, and only gets *better* as the scan fills
 * in the quality block. It is never blocked on the engine.
 *
 * ACCOUNT SWITCHING WIPES THE OLD ACCOUNT
 * --------------------------------------
 * The user was explicit: a different username must delete the previous account's
 * saved data rather than merging the two. `forgetAccount` is the single place that
 * happens, called during the switch so it is auditable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { aggregateStats, type StatsResult, type GameStatRow } from '@/lib/stats';
import { QualityBadge } from '@/components/chess/QualityBadge';
import { Card, Btn, Chip, Bar } from '@/components/ui/Primitives';
import {
  IconBarChart, IconTarget, IconTrophy, IconActivity, IconCompass, IconShieldAlert, IconTrendingUp,
  IconRotateCcw, IconCheck, IconX,
} from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import {
  fetchAllGames, fetchProfile, clearGameCache, sanitizeLichessUser, LichessError,
  lichessAccountError,
  type LichessGame, type FetchProgress,
} from '@/lib/lichess';
import { toGameStatRow } from '@/lib/statsFromLichess';
import { useAppStore } from '@/lib/store';
import { type ScanRecord } from '@/lib/gameScan';
import { SCAN_GAMES } from '@/lib/scanPlan';
import { cancelJob, clearJob, isJobRunning, useJob } from '@/lib/background';
import {
  GAMES_REFRESH_JOB, SCAN_JOB, ratingsRecord, startGamesRefresh, startScanJob,
  type GamesRefreshResult, type ScanJobResult,
} from '@/lib/statsJobs';
import {
  loadAccount, saveAccount, forgetAccount, loadScanState,
  loadActiveUsername, clearActiveUsername,
  loadCachedGames, saveCachedGames, gamesCacheIsStale,
  type LichessAccount,
} from '@/lib/lichessStore';

type StatsData = StatsResult;

/*
 * The scan's own plan — how many games, how deep, how the deck is mined and capped — lives in
 * `lib/scanPlan`. This screen drives it with its detailed progress UI; the empty-state import card
 * on Puzzles and Your openings drives the same function with a plain bar, so the two cannot
 * disagree about what an import is.
 */

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function shortLine(line: string): string {
  return line.replace(/^Study [\d.]+ — /, '');
}

/** W/D/L stacked bar */
function WdlBar({ wins, draws, losses }: { wins: number; draws: number; losses: number }) {
  const total = Math.max(1, wins + draws + losses);
  return (
    <View style={s.wdlTrack}>
      {wins > 0 ? <View style={{ flex: wins / total, backgroundColor: colors.primary }} /> : null}
      {draws > 0 ? <View style={{ flex: draws / total, backgroundColor: colors.subtleFillStrong }} /> : null}
      {losses > 0 ? <View style={{ flex: losses / total, backgroundColor: colors.bad }} /> : null}
    </View>
  );
}

export function StatsScreen() {
  // ---- account + data state -------------------------------------------------
  const [account, setAccount] = useState<LichessAccount | null>(null);
  const [username, setUsername] = useState('');
  const [booted, setBooted] = useState(false);

  const [games, setGames] = useState<LichessGame[]>([]);
  const [records, setRecords] = useState<Record<string, ScanRecord>>({});
  const [puzzlesMade, setPuzzlesMade] = useState(0);

  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when a scan was interrupted, so the UI can offer to continue. */
  const [interrupted, setInterrupted] = useState(false);

  /** Latest game count, read after an await so the refresh note cannot quote a stale number. */
  const gamesRef = useRef<LichessGame[]>([]);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  /*
   * THE TWO JOBS ARE OLDER THAN THIS MOUNT.
   *
   * Stats is unmounted when the user visits another tab. The game refresh and
   * the engine scan now live in `lib/statsJobs`, so returning rehydrates their
   * progress here instead of showing an idle button over work that is still
   * running. The applied timestamps make a completed job a receipt, not an
   * event that fires again on every render.
   */
  const gamesJob = useJob<GamesRefreshResult>(GAMES_REFRESH_JOB);
  const scanJob = useJob<ScanJobResult>(SCAN_JOB);
  const appliedGamesJob = useRef<number | null>(null);
  const appliedScanJob = useRef<number | null>(null);
  /**
   * SET WHEN SOME GAMES COULD NOT BE READ, so the game count is short.
   *
   * A count that omits games looks exactly like a count that does not, and the user is the only one
   * who can tell it should be higher. This is the difference between an app that is under-reporting
   * and one that says it is.
   */
  const [shortRead, setShortRead] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // ---- fetching games -------------------------------------------------------
  /**
   * Fetch the game list.
   *
   * `quiet` is the boot path: it refreshes data the user is ALREADY looking at,
   * so it must not raise the loading state or an error banner. A failure there
   * is not worth a message — the cached list is still on screen and the next
   * launch will try again. Every other caller is an explicit action, and keeps
   * the visible spinner and the error text.
   */
  const loadGames = useCallback(async (
    name: string,
    force: boolean,
    quiet = false,
    expected: number | null = null,
  ) => {
    if (!quiet) { setError(null); setLoading(true); }
    // Every load starts from a clean slate for the shortfall note: a gap found last week is not
    // evidence about this fetch, and leaving it up would blame a read that actually succeeded.
    setShortRead(null);
    if (force) clearGameCache();
    let shortRead: string | null = null;
    try {
      const all = await fetchAllGames(name, {
        force,
        expected,
        onProgress: (p) => {
          // Keep the shortfall even if the screen is unmounted: the cache is
          // still written, and the note must be available on return.
          if (/could not be read/.test(p.phase)) shortRead = p.phase;
          if (quiet || !aliveRef.current) return;
          setProgress(p);
          /*
           * A SHORT TOTAL HAS TO SURVIVE THE FETCH.
           *
           * `fetchAllGames` reports unreadable lines as its final phase, and that means games are
           * missing from the number on screen. But the phase is a loading message: the moment the
           * fetch ends it is replaced, and the user is left looking at a count that is quietly
           * short and looks entirely normal.
           *
           * So the warning is caught here and kept as a note that outlives the progress bar. It is
           * cleared at the start of every load so a past gap is never left blaming a fetch that
           * succeeded.
           */
        },
      });
      /*
       * PERSIST BEFORE CHECKING WHETHER THE COMPONENT IS STILL MOUNTED.
       *
       * The old order returned as soon as `aliveRef` was false, before saving the
       * games or the account. Navigating to another tab therefore downloaded the
       * entire archive and threw it away; returning showed the old cache and the
       * next launch asked again. The cache write is the job's result, not a UI
       * side effect, so it happens regardless.
       */
      await saveCachedGames(name, all);
      if ((await loadActiveUsername()) === name) {
        const prev = await loadAccount(name);
        await saveAccount({
          username: name,
          joined: prev?.joined ?? null,
          ratings: prev?.ratings ?? {},
          lastRefresh: Date.now(),
        });
      }

      if (!aliveRef.current) return;
      gamesRef.current = all;
      setGames(all);
      if (shortRead != null) setShortRead(shortRead);
    } catch (err) {
      if (!aliveRef.current) return;
      if (quiet) return; // silent by design — see the note above
      setError(lichessAccountError(name, err));
    } finally {
      if (!quiet && aliveRef.current) { setLoading(false); setProgress(null); }
    }
  }, []);

  // ---- boot: pick up the saved account, its games, and any scan progress ----
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadActiveUsername();
      if (saved) {
        const [acc, scan] = await Promise.all([loadAccount(saved), loadScanState(saved)]);
        if (!alive) return;
        if (acc) {
          setAccount(acc);
          setUsername(acc.username);
          setRecords(scan.records);
          setPuzzlesMade(scan.puzzles.length);
          if (Object.keys(scan.records).length > 0 && !scan.complete) setInterrupted(true);

          /*
           * PAINT THE GAMES WE ALREADY HAVE, THEN REFRESH THEM SILENTLY.
           *
           * The list is persisted, so the stats are there on the first frame
           * after a cold launch. A fetch runs only when the copy is old or
           * absent, and it runs quietly: the user is already reading the data it
           * replaces, so a spinner over it would be a step backwards.
           */
          const cached = await loadCachedGames(acc.username);
          if (!alive) return;
          if (cached && cached.games.length > 0) {
            gamesRef.current = cached.games;
            setGames(cached.games);
            if (gamesCacheIsStale(cached)) void loadGames(acc.username, false, true);
          } else {
            void loadGames(acc.username, false, true);
          }
        }
      }
      if (alive) setBooted(true);
    })();
    return () => { alive = false; };
    // Boot runs once; `loadGames` is stable (useCallback with no dependencies).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Derive the rows the rest of this screen renders.
   *
   * `toGameStatRow` is the pure adapter: it maps a Lichess game plus whatever
   * engine verdict we have (which may be NONE — the scan is optional) onto the
   * `GameStatRow` shape `aggregateStats` already understands. That is why the
   * charts below needed no changes at all.
   */
  const rows: GameStatRow[] = useMemo(() => {
    if (!account) return [];
    return games.map((g) => toGameStatRow(g, records[g.id] ?? null, account.username));
  }, [games, records, account]);

  const data: StatsData = useMemo(() => aggregateStats(rows), [rows]);

  /** How many of the games we are showing have actually been through the engine. */
  const analysedCount = useMemo(
    () => games.filter((g) => records[g.id] && records[g.id].depthReached > 0).length,
    [games, records],
  );

  /**
   * Switch to an account.
   *
   * The user's rule: a DIFFERENT name means the old account's saved data is
   * deleted and the new one starts fresh. Same name means it is a refresh.
   */
  const connect = useCallback(async (rawName: string) => {
    const name = sanitizeLichessUser(rawName);
    if (!name) return;
    const previous = account?.username?.toLowerCase() ?? null;
    const sameAccount = previous === name;

    /*
     * RESOLVE THE HANDLE BEFORE TOUCHING ANYTHING.
     *
     * This used to write the typed name to storage first and only then ask
     * Lichess about it, so a typo became the saved (and active) account and the
     * failure arrived later with no way to tell whether the name or the network
     * was at fault. It also wiped the previous account before knowing the new
     * one existed. The profile lookup is the same request the games load will
     * make, and it is the only thing that can say the handle is real — so it
     * goes first, and nothing local changes until it succeeds.
     */
    setError(null);
    /*
     * The lookup is a network round trip, so the button must say it is working
     * from the first tap. `loadGames` keeps the flag on afterwards; every early
     * return below clears it.
     */
    setLoading(true);
    /*
     * SHOW THE BAR BEFORE THE FIRST REQUEST. The lookup is the first thing that
     * touches the network, and a form that sits still while it waits reads as
     * broken; `loadGames` replaces this line with real progress as soon as the
     * games read starts.
     */
    setProgress({ phase: 'Looking up that account...', fraction: null, gamesSoFar: 0, monthsDone: 0, monthsTotal: 0 });
    let profile = null;
    try {
      profile = await fetchProfile(name);
    } catch (err) {
      /*
       * A WRONG NAME IS NOT SAVED. A missing or closed account is a fact about
       * the handle, and writing it to storage would leave a broken account
       * connected with no way to tell why. Anything else — a timeout, a dead
       * network — is not a fact about the name, and the old lesson of this file
       * still applies: a handle the user typed must not be lost because a
       * request failed. It is saved below, unresolved, and the message says so.
       */
      if (err instanceof LichessError && (err.kind === 'not-found' || err.kind === 'disabled')) {
        if (aliveRef.current) {
          setError(lichessAccountError(name, err));
          setLoading(false);
          setProgress(null);
        }
        return;
      }
      if (aliveRef.current) setError(lichessAccountError(name, err));
    }
    if (!aliveRef.current) return;
    if (profile?.disabled) {
      setError(lichessAccountError(profile.username, new LichessError('closed', 'disabled')));
      setLoading(false);
      setProgress(null);
      return;
    }
    const resolved = profile ? sanitizeLichessUser(profile.username) : name;

    if (previous && previous !== resolved) {
      // Different account: wipe, exactly as specified. Doing it here — after the
      // new handle is known to be real — means a typo cannot destroy the account
      // the user already had.
      cancelJob(SCAN_JOB);
      await forgetAccount(previous);
      setRecords({});
      setPuzzlesMade(0);
      setInterrupted(false);
      setGames([]);
      setScanning(false);
      setProgress(null);
    }

    const fresh: LichessAccount = {
      username: resolved,
      joined: profile ? profile.joined : sameAccount ? account?.joined ?? null : null,
      ratings: profile ? ratingsRecord(profile.ratings) : sameAccount ? account?.ratings ?? {} : {},
      lastRefresh: sameAccount ? account?.lastRefresh ?? 0 : 0,
    };
    setAccount(fresh);
    await saveAccount(fresh);
    /*
     * SWAP THE TRAINING SCOPE. Progress is per account now, so the rings and
     * ranks must be re-read for the account that was just connected; otherwise
     * the previous account's mastery stays on screen until the next launch.
     */
    await useAppStore.getState().reloadForAccount();

    // Restore any scan progress already on disk for THIS account (there is none
    // for a fresh one, but a refresh of the same account must not forget it).
    const scan = await loadScanState(resolved);
    setRecords(scan.records);
    setPuzzlesMade(scan.puzzles.length);
    if (Object.keys(scan.records).length > 0 && !scan.complete) setInterrupted(true);

    await loadGames(resolved, sameAccount, false, profile?.gameCount ?? null);
  }, [account, loadGames]);

  /**
   * THE REFRESH BUTTON, WHICH IS NOT AN ACCOUNT SWITCH.
   *
   * THE REPORT: *"in stats refreshing games doent work"*.
   *
   * The button called `connect(account.username)`, and `connect` is the account SWITCH: its documented
   * job is *"a DIFFERENT name means the old account's saved data is deleted and the new one starts
   * fresh"*. A refresh is not a switch, and borrowing the handler meant the button did a switch's
   * bookkeeping on every press - rewriting the account with `lastRefresh: 0` and blank ratings, and
   * reloading the whole scan state - before fetching anything. It also had no way to be wrong quietly:
   * the only thing the user could compare before and after was a game count that is often identical,
   * so a refresh that did real work looked exactly like one that did nothing.
   *
   * So the button gets its own handler: fetch, force, no account mutation, and SAY what it found. The
   * scan is reloaded too, because new games mean new work to do - and that is stated rather than
   * implied.
   */
  const refreshGames = useCallback(() => {
    if (!account || loading || scanning) return;
    setError(null);
    setRefreshNote(null);
    /*
     * The refresh is a background job. New games invalidate the derived
     * openings inside that job, exactly where the truth changes; this screen
     * only displays the count it reports. See `lib/statsJobs`.
     */
    void startGamesRefresh(account.username, {
      force: true,
      before: gamesRef.current.length,
    });
  }, [account, loading, scanning]);

  /*
   * Rehydrate the explicit refresh. While running, the row shows the same live
   * fraction as before; when it finishes (even if that happened on another tab)
   * the game list and the "added N" note are applied once.
   */
  useEffect(() => {
    if (!gamesJob || gamesJob.owner !== account?.username) return;
    if (gamesJob.status === 'running') {
      if (!aliveRef.current) return;
      setLoading(true);
      setProgress({
        phase: gamesJob.progress.label,
        fraction: gamesJob.progress.indeterminate ? null : gamesJob.progress.pct / 100,
        gamesSoFar: 0,
        monthsDone: 0,
        monthsTotal: 0,
      });
      return;
    }
    if (appliedGamesJob.current === gamesJob.startedAt) return;
    appliedGamesJob.current = gamesJob.startedAt;
    if (!aliveRef.current) return;
    setLoading(false);
    setProgress(null);
    if (gamesJob.status === 'done' && gamesJob.result) {
      gamesRef.current = gamesJob.result.games;
      setGames(gamesJob.result.games);
      setShortRead(gamesJob.result.shortRead);
      setRefreshNote(gamesJob.result.note);
    } else if (gamesJob.status === 'error') {
      setError(gamesJob.error ?? 'Could not load games.');
    }
    // The result is now screen state; do not replay this receipt on remount.
    clearJob(GAMES_REFRESH_JOB);
  }, [gamesJob, account?.username]);

  // ---- the scan -------------------------------------------------------------
  /**
   * Tap Analyse. The engine boot, scan and puzzle mining live in
   * `startScanJob`; this synchronously shows the bar (so the tap has an answer
   * before the first await) and starts/join the module job.
   */
  const startScan = useCallback(() => {
    if (!account || scanning || isJobRunning(SCAN_JOB)) return;
    setScanning(true);
    setInterrupted(false);
    setError(null);
    /*
     * THE BAR APPEARS ON THE TAP, BEFORE ANY `await`.
     *
     * The engine boot alone can take seconds; without this the button flipped
     * to "Stop" with no progress row. The job immediately overwrites this with
     * its own first phase, but the row exists from the same frame as the tap.
     */
    setProgress({
      phase: 'Starting up…',
      fraction: 0,
      gamesSoFar: 0,
      monthsDone: 0,
      monthsTotal: 0,
    });
    void startScanJob(account.username, games);
  }, [account, games, scanning]);

  /*
   * Rehydrate a running scan after navigation, and apply its result once when
   * it finishes. The result includes the accumulated records and the mined deck
   * count, both of which were persisted by `importGames` already.
   */
  useEffect(() => {
    if (!scanJob || scanJob.owner !== account?.username) return;
    if (scanJob.status === 'running') {
      if (!aliveRef.current) return;
      setScanning(true);
      setProgress({
        phase: scanJob.progress.label,
        fraction: scanJob.progress.indeterminate ? null : scanJob.progress.pct / 100,
        gamesSoFar: 0,
        monthsDone: 0,
        monthsTotal: 0,
      });
      return;
    }
    if (appliedScanJob.current === scanJob.startedAt) return;
    appliedScanJob.current = scanJob.startedAt;
    if (!aliveRef.current) return;
    setScanning(false);
    setProgress(null);
    if (scanJob.status === 'done' && scanJob.result) {
      const r = scanJob.result;
      setRecords(r.records);
      setPuzzlesMade(r.puzzles);
      if (r.stopped) setInterrupted(true);
      /*
       * SAY SO WHEN GAMES COULD NOT BE READ. `failed` is counted all along and
       * shown to nobody otherwise; all-failed is a fault, a handful is not, and
       * neither should be silent.
       */
      if (r.failed > 0) {
        const total = r.scanned + r.failed;
        if (r.scanned === 0) {
          setError(
            `None of the ${total} games could be analysed. The engine answered nothing, so no `
            + 'move quality was recorded. Tap the button again to restart the engine and retry — '
            + 'this is not a problem with your account.',
          );
        } else if (r.failed > 1) {
          setError(
            `${r.scanned} of ${total} games were analysed. ${r.failed} could not be read `
            + 'and were skipped — tap the button again to retry them.',
          );
        }
      }
    } else if (scanJob.status === 'error') {
      setError(scanJob.error ?? 'The scan stopped.');
    }
    // The scan job has already persisted the records/deck; the job receipt is
    // consumed here so returning to Stats later starts from disk, not a replay.
    clearJob(SCAN_JOB);
  }, [scanJob, account?.username]);

  const stopScan = useCallback(() => { cancelJob(SCAN_JOB); }, []);

  // ---- render ---------------------------------------------------------------

  // Not connected yet: the account form IS the empty state.
  if (!booted) {
    return (
      <View style={{ paddingTop: 64, alignItems: 'center' }}>
        <Text style={s.body}>Loading…</Text>
      </View>
    );
  }

  if (!account) {
    return (
      <View style={s.root}>
        <View style={s.titleRow}>
          <IconBarChart size={20} color={colors.gold} />
          <Text style={s.h1}>Stats</Text>
        </View>
        <ConnectCard
          value={username}
          onChange={setUsername}
          onSubmit={() => connect(username)}
          busy={loading}
          error={error}
          progress={progress}
        />
      </View>
    );
  }

  const o = data.overall;

  return (
    <View style={s.root}>
      <View style={s.titleRow}>
        <IconBarChart size={20} color={colors.gold} />
        <Text style={s.h1}>Stats</Text>
      </View>

      {/* account header */}
      <Card style={{ gap: 10 }}>
        <View style={s.spaceBetween}>
          <View style={{ gap: 2 }}>
            <Text style={s.statLabel}>Lichess username</Text>
            <Text style={s.acctName}>{account.username}</Text>
          </View>
          <Pressable
            onPress={() => {
              /*
               * "Change" means the user WANTS to be asked again, so the active
               * key is cleared to match — otherwise a relaunch would silently
               * reopen the account they just left, and the form they are looking
               * at would be pointless.
               *
               * Only the pointer is removed. The account's own data (profile,
               * scan, mined puzzles) stays on disk under its own key, so
               * re-entering the same name picks up where they left off. The wipe
               * belongs to `connect`, and only when the name actually differs.
               */
              void clearActiveUsername();
              setAccount(null);
              setGames([]);
              setError(null);
              setUsername(account.username);
            }}
            style={s.linkBtn}
          >
            <Text style={s.linkText}>Change</Text>
          </Pressable>
        </View>

        <View style={[s.row2, { flexWrap: 'wrap' }]}>
          <Chip text={`${games.length} games`} />
          <Chip
            text={analysedCount > 0 ? `${analysedCount} analysed` : 'not analysed yet'}
            color={analysedCount > 0 ? colors.primary : colors.mutedForeground}
          />
          {puzzlesMade > 0 ? <Chip text={`${puzzlesMade} puzzles mined`} color={colors.gold} /> : null}
        </View>

        {progress ? (
          <View style={{ gap: 6 }}>
            <Text style={s.body} numberOfLines={1}>{progress.phase}</Text>
            <Bar pct={progress.fraction ?? 0} indeterminate={progress.fraction == null} />
          </View>
        ) : null}

        {error ? (
          <View style={s.errRow}>
            <IconShieldAlert size={13} color={colors.bad} />
            <Text style={[s.body, { color: colors.bad, flex: 1 }]}>{error}</Text>
          </View>
        ) : null}

        <View style={[s.row2, { gap: 8 }]}>
          <Btn
            small
            variant="ghost"
            label={loading ? 'Refreshing…' : 'Refresh games'}
            onPress={() => { void refreshGames(); }}
            disabled={loading || scanning}
            style={{ flex: 1 }}
          />
          {scanning ? (
            <Btn small variant="danger" label="Stop" onPress={stopScan} style={{ flex: 1 }} />
          ) : (
            <Btn
              small
              label={interrupted ? 'Finish analysing' : analysedCount > 0 ? 'Analyse more' : 'Analyse games'}
              onPress={startScan}
              disabled={loading || games.length === 0}
              style={{ flex: 1 }}
            />
          )}
        </View>
        {/*
         * WHAT THE REFRESH FOUND.
         *
         * A refresh whose only visible result is a game count that often does not change looks exactly
         * like a refresh that did nothing — which is the report. So the outcome is stated, including
         * the case where there was nothing new, because "no new games" is information and silence is
         * not.
         */}
        {refreshNote ? (
          <Text style={[s.bodySm, { color: colors.mutedForeground, marginTop: 6 }]}>
            {refreshNote}
          </Text>
        ) : null}
        {/* A SHORT TOTAL, SAID PLAINLY. This is not a style concern: the number above is wrong,
            quietly, and a warning that is replaced by the result is a warning nobody sees. */}
        {shortRead ? (
          <Text style={[s.bodySm, { color: colors.bad, marginTop: 4 }]}>{shortRead}</Text>
        ) : null}

        <Text style={[s.statSub, { lineHeight: 15 }]}>
          {scanning
            ? 'You can leave this screen — progress is saved after every game.'
            : analysedCount === 0
              ? `Win rates and opening stats are ready. Tap Analyse to add move quality for your last ${SCAN_GAMES} games — you can stop any time.`
              : 'Move-quality counts cover the games analysed so far; win rates cover every game.'}
        </Text>
      </Card>

      {o.games === 0 ? (
        <Card style={{ alignItems: 'center', gap: 8, padding: 24 }}>
          <View style={s.emptyIcon}>
            <IconTarget size={22} color={colors.mutedForeground} />
          </View>
          <Text style={s.h2}>No games yet</Text>
          {/*
            * The app pulls the game list by itself now — on boot, from disk when
            * it has a copy and from Lichess when it does not. So this card is
            * no longer the expected first thing a user sees, and it must not
            * read as an instruction: it is either "we are working on it" or
            * "the attempt failed, here is the retry".
            */}
          <Text style={[s.body, { textAlign: 'center', lineHeight: 17 }]}>
            {loading
              ? 'Reading your Lichess games…'
              : 'We could not read your games just now. Tap Refresh games to try again.'}
          </Text>
        </Card>
      ) : (
        <>
          {/* overview */}
          <View style={s.row2}>
            <Card style={s.statCard}>
              <Text style={s.statLabel}>Games</Text>
              <Text style={s.bigPct}>{o.games}</Text>
              <Text style={s.statSub}>
                <Text style={{ color: colors.primary, fontWeight: '600' }}>{o.wins}W</Text> · {o.draws}D · <Text style={{ color: colors.bad, fontWeight: '600' }}>{o.losses}L</Text>
              </Text>
            </Card>
            <Card style={s.statCard}>
              <Text style={s.statLabel}>Win rate (decisive)</Text>
              <Text style={[s.bigPct, o.winRate != null && o.winRate >= 0.5 ? { color: colors.primary } : null]}>{pct(o.winRate)}</Text>
              <Text style={s.statSub}>{o.wins + o.losses} decisive</Text>
            </Card>
            <Card style={s.statCard}>
              <Text style={s.statLabel}>Avg accuracy</Text>
              {/*
                A game with no accuracy must not be counted as 0%. Lichess does
                not publish per-game accuracy, so this stays empty until a scan
                can estimate it; when estimates exist, the mean is taken over the
                games that HAVE one and we say how many that was.
              */}
              <Text style={[s.bigPct, { color: colors.whiteSide }]}>
                {o.accuracyGames > 0 ? `${Math.round(o.avgAccuracy)}%` : '—'}
              </Text>
              <Text style={s.statSub}>
                {o.accuracyGames > 0
                  ? `over ${o.accuracyGames} rated game${o.accuracyGames === 1 ? '' : 's'}`
                  : 'not published by Lichess'}
              </Text>
            </Card>
            <Card style={s.statCard}>
              <Text style={s.statLabel}>On book</Text>
              <Text style={[s.bigPct, { color: colors.gold }]}>
                {o.analysedGames > 0 ? `${Math.round((o.onBookGames / o.analysedGames) * 100)}%` : '—'}
              </Text>
              {/*
                The denominator is ANALYSED games, not all games. Games that were
                never scanned have no deviation data at all, so counting them here
                is what made this stat silently describe the whole library.
              */}
              <Text style={s.statSub}>
                {o.analysedGames > 0
                  ? `${o.onBookGames}/${o.analysedGames} analysed stayed in repertoire`
                  : 'analyse games to measure this'}
              </Text>
            </Card>
          </View>

          {/* color split */}
          <View style={s.row2}>
            {(['w', 'b'] as const).map((c) => {
              const row = data.colorSplit.find((x) => x.color === c);
              if (!row) return <View key={c} style={{ flex: 1 }} />;
              return (
                <Card key={c} style={{ flex: 1, padding: 14, gap: 6 }}>
                  <Text style={s.bodySm}>{c === 'w' ? '♔ As White' : '♚ As Black'}</Text>
                  <View style={s.spaceBetween}>
                    <Text style={s.midPct}>{pct(row.winRate)}</Text>
                    <Text style={s.statSub}>{row.games} games</Text>
                  </View>
                  <WdlBar wins={row.wins} draws={row.draws} losses={row.losses} />
                </Card>
              );
            })}
          </View>

          {/* per opening */}
          {data.openings.length > 0 ? (
            <Card>
              <View style={s.titleRowSm}>
                <IconTrophy size={14} color={colors.gold} />
                <Text style={s.h2}>Your openings</Text>
              </View>
              <View style={{ gap: 12 }}>
                {data.openings.slice(0, 12).map((op) => (
                  <View key={op.key}>
                    <View style={[s.spaceBetween, { marginBottom: 4 }]}>
                      <Text style={[s.h2, { flex: 1 }]} numberOfLines={1}>{op.openingKey}</Text>
                      <Text style={s.bodySm}>
                        {op.games} · {pct(op.winRate)} · acc {op.accuracyGames > 0 ? `${Math.round(op.avgAccuracy)}%` : '—'}
                      </Text>
                    </View>
                    <WdlBar wins={op.wins} draws={op.draws} losses={op.losses} />
                    <View style={[s.row2, { marginTop: 4, flexWrap: 'wrap', gap: 8 }]}>
                      <Text style={[s.statSub, { color: colors.primary }]}>{op.wins}W</Text>
                      <Text style={s.statSub}>{op.draws}D</Text>
                      <Text style={[s.statSub, { color: colors.bad }]}>{op.losses}L</Text>
                      <Text style={s.statSub}>· W {op.asWhite} / B {op.asBlack}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}

          {/* best & worst lines */}
          {data.lines.length > 0 ? (
            <Card style={{ gap: 12 }}>
              <View style={s.titleRowSm}>
                <IconTrendingUp size={14} color={colors.primary} />
                <Text style={s.h2}>Repertoire lines — where you win and lose</Text>
              </View>
              <BestWorst data={data} />
            </Card>
          ) : null}

          {/* move quality totals */}
          <Card>
            <View style={s.titleRowSm}>
              <IconActivity size={14} color={colors.whiteSide} />
              <Text style={s.h2}>Move quality (your moves)</Text>
            </View>
            {analysedCount === 0 ? (
              <Text style={[s.body, { lineHeight: 17 }]}>
                Lichess does not publish move quality, so these are measured on this device.
                Tap <Text style={{ color: colors.gold }}>Analyse games</Text> to fill them in —
                win rates and opening stats above are already final.
              </Text>
            ) : (
              <>
                <View style={s.qualityRow}>
                  {([
                    ['brilliant', o.totalBrilliants],
                    ['great', o.totalGreats],
                    ['miss', o.totalMisses],
                    ['mistake', o.totalMistakes],
                    ['blunder', o.totalBlunders],
                  ] as const).map(([kind, n]) => (
                    <View key={kind} style={s.qualityCell}>
                      <QualityBadge kind={kind} size={16} />
                      <Text style={s.qualityNum}>{n}</Text>
                      <Text style={s.statSub}>{kind === 'miss' ? 'missed' : kind + 's'}</Text>
                    </View>
                  ))}
                </View>
                <Text style={[s.statSub, { marginTop: 10 }]}>
                  {o.totalBook} book · {o.totalBest} best · {o.totalInaccuracies} inaccuracies
                  across {analysedCount} analysed game{analysedCount === 1 ? '' : 's'}.
                </Text>
              </>
            )}
          </Card>

          {/* deviation spots */}
          {data.deviations.length > 0 ? (
            <Card>
              <View style={s.titleRowSm}>
                <IconCompass size={14} color={colors.chessforge} />
                <Text style={s.h2}>Where you leave your repertoire</Text>
              </View>
              <View style={{ gap: 6 }}>
                {data.deviations.map((d, i) => (
                  <View key={i} style={s.lineRow}>
                    <Text style={s.body}>{d.move}</Text>
                    <Text style={[s.bodySm, { flex: 1 }]} numberOfLines={1}>{d.openingKey}</Text>
                    <Text style={s.body}>
                      <Text style={{ fontWeight: '600' }}>{d.count}×</Text>
                      {d.wins + d.losses > 0 ? (
                        <Text style={s.statSub}> <Text style={{ color: colors.primary }}>{d.wins}W</Text>/<Text style={{ color: colors.bad }}>{d.losses}L</Text></Text>
                      ) : null}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}

          {/* recent games trend */}
          {data.trend.length > 0 ? (
            <Card>
              <View style={s.titleRowSm}>
                <IconShieldAlert size={14} color={colors.gold} />
                <Text style={s.h2}>Recent games</Text>
              </View>
              <View style={{ gap: 6 }}>
                {/*
                 * NO `.reverse()` HERE.
                 *
                 * `data.trend` is newest-first on purpose, chosen in `aggregateStats` from the row
                 * dates rather than inherited from the caller's sort order. This used to reverse it,
                 * which put the newest at the BOTTOM and, together with `slice(-15)` over
                 * newest-first rows, meant the panel headed "Recent games" listed the OLDEST games
                 * in the account — July 2024, while the user was playing this week.
                 *
                 * Read it as: the heading says recent, so it shows recent, top first, and the order
                 * is decided in the one place that can be reasoned about.
                 */}
                {data.trend.map((g, i) => (
                  <View key={i} style={s.lineRow}>
                    <View style={[s.row2, { gap: 8, flex: 1 }]}>
                      <View style={[s.resultDot, { backgroundColor: g.result === 'win' ? colors.primary : g.result === 'loss' ? colors.bad : colors.subtleFillStrong }]} />
                      <Text style={s.bodySm}>{g.date}</Text>
                    </View>
                    <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{g.openingKey}</Text>
                    <Text style={[s.body, { fontWeight: '600' }]}>
                      {g.accuracy == null ? '—' : `${Math.round(g.accuracy)}%`}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          ) : null}
        </>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ pieces */

function BestWorst({ data }: { data: StatsData }) {
  const worst = data.lines
    .filter((l) => l.winRate != null && l.losses > 0)
    .sort((a, b) => (a.winRate ?? 1) - (b.winRate ?? 1))
    .slice(0, 3);
  const best = data.lines
    .filter((l) => l.winRate != null && l.wins > 0)
    .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))
    .slice(0, 3);

  return (
    <>
      {best.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={[s.bodySm, { color: colors.primary, fontWeight: '600' }]}>Best performing</Text>
          {best.map((l) => (
            <View key={l.key} style={s.lineRow}>
              <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{l.openingKey} · {shortLine(l.line)}</Text>
              <Text style={[s.body, { color: colors.primary, fontWeight: '600' }]}>
                {pct(l.winRate)} <Text style={{ color: colors.mutedForeground }}>({l.games}g)</Text>
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {worst.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={[s.bodySm, { color: colors.bad, fontWeight: '600' }]}>Needs work</Text>
          {worst.map((l) => (
            <View key={l.key} style={s.lineRow}>
              <Text style={[s.body, { flex: 1 }]} numberOfLines={1}>{l.openingKey} · {shortLine(l.line)}</Text>
              <Text style={[s.body, { color: colors.bad, fontWeight: '600' }]}>
                {pct(l.winRate)} <Text style={{ color: colors.mutedForeground }}>({l.games}g)</Text>
              </Text>
            </View>
          ))}
          <Text style={[s.statSub, { marginTop: 4 }]}>
            Drill these via <Text style={{ color: colors.gold }}>Openings → Course/Practice</Text>.
          </Text>
        </View>
      ) : null}
    </>
  );
}

/** The connect form — the empty state when no account is linked. */
function ConnectCard({
  value, onChange, onSubmit, busy, error, progress,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  progress: FetchProgress | null;
}) {
  return (
    <Card style={{ gap: 14 }}>
      <View style={s.emptyIcon}>
        <IconTarget size={22} color={colors.gold} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={s.h2}>Import from Lichess</Text>
        <Text style={[s.body, { lineHeight: 17 }]}>
          Enter a Lichess username. No password or login is needed — the public game
          feed is read directly from Lichess, and the stats are built from those games.
          You can import any public account.
        </Text>
        <Text style={[s.bodySm, { lineHeight: 15, marginTop: 2 }]}>
          ChessForge is independent and not affiliated with Lichess.
        </Text>
      </View>

      <View style={s.inputWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder="Lichess username"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={onSubmit}
          editable={!busy}
          style={s.input}
        />
      </View>

      {progress ? (
        <View style={{ gap: 6 }}>
          <Text style={s.body} numberOfLines={1}>{progress.phase}</Text>
          <Bar pct={progress.fraction ?? 0} indeterminate={progress.fraction == null} />
        </View>
      ) : null}

      {error ? (
        <View style={s.errRow}>
          <IconShieldAlert size={13} color={colors.bad} />
          <Text style={[s.body, { color: colors.bad, flex: 1 }]}>{error}</Text>
        </View>
      ) : null}

      <Btn
        label={busy ? 'Importing…' : 'Import games'}
        onPress={onSubmit}
        disabled={busy || !value.trim()}
      />
    </Card>
  );
}

/* ------------------------------------------------------------------ styles */

const s = themedStyles(() => ({
  root: { gap: 16 },
  row2: { flexDirection: 'row', gap: 8 },
  spaceBetween: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRowSm: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },

  acctName: { fontFamily: fonts.sansBold, fontSize: 16, color: colors.foreground },
  linkBtn: { paddingHorizontal: 10, paddingVertical: 4 },
  linkText: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.gold },

  inputWrap: {
    backgroundColor: colors.subtleFill,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  input: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.foreground,
    paddingVertical: 10,
  },

  errRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  statCard: { flex: 1, padding: 14, gap: 2 },
  statLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },
  statSub: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },
  bigPct: { fontSize: 22, fontWeight: '800', color: colors.foreground, fontFamily: fonts.sans },
  midPct: { fontSize: 18, fontWeight: '800', color: colors.foreground, fontFamily: fonts.sans },

  emptyIcon: {
    width: 48, height: 48, borderRadius: 16, backgroundColor: colors.subtleFill,
    alignItems: 'center', justifyContent: 'center',
  },

  wdlTrack: { flexDirection: 'row', height: 6, borderRadius: 999, overflow: 'hidden', backgroundColor: colors.subtleFillStrong },
  lineRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    backgroundColor: colors.subtleFill, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
  },
  qualityRow: { flexDirection: 'row', gap: 8 },
  qualityCell: {
    flex: 1, backgroundColor: colors.subtleFill, borderRadius: 8,
    paddingVertical: 8, alignItems: 'center', gap: 4,
  },
  qualityNum: { fontSize: 14, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans },
  resultDot: { width: 8, height: 8, borderRadius: 999 },

  h1: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
