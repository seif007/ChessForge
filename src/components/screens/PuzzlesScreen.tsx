'use client';

/**
 * Puzzles screen — RN port of the web `screens/PuzzlesScreen.tsx`.
 *
 * TWO TABS, BOTH ONLINE-SOURCED
 * ----------------------------
 * `Training` — infinite fresh puzzles via `fetchNextPuzzle` (live Lichess when
 * online, and an explicit offline notice when not).
 *
 * `From your games` — replaces the old "Classics" tab. The user asked for the
 * ~17,000 bundled offline puzzles to be REMOVED and for that tab to show
 * positions from their own Lichess games "where they missed wins or blundered
 * or missed tactics". Those positions are mined by `minePuzzles()` during the
 * Stats scan and read back from kv-store here.
 *
 * The bundled `puzzles.json` (Classics) is deliberately no longer imported: keeping
 * a 17k-position deck in the bundle to power a tab nobody asked for any more was
 * both 3 MB of dead weight and a second source of truth for "what is a puzzle".
 * The tab is now driven entirely by the user's own games.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Animated, Easing,
} from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { Chess } from 'chess.js';
import { turnOf } from '@/lib/fen';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { MoveList } from '@/components/chess/MoveList';
import { playMoveSound, playEffect } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import { fetchNextPuzzle, puzzleFetchDiagnostic, type ServedPuzzle } from '@/lib/puzzleProvider';
import {
  PUZZLE_MODES, ratingLabel, themesList, hintForTheme, autoModeFor, bandRange, type PuzzleMode,
} from '@/lib/puzzles';
import { solvingPiece, targetSquares } from '@/lib/hint';
import { deltaForAttempt } from '@/lib/rating';
import { Card, Btn, IconBtn, Segmented, Spinner, Chip } from '@/components/ui/Primitives';
import {
  IconChevronLeft, IconChevronRight, IconLightbulb, IconRotateCcw,
  IconCheckCircle, IconXCircle, IconPuzzle, IconArrowRight, IconGlobe,
  IconInfinity, IconBookMarked, IconWifiOff, IconClock,
} from '@/components/ui/Icons';
import { colors, fonts, themedStyles } from '@/theme/tokens';
import { loadMinedDeck } from '@/lib/lichessStore';
import type { MinedPuzzle } from '@/lib/gameScan';
import { isMinedPuzzlePlayable, puzzleSolution } from '@/lib/puzzleLine';
import { QUALITY_META } from '@/lib/moveQuality';
import { GameImportInline } from '@/components/GameImportInline';

interface Position {
  fen: string;
  lastMove: { from: string; to: string } | null;
}

const MODE_KEY = 'chessforge.puzzle.mode.v1';

type PuzzleTab = 'training' | 'mine';

export function PuzzlesScreen() {
  const store = useAppStore();
  const puzzleStats = store.puzzles;
  const rating = store.profile.puzzleRating;

  const [tab, setTab] = useState<PuzzleTab>('training');
  const [mode, setMode] = useState<PuzzleMode>('auto');
  const [minedCount, setMinedCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    Storage.getItem(MODE_KEY).then((saved) => {
      if (alive && saved && (saved === 'auto' || PUZZLE_MODES.some((m) => m.id === saved))) {
        setMode(saved as PuzzleMode);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // How many mined puzzles exist, for the tab's subtitle. Cheap read, and it
  // lets the tab advertise an empty state before the user opens it.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { username: user, puzzles } = await loadMinedDeck();
        if (!user) { if (alive) setMinedCount(0); return; }
        if (alive) setMinedCount(puzzles.filter(isMinedPuzzlePlayable).length);
      } catch {
        if (alive) setMinedCount(0);
      }
    })();
    return () => { alive = false; };
  }, [tab]);

  const changeMode = (m: PuzzleMode) => {
    setMode(m);
    void Storage.setItem(MODE_KEY, m).catch(() => {});
  };

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <View style={s.titleRow}>
            <IconPuzzle size={20} color={colors.chessforge} />
            <Text style={s.h1}>Puzzles</Text>
          </View>
          <Text style={s.bodySm}>
            {tab === 'training'
              ? 'Fresh puzzles, matched to your level'
              : minedCount == null
                ? 'Loading…'
                : minedCount === 0
                  ? 'No puzzles mined yet'
                  : `${minedCount} puzzles from your games`}
          </Text>
        </View>
        <View style={s.ratingBox}>
          <Text style={s.ratingNum}>{rating}</Text>
          <Text style={s.ratingLabel}>{ratingLabel(rating)}</Text>
        </View>
      </View>

      <Segmented
        options={[
          { id: 'training' as const, label: 'Training' },
          { id: 'mine' as const, label: 'From your games' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'training' ? (
        <TrainingTab mode={mode} changeMode={changeMode} />
      ) : (
        <FromYourGamesTab onCount={setMinedCount} />
      )}
    </View>
  );
}

/* ============================ Training tab ============================ */

/**
 * The moves of this attempt, plus an explicit statement of which colour is being played.
 *
 * THE USER ASKED FOR THIS: *"i want the last move to be showed so i know that
 * i am playing with white or black and what is the last move."*
 *
 * The board is oriented to the player's colour, which does convey it — but only to someone who
 * already knows how to read an orientation, and never as a statement. A puzzle starts from an
 * arbitrary mid-game position, so "it is my turn" is genuinely ambiguous: the same position is
 * a White puzzle one day and a Black puzzle the next with nothing on screen to say which. The
 * shared `MoveList` is given the starting FEN so its numbering and its colours are right, and
 * the side is spelled out beside it.
 *
 * One list for the whole app rather than a second, puzzle-specific one: this screen, Endgames,
 * Train, Practice and Analysis all show the same moves, and two implementations of "numbered
 * move list" is how they drift apart.
 */
function MoveBar({ startFen, sans, userColor }: { startFen: string; sans: string[]; userColor: 'w' | 'b' }) {
  return (
    <View style={s.moveBar}>
      <View style={s.moveBarHead}>
        <View style={[s.sideDot, { backgroundColor: userColor === 'w' ? '#e9f1ea' : '#2a2f39' }]} />
        <Text style={s.moveBarSideText}>You play {userColor === 'w' ? 'White' : 'Black'}</Text>
        <Text style={s.moveBarTurn} numberOfLines={1}>
          {sans.length === 0
            ? `· ${userColor === 'w' ? 'White' : 'Black'} to move — find the winning line`
            : `· last: ${sans[sans.length - 1]}`}
        </Text>
      </View>
      <MoveList sans={sans} currentPly={sans.length} startFen={startFen} style={s.moveBarList} />
    </View>
  );
}

function TrainingTab({ mode, changeMode }: { mode: PuzzleMode; changeMode: (m: PuzzleMode) => void }) {
  const store = useAppStore();
  const [puzzle, setPuzzle] = useState<ServedPuzzle | null>(null);
  type LoadReason = 'no-puzzle' | 'rate-limited' | 'offline' | 'error' | null;

  const [loading, setLoading] = useState(true);
  /*
   * WHY THE FAILURE, rather than a boolean.
   *
   * This was `const [loadError, setLoadError] = useState(false)`, and the catch was
   * `catch { setLoadError(true) }` with nothing kept. So every failure printed the same sentence —
   * "Could not load a puzzle. Check your connection and try again" — for a 429 rate limit, a 401, a
   * changed response shape, a puzzle whose solution would not reconstruct, and an actual loss of
   * network. The user's report:
   *
   *     *"i tried puzzles and it says to check my connection although i am connected (the endgames
   *     works fine although it needs connection but the puzzles doesnt work)"*
   *
   * He was right, and the probe confirmed it: the endpoint answers 200 with real puzzles. The
   * failure was the app's own rating window rejecting everything, and the notice blamed the one
   * thing that was not wrong. Endgames shares the same host and the same unauthenticated rate limit,
   * so it can genuinely work at the moment puzzles cannot — which is what made the message look
   * absurd rather than merely wrong.
   *
   * So the reason is carried, and the screen says which of these it was. "Rate limited, try again in
   * a moment" and "no connection" ask the user for different things, and a screen that cannot tell
   * them apart will eventually tell him to check his wifi while his wifi is fine.
   */
  /**
   * WHY A PUZZLE DID NOT LOAD, when one did not.
   *
   * The distinction the screen could not previously make, and the reason the notice was wrong rather
   * than merely terse. `no-puzzle` is the case the user hit: the endpoint answered, and the app
   * discarded every answer because of its own rating window. `offline` is a genuine network failure
   * and is the ONLY one that should ever tell him to check his connection.
   *
   * Declared at the top of the component, with the rest of its state, because it describes what THIS
   * screen can be told — and the notice's copy table below reads it as the key of an exhaustive
   * record. It is a union of four strings, so nothing outside this file can widen it by accident, and
   * `COPY[loadReason]` fails to compile if a fifth reason is added without copy.
   */
  const [loadReason, setLoadReason] = useState<LoadReason>(null);
  const loadError = loadReason !== null;
  const [startFen, setStartFen] = useState('');
  const [fen, setFen] = useState('');
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  /**
   * Every move played in this attempt, in SAN, oldest first.
   *
   * THE USER ASKED FOR THIS: *"i want the last move to be showed so i know
   * that i am playing with white or black and what is the last move."*
   *
   * The board is oriented to the player's colour, which does tell you the colour — but only
   * if you already know how to read an orientation, and it never says which move led here.
   * A puzzle starts from an arbitrary mid-game position, so "it is my turn" is genuinely
   * ambiguous: the same position is a White puzzle on one day and a Black puzzle on another,
   * with nothing on screen to tell you which. Keeping the SAN list makes both facts readable
   * at a glance, because the odd plies are White's and the even ones Black's.
   *
   * SAN rather than from/to, because the point is to read the moves. Chess.js produced them
   * already in `handleMove` and the opponent replies come from `solutionSan`, so nothing new
   * has to be computed for them.
   */
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [wrongCount, setWrongCount] = useState(0);
  const [solved, setSolved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showHint, setShowHint] = useState(false);
  /** 0 = none, 1 = ring the one piece the solution plays, 2 = also dot where it can go. */
  const [hintStage, setHintStage] = useState(0);
  const [usedHint, setUsedHint] = useState(false);
  const [lastDelta, setLastDelta] = useState<number | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [recorded, setRecorded] = useState(false);
  const [session, setSession] = useState({ solved: 0, streak: 0, best: 0 });
  const lastAttemptRef = useRef('');
  const reqIdRef = useRef(0);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: -1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true, easing: Easing.linear }),
    ]).start();
  }, [shakeAnim]);

  const fetchPuzzle = useCallback(async (m: PuzzleMode) => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setLoadReason(null);
    try {
      const data = await fetchNextPuzzle(m);
      /*
       * NO PUZZLE IS NOT AN ERROR, and the distinction is the whole of the report.
       *
       * `fetchNextPuzzle` returning `null` means the endpoint answered and nothing in the answers
       * was usable — the rating window rejected all of them. It does NOT mean the network is down.
       * The old code threw on `null` and the catch set the offline notice, so the two were reported
       * identically and the user was told to check a connection that was working.
       *
       * The provider's own diagnostic is exported alongside the puzzle, so the screen can say
       * whether this was a rate limit — which the shared, unauthenticated Lichess endpoint applies
       * to every caller, the endgames tab included — or a genuine absence.
       */
      if (!data) {
        if (reqId !== reqIdRef.current) return;
        /*
         * THE MAPPING, AND IT HAD A HOLE.
         *
         * This was `diagnostic() === 'rate-limited' ? 'rate-limited' : 'no-puzzle'` — a binary that
         * sent everything else to `no-puzzle`. There was no branch that could produce `'offline'`, so
         * the "No connection" copy below was unreachable dead text, and a user with no network was
         * shown:
         *
         *     "We asked and the service had nothing at your rating right now. That is not a
         *      connection problem."
         *
         * The user, precisely: *"i tried the app without connection for puzzles and it says provider
         * problem while it had to say internet problem."*
         *
         * Now every diagnostic maps to exactly one reason. `offline` is a request that never produced
         * a response and is the only one that may tell the user to check their connection; `http-error`
         * is the endpoint answering with a failure, which is the provider's; `none` is the endpoint
         * answering with nothing usable, which is also the provider's but is a different sentence.
         */
        const d = puzzleFetchDiagnostic();
        setLoadReason(
          d === 'offline' ? 'offline'
            : d === 'rate-limited' ? 'rate-limited'
              : d === 'http-error' ? 'error'
                : 'no-puzzle',
        );
        return;
      }
      if (reqId !== reqIdRef.current) return;
      setPuzzle(data);
      setStartFen(data.fen);
      setFen(data.fen);
      setLastMove(null);
      setPlayedSans([]);
      setStep(0);
      setWrongCount(0);
      setSolved(false);
      setFailed(false);
      setShowHint(false);
      setHintStage(0);
      setUsedHint(false);
      setLastDelta(null);
      setRecorded(false);
      lastAttemptRef.current = '';
    } catch {
      if (reqId === reqIdRef.current) setLoadReason('error');
    } finally {
      if (reqId === reqIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchPuzzle(mode); }, [fetchPuzzle, mode]);

  const themes = useMemo(() => (puzzle ? themesList(puzzle.themes.join(',')) : []), [puzzle]);

  /**
   * The band the current puzzle was actually measured against.
   *
   * This must be the SAME expression `fetchNextPuzzle` used, or the off-band note describes a range
   * the puzzle was never checked against: an explicit choice is honoured exactly, and only `auto`
   * resolves the band from the rating. Duplicated here rather than returned by the provider because
   * the screen already knows the mode and the rating, and a second copy inside the provider would have
   * to be kept in step with the first.
   */
  const servedBand: PuzzleMode =
    mode === 'auto' ? autoModeFor(store.profile.puzzleRating ?? 800) : mode;

  const finish = useCallback((didSolve: boolean, attempts: number) => {
    setSolved(didSolve);
    if (!didSolve) setFailed(true);
    if (didSolve) playEffect('success');
    if (recorded || !puzzle) return;
    setRecorded(true);
    const firstTry = attempts === 0;
    // Elo against the puzzle's OWN rating (see src/lib/rating.ts). A wrong move
    // or a hint drops the score to 0.5, which turns a gain into nothing and,
    // once you are rated above the puzzle, into a loss — so help has a cost.
    const { delta } = deltaForAttempt(store.profile.puzzleRating, puzzle.rating, {
      solved: didSolve,
      madeMistake: !firstTry,
      usedHint,
    });
    setLastDelta(delta);
    const xp = didSolve ? (firstTry && !usedHint ? 20 : 10) : 4;
    setSession((st) => ({
      solved: st.solved + (didSolve ? 1 : 0),
      streak: didSolve ? st.streak + 1 : 0,
      best: Math.max(st.best, didSolve ? st.streak + 1 : st.streak),
    }));
    store.applyResult({
      type: 'puzzle',
      xp,
      correct: didSolve ? 1 : 0,
      total: 1,
      puzzle: { puzzleId: puzzle.id, solved: didSolve, ratingDelta: delta },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorded, puzzle, store, usedHint]);

  const playOpponentReply = useCallback((fromFen: string, san: string, nextStep: number) => {
    const c = new Chess(fromFen);
    /*
     * THE HINT IS ABOUT ONE POSITION, SO IT ENDS WHEN THAT POSITION DOES.
     *
     * THE REPORT: *"when i click hint and then play the move it still select the piece (that i should
     * move) in the next move"*.
     *
     * The hint was state that survived the move: `showHint` stayed true and `hintStage` stayed put,
     * so the ring from the position the player had already solved was still on the board over the
     * next one. It then pointed at a piece in a position it was never asked about - which is the
     * hint answering a different question than the one on screen.
     *
     * So it is cleared here, where the position actually changes, rather than only when a whole new
     * puzzle arrives. Both puzzles and drills need it, and this function is the one place each of
     * them passes through on every opponent reply.
     */
    setShowHint(false);
    setHintStage(0);
    try {
      const m = c.move(san);
      setTimeout(() => {
        setFen(c.fen());
        setLastMove({ from: m.from, to: m.to });
        setPlayedSans((prev) => [...prev, m.san]);
        playMoveSound(m);
        setStep(nextStep);
      }, 420);
    } catch {
      setStep(nextStep);
    }
  }, []);

  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!puzzle || solved || failed) return false;
    const attemptKey = `${step}:${from}${to}`;
    if (lastAttemptRef.current === attemptKey) return false;
    lastAttemptRef.current = attemptKey;
    const c = new Chess(fen);
    let m;
    try { m = c.move({ from, to, promotion }); } catch { return false; }

    const expected = puzzle.solutionSan[step];
    if (m.san === expected) {
      const isLast = step === puzzle.solutionSan.length - 1;
      // Same rule as the reply above: the hint belonged to the position just solved.
      setShowHint(false);
      setHintStage(0);
      setFen(c.fen());
      setLastMove({ from: m.from, to: m.to });
      setPlayedSans((prev) => [...prev, m.san]);
      playMoveSound(m);
      if (isLast) {
        setTimeout(() => finish(true, wrongCount), 250);
      } else {
        playOpponentReply(c.fen(), puzzle.solutionSan[step + 1], step + 2);
      }
      return true;
    }

    playEffect('wrong');
    setWrongCount((w) => w + 1);
    setShakeKey((k) => k + 1);
    shake();
    if (wrongCount + 1 >= 2) { setShowHint(true); setHintStage(1); setUsedHint(true); }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, solved, failed, puzzle, step, wrongCount, finish, playOpponentReply, shake]);

  const giveUp = () => {
    if (!puzzle) return;
    const c = new Chess(startFen);
    const moves: { from: string; to: string; m: { san: string; captured?: string; flags?: string } | null }[] = [];
    for (const san of puzzle.solutionSan) {
      try { const m = c.move(san); moves.push({ from: m.from, to: m.to, m }); } catch { break; }
    }
    let i = 0;
    const iv = setInterval(() => {
      if (i >= moves.length) {
        clearInterval(iv);
        finish(false, wrongCount);
        return;
      }
      setFen(c.fen());
      setLastMove(moves[i]);
      playMoveSound(moves[i].m);
      i++;
    }, 500);
  };

  const retry = () => {
    setFen(startFen);
    setLastMove(null);
    setPlayedSans([]);
    setStep(0);
    setWrongCount(0);
    setSolved(false);
    setFailed(false);
    setShowHint(false);
    setHintStage(0);
    setUsedHint(false);
    setLastDelta(null);
    setRecorded(false);
    lastAttemptRef.current = '';
  };

  /*
   * Hint: ring the pieces that can move, then dot where they can go.
   *
   * THIS WAS THE PUZZLE'S ANSWER, DRAWN ON THE BOARD. It read `puzzle.solutionSan[step]` — the very
   * move being asked for — and drew it as a gold arrow, so tapping Hint solved the position. The
   * owner's words: *"i clicked on hint and instead of coloring the piece that i should move, it
   * showed me an arrow on where to move it so basically it showed me the solution"*. Correct on every
   * count, and it was the worst of the four because on a puzzle the solution is exact and sitting
   * right there in the state.
   *
   * Nothing about the hint needed the solution, and nothing needs an engine either: it is a read of
   * the position. See `@/lib/hint`.
   *
   * HOOK-ORDER WARNING: this hook must stay ABOVE every early `return` below.
   * `puzzle` is null while loading, and the previous placement (after
   * `if (!puzzle) return null;`) made React see one fewer hook on the loading
   * render than on the loaded render - "Rendered more hooks than during the
   * previous render", which crashes the app the instant the puzzle arrives.
   * That is why it reads raw state (`solved`/`failed`) instead of the
   * `userToMove` const, which is declared further down.
   */
  const hintOn = showHint && !!puzzle && !solved && !failed;
  //
  // ONE piece, and it is the one that plays the solution: "which of these?" is the question
  // the hint exists to shrink, and a guess about which move looks interesting was wrong often enough
  // to be reported twice. The destination is press 2, so the two-step contract is unchanged.
  const hintFrom = useMemo(
    () => (hintOn ? solvingPiece(fen, puzzle?.solutionSan?.[step]) : []),
    [hintOn, fen, puzzle, step],
  );
  const hintTo = useMemo(
    () => (hintOn && hintStage >= 2 ? targetSquares(fen, hintFrom) : []),
    [hintOn, hintStage, fen, hintFrom],
  );

  if (loading && !puzzle) {
    return (
      <Card style={{ padding: 32, alignItems: 'center', gap: 12 }}>
        <Spinner />
        <Text style={[s.bodySm, { textAlign: 'center' }]}>Fetching a fresh puzzle for your level…</Text>
      </Card>
    );
  }

  if (loadError && !puzzle) {
    /*
     * THE FAILURE, NAMED FOR WHAT IT IS.
     *
     * One sentence used to cover every possible cause: "Could not load a puzzle. Check your
     * connection and try again". The user reported it as absurd, and it was — the endpoint answers
     * 200, and the real fault was the app's own rating window. The notice blamed the network.
     *
     * So each cause gets the sentence that asks the user for the right thing. A rate limit is the
     * common case and is NOT their fault: the endpoint is unauthenticated and shared with the
     * endgames tab, so it can be serving that tab while limiting this one.
     */
    const COPY: Record<Exclude<LoadReason, null>, { icon: 'wifi' | 'info'; title: string; body: string }> = {
      'rate-limited': {
        icon: 'info',
        title: 'Puzzle service is busy',
        body: 'Too many requests just now — this is the puzzle provider’s limit, not your connection. '
          + 'Wait a minute and try again. The Endgames tab uses the same service, which is why it '
          + 'can keep working while this one is limited.',
      },
      'no-puzzle': {
        icon: 'info',
        title: 'No puzzle matched your level',
        body: 'We asked and the service had nothing at your rating right now. That is not a '
          + 'connection problem. Try again, or pick a different level.',
      },
      offline: {
        icon: 'wifi',
        title: 'No connection',
        body: 'The app could not reach the puzzle service at all, so nothing came back to play. '
          + 'Check your connection and try again.',
      },
      error: {
        icon: 'info',
        title: 'Could not load a puzzle',
        body: 'The service answered, but with an error rather than a puzzle. This is on their side '
          + 'rather than yours — try again in a moment.',
      },
    };
    // `loadError` is `loadReason !== null`, so the key is present; the exclusion is on the type, not
    // the value, so a future reason added without copy would fail to compile here rather than render
    // an empty card.
    const copy = COPY[loadReason!];
    return (
      <Card style={{ padding: 32, alignItems: 'center', gap: 12 }}>
        {copy.icon === 'wifi'
          ? <IconWifiOff size={22} color={colors.mutedForeground} />
          : <IconClock size={22} color={colors.gold} />}

        <Text style={[s.h2, { textAlign: 'center' }]}>{copy.title}</Text>
        <Text style={[s.bodySm, { textAlign: 'center', lineHeight: 18 }]}>{copy.body}</Text>
        <Btn label="Retry" small onPress={() => void fetchPuzzle(mode)} />
      </Card>
    );
  }

  if (!puzzle) return null;

  /*
   * WHOSE TURN IT IS, WITHOUT BUILDING A BOARD.
   *
   * This ran `new Chess(fen).turn()` in the render body, so every touch, every opponent reply
   * and every hint re-parsed the whole position to read one character of it. See `@/lib/fen`;
   * `Chess` is still used below for the moves themselves.
   */
  const turn = turnOf(fen);
  const userToMove = turn === puzzle.side && !solved && !failed;


  const statusText = solved
    ? 'Solved!'
    : failed
      ? 'Solution shown — study the pattern.'
      : userToMove
        ? `${puzzle.side === 'w' ? 'White' : 'Black'} to play`
        : 'Opponent replies…';
  const hint = themes.length ? hintForTheme(themes[0]) : null;

  return (
    <View style={{ gap: 12 }}>
      {/* difficulty selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {[
          {
            id: 'auto' as PuzzleMode,
            label: `Auto · ${
              PUZZLE_MODES.find((x) => x.id === autoModeFor(store.profile.puzzleRating))?.label ?? '—'
            }`,
          },
          ...PUZZLE_MODES.map((m) => ({ id: m.id as PuzzleMode, label: m.label })),
        ].map((m) => (
          <Pressable
            key={m.id}
            onPress={() => changeMode(m.id)}
            style={[s.modeChip, mode === m.id ? s.modeChipActive : null]}
          >
            <Text style={[s.modeChipText, mode === m.id ? { color: colors.gold } : null]}>{m.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* board */}
      <Animated.View key={shakeKey} style={{ transform: [{ translateX: shakeAnim.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) }] }}>
        <ChessForgeBoard
          fen={fen}
          orientation={puzzle.side === 'w' ? 'white' : 'black'}
          interactive={userToMove}
          onMove={handleMove}
          lastMove={lastMove}
          hintFrom={hintFrom}
          hintTo={hintTo}
        />
      </Animated.View>

      {/* the moves of this attempt, and which colour the user is playing */}
      {puzzle ? (
        <MoveBar startFen={startFen} sans={playedSans} userColor={puzzle.side === 'w' ? 'w' : 'b'} />
      ) : null}

      {/* status card */}
      <Card style={{ gap: 12 }}>
        <View style={s.puzzleHeaderRow}>
          <View style={{ flex: 1 }}>
            <View style={s.puzzleSourceRow}>
              {puzzle.source === 'live' ? <IconGlobe size={13} color={colors.chessforge} /> : <IconBookMarked size={13} color={colors.chessforge} />}
              <Text style={s.puzzleSource}>
                {puzzle.source === 'live' ? 'Fresh from the provider' : 'Puzzle pool'}
                <Text style={s.bodySm}> · rating {puzzle.rating}</Text>
              </Text>
            </View>
            <Text style={s.bodySm}>
              {themes.length > 0 ? themes.map((t) => t.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(' · ') : 'tactics'} · {statusText}
            </Text>
            {/*
             * SAY WHEN A PUZZLE IS OFF YOUR LEVEL.
             *
             * The provider's last resort serves the nearest rating the endpoint actually produced rather
             * than refusing to serve anything, because "no puzzle" is the worse failure for someone who
             * is online and waiting. The code that does it has always carried the note "and SAY SO" —
             * and nothing implemented that half, so a puzzle up to 400 points outside the chosen band
             * arrived looking identical to one inside it, directly under a subtitle promising puzzles are
             * "matched to your level".
             *
             * So the distance the provider measured is shown. Deliberately a plain sentence rather than
             * a warning icon: it is usually a small overshoot caused by the easy bucket having no
             * puzzles below ~1300, which is a fact about the source and not a fault of the user. The
             * direction is stated, because "above" and "below" mean opposite things to someone who
             * wanted to be challenged.
             */}
            {puzzle.offBandBy ? (
              <Text style={[s.bodySm, { color: colors.gold, marginTop: 2 }]}>
                {puzzle.rating > bandRange(servedBand)[1] ? 'above' : 'below'} the range for your level
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {wrongCount > 0 && !solved ? (
              <View style={s.mistakeRow}>
                <IconXCircle size={12} color={colors.bad} />
                <Text style={s.mistakeText}>{wrongCount}</Text>
              </View>
            ) : null}
            {!solved && !failed ? (
              <IconBtn onPress={retry} label="Reset puzzle">
                <IconRotateCcw size={15} color={colors.mutedForeground} />
              </IconBtn>
            ) : null}
            {/*
              * A HINT AFTER THE PUZZLE IS OVER IS A BUTTON THAT DOES NOTHING.
              *
              * `hintOn` requires `!solved && !failed`, so past either of those the press was accepted,
              * incremented a stage nothing reads, and drew nothing — the "hint doesnt work in a place"
              * half of the report. It is not that the hint was broken; it is that the control stayed
              * on screen after the question had been answered, and an inert control is indistinguish-
              * able from a broken one. The Reset button beside it was already guarded this way.
              */}
            {!solved && !failed ? (
              <IconBtn
                onPress={() => {
                  // 0 -> ring the piece, 1 -> also dot the destinations, 2 -> hide again.
                  setHintStage((s) => (s + 1) % 3);
                  setShowHint(true);
                  setUsedHint(true);
                }}
                label="Show hint"
              >
                <IconLightbulb size={15} color={colors.gold} />
              </IconBtn>
            ) : null}
          </View>
        </View>

        {showHint && !solved && !failed && hint ? (
          <Text style={[s.hintText, { lineHeight: 17 }]}>{hint}</Text>
        ) : null}

        {solved ? (
          <View style={s.solvedRow}>
            <IconCheckCircle size={16} color={colors.primary} />
            <Text style={s.solvedText}>
              {wrongCount === 0 && !usedHint ? 'First try — flawless!' : 'Solved!'}
              {usedHint ? <Text style={s.bodySm}> · hint used</Text> : null}
              {session.streak > 1 ? <Text style={s.bodySm}> · {session.streak} in a row</Text> : null}
            </Text>
            {lastDelta !== null ? (
              <Text style={[s.deltaText, lastDelta >= 0 ? s.deltaUp : s.deltaDown]}>
                {lastDelta >= 0 ? `+${lastDelta}` : `${lastDelta}`}
              </Text>
            ) : null}
          </View>
        ) : null}
        {failed ? (
          <View style={{ gap: 10 }}>
            {lastDelta !== null ? (
              <Text style={[s.deltaText, s.deltaDown]}>
                {lastDelta >= 0 ? `+${lastDelta}` : `${lastDelta}`} rating
              </Text>
            ) : null}
            <Btn label="Try again from the start" variant="ghost" onPress={retry} />
          </View>
        ) : null}

        {/* nav */}
        <View style={s.navRow}>
          <IconBtn onPress={() => void fetchPuzzle(mode)} label="Skip puzzle" style={s.navOutlineBtn}>
            {loading ? <Spinner size={15} /> : <IconChevronRight size={15} color={colors.foreground} />}
          </IconBtn>
          <Btn
            label={failed ? 'Retry' : 'Show solution'}
            variant="ghost"
            small
            onPress={failed ? retry : giveUp}
            style={{ flex: 1 }}
          />
          <Btn
            label={solved ? 'Next puzzle' : 'Skip'}
            small
            onPress={() => void fetchPuzzle(mode)}
            style={{ flex: 1 }}
          />
        </View>
      </Card>

      {/* session line */}
      <Text style={[s.bodySm, { textAlign: 'center' }]}>
        This session: <Text style={{ color: colors.primary, fontWeight: '600' }}>{session.solved}</Text> solved
        {session.best > 1 ? <> · best streak <Text style={{ color: colors.gold, fontWeight: '600' }}>{session.best}</Text></> : null}
        {' '}· puzzles never repeat until the pool runs dry
      </Text>
    </View>
  );
}

'use client';

/* ====================== From your games tab ====================== */

/**
 * "From your games" — replaces the old Classics tab.
 *
 * WHAT THE USER ASKED FOR
 * -----------------------
 * Remove the ~17,000 offline puzzles and replace Classics with a tab where the
 * problems come from positions in the user's OWN Lichess games "where he
 * missed wins or blundered or missed tactics".
 *
 * WHERE THE POSITIONS COME FROM
 * -----------------------------
 * `minePuzzles()` in `@/lib/gameScan` runs a second engine pass during the Stats
 * scan and stores a `MinedPuzzle[]` in the per-account kv-store record. This tab
 * is purely a reader of that: it never runs the engine itself, so opening it is
 * instant and works offline once a scan has happened.
 *
 * ORDERING: hardest first, which `minePuzzles` already guarantees by sorting on
 * `lossCp` descending. That is the right order for training — the position the
 * user lost the most in is the one most worth recognising.
 *
 * SRS: solved state is keyed by `MinedPuzzle.id` (`<gameId>:<ply>`) through the
 * same `store.applyResult` path the rest of the app uses, so it survives a
 * rescan (the id is stable) and shows up in the shared puzzle stats.
 */
function FromYourGamesTab({ onCount }: { onCount?: (n: number) => void }) {
  const store = useAppStore();
  const puzzleStats = store.puzzles;

  const [puzzles, setPuzzles] = useState<MinedPuzzle[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [fen, setFen] = useState('');
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  /** How many stored records were the retired one-move format. */
  const [legacyCount, setLegacyCount] = useState(0);
  /** Index into the forced line. Even = the user to move, odd = the opponent's reply. */
  const [step, setStep] = useState(0);
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [solved, setSolved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  const [usedHint, setUsedHint] = useState(false);
  const [showHint, setShowHint] = useState(false);
  /** 0 = none, 1 = ring the one piece the solution plays, 2 = also dot where it can go. */
  const [hintStage, setHintStage] = useState(0);
  const [lastDelta, setLastDelta] = useState<number | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [recorded, setRecorded] = useState(false);
  /** The "show solution" animation, cleared when the position changes or the tab unmounts. */
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** A pending opponent reply, cleared for the same reason: it belongs to one position. */
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The short delay before a solved line is recorded, cleared with the other two. */
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shakeAnim = useRef(new Animated.Value(0)).current;
  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: -1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true, easing: Easing.linear }),
    ]).start();
  }, [shakeAnim]);

  /**
   * ONE READER FOR THE DECK. The mount effect below and the reload after an in-place import both
   * go through this, so the empty state, the tab subtitle and the deck itself cannot disagree
   * about what is stored. `alive` lets the mount path bail out of a read that lands after unmount.
   */
  const readDeck = useCallback(async (alive: () => boolean = () => true) => {
    try {
      const { puzzles: deck } = await loadMinedDeck();
      if (!alive()) return;
      /*
       * RETIRE THE ONE-MOVE DECK, DO NOT PRETEND IT IS A PUZZLE.
       *
       * The old records are still readable, but showing them would reproduce the exact complaint
       * this change answers. They are hidden and counted separately so the empty state can say
       * why. SRS state is keyed by puzzle id, so a re-import brings the same ids back with the new
       * forced lines and the training history reattaches.
       */
      const playable = deck.filter(isMinedPuzzlePlayable);
      setLegacyCount(deck.length - playable.length);
      // Newest/hardest first as stored; no re-sort so the order is stable
      // between sessions (an unstable deck is maddening to train on).
      setPuzzles(playable);
      onCount?.(playable.length);
    } catch {
      if (!alive()) return;
      setLegacyCount(0);
      setPuzzles([]);
      onCount?.(0);
    }
  }, [onCount]);

  // Load the mined deck once, then hand the count up for the tab subtitle.
  useEffect(() => {
    let alive = true;
    void readDeck(() => alive);
    return () => { alive = false; };
  }, [readDeck]);

  const puzzle = puzzles && puzzles.length > 0 ? puzzles[idx] : null;
  /**
   * The forced line for the current record. Old one-move records are filtered out by `readDeck`,
   * but the fallback keeps this expression total while the deck is loading.
   */
  const solution = useMemo(() => (puzzle ? puzzleSolution(puzzle) : []), [puzzle]);

  /** Stop every delayed board write before it can land on a new position. */
  const stopTimers = useCallback(() => {
    if (revealTimerRef.current) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    if (replyTimerRef.current) {
      clearTimeout(replyTimerRef.current);
      replyTimerRef.current = null;
    }
    if (finishTimerRef.current) {
      clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  /** Reset every per-position bit of state and load a new position. */
  const loadAt = useCallback((i: number, list?: MinedPuzzle[]) => {
    const arr = list ?? puzzles ?? [];
    if (arr.length === 0) return;
    const p = arr[((i % arr.length) + arr.length) % arr.length];
    stopTimers();
    setIdx(arr.indexOf(p));
    setFen(p.fen);
    setLastMove(null);
    setStep(0);
    setPlayedSans([]);
    setSolved(false);
    setFailed(false);
    setWrongCount(0);
    setUsedHint(false);
    setShowHint(false);
    setHintStage(0);
    setLastDelta(null);
    setRecorded(false);
  }, [puzzles, stopTimers]);

  // First paint: jump to the first unsolved position, so reopening the tab does
  // not make the user re-solve what they already know.
  useEffect(() => {
    if (!puzzles || puzzles.length === 0) return;
    const firstUnsolved = puzzles.findIndex((p) => !puzzleStats[p.id]?.solved);
    loadAt(firstUnsolved === -1 ? 0 : firstUnsolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puzzles]);

  const finish = useCallback((didSolve: boolean, attempts: number) => {
    setSolved(didSolve);
    if (!didSolve) setFailed(true);
    if (didSolve) playEffect('success');
    if (recorded || !puzzle) return;
    setRecorded(true);
    const firstTry = attempts === 0;
    // Mined positions have no published rating, so we score them against the
    // user's own puzzle Elo — a position from their own game is, by definition,
    // at their level. `deltaForAttempt` handles the arithmetic.
    const { delta } = deltaForAttempt(store.profile.puzzleRating, store.profile.puzzleRating, {
      solved: didSolve,
      madeMistake: !firstTry,
      usedHint,
    });
    setLastDelta(delta);
    const xp = didSolve ? (firstTry && !usedHint ? 20 : 10) : 4;
    store.applyResult({
      type: 'puzzle',
      xp,
      correct: didSolve ? 1 : 0,
      total: 1,
      puzzle: { puzzleId: puzzle.id, solved: didSolve, ratingDelta: delta },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorded, puzzle, store, usedHint]);

  const lastAttemptRef = useRef<string>('');

  /**
   * The opponent's reply in the forced line, played automatically.
   *
   * The user is not asked to find this move; the puzzle is about what the solver does before and
   * after it. Clearing the hint here is deliberate: the hint belonged to the position that was
   * just solved, and carrying it onto the opponent's turn would ring a piece that is not the
   * user's to move.
   */
  const playOpponentReply = useCallback((fromFen: string, san: string, nextStep: number) => {
    setShowHint(false);
    setHintStage(0);
    const c = new Chess(fromFen);
    try {
      const m = c.move(san);
      if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
      replyTimerRef.current = setTimeout(() => {
        replyTimerRef.current = null;
        setFen(c.fen());
        setLastMove({ from: m.from, to: m.to });
        setPlayedSans((prev) => [...prev, m.san]);
        playMoveSound(m);
        setStep(nextStep);
      }, 420);
    } catch {
      setStep(nextStep);
    }
  }, []);

  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!puzzle || solved || failed || solution.length === 0) return false;
    const expected = solution[step];
    if (!expected) return false;
    const attemptKey = `${idx}:${step}:${from}${to}`;
    if (lastAttemptRef.current === attemptKey) return false;
    lastAttemptRef.current = attemptKey;

    const c = new Chess(fen);
    let m;
    try { m = c.move({ from, to, promotion }); } catch { return false; }

    const playedUci = m.from + m.to + (m.promotion ?? '');
    /*
     * THE ANSWER IS THE CURRENT STEP OF THE LINE.
     *
     * The old tab compared against `puzzle.bestUci`, the first move, and finished there. That is
     * why it was a one-move quiz: the rest of the solution was never on the board. The line's
     * even plies are the user's moves; odd plies are the opponent's replies and are played by
     * `playOpponentReply`, never offered to the board.
     */
    if (playedUci === expected.uci) {
      // The hint belonged to the position just solved; the next one starts clean. See the note on
      // the live tab's reply handler for why it is cleared where the position changes.
      setShowHint(false);
      setHintStage(0);
      setFen(c.fen());
      setLastMove({ from: m.from, to: m.to });
      setPlayedSans((prev) => [...prev, m.san]);
      playMoveSound(m);

      const isLast = step === solution.length - 1;
      if (isLast) {
        if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
        finishTimerRef.current = setTimeout(() => {
          finishTimerRef.current = null;
          finish(true, wrongCount);
        }, 250);
      } else {
        playOpponentReply(c.fen(), solution[step + 1].san, step + 2);
      }
      return true;
    }

    playEffect('wrong');
    setWrongCount((w) => w + 1);
    setShakeKey((k) => k + 1);
    shake();
    if (wrongCount + 1 >= 2) { setShowHint(true); setHintStage(1); setUsedHint(true); }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, solved, failed, puzzle, idx, step, solution, wrongCount, finish, playOpponentReply, shake]);

  const giveUp = () => {
    if (!puzzle || solution.length === 0) return;
    stopTimers();
    // Mark the attempt failed before the animation starts, so the board is not live while the
    // answer is being shown. The rating is recorded once, when the line finishes.
    setFailed(true);
    setShowHint(false);
    setHintStage(0);
    setFen(puzzle.fen);
    setLastMove(null);
    setPlayedSans([]);
    setStep(0);

    // Build every frame first; then reveal one at a time. Applying the line to the board before
    // the interval (as the live tab does) would make every tick show the final position.
    const frames: {
      fen: string;
      from: string;
      to: string;
      san: string;
      move: { san: string; captured?: string; flags?: string };
    }[] = [];
    const c = new Chess(puzzle.fen);
    for (const move of solution) {
      try {
        const m = c.move(move.san);
        frames.push({ fen: c.fen(), from: m.from, to: m.to, san: m.san, move: m });
      } catch {
        break;
      }
    }
    if (frames.length === 0) {
      finish(false, wrongCount);
      return;
    }

    let i = 0;
    revealTimerRef.current = setInterval(() => {
      if (i >= frames.length) {
        stopTimers();
        finish(false, wrongCount);
        return;
      }
      const frame = frames[i];
      setFen(frame.fen);
      setLastMove({ from: frame.from, to: frame.to });
      setPlayedSans((prev) => [...prev, frame.san]);
      playMoveSound(frame.move);
      i += 1;
    }, 500);
  };

  /*
   * HOOKS ABOVE THE EARLY RETURN, AND THIS IS NOT A STYLE POINT.
   *
   * `if (!puzzle) return null;` sits below this block. Two `useMemo`s declared after it would run on
   * the loaded render and not on the empty one, so React sees one fewer hook than last time the
   * puzzle arrives: "Rendered more hooks than during the previous render", which crashes the tab
   * exactly when a puzzle finally loads. The live tab carries the same warning above its own hint
   * hooks for the same reason, and `hooks.test.mjs` fails the build on it.
   *
   * They read `fen` and the solved/failed flags rather than `puzzle`, so nothing here needs the
   * puzzle to exist.
   */
  /*
   * THE HINT MUST BE OFF UNTIL IT IS ASKED FOR.
   *
   * This was `const hintOn = !solved && !failed && !!puzzle;` — which is true for every unsolved
   * position, so `hintFrom` was populated from the first paint and EVERY mined puzzle arrived with
   * every movable piece already ringed. The report was *"why all my pieces are selected in the puzzles
   * from my games"*, and it was not a rendering fault: the rings were the hint, permanently on,
   * because nothing in this expression ever consulted whether the user had pressed Hint.
   *
   * The live tab in this same file has always had `showHint &&` here, which is why only this tab was
   * affected — two copies of the same idea, and only one of them was right.
   */
  const turn = turnOf(fen);
  const userTurn = !!puzzle && turn === puzzle.color;
  const hintOn = showHint && !solved && !failed && userTurn;
  // The hint is about the CURRENT move of the line, not the first move. On a three-ply puzzle
  // `bestSan` is the answer to a question the user solved two plies ago.
  const hintFrom = useMemo(
    () => (hintOn ? solvingPiece(fen, solution[step]?.san) : []),
    [hintOn, fen, solution, step],
  );
  const hintTo = useMemo(
    () => (hintOn && hintStage >= 2 ? targetSquares(fen, hintFrom) : []),
    [hintOn, hintStage, fen, hintFrom],
  );
  // ---- empty / loading states ------------------------------------------------

  if (puzzles == null) {
    return (
      <View style={s.centerBox}>
        <Spinner />
        <Text style={s.body}>Loading your positions…</Text>
      </View>
    );
  }

  if (puzzles.length === 0) {
    return (
      <Card style={{ gap: 10 }}>
        <View style={s.puzzleSourceRow}>
          <IconBookMarked size={16} color={colors.gold} />
          <Text style={s.puzzleSource}>
            {legacyCount > 0 ? 'Rebuild your puzzle deck' : 'Nothing here yet'}
          </Text>
        </View>
        {legacyCount > 0 ? (
          <Text style={s.body}>
            Your previous positions were one-move quizzes, so they are retired. Import your games
            again to rebuild them as forced lines: you move, the opponent answers, you find the
            follow-up.
          </Text>
        ) : null}
        {/*
         * THE IMPORT HAPPENS HERE, NOT ON STATS.
         *
         * This used to say "Run Analyse on the Stats tab" / "Connect a Lichess account on the
         * Stats tab first" — an instruction to leave the tab the user is looking at. The owner's
         * request was that the connection and the import happen in place; the card below is that
         * flow, running the same `importGames` driver Stats runs, and reloading the deck when it
         * finishes so anything mined so far shows up immediately.
         */}
        <GameImportInline
          what="puzzles"
          importsGames
          onChanged={() => void readDeck()}
        />
      </Card>
    );
  }


  if (!puzzle) return null;

  const meta = QUALITY_META[puzzle.kind];
  const userToMove = !solved && !failed && userTurn;

  /*
   * The two arrows � what you played, and what you should have played � are the LESSON, and a
   * lesson is only given once the position has been answered.
   *
   * They used to be drawn WHILE the position was still to be played, which is incoherent twice over:
   * the board showed a move and then asked for a move, and the red "here is what you did" arrow
   * gave away that the move was wrong before the user had found anything. So both are now behind
   * `solved || failed`, which is the single state the give-up path and the solved path both land on.
   */
  const arrows: BoardArrow[] = [];
  /*
   * YOUR MISTAKE, DRAWN BEFORE THE MOVE IS MADE - AND ONLY YOUR MISTAKE.
   *
   * This drew TWO arrows: red on `playedUci` and gold on `bestUci`. The second was asked for once and
   * then withdrawn: *"it still shows me what to play (you have to remove the arrow on what to play and
   * when i click hint only colour the piece that i should move)"*. The reasoning behind the change is
   * sound - an arrow on the answer means the position is no longer a question, it is a demonstration -
   * and the hint is now where the answer is revealed, on request, when the user asks for it.
   *
   * So the standing board says WHAT WENT WRONG and nothing about what to do. The hint names the piece
   * that solves it; press 2 names its destinations. Three steps from "here is your mistake" to "here is
   * the move", and the last one is the player's to take.
   *
   * It is drawn before the move, which was the first half of the original request: this used to be
   * gated on `if (!userToMove)`, so it appeared only after the mistake had been made again.
   *
   * And NOT when the two moves are the same: the deck deliberately contains brilliants, where the move
   * mined here IS the move to play, and a red arrow would invent a mistake that did not happen.
   */
  if (!solved && !failed) {
    // Only the STARTING position has a mistake to mark. After the first correct move the board is
    // a different position, and the old red arrow would be pointing at a move from the past.
    if (step === 0 && playedSans.length === 0) {
      const same = puzzle.playedUci.slice(0, 4) === puzzle.bestUci.slice(0, 4);
      if (!same) {
        arrows.push({
          startSquare: puzzle.playedUci.slice(0, 2),
          endSquare: puzzle.playedUci.slice(2, 4),
          color: colors.bad,
        });
      }
    }
  }

  const solvedCount = puzzles.filter((p) => puzzleStats[p.id]?.solved).length;

  const solverMoves = Math.ceil(solution.length / 2);
  const solverMove = Math.floor(step / 2) + 1;
  const statusText = solved
    ? 'Solved!'
    : failed
      ? 'Solution shown - study the pattern.'
      : !userTurn
        ? 'Opponent replies...'
        : solverMoves > 1
          ? `${puzzle.color === 'w' ? 'White' : 'Black'} to play - move ${solverMove}/${solverMoves}`
          : `${puzzle.color === 'w' ? 'White' : 'Black'} to play`;

  /*
   * WHAT THIS POSITION IS, in the user's own terms.
   *
   * The deck is now exactly the three things that were asked for � a blunder, a win that was given
   * away, or a move that was found brilliantly � and the label says which BEFORE the position is
   * played, because "you were winning here" is the most useful sentence this app can say about a
   * position and it is worth nothing after the reveal.
   */
  const themeLine = puzzle.theme === 'missed-win'
    ? 'You were winning in this position.'
    : puzzle.theme === 'brilliant'
      ? 'Find the only move that works here.'
      : `You gave up ${(puzzle.lossCp / 100).toFixed(1)} pawns here.`;

  return (
    <View style={{ gap: 12 }}>
      {/*
       * NO 1..40 STRIP. ONE POSITION AT A TIME.
       *
       * The request: *"in puzzles from my games i dont want to see 1,2,..40,etc . just give me a
       * puzzle and i can solve it then pass to the next one or just pass to the next puzzle"*.
       *
       * The strip was doing something worse than being ugly. It was a TASK LIST: forty numbered
       * positions visible at once turns "solve this" into "work through a queue", and a queue reads
       * as homework. It is also why the count grew to 40 � the deck holds every mined position it
       * found, and the strip showed as many as fitted.
       *
       * What replaces it is the live tab's own shape, which is the right one: a position, a Skip, a
       * Next. Progress is still tracked � `solvedCount` above the card says how many of the deck are
       * solved � but it is a fact about the deck rather than a to-do list sitting on top of it.
       */}

      <Text style={[s.bodySm, { textAlign: 'center' }]}>
        {solvedCount}/{puzzles.length} solved · hardest first
      </Text>

      {legacyCount > 0 ? (
        <Text style={[s.bodySm, { textAlign: 'center' }]}>
          {legacyCount} older one-move position{legacyCount === 1 ? '' : 's'} retired - import
          again to rebuild {legacyCount === 1 ? 'it' : 'them'} as a forced line.
        </Text>
      ) : null}

      <Animated.View key={shakeKey} style={{ transform: [{ translateX: shakeAnim.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) }] }}>
        <ChessForgeBoard
          fen={fen}
          orientation={puzzle.color === 'w' ? 'white' : 'black'}
          interactive={userToMove}
          onMove={handleMove}
          lastMove={lastMove}
          arrows={arrows}
          hintFrom={hintOn ? hintFrom : []}
          hintTo={hintOn && hintStage >= 2 ? hintTo : []}
        />
      </Animated.View>

      {/* The line so far, including the opponent's replies. The live tab has always had this; a
          multi-move mined puzzle needs it for the same reason. */}
      <MoveBar startFen={puzzle.fen} sans={playedSans} userColor={puzzle.color} />

      <Card style={{ gap: 12 }}>
        <View style={s.puzzleHeaderRow}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <Chip
                text={meta?.name ?? puzzle.kind}
                color={meta?.color ?? colors.gold}
                bg="rgba(212,175,55,0.12)"
                border="rgba(212,175,55,0.35)"
              />
              {puzzle.lossCp > 0 ? (
                <Text style={s.bodySm}>−{(puzzle.lossCp / 100).toFixed(1)} pawns</Text>
              ) : null}
            </View>
            <Text style={s.bodySm} numberOfLines={1}>
              {puzzle.opening || 'Your game'} · move {Math.floor(puzzle.ply / 2) + 1} · {statusText}
            </Text>
          {/* Said before the position is played, not after - see `themeLine`. */}
          <Text style={[s.bodySm, { color: puzzle.theme === 'brilliant' ? colors.primary : colors.bad }]}>
            {themeLine}
          </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {wrongCount > 0 && !solved ? (
              <View style={s.mistakeRow}>
                <IconXCircle size={12} color={colors.bad} />
                <Text style={s.mistakeText}>{wrongCount}</Text>
              </View>
            ) : null}
            <IconBtn onPress={() => loadAt(idx)} label="Reset position">
              <IconRotateCcw size={15} color={colors.mutedForeground} />
            </IconBtn>
            {/*
              * A HINT AFTER THE PUZZLE IS OVER IS A BUTTON THAT DOES NOTHING.
              *
              * `hintOn` requires `!solved && !failed`, so past either of those the press was accepted,
              * incremented a stage nothing reads, and drew nothing — the "hint doesnt work in a place"
              * half of the report. It is not that the hint was broken; it is that the control stayed
              * on screen after the question had been answered, and an inert control is indistinguish-
              * able from a broken one. The Reset button beside it was already guarded this way.
              */}
            {!solved && !failed ? (
              <IconBtn
                onPress={() => {
                  // 0 -> ring the piece, 1 -> also dot the destinations, 2 -> hide again.
                  setHintStage((s) => (s + 1) % 3);
                  setShowHint(true);
                  setUsedHint(true);
                }}
                label="Show hint"
              >
                <IconLightbulb size={15} color={colors.gold} />
              </IconBtn>
            ) : null}
          </View>
        </View>

        {/* The lesson: what was played, and the forced line that was available. The hint must not
            reveal this row - it rings the piece for the current step, and the line stays hidden
            until the attempt is over. */}
        <View style={s.compareRow}>
          <View style={s.compareCol}>
            <Text style={s.compareLabel}>You played</Text>
            <Text style={[s.compareMove, { color: colors.bad }]}>{puzzle.playedSan}</Text>
          </View>
          <IconArrowRight size={14} color={colors.mutedForeground} />
          <View style={s.compareCol}>
            <Text style={s.compareLabel}>Best line</Text>
            <Text style={[s.compareMove, { color: colors.primary }]} numberOfLines={2}>
              {solved || failed ? solution.map((m) => m.san).join(' ') : '•••'}
            </Text>
          </View>
        </View>

        {solved ? (
          <View style={{ gap: 8 }}>
            <View style={s.solvedRow}>
              <IconCheckCircle size={16} color={colors.primary} />
              <Text style={s.solvedText}>
                {wrongCount === 0 && !usedHint ? 'First try — flawless!' : 'Solved!'}
                {usedHint ? <Text style={s.bodySm}> · hint used</Text> : null}
              </Text>
              {lastDelta !== null ? (
                <Text style={[s.deltaText, lastDelta >= 0 ? s.deltaUp : s.deltaDown]}>
                  {lastDelta >= 0 ? `+${lastDelta}` : `${lastDelta}`}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {failed && !solved ? (
          <View style={{ gap: 10 }}>
            {lastDelta !== null ? (
              <Text style={[s.deltaText, s.deltaDown]}>
                {lastDelta >= 0 ? `+${lastDelta}` : `${lastDelta}`} rating
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={s.navRow}>
          <IconBtn onPress={() => loadAt(idx - 1)} label="Previous position" style={s.navOutlineBtn}>
            <IconChevronLeft size={15} color={colors.foreground} />
          </IconBtn>
          {/*
            * GIVE UP, AND THE ADJACENT SKIP.
            *
            * "Show solution" used to sit between Previous and Next, so the only way past a position
            * you could not solve was to reveal its answer and take the rating hit. Skipping is the
            * action people actually want in that moment, and on a deck mined from their own games
            * it matters more than usual: the position is not going anywhere, and being unable to see
            * it today is not a failure worth a penalty. The deck keeps its own unsolved state, so a
            * skipped position is still counted in `solvedCount` as unsolved and comes back round.
            */}
          <Btn
            label="Skip"
            variant="ghost"
            small
            onPress={() => loadAt(idx + 1)}
            style={{ flex: 1 }}
          />
          <Btn
            label={failed ? 'Retry' : 'Show solution'}
            variant="ghost"
            small
            onPress={failed ? () => loadAt(idx) : giveUp}
            style={{ flex: 1 }}
          />
          <Btn
            label="Next"
            small
            onPress={() => loadAt(idx + 1)}
            style={{ flex: 1 }}
          />
          <IconBtn onPress={() => loadAt(idx + 1)} label="Next position" style={s.navOutlineBtn}>
            <IconChevronRight size={15} color={colors.foreground} />
          </IconBtn>
        </View>
      </Card>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { gap: 16 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ratingBox: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center',
  },
  ratingNum: { fontSize: 14, fontWeight: '700', color: colors.gold, fontFamily: fonts.sans },
  ratingLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans, marginTop: 2 },

  modeChip: {
    borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, paddingHorizontal: 12, paddingVertical: 6,
  },
  modeChipActive: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.15)' },
  modeChipText: { fontSize: 11, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },

  puzzleHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  puzzleSourceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  puzzleSource: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },

  /*
   * The move strip. Sits directly under the board because the question it answers ("whose move
   * is this, and how did we get here") is one the user asks before every single puzzle.
   *
   * Horizontal and scrollable with the tail pinned: on a long solution the interesting move
   * is the last one, and a strip that needs scrolling to find the move just made would be no
   * better than not having one.
   */
  moveBar: {
    backgroundColor: colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, gap: 6,
  },
  moveBarHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sideDot: { width: 10, height: 10, borderRadius: 5 },
  moveBarSideText: {
    fontSize: 12, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold,
  },
  moveBarTurn: { flex: 1, fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.sans },
  // A puzzle is a handful of moves; the cap stops a long one from pushing the status card off
  // the screen, and the list scrolls inside it.
  moveBarList: { maxHeight: 96 },
  mistakeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mistakeText: { fontSize: 11, color: colors.bad, fontFamily: fonts.sans },
  hintText: { fontSize: 12, color: 'rgba(212,175,55,0.9)', fontFamily: fonts.sans, borderLeftWidth: 2, borderLeftColor: 'rgba(212,175,55,0.5)', paddingLeft: 10 },
  solvedRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  solvedText: { fontSize: 14, fontWeight: '600', color: colors.primary, fontFamily: fonts.sansSemiBold },
  // Rating change for the attempt. Green = gained, red = lost, matching the
  // app's existing success/error colours.
  deltaText: { fontSize: 13, fontWeight: '700', fontFamily: fonts.sansBold },
  deltaUp: { color: colors.primary },
  deltaDown: { color: colors.bad },

  navRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navOutlineBtn: { borderWidth: 1, borderColor: colors.border },

  dotsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dot: {
    width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center',
  },
  dotActive: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.2)' },
  dotDone: { borderColor: 'rgba(46,139,106,0.5)', backgroundColor: 'rgba(46,139,106,0.15)' },
  dotText: { fontSize: 10, fontWeight: '700', color: colors.mutedForeground, fontFamily: fonts.sans },

  // 'From your games' additions.
  centerBox: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  compareRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compareCol: { flex: 1, gap: 2 },
  compareLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },
  compareMove: { fontSize: 15, fontWeight: '700', fontFamily: fonts.sansBold },

  h1: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
