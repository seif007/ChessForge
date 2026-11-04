'use client';

/**
 * Course screen — RN port of the web `screens/CourseScreen.tsx`.
 * Guided walkthrough of every line: gold arrow = your move, sky = opponent.
 * Deviation mode lets you explore freely; live Stockfish evals + best-move
 * (pink arrow) come from the WebView engine. Transpositions snap you back.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import type { Repertoire, RepStudy, TrainLine } from '@/lib/repertoire';
import { LEVELS, commentForPly, fenAtPly, fenKey, linesForLevel, removePrefixLines, replayLine } from '@/lib/repertoire';
import { findStudyWithOpening, studyUserColor } from '@/lib/openings';
import { buildDecisionIndex, decisionAt, type YourDecision } from '@/lib/yourOpenings';
import { loadActiveUsername } from '@/lib/lichessStore';
import { loadCachedPositions } from '@/lib/lichessStore';
import { Chess } from 'chess.js';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { DriftBadge } from '@/components/chess/DriftBadge';
import { MoveList } from '@/components/chess/MoveList';
import { EvalBar, evalLabel } from '@/components/chess/EvalBar';
import { evalCpWhite, hasCachedEval } from '@/lib/evals';
import { getEngine, uciToSan } from '@/lib/engine';
import { playMoveSound, playEffect } from '@/lib/sounds';
import { Card, Bar, Btn } from '@/components/ui/Primitives';
import {
  IconArrowLeft, IconChevronsLeft, IconChevronLeft, IconChevronRight,
  IconBookOpen, IconGraduationCap, IconCheckCircle, IconCompass, IconUndo,
  IconDumbbell, IconActivity, IconNavigation, IconChevronDown,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';

/**
 * Board arrow colours, aliased to the shared palette so the meaning is fixed in
 * one place (see `arrowColors` in theme/tokens). Local names keep the call
 * sites in this file readable: GOLD is the move we want *you* to play, SKY is
 * the scripted opponent reply, REPLY is the engine answering an idea you
 * invented while off the line.
 *
 * The third was named after the old brand's pink. It is `REPLY` now because that is what the
 * arrow means; naming a colour after a brand tells the reader nothing about it.
 */
const GOLD = arrowColors.hint;
const SKY = arrowColors.book;
const REPLY = arrowColors.reply;

/**
 * How long the opponent's move waits before playing itself.
 *
 * Long enough to have read the position he has just changed, short enough that a course does
 * not feel like a slideshow with a timer. It matches the Train screen's opponent delay, so the
 * two feel like the same app.
 */
const OPPONENT_AUTO_MS = 650;

interface Deviation {
  basePly: number;   // course ply where the user left the line
  sans: string[];    // moves played since (free exploration, either side)
}

/** White-POV centipawns for a side-to-move-POV score + position turn. */
function toWhiteCp(scoreCp: number | null, mateIn: number | null, turn: 'w' | 'b'): number | null {
  let cp: number | null = null;
  if (scoreCp != null) cp = scoreCp;
  else if (mateIn != null) cp = mateIn > 0 ? 10000 - 10 * mateIn : -10000 - 10 * mateIn;
  if (cp == null) return null;
  return turn === 'w' ? cp : -cp;
}

/** Short verdict phrase for a white-POV eval. */
function evalVerdict(cp: number): string {
  if (cp >= 9700) return 'White has a forced mate';
  if (cp <= -9700) return 'Black has a forced mate';
  if (cp >= 300) return 'White is winning';
  if (cp <= -300) return 'Black is winning';
  if (cp >= 120) return 'White stands better';
  if (cp <= -120) return 'Black stands better';
  if (cp >= 40) return 'White is slightly better';
  if (cp <= -40) return 'Black is slightly better';
  return 'Roughly balanced';
}

/**
 * The from+to part of a UCI move.
 *
 * UCI carries a promotion suffix in a fifth character (`e7e8q`), and comparing a full five-character
 * UCI against a four-character `from + to` would call the user's pawn promotion a different move from
 * the line's - so a promotion the line also recommends would be drawn as two arrows and reported as a
 * disagreement. Promotion is the only move UCI longer than four characters, so this is exact.
 */
const stripNth = (uci: string) => uci.slice(0, 4);

export function CourseScreen({ studyId, origin = 'all', onExit, onOpenStudy, onPractice }: {
  studyId: string;
  /**
   * WHICH TAB OPENED THIS COURSE. `'all'` is All Openings, `'mine'` is Your Openings.
   *
   * THE REPORT: *"showing the moves and choices of user is only in your openings not all
   * openings"*, after finding this screen showing them from All Openings.
   *
   * Both tabs land here, so the screen has to be told. Default `'all'` because a course opened
   * without saying where from is not evidence of permission to read the user's games - and the
   * complaint was precisely that it assumed.
   */
  origin?: 'all' | 'mine';
  onExit: () => void;
  onOpenStudy?: (studyId: string) => void;
  onPractice?: (studyId: string) => void;
}) {
  /** THE ONE RULE: your own moves and choices are shown in YOUR openings, and nowhere else. */
  const showYourMoves = origin === 'mine';
  const hit = useMemo(() => findStudyWithOpening(studyId), [studyId]);
  const study = hit?.study as RepStudy | undefined;
  const userColor: 'w' | 'b' = hit?.entry.side === 'white' ? 'w' : 'b';
  const userMod = userColor === 'b' ? 1 : 0;
  const opponentName = userColor === 'w' ? 'Black' : 'White';

  const nextStudy = useMemo(() => {
    const rep = hit?.entry.repertoire as Repertoire | null | undefined;
    if (!rep) return null;
    const flat = rep.chapters.flatMap((c) => c.studies);
    const idx = flat.findIndex((x) => x.id === studyId);
    return idx >= 0 && idx + 1 < flat.length ? flat[idx + 1] : null;
  }, [studyId, hit]);

  // Full-depth lines (course shows the complete picture, all branches included)
  const lines = useMemo(
    () => (study ? removePrefixLines(linesForLevel(study, LEVELS[LEVELS.length - 1])) : []),
    [study],
  );

  const [lineIdx, setLineIdx] = useState(0);
  const [ply, setPly] = useState(0);
  const [deviation, setDeviation] = useState<Deviation | null>(null);

  /*
   * WHICH COLOUR THE USER PLAYS IN THIS COURSE.
   *
   * A decision belongs to the side that had to move, so without a colour the index cannot be read
   * safely: every second ply in the user's own games holds the OPPONENT's move, and a lookup that
   * ignored colour would report the opponent's reply as "you played this". `studyUserColor` is the
   * function the registry already exposes for this, so the course does not derive its own colour
   * from the ply parity it happens to be displaying at the moment.
   */
  const userSide: 'w' | 'b' = studyUserColor(studyId);

  /*
   * THE USER'S OWN DECISIONS, LOADED ONCE.
   *
   * From the cached positions the openings screen writes, NOT from a fresh fetch: this is a course,
   * and re-analysing the user's games to decorate a line the user is reading would stall the screen
   * on network and engine work for something that is already known. Absent a cache the index is
   * null, `decisionAt` returns null, and the course is exactly what it was - a line with one arrow -
   * which is the right behaviour when we do not know anything about the user's games.
   */
  /*
   * FROM ALL OPENINGS THIS DOES NOT LOAD AT ALL, AND THAT IS THE FIX.
   *
   * THE REPORT: *"i tried 'all openings' not 'your openings' and i found out that you changed its
   * behaviour to be like 'your openings' while i specifically told you to not touch it. (showing the
   * moves and choices of user is only in your openings not all openings)"*.
   *
   * Gating only the ARROWS was not enough, and this is why. The index was still read off disk and
   * still built on every open, so All Openings was still reading the user's analysed games to
   * decorate a line the user was simply reading; and a decision that is computed but not drawn is
   * not a fixed feature, it is a feature waiting for one missed condition. So the work is not done
   * unless it was asked for.
   *
   * The guard is on the LOAD, not on the render, so the screen does not even read the cache from
   * All Openings - and `decisionAt` below receives null and returns null, which is the same course it
   * was before any of this was added.
   */
  const [yourDecisions, setYourDecisions] = useState<Map<string, YourDecision> | null>(null);
  useEffect(() => {
    if (!showYourMoves) return;
    let cancelled = false;
    (async () => {
      try {
        const name = await loadActiveUsername();
        if (!name) return;
        const cached = await loadCachedPositions(name);
        if (cancelled || !cached) return;
        setYourDecisions(buildDecisionIndex(cached.positions, fenKey));
      } catch { /* no cache, no decisions; the course still works */ }
    })();
    return () => { cancelled = true; };
  }, [showYourMoves]);
  const [snapNote, setSnapNote] = useState<string | null>(null);
  const [explore, setExplore] = useState<{ fen: string; cp: number } | null>(null);
  const [exploreBest, setExploreBest] = useState<{ fen: string; uci: string } | null>(null);

  const line: TrainLine | undefined = lines[lineIdx];
  const lineLen = line?.sans.length ?? 0;

  // Clear the transposition note after a moment
  useEffect(() => {
    if (!snapNote) return;
    const t = setTimeout(() => setSnapNote(null), 3500);
    return () => clearTimeout(t);
  }, [snapNote]);

  /**
   * The whole line replayed ONCE. Everything below reads a prefix out of this
   * instead of rebuilding a `Chess` per derived value — see `replayLine` in
   * lib/repertoire for why that matters (it is the difference between an
   * instant board and a visibly laggy one on every move).
   */
  const replay = useMemo(() => (line ? replayLine(line.sans) : null), [line]);

  /**
   * Position after `ply` moves + preview of the next move (for the arrow).
   *
   * Both come straight out of the single replay — no `new Chess(fen)` here. That
   * probe used to run on EVERY ply change just to learn one move's from/to/san,
   * and it was the dominant cost of a step (~5.8 ms of the ~6 ms render, measured
   * in `.bench/bench_course.js`). `replay.moves[ply]` already holds it.
   */
  const view = useMemo(() => {
    if (!line || !replay) return null;
    const fen = fenAtPly(replay, ply);
    const mv = ply < replay.moves.length ? replay.moves[ply] : null;
    const next = mv && mv.from ? { san: mv.san, from: mv.from, to: mv.to } : null;
    return { fen, next };
  }, [line, replay, ply]);

  // FEN key after every course prefix — for transposition detection.
  // Derived from `replay` (no second replay), and memoised on its own so the
  // deviation path can index it without recomputing.
  const courseFenKeys = useMemo(
    () => (replay ? replay.plies.map(fenKey) : []),
    [replay],
  );

  /**
   * The exploration we are currently showing: `basePly` course moves followed by
   * the free `deviation.sans`, replayed in one pass.
   *
   * `progressKey` lets the live-eval effect tell "same position, new render"
   * apart from "a genuinely new position to analyse", so it stops re-launching
   * a 420ms engine search on every unrelated re-render.
   *
   * While `deviation` is set this can never be null: `deviation` is only ever
   * created from `handleMove`, which requires a live `line`. If it somehow were,
   * `shownFen` below would fall back to the *course* position and the board
   * would appear to reject the very move that started the exploration.
   */
  const dev = useMemo(() => {
    if (!line || !deviation) return null;
    const base = [...line.sans.slice(0, deviation.basePly), ...deviation.sans];
    const r = replayLine(base);
    const last = r.moves.length ? r.moves[r.moves.length - 1] : null;
    return {
      fen: r.plies[r.plies.length - 1],
      lastMove: last && last.from ? last : null,
      progressKey: `${deviation.basePly}|${deviation.sans.join(' ')}`,
    };
  }, [line, deviation]);

  const lastMove = useMemo(() => {
    if (!replay || ply === 0) return null;
    const m = replay.moves[ply - 1];
    return m && m.from ? m : null;
  }, [replay, ply]);

  // Book eval of the position the user left (all course positions are cached).
  const bookCp = useMemo(() => {
    if (!replay || !deviation) return null;
    return evalCpWhite(fenAtPly(replay, deviation.basePly));
  }, [replay, deviation]);

  // ----- LIVE engine eval + best move of the off-course position -----
  const devFen = dev?.fen ?? null;
  const devProgressKey = dev?.progressKey ?? null;
  useEffect(() => {
    if (!devProgressKey || !devFen) return;
    const fen = devFen;
    let cancelled = false;
    const turn = (fen.split(' ')[1] === 'b' ? 'b' : 'w') as 'w' | 'b';
    (async () => {
      try {
        const engine = getEngine();
        const res = await engine.analyse(fen, {
          movetime: 420,
          onInfo: (ev) => {
            if (cancelled || ev.depth < 8) return;
            const cp = toWhiteCp(ev.scoreCp, ev.mateIn, turn);
            if (cp != null) setExplore({ fen, cp });
            if (ev.bestMoveUci) setExploreBest({ fen, uci: ev.bestMoveUci });
          },
        });
        if (cancelled) return;
        const cp = toWhiteCp(res.scoreCp, res.mateIn, turn);
        if (cp != null) setExplore({ fen, cp });
        const uci = res.bestMoveUci && res.bestMoveUci !== '(none)' ? res.bestMoveUci : null;
        if (uci) setExploreBest({ fen, uci });
      } catch { /* engine unavailable — bar keeps the last known value */ }
    })();
    return () => { cancelled = true; };
    // Keyed on the exploration PROGRESS, not the `deviation` object identity:
    // re-rendering for an unrelated reason must not restart a 420ms search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devProgressKey]);

  const cacheCp = deviation && devFen && hasCachedEval(devFen) ? evalCpWhite(devFen) : null;
  const liveCp = cacheCp ?? (deviation && explore && devFen === explore.fen ? explore.cp : null);
  // true while an off-book position is still being analysed (bar dims meanwhile)
  const analyseBusy = !!deviation && liveCp == null;

  const shownLastMove = deviation ? dev?.lastMove ?? null : lastMove;
  const shownFen = (deviation ? dev?.fen ?? view?.fen : view?.fen) ?? null;

  // engine's best move while exploring: SAN for the banner chip + the arrow
  const best = useMemo(() => {
    if (!deviation || !devFen || !exploreBest || exploreBest.fen !== devFen) return null;
    const uci = exploreBest.uci;
    return {
      san: uciToSan(devFen, uci),
      arrow: { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color: REPLY } as BoardArrow,
    };
  }, [deviation, devFen, exploreBest]);

  /*
   * WHAT THE USER ACTUALLY PLAYED AT THIS POSITION, AND WHAT TO PLAY INSTEAD.
   *
   * THE REPORT: *"when i go to another line in the same opening in course mode there is no arrows
   * (neither my choice or the app choice)"*.
   *
   * The course drew exactly one arrow - the line's own next move - and had no way to draw the other
   * one, because `StudyLine` is a bare SAN array: it carries no position, no game, and no opinion
   * about anything. That was not a bug in the arrow code. It was the shape of the data, and the
   * arrow code was doing exactly the only thing the shape allowed.
   *
   * So the user's own decisions are now indexed BY POSITION (see `buildDecisionIndex`) and joined to
   * the course prefix by FEN. A decision belongs to a position, not to a line: the position is
   * reached by several of the user's games and by this course line, none of which share a move
   * order, so a line index could never answer the question being asked.
   *
   * `deviation` deliberately keeps its single engine arrow. Once the user has left the course he is
   * exploring, not being told what he used to play, and mixing the two would put a red arrow on the
   * board for a position the user has not finished thinking about.
   */
  /*
   * A DECISION IS ONLY SHOWN FROM THE SECOND MOVE PAIR ON.
   *
   * The first two plies are the same position in every game the user has ever played, and the
   * position after one move each is shared by every game that opened the same way. A decision read
   * there is the user's most common first move - `e4` for most people - and showing it against a
   * Queen's Gambit course that plays `d4` would teach that the Queen's Gambit starts with a move that
   * cannot reach it. The line it opens has not been identified yet at ply 1, so a note about it is
   * an observation about every game, not about this opening.
   *
   * From ply 2 the position belongs to a specific opening, the user's move there was a decision about
   * that opening, and both arrows mean what they look like they mean.
   */
  const yourMove = useMemo(() => (
    // 'all' short-circuits HERE as well as at the load. Two gates because there are two things to
    // get wrong: not reading the user's games, and not drawing them. One without the other leaves a
    // screen that behaves correctly today and not after someone reorders the code.
    showYourMoves
      ? decisionAt(
        yourDecisions,
        deviation || ply < 2 ? null : view?.fen,
        fenKey,
        (view?.fen?.split(' ')[1] as 'w' | 'b') ?? null,
        userSide,
      )
      : null
  ), [showYourMoves, yourDecisions, view?.fen, deviation, ply, userSide]);

  const arrows: BoardArrow[] = useMemo(() => {
    /*
     * A DEVIATION SHOWS BOTH MOVES: WHAT WAS PLAYED, AND WHAT THE LINE WANTS.
     *
     * THE REPORT: *"when i make a mistake it still doesnt show me red arrow for my move and an arrow
     * for the correct move"*.
     *
     * This returned only `best.arrow` — the engine's suggestion — so a player who had left the line
     * was shown what to do and nothing about what they had just done. The mistake arrow existed on
     * this screen already; it was simply not reached on this path, which is the one path where a
     * mistake is what happened.
     *
     * `deviation.sans[0]` is the move that was actually played, from the position before the
     * deviation. It is replayed to get its squares rather than parsed, because the line is stored
     * as SAN and a SAN read back into squares by hand is a guess.
     */
    if (deviation) {
      if (!best) return [];
      if (!deviation.sans.length || !view?.fen) return [best.arrow];
      try {
        const probe = new Chess(view.fen);
        const played = probe.move(deviation.sans[0]);
        const playedUci = played ? played.from + played.to + (played.promotion ?? '') : null;
        if (!playedUci) return [best.arrow];
        // One arrow when it IS the move that was suggested - there is no disagreement to show.
        if (stripNth(playedUci) === stripNth(best.arrow.startSquare + best.arrow.endSquare)) {
          return [best.arrow];
        }
        return [
          {
            startSquare: playedUci.slice(0, 2),
            endSquare: playedUci.slice(2, 4),
            color: colors.bad,
          },
          best.arrow,
        ];
      } catch {
        return [best.arrow];
      }
    }
    if (!view?.next) return [];
    const isUserMove = ply % 2 === userMod;
    const lineArrow: BoardArrow = {
      startSquare: view.next.from, endSquare: view.next.to, color: isUserMove ? GOLD : SKY,
    };
    /*
     * TWO ARROWS ONLY WHERE THERE REALLY ARE TWO MOVES.
     *
     * When the move the user played IS the move the line plays there is one move and one arrow;
     * drawing a red arrow on top of a gold one for the same two squares would be showing a
     * disagreement that does not exist - and the user's report about arrows that are not there
     * would be answered with arrows that mean nothing.
     */
    if (!isUserMove || !yourMove) return [lineArrow];
    const sameMove = stripNth(yourMove.playedUci) === stripNth(view.next.from + view.next.to);
    if (sameMove) return [lineArrow];
    return [
      { startSquare: yourMove.playedUci.slice(0, 2), endSquare: yourMove.playedUci.slice(2, 4), color: colors.bad },
      lineArrow,
    ];
  }, [view, ply, userMod, deviation, best, yourMove]);

  const coachNote = useMemo(() => {
    if (deviation) return null;
    if (!study || !line) return null;
    if (ply === 0) return study.intro ?? null;
    return commentForPly(study, line.sans, ply - 1);
  }, [study, line, ply, deviation]);

  const lineDone = !!line && ply >= lineLen;

  const goToPly = useCallback((p: number) => {
    setPly((prev) => Math.max(0, Math.min(lineLen, p ?? prev)));
  }, [lineLen]);

  const backToCourse = useCallback(() => {
    if (!deviation) return;
    setPly(deviation.basePly);
    setDeviation(null);
  }, [deviation]);

  const playNext = useCallback(() => {
    if (!line || !view || ply >= line.sans.length) return;
    try {
      const probe = new Chess(view.fen);
      playMoveSound(probe.move(line.sans[ply]));
    } catch { /* verified data */ }
    setPly((p) => p + 1);
  }, [line, ply, view]);

  /*
   * THE OPPONENT PLAYS ITSELF.
   *
   * THE USER REPORTED: *"in the openings of the app, when i am in the course i want the moves
   * of the opponent to be played automatically, not until i click next or move the piece. I
   * only move my pieces or click on next to my pieces."*
   *
   * The course was a film the user had to operate: after every one of his own moves the screen
   * sat at "○ London System plays Nf6" until he pressed the forward button. Half the clicks in
   * the course were moving the opponent for it, and the one thing that distinguishes his move
   * from the demonstration was the one thing he could not skip.
   *
   * So an opponent ply now advances on its own, after a beat long enough to read the position.
   * It stops for three things, each of which would be wrong to animate past:
   *
   *   - it is the USER's ply. That is the whole interaction; waiting is the point.
   *   - a DEVIATION is in progress. Once he has left the script, the script is not running
   *     any more, and advancing `ply` would yank the board out from under his own moves.
   *   - the line has ended. `ply >= sans.length` is the finished state, and the screen has
   *     its own text for it.
   *
   * The forward and back buttons still work exactly as before, so stepping through a line
   * without waiting is still possible - this only stops the opponent being a chore.
   */
  useEffect(() => {
    if (deviation) return;
    if (!line || !view) return;
    if (ply >= line.sans.length) return;
    if (ply % 2 === userMod) return;      // his move: wait for him
    const t = setTimeout(() => {
      try {
        const probe = new Chess(view.fen);
        playMoveSound(probe.move(line.sans[ply]));
      } catch { /* verified data */ }
      setPly((p) => p + 1);
    }, OPPONENT_AUTO_MS);
    return () => clearTimeout(t);
  }, [deviation, line, view, ply, userMod]);

  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!line || !shownFen) return false;
    const c = new Chess(shownFen);
    let m;
    try {
      m = c.move({ from, to, promotion: promotion ?? 'q' });
    } catch {
      return false; // illegal move — board rejects it
    }

    // ----- exploring: accept everything, watch for transpositions -----
    if (deviation) {
      playMoveSound(m);
      const k = fenKey(c.fen());
      /*
       * Transposition snap: did the free move land back on a course position?
       *
       * Scanning backwards from the end means the *deepest* match wins, which is
       * what "you are back on the line" should mean. `courseFenKeys` comes
       * straight off the single replay, so this is a string compare per ply
       * rather than four chess.js replays.
       */
      let snap = -1;
      for (let p = courseFenKeys.length - 1; p >= deviation.basePly; p--) {
        if (courseFenKeys[p] === k) { snap = p; break; }
      }
      if (snap >= 0) {
        setDeviation(null);
        setPly(snap);
        setSnapNote(`Transposed back onto the course after ${m.san} — you are on line ${lineIdx + 1} again.`);
        playEffect('success');
      } else {
        setDeviation({ ...deviation, sans: [...deviation.sans, m.san] });
      }
      return true;
    }

    // ----- on course: the booked move advances; any other LEGAL move starts exploration -----
    const strip = (x: string) => x.replace(/[+#]/g, '');
    if (view?.next && strip(m.san) === strip(view.next.san)) {
      playMoveSound(m);
      setPly((p) => p + 1);
      return true;
    }

    playMoveSound(m);
    setDeviation({ basePly: ply, sans: [m.san] });
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, shownFen, view, ply, deviation, courseFenKeys, lineIdx]);

  const changeLine = (idx: number) => {
    setDeviation(null);
    setSnapNote(null);
    setLineIdx(idx);
    setPly(0);
  };

  if (!study || !line || !view) {
    return (
      <View style={s.center}>
        <Text style={s.body}>Study not found.</Text>
        <Pressable onPress={onExit}><Text style={s.goldLink}>Back</Text></Pressable>
      </View>
    );
  }

  const nextIsUser = ply % 2 === userMod;
  const leftAt = deviation
    ? deviation.basePly === 0
      ? 'the start'
      : `after ${Math.ceil(deviation.basePly / 2)}${deviation.basePly % 2 ? '.' : '...'} ${line.sans[deviation.basePly - 1]}`
    : '';

  // Move list while exploring: course prefix + the exploration moves
  const listSans = deviation ? [...line.sans.slice(0, deviation.basePly), ...deviation.sans] : line.sans;
  const listPly = deviation ? deviation.basePly + deviation.sans.length : ply;

  const handleJump = (targetPly: number) => {
    if (deviation) {
      if (targetPly <= deviation.basePly) {
        setDeviation(null);
        goToPly(targetPly);
      }
      return; // clicks on exploration moves do not navigate
    }
    goToPly(targetPly);
  };

  return (
    <View style={s.root}>
      {/* Top bar */}
      <View style={s.topBar}>
        <Pressable onPress={onExit} style={s.backBtn} accessibilityLabel="Back">
          <IconArrowLeft size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <View style={s.topTitleRow}>
            <IconGraduationCap size={14} color={colors.chessforge} />
            <Text style={s.topTitle} numberOfLines={1}>
              Course — {study.title.replace(/^Study [\d.]+ — /, '')}
            </Text>
          </View>
          <Text style={s.bodySm}>
            Line {lineIdx + 1}/{lines.length} · move {Math.min(ply, lineLen)}/{lineLen}
            {line.isVariation ? ' · variation' : ''}{deviation ? ' · exploring' : ''}
          </Text>
        </View>
      </View>
      <Bar pct={lineLen ? (deviation ? deviation.basePly : ply) / lineLen : 0} color={colors.chessforge} height={4} />

      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 12, gap: 12, paddingBottom: 32 }}>
        {/* Board + eval bar */}
        <View style={[s.boardWrap, deviation ? { borderWidth: 1, borderColor: 'rgba(251,191,36,0.5)', borderRadius: 12 } : null]}>
          <EvalBar
            cp={deviation ? (liveCp ?? bookCp ?? 0) : evalCpWhite(shownFen ?? view.fen)}
            flip={userColor === 'b'}
            dim={analyseBusy}
          />
          <View style={{ flex: 1 }}>
            <ChessForgeBoard
              fen={shownFen ?? view.fen}
              orientation={userColor === 'w' ? 'white' : 'black'}
              interactive
              onMove={handleMove}
              lastMove={shownLastMove}
              arrows={arrows}
            />
          </View>
        </View>

        {/* Deviation banner / snap note / coach note */}
        {deviation ? (
          <Card style={{ padding: 12, gap: 8 }}>
            <View style={s.devBannerRow}>
              <View style={{ flex: 1, gap: 4 }}>
                <View style={s.devTitleRow}>
                  <Text style={s.devTitle}>Off course — exploring</Text>
                  <Pressable onPress={backToCourse} style={s.backToCourseBtn}>
                    <IconUndo size={12} color="#fde68a" />
                    <Text style={s.backToCourseText}>Back to course</Text>
                  </Pressable>
                </View>
                <Text style={[s.bodySm, { lineHeight: 16 }]}>
                  You left the line {leftAt} and are {deviation.sans.length} move{deviation.sans.length > 1 ? 's' : ''} off book. Play freely for either side — the pink arrow is the engine's best idea here; if you reach a course position again, the app snaps you back in automatically.
                </Text>
                {/*
                  The shared "you are off the line" indicator. Kept identical to
                  Analysis and the Openings trainer so the state reads the same
                  wherever the user steps off the recorded line.
                */}
                <DriftBadge
                  state={{
                    drifting: true,
                    driftPly: deviation.basePly,
                    bookMove: line.sans[deviation.basePly] ?? null,
                    playedMove: deviation.sans[0] ?? null,
                  }}
                />
                <View style={s.devChips}>
                  {liveCp != null ? (
                    <>
                      <View style={s.evalChip}>
                        <IconActivity size={10} color="#fde68a" />
                        <Text style={s.evalChipText}>{evalLabel(liveCp)}</Text>
                      </View>
                      <Text style={[s.bodySm, { color: 'rgba(253,230,138,0.8)', flex: 1 }]}>
                        {evalVerdict(liveCp)}
                        {bookCp != null && Math.abs(bookCp - liveCp) >= 40
                          ? ` — the book move kept ${evalLabel(bookCp)}`
                          : ''}
                      </Text>
                    </>
                  ) : (
                    <View style={s.devChips}>
                      <IconActivity size={10} color="rgba(253,230,138,0.6)" />
                      <Text style={[s.bodySm, { color: 'rgba(253,230,138,0.6)' }]}>engine checking this position…</Text>
                    </View>
                  )}
                  {best?.san ? (
                    <View style={s.bestChip}>
                      <IconNavigation size={10} color={colors.chessforge} />
                      <Text style={s.bestChipText}>best: {best.san}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          </Card>
        ) : snapNote ? (
          <Card style={{ padding: 12 }}>
            <View style={s.snapRow}>
              <IconCheckCircle size={16} color={colors.chessforge} />
              <Text style={[s.body, { color: colors.chessforge, lineHeight: 17 }]}>{snapNote}</Text>
            </View>
          </Card>
        ) : (
          <Card style={{ minHeight: 76 }}>
            <View style={s.statusRow}>
              <Text style={[s.statusText, !view.next ? { color: colors.chessforge } : nextIsUser ? { color: colors.gold } : { color: SKY }]}>
                {!view.next
                  ? '● Line complete — play on to explore, or continue'
                  : nextIsUser
                    ? `● Your move: ${view.next.san}`
                    : `○ ${opponentName} plays ${view.next.san}`}
              </Text>
              <View style={s.courseTag}>
                <IconBookOpen size={11} color={colors.mutedForeground} />
                <Text style={s.bodySm}>course</Text>
              </View>
            </View>
            {/*
             * WHAT YOU PLAYED HERE, IN WORDS, BESIDE THE TWO ARROWS.
             *
             * The arrows were the request - "there is no arrows (neither my choice or the app
             * choice)" - and an arrow alone is not a lesson: two coloured lines on a board say that
             * two moves differ without saying which is which, or whether the difference is worth
             * anything. So the two are named, and the name follows the ENGINE rather than the
             * mismatch: a position the user left is not by itself an error, and calling 2.e3 a
             * mistake against a line that plays 2.c4 is false.
             *
             * `verdict` is the only thing allowed to use the words below. Without it the sentence
             * states what was played and what the line plays, and stops there.
             */}
            {yourMove ? (
              <Text style={[s.body, { lineHeight: 17 }]} numberOfLines={6}>
                <Text style={{ color: colors.bad, fontWeight: '600' }}>
                  {yourMove.verdict === 'blunder' ? 'Blunder' : yourMove.verdict === 'mistake' ? 'Mistake' : 'Your move'}
                  {': '}
                </Text>
                <Text style={{ color: colors.foreground, fontWeight: '600' }}>{yourMove.playedSan}</Text>
                {'  '}
                {yourMove.verdict === 'blunder' || yourMove.verdict === 'mistake' ? (
                  <Text>
                    — you played this in your game
                    {yourMove.lossCp > 0 ? ` and it gave up ${Math.round(yourMove.lossCp / 100) || 1} pawn` : ''}.
                    {' '}This line plays{' '}
                    <Text style={{ color: colors.gold, fontWeight: '600' }}>{view?.next?.san}</Text>.
                  </Text>
                ) : yourMove.playedSan === view?.next?.san ? (
                  <Text>— the move this line plays too. This is your move, recognised.</Text>
                ) : (
                  <Text>
                    — you played this here. This line plays{' '}
                    <Text style={{ color: colors.gold, fontWeight: '600' }}>{view?.next?.san}</Text>.
                  </Text>
                )}
              </Text>
            ) : coachNote ? (
              <Text style={[s.body, { lineHeight: 17 }]} numberOfLines={5}>
                <Text style={{ color: colors.chessforge, fontWeight: '500' }}>Coach: </Text>{coachNote}
              </Text>
            ) : (
              <Text style={[s.body, { opacity: 0.6, lineHeight: 17 }]}>
                {view.next
                  ? 'Follow the arrow — play the move on the board or press Next to watch.'
                  : 'You have seen the whole line. Review it or continue to the next one.'}
              </Text>
            )}
          </Card>
        )}

        {/* Controls */}
        <View style={s.controlsRow}>
          <Pressable
            onPress={() => { if (deviation) { setDeviation(null); setSnapNote(null); } goToPly(0); }}
            disabled={ply === 0 && !deviation}
            style={[s.ctrlBtn, (ply === 0 && !deviation) ? { opacity: 0.3 } : null]}
            accessibilityLabel="Back to start"
          >
            <IconChevronsLeft size={17} color={colors.foreground} />
          </Pressable>
          <Pressable
            onPress={() => {
              if (deviation) {
                if (deviation.sans.length > 1) setDeviation({ ...deviation, sans: deviation.sans.slice(0, -1) });
                else backToCourse();
                return;
              }
              goToPly(ply - 1);
            }}
            disabled={ply === 0 && !deviation}
            style={[s.ctrlBtn, (ply === 0 && !deviation) ? { opacity: 0.3 } : null]}
            accessibilityLabel="Previous move"
          >
            <IconChevronLeft size={17} color={colors.foreground} />
          </Pressable>
          {deviation ? (
            <Btn label="Back to course" onPress={backToCourse} style={{ flex: 1 }} />
          ) : lineDone ? (
            (() => {
              const hasNextLine = lineIdx + 1 < lines.length;
              const toNextStudy = !hasNextLine && nextStudy && onOpenStudy;
              return (
                <Btn
                  label={hasNextLine ? 'Next line' : toNextStudy ? 'Next study' : 'Review line 1'}
                  onPress={() => {
                    if (hasNextLine) changeLine(lineIdx + 1);
                    else if (toNextStudy) onOpenStudy?.(nextStudy.id);
                    else changeLine(0);
                  }}
                  style={{ flex: 1 }}
                />
              );
            })()
          ) : (
            <Btn label="Next" onPress={playNext} style={{ flex: 1 }} />
          )}
          {onPractice ? (
            <Btn label="Practice" variant="gold" small onPress={() => onPractice(studyId)} />
          ) : null}
        </View>

        {/* Move list — tap any move to jump there */}
        <Card style={{ padding: 8 }}>
          {deviation ? (
            <View style={s.exploreNote}>
              <IconCompass size={10} color="rgba(252,211,77,0.9)" />
              <Text style={[s.bodySm, { color: 'rgba(252,211,77,0.9)' }]}>
                moves after {Math.ceil(deviation.basePly / 2)}{deviation.basePly % 2 ? '.' : '...'} are your exploration
              </Text>
            </View>
          ) : null}
          <MoveList
            sans={listSans}
            currentPly={listPly}
            onSelectPly={(p) => handleJump(p + 1)}
          />
        </Card>

        {/* Line picker (web <select> → horizontal chip row) */}
        <Card style={{ padding: 10, gap: 8 }}>
          <Text style={s.bodySm}>Jump to line</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {lines.map((l, i) => (
              <Pressable
                key={l.id}
                onPress={() => changeLine(i)}
                style={[s.levelChip, i === lineIdx ? s.levelChipActive : null]}
              >
                <Text style={[s.levelChipText, i === lineIdx ? { color: colors.gold } : null]}>
                  Line {i + 1} · {l.isVariation ? 'variation' : 'mainline'} · {Math.ceil(l.sans.length / 2)} moves
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </Card>
      </ScrollView>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 6, borderRadius: 999 },
  topTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold, flex: 1 },

  boardWrap: { flexDirection: 'row', gap: 6, alignItems: 'stretch', overflow: 'hidden' },

  devBannerRow: { flexDirection: 'row', gap: 8 },
  devTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  devTitle: { fontSize: 12, fontWeight: '600', color: colors.warnText, fontFamily: fonts.sansSemiBold, flex: 1 },
  backToCourseBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'rgba(251,191,36,0.4)', backgroundColor: 'rgba(251,191,36,0.1)',
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  backToCourseText: { fontSize: 11, fontWeight: '600', color: '#fde68a', fontFamily: fonts.sansSemiBold },
  devChips: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  evalChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.scrim, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  evalChipText: { fontSize: 11, fontWeight: '700', color: '#fde68a', fontFamily: fonts.sans },
  bestChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(232,143,162,0.15)', borderWidth: 1, borderColor: 'rgba(232,143,162,0.3)',
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  bestChipText: { fontSize: 11, fontWeight: '700', color: colors.chessforge, fontFamily: fonts.sans },

  snapRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  statusText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold, flex: 1 },
  courseTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  controlsRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  ctrlBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 12,
  },

  exploreNote: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingBottom: 4 },
  levelChip: {
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, paddingHorizontal: 8, paddingVertical: 6,
  },
  levelChipActive: { borderColor: 'rgba(212,175,55,0.5)', backgroundColor: 'rgba(212,175,55,0.1)' },
  levelChipText: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  goldLink: { color: colors.gold, textDecorationLine: 'underline', fontFamily: fonts.sans },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
