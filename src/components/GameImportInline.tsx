'use client';

/**
 * IMPORT RIGHT HERE — without sending the user to Stats.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mined deck and the openings list are both derived from a Lichess account's public games,
 * and both are built from one import pipeline (see `lib/scanPlan`). That pipeline only had one
 * door: the Stats tab. Every empty state on the other tabs therefore ended with the same
 * instruction — "import an account on the Stats tab" — which asks the user to leave the thing they
 * were trying to do and come back. The owner's request was exact: let them enter a username and
 * import IN PLACE.
 *
 * WHAT IT DOES
 * ------------
 * One card, three states, decided by the stored account rather than by props:
 *
 *   - No account: the username field and Continue. The account is persisted BEFORE anything is
 *     fetched — the lesson Stats learned the hard way: a fetch that fails must not throw away the
 *     handle the user entered — and switching away from a previous account wipes that account's
 *     data first, in the same order Stats does it.
 *   - Account saved, `importsGames`: the import button, then live progress and Stop. The scan
 *     itself is `importGames` — the SAME driver Stats runs — so the two surfaces cannot disagree
 *     about depth, caps or resumability.
 *   - Account saved, and the host builds its own way: one sentence (the host's
 *     `connectedNote`), and `onChanged` already fired on save so the host can rebuild.
 *
 * The games are read from the cache when it is fresh: a deliberate import should not start by
 * re-downloading a list the app already has, and offline users still have one.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Bar, Btn, Spinner } from '@/components/ui/Primitives';
import { colors, fonts, radii } from '@/theme/tokens';
import { cancelJob, clearJob, isJobRunning, useJob } from '@/lib/background';
import { SCAN_JOB, startScanJob, type ScanJobResult } from '@/lib/statsJobs';
import {
  LichessError, sanitizeLichessUser, fetchProfile, lichessAccountError,
} from '@/lib/lichess';
import {
  forgetAccount, loadActiveUsername, saveAccount,
} from '@/lib/lichessStore';
import { useAppStore } from '@/lib/store';

export function GameImportInline({
  what,
  importsGames = false,
  connectedNote,
  onChanged,
}: {
  /** What the import builds, woven into the copy — e.g. "puzzles". */
  what: string;
  /** True on a surface that runs the engine scan itself; false when the host only needed the
   *  username saved and imports on its own. */
  importsGames?: boolean;
  /** Copy shown when an account is saved and this card does not run the scan. */
  connectedNote?: string;
  /** Called after an account is saved and after every import ends, so the host reloads. */
  onChanged: () => void;
}) {
  /** `undefined` until the stored account has been read; `null` means none. */
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [stage, setStage] = useState<'idle' | 'running' | 'done'>('idle');
  const [phase, setPhase] = useState('');
  const [fraction, setFraction] = useState<number | null>(null);
  const [puzzles, setPuzzles] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * The scan is the shared `stats-scan` job, not a promise owned by this card.
   * If the user leaves Puzzles while games are being mined, the work continues
   * and this card rehydrates when they come back. It also means Stats and this
   * empty state can never run two scans of the same account at once.
   */
  const job = useJob<ScanJobResult>(SCAN_JOB);
  const appliedJob = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    loadActiveUsername()
      .then((u) => { if (alive) setAccount(u); })
      .catch(() => { if (alive) setAccount(null); });
    return () => { alive = false; };
  }, []);

  const connect = useCallback(async () => {
    const next = sanitizeLichessUser(name);
    if (!next || connecting) return;
    setError(null);
    setConnecting(true);
    try {
      /*
       * RESOLVE THE HANDLE FIRST, SAVE IT SECOND.
       *
       * This card used to persist the sanitized text before any request, so a
       * typo was saved as the account and only failed later, on the games
       * request — leaving a broken account connected and no way to tell why.
       * The profile lookup is one request, it is the same one the import will
       * make, and it is the only thing that can say the handle is real. The
       * canonical spelling Lichess returns is what gets stored.
       *
       * A NETWORK failure is not a verdict on the name, though. The original
       * lesson of this card stands: a handle the user typed must survive a bad
       * connection, so it is saved unresolved and the message says it could not
       * be checked.
       */
      let profile = null;
      try {
        profile = await fetchProfile(next);
      } catch (e) {
        if (e instanceof LichessError && (e.kind === 'not-found' || e.kind === 'disabled')) {
          setError(lichessAccountError(next, e));
          return;
        }
        setError(lichessAccountError(next, e));
      }
      if (profile?.disabled) {
        setError(lichessAccountError(profile.username, new LichessError('closed', 'disabled')));
        return;
      }
      const resolved = profile ? sanitizeLichessUser(profile.username) : next;

      /*
       * A DIFFERENT NAME MEANS THE OLD ACCOUNT'S SAVED DATA GOES FIRST — the owner's rule, and the
       * same order Stats uses: wipe before any state changes, so a failure mid-switch cannot leave
       * both accounts' data present. Done only after the new name is known not to be wrong.
       */
      if (account && account !== resolved) {
        cancelJob(SCAN_JOB);
        await forgetAccount(account);
        setStage('idle');
        setPhase('');
        setFraction(null);
        setPuzzles(null);
      }
      await saveAccount({
        username: resolved,
        joined: profile ? profile.joined : null,
        ratings: {},
        lastRefresh: 0,
      });
      // Training progress is per account; re-read it for the one just saved.
      await useAppStore.getState().reloadForAccount();
      setAccount(resolved);
      // The host reloads on connect: on Your openings the host's own build IS the import.
      onChanged();
    } catch (e) {
      setError(lichessAccountError(next, e));
    } finally {
      setConnecting(false);
    }
  }, [account, connecting, name, onChanged]);

  const runImport = useCallback(() => {
    if (!account || isJobRunning(SCAN_JOB)) return;
    clearJob(SCAN_JOB);
    setError(null);
    setStage('running');
    setPhase('Starting up…');
    setFraction(0);
    setPuzzles(null);
    // The job fetches the games if needed, boots the engine, scans and mines.
    void startScanJob(account);
  }, [account]);

  /*
   * Mirror the shared job. A running scan survives navigation; a finished one
   * is applied exactly once and then consumed so this card does not replay it.
   */
  useEffect(() => {
    if (!job || job.owner !== account) return;
    if (job.status === 'running') {
      setStage('running');
      setPhase(job.progress.label);
      setFraction(job.progress.indeterminate ? null : job.progress.pct / 100);
      return;
    }
    if (appliedJob.current === job.startedAt) return;
    appliedJob.current = job.startedAt;
    if (job.status === 'done' && job.result) {
      /*
       * RELOAD EVEN WHEN THE USER STOPPED. The scan persists as it goes — the
       * puzzles mined so far are already in the stored deck — so a stopped
       * import is not nothing: it is the part that is done.
       */
      setPuzzles(job.result.puzzles);
      setStage(job.result.stopped ? 'idle' : 'done');
      setPhase('');
      setFraction(null);
      onChanged();
    } else if (job.status === 'error') {
      setError(job.error ?? 'The import stopped.');
      setStage('idle');
      setPhase('');
      setFraction(null);
    }
    clearJob(SCAN_JOB);
  }, [job, account, onChanged]);

  const stop = useCallback(() => { cancelJob(SCAN_JOB); }, []);

  if (account === undefined) {
    return (
      <View style={s.loadRow}>
        <Spinner size={16} />
        <Text style={s.note}>Looking up that username…</Text>
      </View>
    );
  }

  if (account === null) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.body}>
          {`Enter a Lichess username to build ${what} from that account's public games.`}
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Lichess username"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => void connect()}
          editable={!connecting}
          style={s.input}
        />
        <Text style={s.note}>No password or login — only public games are read.</Text>
        <Btn
          label={connecting ? 'Checking…' : 'Continue'}
          onPress={() => void connect()}
          disabled={connecting || name.trim().length === 0}
        />
        {error ? <Text style={s.err}>{error}</Text> : null}
      </View>
    );
  }

  if (!importsGames) {
    return <Text style={s.body}>{connectedNote ?? `Using @${account}.`}</Text>;
  }

  if (stage === 'running') {
    return (
      <View style={{ gap: 8 }}>
        <Text style={s.body} numberOfLines={2}>
          {puzzles != null ? `${phase} · ${puzzles} positions so far` : phase}
        </Text>
        <Bar pct={fraction ?? 0} indeterminate={fraction == null} />
        <Btn label="Stop" variant="ghost" onPress={stop} />
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={s.body}>
        {stage === 'done'
          ? `Imported — ${puzzles ?? 0} positions from this account are ready to train.`
          : `Using @${account}. Import recent games and we will build ${what} from them as it `
            + 'runs. It can take a while, and you can stop any time — progress is saved.'}
      </Text>
      <Btn label={stage === 'done' ? 'Import again' : 'Import games'} onPress={() => void runImport()} />
      {error ? <Text style={s.err}>{error}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  loadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: { color: colors.mutedForeground, fontFamily: fonts.sans, fontSize: 12 },
  body: { color: colors.mutedForeground, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.foreground,
    fontFamily: fonts.sans,
    fontSize: 14,
    backgroundColor: colors.subtleFill,
  },
  err: { color: colors.bad, fontFamily: fonts.sans, fontSize: 12 },
});
