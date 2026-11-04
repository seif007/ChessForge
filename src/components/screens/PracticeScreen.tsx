'use client';

/**
 * Practice screen — RN port of the web `screens/PracticeScreen.tsx`.
 * The core opening-training loop: play the repertoire side against a simulated
 * opponent, wrong moves bounce back, hints escalate, mastery accrues.
 *
 * Port notes:
 *  - the level `<select>` becomes a horizontal chip row (RN has no <select>)
 *  - `animate-shake` becomes a keyframed Animated translation
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Easing, Modal, ScrollView, Platform, UIManager,
} from 'react-native';
import type { LevelDef, Repertoire, RepStudy, TrainLine } from '@/lib/repertoire';
import {
  LEVELS, commentForPly, createPractice, expectedUserMove, fenKey,
  linesForLevel, opponentDeviation, positionFor, removePrefixLines, userToMove,
} from '@/lib/repertoire';
import { findStudyWithOpening } from '@/lib/openings';
import { Chess } from 'chess.js';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { buildDecisionIndex, decisionAt, type YourDecision } from '@/lib/yourOpenings';
import { loadActiveUsername, loadCachedPositions } from '@/lib/lichessStore';
import { MoveList } from '@/components/chess/MoveList';
import { EvalBar } from '@/components/chess/EvalBar';
import { evalCpWhite } from '@/lib/evals';
import { solvingPiece, targetSquares } from '@/lib/hint';
import { playMoveSound, playEffect } from '@/lib/sounds';
import { useAppStore, unlockByMastery, type AppState } from '@/lib/store';
import { Card, Bar, Btn } from '@/components/ui/Primitives';
import {
  IconArrowLeft, IconChevronRight, IconEye, IconLightbulb, IconRotateCcw,
  IconSparkles, IconTrophy, IconX, IconCheckCircle, IconBrain,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const XP_FIRST_TRY = 4;
const XP_RETRY = 1;
const XP_PERFECT = 12;
const XP_SESSION_BONUS = 5;
const INTERVALS_DAYS = [0, 1, 3, 7, 14, 30, 60];
const DEVIATION_CHANCE: Record<number, number> = { 4: 0.45, 5: 0.55, 6: 0.65 };
const MAX_LINES_PER_SESSION = 6;

interface LineResult {
  lineId: string;
  isVariation: boolean;
  perfect: boolean;
  mistakes: number;
  firstTry: number;
  totalUserMoves: number;
  xp: number;
  usedSolution: boolean;
}

function lineUserPositionKeys(studyId: string, sans: string[], userColor: 'w' | 'b'): string[] {
  const keys: string[] = [];
  const mod = userColor === 'b' ? 1 : 0;
  const c = new Chess();
  for (let i = 0; i < sans.length; i++) {
    if (i % 2 === mod) keys.push(`${studyId}|${fenKey(c.fen())}`);
    try { c.move(sans[i]); } catch { /* verified data */ }
  }
  return keys;
}

/**
 * The full line depth, independent of level.
 *
 * Levels 1-2 carry `maxPly` 8/12, and `linesForLevel` truncates to it — so
 * practicing at Beginner/Novice drilled only the first 2-3 moves of a 15-move
 * line and the session ended there ("only few moves, not the whole moves").
 * The Course screen never had this problem because it always asks for the LAST
 * level (`maxPly: 999`). Practice must match it: the level still governs hint
 * escalation and (Blaze+) variations, but *depth* comes from the data.
 */
const FULL_LINE: LevelDef = LEVELS[LEVELS.length - 1];

function buildSession(study: RepStudy, levelIdx: number, positionsState: AppState['positions'], userColor: 'w' | 'b'): TrainLine[] {
  const lines = removePrefixLines(linesForLevel(study, FULL_LINE));
  const now = Date.now();
  const scored = lines.map((l) => {
    const keys = lineUserPositionKeys(study.id, l.sans, userColor);
    const due = keys.reduce((a, k) => {
      const p = positionsState[k];
      return a + (!p || !p.dueAt || new Date(p.dueAt).getTime() <= now ? 1 : 0);
    }, 0);
    return { l, due };
  });
  scored.sort((a, b) => b.due - a.due);
  return scored.slice(0, MAX_LINES_PER_SESSION).map((x) => x.l);
}

export function PracticeScreen({ studyId, initialLevel, origin = 'all', onExit, onOpenStudy }: {
  studyId: string;
  initialLevel: number;
  /**
   * WHICH TAB THIS PRACTICE CAME FROM. `'all'` is All Openings or Home; `'mine'` is reached through
   * the course opened out of Your Openings.
   *
   * THE REPORT: *"showing the moves and choices of user is only in your openings not all
   * openings"*. Practice is reachable from All Openings directly, so it inherited the same leak as
   * the course did and needed the same fix. Default `'all'` for the same reason.
   */
  origin?: 'all' | 'mine';
  onExit: () => void;
  onOpenStudy?: (studyId: string) => void;
}) {
  /** THE ONE RULE: your own moves and choices are shown in YOUR openings, and nowhere else. */
  const showYourMoves = origin === 'mine';
  const hit = useMemo(() => findStudyWithOpening(studyId), [studyId]);
  const study = hit?.study as RepStudy | undefined;
  const userColor: 'w' | 'b' = hit?.entry.side === 'white' ? 'w' : 'b';
  const userMod = userColor === 'b' ? 1 : 0;
  const store = useAppStore();
  const prog = store.studies[studyId];

  const [level, setLevel] = useState(Math.min(initialLevel, 6));
  const [session, setSession] = useState<TrainLine[]>([]);
  const [lineIdx, setLineIdx] = useState(0);
  /*
   * THE USER'S OWN MOVES, BY POSITION.
   *
   * Loaded once from the cached positions, never re-derived: this is a course screen and re-analysing
   * the user games to decorate a line they are reading would stall it on network and engine work for
   * something already known. With no cache the index is null, decisionAt returns null, and the screen
   * draws the line's own arrow exactly as it did before - which is the right behaviour when we know
   * nothing about the user games.
   */
  const [yourDecisions, setYourDecisions] = useState<Map<string, YourDecision> | null>(null);
  useEffect(() => {
    // Same rule as the course: the user's games are not read unless this screen was opened from Your
    // Openings. See CourseScreen for why the guard is on the load and not only on the arrows.
    if (!showYourMoves) return;
    let cancelled = false;
    (async () => {
      try {
        const name = await loadActiveUsername();
        if (!name) return;
        const cached = await loadCachedPositions(name);
        if (cancelled || !cached) return;
        setYourDecisions(buildDecisionIndex(cached.positions, fenKey));
      } catch { /* no cache, no decisions; the line still teaches */ }
    })();
    return () => { cancelled = true; };
  }, [showYourMoves]);
  const [ps, setPs] = useState<ReturnType<typeof createPractice> | null>(null);
  const [status, setStatus] = useState<'playing' | 'lineDone' | 'sessionDone'>('playing');
  /**
   * THE MOVE THE PLAYER JUST GOT WRONG, IN THIS POSITION.
   *
   * Kept so the board can show both arrows after a wrong answer. A wrong move bounces back, so the
   * position is unchanged and the correction has to be state rather than something derived from the
   * position. Cleared the moment the position moves on, because a correction belongs to the question
   * it answered and not to the next one.
   */
  const [mistakeUci, setMistakeUci] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [wrongKey, setWrongKey] = useState(0);
  const [userMoveErrors, setUserMoveErrors] = useState(0);
  // Hint stage: 0 = none, 1 = ring the one piece the line plays, 2 = also dot where it can go.
  const [hintStage, setHintStage] = useState(0);
  const [erroredKeys, setErroredKeys] = useState<Set<string>>(new Set());
  const [linePositions, setLinePositions] = useState<{ key: string; correct: boolean }[]>([]);
  const [lineXp, setLineXp] = useState(0);
  const [sessionXp, setSessionXp] = useState(0);
  const [lineResults, setLineResults] = useState<LineResult[]>([]);
  const [comment, setComment] = useState<string | null>(null);
  const [usedSolution, setUsedSolution] = useState(false);
  const [showIntro, setShowIntro] = useState(false);
  const [levelUpTo, setLevelUpTo] = useState<number | null>(null);
  const [solving, setSolving] = useState(false);
  const levelAtStartRef = useRef(initialLevel);
  const lastAttemptRef = useRef<string>('');
  const lineFinishedRef = useRef(false);

  // shake animation (the web's `animate-shake`)
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const shake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: -1, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0.6, duration: 50, useNativeDriver: true, easing: Easing.linear }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true, easing: Easing.linear }),
    ]).start();
  }, [shakeAnim]);

  const levelDef = LEVELS[level - 1];
  const unlockedLevel = prog?.level ?? 1;

  // ---------- session lifecycle ----------
  const startLine = useCallback((line: TrainLine) => {
    setPs(createPractice(line));
    setStatus('playing');
    setLastMove(null);
    setUserMoveErrors(0);
    setHintStage(0);
    setErroredKeys(new Set());
    setLinePositions([]);
    setLineXp(0);
    setComment(null);
    setUsedSolution(false);
    setSolving(false);
    lastAttemptRef.current = '';
    lineFinishedRef.current = false;
  }, []);

  const startSession = useCallback((lv: number) => {
    if (!study) return;
    const lines = buildSession(study, lv, useAppStore.getState().positions, userColor);
    setSession(lines);
    setLineIdx(0);
    setSessionXp(0);
    setLineResults([]);
    setLevelUpTo(null);
    levelAtStartRef.current = lv;
    setLevel(lv);
    if (lines.length > 0) startLine(lines[0]);
    else setStatus('sessionDone');
  }, [study, startLine, userColor]);

  // boot: show intro for brand-new studies, then start session
  useEffect(() => {
    if (study?.intro && !prog?.attempts) setShowIntro(true);
    else startSession(Math.min(initialLevel, prog?.level ?? initialLevel));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-time session bootstrap on mount
  }, [studyId]);

  const dismissIntro = () => {
    setShowIntro(false);
    startSession(Math.min(initialLevel, prog?.level ?? initialLevel));
  };

  // ---------- position helpers ----------
  const chess = useMemo(() => (ps ? positionFor(ps) : new Chess()), [ps]);
  const fen = chess.fen();

/**
 * THE HINT NAMES ONE PIECE — THE ONE THAT PLAYS THIS LINE'S MOVE.
 *
 * THE REPORT: *"when i click hint it sometimes select one piece and sometimes all the pieces"*.
 *
 * This was `movableSquares(fen)`, which rings every piece that has a legal move. That number is
 * whatever the position happens to offer: one in a quiet middlegame, eight in a position full of
 * pawns. It is not a hint, it is a description of the position, and which of those the user got was
 * the reason for the report.
 *
 * The screen already knows the answer — `expectedUserMove` is the move this line plays — so the
 * hint is a read of that rather than a guess about which pieces look interesting. Exactly one square
 * comes back, every time, in every position.
 *
 * It is still a HINT and not the answer: it names the PIECE, never the square it goes to, and the
 * destinations are the second press.
 */
const expectedForHint = ps ? expectedUserMove(ps, userColor) : null;
const hintFrom = useMemo(
  () => (hintStage >= 1 && expectedForHint ? solvingPiece(fen, expectedForHint) : []),
  [hintStage, expectedForHint, fen],
);
const hintTo = useMemo(
  () => (hintStage >= 2 ? targetSquares(fen, hintFrom) : []),
  [hintStage, fen, hintFrom],
);
  const expected = ps ? expectedUserMove(ps, userColor) : null;
  const totalUserMoves = ps ? ps.sans.reduce((a, _, i) => a + (i % 2 === userMod ? 1 : 0), 0) : 0;

  /*
   * THE LINE'S ARROW, AND THE USER'S OWN MOVE BESIDE IT.
   *
   * THE REPORT, ON THIS SCREEN: *"when i go to another line in the same opening in course mode there
   * is no arrows (neither my choice or the app choice)"*. And, from the same user, quoted in
   * GameOpeningsScreen: *"this is a course so no you just show the arrows ... dont keep anything that
   * says you have to activate the arrows"*.
   *
   * What was removed here was an ARROW, and it was removed for a reason that was right about something
   * else. The note above says the old arrow came from the HINT: *"This used to play the EXPECTED move
   * and draw it as an arrow. That is not a hint - it is the answer."* Correct: a hint must ring the
   * pieces that can move and stop there. But the fix took the line's own arrow with it, and the line's
   * move is not a hint - it is what the screen is teaching, and it is on the board the whole time
   * otherwise. So the hint went back to `lib/hint` and the LINE arrow came back here, unconditionally.
   *
   * The second arrow is the user's own move at this position, joined by POSITION from their games (the
   * same `buildDecisionIndex` the course view uses). A decision belongs to a position, not to a line,
   * so this can be read at a line the user never played - which is the point: it is how "my choice vs
   * the app's" can be shown on a line that has nothing to do with the game it came from.
   *
   * ONE ARROW WHEN THERE IS ONE MOVE. When the user's own move IS the move this line plays, there is
   * nothing to compare and two arrows on the same two squares would be showing a disagreement that
   * does not exist.
   */
  const yourDecision = useMemo(() => (
    showYourMoves
      ? decisionAt(
        yourDecisions,
        status === 'playing' && ps ? fen : null,
        fenKey,
        fen.split(' ')[1] === 'b' ? 'b' : 'w',
        userColor,
      )
      : null
  ), [showYourMoves, yourDecisions, fen, ps, status, userColor]);

  const arrows = useMemo(() => {
    if (status !== 'playing') return [];

    // The UCI of the line's move here, or null if it cannot be made in this position.
    let lineUci: string | null = null;
    if (expected) {
      try {
        const probe = new Chess(fen);
        const made = probe.move(expected);
        if (made) lineUci = made.from + made.to + (made.promotion ?? '');
      } catch { /* the line is verified data; a throw here is not actionable */ }
    }

    /*
     * A MISTAKE IS SHOWN ON THE BOARD, NOT ONLY SENTENCED.
     *
     * THE REPORT: *"when i make a mistake it still doesnt show me red arrow for my move and an arrow
     * for the correct move"*.
     *
     * A wrong move here bounces straight back, so the position never changes and the arrow code —
     * which reads the position — had nothing new to read. The player got a shake and a sentence: the
     * one form of feedback that cannot be acted on without working out the square yourself, twice.
     *
     * So the move they actually played is kept, and it is drawn against the move the line wants. The
     * bounce is the right behaviour for the POSITION - they should retry the same square - and it
     * has no bearing on what the board should show while they do.
     */
    if (mistakeUci && lineUci) {
      if (mistakeUci.slice(0, 4) === lineUci.slice(0, 4)) return [{ startSquare: lineUci.slice(0, 2), endSquare: lineUci.slice(2, 4), color: colors.gold }];
      return [
        { startSquare: mistakeUci.slice(0, 2), endSquare: mistakeUci.slice(2, 4), color: colors.bad },
        { startSquare: lineUci.slice(0, 2), endSquare: lineUci.slice(2, 4), color: colors.gold },
      ];
    }

    // On the user's ply: the line's move. Two arrows only where the two really differ.
    if (expected) {
      if (!lineUci) return [];
      const gold: BoardArrow = {
        startSquare: lineUci.slice(0, 2), endSquare: lineUci.slice(2, 4), color: colors.gold,
      };
      if (!yourDecision || yourDecision.playedUci.slice(0, 4) === lineUci.slice(0, 4)) return [gold];
      return [
        {
          startSquare: yourDecision.playedUci.slice(0, 2),
          endSquare: yourDecision.playedUci.slice(2, 4),
          color: colors.bad,
        },
        gold,
      ];
    }
    // On the opponent's ply the line's reply is shown, in the opponent's colour, so the position
    // reads as a demonstration rather than a question.
    if (!ps || ps.moveIndex >= ps.sans.length) return [];
    try {
      const probe = new Chess(fen);
      const made = probe.move(ps.sans[ps.moveIndex]);
      if (!made) return [];
      const uci = made.from + made.to + (made.promotion ?? '');
      return [{
        startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color: arrowColors.reply,
      }];
    } catch {
      return [];
    }
  }, [status, expected, yourDecision, fen, ps, mistakeUci]);

  const recordPosition = useCallback((key: string, correct: boolean) => {
    setLinePositions((prev) => {
      if (prev.some((p) => p.key === key)) return prev; // first record wins
      return [...prev, { key, correct }];
    });
  }, []);

  const currentPosKey = useCallback((state: NonNullable<typeof ps>): string => {
    const c = positionFor(state);
    return `${studyId}|${fenKey(c.fen())}`;
  }, [studyId]);

  // ---------- line finish ----------
  const finishLine = useCallback(() => {
    if (!ps || lineFinishedRef.current) return; // idempotent
    lineFinishedRef.current = true;
    const perfect = ps.mistakes === 0 && !usedSolution;
    const firstTry = totalUserMoves - erroredKeys.size;
    const runScore = totalUserMoves > 0 ? Math.max(0, firstTry) / totalUserMoves : 1;
    const bonusXp = perfect ? XP_PERFECT : 0;
    const xp = lineXp + bonusXp;

    const prevProg = useAppStore.getState().studies[studyId];
    const prevMastery = prevProg?.mastery ?? 0;
    const newMastery = perfect
      ? Math.min(1, prevMastery + 0.2)
      : Math.max(0, prevMastery * 0.85 + runScore * 0.05);
    const newBestStreak = perfect ? (prevProg?.bestStreak ?? 0) + 1 : 0;
    const days = INTERVALS_DAYS[Math.min(newBestStreak, INTERVALS_DAYS.length - 1)];
    const dueAt = perfect
      ? new Date(Date.now() + days * 86400000).toISOString()
      : new Date().toISOString();

    store.applyResult({
      type: 'opening',
      xp,
      correct: Math.max(0, firstTry),
      total: totalUserMoves,
      studyId,
      study: {
        studyId,
        mastery: newMastery,
        perfectRuns: perfect ? 1 : 0,
        bestStreak: newBestStreak,
        level,
        dueAt,
      },
      positions: linePositions,
    });
    setSessionXp((x) => x + xp);
    setLineResults((r) => [...r, {
      lineId: ps.line.id, isVariation: ps.line.isVariation, perfect, mistakes: ps.mistakes,
      firstTry: Math.max(0, firstTry), totalUserMoves, xp, usedSolution,
    }]);
    const unlock = unlockByMastery(newMastery);
    if (unlock > levelAtStartRef.current && unlock <= 6) setLevelUpTo(unlock);
    if (perfect) playEffect('success');
    setStatus('lineDone');
  }, [ps, usedSolution, totalUserMoves, erroredKeys, lineXp, store, studyId, level, linePositions]);

  // ---------- opponent auto-move / line end ----------
  const playOpponentMove = useCallback((state: NonNullable<typeof ps>) => {
    if (!study || userToMove(state, userColor) || state.moveIndex >= state.sans.length) return;
    let sans = state.sans;
    if (levelDef.variations && !state.line.isVariation && DEVIATION_CHANCE[level]) {
      const devi = opponentDeviation(study, sans, state.moveIndex);
      if (devi && Math.random() < DEVIATION_CHANCE[level]) sans = devi;
    }
    const san = sans[state.moveIndex];
    const c = positionFor({ ...state, sans });
    let mv: { from: string; to: string } | null = null;
    let moved: { san: string; captured?: string; flags?: string } | null = null;
    try {
      const m = c.move(san);
      mv = { from: m.from, to: m.to };
      moved = m;
    } catch {
      return;
    }
    setPs({ ...state, sans, moveIndex: state.moveIndex + 1, userMoveErrors: 0 });
    if (mv) {
      setLastMove(mv);
      playMoveSound(moved);
    }
    setHintStage(0); // the reply moves the position on; the old hint is stale
    setComment(commentForPly(study as RepStudy, sans, state.moveIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelDef, level, study, userColor]);

  useEffect(() => {
    if (status !== 'playing' || !ps || showIntro) return;
    if (ps.moveIndex >= ps.sans.length) {
      const t = setTimeout(() => finishLine(), 600);
      return () => clearTimeout(t);
    }
    if (!userToMove(ps, userColor)) {
      const t = setTimeout(() => playOpponentMove(ps), 750);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps, status, showIntro, playOpponentMove, finishLine, userColor]);

  // ---------- hint ----------
  /**
   * Hints are STRICTLY user-initiated, and they are NOT the answer.
   *
   * This used to play the EXPECTED move and draw it as an arrow. That is not a hint — it is the
   * answer, drawn from the study rather than the engine, so it was even more tempting than it looks
   * because it is guaranteed to be what the line wants. See `@/lib/hint`: the hint rings the pieces
   * that can move, then dots where they can go, and the player still has to choose.
   *
   * The strictness is unchanged and still matters: the hint may only be written from the Hint button
   * and the escalation after a 2nd failed attempt, and it is cleared on every ply change, so it can
   * never sit on the board while it is not the user's turn. The old idle-triggered auto-hint
   * (`levelDef.hintAfterMs`) was doing nothing showing you the answer, which is the opposite of what
   * practice is for; it is unused and the level still governs depth and deviations.
   */
  const showHintFor = useCallback((_state: NonNullable<typeof ps>) => {
    // stage 0 -> ring the pieces, 1 -> also dot the destinations, 2 -> off.
    setHintStage((s) => (s + 1) % 3);
  }, []);

  // never leave a hint on the board when it is not the user's turn to act
  useEffect(() => {
    if (!ps || !userToMove(ps, userColor)) setHintStage(0);
  }, [ps, userColor]);

  // ---------- user move handling ----------
  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!ps || status !== 'playing' || !userToMove(ps, userColor)) return false;
    const attemptKey = `${ps.moveIndex}:${from}${to}`;
    if (lastAttemptRef.current === attemptKey) return false;
    lastAttemptRef.current = attemptKey;
    const exp = ps.sans[ps.moveIndex];
    const c = positionFor(ps);
    let m;
    try {
      m = c.move({ from, to, promotion });
    } catch { return false; }

    if (m.san === exp) {
      const key = currentPosKey(ps);
      const firstTry = !erroredKeys.has(key) && userMoveErrors === 0;
      if (firstTry) {
        recordPosition(key, true);
        setLineXp((x) => x + XP_FIRST_TRY);
      } else {
        recordPosition(key, false);
        setLineXp((x) => x + XP_RETRY);
      }
      const next: typeof ps = {
        ...ps,
        moveIndex: ps.moveIndex + 1,
        mistakes: ps.mistakes,
        firstTryPerfect: ps.firstTryPerfect && firstTry,
        userMoveErrors: 0,
      };
      setPs(next);
      setLastMove({ from: m.from, to: m.to });
      setMistakeUci(null);
      playMoveSound(m);
      setComment(commentForPly(study as RepStudy, ps.sans, ps.moveIndex));
      setHintStage(0);
      setUserMoveErrors(0);
      return true;
    }

    // wrong move — bounce back
    const key = currentPosKey(ps);
    // Remember what was actually played, so the board can show it against the right move.
    setMistakeUci(m.from + m.to + (m.promotion ?? ''));
    playEffect('wrong');
    setWrongKey((k) => k + 1);
    shake();
    setPs({ ...ps, mistakes: ps.mistakes + 1, firstTryPerfect: false });
    setUserMoveErrors((e) => e + 1);
    setErroredKeys((prev) => new Set(prev).add(key));
    recordPosition(key, false);
    if (userMoveErrors + 1 >= 2) showHintFor(ps);
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps, status, study, erroredKeys, userMoveErrors, currentPosKey, recordPosition, showHintFor, userColor, shake]);

  // after 3 errors: auto-play the book move
  useEffect(() => {
    if (!ps || status !== 'playing' || userMoveErrors < 3 || !userToMove(ps, userColor)) return;
    const t = setTimeout(() => {
      const exp = ps.sans[ps.moveIndex];
      const c = positionFor(ps);
      try {
        const mv = c.move(exp);
        setPs({ ...ps, moveIndex: ps.moveIndex + 1, userMoveErrors: 0 });
        setLastMove({ from: mv.from, to: mv.to });
        playMoveSound(mv);
        setComment(commentForPly(study as RepStudy, ps.sans, ps.moveIndex));
        setHintStage(0);
        setUserMoveErrors(0);
      } catch { /* noop */ }
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps, status, userMoveErrors, study, userColor]);

  // ---------- next study in library order ----------
  const nextStudy = useMemo(() => {
    const rep = hit?.entry.repertoire as Repertoire | null | undefined;
    if (!rep) return null;
    const flat = rep.chapters.flatMap((c) => c.studies);
    const idx = flat.findIndex((x) => x.id === studyId);
    return idx >= 0 && idx + 1 < flat.length ? flat[idx + 1] : null;
  }, [studyId, hit]);

  /**
   * More unplayed lines of this study, due-first and batched.
   *
   * Not level-filtered: every level trains the study's FULL lines (see
   * `FULL_LINE`), so the "is there anything left?" question is the same at every
   * level. The parameter is kept so callers read naturally.
   */
  const remainingLines = useCallback((_lv: number): TrainLine[] => {
    if (!study) return [];
    const all = removePrefixLines(linesForLevel(study, FULL_LINE));
    const played = new Set(session.map((l) => l.sans.join(' ')));
    const now = Date.now();
    const rest = all.filter((l) => !played.has(l.sans.join(' ')));
    const scored = rest.map((l) => {
      const keys = lineUserPositionKeys(study.id, l.sans, userColor);
      const due = keys.reduce((a, k) => {
        const p = useAppStore.getState().positions[k];
        return a + (!p || !p.dueAt || new Date(p.dueAt).getTime() <= now ? 1 : 0);
      }, 0);
      return { l, due };
    });
    scored.sort((a, b) => b.due - a.due);
    return scored.slice(0, MAX_LINES_PER_SESSION).map((x) => x.l);
  }, [study, session, userColor]);

  // ---------- next line (extends the session until the study is exhausted) ----------
  const finishSession = useCallback(() => {
    store.applyResult({ type: 'opening', xp: XP_SESSION_BONUS, correct: 0, total: 0 });
    /*
     * THE SESSION'S OWN MOMENT. Every line of it is trained. Raised right after the result write,
     * so if that write also started or extended the day's streak, the streak moment is absorbed
     * into this completion banner (which carries the day) instead of replacing it.
     */
    store.completeSession('lines', `${session.length} line${session.length === 1 ? '' : 's'}`, XP_SESSION_BONUS);
    setSessionXp((x) => x + XP_SESSION_BONUS);
    setStatus('sessionDone');
  }, [store, session.length]);

  const jumpToNextStudy = useCallback(() => {
    if (!nextStudy) return;
    store.applyResult({ type: 'opening', xp: XP_SESSION_BONUS, correct: 0, total: 0 });
    setSessionXp((x) => x + XP_SESSION_BONUS);
    onOpenStudy?.(nextStudy.id);
  }, [nextStudy, onOpenStudy, store]);

  const nextLine = useCallback(() => {
    const nextIdx = lineIdx + 1;
    if (nextIdx < session.length) {
      setLineIdx(nextIdx);
      startLine(session[nextIdx]);
      return;
    }
    const more = remainingLines(level);
    if (more.length > 0) {
      setSession((prev) => [...prev, ...more]);
      setLineIdx(session.length);
      startLine(more[0]);
      return;
    }
    finishSession();
  }, [lineIdx, session, level, remainingLines, startLine, finishSession]);

  // ---------- show solution ----------
  const showSolution = useCallback(() => {
    if (!ps || status !== 'playing') return;
    setSolving(true);
    setUsedSolution(true);
    const cur = currentPosKey(ps);
    recordPosition(cur, false);
    setErroredKeys((prev) => new Set(prev).add(cur));
    setStatus('playing');
    const step = () => {
      setPs((prev) => {
        if (!prev || prev.moveIndex >= prev.sans.length) return prev;
        const c = positionFor(prev);
        try {
          const mv = c.move(prev.sans[prev.moveIndex]);
          setTimeout(() => {
            setLastMove({ from: mv.from, to: mv.to });
            playMoveSound(mv);
            setComment(commentForPly(study as RepStudy, prev.sans, prev.moveIndex));
          }, 0);
          return { ...prev, moveIndex: prev.moveIndex + 1 };
        } catch { return prev; }
      });
    };
    const iv = setInterval(() => {
      setPs((prev) => {
        if (!prev || prev.moveIndex >= prev.sans.length) {
          clearInterval(iv);
          setTimeout(() => finishLine(), 700);
          return prev;
        }
        return prev;
      });
      step();
    }, 420);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ps, status, study, currentPosKey, recordPosition, finishLine]);

  // ---------- derived UI ----------
  const lineProgress = ps ? ps.moveIndex / Math.max(1, ps.sans.length) : 0;
  const sessionAccuracy = useMemo(() => {
    const tot = lineResults.reduce((a, r) => a + r.totalUserMoves, 0);
    const ok = lineResults.reduce((a, r) => a + r.firstTry, 0);
    return tot > 0 ? Math.round((ok / tot) * 100) : 100;
  }, [lineResults]);
  const totalMistakes = lineResults.reduce((a, r) => a + r.mistakes, 0);
  const hasNextLine = lineIdx + 1 < session.length || remainingLines(level).length > 0;

  /**
   * Every line of the study, at full depth — the true denominator for the
   * "Line n/N" counter. `session.length` is only the current BATCH (6), so using
   * it made a 12-line study look like it had 6 lines and the total changed under
   * the user as batches loaded. `session` is a subset of this, so the two are
   * consistent by construction.
   */
  const studyLineCount = useMemo(
    () => (study ? removePrefixLines(linesForLevel(study, FULL_LINE)).length : 0),
    [study],
  );

  /*
   * WHICH EXERCISE THIS IS, AND HOW MANY THERE ARE.
   *
   * THE REPORT: *"there is nothing indicating i am in practice a,d how many exercises there are"*.
   *
   * The header already counted LINES, which is the wrong unit: a line is a sequence of positions,
   * and the thing the player is asked to do is find one move in one position. So "Line 3/4" says
   * nothing about whether this is their last exercise or their first out of twenty.
   *
   * An exercise here is one position where it is their turn — that is what `expectedUserMove` asks
   * about, and what a wrong answer bounces back from. Counting those plies gives a number that moves
   * once per question, so the display advances exactly when the work does.
   *
   * The word "Practice" is in the same line for the other half of the report: the title was the study
   * name alone, so a player who arrived from All Openings had no way to tell a drill from a lesson.
   *
   * THIS MEMO IS DECLARED BEFORE THE `if (!study)` RETURN, and it was not at first. A hook after a
   * conditional return means one render has fewer hooks than the render before it, and React throws
   * "Rendered fewer hooks than expected" the first time a study fails to resolve — which is not a
   * rare path, it is what happens when a study id goes stale. The hooks gate caught it here and
   * named this line, which is the whole reason that gate exists.
   */
  const exercise = useMemo(() => {
    if (!ps) return { number: 0, total: 0 };
    let total = 0;
    let number = 0;
    for (let i = 0; i < ps.sans.length; i += 1) {
      if ((i % 2 === 0 ? 'w' : 'b') !== userColor) continue;
      total += 1;
      if (i === ps.moveIndex) number = total;
    }
    return { number, total };
  }, [ps, userColor]);

  if (!study) {
    return (
      <View style={s.center}>
        <Text style={s.body}>Study not found.</Text>
        <Pressable onPress={onExit}><Text style={s.goldLink}>Back</Text></Pressable>
      </View>
    );
  }

  const levelOptions = LEVELS.slice(0, Math.max(unlockedLevel, level));

  return (
    <View style={s.root}>
      {/* Top bar */}
      <View style={s.topBar}>
        <Pressable onPress={onExit} style={s.backBtn} accessibilityLabel="Back">
          <IconArrowLeft size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.topTitle} numberOfLines={1}>{study.title.replace(/^Study [\d.]+ — /, '')}</Text>
          <Text style={s.bodySm}>
            Practice · Line {Math.min(lineIdx + 1, studyLineCount || 1)}/{studyLineCount || 1}
            {exercise.total > 0
              ? ` · Exercise ${exercise.number || 1}/${exercise.total}`
              : ''}
            {session.length > 0 ? ` · ${sessionAccuracy}% first-try · ${totalMistakes} mistakes` : ''}
          </Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {levelOptions.map((l) => (
            <Pressable
              key={l.id}
              onPress={() => startSession(l.id)}
              style={[s.levelChip, level === l.id ? s.levelChipActive : null]}
              accessibilityLabel={`Training level ${l.name}`}
            >
              <Text style={[s.levelChipText, level === l.id ? { color: colors.gold } : null]}>{l.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <Bar pct={lineProgress} color={colors.primary} height={4} />

      {showIntro ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <Card style={{ padding: 20 }}>
            <View style={s.introHeader}>
              <IconBrain size={18} color={colors.chessforge} />
              <Text style={s.h2}>Study brief</Text>
            </View>
            <Text style={[s.body, { lineHeight: 20 }]}>{study.intro}</Text>
            <Btn label="Got it — start practicing" onPress={dismissIntro} style={{ marginTop: 16 }} />
          </Card>
        </ScrollView>
      ) : status !== 'sessionDone' ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, gap: 12 }}>
          {/* Board + eval bar */}
          <Animated.View key={wrongKey} style={{ transform: [{ translateX: shakeAnim.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) }] }}>
            <View style={s.boardRow}>
              <EvalBar cp={evalCpWhite(fen)} flip={userColor === 'b'} />
              <View style={{ flex: 1 }}>
                <ChessForgeBoard
                  fen={fen}
                  orientation={userColor === 'w' ? 'white' : 'black'}
                  interactive={status === 'playing' && !!ps && userToMove(ps, userColor) && !solving}
                  onMove={handleMove}
                  lastMove={lastMove}
                  arrows={arrows}
                  hintFrom={hintStage >= 1 ? hintFrom : []}
        hintTo={hintStage >= 2 ? hintTo : []}
                />
              </View>
            </View>
          </Animated.View>

          {/* Status / comment */}
          <Card style={{ minHeight: 76 }}>
            {status === 'playing' && ps ? (
              <>
                <View style={s.statusRow}>
                  <Text style={[s.statusText, userToMove(ps, userColor) ? { color: colors.gold } : null]}>
                    {userToMove(ps, userColor) ? `● Your move (${userColor === 'w' ? 'White' : 'Black'})` : '○ Opponent thinking…'}
                  </Text>
                  <View style={s.statusActions}>
                    {ps.mistakes > 0 ? (
                      <View style={s.mistakeRow}>
                        <IconX size={11} color={colors.bad} />
                        <Text style={s.mistakeText}>{ps.mistakes} mistake{ps.mistakes > 1 ? 's' : ''}</Text>
                      </View>
                    ) : null}
                    {status === 'playing' && userToMove(ps, userColor) ? (
                      <Pressable onPress={() => showHintFor(ps)} style={s.hintBtn}>
                        <IconLightbulb size={12} color={colors.gold} />
                        <Text style={s.hintText}>Hint</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={showSolution} style={s.showLineBtn}>
                      <IconEye size={12} color={colors.mutedForeground} />
                      <Text style={[s.hintText, { color: colors.mutedForeground }]}>Show line</Text>
                    </Pressable>
                  </View>
                </View>
                {comment ? (
                  <Text style={[s.body, { lineHeight: 17 }]} numberOfLines={4}>
                    <Text style={{ color: colors.chessforge, fontWeight: '500' }}>Coach: </Text>{comment}
                  </Text>
                ) : (
                  <Text style={[s.body, { opacity: 0.6, lineHeight: 17 }]}>
                    {expected ? `Play the book move for ${userColor === 'w' ? 'White' : 'Black'}.` : 'Watch the opponent…'}
                  </Text>
                )}
              </>
            ) : null}
          </Card>

          {/* Move list (played moves only — no spoilers) */}
          <Card style={{ padding: 8 }}>
            <MoveList sans={ps ? ps.sans.slice(0, ps.moveIndex) : []} currentPly={ps?.moveIndex ?? 0} />
          </Card>
        </ScrollView>
      ) : null}

      {/* Line-complete interstitial */}
      <Modal visible={status === 'lineDone' && !!ps} transparent animationType="fade" onRequestClose={() => setStatus('playing')}>
        <View style={s.modalBackdrop}>
          <Card style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: 4 }}>
            {(() => {
              const r = lineResults[lineResults.length - 1];
              const perfect = r?.perfect;
              return (
                <>
                  <View style={[s.resultIcon, perfect ? { backgroundColor: 'rgba(212,175,55,0.15)' } : { backgroundColor: 'rgba(46,139,106,0.15)' }]}>
                    {perfect ? <IconTrophy size={26} color={colors.gold} /> : <IconCheckCircle size={26} color={colors.primary} />}
                  </View>
                  <Text style={s.h1}>{perfect ? 'Perfect run!' : 'Line complete'}</Text>
                  <Text style={[s.bodySm, { textAlign: 'center' }]}>
                    {perfect
                      ? `No mistakes — mastery +20% · +${r?.xp ?? 0} XP`
                      : r && r.mistakes > 0
                        ? `${r.mistakes} mistake${r.mistakes > 1 ? 's' : ''} · repeat this line until it's automatic`
                        : 'Watched line — replay it from memory to earn mastery'}
                  </Text>
                  <View style={[s.row2, { marginTop: 16 }]}>
                    <Btn label="Replay" variant="ghost" onPress={() => ps && startLine(ps.line)} style={{ flex: 1 }} />
                    {hasNextLine || nextStudy ? (
                      <Btn
                        label={hasNextLine ? 'Next line' : 'Next study'}
                        onPress={hasNextLine ? nextLine : jumpToNextStudy}
                        style={{ flex: 1 }}
                      />
                    ) : (
                      <Btn label="Finish" onPress={nextLine} style={{ flex: 1 }} />
                    )}
                  </View>
                </>
              );
            })()}
          </Card>
        </View>
      </Modal>

      {/* Session summary */}
      {status === 'sessionDone' ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingTop: 24 }}>
          <Card style={{ alignItems: 'center', gap: 4 }}>
            <View style={s.sessionIcon}>
              <IconSparkles size={28} color={colors.gold} />
            </View>
            <Text style={s.h1}>Session complete</Text>
            <Text style={s.bodySm}>
              {lineResults.length} line{lineResults.length === 1 ? '' : 's'} · {sessionAccuracy}% first-try accuracy · +{sessionXp} XP
            </Text>
            {levelUpTo ? (
              <View style={s.levelUpBadge}>
                <IconTrophy size={13} color={colors.gold} />
                <Text style={s.levelUpText}>Level up — {LEVELS[levelUpTo - 1].name} unlocked!</Text>
              </View>
            ) : null}
            <View style={{ alignSelf: 'stretch', gap: 6, marginTop: 12 }}>
              {lineResults.map((r, i) => (
                <View key={r.lineId} style={s.lineResultRow}>
                  <Text style={s.bodySm}>Line {i + 1}{r.isVariation ? ' (variation)' : ''}</Text>
                  <View style={s.lineResultRight}>
                    {r.perfect ? (
                      <View style={s.mistakeRow}>
                        <IconTrophy size={11} color={colors.gold} />
                        <Text style={[s.bodySm, { color: colors.gold }]}>perfect</Text>
                      </View>
                    ) : (
                      <Text style={[s.bodySm, { color: colors.bad }]}>{r.mistakes} ✗</Text>
                    )}
                    <Text style={[s.bodySm, { color: 'rgba(212,175,55,0.8)' }]}>+{r.xp}</Text>
                  </View>
                </View>
              ))}
            </View>
            <View style={{ alignSelf: 'stretch', gap: 8, marginTop: 20 }}>
              {nextStudy ? (
                <Btn label={`Next study: ${nextStudy.title.replace(/^Study [\d.]+ — /, '')}`} onPress={jumpToNextStudy} />
              ) : null}
              <View style={s.row2}>
                <Btn label="Done" variant="ghost" onPress={onExit} style={{ flex: 1 }} />
                <Btn label="Practice again" onPress={() => startSession(level)} style={{ flex: 1 }} />
              </View>
            </View>
            <Text style={[s.bodySm, { opacity: 0.7, marginTop: 12, textAlign: 'center' }]}>
              Tip: zero-mistake runs are what raise mastery and schedule reviews further into the future.
            </Text>
          </Card>
        </ScrollView>
      ) : null}

      {/* start line guard */}
      {status === 'playing' && ps && ps.moveIndex === 0 && session.length === 0 ? (
        <Text style={[s.body, { textAlign: 'center', padding: 32 }]}>No trainable lines at this level.</Text>
      ) : null}
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  backBtn: { padding: 6, borderRadius: 999 },
  topTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },
  levelChip: {
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, paddingHorizontal: 8, paddingVertical: 6,
  },
  levelChipActive: { borderColor: 'rgba(212,175,55,0.5)', backgroundColor: 'rgba(212,175,55,0.1)' },
  levelChipText: { fontSize: 11, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },

  boardRow: { flexDirection: 'row', gap: 6, alignItems: 'stretch' },

  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  statusText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },
  statusActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mistakeRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  mistakeText: { fontSize: 11, color: colors.bad, fontFamily: fonts.sans },
  hintBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  hintText: { fontSize: 11, color: colors.gold, fontFamily: fonts.sans },
  showLineBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },

  introHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },

  modalBackdrop: {
    flex: 1, backgroundColor: colors.scrim,
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  resultIcon: { width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  sessionIcon: {
    width: 64, height: 64, borderRadius: 20,
    backgroundColor: 'rgba(212,175,55,0.25)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
  },
  levelUpBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12,
    backgroundColor: 'rgba(212,175,55,0.15)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)',
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6,
  },
  levelUpText: { fontSize: 12, fontWeight: '600', color: colors.gold, fontFamily: fonts.sansSemiBold },
  lineResultRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.subtleFill, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
  },
  lineResultRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row2: { flexDirection: 'row', gap: 8 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  goldLink: { color: colors.gold, textDecorationLine: 'underline', fontFamily: fonts.sans },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
