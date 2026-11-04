'use client';

/**
 * Train screen — RN port of the web `screens/TrainScreen.tsx`.
 * Mixed review across ALL learned openings with a to-do/mistake/unclear/solved
 * pipeline, plus the opening→chapter→line tri-state picker with weakest-first
 * sorting. Preferences persist through expo-sqlite/kv-store (was localStorage).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Modal, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Storage from 'expo-sqlite/kv-store';
import type { Repertoire, RepStudy, TrainExercise } from '@/lib/repertoire';
import {
  buildTrainExercises, collectStudyLines, commentForPly, fenKey, rateStudyLines, studyShortTitle,
  isReferenceStudy,
} from '@/lib/repertoire';
import { AVAILABLE_OPENINGS, findStudyWithOpening, studyIndexAll } from '@/lib/openings';
import { scopedOpenings } from '@/lib/yourOpenings';
import { buildBookExercisesForAdoptions } from '@/lib/openingBuilder';
import { buildCustomExercises, CUSTOM_STUDY_ID, CUSTOM_STUDY_TITLE, type CustomLine } from '@/lib/gameOpenings';
import { loadCustomRepertoire } from '@/lib/lichessStore';
import { Chess } from 'chess.js';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { solvingPiece, targetSquares } from '@/lib/hint';
import { MoveList } from '@/components/chess/MoveList';
import { playMoveSound, playEffect } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import { Card, Bar, Btn, IconBtn, Spinner } from '@/components/ui/Primitives';
import {
  IconArrowLeft, IconCheckCircle, IconDumbbell, IconLightbulb,
  IconSparkles, IconTrophy, IconX, IconBookOpen, IconSliders, IconCheck, IconChevronDown,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';

const XP_FIRST_TRY = 3;
const XP_RETRY = 1;
const XP_PASS_CLEAN = 4;
const XP_SESSION_BONUS = 10;
const AUTOPLAY_MS = 380;
const OPPONENT_MS = 720;

type ExState = 'todo' | 'mistake' | 'unclear' | 'solved';
type Phase = 'presenting' | 'playing' | 'flash' | 'done' | 'empty';

/**
 * Which sources Train drills from.
 *
 * `all`     — every learned position across the shipped openings.
 * `custom`  — a hand-picked subset of book lines.
 * `mine`    — the user's OWN repertoire: the moves they adopted while reviewing
 *             their Lichess games (see GameOpeningsScreen). This is a third
 *             mode rather than a subset of `custom` because its exercises come
 *             from a different source entirely (adoptions, not book lines) and
 *             "you have not built one yet" needs its own empty state.
 */
type Sel = { mode: 'all' } | { mode: 'custom'; lines: string[] } | { mode: 'mine' };

const SEL_KEY = 'chessforge.train.sel.v2';
const WEAK_FIRST_KEY = 'chessforge.train.weakfirst';

async function loadSel(): Promise<Sel> {
  try {
    const raw = await Storage.getItem(SEL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.mode === 'mine') return { mode: 'mine' };
      if (parsed?.mode === 'custom' && Array.isArray(parsed.lines) && parsed.lines.length > 0) {
        return { mode: 'custom', lines: parsed.lines.filter((x: unknown) => typeof x === 'string') };
      }
    }
  } catch { /* ignore */ }
  return { mode: 'all' };
}

async function saveSel(sel: Sel) {
  try { await Storage.setItem(SEL_KEY, JSON.stringify(sel)); } catch { /* ignore */ }
}

async function loadWeakFirst(): Promise<boolean> {
  try { return (await Storage.getItem(WEAK_FIRST_KEY)) === '1'; } catch { return false; }
}

async function saveWeakFirst(v: boolean) {
  try { await Storage.setItem(WEAK_FIRST_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

interface PoolItem {
  ex: TrainExercise;
  state: ExState;
  passes: number;
}

function positionAfter(sans: string[], ply: number): Chess {
  const c = new Chess();
  for (let i = 0; i < ply && i < sans.length; i++) {
    try { c.move(sans[i]); } catch { /* verified data */ }
  }
  return c;
}

export function TrainScreen({
  onExit,
  scopeOpeningId = null,
}: {
  onExit: () => void;
  /**
   * WHICH OPENING the user was looking at when they tapped Train.
   *
   * The request: *"for the training in 'your openings' we get positions from what we learned by
   * default (unless i want to customize and choose)"*. Two halves, and they are different things:
   *
   *   - "positions from what we learned" was already true. `buildTrainExercises` defaults to
   *     studies with `attempts > 0`, so the pool has only ever been learned material. That part
   *     needed no work, and saying otherwise would be claiming credit for it.
   *   - "in 'your openings'" was not. Tapping Train from an opening drilled EVERY opening at once,
   *     so the Sicilian screen produced a session full of positions from openings he was not
   *     looking at. The scope below is what makes the button mean the screen it is on.
   *
   * It is a SCOPE and not a new source, deliberately. The user keeps his saved choice of source -
   * learned, his own lines, or a custom selection - and the scope narrows whichever one he picked
   * to a single opening. Folding the scope into the saved selection instead would mean arriving
   * from an opening silently overwrote a preference he set on purpose, which is the "unless i want
   * to customize" half of the sentence failing.
   */
  scopeOpeningId?: string | null;
}) {
  const store = useAppStore();
  /*
   * The app draws edge-to-edge, so `position: absolute; bottom: 0` puts the
   * pipeline counters underneath the system navigation bar — the nav buttons
   * are then painted straight over "To do / Mistakes / Unclear / Solved" and
   * the labels become unreadable. Lift the bar by the bottom safe-area inset.
   */
  const insets = useSafeAreaInsets();

  const [sel, setSel] = useState<Sel>({ mode: 'all' });
  /**
   * The opening Train is scoped to, or null for every opening.
   *
   * Held separately from `sel` so the user's saved source choice survives arriving from an opening,
   * and so the scope can be dropped without disturbing what they chose. See `scopeOpeningId`.
   */
  const [scope, setScope] = useState<string | null>(scopeOpeningId);
  const scopeName = useMemo(
    () => (scope ? (AVAILABLE_OPENINGS.find((o) => o.id === scope)?.name ?? scope) : null),
    [scope],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pool, setPool] = useState<PoolItem[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('presenting');
  const [ply, setPly] = useState(0);
  const [mistakesThisPass, setMistakesThisPass] = useState(0);
  const [erroredKeys, setErroredKeys] = useState<Set<string>>(new Set());
  const [passPositions, setPassPositions] = useState<{ key: string; correct: boolean }[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  // Hint stage: 0 = none, 1 = ring the one piece the line plays, 2 = also dot where it can go.
  const [hintStage, setHintStage] = useState(0);
  /**
   * WHY THIS EXISTS: *"for the training i made a mistake and stil didnt count as mistake i
   * just continued playing"*.
   *
   * The mistake WAS counted - `setMistakesThisPass` and a `correct: false` entry in
   * `passPositions`, both of which decide whether the pass is clean at the end. But the only
   * feedback at the moment it happened was a sound and a board shake, and a drill that lets
   * you retry immediately means the player sees no consequence: the counter that records it
   * is in a corner they are not looking at, and the position is only revisited much later.
   *
   * So a wrong move now says so, in words, where the move was made, and states what will
   * happen to the position. The retry itself is unchanged and deliberate - stopping the drill
   * on the first wrong move would teach nothing - but the mistake is no longer silent.
   */
  const [mistakeNotice, setMistakeNotice] = useState<string | null>(null);
  /**
   * THE MOVE THAT WAS ACTUALLY PLAYED, WHILE THE POSITION STILL SHOWS THE QUESTION.
   *
   * THE REPORT: *"in the training when i make a mistake it should show a red arrow on the wrong move
   * and the correct arrow on the right move then let me play it again"*.
   *
   * A wrong answer here bounces straight back, so the position never changes. Everything the board
   * could draw from the position is therefore the same as it was a second earlier — it cannot say
   * anything about the move that was just rejected, because that move is the one fact the bounce
   * undid. So it is kept as STATE, and the board draws it against the move the line plays.
   *
   * Cleared on the correct move, not on a timer: a correction belongs to the question it corrects,
   * and it should still be on screen for as long as the player is looking at that question.
   */
  const [mistakeUci, setMistakeUci] = useState<string | null>(null);
  /*
   * NOTE: this screen deliberately has NO explore ("drift") mode.
   *
   * Train is a spaced-repetition drill: it measures whether you can recall the
   * recorded line, and it counts your mistakes to decide what comes back. Letting
   * the user wander off the line would corrupt the very thing it measures — a
   * deviation would be scored as a failed recall, and the engine would then be
   * "grading" a position that was never part of the repertoire.
   *
   * Free exploration lives in the Course walkthrough instead, where the point is
   * understanding rather than recall. If you are looking for it, it is not here.
   */
  const [comment, setComment] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; good: boolean } | null>(null);
  const [sessionStats, setSessionStats] = useState({ passes: 0, correct: 0, total: 0, xp: 0 });
  /** How many adopted moves the user has, so the picker can label the source. */
  const [customCount, setCustomCount] = useState(0);

  const lastAttemptRef = useRef('');

  // shake animation
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const [shakeKey, setShakeKey] = useState(0);
  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: -1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0.6, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true, easing: Easing.linear }),
    ]).start();
  }, [shakeAnim]);

  // ---------- exercise lifecycle ----------
  const startExercise = useCallback((items: PoolItem[], idx: number) => {
    setCur(idx);
    /*
     * The first exercise of a session chooses the colour; after that it is held, so the board
     * does not rotate between drills. Set from the exercise being opened rather than the first
     * in the array, because `init` starts at a random index.
     */
    if (sessionColorRef.current === null) sessionColorRef.current = items[idx].ex.userColor;
    setPly(0);
    setMistakesThisPass(0);
    setErroredKeys(new Set());
    setPassPositions([]);
    setLastMove(null);
    setHintStage(0);
    setComment(null);
    setFlash(null);
    setMistakeNotice(null);
    lastAttemptRef.current = '';
    setPhase(items[idx].ex.startPly > 0 ? 'presenting' : 'playing');
  }, []);

  // ---------- pool build + first pick ----------
  /**
   * Build the pool for a selection, then start the first exercise.
   *
   * `adopted` is passed in rather than loaded here because the custom pool is
   * read asynchronously from kv-store: the caller awaits the read and hands the
   * result over, which keeps this function synchronous (it is called from a
   * render-independent effect and from event handlers, and making it async
   * would re-introduce the unmount race the effect's `alive` flag guards).
   *
   * `mine` deliberately does NOT fall back to the book pool when it is empty.
   * The user picked "my openings"; silently drilling the shipped studies
   * instead would look like the selection was ignored. The dedicated empty
   * state points at where the positions come from.
   */
  const init = useCallback((
    selection: Sel,
    adopted: Record<string, CustomLine> = {},
  ) => {
    let items: TrainExercise[] = [];

    if (selection.mode === 'mine') {
      /*
       * HIS REPERTOIRE, PLUS OURS, FOR THE OPENINGS HE PLAYS.
       *
       * The complaint was "it said there is no train available since I didnt
       * practice although I finished some lines". This mode was built ONLY from
       * `CustomLine` adoptions, and an adoption was written only at a step that
       * offered a real CHOICE — so playing a line straight through, which is most
       * of a line, recorded nothing at all and finishing lines left the trainer
       * empty. `GameOpeningsScreen` now records every move the user plays, so a
       * played line becomes a repertoire.
       *
       * The book half is DERIVED, never a list of opening ids: each adoption's own
       * move order is looked up against the library and whatever study covers it is
       * added. So a future version that ships another opening — or teaches the move
       * order he actually plays — is picked up with no change here, which matters
       * because the repertoire grows every release.
       */
      items = buildCustomExercises(adopted, 8)
        .concat(buildBookExercisesForAdoptions(adopted, 8));
      if (items.length === 0) {
        setPool([]);
        setPhase('empty');
        return;
      }
      const mine: PoolItem[] = items.map((ex) => ({ ex, state: 'todo', passes: 0 }));
      const shuffledMine = mine
        .map((it) => ({ it, k: Math.random() }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.it);
      setPool(shuffledMine);
      // A new session: the colour is decided again by whichever exercise opens it.
      sessionColorRef.current = null;
      setSessionStats({ passes: 0, correct: 0, total: 0, xp: 0 });
      startExercise(shuffledMine, Math.floor(Math.random() * shuffledMine.length));
      return;
    }

    // A custom selection is an EXPLICIT request, so unlearned lines are included —
    // otherwise the sheet would let you tick them and then build an empty pool.
    const filter = selection.mode === 'custom'
      ? { lineIds: selection.lines, includeUnlearned: true }
      : undefined;

    /*
     * WHICH OPENINGS ARE IN SCOPE.
     *
     * `scope` is the opening the user was on. When it is set, the review is that opening's learned
     * material only - which is what the button on that screen has always implied, and what the
     * user asked for by saying the positions should come from what he learned *in Your openings*.
     * When it is null the review spans everything, as it always has.
     *
     * The default is not widened: `buildTrainExercises` is called with no `includeUnlearned`, so
     * a study enters the pool only if he has practised it. Scoping narrows a learned review; it
     * never quietly turns into a chapter of material he has not opened.
     */
    const inScope = scopedOpenings(AVAILABLE_OPENINGS, scope) as typeof AVAILABLE_OPENINGS;
    for (const o of inScope) {
      const rep = o.repertoire as Repertoire;
      const color: 'w' | 'b' = o.side === 'white' ? 'w' : 'b';
      items = items.concat(buildTrainExercises(
        rep,
        useAppStore.getState().studies,
        useAppStore.getState().positions,
        12,
        filter,
        color,
      ));
    }
    if (items.length === 0) {
      /*
       * NO MIXED REVIEW AVAILABLE — BUT HE HAS PRACTISED HIS OWN LINES.
       *
       * The user completed a line in "Your openings" and then tapped Train, and was told
       * "Nothing to train yet": *"i completed the line then i tried training and it always
       * tells me no train yet"*.
       *
       * Both halves were true and together they are the bug. The line really was recorded -
       * adoptions go to the custom repertoire - and the mixed pool really was empty, because
       * that mode draws from practised STUDIES and practising in "Your openings" never
       * touches the SRS by design. So the one thing he had just done produced nothing he
       * could train, and the screen said so without offering the thing he could.
       *
       * So when the mixed pool is empty and his own repertoire is not, he is put straight
       * into 'mine' rather than shown an empty card. The default selection is left alone:
       * this is a fallback for "there is nothing else to show", not a reinterpretation of
       * what Train means. If his own repertoire is empty too, the empty state is correct
       * and stays.
       *
       * `adopted` is passed in by `initFrom`, which reads the custom repertoire for every
       * mode - so this needs no `await` and `init` stays synchronous.
       */
      const mineItems = Object.keys(adopted).length > 0
        ? buildCustomExercises(adopted, 8).concat(buildBookExercisesForAdoptions(adopted, 8))
        : [];
      if (mineItems.length === 0) {
        setPool([]);
        setPhase('empty');
        return;
      }
      const mine: PoolItem[] = mineItems.map((ex) => ({ ex, state: 'todo', passes: 0 }));
      setPool(mine);
      // A new session: the colour is decided again by whichever exercise opens it.
      sessionColorRef.current = null;
      setSessionStats({ passes: 0, correct: 0, total: 0, xp: 0 });
      startExercise(mine, 0);
      return;
    }
    const shuffled = items
      .map((e) => ({ e, k: Math.random() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.e)
      .slice(0, 12);
    const built: PoolItem[] = shuffled.map((ex) => ({ ex, state: 'todo', passes: 0 }));
    setPool(built);
    // A new session: the colour is decided again by whichever exercise opens it.
    sessionColorRef.current = null;
    setSessionStats({ passes: 0, correct: 0, total: 0, xp: 0 });
    const first = Math.floor(Math.random() * built.length);
    startExercise(built, first);
  }, [startExercise, scope]);

  /**
   * Resolve a selection, reading the custom repertoire when it is needed, and
   * build the pool. Every entry point goes through here so `init` is never
   * called without the adoptions it needs.
   */
  const initFrom = useCallback(async (selection: Sel) => {
    // The custom repertoire is read for EVERY mode, not just 'mine', because it is the
    // fallback pool when the mixed review is empty. Reading it is one kv-store read, and
    // doing it here rather than inside `init` keeps `init` synchronous - it is a useCallback
    // with a non-promise return, and putting an `await` in it would not compile.
    let adopted: Record<string, CustomLine> = {};
    try {
      adopted = (await loadCustomRepertoire()).positions;
    } catch { /* a failed read degrades to the empty state */ }
    setCustomCount(Object.keys(adopted).length);
    init(selection, adopted);
  }, [init]);

  useEffect(() => {
    let alive = true;
    loadSel().then(async (s) => {
      if (!alive) return;
      setSel(s);
      // The picker labels the "Your openings" source with how many decisions the
      // user has made, so read the repertoire once on mount regardless of the
      // selected mode — otherwise the count would read 0 until they switched.
      let adopted: Record<string, CustomLine> = {};
      try {
        adopted = (await loadCustomRepertoire()).positions;
      } catch { /* a failed read degrades to the empty state */ }
      if (!alive) return;
      setCustomCount(Object.keys(adopted).length);
      init(s, adopted);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time bootstrap on mount
  }, []);

  const applySel = useCallback((s: Sel) => {
    setSel(s);
    void saveSel(s);
    setPickerOpen(false);
    void initFrom(s);
  }, [initFrom]);

  const current = cur !== null ? pool[cur] : null;
  /**
   * The study a custom exercise belongs to, synthesised.
   *
   * The render path reads `curStudy.title` (via `studyShortTitle`) and passes
   * the object to `commentForPly` for the per-ply note. A custom exercise has
   * no shipped study, so rather than teaching every consumer about a null case
   * we hand back a minimal stand-in: an empty `tree`, which makes `commentForPly`
   * return null (there is no authored comment to show) — exactly right, since
   * the "why" for a custom move lives in the Game Openings screen, not here.
   */
  const curStudy: RepStudy | null = useMemo(() => {
    if (!current) return null;
    if (current.ex.studyId === CUSTOM_STUDY_ID) {
      return {
        id: CUSTOM_STUDY_ID,
        chapter: CUSTOM_STUDY_TITLE,
        title: CUSTOM_STUDY_TITLE,
        type: 'custom',
        tree: [],
        mainPlies: 1,
        lineCount: 1,
      };
    }
    return findStudyWithOpening(current.ex.studyId)?.study ?? null;
  }, [current]);

  const sans = current?.ex.line.sans ?? [];
  const totalLen = sans.length;
  const startPly = current?.ex.startPly ?? 0;
  const userMod: 0 | 1 = current?.ex.userColor === 'w' ? 0 : 1;

  // ---------- pass complete → state transition + persistence ----------
  const finishPass = useCallback(() => {
    if (!current || !curStudy) return;
    const clean = mistakesThisPass === 0;
    const prev = current.state;
    const next: ExState = clean
      ? (prev === 'todo' ? 'solved' : prev === 'mistake' ? 'unclear' : 'solved')
      : 'mistake';

    const xp = passPositions.filter((p) => p.correct).length * XP_FIRST_TRY
      + passPositions.filter((p) => !p.correct).length * XP_RETRY
      + (clean ? XP_PASS_CLEAN : 0);
    setSessionStats((st) => ({ ...st, passes: st.passes + 1, xp: st.xp + xp }));

    store.applyResult({
      type: 'opening',
      xp,
      correct: passPositions.filter((p) => p.correct).length,
      total: passPositions.length,
      positions: passPositions,
    });

    setPool((items) => items.map((it, i) => (i === cur
      ? { ...it, state: next, passes: it.passes + 1 }
      : it)));

    let text: string;
    if (!clean) text = 'Mistake noted — this one will come back later in the session.';
    else if (prev === 'mistake') text = 'Clean repeat — marked unclear. One more clean pass to confirm it.';
    else if (prev === 'unclear') text = 'Confirmed — fully memorized!';
    else text = 'Solved with zero mistakes — memorized!';
    setFlash({ text, good: clean });
    setPhase('flash');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, curStudy, mistakesThisPass, passPositions, cur, store]);

  // ---------- auto-play: reach the exercise position ----------
  useEffect(() => {
    if (phase !== 'presenting' || !current) return;
    if (ply >= startPly) {
      const t = setTimeout(() => setPhase('playing'), 350);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      const c = positionAfter(sans, ply);
      try {
        const m = c.move(sans[ply]);
        setLastMove({ from: m.from, to: m.to });
        playMoveSound(m);
      } catch { /* verified data */ }
      setPly((p) => p + 1);
    }, AUTOPLAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ply, current?.ex.id, startPly]);
  // ---------- opponent auto-moves while playing ----------
  useEffect(() => {
    if (phase !== 'playing' || !current) return;
    if (ply >= totalLen) {
      const t = setTimeout(() => finishPass(), 550);
      return () => clearTimeout(t);
    }
    if (ply % 2 !== userMod) {
      const t = setTimeout(() => {
        const c = positionAfter(sans, ply);
        try {
          const m = c.move(sans[ply]);
          setLastMove({ from: m.from, to: m.to });
          playMoveSound(m);
          setComment(commentForPly(curStudy as RepStudy, sans, ply));
        } catch { /* verified data */ }
        setPly((p) => p + 1);
      }, OPPONENT_MS);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, ply, current, totalLen, finishPass, curStudy, sans, userMod]);

  // ---------- hint (on demand) ----------
  /**
   * Ring the ONE piece the line plays, then dot where it can go - see `@/lib/hint`.
   *
   * This used to play the line's own next move and draw it as an arrow. That is the answer, and it
   * is a particularly cheap answer to give here: the line is a fixed sequence, so the arrow both
   * revealed the move and confirmed the line was memorised rather than understood. Nothing about the
   * hint needs the line at all — it only needs to know it is the user's turn, which is the guard
   * below — so the dependency on `sans` is gone too.
   */
  const showHint = useCallback(() => {
    if (!current || phase !== 'playing' || ply % 2 !== userMod || ply >= totalLen) return;
    // 0 -> ring the piece the line plays, 1 -> also dot its destinations, 2 -> off.
    setHintStage((s) => (s + 1) % 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, phase, ply, totalLen, userMod]);

  // ---------- user moves ----------
  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!current || phase !== 'playing' || ply % 2 !== userMod || ply >= totalLen) return false;
    const attemptKey = `${ply}:${from}${to}`;
    if (lastAttemptRef.current === attemptKey) return false;
    lastAttemptRef.current = attemptKey;

    const c = positionAfter(sans, ply);
    const posKey = `${current.ex.studyId}|${fenKey(c.fen())}`;
    let m;
    try {
      m = c.move({ from, to, promotion: promotion ?? 'q' });
    } catch { return false; }

    const exp = sans[ply];
    const strip = (x: string) => x.replace(/[+#]/g, '');
    if (strip(m.san) !== strip(exp)) {
      playEffect('wrong');
      setShakeKey((k) => k + 1);
      shake();
      /*
       * Record the move itself. The board cannot recover it from the position — see the note on
       * `mistakeUci` — so it is captured here, at the only moment it is known.
       */
      setMistakeUci(m.from + m.to + (m.promotion ?? ''));
      setMistakesThisPass((n) => n + 1);
      setErroredKeys((prevSet) => new Set(prevSet).add(posKey));
      setPassPositions((prev) => (prev.some((p) => p.key === posKey) ? prev : [...prev, { key: posKey, correct: false }]));
      /*
       * DELIBERATELY DOES NOT NAME THE MOVE.
       *
       * The tempting version of this message is "that wasn't Nf3, it was d4", and it would
       * end the user's problem on the first slip. It would also make the hint - which costs
       * XP and marks the exercise as hinted - worth less than free, so a player who does not
       * want to spend would simply get the answer by guessing. So the notice confirms the
       * mistake was recorded and says what will happen to the position, and the recall is
       * still the user's to make. Reveal stays behind the hint.
       *
       * The count is read from state rather than from the updater's argument: `n` does not
       * exist outside the callback, and computing it inside would be a side effect in a
       * reducer that React is entitled to call twice.
       */
      setMistakeNotice(`Mistake ${mistakesThisPass + 1} recorded. Try that position again - it returns later in the pass.`);
      return false;
    }

    const firstTry = !erroredKeys.has(posKey);
    if (firstTry) {
      setPassPositions((prev) => [...prev, { key: posKey, correct: true }]);
      setSessionStats((st) => ({ ...st, correct: st.correct + 1, total: st.total + 1, xp: st.xp + XP_FIRST_TRY }));
    } else {
      setSessionStats((st) => ({ ...st, total: st.total + 1, xp: st.xp + XP_RETRY }));
    }
    setPly((p) => p + 1);
    setLastMove({ from: m.from, to: m.to });
    playMoveSound(m);
    setComment(commentForPly(curStudy as RepStudy, sans, ply));
    setHintStage(0);
    // The move landed, so whatever the notice was about is no longer the live situation.
    setMistakeNotice(null);
    // ...and neither is the correction, which described the position before this move.
    setMistakeUci(null);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, phase, ply, sans, totalLen, erroredKeys, curStudy, userMod, shake, mistakesThisPass]);

  // ---------- pick next exercise ----------
  const poolRef = useRef<PoolItem[]>([]);
  useEffect(() => { poolRef.current = pool; }, [pool]);
  /*
   * The colour this session drills, decided on the first exercise and held after that.
   * Reset when a new session is built, so reopening Train can start on the other side.
   */
  const sessionColorRef = useRef<'w' | 'b' | null>(null);

  useEffect(() => {
    if (phase !== 'flash') return;
    const t = setTimeout(() => {
      const items = poolRef.current;
      /*
       * A SESSION KEEPS ONE COLOUR.
       *
       * THE BUG THE USER REPORTED: *"i captured a piece when i play with white and my piece
       * became black"*.
       *
       * Nothing was recoloured. The board's orientation comes straight from
       * `ex.userColor`, the pool mixes both colours, and the next exercise was drawn at
       * random from all of them — so one move after capturing as White the app handed him a
       * Black exercise, the board rotated 180 degrees, and his white pieces appeared to have
       * turned black. It was a coin flip, which is why it looked arbitrary.
       *
       * A drill is a session with a colour, so the colour is decided once and then held: the
       * first exercise of the session picks it, and every later one prefers the same side. The
       * other colour is still reached, just at the start of a later exercise rather than
       * mid-capture, so the board never turns over under a player who has just moved.
       */
      const sessionColor = sessionColorRef.current ?? poolRef.current.find((x) => x.state !== 'todo')?.ex.userColor
        ?? poolRef.current[0]?.ex.userColor ?? 'w';
      sessionColorRef.current = sessionColor;

      const sameColor = items.map((it, i) => ({ it, i })).filter((x) => x.it.ex.userColor === sessionColor);
      const poolForColor = sameColor.length > 0 ? sameColor : items.map((it, i) => ({ it, i }));

      const todo = poolForColor.filter((x) => x.it.state === 'todo');
      let pick: number | null = null;
      if (todo.length > 0) {
        pick = todo[Math.floor(Math.random() * todo.length)].i;
      } else {
        const retry = poolForColor.filter((x) => x.it.state === 'mistake' || x.it.state === 'unclear');
        if (retry.length > 0) pick = retry[Math.floor(Math.random() * retry.length)].i;
      }
      if (pick === null) {
        store.applyResult({ type: 'opening', xp: XP_SESSION_BONUS, correct: 0, total: 0 });
        setSessionStats((st) => ({ ...st, xp: st.xp + XP_SESSION_BONUS }));
        /*
         * THE SESSION'S OWN MOMENT. Every exercise this session can touch is solved — that is
         * what the done screen says in words, and the banner says it in the one slot the app has
         * for such moments. The count is read from the same pool the done screen renders.
         */
        const solved = items.filter((x) => x.state === 'solved').length;
        store.completeSession('train', `${solved} exercise${solved === 1 ? '' : 's'} solved`, XP_SESSION_BONUS);
        setPhase('done');
      } else {
        startExercise(items, pick);
      }
    }, 1400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, flash, store, startExercise]);

  // ---------- derived ----------
  const counts = useMemo(() => {
    const c = { todo: 0, mistake: 0, unclear: 0, solved: 0 };
    for (const it of pool) c[it.state]++;
    return c;
  }, [pool]);

  const fen = useMemo(() => positionAfter(sans, ply).fen(), [sans, ply]);

/**
 * THE HINT NAMES THE PIECE THE LINE PLAYS, NOT EVERY PIECE THAT CAN MOVE.
 *
 * THE REPORT: *"the hint doesnt work in a place and selects all the pieces in another place"*.
 *
 * This was `movableSquares(fen)`, which rings every piece with a legal move — one in a forcing
 * position, eight in an ordinary middlegame. That count is a description of the position, not a hint,
 * and it is the exact complaint the puzzle tabs were already fixed for. Training was missed because it
 * is a different screen with its own copy of the same three lines.
 *
 * The line's move is `sans[ply]` — the drill is a recall test, so the app knows the answer and this is
 * a READ of it rather than a guess. It names the PIECE only; the destinations are the second press.
 */
const hintFrom = useMemo(
  () => (hintStage >= 1 ? solvingPiece(fen, sans[ply]) : []),
  [hintStage, fen, sans, ply],
);
const hintTo = useMemo(
  () => (hintStage >= 2 ? targetSquares(fen, hintFrom) : []),
  [hintStage, fen, hintFrom],
);

/*
 * THE MISTAKE, AS TWO ARROWS ON THE BOARD.
 *
 * Red is what was played; gold is what the line plays. Both are needed and they say different things:
 * red alone is "not that", with no correction, and gold alone is the answer to a question the player
 * is still being asked.
 *
 * Shown only while a mistake is live — unlike the course walkthrough, where the line's arrow IS the
 * lesson. Here the whole exercise is recall, so the line's move on screen before the player has
 * produced it would be the answer, and the retry they are about to make would be a copy.
 */
const arrows: BoardArrow[] = useMemo(() => {
  if (phase !== 'playing' || !mistakeUci) return [];
  let correctUci: string | null = null;
  try {
    const made = sans[ply] ? new Chess(fen).move(sans[ply]) : null;
    if (made) correctUci = made.from + made.to + (made.promotion ?? '');
  } catch { /* an unreadable line move leaves the red arrow alone, which is still true */ }
  const played: BoardArrow = {
    startSquare: mistakeUci.slice(0, 2), endSquare: mistakeUci.slice(2, 4), color: colors.bad,
  };
  if (!correctUci) return [played];
  return [
    played,
    { startSquare: correctUci.slice(0, 2), endSquare: correctUci.slice(2, 4), color: colors.gold },
  ];
}, [phase, mistakeUci, fen, sans, ply]);

  const userTurn = phase === 'playing' && ply % 2 === userMod && ply < totalLen;
  const passProgress = totalLen ? ply / totalLen : 0;
  const solvedPct = pool.length ? Math.round((counts.solved / pool.length) * 100) : 0;
  const userSideName = current?.ex.userColor === 'w' ? 'White' : 'Black';

  // ---------- screens ----------
  if (phase === 'empty') {
    return (
      <View style={s.center}>
        <Card style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 8 }}>
          <View style={s.emptyIcon}>
            <IconDumbbell size={24} color={colors.gold} />
          </View>
          <Text style={s.h1}>
            {sel.mode === 'mine' ? 'No openings of your own yet' : 'Nothing to train yet'}
          </Text>
          <Text style={[s.bodySm, { textAlign: 'center', lineHeight: 17 }]}>
            {sel.mode === 'mine'
              ? 'Your repertoire is built from your Lichess games. Open the Openings tab, tap "Your openings", and decide what to play in the positions you reached — every move you keep shows up here for drill.'
              : 'Train pulls exercises from the openings you already practiced. Open a study in the Openings tab, run its Course, then Practice it — your learned positions will start appearing here for mixed repetition.'}
          </Text>
          <Btn label="Choose openings / lines" variant="ghost" onPress={() => setPickerOpen(true)} style={{ alignSelf: 'stretch', marginTop: 12 }} />
          <Btn label="Back" onPress={onExit} style={{ alignSelf: 'stretch', marginTop: 8 }} />
        </Card>
        {pickerOpen ? (
          <StudyPicker sel={sel} onApply={applySel} onClose={() => setPickerOpen(false)} customCount={customCount} />
        ) : null}
      </View>
    );
  }

  if (phase === 'done') {
    const acc = sessionStats.total > 0 ? Math.round((sessionStats.correct / sessionStats.total) * 100) : 100;
    return (
      <View style={s.center}>
        <Card style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 6 }}>
          <View style={s.sessionIcon}>
            <IconSparkles size={28} color={colors.gold} />
          </View>
          <Text style={s.h1}>All exercises solved!</Text>
          <Text style={s.bodySm}>
            {pool.length} positions · {sessionStats.passes} passes · {acc}% first-try · +{sessionStats.xp} XP
          </Text>
          <Text style={[s.bodySm, { textAlign: 'center', lineHeight: 17, marginTop: 8 }]}>
            The positions you drilled are scheduled for spaced review — come back tomorrow and Train will serve them again before they fade.
          </Text>
          <View style={[s.row2, { alignSelf: 'stretch', marginTop: 20 }]}>
            <Btn label="Done" variant="ghost" onPress={onExit} style={{ flex: 1 }} />
            <Btn label="Train again" onPress={() => void initFrom(sel)} style={{ flex: 1 }} />
          </View>
          <Btn label="Change openings / lines" variant="ghost" small onPress={() => setPickerOpen(true)} style={{ alignSelf: 'stretch', marginTop: 8 }} />
        </Card>
        {pickerOpen ? (
          <StudyPicker sel={sel} onApply={applySel} onClose={() => setPickerOpen(false)} customCount={customCount} />
        ) : null}
      </View>
    );
  }

  if (!current || !curStudy) {
    return (
      <View style={s.center}>
        <Card style={{ alignItems: 'center', padding: 24 }}>
          <Text style={s.body}>Preparing exercises…</Text>
        </Card>
      </View>
    );
  }

  /*
   * THE LABEL HAS TO NAME WHAT IS BEING DRILLED.
   *
   * `mine` fell into the `else` and was called "all openings" — the opposite of what it is, on
   * the one screen whose whole point is the user's own repertoire. It read as a bug in the
   * trainer rather than in the title, which is worse than no title: when the drill then served
   * a book line instead of the user's own, the header appeared to be lying about that too.
   */
  const selLabel =
    sel.mode === 'custom' ? `${sel.lines.length} selected line${sel.lines.length > 1 ? 's' : ''}`
    : sel.mode === 'mine' ? 'your openings'
    : 'learned lines';

  /*
   * THE SCOPE IS NAMED, AND CAN BE DROPPED.
   *
   * A silent scope is indistinguishable from a bug: the session would simply contain positions from
   * a different opening, and the user would have no way to tell that from the app having forgotten
   * where he was. So the opening appears in the title, and there is a visible way back to the full
   * review - because arriving scoped is a convenience, not a decision he made. The same reasoning
   * that put the source in the title applies to the scope, for the same reason.
   */
  const titleLabel = scopeName ? `${selLabel} · ${scopeName}` : selLabel;

  return (
    <View style={s.root}>
      {/* Top bar */}
      <View style={s.topBar}>
        <Pressable onPress={onExit} style={s.backBtn} accessibilityLabel="Back">
          <IconArrowLeft size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <View style={s.topTitleRow}>
            <IconDumbbell size={14} color={colors.gold} />
            <Text style={s.topTitle} numberOfLines={1}>Train — {titleLabel}</Text>
          </View>
          <Text style={s.bodySm} numberOfLines={1}>
            {counts.solved}/{pool.length} memorized · {studyShortTitle(curStudy.title)}
            {startPly > 0 ? ` · from move ${Math.floor(startPly / 2) + 1}` : ' · from the start'}
          </Text>
        </View>
        <IconBtn onPress={() => setPickerOpen(true)} label="Customize training sources">
          <IconSliders size={16} color={colors.mutedForeground} />
        </IconBtn>
      </View>
      <Bar pct={passProgress} color={colors.primary} height={4} />

      {scopeName ? (
        <View style={s.scopeRow}>
          <Text style={[s.bodySm, { flex: 1 }]} numberOfLines={1}>
            Positions from what you have learned in {scopeName}.
          </Text>
          <Pressable
            onPress={() => { setScope(null); void initFrom(sel); }}
            hitSlop={8}
            style={s.scopeClear}
            accessibilityLabel={`Include every opening, not only ${scopeName}`}
          >
            <Text style={s.scopeClearText}>All openings</Text>
          </Pressable>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, gap: 12, paddingBottom: 100 + insets.bottom }}>
        {/* Board */}
        <Animated.View key={shakeKey} style={{ transform: [{ translateX: shakeAnim.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) }] }}>
          <ChessForgeBoard
            fen={fen}
            orientation={current?.ex.userColor === 'w' ? 'white' : 'black'}
            interactive={userTurn}
            onMove={handleMove}
            lastMove={lastMove}
            arrows={arrows}
            hintFrom={hintStage >= 1 ? hintFrom : []}
            hintTo={hintStage >= 2 ? hintTo : []}
          />
        </Animated.View>

        {/*
         * THE MISTAKE NOTICE, placed immediately under the board.
         *
         * Position is the whole argument. The mistake counter already existed, but it sat in
         * the status row's top-right corner, small and grey-ish, while the eye is on a board
         * that has just bounced and is waiting to be used again. Put directly under the piece
         * the user just moved, the same information is unmissable. It is also transient by
         * construction: the next correct move clears it, so it describes the present moment
         * rather than accumulating into a log the user has to dismiss.
         */}
        {mistakeNotice ? (
          <View style={s.mistakeNotice} accessibilityLiveRegion="polite">
            <IconX size={14} color={colors.bad} />
            <Text style={s.mistakeNoticeText}>{mistakeNotice}</Text>
          </View>
        ) : null}

        {/* Status / comment */}
        <Card style={{ minHeight: 76 }}>
          {phase === 'presenting' ? (
            <Text style={[s.body, { lineHeight: 17 }]}>
              <Text style={{ color: colors.chessforge, fontWeight: '500' }}>Setting up: </Text>
              replaying the moves played before this position — get ready, you are {userSideName}…
            </Text>
          ) : phase === 'flash' && flash ? (
            <View style={s.flashRow}>
              {flash.good
                ? <IconCheckCircle size={16} color={colors.chessforge} />
                : <IconX size={16} color={colors.bad} />}
              <Text style={[s.body, { lineHeight: 17 }]}>{flash.text}</Text>
            </View>
          ) : (
            <>
              <View style={s.statusRow}>
                <Text style={[s.statusText, userTurn ? { color: colors.gold } : null]}>
                  {userTurn ? `● Your move (${userSideName})` : '○ Opponent thinking…'}
                </Text>
                <View style={s.statusActions}>
                  {mistakesThisPass > 0 ? (
                    <View style={s.mistakeRow}>
                      <IconX size={11} color={colors.bad} />
                      <Text style={s.mistakeText}>{mistakesThisPass}</Text>
                    </View>
                  ) : null}
                  {userTurn ? (
                    <Pressable onPress={showHint} style={s.hintBtn}>
                      <IconLightbulb size={12} color={colors.gold} />
                      <Text style={s.hintText}>Hint</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
              {comment ? (
                <Text style={[s.body, { lineHeight: 17 }]} numberOfLines={4}>
                  <Text style={{ color: colors.chessforge, fontWeight: '500' }}>Coach: </Text>{comment}
                </Text>
              ) : (
                <Text style={[s.body, { opacity: 0.6, lineHeight: 17 }]}>
                  Continue the line from here — you are {userSideName}.
                </Text>
              )}
            </>
          )}
        </Card>

        {/* Move list (played so far — no spoilers) */}
        <Card style={{ padding: 8 }}>
          <View style={s.exNote}>
            <IconBookOpen size={10} color={colors.mutedForeground} />
            <Text style={s.bodySm}>{studyShortTitle(curStudy.title)} · line {current.ex.line.index + 1}</Text>
          </View>
          <MoveList sans={sans.slice(0, ply)} currentPly={ply} />
        </Card>
      </ScrollView>

      {/* Bottom pipeline counters */}
      <View style={[s.pipeline, { paddingBottom: insets.bottom }]}>
        <View style={s.pipelineRow}>
          <Counter label="To do" value={counts.todo} dot={colors.whiteSide} />
          <Counter label="Mistakes" value={counts.mistake} dot={colors.bad} />
          <Counter label="Unclear" value={counts.unclear} dot={colors.warn} />
          <Counter label="Solved" value={counts.solved} dot={colors.chessforge} />
        </View>
        <Bar pct={solvedPct / 100} color={colors.chessforge} height={4} trackColor={colors.subtleFill} />
      </View>

      {pickerOpen ? (
        <StudyPicker sel={sel} onApply={applySel} onClose={() => setPickerOpen(false)} customCount={customCount} />
      ) : null}
    </View>
  );
}

/* ==================== opening → chapter → line picker ==================== */

interface PickerLine { id: string; index: number; isVariation: boolean; moves: number }
interface PickerStudy {
  id: string;
  title: string;
  practiced: boolean;
  lines: PickerLine[];
  /**
   * `type: 'Reference'` — a prose index with no lines, so nothing to select.
   *
   * Carried through so `selectableOf` can exclude it. A reference study has no
   * `lines` at all, so it contributed an empty id list, which made its checkbox
   * render in the "none" state and do nothing when pressed: the dead-control shape
   * that was already fixed for un-practised lines, reappearing for a different
   * reason. It is excluded here rather than given a fake line.
   */
  reference: boolean;
}
interface PickerChapter { key: string; title: string; studies: PickerStudy[] }
interface PickerOpening { id: string; name: string; side: 'white' | 'black'; chapters: PickerChapter[] }

/** Lazily-filled mastery layer, keyed by study id (see `mastery` in StudyPicker). */
interface MasteryEntry { study: number | null; lines: Record<string, number | null> }

type Tri = 'none' | 'some' | 'all';

function TriBox({ state, disabled, onPress, label }: {
  state: Tri;
  disabled?: boolean;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={[
        s.triBox,
        state === 'all' ? { backgroundColor: colors.gold, borderColor: colors.gold }
          : state === 'some' ? { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.2)' }
          : { borderColor: colors.faint },
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      {state !== 'none' ? <IconCheck size={11} color={state === 'some' ? colors.gold : '#000'} strokeWidth={3.5} /> : null}
    </Pressable>
  );
}

function StudyPicker({ sel, onApply, onClose, customCount }: {
  sel: Sel;
  onApply: (s: Sel) => void;
  onClose: () => void;
  customCount: number;
}) {
  const studiesState = useAppStore((st) => st.studies);
  const positions = useAppStore((st) => st.positions);
  // The sheet is bottom-anchored, so its footer sits under the system nav bar
  // unless we pad it out by the inset.
  const insets = useSafeAreaInsets();

  /*
   * Structural tree: openings → chapters → studies → lines.
   *
   * This deliberately does NOT read `positions` any more. It used to compute
   * `lineMastery` for EVERY line of EVERY study of EVERY opening — roughly
   * 500 studies × ~30 lines, each one a fresh `new Chess()` replayed ply by ply
   * with a `c.fen()` per move. That is an O(all lines × line length) burst of
   * chess.js work on the JS thread, and it ran synchronously the first time the
   * sheet rendered — which is the freeze reported when tapping Customize.
   *
   * Mastery is now fetched lazily per study, and only for studies the user has
   * actually expanded (see `masteryOf` below). The tree itself is pure
   * structure and is stable for the process lifetime, so it is computed once.
   */
  const tree = useMemo<PickerOpening[]>(
    () => AVAILABLE_OPENINGS.map((o) => {
      const rep = o.repertoire as Repertoire;
      return {
        id: o.id,
        name: o.name,
        side: o.side,
        chapters: rep.chapters.map((ch) => ({
          key: `${o.id}::${ch.title}`,
          title: ch.title,
          studies: ch.studies.map((st) => {
            const ls = collectStudyLines(st);
            return {
              id: st.id,
              title: st.title,
              practiced: (studiesState[st.id]?.attempts ?? 0) > 0,
              reference: isReferenceStudy(st),
              lines: ls.map((l) => ({
                id: l.id,
                index: l.index,
                isVariation: l.isVariation,
                moves: Math.ceil(l.plyCount / 2),
              })),
            };
          }),
        })),
      };
    }),
    [studiesState],
  );

  /*
   * Mastery is a separate, lazily-filled layer keyed by study id. Filling it is
   * the expensive part, so `MasteryChip` renders "…" until the value arrives
   * and the fill runs after the sheet has painted (see the effect below), which
   * keeps the tap-to-open interaction free.
   */
  const [mastery, setMastery] = useState<Record<string, { study: number | null; lines: Record<string, number | null> }>>({});

  useEffect(() => {
    let alive = true;
    // Yield one frame so the modal paints before we start crunching.
    const t = setTimeout(() => {
      const acc: Record<string, { study: number | null; lines: Record<string, number | null> }> = {};
      for (const ref of studyIndexAll()) {
        const { lines, mastery: m } = rateStudyLines(ref.study, ref.userColor, positions);
        const byId: Record<string, number | null> = {};
        for (const l of lines) byId[l.id] = l.mastery;
        acc[ref.study.id] = { study: m, lines: byId };
      }
      if (alive) setMastery(acc);
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [positions]);

  const masteryOf = (studyId: string) => mastery[studyId];

  const [draft, setDraft] = useState<Set<string>>(() => new Set(sel.mode === 'custom' ? sel.lines : []));
  const [weakFirst, setWeakFirst] = useState<boolean>(false);
  const [openOpenings, setOpenOpenings] = useState<Set<string>>(() => {
    if (sel.mode !== 'custom') {
      const first = AVAILABLE_OPENINGS[0];
      return new Set(first ? [first.id] : []);
    }
    const wanted = new Set(sel.lines);
    const open = new Set<string>();
    for (const ref of studyIndexAll()) {
      if (collectStudyLines(ref.study).some((l) => wanted.has(l.id))) open.add(ref.entry.id);
    }
    return open;
  });
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => {
    const open = new Set<string>();
    if (sel.mode === 'custom') {
      const wanted = new Set(sel.lines);
      for (const ref of studyIndexAll()) {
        if (collectStudyLines(ref.study).some((l) => wanted.has(l.id))) open.add(ref.chapterKey);
      }
    }
    return open;
  });

  // hydrate weak-first preference (async kv-store)
  useEffect(() => {
    let alive = true;
    loadWeakFirst().then((v) => { if (alive) setWeakFirst(v); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /**
   * Every line id under a node — the full set, not just the practised ones.
   *
   * THE PICKER WAS DEAD ON A FRESH ACCOUNT
   * --------------------------------------
   * This used to filter on `st.practiced`, so a study the user had never opened
   * contributed NOTHING to its chapter's selectable set. For a new account that
   * is every study, which means:
   *
   *   - `tri([])` returned 'none',
   *   - `toggleNode([])` returned immediately on `ids.length === 0`,
   *   - the chapter's tri-state box was disabled,
   *
   * so clicking a chapter did nothing at all, while looking perfectly usable. That
   * is the reported "i tried clicking all the sicilian chapter for example and
   * nothing happened", and the gate was invisible — which is why this is a
   * behaviour fix and not a styling one.
   *
   * `practiced` is still computed and still shown: it is how the sheet tells you
   * where you have got to. It is a LABEL, not an access control. Choosing
   * something to drill is an explicit request, so it is honoured, and the pool
   * builder is told to include unlearned lines for exactly that reason
   * (`buildTrainExercises({ includeUnlearned: true })`).
   */
  const selectableOf = (studies: PickerStudy[]) =>
    // Reference indexes are skipped explicitly. They yield no lines, so leaving them
    // in produced an empty id list and a checkbox that looked enabled and did
    // nothing — the same dead control the `practiced` gate used to cause.
    studies.filter((st) => !st.reference).flatMap((st) => st.lines.map((l) => l.id));

  const tri = (ids: string[]): Tri => {
    if (ids.length === 0) return 'none';
    const n = ids.filter((id) => draft.has(id)).length;
    return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
  };

  const setMany = (ids: string[], add: boolean) => {
    setDraft((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const toggleNode = (ids: string[]) => {
    if (ids.length === 0) return;
    setMany(ids, !ids.every((id) => draft.has(id)));
  };

  const toggleLine = (id: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleWeakFirst = () => {
    setWeakFirst((v) => {
      void saveWeakFirst(!v);
      return !v;
    });
  };

  const weakKey = (m: number | null) => (m == null ? Number.POSITIVE_INFINITY : m);

  const studyMastery = (st: PickerStudy): number | null => masteryOf(st.id)?.study ?? null;
  const lineMasteryOf = (st: PickerStudy, lineId: string): number | null =>
    masteryOf(st.id)?.lines[lineId] ?? null;

  const viewTree = useMemo<PickerOpening[]>(() => {
    if (!weakFirst) return tree;
    const byWeak = <T,>(arr: T[], m: (x: T) => number | null): T[] =>
      [...arr].sort((a, b) => weakKey(m(a)) - weakKey(m(b)));
    const studyAvg = (ch: PickerChapter): number | null => {
      const rated = ch.studies.map(studyMastery).filter((x): x is number => x != null);
      return rated.length ? rated.reduce((a, x) => a + x, 0) / rated.length : null;
    };
    return byWeak(tree, (o) => {
      const rated = o.chapters.map(studyAvg).filter((x): x is number => x != null);
      return rated.length ? rated.reduce((a, x) => a + x, 0) / rated.length : null;
    }).map((o) => ({
      ...o,
      chapters: [...o.chapters]
        .sort((a, b) => weakKey(studyAvg(a)) - weakKey(studyAvg(b)))
        .map((ch) => ({
          ...ch,
          studies: [...ch.studies]
            .sort((a, b) => weakKey(studyMastery(a)) - weakKey(studyMastery(b)))
            .map((st) => ({
              ...st,
              lines: [...st.lines].sort((a, b) => weakKey(lineMasteryOf(st, a.id)) - weakKey(lineMasteryOf(st, b.id))),
            })),
        })),
    }));
  }, [tree, weakFirst, mastery]);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.pickerBackdrop} onPress={onClose}>
        <Pressable style={s.pickerSheet} onPress={(e) => e.stopPropagation()}>
          <View style={s.pickerHeader}>
            <IconSliders size={16} color={colors.gold} />
            <View style={{ flex: 1 }}>
              <Text style={s.pickerTitle}>Customize training</Text>
              <Text style={s.bodySm}>Openings → chapters → lines — pick what your exercises come from</Text>
            </View>
            <IconBtn onPress={onClose} label="Close">
              <IconX size={17} color={colors.foreground} />
            </IconBtn>
          </View>

          <View style={s.sortRow}>
            <Text style={[s.bodySm, { textTransform: 'uppercase' }]}>Sort</Text>
            <View style={s.sortToggle}>
              <Pressable onPress={() => weakFirst && toggleWeakFirst()} style={[s.sortBtn, !weakFirst ? s.sortBtnActive : null]}>
                <Text style={[s.sortBtnText, !weakFirst ? { color: colors.gold } : null]}>Book order</Text>
              </Pressable>
              <Pressable onPress={() => !weakFirst && toggleWeakFirst()} style={[s.sortBtn, weakFirst ? s.sortBtnActive : null]}>
                <Text style={[s.sortBtnText, weakFirst ? { color: colors.gold } : null]}>Weakest first</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 12, gap: 8 }}>
            {/*
              The user's OWN repertoire, offered as a first-class source rather
              than hidden inside the line tree. It is not a book study, so it
              cannot live in the tree; and putting it first means the choice the
              user is most likely to want ("drill the stuff I decided on") is
              one tap, not a scroll past ten shipped openings.
            */}
            <Pressable
              style={[s.pickerCard, s.myRepCard, sel.mode === 'mine' ? s.myRepCardActive : null]}
              /*
               * Always applies `mine`, even when empty. Falling back to `all`
               * here would look like the tap did nothing and would hide the one
               * screen explaining how to build a repertoire — which is exactly
               * what the empty state is for.
               */
              onPress={() => onApply({ mode: 'mine' })}
              accessibilityLabel="Train your own openings"
            >
              <View style={s.myRepRow}>
                <View style={s.myRepIcon}>
                  <IconSparkles size={16} color={colors.gold} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.pickerOpeningName} numberOfLines={1}>Your openings</Text>
                  <Text style={s.bodySm} numberOfLines={2}>
                    {customCount > 0
                      ? `${customCount} move${customCount > 1 ? 's' : ''} you adopted from your own games`
                      : 'Decide on positions from your Lichess games to build this'}
                  </Text>
                </View>
                {sel.mode === 'mine' ? (
                  <View style={s.myRepCheck}>
                    <IconCheck size={13} color={colors.background} />
                  </View>
                ) : null}
              </View>
            </Pressable>

            {viewTree.map((o) => {
              const sel0 = selectableOf(o.chapters.flatMap((c) => c.studies));
              const total = o.chapters.reduce((n, c) => n + c.studies.reduce((m, st) => m + st.lines.length, 0), 0);
              const st = tri(sel0);
              const open = openOpenings.has(o.id);
              return (
                <View key={o.id} style={s.pickerCard}>
                  {/* ---- opening row ---- */}
                  <View style={[s.pickerRow, { backgroundColor: colors.surfaceRaised }]}>
                    <TriBox state={st} disabled={sel0.length === 0} onPress={() => toggleNode(sel0)} label={`Toggle ${o.name}`} />
                    <Pressable style={{ flex: 1 }} onPress={() => toggleSet(setOpenOpenings, o.id)}>
                      <View style={s.pickerOpeningRow}>
                        <Text style={s.pickerOpeningName} numberOfLines={1}>{o.name}</Text>
                        <Text style={[s.bodySm, { color: o.side === 'white' ? colors.whiteSide : colors.gold }]}>
                          {o.side === 'white' ? 'as White' : 'as Black'}
                        </Text>
                        <Text style={s.bodySm}>{sel0.length}/{total} lines</Text>
                        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
                          <IconChevronDown size={14} color={colors.mutedForeground} />
                        </View>
                      </View>
                    </Pressable>
                  </View>

                  {open ? (
                    <View style={{ paddingHorizontal: 8, paddingBottom: 8, paddingTop: 6, gap: 6 }}>
                      {o.chapters.map((ch) => {
                        const chSel = selectableOf(ch.studies);
                        const chTotal = ch.studies.reduce((m, st) => m + st.lines.length, 0);
                        const chSt = tri(chSel);
                        const chOpen = openChapters.has(ch.key);
                        return (
                          <View key={ch.key} style={s.pickerChapterCard}>
                            <View style={[s.pickerRow, { backgroundColor: colors.surfaceRaised }]}>
                              <TriBox state={chSt} disabled={chSel.length === 0} onPress={() => toggleNode(chSel)} label={`Toggle ${ch.title}`} />
                              <Pressable style={{ flex: 1 }} onPress={() => toggleSet(setOpenChapters, ch.key)}>
                                <View style={s.pickerOpeningRow}>
                                  <Text style={s.pickerChapterName} numberOfLines={1}>{ch.title}</Text>
                                  <Text style={s.bodySm}>{chSel.length}/{chTotal} lines</Text>
                                  <View style={{ transform: [{ rotate: chOpen ? '180deg' : '0deg' }] }}>
                                    <IconChevronDown size={12} color={colors.mutedForeground} />
                                  </View>
                                </View>
                              </Pressable>
                            </View>

                            {chOpen ? (
                              <View style={{ paddingHorizontal: 8, paddingBottom: 8, gap: 2 }}>
                                {ch.studies.map((st) => {
                                  // Every line is selectable — see `selectableOf`.
                                  // `practiced` stays as a visual hint (the dimmed
                                  // row) rather than a gate, so tapping it does
                                  // something instead of silently doing nothing.
                                  const sSel = st.lines.map((l) => l.id);
                                  const stM = studyMastery(st);
                                  return (
                                    <View key={st.id} style={{ opacity: st.practiced ? 1 : 0.72 }}>
                                      <View style={s.pickerStudyRow}>
                                        <TriBox state={tri(sSel)} disabled={sSel.length === 0} onPress={() => toggleNode(sSel)} label={`Toggle ${st.title}`} />
                                        <Text style={s.pickerStudyName} numberOfLines={1}>{studyShortTitle(st.title)}</Text>
                                        <MasteryChip mastery={stM} pending={mastery[st.id] === undefined} />
                                        <Text style={s.bodySm}>{st.lines.length} line{st.lines.length === 1 ? '' : 's'}</Text>
                                      </View>
                                      <View style={{ paddingLeft: 28, paddingBottom: 4, gap: 2 }}>
                                        {st.lines.map((l) => {
                                          const checked = draft.has(l.id);
                                          return (
                                            <Pressable
                                              key={l.id}
                                              onPress={() => toggleLine(l.id)}
                                              style={s.lineRow}
                                            >
                                              <View style={[s.lineCheckbox, checked ? { backgroundColor: colors.gold, borderColor: colors.gold } : null]}>
                                                {checked ? <IconCheck size={10} color="#000" strokeWidth={3.5} /> : null}
                                              </View>
                                              <Text style={s.lineText} numberOfLines={1}>
                                                Line {l.index + 1} · {l.isVariation ? 'variation' : 'mainline'} · {l.moves} moves
                                              </Text>
                                              <MasteryChip mastery={lineMasteryOf(st, l.id)} pending={mastery[st.id] === undefined} />
                                            </Pressable>
                                          );
                                        })}
                                      </View>
                                    </View>
                                  );
                                })}
                              </View>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>

          <View style={[s.pickerFooter, { paddingBottom: 12 + insets.bottom }]}>
            <Text style={s.bodySm}>
              {sel.mode === 'mine'
                ? 'Exercises come from the moves you adopted in your own games'
                : draft.size > 0
                  ? `Exercises will come from ${draft.size} selected line${draft.size > 1 ? 's' : ''}`
                  : 'No selection — exercises come from all learned openings (mixed)'}
            </Text>
            <View style={s.legendRow}>
              <Text style={[s.bodySm, { opacity: 0.8 }]}>Mastery: </Text>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: colors.chessforge }]} /><Text style={s.bodySm}>≥70% solid</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: colors.warn }]} /><Text style={s.bodySm}>35–69%</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: colors.bad }]} /><Text style={s.bodySm}>&lt;35% shaky</Text></View>
            </View>
            <View style={s.row2}>
              <Btn label="Use all learned" variant="ghost" small onPress={() => onApply({ mode: 'all' })} style={{ flex: 1 }} />
              {/*
                When `mine` is active, "Apply" must APPLY it — falling through to
                `all` (because no book lines are drafted) would silently discard
                the source the user picked and replace it with the book pool.
              */}
              <Btn
                label={sel.mode === 'mine' ? 'Train my openings' : 'Apply'}
                small
                onPress={() => onApply(
                  sel.mode === 'mine'
                    ? { mode: 'mine' }
                    : draft.size > 0
                      ? { mode: 'custom', lines: [...draft] }
                      : { mode: 'all' },
                )}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Counter({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: dot }} />
        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans }}>{value}</Text>
      </View>
      <Text style={{ fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans }}>{label}</Text>
    </View>
  );
}

/**
 * Line/study mastery chip: mini progress bar + %, or "new" when untrained.
 *
 * `pending` means the mastery layer has not been computed for this study yet —
 * it renders a neutral placeholder instead of "new", so a study the user has
 * drilled does not briefly claim to be untouched while the sheet is warming up.
 */
function MasteryChip({ mastery, pending }: { mastery: number | null; pending?: boolean }) {
  if (pending) {
    return <Text style={{ fontSize: 9, color: colors.faint, fontFamily: fonts.sans }}>…</Text>;
  }
  if (mastery == null) {
    return <Text style={{ fontSize: 9, color: colors.faint, fontFamily: fonts.sans }}>new</Text>;
  }
  const pct = Math.round(mastery * 100);
  const bar = mastery >= 0.7 ? colors.chessforge : mastery >= 0.35 ? colors.warn : colors.bad;
  const text = mastery >= 0.7 ? colors.chessforge : mastery >= 0.35 ? colors.warnText : colors.badText;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 32, height: 4, borderRadius: 999, backgroundColor: colors.subtleFillStrong, overflow: 'hidden' }}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: bar }} />
      </View>
      <Text style={{ fontSize: 9, fontWeight: '600', color: text, fontFamily: fonts.sans }}>{pct}%</Text>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  row2: { flexDirection: 'row', gap: 8 },

  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 6, borderRadius: 999 },
  topTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold, flex: 1 },

  /* The scope strip: which opening the session is confined to, and the way out of it. */
  scopeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  scopeClear: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border,
  },
  scopeClearText: { fontSize: 11, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },

  flashRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  statusText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },
  statusActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mistakeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mistakeText: { fontSize: 11, color: colors.bad, fontFamily: fonts.sans },
  mistakeNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.badSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.bad,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  mistakeNoticeText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 17,
    color: colors.bad,
    fontFamily: fonts.sans,
    fontWeight: '500',
  },
  hintBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  hintText: { fontSize: 11, color: colors.gold, fontFamily: fonts.sans },
  exNote: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 4 },

  emptyIcon: {
    width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(212,175,55,0.15)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  sessionIcon: {
    width: 64, height: 64, borderRadius: 20, backgroundColor: 'rgba(212,175,55,0.25)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },

  pipeline: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border,
  },
  pipelineRow: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 8, justifyContent: 'space-around' },

  pickerBackdrop: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  pickerSheet: {
    backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderColor: colors.border,
    /*
     * Must be a definite height, not `maxHeight`. The body is a `flex: 1`
     * ScrollView holding the opening tree *and* the legend + Apply buttons.
     * Inside an auto-height (content-sized) parent a `flex: 1` ScrollView
     * resolves to zero height, which hid the entire tree and pushed Apply off
     * screen — the sheet looked empty and its customization could not be used.
     */
    height: '88%', flexDirection: 'column',
  },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  pickerTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },
  sortRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  sortToggle: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' },
  sortBtn: { paddingHorizontal: 10, paddingVertical: 4 },
  sortBtnActive: { backgroundColor: 'rgba(212,175,55,0.2)' },
  sortBtnText: { fontSize: 11, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },

  pickerCard: { borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  pickerOpeningRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  pickerOpeningName: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold, flex: 1 },
  pickerChapterCard: { borderRadius: 10, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  pickerChapterName: { fontSize: 12, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold, flex: 1 },
  pickerStudyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingVertical: 6 },
  pickerStudyName: { fontSize: 11, fontWeight: '500', color: colors.foreground, fontFamily: fonts.sansMedium, flex: 1 },
  lineRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8,
  },
  lineCheckbox: {
    width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: colors.faint,
    alignItems: 'center', justifyContent: 'center',
  },
  lineText: { fontSize: 11, color: colors.foreground, fontFamily: fonts.sans, flex: 1 },

  /*
   * "Your openings" source card. Gold-tinted rather than neutral so it reads as
   * a different KIND of source from the shipped openings below it — it is the
   * user's own work, not a chapter of ours.
   */
  myRepCard: { padding: 10, borderWidth: 1, borderColor: 'rgba(255,213,74,0.22)' },
  myRepCardActive: { backgroundColor: 'rgba(255,213,74,0.08)' },
  myRepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  myRepIcon: {
    width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,213,74,0.12)',
  },
  myRepCheck: {
    width: 20, height: 20, borderRadius: 999, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.gold,
  },

  pickerFooter: {
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 999 },

  triBox: {
    width: 18, height: 18, borderRadius: 4, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
