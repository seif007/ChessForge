'use client';

/**
 * Analysis screen — RN port of the web `screens/AnalysisScreen.tsx`.
 * PGN import → engine sweep of every position → move-by-move review with
 * classification badges, eval bar, exploration branches and an SVG eval graph
 * (the web's recharts AreaChart redrawn with react-native-svg).
 *
 * `POST /api/stats/game` becomes `store.saveGameStat()` (local SQLite).
 * PGN input uses a multiline TextInput; keyboard nav is replaced by on-screen
 * controls (Android has no arrow keys).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ScrollView, Switch,
} from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import Svg, { Polyline, Line as SvgLine, Polygon, Defs, Stop, LinearGradient, Path as SvgPath } from 'react-native-svg';
import { Chess, type Square, type Move } from 'chess.js';
import { turnOf } from '@/lib/fen';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { DriftBadge } from '@/components/chess/DriftBadge';
import { MoveList, type MarkerKind } from '@/components/chess/MoveList';
import { QualityBadge } from '@/components/chess/QualityBadge';
import { CoachPanel } from '@/components/CoachPanel';
import { EVAL_DARK, EVAL_LIGHT } from '@/components/chess/EvalBar';
import { getEngine, uciToSan, type EngineEval } from '@/lib/engine';
import { gameAccuracy, winPercent, analysisUsable } from '@/lib/accuracy';
import { classifyMove, QUALITY_META, KEY_KINDS, ACTIVE_KINDS, type QualityKind } from '@/lib/moveQuality';
import { bestCoverageAcrossOpenings } from '@/lib/openings';
import { useAppStore } from '@/lib/store';
import { Card, Bar, Btn, IconBtn } from '@/components/ui/Primitives';
import {
  IconLineChart, IconSearch, IconPlay, IconPause, IconRotateCcw,
  IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight,
  IconBookOpen, IconCompass, IconUndo, IconGauge,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';

/*
 * STRENGTH IS THE ACCURACY.
 *
 * A review is only as honest as the numbers it is given, and every label in it
 * is a difference between two of them. At 350ms a single-threaded WASM search
 * is still shallow enough that the same position can come back 60cp different
 * on the two searches either side of a quiet move — which registers as a real
 * expected-score loss and prints "mistake" on a perfectly good move. That is
 * the mechanism behind *"it is full of mistakes"*.
 *
 * These are the same four choices, with the thinking times raised so the eval
 * is stable rather than merely fast. Fast is still a quick pass; Balanced is the
 * default and now sits where the noise stops deciding the label.
 */
const DEPTHS = [
  { id: 'fast', name: 'Fast', movetime: 300, desc: 'Quick pass over every move' },
  { id: 'balanced', name: 'Balanced', movetime: 700, desc: 'Recommended — stable evals' },
  { id: 'deep', name: 'Deep', movetime: 1500, desc: 'Sharper evals, better best moves' },
  { id: 'max', name: 'Maximum', movetime: 3000, desc: 'Slowest, most reliable review' },
] as const;
type DepthId = (typeof DEPTHS)[number]['id'];

type KindCounts = Record<QualityKind, number>;

function zeroCounts(): KindCounts {
  return { brilliant: 0, great: 0, best: 0, excellent: 0, good: 0, book: 0, inaccuracy: 0, miss: 0, mistake: 0, blunder: 0 };
}

interface MoveAnalysis {
  ply: number;
  san: string;
  uci: string | null;
  mover: 'w' | 'b';
  fenBefore: string;
  fenAfter: string;
  cpBefore: number;
  cpAfter: number;
  bestMoveSan: string | null;
  bestMoveUci: string | null;
  /** Engine PV (UCI) for the position BEFORE the move — the coach narrates it. */
  pvUci: string[];
  kind: QualityKind;
  drop: number;
}

interface Report {
  white: string;
  black: string;
  result: string;
  /** The position the first SAN is played from. Standard for almost every PGN. */
  startFen: string;
  sans: string[];
  moves: MoveAnalysis[];
  accuracyWhite: number;
  accuracyBlack: number;
  counts: { w: KindCounts; b: KindCounts };
  openingName: string | null;
  openingLine: string | null;
  coveragePly: number;
  expectedNext: string[];
  totalPlies: number;
  depthName: string;
}

function cpToWhite(scoreCp: number | null, mateIn: number | null, turn: 'w' | 'b'): number {
  let cp: number;
  if (mateIn !== null) {
    if (mateIn === 0) {
      /*
       * `mate 0` means the side to move is ALREADY CHECKMATED. From that
       * side's point of view the score is -10000 for both colours; converting
       * it to White's point of view is the job of the return below.
       *
       * This used to be `turn === 'w' ? -10000 : 10000`, which is positive for
       * Black. After the final `turn === 'b'` negation that made a Black
       * checkmate look like a WHITE loss: a mating move at the end of a game
       * could be graded as a blunder and the accuracy of the last move was
       * destroyed. The checkmate belongs to the mover, not to the colour field.
       */
      cp = -10000;
    } else {
      cp = 10000 - Math.min(999, Math.abs(mateIn)) * 10;
      if (mateIn < 0) cp = -cp;
    }
  } else if (scoreCp !== null) {
    cp = scoreCp;
  } else {
    cp = 0;
  }
  return turn === 'w' ? cp : -cp;
}

/**
 * Engine evaluations for a position that is already over. Searching these is
 * both unnecessary and unreliable: Stockfish has no move to return, and a PGN's
 * final position can be checkmate, stalemate, or a rule draw. The board knows
 * the result, so state it directly.
 *
 * `mateIn: 0` is "the side to move is mated"; `cpToWhite` handles the sign.
 */
function terminalEval(fen: string): EngineEval | null {
  let board: Chess;
  try { board = new Chess(fen); } catch { return null; }
  if (!board.isGameOver()) return null;
  if (board.isCheckmate()) {
    return { bestMoveUci: null, scoreCp: null, mateIn: 0, depth: 0, pvUci: [] };
  }
  return { bestMoveUci: null, scoreCp: 0, mateIn: null, depth: 0, pvUci: [] };
}

function evalLabel(cp: number): string {
  if (cp >= 9700) return `#${Math.max(1, Math.round((10000 - cp) / 10))}`;
  if (cp <= -9700) return `#-${Math.max(1, Math.round((10000 + cp) / 10))}`;
  const v = cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resultForUser(resultHeader: string | undefined, color: 'w' | 'b'): 'win' | 'loss' | 'draw' | 'unknown' {
  if (resultHeader === '1-0') return color === 'w' ? 'win' : 'loss';
  if (resultHeader === '0-1') return color === 'b' ? 'win' : 'loss';
  if (resultHeader === '1/2-1/2') return 'draw';
  return 'unknown';
}

function deviationLabel(startFen: string, ply: number, san: string | null): string {
  return moveNumberLabel(startFen, ply, san ?? '?');
}

/**
 * Move number for a ply, relative to the game's actual starting position.
 *
 * `deviationLabel` is fine for the repertoire check, which only runs on
 * standard-start games, but the review's move caption must not print "1." for
 * a Black move from a `[FEN]` start. The FEN carries both the side to move and
 * the fullmove number, and those are the only two inputs needed.
 */
function moveNumberLabel(startFen: string, ply: number, san: string): string {
  const fields = startFen.split(' ');
  const startTurn: 'w' | 'b' = fields[1] === 'b' ? 'b' : 'w';
  const startFullmove = Number.parseInt(fields[5] ?? '1', 10) || 1;
  const offset = startTurn === 'w' ? ply : ply + 1;
  const whiteMoved = (startTurn === 'w') === (ply % 2 === 0);
  return `${startFullmove + Math.floor(offset / 2)}${whiteMoved ? '.' : '...'} ${san}`;
}

/** Vertical eval bar (white share = white winning chances). */
function EvalBarView({ cp, dim = false }: { cp: number; dim?: boolean }) {
  const whitePct = Math.max(3, Math.min(97, winPercent(cp)));
  return (
    <View style={[barStyles.column, dim ? { opacity: 0.5 } : null]}>
      <View style={barStyles.track}>
        <View style={[barStyles.fill, { height: `${whitePct}%`, bottom: 0 }]} />
      </View>
      <Text allowFontScaling={false} style={barStyles.label}>{evalLabel(cp)}</Text>
    </View>
  );
}

/** Compact per-player classification chips (only non-zero kinds). */
function KindChips({ counts }: { counts: KindCounts }) {
  // `ACTIVE_KINDS`, not a hand-written list: this was a second copy of the vocabulary, and it
  // is how a retired label keeps showing up after it has been retired everywhere else. A
  // previously-saved game can still have a non-zero `great` or `inaccuracy` count, and showing
  // one of those would be advertising a verdict this app no longer hands out.
  const shown = ACTIVE_KINDS.filter((k) => counts[k] > 0);
  if (shown.length === 0) {
    return <Text style={a.bodySm}>Clean game — nothing flagged</Text>;
  }
  return (
    <View style={a.chipsRow}>
      {shown.map((k) => (
        <View key={k} style={a.chip}>
          <QualityBadge kind={k} size={12} />
          <Text style={a.chipText}>{counts[k]}</Text>
        </View>
      ))}
    </View>
  );
}

/* ---------------- eval graph (recharts AreaChart → react-native-svg) ---------------- */

function EvalGraph({
  data,
  onPly,
  currentPly,
}: {
  data: { ply: number; cp: number; label: string }[];
  onPly: (ply: number) => void;
  currentPly: number;
}) {
  const W = 320;
  const H = 132;
  const PAD = 6;
  const MAX_CP = 800;

  const clamp = (cp: number) => Math.max(-MAX_CP, Math.min(MAX_CP, cp));
  const x = (i: number) => (data.length <= 1 ? W / 2 : PAD + (i / (data.length - 1)) * (W - 2 * PAD));
  const y = (cp: number) => PAD + ((MAX_CP - clamp(cp)) / (2 * MAX_CP)) * (H - 2 * PAD);

  const linePts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.cp).toFixed(1)}`).join(' ');
  // area polygon: line points + down to the midline + close
  const midY = H / 2;
  const areaPts = `${linePts} ${x(data.length - 1).toFixed(1)},${midY} ${x(0).toFixed(1)},${midY}`;

  const zeroIdx = data.findIndex((d) => d.ply === currentPly);

  return (
    <View>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="evalGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={arrowColors.hint} stopOpacity="0.5" />
            <Stop offset="1" stopColor={arrowColors.best} stopOpacity="0.05" />
          </LinearGradient>
        </Defs>
        <SvgLine x1={PAD} y1={midY} x2={W - PAD} y2={midY} stroke={colors.border} strokeWidth="1" strokeDasharray="3 3" />
        <Polygon points={areaPts} fill="url(#evalGrad)" />
        <Polyline points={linePts} fill="none" stroke={arrowColors.hint} strokeWidth="1.5" />
        {zeroIdx >= 0 ? (
          <SvgLine
            x1={x(zeroIdx)} y1={PAD} x2={x(zeroIdx)} y2={H - PAD}
            stroke="rgba(212,175,55,0.55)" strokeWidth="1.5"
          />
        ) : null}
      </Svg>
      {/* touch targets — one invisible Pressable per point */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {data.map((d, i) => (
          <Pressable
            key={d.ply}
            onPress={() => onPly(d.ply)}
            style={{
              position: 'absolute',
              left: (x(i) / W) * 100 - 100 / Math.max(1, data.length) / 2,
              top: 0,
              width: 100 / Math.max(1, data.length),
              height: H,
            }}
          />
        ))}
      </View>
    </View>
  );
}

/* ------------------------------- main screen ------------------------------- */

export function AnalysisScreen({
  initialPgn = null,
  onConsumeInitialPgn,
}: {
  /** A game handed over by another screen (the bot game-over card) — see the effect below. */
  initialPgn?: string | null;
  /** Called once `initialPgn` has been copied in, so it can never be offered twice. */
  onConsumeInitialPgn?: () => void;
} = {}) {
  const store = useAppStore();
  const [phase, setPhase] = useState<'input' | 'analyzing' | 'done'>('input');
  const [pgnText, setPgnText] = useState('');
  const [depth, setDepth] = useState<DepthId>('balanced');
  const [userColor, setUserColor] = useState<'w' | 'b'>('b');
  // null = auto-follow the side to move (see boardOrientation in the review).
  const [flipOverride, setFlipOverride] = useState<'white' | 'black' | null>(null);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewPly, setViewPly] = useState(0);      // position index along the game (0 = start)
  const [showBest, setShowBest] = useState(true);
  const [branch, setBranch] = useState<{ basePly: number; sans: string[] } | null>(null);
  const [branchEval, setBranchEval] = useState<EngineEval | null>(null);
  const [playing, setPlaying] = useState(false);
  const cancelRef = useRef(false);

  /*
   * A GAME BROUGHT HERE FROM ANOTHER SCREEN.
   *
   * The bot game's "Game review" button is the first caller: the game is over, the user asked to
   * review it properly, and "properly" means this page — the PGN in the box, a depth, and Analyze.
   * The text goes into the SAME box the user types into, so everything downstream (the depth
   * picker, the colour, the Analyze button's own validation) behaves exactly as if he had pasted
   * it himself.
   *
   * Consumed on arrival: the parent clears its copy so switching tabs and coming back does not
   * re-fill the box over whatever the user has typed or analysed since.
   */
  useEffect(() => {
    if (!initialPgn) return;
    setPgnText(initialPgn);
    setPhase('input');
    setError(null);
    onConsumeInitialPgn?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPgn]);

  const engine = getEngine();

  // persisted preferences
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await Storage.getItem('chessforge.analysis.depth.v1');
        if (alive && d && DEPTHS.some((x) => x.id === d)) setDepth(d as DepthId);
        const c = await Storage.getItem('chessforge.analysis.color.v1');
        if (alive && (c === 'w' || c === 'b')) setUserColor(c);
      } catch { /* private mode */ }
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => { void Storage.setItem('chessforge.analysis.depth.v1', depth).catch(() => {}); }, [depth]);
  useEffect(() => { void Storage.setItem('chessforge.analysis.color.v1', userColor).catch(() => {}); }, [userColor]);

  const analyze = useCallback(async () => {
    setError(null);
    const c = new Chess();
    let ok = true;
    try {
      c.loadPgn(pgnText.trim());
    } catch {
      ok = false;
    }
    if (!ok || c.history().length < 4) {
      setError('Could not read that PGN. Paste a game with at least 4 moves.');
      return;
    }
    const headers = c.getHeaders();
    const sans = c.history();

    /*
     * Replay from the PGN's own starting position when it has a FEN header.
     *
     * A normal game starts from the initial array, but `loadPgn` accepts a
     * `[FEN]`/`[SetUp]` pair and then `history()` is relative to that position.
     * Replaying those SANs from `new Chess()` would either throw or, worse,
     * produce FENs for a different game, so the engine would grade positions
     * the user never played. The fallback is the standard start for the
     * overwhelmingly common case.
     */
    let replay: Chess;
    try {
      replay = headers.FEN ? new Chess(headers.FEN) : new Chess();
    } catch {
      replay = new Chess();
    }
    const fens: string[] = [replay.fen()];
    const ucis: string[] = [];
    for (const san of sans) {
      let mv: Move | null = null;
      try { mv = replay.move(san); } catch { /* validated by history() */ }
      ucis.push(mv ? mv.from + mv.to + (mv.promotion ?? '') : '');
      fens.push(replay.fen());
    }

    setPhase('analyzing');
    setProgress(0);
    cancelRef.current = false;
    /*
     * AN ENGINE THAT IS NOT RUNNING ANSWERS EVERY SEARCH WITH NOTHING.
     *
     * A review built from null evaluations is not "a clean game" — it is a
     * review with no evidence, and it printed 100% for both players with the bar
     * pinned at 0.0. Pull the engine back up the same way the Stats scan does,
     * and refuse to analyse without it rather than publishing that.
     */
    if (!engine.isReady) engine.restart('retry from the game review');
    await engine.init();
    if (!engine.isReady) {
      setError(
        'The chess engine did not start, so this game cannot be reviewed. Tap Analyse again to '
        + 'restart it — everything else on this screen still works without it.',
      );
      setPhase('input');
      return;
    }
    const depthDef = DEPTHS.find((d) => d.id === depth) ?? DEPTHS[1];

    /*
     * Match against ALL registered repertoires first.
     *
     * The book index is keyed by SAN sequences from the standard initial array.
     * A PGN that starts from a `[FEN]` position can still contain SANs that
     * happen to look like an opening line, so matching it would name a book this
     * game never played and could badge moves as theory. Skip the match for
     * non-standard starts rather than lie about the opening.
     *
     * Only the first four FEN fields identify the position; the halfmove and
     * fullmove counters do not change which moves are legal.
     */
    const positionKey = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
    const standardStart = positionKey(fens[0]) === positionKey(new Chess().fen());
    const hit = standardStart ? bestCoverageAcrossOpenings(sans) : null;
    const bookPlies = hit?.coverage.matchedPly ?? 0;

    // Each unique position is evaluated once (n+1 evals). A terminal position
    // is not searched: the board already knows the result, and asking the
    // engine for a move in a checkmated position returns an empty eval that
    // used to be mistaken for "the position became equal".
    const evals: EngineEval[] = [];
    /*
     * A SYSTEMATIC FAILURE MUST NOT TAKE A MINUTE PER POSITION.
     *
     * When the engine is not answering, every search burns its own grace timeout
     * before returning nothing — a 40-move game would sit there for twenty
     * minutes and then print a perfect review. After two consecutive empty
     * answers the engine is restarted once; if the next answer is empty too, the
     * analysis stops and says so.
     */
    let emptyRun = 0;
    let restarted = false;
    for (let i = 0; i <= sans.length; i++) {
      if (cancelRef.current) { setPhase('input'); return; }
      const terminal = terminalEval(fens[i]);
      if (terminal) {
        evals.push(terminal);
        setProgress(Math.round(((i + 1) / (sans.length + 1)) * 100));
        continue;
      }
      /*
       * MultiPV 2, NOT 1, AND THIS IS THE ONLY REASON `brilliant` CAN BE TOLD FROM `best`.
       *
       * One line gives the engine's top choice and nothing about the runners-up, so the classifier
       * had no way to ask "is this the only move that wins?" — which is the whole meaning of a
       * brilliant sacrifice. It fell back to an eval-only heuristic and badged ordinary moves that
       * happened to give up material.
       *
       * `lines` is populated only when `multipv > 1`, and `engine.ts` documents that an ordinary
       * search resets MultiPV to 1 on every dispatch, so asking for 2 here cannot leak into any other
       * search that follows. The cost is one extra line in the same search, not a second search: the
       * engine evaluates alternatives it was going to evaluate anyway.
       */
      let ev = await engine.analyse(fens[i], { movetime: depthDef.movetime, multipv: 2 });
      /*
       * ONE RETRY FOR A DROPPED EVALUATION. A single search can come back empty
       * while the engine is alive (a superseded dispatch, a WebView hitch); a
       * blank in the middle of a game would otherwise be graded as "no loss"
       * and quietly raise the player's accuracy.
       */
      if (ev.scoreCp == null && ev.mateIn == null) {
        ev = await engine.analyse(fens[i], {
          movetime: Math.max(depthDef.movetime, 600),
          multipv: 2,
        });
      }
      if (ev.scoreCp == null && ev.mateIn == null) {
        emptyRun += 1;
        if (emptyRun >= 2 && !restarted) {
          restarted = true;
          engine.restart('the game review got no evaluations');
          await engine.init();
          // Re-run the position that just failed, once, on the fresh engine.
          ev = await engine.analyse(fens[i], { movetime: Math.max(depthDef.movetime, 800), multipv: 2 });
          if (ev.scoreCp != null || ev.mateIn != null) emptyRun = 0;
        }
        if (emptyRun >= 3) {
          setError(
            'The engine stopped answering, so the review was cancelled rather than shown empty. '
            + 'Tap Analyse again to restart it.',
          );
          setPhase('input');
          return;
        }
      } else {
        emptyRun = 0;
      }
      evals.push(ev);
      setProgress(Math.round(((i + 1) / (sans.length + 1)) * 100));
    }

    /*
     * NO EVIDENCE, NO REVIEW. A game whose positions mostly returned no
     * evaluation cannot be graded: publishing it produced 100% for both players
     * and a bar stuck at 0.0 on games full of blunders. Say so instead.
     */
    if (!analysisUsable(evals)) {
      setError(
        'The engine returned no evaluations for this game, so the review would be meaningless and '
        + 'was not saved. Check that the engine started, then tap Analyse again.',
      );
      setPhase('input');
      return;
    }

    const moves: MoveAnalysis[] = sans.map((san, i) => {
      /*
       * Read the mover from the board, not from the array index.
       *
       * `i % 2` is only White-then-Black from the standard initial array. A PGN
       * with a `[FEN]` header may start with Black to move, and then every eval
       * would be re-signed for the wrong side: White's good moves would be
       * graded as Black's, and the move icons and both accuracy scores would be
       * wrong together. `turnOf` is the same helper the exploration bar uses.
       *
       * `nextTurn` is read from the resulting position for the same reason. In a
       * legal game it is the opposite colour; in a malformed line where the SAN
       * could not be applied it is the same colour, which is also the correct
       * interpretation of the unchanged FEN.
       */
      const turn = turnOf(fens[i]);
      const nextTurn = turnOf(fens[i + 1]);
      const bestRaw = evals[i].bestMoveUci;
      const bestUci = bestRaw && bestRaw !== '(none)' ? bestRaw : null;
      const cpBefore = cpToWhite(evals[i].scoreCp, evals[i].mateIn, turn);
      const cpAfter = cpToWhite(evals[i + 1].scoreCp, evals[i + 1].mateIn, nextTurn);
      const moverPersp = (cp: number) => (turn === 'w' ? cp : -cp);
      const drop = Math.max(0, moverPersp(cpBefore) - moverPersp(cpAfter));
      /*
       * THE GAP TO THE SECOND-BEST LINE, which is what `brilliant` needs and had never been given.
       *
       * Both scores are from the side to move in `fens[i]`, which is `turn`, so no re-signing is
       * needed here — unlike `cpBefore`/`cpAfter`, which are converted to White's perspective for
       * the classifier. Getting that wrong would compare two different sides' numbers and produce a
       * gap of arbitrary size, so it is stated here rather than left implicit.
       *
       * A mate score is folded onto the centipawn scale on the way in, so a forced mate dwarfs the
       * threshold and passes. `null` when there is only one line, and `null` means "no evidence" —
       * the classifier then declines to say `brilliant` rather than guessing.
       */
      const lines = evals[i].lines ?? [];
      const lineScore = (l: { scoreCp: number | null; mateIn: number | null }) =>
        cpToWhite(l.scoreCp, l.mateIn, turn);
      /*
       * Only measure the gap when the top MultiPV line is the move `bestmove`
       * actually returned. `bestmove` is authoritative and the MultiPV map is
       * filled from the last `info` blocks; if a timeout left the two describing
       * different moves, their score difference is not the distance between the
       * played move and its runner-up, and `brilliant` must not be inferred from
       * it.
       */
      const bestGap = bestUci && lines.length >= 2 && lines[0].uci === bestUci
        ? Math.abs(lineScore(lines[0]) - lineScore(lines[1]))
        : null;
      const kind = classifyMove({
        ply: i,
        playedUci: ucis[i] || null,
        bestUci,
        fenBefore: fens[i],
        fenAfter: fens[i + 1],
        cpBefore,
        cpAfter,
        mover: turn,
        bookPlies,
        bestGap,
      });
      return {
        ply: i,
        san,
        uci: ucis[i] || null,
        mover: turn,
        fenBefore: fens[i],
        fenAfter: fens[i + 1],
        cpBefore,
        cpAfter,
        bestMoveSan: bestUci ? uciToSan(fens[i], bestUci) : null,
        bestMoveUci: bestUci,
        /*
         * The top line's own PV, kept on the move row for the coach. `lines[0]`
         * is the same search this row's `cpBefore` came from, so the narration
         * can show the continuation the engine actually saw.
         */
        pvUci: evals[i].lines?.[0]?.pvUci ?? evals[i].pvUci ?? [],
        kind,
        drop,
      };
    });

    /*
     * Accuracy per side.
     *
     * `cpBefore` of the first move is the initial position's eval; every later
     * entry is the eval after a move. That is exactly the n+1 list the
     * game-accuracy formula expects: one number per position, paired with the
     * next one to score the move in between.
     *
     * This used to be a plain mean of per-move accuracies. A plain mean is
     * generous: one blunder in forty quiet moves is diluted to a few points and
     * a clean game reads 95%+. The formula weights each move by the volatility of
     * its window and blends the weighted mean with the harmonic mean, which is
     * why the score drops sharply when a game contains one real disaster.
     */
    const cps: (number | null)[] = moves.length > 0
      ? [moves[0].cpBefore, ...moves.map((m) => m.cpAfter)]
      : [];
    const accuracy = gameAccuracy(cps, moves[0]?.mover ?? 'w');

    const counts = { w: zeroCounts(), b: zeroCounts() };
    for (const m of moves) counts[m.mover][m.kind]++;

    const rep: Report = {
      white: headers.White || 'White',
      black: headers.Black || 'Black',
      result: headers.Result || '',
      startFen: fens[0],
      sans,
      moves,
      accuracyWhite: Math.round(accuracy.white),
      accuracyBlack: Math.round(accuracy.black),
      counts,
      openingName: hit?.opening.name ?? null,
      openingLine: hit ? hit.coverage.study.title.replace(/^Study [\d.]+ — /, '') : null,
      coveragePly: hit?.coverage.matchedPly ?? 0,
      expectedNext: hit?.coverage.expectedNext ?? [],
      totalPlies: sans.length,
      depthName: depthDef.name,
    };
    setReport(rep);
    setViewPly(0);
    setBranch(null);
    setBranchEval(null);
    setPlaying(false);
    setPhase('done');

    // Save ONE slim aggregate row for the Stats tab — never the report/PGN.
    const my = counts[userColor];
    void store.saveGameStat({
      date: fmtDate(new Date()),
      openingKey: rep.openingName ?? 'Other',
      openingLine: rep.openingLine ?? '',
      color: userColor,
      result: resultForUser(headers.Result, userColor),
      accuracy: userColor === 'w' ? rep.accuracyWhite : rep.accuracyBlack,
      opponentAccuracy: userColor === 'w' ? rep.accuracyBlack : rep.accuracyWhite,
      plies: rep.totalPlies,
      brilliant: my.brilliant,
      great: my.great,
      bestCount: my.best,
      excellent: my.excellent,
      good: my.good,
      book: my.book,
      inaccuracy: my.inaccuracy,
      miss: my.miss,
      mistake: my.mistake,
      blunder: my.blunder,
      deviationPly: rep.coveragePly < rep.totalPlies ? rep.coveragePly : null,
      deviationMove: rep.coveragePly < rep.totalPlies ? rep.sans[rep.coveragePly] : null,
    });
    store.applyResult({ type: 'analysis', xp: 15, correct: 0, total: 1 });
  }, [pgnText, depth, userColor, engine, store]);

  // ---------- review-state helpers ----------
  const exploring = branch !== null;

  const viewFen = useMemo(() => {
    if (!report) return null;
    // Replay from the game's own start, not always the standard array: a PGN
    // with a `[FEN]` header would otherwise show a different game in review.
    const c = new Chess(report.startFen);
    for (let i = 0; i < viewPly && i < report.sans.length; i++) {
      try { c.move(report.sans[i]); } catch { /* legal by construction */ }
    }
    return c.fen();
  }, [report, viewPly]);

  const branchFen = useMemo(() => {
    if (!branch || !report) return null;
    const c = new Chess(report.startFen);
    for (let i = 0; i < branch.basePly && i < report.sans.length; i++) {
      try { c.move(report.sans[i]); } catch { /* legal by construction */ }
    }
    for (const san of branch.sans) {
      try { c.move(san); } catch { /* user-validated */ }
    }
    return c.fen();
  }, [branch, report]);

  const boardFen = exploring ? branchFen : viewFen;

  const currentMove: MoveAnalysis | null = report && viewPly > 0 ? report.moves[viewPly - 1] : null;

  const goPly = useCallback((p: number) => {
    setBranch(null);
    setBranchEval(null);
    setPlaying(false);
    setViewPly((prev) => {
      const max = report?.totalPlies ?? prev;
      return Math.max(0, Math.min(max, p === prev ? prev : p));
    });
  }, [report]);

  const handleExploreMove = (from: Square, to: Square, promotion?: string): boolean => {
    if (!boardFen) return false;
    const c = new Chess(boardFen);
    let mv: Move | null = null;
    try { mv = c.move({ from, to, promotion: promotion ?? 'q' }); } catch { return false; }
    if (!mv) return false;
    setPlaying(false);
    setBranchEval(null);
    setBranch((b) => (b ? { basePly: b.basePly, sans: [...b.sans, mv.san] } : { basePly: viewPly, sans: [mv.san] }));
    return true;
  };

  // autoplay: walk the game one move at a time
  useEffect(() => {
    if (!playing || !report || branch || viewPly >= report.totalPlies) return;
    const t = setTimeout(() => {
      const next = Math.min(report.totalPlies, viewPly + 1);
      setViewPly(next);
      if (next >= report.totalPlies) setPlaying(false);
    }, 750);
    return () => clearTimeout(t);
  }, [playing, viewPly, report, branch]);

  /*
   * Live engine feedback while exploring a branch.
   *
   * There is deliberately no depth cap on the branch itself — the user may keep
   * playing for as long as they like, up to a whole game, and the recorded game
   * is never mutated. The engine only speaks here (it does not auto-reply) so
   * the user stays fully in control of both sides while they explore; its
   * suggestion is surfaced as an arrow and its eval on the bar.
   */
  useEffect(() => {
    if (!exploring || !branchFen) return;
    let alive = true;
    const t = setTimeout(async () => {
      const ev = await engine.analyse(branchFen, { movetime: 280 });
      if (alive) setBranchEval(ev);
    }, 260);
    return () => { alive = false; clearTimeout(t); };
  }, [exploring, branchFen, engine]);

  /*
   * At ply 0 the board is the initial position, so the bar must show the
   * initial evaluation — not a hardcoded 0.00. This was most visible in games
   * that start from a non-standard position, where the first move's cpBefore is
   * not zero, but it also made the first graph point disagree with the engine.
   */
  const gameCp = report
    ? (viewPly > 0 ? report.moves[viewPly - 1].cpAfter : (report.moves[0]?.cpBefore ?? 0))
    : 0;
  const barCp = exploring
    ? (branchEval && branchFen ? cpToWhite(branchEval.scoreCp, branchEval.mateIn, turnOf(branchFen)) : gameCp)
    : gameCp;

  const arrows: BoardArrow[] = useMemo(() => {
    /*
     * While exploring a branch the engine's suggestion is the *reply to the
     * user's own idea*, so it is drawn in chessforge pink and shown unconditionally
     * — the same treatment the trainer and the course screen give it. The
     * "Show engine best move" toggle governs only the green review arrow below,
     * where the engine is grading the recorded game rather than answering you.
     */
    if (exploring) {
      const b = branchEval?.bestMoveUci;
      if (b && b !== '(none)') {
        return [{ startSquare: b.slice(0, 2), endSquare: b.slice(2, 4), color: arrowColors.reply }];
      }
      return [];
    }
    if (!showBest) return [];
    /*
     * THE ENGINE'S BEST MOVE FOR THE POSITION ON THE BOARD.
     *
     * THE REPORT: *"there is no arrows for best moves of the engine"*.
     *
     * It indexed `moves[viewPly - 1]` — the move just PLAYED — and so drew the arrow for the
     * position before it, which means: nothing at all at the start of the game, and once you
     * reached the last move of the game there was no position left to have an opinion about.
     * The answer also vanished on every `book` move, which is exactly where a player most wants
     * to be shown the alternative.
     *
     * `moves[viewPly]` is the move played FROM the position currently shown, so its `bestMoveUci`
     * is the engine's top move for the position you are looking at. That is what the control
     * "show engine best move" promises.
     *
     * It is deliberately NOT suppressed when the best move is the move that was played: an
     * arrow along the move you just made is information ("this was the only move"), and
     * hiding it would make the review quieter at the exact moments it is most useful.
     */
    if (!report || viewPly >= report.moves.length) return [];
    const m = report.moves[viewPly];
    if (!m?.bestMoveUci || m.bestMoveUci === '(none)') return [];
    return [{ startSquare: m.bestMoveUci.slice(0, 2), endSquare: m.bestMoveUci.slice(2, 4), color: arrowColors.best }];
  }, [showBest, exploring, report, viewPly, branchEval]);

  const lastMove = useMemo(() => {
    if (exploring || !report || viewPly === 0) return null;
    const u = report.moves[viewPly - 1].uci;
    return u ? { from: u.slice(0, 2), to: u.slice(2, 4) } : null;
  }, [exploring, report, viewPly]);

  // classification badge on the destination square of the reviewed move
  const overlays = useMemo(() => {
    if (!report || exploring || viewPly === 0) return {} as Record<string, React.ReactNode>;
    const m = report.moves[viewPly - 1];
    if (!m || !m.uci) return {} as Record<string, React.ReactNode>;
    const dest = m.uci.slice(2, 4);
    // `fill`, not a pixel size: the board's overlay box is a fraction of the square and the
    // board is the only thing that knows how big a square is. See the note on `QualityBadge`.
    return {
      [dest]: <QualityBadge kind={m.kind} fill />,
    } as Record<string, React.ReactNode>;
  }, [report, viewPly, exploring]);

  const markers = useMemo(() => {
    const mk: Record<number, { kind: MarkerKind; label?: string }> = {};
    if (!report) return mk;
    for (const m of report.moves) {
      const worse = m.bestMoveSan && m.bestMoveSan !== m.san && !['best', 'book', 'brilliant', 'great'].includes(m.kind);
      mk[m.ply] = {
        kind: m.kind,
        label: `${QUALITY_META[m.kind].name}${worse ? ` — best was ${m.bestMoveSan}` : ''}`,
      };
    }
    return mk;
  }, [report]);

  const keyMoments = useMemo(() => (report ? report.moves.filter((m) => KEY_KINDS.includes(m.kind)) : []), [report]);

  const graphData = useMemo(() => {
    if (!report) return [];
    const start = Math.max(-1500, Math.min(1500, report.moves[0]?.cpBefore ?? 0));
    const pts: { ply: number; cp: number; label: string }[] = [{ ply: 0, cp: start, label: 'start' }];
    for (const m of report.moves) pts.push({ ply: m.ply + 1, cp: Math.max(-1500, Math.min(1500, m.cpAfter)), label: m.san });
    return pts;
  }, [report]);

  const reset = () => {
    cancelRef.current = true;
    setPlaying(false);
    setBranch(null);
    setBranchEval(null);
    setReport(null);
    setPhase('input');
    setPgnText('');
    setProgress(0);
  };

  // ================= input =================
  if (phase === 'input') {
    return (
      <View style={a.root}>
        <View style={a.titleRow}>
          <IconLineChart size={20} color={colors.whiteSide} />
          <Text style={a.h1}>Game review</Text>
        </View>
        <Text style={[a.body, { lineHeight: 17 }]}>
          Import a game and get an engine review: brilliant, great and best moves, mistakes, blunders, an evaluation bar and free exploration.
        </Text>

        <Card style={{ gap: 12 }}>
          <View>
            <Text style={a.inputLabel}>I played</Text>
            <View style={a.row2}>
              {(['b', 'w'] as const).map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setUserColor(c)}
                  style={[
                    a.colorBtn,
                    userColor === c ? { borderColor: 'rgba(212,175,55,0.6)', backgroundColor: 'rgba(212,175,55,0.15)' } : null,
                  ]}
                >
                  <Text style={[a.colorBtnText, userColor === c ? { color: colors.gold } : null]}>
                    {c === 'w' ? '♔ White' : '♚ Black'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <TextInput
            value={pgnText}
            onChangeText={setPgnText}
            placeholder={'[White "You"]\n[Black "Opponent"]\n\n1. e4 c5 2. Nf3 d6 ...'}
            placeholderTextColor={colors.faint}
            multiline
            numberOfLines={8}
            style={a.pgnInput}
          />
          {error ? <Text style={a.errorText}>{error}</Text> : null}

          <View>
            <Text style={a.inputLabel}>Analysis depth</Text>
            <View style={[a.row2, { flexWrap: 'wrap' }]}>
              {DEPTHS.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => setDepth(d.id)}
                  style={[
                    a.depthBtn,
                    depth === d.id ? { borderColor: colors.primary, backgroundColor: 'rgba(46,139,106,0.15)' } : null,
                  ]}
                >
                  <Text style={[a.depthName, depth === d.id ? { color: colors.primary } : null]}>{d.name}</Text>
                  <Text style={a.bodySm}>{d.desc}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={a.row2}>
            <Btn
              label="Analyze game"
              onPress={() => void analyze()}
              disabled={pgnText.trim().length < 10}
              style={{ flex: 1 }}
            />
          </View>
        </Card>
      </View>
    );
  }

  // ================= analyzing =================
  if (phase === 'analyzing') {
    return (
      <View style={[a.root, { paddingTop: 64, alignItems: 'center', gap: 16 }]}>
        <View style={a.analyzeIcon}>
          <IconSearch size={24} color={colors.primary} />
        </View>
        <Text style={a.h1}>Analyzing your game…</Text>
        <Text style={a.bodySm}>
          Stockfish reviews every position ({DEPTHS.find((d) => d.id === depth)?.name} depth) — {progress}%
        </Text>
        <Bar pct={progress / 100} color={colors.primary} height={8} style={{ width: 240 }} />
        <Pressable onPress={reset}><Text style={a.cancelLink}>Cancel</Text></Pressable>
      </View>
    );
  }

  // ================= review =================
  if (!report || viewFen === null) return null;
  /*
   * WHOSE TURN IT IS, WITHOUT BUILDING A BOARD.
   *
   * This ran `new Chess(boardFen ?? viewFen).turn()` on every render of the review, and the
   * review re-renders on every engine evaluation it receives — several a second while a search
   * runs. The second field of the FEN is the answer (see `@/lib/fen`), and nothing here needs
   * the board: the moves themselves are replayed where they are actually played.
   */
  const turnAtView = turnOf(boardFen ?? viewFen);

  /*
   * Board orientation — LOCKED TO THE PLAYER, NOT TO THE SIDE TO MOVE.
   *
   * THE REPORT: *"the board keep flipping"*.
   *
   * It was auto-following the side to move, which sounds reasonable and is unusable for a
   * review: you step through a game move by move, so the board rotated 180 degrees on every
   * single ply. A board that turns over under you while you are reading it is not a viewpoint,
   * it is a distraction, and it is impossible to compare two positions a move apart when one of
   * them is upside down.
   *
   * The previous comment here defended auto-follow on the grounds that a board locked to Black
   * "left the pieces upside down relative to the player" once it was White's move. That is a
   * real problem with locking to the WRONG side — and the fix was to lock to the wrong thing.
   * The right answer is the player's seat: the board stays oriented for the whole game, and
   * `userColor` already says which seat that is. A player who wants the other view has a Flip
   * button, which pins the override for the game rather than re-deciding on every ply.
   */
  const boardOrientation = flipOverride ?? (userColor === 'w' ? 'white' : 'black');

  return (
    <View style={a.root}>
      <View style={a.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={a.h1}>Game review</Text>
          <Text style={a.bodySm} numberOfLines={1}>
            {report.white} vs {report.black} · {Math.ceil(report.totalPlies / 2)} moves
            {report.result ? ` · ${report.result}` : ''} · <Text style={{ color: colors.gold }}>{report.depthName}</Text> depth
          </Text>
        </View>
        <Pressable
          onPress={() => setFlipOverride(boardOrientation === 'white' ? 'black' : 'white')}
          style={a.flipBtn}
          accessibilityLabel="Flip board"
        >
          <IconRotateCcw size={14} color={colors.mutedForeground} />
          <Text style={a.bodySm}>Flip</Text>
        </Pressable>
        <IconBtn onPress={reset} label="New analysis">
          <IconRotateCcw size={16} color={colors.mutedForeground} />
        </IconBtn>
      </View>

      {/* accuracy + classification chips per side */}
      <View style={a.row2}>
        <Card style={{ flex: 1, padding: 14, gap: 4 }}>
          <Text style={a.bodySm}>{report.white} (White)</Text>
          <Text style={a.bigPct}>{report.accuracyWhite}%</Text>
          <KindChips counts={report.counts.w} />
        </Card>
        <Card style={{ flex: 1, padding: 14, gap: 4 }}>
          <Text style={a.bodySm}>{report.black} (Black)</Text>
          <Text style={a.bigPct}>{report.accuracyBlack}%</Text>
          <KindChips counts={report.counts.b} />
        </Card>
      </View>

      {/* opening verdict */}
      <Card>
        <View style={a.titleRowSm}>
          <IconBookOpen size={14} color={colors.chessforge} />
          <Text style={a.h2}>Opening</Text>
        </View>
        {report.openingName ? (
          <View style={{ gap: 8 }}>
            {/*
              Same drift indicator as the Openings trainer, so "am I still in my
              book?" reads identically wherever you are in the app.
            */}
            <DriftBadge
              state={{
                drifting: report.coveragePly < report.totalPlies,
                driftPly: report.coveragePly < report.totalPlies ? report.coveragePly : null,
                bookMove: report.expectedNext[0] ?? null,
                playedMove: report.coveragePly < report.totalPlies
                  ? deviationLabel(report.startFen, report.coveragePly, report.sans[report.coveragePly])
                  : null,
              }}
            />
            <Text style={[a.body, { lineHeight: 17 }]}>
              Matched <Text style={{ color: colors.foreground }}>{report.openingName}</Text>
              {report.openingLine ? <> — line <Text style={{ color: colors.gold }}>{report.openingLine}</Text></> : null}. Followed your book for{' '}
              <Text style={{ color: colors.gold, fontWeight: '600' }}>{Math.ceil(report.coveragePly / 2)}</Text> move{report.coveragePly > 1 ? 's' : ''}
              {report.coveragePly < report.totalPlies && report.expectedNext.length > 0 ? (
                <> — then left at <Text style={{ color: colors.foreground }}>{deviationLabel(report.startFen, report.coveragePly, report.sans[report.coveragePly])}</Text>.
                Book options there: <Text style={{ color: colors.chessforge }}>{report.expectedNext.join(', ')}</Text>.</>
              ) : null}
              {report.coveragePly >= report.totalPlies ? <> — right on book the whole way!</> : null}
            </Text>
          </View>
        ) : (
          <Text style={[a.body, { lineHeight: 17 }]}>
            This game didn&apos;t match any repertoire in your library.
          </Text>
        )}
      </Card>

      {/* eval graph */}
      <Card style={{ padding: 12 }}>
        <EvalGraph data={graphData} onPly={goPly} currentPly={exploring ? -1 : viewPly} />
      </Card>

      {/* exploration banner */}
      {exploring && branch ? (
        <Card style={{ padding: 10, borderLeftWidth: 4, borderLeftColor: colors.whiteSide, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <IconCompass size={14} color={colors.whiteSide} />
          <Text style={[a.bodySm, { flex: 1, lineHeight: 15 }]}>
            Exploring from move <Text style={{ color: colors.foreground, fontWeight: '600' }}>{Math.ceil(branch.basePly / 2) || 1}</Text>
            {branch.sans.length > 0
              ? ` — ${branch.sans.length} move${branch.sans.length > 1 ? 's' : ''} into your idea`
              : ''}. Play as deep as you like; the game record is untouched.
          </Text>
          <IconBtn onPress={() => { setBranch((b) => (b && b.sans.length ? { basePly: b.basePly, sans: b.sans.slice(0, -1) } : b)); setBranchEval(null); }} label="Undo branch move" disabled={branch.sans.length === 0}>
            <IconUndo size={12} color={colors.foreground} />
          </IconBtn>
          <Btn label="Return to game" variant="sky" small onPress={() => { setBranch(null); setBranchEval(null); }} />
        </Card>
      ) : null}

      {/* eval bar + board */}
      <View style={[a.row2, { alignItems: 'stretch', gap: 8 }]}>
        <EvalBarView cp={barCp} dim={exploring && !branchEval} />
        <View style={{ flex: 1 }}>
          <ChessForgeBoard
            fen={boardFen ?? viewFen}
            orientation={boardOrientation}
            interactive
            onMove={handleExploreMove}
            arrows={arrows}
            lastMove={lastMove}
            squareOverlays={overlays}
          />
        </View>
      </View>
      <Text style={[a.bodySm, { opacity: 0.8, lineHeight: 15 }]}>
        Drag a piece to try your own idea — the <Text style={{ color: arrowColors.reply, fontWeight: '600' }}>pink arrow</Text> is the engine&apos;s answer to it and the bar tracks the position. Play as many moves as you like, then hit <Text style={{ color: colors.whiteSide, fontWeight: '600' }}>Return to game</Text> to snap back where you left the record.{' '}
        <Text style={{ color: colors.gold }}>{turnAtView === 'w' ? '○ White' : '● Black'} to move</Text>
        {exploring ? ' (in your branch)' : ''}
      </Text>

      {/* navigation controls */}
      <View style={a.navRow}>
        <IconBtn onPress={() => goPly(0)} label="First move" style={a.navBtn}>
          <IconChevronsLeft size={15} color={colors.foreground} />
        </IconBtn>
        <IconBtn onPress={() => goPly(Math.max(0, viewPly - 1))} label="Previous move" style={a.navBtn}>
          <IconChevronLeft size={16} color={colors.foreground} />
        </IconBtn>
        <IconBtn onPress={() => setPlaying((p) => !p)} label={playing ? 'Pause autoplay' : 'Autoplay'} style={a.navBtn}>
          {playing ? <IconPause size={13} color={colors.foreground} /> : <IconPlay size={13} color={colors.foreground} />}
        </IconBtn>
        <IconBtn onPress={() => goPly(Math.min(report.totalPlies, viewPly + 1))} label="Next move" style={a.navBtn}>
          <IconChevronRight size={16} color={colors.foreground} />
        </IconBtn>
        <IconBtn onPress={() => goPly(report.totalPlies)} label="Last move" style={a.navBtn}>
          <IconChevronsRight size={15} color={colors.foreground} />
        </IconBtn>
      </View>
      <View style={{ alignItems: 'center', minHeight: 34, justifyContent: 'center' }}>
        {exploring ? (
          <Text style={[a.bodySm, { color: colors.whiteSide, fontWeight: '600' }]}>Branch · move {branch?.sans.length ?? 0}</Text>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={a.body}>
              {viewPly === 0 ? 'Start position' : moveNumberLabel(report.startFen, viewPly - 1, report.moves[viewPly - 1].san)}
            </Text>
            {currentMove ? (
              <>
                <QualityBadge kind={currentMove.kind} size={12} />
                <Text style={a.body}>{QUALITY_META[currentMove.kind].name}</Text>
              </>
            ) : null}
          </View>
        )}
      </View>

      <View style={a.switchRow}>
        <Switch
          value={showBest}
          onValueChange={setShowBest}
          trackColor={{ false: colors.subtleFillStrong, true: colors.primary }}
          thumbColor={showBest ? colors.primary : colors.mutedForeground}
        />
        <Text style={a.body}>Show engine best move (green arrow, review only)</Text>
      </View>

      {/*
        * The coach reacts to what the board shows: the selected move, the
        * current position, or the whole game. In a branch `currentMove` is a
        * game move that no longer belongs to the shown position, so it is
        * withheld and the coach talks about the branch position instead.
        */}
      <CoachPanel
        fen={boardFen ?? viewFen}
        move={exploring ? null : currentMove}
        report={report}
      />

      {/* key moments */}
      {keyMoments.length > 0 ? (
        <Card>
          <View style={a.titleRowSm}>
            <IconGauge size={13} color="#fb923c" />
            <Text style={a.h2}>Key moments ({keyMoments.length})</Text>
          </View>
          <View style={{ gap: 4 }}>
            {keyMoments.map((m) => (
              <Pressable
                key={m.ply}
                onPress={() => goPly(m.ply + 1)}
                style={({ pressed }) => [
                  a.keyMomentRow,
                  (!exploring && viewPly === m.ply + 1) ? { backgroundColor: 'rgba(212,175,55,0.15)' } : null,
                  pressed ? { backgroundColor: colors.subtleFill } : null,
                ]}
              >
                <View style={a.keyMomentLeft}>
                  <QualityBadge kind={m.kind} size={13} />
                  <Text style={a.body}>
                    {Math.ceil((m.ply + 1) / 2)}{m.mover === 'w' ? '.' : '...'} {m.san}
                  </Text>
                </View>
                <Text style={a.bodySm} numberOfLines={1}>
                  {QUALITY_META[m.kind].name}
                  {m.bestMoveSan && m.bestMoveSan !== m.san ? ` · best ${m.bestMoveSan}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        </Card>
      ) : null}

      {/* full move list with per-move badges */}
      <Card style={{ padding: 8 }}>
        <MoveList
          sans={report.sans}
          currentPly={exploring ? -1 : viewPly}
          onSelectPly={(ply) => goPly(ply + 1)}
          markers={markers}
        />
      </Card>

      <Btn label="Analyze another game" variant="ghost" onPress={reset} />
      <Text style={[a.bodySm, { opacity: 0.7, textAlign: 'center', lineHeight: 15 }]}>
        Saved to <Text style={{ color: colors.gold }}>Stats</Text>: opening, result, accuracy and quality counts — never the game report itself.
      </Text>
    </View>
  );
}

/* ---------------------------------------------------------------- styles */

const barStyles = themedStyles(() => ({
  column: { width: 32, alignItems: 'center', alignSelf: 'stretch' },
  track: {
    flex: 1, width: 12, borderRadius: 999, overflow: 'hidden',
    // Shares EvalBar's constants: the same quantity is drawn in two places and
    // must not disagree. They are chart-content colours (white's share reads as
    // the light tone), so they stay identical across themes.
    backgroundColor: EVAL_DARK, borderWidth: 1, borderColor: colors.subtleFillStrong,
  },
  fill: { position: 'absolute', left: 0, right: 0, backgroundColor: EVAL_LIGHT },
  label: { marginTop: 4, fontSize: 9, fontFamily: fonts.sans, fontWeight: '700', color: colors.mutedForeground },
}));

const a = themedStyles(() => ({
  root: { gap: 16 },
  row2: { flexDirection: 'row', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRowSm: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  flipBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card,
  },

  inputLabel: { fontSize: 11, fontWeight: '600', color: colors.mutedForeground, marginBottom: 6, fontFamily: fonts.sansSemiBold },
  colorBtn: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    alignItems: 'center', paddingVertical: 8,
  },
  colorBtnText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },
  pgnInput: {
    backgroundColor: colors.input, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, padding: 12, fontSize: 11, fontFamily: fonts.sans,
    color: colors.foreground, minHeight: 140, textAlignVertical: 'top',
  },
  errorText: { fontSize: 12, color: colors.bad, fontFamily: fonts.sans },
  depthBtn: {
    width: '48%', borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 8, gap: 2,
  },
  depthName: { fontSize: 12, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans },

  analyzeIcon: {
    width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(46,139,106,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  cancelLink: { fontSize: 12, color: colors.mutedForeground, textDecorationLine: 'underline', fontFamily: fonts.sans },

  bigPct: { fontSize: 24, fontWeight: '800', color: colors.foreground, fontFamily: fonts.sans },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.subtleFill, borderWidth: 1, borderColor: colors.border,
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2,
  },
  chipText: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },

  navRow: { flexDirection: 'row', gap: 4, justifyContent: 'center' },
  navBtn: { borderWidth: 1, borderColor: colors.border },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },

  keyMomentRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, gap: 8,
  },
  keyMomentLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
