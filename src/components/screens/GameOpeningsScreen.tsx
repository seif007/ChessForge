'use client';

/**
 * "Your openings" — the opening builder.
 *
 * THE FLOW, WHICH IS THE WHOLE POINT
 * ----------------------------------
 * The user's exact words:
 *
 *   "before showing anything you should show him the names of his openings and
 *    when he click on one of them for example sicilian then we show him what he
 *    played and what we suggest and continue the line and give him many other
 *    lines on the sicilian so he could train"
 *
 *   "in 'your openings' i want the user to be able to move the piece to decide
 *    whether to keep his move or what the app suggests not just clicking on the
 *    buttons"
 *
 *   "you have to complete the line with him before passing to the next opening"
 *
 *   "whenever you can suggest him to choose the app suggests to him else just
 *    show him the move"
 *
 *   "he doesn't need to wait for the app to read his openings each time he clicks
 *    on 'your openings' — the app just does that one time"
 *
 * And how the board must be annotated, which came in two rounds:
 *
 *   "the app shows him the position + an arrow what he played + an arrow what we
 *    recommend (+ a msg indicating to user what he played and what we recommend
 *    + alternative choices + engine differences)"
 *
 *   "you have to remove the show btw / dont keep anything that says you have to
 *    activate the arrows ... because this is a course so no you just show the
 *    arrows"
 *
 * The second round matters more than it looks: the annotation is COURSE
 * MATERIAL, not a hint. There is no toggle anywhere on this screen, and the
 * arrows, the compared moves, the alternatives and the eval are drawn
 * unconditionally whenever the data exists.
 *
 * So the screen has exactly three states, and each one exists because of a
 * sentence above:
 *
 *   `list`   → "show him the names of his openings". A list of FAMILIES
 *              (Sicilian Defence, Italian Game, …) with how many of his games
 *              are in each. This is painted from CACHE, so it is instant.
 *
 *   `play`   → tap a family and you PLAY it. The board is live. Move a piece:
 *              if there is a real choice, either your move or our recommendation
 *              is accepted; if there is not, the move is played for you and the
 *              line continues. The line is played to its END before the next
 *              family is offered.
 *
 *   `lines`  → the family's other lines ("many other lines on the Sicilian").
 *              Each one is a sibling rotation of his other games in that family,
 *              and picking one starts playing it.
 *
 * WHY DRAGGING IS THE INPUT, NOT BUTTONS
 * --------------------------------------
 * The board already does drag-and-drop AND click-to-move (see `ChessForgeBoard`), and
 * it was simply switched off here (`interactive={false}`). Turning it on is what
 * the user asked for — "i want the user to be able to move the piece to decide"
 * — and it is strictly better than two buttons: the user demonstrates the move
 * they mean instead of picking a label, and the same gesture works for the
 * recommendation and for every alternative.
 *
 * The buttons are gone from the answer path entirely. An earlier build kept a
 * "Show me" bulb that revealed our move as an arrow; it has been REMOVED —
 * "you have to remove the show btw / dont keep anything that says you have to
 * activate the arrows ... because this is a course so no you just show the
 * arrows". The arrows, the comparison and the eval are simply always on the
 * screen, like the diagram in a book.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { turnOf } from '@/lib/fen';
import { ChessForgeBoard, type BoardArrow } from '@/components/chess/ChessForgeBoard';
import { Card, Btn, Chip, Spinner, Bar } from '@/components/ui/Primitives';
import { GameImportInline } from '@/components/GameImportInline';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import {
  IconArrowRight, IconCheckCircle, IconBookMarked, IconSparkles, IconShieldAlert,
  IconChevronLeft, IconChevronRight, IconBookOpen, IconXCircle,
  IconDumbbell, IconRotateCcw,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';
import { playMoveSound } from '@/lib/sounds';
import { replayLine } from '@/lib/repertoire';
import { useAppStore } from '@/lib/store';
import { getEngine } from '@/lib/engine';
import {
  describeDelta, analyseFamily, deriveCandidatesAsync, deriveFamilyCandidates,
  candidatesFromPositions, analysedPositionsFromCandidates, formatEvalCp,
  type GamePosition, type MoveOption, type Cand, type CustomLine,
} from '@/lib/gameOpenings';
import {
  buildFamilyLines, continueLine, continueLineWithEngine, studyForLine, withVerdicts,
  type BuilderStep, type FamilyLine,
} from '@/lib/openingBuilder';
import {
  drillableLines, familyRecord, rankFor, depthForRank, resolveLine,
  allLinesOf, linesForRank, nextRankLineCount, chaptersCovered, askablePositions, type AskablePlace,
  nextLoopState, loopMessage, loopCounts, loopStateForNewSession, orderLoopQueue,
  type OpeningLoopState, type DrillLine,
} from '@/lib/yourOpenings';
import { AVAILABLE_OPENINGS, findStudyWithOpening } from '@/lib/openings';
import {
  loadActiveUsername, loadCustomRepertoire, saveAdoptions, clearAdoption,
  loadCachedOpenings, saveCachedOpenings, clearCachedOpenings,
  loadCachedPositions, saveCachedPositions, loadScanState, loadCachedGames,
  loadCachedVerdicts, saveCachedVerdicts, loadMinedDeck,
  openingsCacheIsStale,
  openingsCacheGameCountIsStale,
  type CustomRepertoire,
} from '@/lib/lichessStore';
import { fetchAllGames, type LichessGame, type FetchProgress } from '@/lib/lichess';
import { openingMistakesByFamily, describeOpeningMistake } from '@/lib/openingMistakes';
import type { MinedPuzzle } from '@/lib/gameScan';

/**
 * `lines` is the screen an opening trainer should have, and this one did not have.
 *
 * Tapping an opening used to go STRAIGHT into playing whatever `lineWithDecisions` picked. That
 * is the shape behind *"i played few moves in london and it is not london and just 2-3 moves"*:
 * the card was one arbitrary spine, its siblings were hidden behind an "Other lines (8)" control,
 * and the tap dropped him into a line whose length and provenance he had no way to judge before
 * committing to it.
 *
 * So an opening now opens onto ITS LINES - sized, ordered by how many of his own games reached
 * them, each with a mastery ring out of ten - and only a tap on a line starts playing. See
 * `src/lib/yourOpenings.ts` for the model.
 */
type Phase = 'boot' | 'empty' | 'building' | 'list' | 'lines' | 'analysing' | 'play';
type LineRef = { kind: 'main' } | { kind: 'alt'; index: number };

/** Games read on the very first build. Cached afterwards, so this runs once. */
const READ_GAMES = 200;
/**
 * How deep into a game we mine positions — the opening and early middlegame.
 *
 * This was 16, and 16 was chosen when the line could only ever BE the user's own
 * games: past eight moves the sample thins out and the old builder had nothing
 * to extend a line with. With the shipped studies now carrying the tail
 * (`withBookTail`), the cap stopped being "as deep as his games go" and became
 * "as deep as we are allowed to look", which truncated lines that the book
 * could have finished properly.
 *
 * 24 plies (12 moves each) is where the studies themselves stop treating the
 * position as an opening. Going deeper mostly adds forced recaptures, which is
 * what `trimLine` throws away anyway.
 */
const MAX_PLY = 24;
/**
 * Sibling lines kept per family.
 *
 * "give him many other lines on the Sicilian so he could train" — 8 is where the
 * measured curve bends: it raises the decisions on offer from 249 to 285 and
 * cuts stranded positions from 254 to 99 across the reference corpus, at under
 * one extra line per family. See `BuildOptions.maxAlternates`.
 */
const MAX_ALTERNATES = 8;
/**
 * How many positions the engine may analyse for one open family.
 *
 * This is the screen's whole engine cost, paid once per family the user opens
 * and remembered afterwards. It is sized to the LINE the user is playing, not to
 * the family: a line is 30 plies at most, and positions only exist on the trained
 * side's moves, so a full line is ~15 positions. See `sampleForLine`.
 */
const ENGINE_BUDGET_MIN = 8;
const ENGINE_BUDGET_MAX = 24;

/**
 * How much of that sample is analysed and published BEFORE the user is left to
 * wait for the rest.
 *
 * The sample is in play order (see `sampleForLine`), so its head is the opening
 * moves of the line — where the first decisions are. Publishing the head first
 * is the difference between "the first question appears in a couple of seconds"
 * and "nothing appears until the whole sample is done", which is what the user
 * experienced as a freeze.
 *
 * FOUR, NOT SIX. Each position can cost two searches (the MultiPV one and the
 * played-move probe), so every position added to the head is a visible step in
 * the wait before the first question. Four user moves is twelve plies — the
 * opening proper — and the tail is analysed while the user is playing it.
 */
const ENGINE_HEAD = 4;

/**
 * HOW LONG ONE FAMILY SEARCH MAY RUN, IN MILLISECONDS.
 *
 * The host used to ignore `movetime` entirely whenever `depth` was set, so every
 * search of this pass ran unbounded — `go depth 10` with MultiPV 3, on a phone,
 * up to 24 positions and a second probe per position. That is the "Checking our
 * ideas here…" wait the user hit, and it read as a freeze because the board
 * below it was already at the end of the line. The host now supports
 * `go depth N movetime M` (stops at whichever lands first), and this is the M.
 *
 * 800 was chosen when the only alternative was "unbounded", and the user's
 * report is that it is still too long: a line has ~12 positions, so the old
 * budget was ~19s of searches before the tail, and ~10s before the first
 * publish. 450ms still lets the engine reach the depth-10 ceiling on a desktop
 * and gets most of the way there on the phone, while nearly halving the pass.
 */
const ENGINE_SEARCH_CAP_MS = 450;

/**
 * HOW LONG THE PLAYED-MOVE PROBE MAY RUN, IN MILLISECONDS.
 *
 * The probe is a SINGLE-line search: it is not ranking alternatives, only
 * putting a number on the move the user actually played so the comparison is
 * not a dash. It does not need the MultiPV search's full budget, and making it
 * inherit 800ms was the other half of the wait — every move outside the top
 * three paid two full searches.
 *
 * 200ms is enough for a single line to reach the depth the MultiPV search
 * reaches in 450ms. It is a scoring pass, not a recommendation: the move we
 * suggest still comes from the main search.
 */
const ENGINE_PROBE_CAP_MS = 200;

/**
 * HOW FAST A LINE WALKS ITSELF, IN MILLISECONDS.
 *
 * One number, named, because the opening walkthrough and the mistake replay have to agree. When the
 * replay used its own literal the two drifted, and a correction that is played back more slowly
 * than the line it is correcting reads as the app hesitating.
 */
const WALK_MS = 420;

/**
 * THE POSITIONS A TEST CAN ASK, WHICH IS NOT THE SAME AS THE ONES THAT CARRY A DECISION.
 *
 * THE REPORT: *"i should always be able to test after finishing whether there is askable positions
 * or not"*, after the button had been hidden whenever `askablePositions` came back empty.
 *
 * Hiding it was a correct reaction to a dead tap and the wrong remedy: the earlier report was *"i
 * completed a line in your openings and clicked on test yourself but nothing happened"*, and the
 * answer taken was to remove the control. Removing it tells the user the app decided he was not
 * ready — and he has just finished the line, so he is the one who knows that.
 *
 * THE DISTINCTION BEING MISSED is between a POSITION and a DECISION. A decision needs our
 * recommendation to differ from what the user played; on a line that has never been analysed, or one
 * whose steps came back from the book tail, no step carries one. That does not make the line
 * untestable. Every ply where it is the user's turn is a question with a known answer — the line
 * plays `moveSan` there — so it is a weaker test than one scored against their own games, and a
 * real one.
 *
 * The user's own plies are therefore the FLOOR, and decision-carrying positions are preferred. The
 * side is recomputed from `step.side` rather than read from `step.isUserMove`, because a line
 * rebuilt from the book can arrive with that flag unset — which is the exact case this exists for.
 *
 * IT IS A FUNCTION AND NOT A MEMO because two callers need it: the button's count and `startTest`'s
 * queue. When those were separate computations they drifted, which is how a button came to be shown
 * over an empty pool and do nothing when pressed.
 *
 * AND IT LIVES HERE, AT MODULE SCOPE, NOT INSIDE THE COMPONENT — which is not tidiness. The
 * hooks gate reads a `return` inside a function declared in the component body as the component's
 * own early return, and then reports every hook after it as unreachable. That gate is right about
 * real cases and was tripped by this one; rather than teach it about callbacks, the function was
 * moved to where its control flow cannot be mistaken for the component's.
 */
function testPlacesFor(
  pool: readonly { id?: string; steps: readonly BuilderStep[] }[],
  trained: 'w' | 'b',
): AskablePlace<{ id: string; steps: BuilderStep[] }>[] {
  const decided = askablePositions<{ id: string; steps: BuilderStep[] }>(pool);
  if (decided.length > 0) return decided;
  const out: AskablePlace<{ id: string; steps: BuilderStep[] }>[] = [];
  for (const entry of pool) {
    for (let i = 0; i < entry.steps.length; i += 1) {
      const s = entry.steps[i];
      if (s.side !== trained) continue;
      const key = s.position?.key ?? null;
      out.push({
        key,
        id: key ?? `${entry.id ?? 'current'}#${i}`,
        ply: i,
        line: entry as { id: string; steps: BuilderStep[] },
      });
    }
  }
  return out;
}

export function GameOpeningsScreen({
  onExit, onTrain, onCourse,
}: {
  onExit: () => void;
  /**
   * Open the drill, confined to an opening when one is in view.
   *
   * The argument is the reason this is not just `onTrain()`. Train is meant to drill positions from
   * what the user has learned *in Your openings*, and it used to arrive with no idea which screen
   * sent it: tapping Train on the Sicilian produced a session full of positions from openings he was
   * not looking at. Passing the opening makes the button mean the screen it is on. Called with no
   * argument from the openings list, where there is no single opening to be about.
   *
   * `null` is accepted because a family can exist without a resolved opening id - a family is built
   * from the user's games, and until the identification pass names the opening there is nothing to
   * scope to. It means "every opening", which is the honest answer rather than a guess.
   */
  onTrain: (openingId?: string | null) => void;
  /**
   * Open a shipped study in the course.
   *
   * The "ours" half of "train on his repertoire and ours": once the user has
   * played through an opening he actually meets, he should be able to read the
   * full lesson for it. Optional so the screen still renders standalone.
   */
  onCourse?: (studyId: string) => void;
}) {
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>('boot');
  const [username, setUsername] = useState<string | null>(null);
  const [families, setFamilies] = useState<FamilyLine[]>([]);
  const [gameCount, setGameCount] = useState(0);
  /**
   * When the family list currently on screen was derived (ms), or null.
   *
   * Shown in the footer so the freshness promise is CHECKABLE rather than
   * implied — "when we switch accounts we should add a refresh to get the new
   * games" is only trustworthy if the user can see that it happened.
   */
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [repertoire, setRepertoire] = useState<CustomRepertoire>({ positions: {}, updatedAt: 0 });

  // Which family is open, and which of its lines.
  const [openFamilyId, setOpenFamilyId] = useState<string | null>(null);
  const [lineRef, setLineRef] = useState<LineRef>({ kind: 'main' });
  /**
   * THE MOVES OF THE CHOSEN LINE, so it can be found again after the family is re-derived.
   *
   * A ref and not state on purpose: it is read inside the `activeLine` memo, and putting it in
   * state would mean a render, and a `setState` from inside a `useMemo` is a render loop. Written
   * at the moment the line is picked, cleared whenever a different family is opened.
   *
   * See `activeLine` for why the index alone is not enough — the engine pass replaces
   * `alternates` with a different list, twice, while the user is looking at it.
   */
  const lineSansRef = useRef<string[] | null>(null);

  /**
   * PER-POSITION MASTERY, which is what the rings on the line list are drawn from.
   *
   * `repertoire` below is the CUSTOM repertoire - the lines the user has adopted and saved - and
   * it is not the same thing and does not carry mastery. Mastery lives in the app store's
   * `positions` map, keyed by `GamePosition.key`, and `store.ts` already maintains it:
   * `recordPositionResult` raises it by 0.25 per correct answer and drops it by 0.3 per wrong one,
   * clamped to 0..1.
   *
   * Subscribed at the top of the component rather than inside the render body, because this file
   * returns early for several phases and a hook after an early return is a hook called a
   * different number of times on different renders.
   */
  const positionProgress = useAppStore((st) => st.positions);

  /*
   * THE MINED PUZZLE DECK, GROUPED INTO OPENING MISTAKES.
   *
   * Read once, from the same scan record the Stats screen writes, so this screen cannot disagree with
   * the puzzles tab about where the user went wrong. `null` until it has loaded — see the family
   * view, which words that state differently from "loaded and empty".
   */
  const [scanPuzzles, setScanPuzzles] = useState<MinedPuzzle[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // One read for "the active account and its mined deck" — the same helper Puzzles uses, so
        // the two screens cannot disagree about what has been mined.
        const { username, puzzles } = await loadMinedDeck();
        if (!username) return;
        if (alive) setScanPuzzles(puzzles ?? []);
      } catch {
        // No scan yet, or storage unavailable. The screen says "analyse your games" rather than
        // pretending the opening is clean.
        if (alive) setScanPuzzles([]);
      }
    })();
    return () => { alive = false; };
  }, []);
  const openingMistakes = useMemo(
    () => openingMistakesByFamily(scanPuzzles ?? []),
    [scanPuzzles],
  );
  /**
   * Progress written without running a Train session. See `store.recordPositions` — without it the
   * rings in this screen had no writer at all and read 0% forever.
   */
  const recordPositions = useAppStore((st) => st.recordPositions);
  /**
   * Study progress goes through `applyResult` rather than a new action, because a study must not
   * acquire a second definition of "attempted" — one written by the trainer and a different one
   * written by a drill. `applyResult` is the same path, with the session-only fields left at zero.
   */
  const applyResult = useAppStore((st) => st.applyResult);
  /** The test's own completion moment, raised through the store's single celebration slot. */
  const completeSession = useAppStore((st) => st.completeSession);

  // Playback state.
  const [stepIdx, setStepIdx] = useState(0);
  const [playedSans, setPlayedSans] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  /**
   * Flushed straight away, so a finished line is on disk before the user can leave.
   *
   * Set by the completion path. The 700 ms debounce is the right shape for the
   * re-render problem but it introduced a race the user then hit exactly: finish a
   * line, tap Train straight away, and the timer had not fired, so the custom
   * repertoire was still empty and Train said "you have not practiced anything" about
   * a line played seconds earlier.
   *
   * A shorter debounce would trade one bug for a worse one — a write on nearly every
   * ply is what caused the touch regression. Line completion is a real signal, so it
   * is waited for instead of guessed at.
   */
  const lineFinishedRef = useRef(0);
  /**
   * The continuation the user's own choices produced, when it diverged.
   *
   * Null while a line is still being played along its original spine. Once the
   * user takes our recommendation (or any move the spine does not contain), the
   * branch they created is re-derived by `continueLine` and stored here, and it
   * REPLACES the spine for the rest of the line. A single list is what keeps the
   * board and the step index from ever disagreeing — the failure mode that put
   * an illegal move on the board and stopped the line after one move.
   *
   * Cleared whenever a different line or family is opened.
   */
  const [overrideLine, setOverrideLine] = useState<BuilderStep[] | null>(null);

  /**
   * A COUNTER THAT MOVES WHEN THE ENGINE'S VERDICTS LAND.
   *
   * `analysedRef` is a ref, so writing to it does not re-render — and `publish`
   * deliberately refuses to swap the family in while a session is live, because
   * that is what moved the line under the user. The verdicts still have to reach
   * the line he is playing, so they are applied to it IN PLACE (see
   * `withVerdicts` below the resolver) and this counter is what makes React run
   * that join. Without it, "it never shows me a bad move ... only my good move
   * and another good move" is exactly what a session looks like.
   */
  const [verdictsTick, setVerdictsTick] = useState(0);

  /**
   * THE POSITION THE USER'S OWN GESTURE PRODUCED, HELD WHILE THE LINE CATCHES UP.
   *
   * The board is driven by `stepIdx` (through `boardFen`), and the steps only
   * know the LINE's moves. When the user plays a move the line does not contain
   * — our recommendation, or an alternative — the position he reached is not on
   * any step yet, so the board used to stay on the pre-move position until
   * `continueLineWithEngine` came back, with the piece he had just moved sitting
   * back on its origin square. That is the "stayed stuck a little bit" half of
   * *"i played my move. the app stayed stuck a little bit then it jumped to
   * another position"*, and it was purely a display gap: his move is legal, it
   * happened, and it is the one thing on screen that is certain.
   *
   * So the FEN after the move is held here and the board wears it until the
   * continuation resolves (or the dead-end branch gives up and puts the question
   * back). It is never trusted as game state: `stepIdx` and `playedSans` are
   * untouched while it is set, so nothing downstream can index into a position
   * that has no step.
   */
  const [pendingFen, setPendingFen] = useState<string | null>(null);

  /**
   * Progress for the phase in flight.
   *
   * `phase` is carried alongside the counts because the counts are often
   * unknowable — looking up an account and listing its archives have no
   * denominator. The UI needs the words for those moments; the numbers alone
   * showed the user "0 / 0".
   */
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Positions (with engine verdicts) per family id, so re-opening is instant. */
  const analysedRef = useRef<Map<string, GamePosition[]>>(new Map());
  /**
   * Family ids the engine has FINISHED with.
   *
   * WHY THIS IS STATE AND NOT JUST `analysedRef`
   * -------------------------------------------
   * `analysedRef` is a ref: writing to it does not re-render. The play view
   * needs a re-render, because a line with no decision looks EXACTLY like a
   * line the user has already finished — `startLine` walks every non-decision
   * step for him, so a question-free line lands on the last ply immediately.
   * That is what made the opening cards read as "fake buttons": tap one, the
   * board arrives already complete and dead, and the engine's verdicts — the
   * decisions that were supposed to appear — arrive a moment later into a view
   * that had already declared the lesson over.
   *
   * So: while a question-free line is still being analysed we say we are
   * checking rather than claim it is done, and when the verdicts land we start
   * the line again so the questions are actually asked.
   */
  const [engineChecked, setEngineChecked] = useState<string[]>([]);
  /**
   * Families we TRIED to analyse and got NOTHING back from.
   *
   * This exists because `engineChecked` cannot carry both "finished" and "finished without doing
   * anything", and conflating them is what produced three separate reports at once:
   *
   *   1. "i completed a line and it gave me just one position for the test" — with no engine verdicts
   *      almost every step has `choice == null` and `isUserMove` false, so `askablePositions` had
   *      almost nothing to return. One question is not a test.
   *   2. "it showed nothing to play, then after a few time it says we are done while i didnt play
   *      anything" — the engine pass ran, produced nothing, and the `finally` below marked the family
   *      checked anyway. That made `enginePending` false, `awaitingVerdict` false, and `done` true:
   *      the app declared a line finished that it had never once examined.
   *   3. "it never showed me a mistake or blunder of mine" — `verdict` is set BY the engine pass.
   *      Without it every move of the user's reads as merely fine, and the recommendation is just
   *      another reasonable move.
   *
   * All three are the same fact: the engine produced no verdicts, and the screen said nothing about
   * it. A separate list lets the screen say the truth — the line is NOT complete, and here is why —
   * instead of presenting an unchecked walkthrough as a finished one.
   */
  const [engineStalled, setEngineStalled] = useState<string[]>([]);
  /**
   * Bumped by the stall view's Retry button.
   *
   * The engine pass below depends on it, so a retry re-runs the pass for the family on screen
   * instead of waiting for the next visit — the whole point of the button, and the reason it is
   * not merely `setEngineStalled` clearing state.
   */
  const [engineRetry, setEngineRetry] = useState(0);
  /**
   * The account the in-memory `families`/`analysedRef` were built for.
   *
   * Used to detect an account switch that happened while this screen stayed
   * mounted (see `build`). Null until the first load resolves.
   */
  const builtForRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const stopRef = useRef(false);
  /**
   * The games this screen already fetched, so the engine pass does not ask again.
   *
   * THE FREEZE THIS FIXES
   * ---------------------
   * "i clicked on an opening and it took too long to open (i thought it froze)".
   * Opening a family runs the engine over its positions, and that effect fetched
   * the whole game list ITSELF — `fetchAllGames` is a network request even when the
   * list was read moments earlier, so each tap cost an extra round-trip before a
   * single engine search began. The list had been built from those same games
   * moments earlier.
   *
   * A ref rather than state: this is a cache for a later effect, not something
   * the UI renders, and putting it in state would re-render the list on every
   * fetch.
   */
  const gamesRef = useRef<LichessGame[]>([]);
  /**
   * The derived candidates, so nothing on this screen replays a game twice.
   *
   * THE FREEZE THIS REMOVES
   * -----------------------
   * `deriveCandidates` replays every one of the user's games with chess.js, and
   * chess.js costs ~0.2 ms a move: 160 games x 24 plies is ~4,100 moves, about a
   * second of blocked main thread on a desktop and several seconds on a phone.
   *
   * The engine effect used to call it again after the play view was already on
   * screen — so tapping an opening froze the board for that whole second, and the
   * user's report was exactly that: "i clicked on an opening and it took too
   * much time to open … then when I click on a piece to move it stays blocked
   * and doesn't move". The board was not broken; nothing could run.
   *
   * A ref, not state: it is a cache for a later effect, and putting it in state
   * would re-render the whole screen on every derivation.
   */
  const candsRef = useRef<Cand[]>([]);

  useEffect(() => () => { aliveRef.current = false; stopRef.current = true; }, []);

  /* ------------------------------------------------------------------ load */

  /**
   * Fetch this account's games and rotate them into families — no screen state.
   *
   * Split out of `build` so the background refresh can reuse it without
   * duplicating the filter and the rotation. Returns null (rather than an empty
   * list) when the account has no usable games, because the caller's response to
   * "nothing came back" is different from "we derived zero families": one is a
   * fetch problem, the other is a legitimate empty repertoire.
   */
  const deriveFamilies = useCallback(async (
    user: string,
    opts: {
      force: boolean;
      onProgress?: (p: FetchProgress) => void;
      onDeriving?: (done: number, total: number) => void;
      shouldStop?: () => boolean;
    },
  ): Promise<{ lines: FamilyLine[]; gameCount: number } | null> => {
    /*
     * REUSE THE POSITIONS BEFORE RE-DERIVING THEM.
     *
     * The fetch and the replay are the expensive half, and they have nothing to do with how
     * families are grouped. So they are looked up in their own cache first, and only done
     * when that cache is missing or explicitly invalidated.
     *
     * `opts.force` still means "the user asked for a refresh" and still re-downloads, which
     * is the right behaviour for a button labelled "re-read my games". What it no longer
     * means is "the grouping code changed", because that no longer reaches this function at
     * all: a grouping change bumps `OPENINGS_CACHE_VERSION`, the family cache misses, and
     * the positions are read from here and re-grouped.
     */
    const cached = opts.force ? null : await loadCachedPositions(user);
    /*
     * A CACHE THAT PREDATES THE ANALYSIS IS NOT FRESH, AND SAYING OTHERWISE WAS THE BUG.
     *
     * The positions are DERIVED from the analysed games, so the number of analysed games is part of
     * their identity. The cache did not record it and nothing compared it, so a cache written before
     * the engine had run stayed "fresh" for ever - which is why analysing two hundred games left every
     * opening reading "0 in the opening". See `StatsScreen` for the other half of this fix.
     *
     * Clearing the cache when a run completes is not enough on its own: it only helps if a run
     * completes, and the user may never start one. So the count is checked HERE as well, which makes
     * the cache self-healing - any change to what has been analysed invalidates it without anybody
     * having to remember to.
     *
     * The cost is one cheap read of the scan state, and it is a read this screen already does.
     */
    let usable = cached;
    if (cached) {
      const scan = await loadScanState(user);
      const analysedNow = Object.keys(scan.records ?? {}).length;
      if (typeof cached.analysedGameCount === 'number' && cached.analysedGameCount !== analysedNow) {
        usable = null;
      }
      /*
       * AND A DIFFERENT NUMBER OF GAMES IS ALSO A DIFFERENT ANSWER.
       *
       * THE REPORT: *"when the user refresh games or try another account (so there is a fresh
       * data/games) the creation of your openings is automatic (maybe there are new openings played)
       * and also the same for the suggestions move"*.
       *
       * The comparison above only knows about ANALYSED games, so a game fetched but not yet analysed
       * changed nothing — and an unanalysed game is exactly the one that can be a new opening. Every
       * decision on this screen, the played move and the suggestion beside it, is read from a game
       * list, so a different game list is a different set of answers by definition.
       *
       * It is checked here as well as in Stats, deliberately. One place making this true means the
       * behaviour depends on a caller remembering to clear a cache; the screen that is wrong when it
       * is missed is the one that has to be able to notice. The read is cheap and already in scope.
       */
      if (usable) {
        const stored = await loadCachedGames(user);
        const have = stored?.games?.length ?? null;
        if (have != null && typeof cached.gameCount === 'number' && cached.gameCount !== have) {
          usable = null;
        }
      }
    }
    if (usable && usable.positions.length > 0) {
      const lines = buildFamilyLines(usable.positions, { maxPly: MAX_PLY, maxAlternates: MAX_ALTERNATES });
      if (!aliveRef.current) return null;
      // The candidates are not recoverable from positions alone, and the engine pass needs
      // them, so a family opened from this path re-derives its own candidates from the
      // stored games. That is one family, not all 160.
      gamesRef.current = [];
      return { lines, gameCount: usable.gameCount };
    }

    /*
     * READ THE GAMES THE APP ALREADY HAS BEFORE REACHING FOR THE NETWORK.
     *
     * THE REPORT: *"i imported the games in stats then went to your openings and it told me to import
     * the games! if i did import in a page i shouldn't redo in the other page"*.
     *
     * The import on Stats (and the inline card) downloads the account's games ONCE and caches them
     * under the account key — `loadCachedGames(user)`. This screen ignored that cache and always
     * re-fetched. A second request a moment after the first is exactly what Lichess rate-limits, and a
     * failed fetch here was caught and rendered as `phase = 'empty'` — the "import your games" card —
     * even though the games were already on the device. One import must be enough everywhere.
     *
     * So the cached list is the source when it exists. The network is only touched for an explicit
     * refresh (`force`) or when nothing has been downloaded yet.
     */
    let games: LichessGame[];
    const stored = opts.force ? null : await loadCachedGames(user);
    if (stored && stored.games.length > 0) {
      games = stored.games;
    } else {
      games = await fetchAllGames(user, {
        maxGames: READ_GAMES,
        // A switch or an explicit refresh re-downloads; the archive URLs differ per
        // account anyway, but passing `force` keeps the intent explicit.
        force: opts.force,
        onProgress: opts.onProgress,
      });
      if (!aliveRef.current) return null;
    }

    // The same filter the rest of the app uses: rated, not bullet, and long
    // enough to contain an opening.
    const kept = games
      .filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 6)
      .slice(0, 160);
    if (kept.length === 0) return null;
    // Keep them: the engine pass for a family needs exactly these games, and
    // re-fetching them was the delay the user felt when opening an opening.
    gamesRef.current = kept;

    // Derive ONCE, and keep the candidates. The list is built from the positions
    // and the engine pass needs the candidates; deriving the games twice is the
    // second full replay this screen used to pay on every open.
    //
    // In slices, not in one call. The derivation is ~4,100 chess.js moves at
    // ~0.2 ms each, so a single synchronous call owns the JS thread for a second
    // (several on a phone) — long enough that the progress card never paints and
    // its Stop button never answers, which reads as a hang. See
    // `deriveCandidatesAsync`.
    const cands = await deriveCandidatesAsync(kept, {
      limit: Number.MAX_SAFE_INTEGER,
      maxPly: MAX_PLY,
      shouldStop: opts.shouldStop,
      onProgress: opts.onDeriving,
    });
    if (!aliveRef.current) return null;
    candsRef.current = cands;

    const positions = positionsFromCandidates(cands);
    /*
     * Store the positions, not just the families. This is the write that makes the NEXT
     * grouping change free, and it is the only durable artefact of the expensive half.
     *
     * The analysed-game count goes in with them, and it is what makes this cache checkable later:
     * the positions are derived from the analysed games, so a cache whose count no longer matches
     * the scan describes a state the app is no longer in.
     */
    const scanNow = await loadScanState(user);
    const analysedCount = Object.keys(scanNow.records ?? {}).length;
    void saveCachedPositions(user, positions, kept.length, analysedCount);
    const lines = buildFamilyLines(positions, { maxPly: MAX_PLY, maxAlternates: MAX_ALTERNATES });
    return { lines, gameCount: kept.length };
  }, []);

  /**
   * Re-derive in the background and swap the list in when it lands.
   *
   * WHY THIS IS NOT `build(true)`
   * -----------------------------
   * `build` owns the `building` phase, so calling it here would blank the screen
   * and show the progress card — turning a silent freshness update into a visible
   * stall, which is worse than the staleness it fixes.
   *
   * WHY IT IS SILENT ABOUT FAILURE
   * ------------------------------
   * The user is already looking at a perfectly usable list. A failed refresh
   * (offline, Lichess hiccup) must not replace that with an error screen; the
   * next staleness check will try again. So the failure is swallowed by design —
   * this is the one place where swallowing an error is the correct behaviour, and
   * it is deliberate rather than an oversight.
   *
   * It deliberately does NOT clear `analysedRef`: engine verdicts are keyed by
   * POSITION key, so a newly-derived line that revisits a position we already
   * analysed keeps that analysis. Dropping the map would only force needless
   * re-searches.
   */
  const refreshInBackground = useCallback(async (user: string) => {
    try {
      const result = await deriveFamilies(user, { force: false });
      if (!aliveRef.current || !result || result.lines.length === 0) return;
      setFamilies(result.lines);
      setGameCount(result.gameCount);
      setBuiltAt(Date.now());
      const scanAfter = await loadScanState(user);
      void saveCachedOpenings(user, result.lines, result.gameCount, Object.keys(scanAfter.records ?? {}).length);
    } catch {
      /* keep showing the cached list — see the note above */
    }
  }, [deriveFamilies]);

  /**
   * Build the family list — from CACHE when we have it.
   *
   * This is the "read his openings one time" requirement. The expensive part is
   * not the Lichess fetch (which the cache normally serves) but the ENGINE pass,
   * and the engine pass is deliberately NOT done here: the list of names is
   * engine-free by design, so it paints from cached, already-rotated families in
   * one key-value read.
   *
   * `force` is the explicit refresh: it re-reads the games and rebuilds. Nothing
   * else in this screen may trigger it — staleness is handled by
   * `refreshInBackground`, which does not blank the screen.
   */
  const build = useCallback(async (force: boolean) => {
    setError(null);
    try {
      const user = await loadActiveUsername();
      if (!aliveRef.current) return;
      if (!user) { setPhase('empty'); return; }

      /*
       * A CHANGE OF ACCOUNT INVALIDATES EVERYTHING IN MEMORY.
       *
       * The disk cache is already namespaced per account, and `connect()` in the
       * Stats screen wipes the OLD account's cached openings on a switch. What
       * that does not cover is this component's own state: if the user switches
       * account and comes back without the screen having unmounted, `families`
       * and `analysedRef` still hold the previous account's openings and would
       * be shown for the new one — the exact "shows me the wrong data when I
       * change account" complaint.
       *
       * So the username is compared against the one that produced what is in
       * memory, and any difference forces a fresh derivation. Comparing the
       * resolved name (rather than reacting to a prop) is what makes this hold
       * however the switch was performed.
       */
      const previousUser = builtForRef.current;
      const switched = previousUser != null && previousUser !== user;
      const fresh = force || switched;
      if (switched) {
        analysedRef.current = new Map();
        candsRef.current = [];
        setOpenFamilyId(null);
        setLineRef({ kind: 'main' });
        setFamilies([]);
      }
      builtForRef.current = user;
      setUsername(user);

      /*
       * BRING BACK THE ENGINE'S VERDICTS FROM THE LAST RUN.
       *
       * THE REPORT: *"when i open the app and go to your openings and open an opening it takes too
       * much time as before"*. `analysedRef` is a ref, so the pass was re-run from scratch on every
       * launch - the most expensive thing this screen does, re-bought every time.
       *
       * AFTER the switch reset above, not before it. Seeding first and resetting second threw the
       * newly read verdicts away on every account switch, so the second account paid for the whole
       * engine pass while its own answers sat on disk unread - and switching account is one of the
       * two ways the user gets fresh data in the first place.
       *
       * Guarded on `size === 0` rather than done once at mount, so a rebuild in the same session does
       * not re-read the disk and cannot overwrite verdicts the running pass has just produced. It
       * stays before the cache branch, so a family whose verdicts are already known skips the engine
       * on the very first tap rather than after one more wait.
       */
      if (analysedRef.current.size === 0) {
        const storedVerdicts = await loadCachedVerdicts(user);
        if (!aliveRef.current) return;
        if (storedVerdicts) {
          for (const [id, positions] of Object.entries(storedVerdicts.families)) {
            if (Array.isArray(positions) && positions.length > 0) {
              analysedRef.current.set(id, positions);
            }
          }
        }
      }

      const rep = await loadCustomRepertoire();
      if (!aliveRef.current) return;
      setRepertoire(rep);

      if (!fresh) {
        const cached = await loadCachedOpenings(user);
        if (!aliveRef.current) return;
        if (cached) {
          /*
           * THE CACHE CARRIES THE POSITIONS, SO THE ENGINE PASS NEEDS NO REPLAY.
           *
           * Every family keeps its whole position pool (`FamilyLine.positions`) —
           * that is what makes "analyse, then rebuild" idempotent, see
           * `mergeAnalysed`. Those positions already hold everything a candidate
           * needs, so a warm open reconstructs the candidate list in one pass
           * over data we have just read off disk.
           *
           * Without this, the engine effect re-derived the candidates from the
           * games, and that is the ~4,100-move replay the user felt as a frozen
           * board on every tap. This is the last piece of that: from here on,
           * opening an opening replays NOTHING.
           */
          candsRef.current = candidatesFromPositions(
            cached.families.flatMap((f) => f.positions ?? []),
          );
          setFamilies(cached.families);
          setGameCount(cached.gameCount);
          setBuiltAt(cached.builtAt ?? null);
          setPhase('list');
          /*
           * STALE-WHILE-REVALIDATE.
           *
           * We paint the cached list FIRST — that is the "opens instantly"
           * promise — and only then decide whether it is old enough to be worth
           * re-deriving. The refresh runs in the background and replaces the list
           * when it lands, so the user never waits for it and never has to press
           * anything.
           *
           * `refreshInBackground` (not `build(true)`) because a full `build`
           * would flip the screen back to the `building` phase and hide the list
           * we just painted — turning a silent update into a visible stall.
           */
          const scanNow = await loadScanState(user);
          const gamesNow = await loadCachedGames(user);
          if (!aliveRef.current) return;
          if (
            openingsCacheIsStale(cached, Object.keys(scanNow.records ?? {}).length)
            /*
             * AND A REFRESH THAT ADDED GAMES, WHICH NOTHING ELSE IN THIS SCREEN CAN SEE.
             *
             * The list we just painted is correct about the games it was built from and blind to the
             * ones the user fetched a minute ago. `openingsCacheIsStale` cannot catch that: the
             * analysis count is unchanged by a refresh and the blob is young, so both of its reasons
             * say "fresh" while the answer has moved. The games cache is what the refresh wrote, and
             * its length is the count the user would recognise at the top of this screen.
             *
             * This only ever starts the SAME silent background re-derivation as the age rule. The
             * painted list stays on screen until the new one lands, so the cost of being right here
             * is nil.
             */
            || openingsCacheGameCountIsStale(cached, gamesNow?.games.length)
          ) {
            void refreshInBackground(user);
          }
          return;
        }
      }

      setPhase('building');
      setProgress(null);

      const result = await deriveFamilies(user, {
        force: fresh,
        shouldStop: () => stopRef.current,
        onProgress: (p) => {
          if (aliveRef.current) {
            setProgress({
              phase: p.phase,
              done: p.monthsDone ?? 0,
              total: p.monthsTotal ?? 0,
            });
          }
        },
        /*
         * The second half of the first build — the chess.js replay — reports here,
         * with its own honest denominator. Before the work was sliced it could
         * not report at all, because nothing could run while it held the thread:
         * the card sat on whatever the FETCH last said ("Finding your games…")
         * for a second or more, which is indistinguishable from a hang.
         */
        onDeriving: (done, total) => {
          if (aliveRef.current) {
            setProgress({ phase: 'Finding your openings…', done, total });
          }
        },
      });
      if (!aliveRef.current) return;
      // A cancelled build is a deliberate act by the user, not a failure, and it
      // must not be reported as one — the screen simply has nothing to show yet.
      if (stopRef.current) return;

      if (!result || result.lines.length === 0) { setPhase('empty'); return; }
      setFamilies(result.lines);
      setGameCount(result.gameCount);
      setBuiltAt(Date.now());
      setProgress(null);
      setPhase('list');
      // Persist for the next open. Awaiting this is not necessary for the UI and
      // a failure must not break the screen, so it is fired and forgotten.
      const scanAfter = await loadScanState(user);
      void saveCachedOpenings(user, result.lines, result.gameCount, Object.keys(scanAfter.records ?? {}).length);
    } catch (err) {
      if (aliveRef.current) {
        setError((err as Error)?.message ?? 'Could not read your games.');
        setPhase('empty');
      }
    }
  }, [deriveFamilies, refreshInBackground]);

  useEffect(() => { void build(false); }, [build]);

  /* --------------------------------------------------------------- helpers */

  const openFamily = useMemo(
    () => families.find((f) => f.id === openFamilyId) ?? null,
    [families, openFamilyId],
  );

  /**
   * THE OPENING'S OWN LINES, drawn from its studies and ordered so any prefix spans the opening.
   *
   * HOISTED, AND THAT IS THE WHOLE COMMENT.
   *
   * These two hooks were written inside the `lines` render block, and the device killed the app on
   * the first tap of an opening:
   *
   *     com.facebook.react.common.JavascriptException:
   *       Error: Rendered more hooks than during the previous render.
   *
   * A hook inside a conditional runs on some renders and not others, so React's hook list changes
   * length between renders and it throws. It threw on the transition INTO the line-list screen -
   * which is why opening "Your openings" looked fine (that render skips the block entirely, so the
   * old list showed and it looked as though the new UI had never shipped) and only tapping an
   * opening crashed. Neither tsc nor any behaviour gate can see it: the type is correct, every
   * check passes, and the crash needs the exact transition.
   *
   * This file already carries a long note about having made this mistake once before, for an
   * effect rather than a memo. Making it twice is the lesson, so GATE 1j now checks it
   * mechanically: no hook may appear after the first early return in any screen.
   */
  const openingRepertoire = useMemo(
    () => AVAILABLE_OPENINGS.find((o) => o.id === openFamily?.openingId)?.repertoire ?? null,
    [openFamily?.openingId],
  );
  const allLines = useMemo(() => allLinesOf(openingRepertoire), [openingRepertoire]);

  /**
   * TWO REFS, DECLARED HERE BECAUSE `activeLine` BELOW WRITES THEM.
   *
   * The device crash, verbatim, from the build that introduced them:
   *
   *     TypeError: Cannot set property 'current' of undefined
   *
   * Both were originally declared further down this component, next to the other line-identity
   * refs, which is where they tidily belong. That is wrong, and it crashes on the first tap of an
   * opening. `activeLine` is a `useMemo`, and a `useMemo`'s callback runs INLINE, during the render
   * pass, at the line where it is written — not after the component body finishes. So a ref written
   * inside it must already exist. These were declared 250 and 470 lines further down, and Metro
   * transpiles `const` to `var` for the release bundle, so at line 707 they were `undefined` rather
   * than in the temporal dead zone, and `lastLineRef.current = resolved` threw.
   *
   * `tsc` is clean on this, which is the part worth remembering: a use-before-declaration inside a
   * closure is a perfectly legal program to the type checker, and to `eslint` without the
   * no-use-before-define rule enabled. Only running it finds it. GATE 1k §6 now checks the ordering
   * for this file, because the compiler will not.
   */

  /**
   * TRUE FOR AS LONG AS THE USER IS IN A LINE, ANSWERED OR NOT.
   *
   * `answeredRef` answers "has he moved?", which is the wrong question for the engine publish: the
   * publish that does the damage lands during the opening walkthrough, before he has moved
   * anything. This asks the question that actually matters - "is a line on the board?" - and it is
   * set from `phase` above the effect's early return. See the note in `publish` for why the two
   * were the same bug wearing two hats.
   */
  const sessionLiveRef = useRef(false);

  /**
   * THE LINE MOST RECENTLY RESOLVED, so a session can be held on it.
   *
   * `activeLine` resolves the chosen line from the family's current arrays, and those arrays are
   * re-derived by the engine pass. When the recorded moves are no longer in them there is no honest
   * line to resolve to by index - the index names a different move order - so the answer during a
   * session is the line already on the board. See the note in the `activeLine` memo.
   */
  const lastLineRef = useRef<BuilderStep[]>([]);

  /**
   * The line currently being played — identified by its MOVES, not by its index.
   *
   * THE BUG THIS FIXES, and it is the third time this symptom has been reported:
   * *"it keep playin automatically 3 times and then i get a new different position to play"*.
   *
   * `lineRef` was `{kind:'alt', index: n}` — a POSITION in `family.alternates`. And the engine
   * pass RE-DERIVES the family: `publish()` calls `buildFamilyLines` again with the verdicts now
   * attached, which re-runs the pool rotation, and the rotation prefers positions that carry
   * decisions. So `alternates` is not merely re-derived, it is a DIFFERENT LIST, published twice -
   * once for the head of the sample and once for the tail.
   *
   * Which makes the index a moving target. The user taps the third line on the openings screen,
   * the engine publishes, and `alternates[2]` is now somebody else's move order: the board shows
   * a different position without anything being tapped. Then the sync effect compares those new
   * SANs against what is on the board, disagrees, and calls `startLine()` - which walks from move
   * one again. Publish, disagree, replay; twice. That is the automatic playing, and the "new
   * different position" is the line the user never chose.
   *
   * THE FIX: the chosen line's MOVES are recorded when it is picked, and after any re-derivation
   * the line is located by those moves. An index is only a hint for the first render, before the
   * moves are known. Two consequences, both wanted:
   *
   *   - the line the user chose is the line they get, whatever the engine does to the list; and
   *   - the sync effect's SAN comparison then AGREES, so a re-publication is adopted in place
   *     instead of replaying the opening.
   */
  const resolvedLine: BuilderStep[] = useMemo(() => {
    if (overrideLine && overrideLine.length > 0) return overrideLine;
    if (!openFamily) return [];

    const resolved = resolveLine(openFamily, lineRef, lineSansRef.current);
    if (resolved) {
      lastLineRef.current = resolved;
      return resolved;
    }

    /*
     * NO LINE MATCHES ANY MORE, so the moves are gone from this family entirely.
     *
     * That is the honest outcome - the pool rotation genuinely produced different lines, and
     * showing one of those instead would be exactly the bug this replaced. The recorded moves are
     * dropped so the next render resolves by index rather than re-scanning every time, and the
     * sync effect will notice the disagreement and walk the new line from the top, which is the
     * one case where a replay is correct: something really did change.
     *
     * EXCEPT WHILE A SESSION IS LIVE, WHERE THAT LAST SENTENCE IS THE BUG.
     *
     * Falling back to `alternates[lineRef.index]` hands the user a DIFFERENT line's move order and
     * calls it the line they tapped. That is the "then i get a different new position to play", and
     * it is how a session that was four moves deep turned into a one-move fragment. Outside a
     * session the fallback is right - a fresh open with no recorded moves has nothing better to go
     * on, and showing nothing would be worse. Inside one, the only line that is not a lie is the
     * line already on the board, so that is what stands until the session ends.
     *
     * This is a ref written during render, which React does not officially bless. It is here
     * anyway, and the file already does it two lines above (`lineSansRef.current = null`), for the
     * same reason: this value cannot be derived, only remembered, and a `useState` would re-render
     * the board to store a fact about the board.
     */
    if (sessionLiveRef.current && lastLineRef.current.length > 0) {
      return lastLineRef.current;
    }
    lineSansRef.current = null;
    const byIndex = lineRef.kind === 'main'
      ? openFamily.steps
      : (openFamily.alternates[lineRef.index] ?? openFamily.steps);
    lastLineRef.current = byIndex;
    return byIndex;
  }, [openFamily, lineRef, overrideLine]);

  /**
   * THE LIVE LINE = THE RESOLVED LINE WITH EVERY VERDICT THAT HAS LANDED.
   *
   * `withVerdicts` swaps each step's position record for the analysed one by KEY
   * and re-derives its `choice` with the same rules the line was built with. It
   * moves nothing: the SANs, plies, FENs and order are byte-for-byte the ones the
   * session is already playing, so `stepIdx` cannot fall out of step and the
   * `walkTo` timer's captured array still agrees by index. What changes is what
   * the user can SEE at a decision — the engine's verdict on his move, the
   * evaluations, and (out of book) the recommendation — which is the whole of
   * "show me where I made a mistake and what to play instead".
   */
  const livePositions = useMemo(
    () => (openFamilyId == null ? [] : analysedRef.current.get(openFamilyId) ?? []),
    // `verdictsTick` is the trigger: the ref itself does not re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openFamilyId, verdictsTick],
  );

  const activeLine: BuilderStep[] = useMemo(
    () => withVerdicts(resolvedLine, livePositions),
    [resolvedLine, livePositions],
  );

  /* --------------------------------------------------------------- play loop */

  /** Adopt a move at a step, so it feeds the Train drill. */
  /**
   * QUEUE AN ADOPTION; FLUSH THE BATCH, NOT THE MOVE.
   *
   * This started as a straight `await saveAdoption(...)` per ply, and that was a
   * regression the user reported as *"i can no longer click and move pieces"*.
   *
   * Three separate things went wrong, all from doing a full write per ply:
   *
   *   1. `saveAdoption` re-read and rewrote the ENTIRE custom repertoire every
   *      time. A 12-ply line meant 12 read-modify-writes of a document that grows
   *      with every decision the user has ever made.
   *   2. It returned a freshly-parsed object, assigned straight to `setRepertoire`.
   *      So the whole screen re-rendered on every ply — WHILE THE USER WAS DRAGGING
   *      A PIECE. That is the touch failure: not "slow", but the gesture interrupted
   *      by a re-render that had no business happening between picking a piece up
   *      and putting it down.
   *   3. It fired the "Saved X to your repertoire" toast on every ply, so a passive
   *      full-width absolutely-positioned bar sat on screen for most of the line.
   *
   * The RECORDING is unchanged and still happens for every move — that was the whole
   * point of it. Only the WRITING is batched: moves accumulate in a ref and are
   * written once, on a short debounce. An abandoned line still keeps everything
   * played up to that point, because the debounce is short, and a failed write puts
   * its batch back rather than losing the user's moves.
   */
  const pendingRef = useRef<CustomLine[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushingRef = useRef(false);

  const flushAdoptions = useCallback(async () => {
    if (flushingRef.current) return;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    flushingRef.current = true;
    try {
      const next = await saveAdoptions(batch);
      if (!aliveRef.current) return;
      // ONE state change per batch, not one per move.
      setRepertoire(next);
      setJustSaved(batch[batch.length - 1].adoptedSan);
      setTimeout(() => { if (aliveRef.current) setJustSaved(null); }, 1400);
    } catch {
      // Put them back: a failed write must not silently discard the user's moves.
      pendingRef.current = [...batch, ...pendingRef.current];
    } finally {
      flushingRef.current = false;
    }
  }, []);

  const queueAdoption = useCallback((step: BuilderStep, opt: MoveOption, prefixSan: string[]) => {
    /*
     * A LINE MUST BE RECORDED WITHOUT A `GamePosition`.
     *
     * This was `if (!p) return`, and that guard silently discarded most of what the
     * user did. `position` is only set on a step derived from a real game position;
     * every step from `withBookTail` — the whole book continuation, i.e. most of a
     * typical Sicilian line — carries `position: null`, because there was no game
     * behind it. Twelve moves played, three recorded, line finished, Train said "you
     * have not practiced anything".
     *
     * Nothing needed is missing. A `CustomLine` wants a position key, the FEN the move
     * is played FROM, and the move order leading to it; the screen has all three, so
     * the record is built from the STEP instead of from the game it may not have come
     * from. `engineBestSan` and `selfDiscovered` are the only fields that truly need
     * the game, and both have honest answers without one: null, and true for a book
     * continuation, since the app's own book taught the move.
     */
    const p = step.position;
    const side = step.side === 'w' ? 'w' : 'b';
    const key = p ? p.key : `${step.fen.split(' ').slice(0, 4).join(' ')}|${side}`;
    pendingRef.current.push({
      key,
      fen: step.fen,
      adoptedUci: opt.uci,
      adoptedSan: opt.san,
      prevSan: prefixSan.length ? prefixSan[prefixSan.length - 1] : null,
      prefixSan: [...prefixSan],
      engineBestSan: p?.options[0]?.san ?? null,
      opening: p?.opening ?? step.opening ?? 'Your openings',
      // The join key for the per-opening rank. See CustomLine.openingId.
      openingId: step.openingId ?? null,
      decidedAt: Date.now(),
      selfDiscovered: p ? !p.inBook : true,
    });
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    // Short enough that an abandoned line still records, long enough that a normally
    // paced line is written once rather than per ply.
    flushTimerRef.current = setTimeout(() => { void flushAdoptions(); }, 700);
  }, [flushAdoptions]);

  const adopt = useCallback(async (step: BuilderStep, opt: MoveOption, prefixSan: string[]) => {
    queueAdoption(step, opt, prefixSan);
  }, [queueAdoption]);

  /**
   * Advance the board to the next step that needs the user.
   *
   * THE AUTO-PLAY STOPS AT THE USER'S OWN MOVES, NOT ONLY AT DECISIONS.
   *
   * It used to play every step that had no `choice` for him, which meant the
   * whole line was played out the moment there was no question left to ask — and
   * a line whose questions come from the engine had none at first paint, so
   * opening a card played the entire line instantly and painted "line complete"
   * over a board the user had never touched. That is the "what line did i
   * complete? i just played one move" report: he had played one move because the
   * app had played the other eleven for him.
   *
   * A `choice` is a step where the user MAY pick between his move and ours. A
   * step with `isUserMove` and no choice is still HIS move — we show it with an
   * arrow and he plays it. Only the opponent's replies are played for him. That
   * is what makes "complete the line with him" true, and it is why a line is now
   * a session rather than a single tap.
   */
  const goTo = useCallback((steps: BuilderStep[], from: number) => {
    let i = from;
    const sans: string[] = [];
    for (let k = 0; k < from; k++) sans.push(steps[k].moveSan);
    // Play the opponent's replies; stop on anything that is the user's to answer.
    while (i < steps.length && !needsUser(steps[i])) {
      sans.push(steps[i].moveSan);
      i++;
    }
    // Every place that sets `stepIdx` records WHICH array it set it against, so
    // the re-sync effect can tell a line we chose from a line that was swapped in
    // underneath us. `goTo` is the single place that does it for a start, a
    // restart and "Back a move"; `onBoardMove` does it for a divergence.
    syncedLineRef.current = steps;
    setPlayedSans(sans);
    setStepIdx(i);
    setFeedback(null);
  }, []);

  /*
   * WALK THE LINE, ONE PLY AT A TIME.
   *
   * THE BUG THE USER REPORTED: *"i choose two moves and it tells me we are finished - it
   * should continue showing me all the line."*
   *
   * `goTo` above fast-forwards: it loops over every step that is not the user's to answer
   * and pushes them all into `playedSans` in a single tick, landing on the next question -
   * or, when the rest of the line has no further question, landing on `steps.length`. That
   * last case is the report. Two moves in, the board is instantly snapped to the end of
   * the line, `stepIdx === total`, and the screen declares the line complete while most of
   * it was never shown.
   *
   * "Complete" has to mean the line was actually played, not that there is nothing left to
   * ASK. So the line is walked a ply at a time, and the walk stops only on a step that is
   * genuinely the user's to answer, or at the real end. Everything in between is shown.
   *
   * `setStepIdx` is used with its updater form so each tick reads the live index; a timer
   * that captured a stale `stepIdx` would double-advance or stall whenever a render landed
   * between ticks.
   */
  const walkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /*
   * WHAT IS ON THE BOARD, MIRRORED INTO A REF.
   *
   * The re-sync effect below has to answer "is the line the engine just published the line
   * we are already playing?", and the answer needs the moves currently shown. Listing
   * `playedSans` as a dependency would re-run that effect on every single ply, so it is
   * mirrored here instead - written wherever the board's move list is set, so the two can
   * never disagree.
   */
  const shownSansRef = useRef<string[]>([]);

  /*
   * FIVE PIECES OF STATE FOR THE TEST AND THE MISTAKE REPLAY, DECLARED HERE ON PURPOSE.
   *
   * They began further down this component, beside the play-loop documentation that explains them,
   * which reads better and does not work: `replayTo` is defined ABOVE that point and both calls
   * `setReplayTarget`, so at the moment its body runs the setter did not exist. That is precisely
   * the fault GATE 1k §6 was written for — `TypeError: Cannot set property 'current' of undefined`
   * from a `useMemo` that used a ref declared 390 lines later — and it was made a second time in the
   * same file, one feature after the check that exists to prevent it.
   *
   * So they sit with the other walk state, above every function that touches them, and the gate
   * keeps them there. The tidier arrangement is the one that crashes.
   */

  /**
   * A MOVE THE USER GOT WRONG, WAITING TO BE PLAYED AGAIN.
   *
   * The user asked for this exactly: *"when i make a mistake when i am learning (not train mode),
   * the app shows me that it is wrong and what is the right move and then repeats the movement
   * automatically until it gets to the wrong move and lets me play it myself, then we continue."*
   *
   * The replay is not decoration. Standing on a board several moves past a blunder, with a message
   * saying the move was wrong, asks the user to reconstruct the position from memory — which is the
   * opposite of learning it. Putting the board back to that exact position means the thing he does
   * next is the thing he got wrong, once, deliberately. That is what makes the correction land.
   *
   * `ply` is the step index the mistake happened AT, so the replay has a destination rather than a
   * length, and `san` is the move that belongs there, so the retry can be graded without
   * re-deriving anything.
   */
  /*
   * A RECORDED MISTAKE, WITH BOTH MOVES ON IT.
   *
   * `ply` and `san` are for the message a person reads. `playedUci` and `recommendUci` are for the two
   * arrows drawn beside it — the request was explicitly for both: *"it should show me arrows that my
   * move is mistake and shows me what to play not just a message"*. Either may be null, because a
   * line can be wrong on a move whose squares cannot be recovered from the position we still hold;
   * the arrow is then simply omitted rather than guessed.
   */
  /*
   * THE TEST QUEUE.
   *
   * A test is a list of positions to answer, not a position. `queue` holds what is still OUTSTANDING;
   * a wrong answer puts its position back on the end, which is what makes the loop run until the
   * user has them all right rather than until they have been lucky once.
   *
   * Counters rather than derived state, because they are cumulative over a session and the queue is
   * shuffled and re-appended: "3 of 7" cannot be recomputed from what is left.
   */
  const testQueueRef = useRef<ReturnType<typeof askablePositions<{ id: string; steps: BuilderStep[] }>>>([]);
  const testAskedRef = useRef(0);
  const testCorrectRef = useRef(0);
  const testTotalRef = useRef(0);

  /*
   * WHERE EACH POSITION SITS IN THE LOOP: to-do, mistake, unclear, correct.
   *
   * A ref, not state, because the loop is driven by the answer handler rather than by rendering, and
   * a re-render in the middle of an answer must not rebuild it. `testPoolVersion` is what makes it
   * visible to the header - the same pattern the queue's own counter already uses, and for the same
   * reason: a ref change does not re-render, so a header reading a ref would show the answer to the
   * previous question.
   */
  const testStatesRef = useRef<Map<string, OpeningLoopState>>(new Map());

  /**
   * Move one position to its next loop state, and say what happened.
   *
   * The message comes from the shared `loopMessage`, so the openings drill and the trainer report a
   * transition in the same words. It replaces the drill's own "Not this one - here it is X" only for
   * the STATE, not for the correction: the correction still has to name the move, and that is the
   * screen's own text.
   */
  const markTestResult = useCallback((id: string, clean: boolean) => {
    if (!id) return;
    const prev = testStatesRef.current.get(id) ?? 'todo';
    const next = nextLoopState(prev, clean);
    testStatesRef.current.set(id, next);
    setPoolVersion((v) => v + 1);
    return loopMessage(prev, next);
  }, []);

  const [mistake, setMistake] = useState<{
    ply: number;
    san: string;
    playedUci: string | null;
    recommendUci: string | null;
    /*
     * WHY THIS FIELD EXISTS, AND WHY IT IS NOT A DETAIL.
     *
     * "That is not this line" and "that is a mistake" are different facts, and the app used to
     * treat them as one. Playing 2.e3 against a study that says 2.c4 is not an error — e3 is a real
     * move in the Queen's Gambit Accepted and a perfectly sensible one. It simply is not the move this
     * particular study takes. Labelling it a blunder is simply wrong, and it is the same complaint as
     * *"you keep refering for my moves as blunder while they are not"*, arriving by a different road
     * than the eval-sign bug: that one inverted the numbers, this one graded a legitimate alternative
     * as a failure to agree.
     *
     * So a deviation is named as a deviation, in neutral words, with NO red arrow. A red arrow is
     * reserved for a move the ENGINE judged worse than the alternative — which is a different code
     * path, and the only one entitled to the word "mistake".
     */
    severity: 'deviation' | 'mistake';
  } | null>(null);

  /**
   * WHERE A REPLAY IS HEADED, OR null.
   *
   * The board is not the user's while the moves are being played back to him. A touch that began
   * before the replay reached the position would otherwise be graded as a second failed attempt at a
   * board he has not been shown yet — which is not a correction, it is the app blaming him for
   * looking. So the board goes non-interactive for exactly the length of the replay.
   */
  const [replayTarget, setReplayTarget] = useState<number | null>(null);
  const replaying = replayTarget !== null && stepIdx < replayTarget;

  /*
   * THE BOARD UNLOCKS THE MOMENT THE REPLAY LANDS.
   *
   * `replayTo` can only set the destination, not know when the timer got there, so the transition is
   * watched here. Without this the board would stay locked for the rest of the session: `replayTo`
   * sets a target, `replaying` compares the step index against it, and nothing ever clears it. A
   * locked board is the most confusing failure this screen can have, because it looks exactly like
   * a broken one.
   */
  useEffect(() => {
    if (replayTarget !== null && stepIdx >= replayTarget) setReplayTarget(null);
  }, [stepIdx, replayTarget]);

  /**
   * WHETHER THE CURRENT POSITION IS BEING GRADED, the pool to draw from, and the last position
   * asked, so a test does not ask the same thing twice running when it has a choice.
   *
   * *"i want you to give me random positions like the train does (from what i studied: the current
   * line and the previous ones) and i try them to make sure i learned, exactly like in train mode.
   * But keep the train mode so i could practice these lines whenever i want."*
   *
   * So this is a THIRD thing, deliberately not a fourth: Train stays exactly as it is for
   * practising, and this is the check. The difference from learning is the only thing that matters —
   * in learning, the move the user played is kept and recorded as their repertoire, because the
   * repertoire is theirs. In a test there is no repertoire to protect, so the move we teach is the
   * only right answer and anything else is a mistake, which is what puts a position on the
   * `mistake` path above and makes the rings mean something.
   */
  const [testing, setTesting] = useState(false);
  const testPoolRef = useRef<{ id: string; steps: BuilderStep[] }[]>([]);
  const lastTestRef = useRef<string>('');

  /**
   * Bumped whenever the test pool changes, so the count below is a pure derivation that re-runs.
   *
   * The pool is a ref, because it is written from a completion effect and read from an event
   * handler, and neither wants a re-render. But a ref cannot drive the BUTTON: a ref change does not
   * re-render, so a count derived from one would leave the button showing a stale answer. This is the
   * same bug as the one it fixes, approached from the other side — the handler and the button have to
   * agree, and the only reliable way to make a ref visible to render is a version to depend on.
   */
  const [poolVersion, setPoolVersion] = useState(0);
  /*
   * THE FOUR STATES, SPOKEN ONLY WHEN THEY SAY SOMETHING.
   *
   * "6 positions left" tells the user how much work is queued and nothing about what state it is in -
   * and the state is the part that answers "do the loop too". A header that always printed all four
   * counts would read `0 to confirm` on a first run, which is noise about a position the user has not
   * met. So only the non-zero ones are named, and a run where everything is still to-do says nothing
   * at all, because then there is nothing to report.
   */
  const loopSummary = useMemo(() => {
    if (!testing) return '';
    const c = loopCounts([...testStatesRef.current.values()].map((state) => ({ state })));
    const parts: string[] = [];
    if (c.solved > 0) parts.push(`${c.solved} done`);
    if (c.unclear > 0) parts.push(`${c.unclear} to confirm`);
    if (c.mistake > 0) parts.push(`${c.mistake} to get right`);
    return parts.length ? ` - ${parts.join(', ')}` : '';
  }, [testing, poolVersion]);

  const stopWalk = useCallback(() => {
    if (walkTimerRef.current !== null) {
      clearInterval(walkTimerRef.current);
      walkTimerRef.current = null;
    }
  }, []);

  const walkTo = useCallback((steps: BuilderStep[], from: number) => {
    stopWalk();
    // Record WHICH array the index is being set against, or the re-sync effect treats the
    // user's own divergence as an engine swap and restarts on top of it.
    syncedLineRef.current = steps;
    const seed = steps.slice(0, from).map((s) => s.moveSan);
    shownSansRef.current = seed;
    setPlayedSans(seed);
    setStepIdx(from);
    setFeedback(null);
    if (from >= steps.length) return;
    if (needsUser(steps[from])) return;   // already standing on a question
    walkTimerRef.current = setInterval(() => {
      setStepIdx((prev) => {
        const next = prev + 1;
        setPlayedSans(steps.slice(0, next).map((s) => s.moveSan));
        if (next >= steps.length || needsUser(steps[next])) stopWalk();
        return next;
      });
    }, WALK_MS);
  }, [stopWalk]);

  // A walk in flight must not outlive the screen, or its timer keeps calling setState on an
  // unmounted component.
  useEffect(() => () => stopWalk(), [stopWalk]);

  /**
   * PLAY THE LINE BACK TO A NAMED PLY, THEN STOP AND WAIT.
   *
   * The sibling of `walkTo`, and the difference is the whole point. `walkTo` JUMPS to a question
   * and, if the destination is the user's to answer, returns without starting a timer. This one
   * PLAYS: it starts at move one and advances on the same cadence the opening walkthrough uses,
   * because the user asked to see the moves repeated - "then repeat the movement automatically until
   * it gets to the wrong move". It stops on the destination, not on the first question, because the
   * destination IS the question he has to answer again.
   *
   * Written as a timer over the same `steps` array rather than by rewinding and calling `walkTo`,
   * so the board and the step index cannot disagree: there is one list and one index, exactly as
   * the continuation fix requires.
   */
  const replayTo = useCallback((steps: BuilderStep[], target: number) => {
    stopWalk();
    syncedLineRef.current = steps;
    shownSansRef.current = [];
    setPlayedSans([]);
    setStepIdx(0);
    const clamped = Math.max(0, Math.min(target, steps.length));
    setReplayTarget(clamped);
    if (clamped === 0) return;
    walkTimerRef.current = setInterval(() => {
      setStepIdx((prev) => {
        const next = prev + 1;
        if (next >= clamped) {
          stopWalk();
          return clamped;                 // the destination: his move, and the board is on it
        }
        setPlayedSans(steps.slice(0, next).map((s) => s.moveSan));
        return next;
      });
    }, WALK_MS);
  }, [stopWalk]);

  /**
   * START A TEST: A RANDOM POSITION FROM WHAT HE HAS STUDIED.
   *
   * *"random positions like the train does (from what i studied: the current line and the previous
   * ones)"*. The pool is exactly that and nothing else - the line in front of him, plus the ones he
   * has already finished in this opening - so every question is about material he has actually been
   * shown, which is the difference between a test and a surprise.
   *
   * The position is reached by REPLAYING the line up to it rather than by dropping the user into the
   * middle of a board. Two reasons, and the second is the important one:
   *
   *   - the opponent's replies are part of what he is learning to recognise, and skipping them
   *     teaches him to recognise a position he will never meet;
   *   - `replayTo` keeps ONE list and ONE index, so the board and the step the user is being asked
   *     about cannot drift apart, which is the fault the continuation fix already had to repair
   *     once. A test built by jumping to an index would invite the same bug back.
   *
   * A position is only asked if it is a real one: a step with a `choice` and a position key. A book
   * move has no position, so there is nothing to have learned and nothing to be asked about.
   */
  const startTest = useCallback(() => {
    if (!openFamily) return;
    // THE SAME HELPER the button's count uses, computed at press time rather than closed over from
    // render. A `useCallback` here would capture whichever `testPlaces` was current when it was
    // last rebuilt, and the memo's own deps change on things this callback knows nothing about.
    const askable = testPlacesFor(testPoolNow(), openFamily.side);
    if (askable.length === 0) {
      // Still nothing: a line with no ply of the trained side, which is not a line anyone can
      // practise. Said rather than swallowed, because the alternative is a tap that does nothing.
      setFeedback({
        ok: false,
        text: 'This line has no position of yours to be asked about — try one of your own lines.',
      });
      return;
    }

    /*
     * THE QUEUE IS THE WHOLE POOL, SHUFFLED - NOT ONE POSITION DRAWN FROM IT.
     *
     * Asked for directly: *"in the test i said it should be many to do and as a train loop until i get
     * them all correct not just one position"*. Drawing a single position and calling that a test is
     * what produced a screen that asked one question and then sat there still flagged as testing.
     *
     * A wrong answer puts its position BACK on the queue rather than dropping it, which is the whole
     * difference between "keep going until you get them all" and "keep going until you get lucky".
     * Shuffling means the queue is not the book's order, so the same position is not always first.
     */
    testQueueRef.current = askable
      .map((a) => ({ a, sort: Math.random() }))
      .sort((x, y) => x.sort - y.sort)
      .map((x) => x.a);
    /*
     * EVERY POSITION STARTS AT TO-DO, whatever its stored counters say.
     *
     * The loop is about what has been CONFIRMED in this drill, and a position answered in an earlier
     * session has not been confirmed here. Reopening it as `todo` is also what keeps the four states
     * meaningful: a pool that arrived with half its positions already `solved` would report a
     * finished opening the user has not opened.
     */
    testStatesRef.current = new Map(askable.map((a) => [a.id, loopStateForNewSession()]));
    testAskedRef.current = 0;
    testCorrectRef.current = 0;
    testTotalRef.current = askable.length;

    setTesting(true);
    setMistake(null);
    const chosen = testQueueRef.current[0];
    if (!chosen) return;
    lastTestRef.current = chosen.id;

    setTesting(true);
    setMistake(null);
    setOverrideLine(chosen.line.steps);
    setLineRef(lineRef);                      // the family line is unchanged; the ply is the question
    answeredRef.current = false;
    setFeedback({ ok: true, text: 'Find your move here.' });
    replayTo(chosen.line.steps, chosen.ply);
  // `testPoolNow` and `noTestReason` are deliberately NOT in this array: both are declared further
  // down, and a dep array is evaluated during render, so naming them here would be a TDZ crash.
  // Neither can make this stale anyway — `testPoolNow` depends only on `activeLine`, which is
  // already here, and `noTestReason` is read on an empty-pool branch that also cannot go stale.
  }, [openFamily, activeLine, lineRef, replayTo]);

  /** Back out of a test, to plain learning, without leaving the line. */
  const endTest = useCallback(() => {
    setTesting(false);
    setMistake(null);
    lastTestRef.current = '';
  }, []);

  /**
   * MOVE THE TEST ON: ask the next outstanding position, or finish it.
   *
   * Called after a CORRECT answer. The position just answered is dropped from the front; if a wrong
   * answer has already put it back, dropping is a no-op and it comes round again — so a position the
   * user cannot find keeps being asked until they can, which is the loop that was asked for.
   *
   * When the queue empties, the test ENDS and says how it went. It does not sit on a finished line
   * still flagged as testing, which is where the old single-position test left the screen.
   */
  const advanceTest = useCallback(() => {
    testQueueRef.current = testQueueRef.current.filter((p) => p.id !== lastTestRef.current);
    const next = testQueueRef.current[0];
    testCorrectRef.current++;
    testAskedRef.current++;
    /*
     * THE LOOP, ON A CORRECT ANSWER TOO.
     *
     * A clean pass is not always "solved". A position answered wrongly earlier and right now goes to
     * `unclear`, and only a second clean pass solves it - the trainer's rule, kept because it is the
     * rule the user described. Getting that wrong in the drill's favour would report a position as
     * known after one right answer, which is the whole thing `unclear` exists to prevent.
     */
    const loopLine = markTestResult(lastTestRef.current, true);
    if (!next) {
      const correct = testCorrectRef.current;
      const total = testTotalRef.current;
      const counts = loopCounts([...testStatesRef.current.values()].map((state) => ({ state })));
      setTesting(false);
      setMistake(null);
      testQueueRef.current = [];
      setFeedback({
        ok: true,
        text: counts.mistake === 0 && counts.unclear === 0
          ? `Test complete — all ${total} position${total === 1 ? '' : 's'} correct.`
          : `Test complete — ${counts.solved} solved, ${counts.unclear} to confirm, `
            + `${counts.mistake} still to get right.`,
      });
      /*
       * THE TEST'S OWN MOMENT. Finishing the queue is the achievement the whole tab builds to,
       * and the feedback line alone is easy to miss while looking at the board. The figure passed
       * here is the same one the line above states, so the banner cannot disagree with it.
       */
      completeSession('test', counts.mistake === 0 && counts.unclear === 0
        ? `all ${total} position${total === 1 ? '' : 's'} correct`
        : `${counts.solved} solved, ${counts.unclear} to confirm, ${counts.mistake} still to get right`);
      return;
    }
    lastTestRef.current = next.id;
    setMistake(null);
    setOverrideLine(next.line.steps);
    answeredRef.current = false;
    setFeedback({ ok: true, text: 'Find your move here.' });
    replayTo(next.line.steps, next.ply);
  }, [replayTo, completeSession]);

  /**
   * THE SHIPPED STUDIES THIS LINE ACTUALLY COVERS.
   *
   * *"in the apps openings there is no advancement for your progress ( always 0)"*, and the reason is
   * the same missing writer as the rings: `0/114 started` counts studies with `attempts > 0` in the
   * SRS, and the only thing that ever wrote an attempt was a Train session. A line drilled to the
   * end in "Your openings" — where the user spends his time — moved nothing at all, so the count was
   * structurally pinned at zero.
   *
   * THE HONEST VERSION OF THIS, which is the only version worth shipping: a study is marked when the
   * line the user played REACHED it, not merely because the line belongs to the same opening.
   * "You drilled a Sicilian line" is not evidence you have touched the Sveshnikov, and marking all
   * 114 on the first line would make the number move and mean nothing. So the line is walked and
   * every study whose own opening move order is a prefix of what was played is credited.
   *
   * A line from the user's own games that we do not teach credits nothing, and that is correct: there
   * is no study to have started.
   */
  const studiesCoveredBy = useCallback((sans: string[]): string[] => {
    if (sans.length === 0 || !openFamily) return [];
    const out = new Set<string>();
    // The study the line's tail came from is covered by definition — it was played, not just matched.
    for (const s of activeLine) if (s.fromStudy) out.add(s.fromStudy);
    for (const s of activeLine) {
      const id = s.openingId;
      if (!id) continue;
      // `studyForLine` is the same lookup the "read our study" button uses, so the study credited
      // here is the one the user is offered to read. Crediting a different one would be a second,
      // quietly different notion of "the study for this line".
      const hit = studyForLine(sans);
      if (hit) { out.add(hit.id); break; }
      void id;
    }
    return [...out];
  }, [openFamily, activeLine]);

  /**
   * MARK A LINE'S STUDIES AS STARTED, and move their mastery.
   *
   * `attempts` is what `openingProgress` counts, and `mastery` is what raises a study's level. Both
   * are written through `applyResult` normally; here they are written through the same store path so
   * a study cannot acquire two different definitions of "attempted".
   */
  const recordStudiedStudies = useCallback((sans: string[]) => {
    const ids = studiesCoveredBy(sans);
    if (ids.length === 0) return;
    for (const id of ids) {
      if (!findStudyWithOpening(id)) continue;
      /*
       * `type: 'opening'` with the counters at zero, because this is not a quiz result being scored.
       * It is a note that a study was reached. `applyResult` adds XP from `payload.xp` and nothing
       * else, so zero here is what keeps the drill from paying out as though a session happened.
       */
      applyResult({
        type: 'opening',
        correct: 0,
        total: 0,
        xp: 0,
        study: { studyId: id, mastery: 0.25, level: 1, perfectRuns: 0, bestStreak: 0 },
        positions: [],
      });
    }
  }, [studiesCoveredBy, applyResult]);

  /**
   * Start (or restart) the active line, WALKING it rather than jumping to a question.
   */
  const startLine = useCallback(() => {
    const steps = activeLine;
    if (steps.length === 0) return;
    walkTo(steps, 0);
  }, [activeLine, walkTo]);

  /**
   * THE LINE AND THE INDEX MUST NEVER BE DERIVED FROM DIFFERENT ARRAYS.
   *
   * `stepIdx` is an integer. `activeLine` is an array that gets REPLACED —
   * whenever the engine publishes and the family is re-rotated. Nothing about an
   * integer survives that, so after a publish the screen would be reading
   * `newArray[oldIndex]`, and the instruction would belong to a different line
   * from the one the board had been showing.
   *
   * The old guard was the 0 -> n restart, and it only fires when the decision
   * count rises from zero. A publish that merely CHANGED the line (the common
   * case: the engine's verdicts move a decision from one ply to another) left the
   * two out of step permanently. That is the device report: an instruction for
   * `cxd4` over a board where it is not playable.
   *
   * So the invariant is enforced by identity instead of by a counter: whenever the
   * active line is an array we did NOT choose, restart on it. A divergence the
   * user just made is an array we DID choose — `onBoardMove` sets `overrideLine`
   * and then sets `stepIdx` itself, in the same tick — and is left alone, so
   * taking our recommendation still does not throw his moves away.
   */
  const syncedLineRef = useRef<BuilderStep[] | null>(null);

  useEffect(() => {
    if (phase !== 'play') return;
    if (activeLine.length === 0) return;
    if (syncedLineRef.current === activeLine) return;   // our own divergence
    if (answeredRef.current) return;                   // a session in progress

    /*
     * THE ENGINE RE-PUBLISHED THE LINE WE ARE ALREADY PLAYING - DO NOT REPLAY IT.
     *
     * THE BUG THE USER REPORTED: *"when i try an opening it keep repeating the moves 3
     * times before i could choose between my move and the suggested move"*.
     *
     * `activeLine` is re-DERIVED every time the engine publishes a verdict, so it arrives as
     * a NEW array even when the moves are identical - the decisions now carry an eval where
     * they carried none. This effect could only see a new array, and its only answer was
     * `startLine()`, which walks from move 1. So the opening moves were played again, waited
     * out, and played again - once per publish - before the first question appeared. Three
     * times is what the analysis pass takes to settle.
     *
     * A re-publication that AGREES with what is already on the board is not a new line, it
     * is the same line with better data, so it is adopted in place and the walk continues
     * from where it stands. Only a line that actually disagrees - a different opening, a
     * different move order - restarts from the beginning, which is the one case where
     * replaying is correct.
     *
     * Comparing SANs rather than array identity is the whole point: identity changes on every
     * verdict, the moves do not.
     *
     * AND ONCE A LINE IS ON THE BOARD, A DISAGREEMENT IS NOT ENOUGH TO RESTART.
     *
     * The paragraph above says a disagreeing line "restarts from the beginning, which is the
     * one case where replaying is correct". That was wrong, and it is what let the third
     * symptom through. A disagreement here does not mean the engine learned something new about
     * the line - `buildFamilyLines` re-runs the POOL ROTATION, which prefers positions carrying
     * decisions, so a rebuilt family is a different SELECTION rather than a better version of
     * the same one. Restarting onto it does not correct anything: it swaps a line the user
     * chose for one the rotation preferred, mid-walk, and the short decision-bearing fragments
     * that rotation favours are exactly the lines that finish after a move or two.
     *
     * So a session is a session. The moves the user is playing are the moves they keep, and the
     * richer line is taken when the session ends rather than under the board. `publish` is
     * stopped from doing this at the source; this is the second lock, and it is here because a
     * single guard is a single point of failure - which is the lesson of this whole bug.
     */
    if (sessionLiveRef.current) return;
    const shown = shownSansRef.current;
    if (shown.length > 0) {
      const n = Math.min(shown.length, activeLine.length);
      let agrees = true;
      for (let i = 0; i < n; i++) {
        if (activeLine[i].moveSan !== shown[i]) { agrees = false; break; }
      }
      if (agrees) {
        // Adopt the richer line and carry on. `walkTo` is safe to call while a walk is in
        // flight: it stops the old timer first, and with `stepIdx` already on a question it
        // returns without starting a new one.
        walkTo(activeLine, Math.min(stepIdx, activeLine.length));
        return;
      }
    }
    startLine();
  }, [phase, activeLine, startLine, stepIdx, walkTo]);

  /*
   * Opening a different family or a different sibling line starts over: any
   * continuation the user's earlier choices produced belongs to the line they
   * were playing, not to this one.
   */
  useEffect(() => {
    /*
     * THE SESSION FLAG IS SET HERE, ABOVE THE EARLY RETURN.
     *
     * It was originally written at the bottom of this effect, next to `stopWalk()`, which reads
     * more tidily and is wrong: the first line of the effect is `if (phase !== 'play') return;`, so
     * leaving the play phase skipped the assignment entirely and the flag stayed `true` for the
     * rest of the screen's life. `publish()` would then never rebuild a family again — the engine
     * verdicts would be recorded and never applied, on this opening or any later one. A guard that
     * cannot be turned off is not a guard, it is a decision made once by accident.
     *
     * So it is set from `phase` on every run of the effect, in either direction. GATE 1k asserts
     * that this assignment is not below an early return, because the mistake is invisible in review
     * and produces no error at all — the app simply stops learning.
     */
    sessionLiveRef.current = phase === 'play';
    if (phase !== 'play') return;
    setOverrideLine(null);
    // A stale pending position belongs to the line that was just left.
    setPendingFen(null);
    // A fresh line: nothing has been answered yet, so the engine may still
    // restart it (see the restart effect below).
    answeredRef.current = false;
    /*
     * The recorded moves follow the LINE, not the family.
     *
     * This effect fires when `openFamilyId` OR `lineRef` changes, and `lineRef` changes whenever
     * a sibling is selected with the left/right controls inside the play view - which is a
     * different line, and would otherwise still be resolved by the moves of the previous one.
     * Re-recording here is wrong too (the moves are not known yet), so the ref is simply cleared
     * and `activeLine` resolves by index for one render, exactly as it did before any of this.
     */
    if (openFamilyId && lineSansRef.current) {
      const f = families.find((x) => x.id === openFamilyId);
      const idx = lineRef.kind === 'main' ? 0 : lineRef.index;
      const cand = lineRef.kind === 'main' ? f?.steps : f?.alternates[idx];
      lineSansRef.current = cand ? cand.map((s) => s.moveSan) : null;
    }
    /*
     * RESET THE "THIS LINE WAS ALREADY FLUSHED" MARKER, NOT COMPARE IT BY LENGTH.
     *
     * The completion effect guards on `lineFinishedRef.current === total`, and `total` is
     * the LENGTH of the line. Two lines of the same length - which is the normal case, since
     * lines from the user's games cluster around the same game length - therefore collided:
     * the first line set the marker to 20, the second line was also 20 plies, so the guard
     * matched and `flushAdoptions` never ran. Nothing was written, and Train then reported
     * "no train yet" about a line the user had just played to the end. That is the report:
     * *"i clicked on train and it says no train yet although i completed the line"*.
     *
     * The marker answers "have I flushed THIS line", so it has to be cleared when the line
     * changes. Comparing lengths answers a different question, and the wrong one.
     */
    lineFinishedRef.current = 0;
    stopWalk();
    // The `startLine` below runs against the spine, because clearing the
    // override has already made `activeLine` the spine again.
  }, [phase, openFamilyId, lineRef]);

  useEffect(() => {
    if (phase !== 'play') return;
    startLine();
    // Deliberately keyed on the phase and the chosen line, not on `startLine`
    // (which is recreated whenever `activeLine` changes identity).
  }, [phase, openFamilyId, lineRef]);

  /** How many real questions this line asks the user. */
  const decisionsInLine = useMemo(
    () => activeLine.filter((s) => s.choice != null).length,
    [activeLine],
  );

  /**
   * START THE LINE AGAIN WHEN THE ENGINE TURNS IT FROM A WALKTHROUGH INTO A QUIZ.
   *
   * THE BUG THIS FIXES
   * ------------------
   * The list is painted from ENGINE-FREE positions, and a position only carries a
   * decision when we ship a book for the opening (`stepFor` needs
   * `recommendUci !== playedUci`, and without a book the recommendation falls
   * back to the user's own move). So for every opening we do NOT ship, the first
   * paint produces a line with no questions in it — measured on the reference
   * corpus, 29 of 39 families.
   *
   * `startLine` then does the only thing it can: with no decision to stop at it
   * walks the whole line, lands on the last ply, and the view renders "line
   * complete" over a board with `interactive={false}`. The engine verdicts that
   * WOULD have supplied the questions arrive a second later — and nothing
   * restarted, because the restart effect above keys on the family and the line,
   * neither of which changed. The user taps a card, gets a dead finished board,
   * taps it again, gets the same thing: "it's like a fake button".
   *
   * The transition that matters is exactly 0 -> n, and only that. A line the user
   * is already part-way through must NOT be restarted when later verdicts land,
   * which is why this compares against the previous count instead of firing on
   * every change.
   *
   * AND NEVER ONCE HE HAS MOVED. The verdicts arrive while he is playing, so a
   * restart is not free: it throws away the moves he has already made and snaps
   * the board back to the start of the line. The choices for the positions he has
   * not reached yet appear as he reaches them anyway, so there is nothing to gain
   * and a session to lose. `answeredRef` is the guard, set by `onBoardMove` and
   * cleared whenever a different line is opened.
   */
  const prevDecisionsRef = useRef<number | null>(null);

  const answeredRef = useRef(false);

  /*
   * LINE-COMPLETION STATE — HOISTED OUT OF THE PLAY BLOCK ON PURPOSE.
   *
   * These five values and the effect below used to live inside
   *
   *     if (phase === 'play' && openFamily) { ... }
   *
   * which is a RULES-OF-HOOKS VIOLATION, and it is what crashed the screen. The device
   * log is unambiguous:
   *
   *     com.facebook.react.common.JavascriptException:
   *       Error: Rendered more hooks than during the previous render.
   *     ... updateEffectImpl -> GameOpeningsScreen
   *
   * A hook inside a conditional runs on some renders and not others, so React's hook list
   * changes length between renders and it throws. Here it threw on the transition INTO
   * the play view — the moment the user opens a line — which is why the screen looked
   * fine until you actually used it, and why adding openings seemed to cause it. The new
   * openings changed which lines open and how they resolve, so the bad path got walked;
   * they were the trigger, not the fault.
   *
   * The effect is now unconditional and does its own guarding. Every value it needs is
   * already top-level — `activeLine`, `stepIdx`, `openFamilyId`, `engineChecked` and
   * `decisionsInLine` are all hooks or state declared above — so nothing is lost by
   * hoisting, and the play view reads these same names from the enclosing scope.
   */
  const total = activeLine.length;

  /*
   * A LINE WITH NO QUESTION IS NOT A FINISHED LINE WHILE WE ARE STILL LOOKING.
   *
   * `stepIdx >= total` is reached two very different ways: the user played the line out,
   * or `startLine` walked it for him because there was nothing to ask. In the second case
   * the engine may still be working out whether there IS something to ask, and saying
   * "line complete" over a dead board during that window is the false end-state the user
   * hit. So the finished view is withheld until the engine has had its say.
   */
  const enginePending = openFamilyId != null && !engineChecked.includes(openFamilyId);
  /**
   * We tried to check this line and got nothing back - the engine is not producing verdicts.
   *
   * `enginePending` deliberately stays TRUE for a stalled family. It is what stops `done` becoming
   * true, and `done` is what prints "Line complete" and offers the test. Marking a stalled family
   * as finished is precisely the bug: the app congratulated the user on completing a line it had
   * not examined, then offered a test built from the one position it happened to have.
   */
  const engineStalledHere = openFamilyId != null && engineStalled.includes(openFamilyId);
  /*
   * ONLY WHEN THE LINE IS ACTUALLY OVER.
   *
   * This state exists to stop a FINISHED view being shown over a board nobody has touched.
   * It must not swallow the play view: the user now plays his own moves, so a
   * question-free line is a ten-move session during which the engine is still working —
   * and replacing "Play e4" with "checking" for that whole time would hide the
   * instruction he needs to follow the line.
   */
  const reachedEnd = stepIdx >= total;
  const awaitingVerdict = reachedEnd && decisionsInLine === 0 && (enginePending || engineStalledHere);
  const done = reachedEnd && !awaitingVerdict;

  /**
   * HOW MANY POSITIONS A TEST COULD ASK ABOUT RIGHT NOW.
   *
   * The pool of finished lines, or the line in front of him when he has not finished any yet — the
   * same fallback `startTest` uses, so the button and the handler cannot disagree. When they did, the
   * button was offered on a line with nothing askable and the handler returned silently, and the user
   * could not tell a bug from a mis-tap: *"i completed a line in 'your openings' and clicked on test
   * yourself but nothing happened"*.
   *
   * Declared HERE rather than beside the test state, because it depends on `done` and
   * `decisionsInLine` — the values that say whether a line has finished — and those are computed
   * further down. Written above them it was a dependency read before it existed, which is the same
   * ordering fault GATE 1k §6 exists for, in a dependency array rather than a ref.
   */
  const testPoolNow = useCallback(
    (): { id: string; steps: BuilderStep[] }[] => (testPoolRef.current.length > 0
      ? testPoolRef.current
      : [{ id: 'current', steps: activeLine }]),
    [activeLine],
  );

  const testPlaces = useMemo(
    () => testPlacesFor(testPoolNow(), openFamily?.side ?? 'w'),
    [testPoolNow, openFamily, done, decisionsInLine, poolVersion],
  );
  /** How many questions this test would ask. Drives the button's label only. */
  const testAskable = testPlaces.length;

  /**
   * WHAT THE BUTTON SAYS WHEN THERE IS NOTHING TO ASK.
   *
   * There is almost always something: a line the user played has his moves on it, and that is the
   * condition. So this is for the genuinely empty case, and it says what is missing rather than
   * "nothing to test", because the user has by then played a line and does not believe it.
   */
  const noTestReason = useMemo(() => {
    /*
     * A STALLED LINE HAS NO TEST, AND SAYING "ONE POSITION" WOULD BE A LIE BY OMISSION.
     *
     * Without engine verdicts there is almost nothing to ask about, so `askablePositions` returns
     * one or two places and the button reads "Test yourself (1)". That is what the user saw:
     * *"i completed a line in your openings but it gave me just one position for the test and thats
     * it?"* — a test of one position is not a test, and the number was honest while the framing was
     * not.
     *
     * So a stalled line gets its own reason, checked FIRST: the count is a symptom, and explaining
     * the symptom would leave the cause unsaid.
     */
    if (engineStalledHere) {
      return 'The engine did not answer, so nothing here was checked and there is nothing to test yet.';
    }
    const anyUserMove = (testPoolRef.current.length > 0 ? testPoolRef.current : [{ id: 'current', steps: activeLine }])
      .some((l) => l.steps.some((s) => s.isUserMove));
    return anyUserMove
      ? 'No positions to test in this line yet — drill one that asks you something and it will appear here.'
      : 'This line had no moves of yours in it, so there is nothing to ask about yet.';
  }, [activeLine, done, poolVersion, engineStalledHere]);

  /*
   * FLUSH ON COMPLETION.
   *
   * The 700 ms debounce exists so a line is written once rather than per ply — that is
   * what fixed the touch regression. But it introduced a race the user hit exactly: finish
   * a line, tap Train immediately, and the timer has not fired, so the custom repertoire
   * is still empty and Train reports "you have not practiced anything" about a line
   * played seconds earlier.
   *
   * Shortening the debounce would trade that bug for a worse one, since a write on nearly
   * every ply is precisely what broke dragging pieces. Line completion is a real signal,
   * so it is waited for. `lineFinishedRef` makes it once per line, so a re-render at the
   * end of a line does not write repeatedly.
   */
  useEffect(() => {
    if (!done) return;
    if (lineFinishedRef.current === total) return;
    lineFinishedRef.current = total;
    void flushAdoptions();
    /*
     * A FINISHED LINE JOINS THE TEST POOL.
     *
     * The pool is the user's own record of what he has studied, so it is written HERE - when a line
     * is genuinely finished - and nowhere else. Building it from the lines on screen instead would
     * put lines he never played into a test about what he learned, which is the one thing a test
     * must not do.
     *
     * Keyed by the line's own moves rather than by an index, for the same reason the line itself is:
     * the engine pass re-derives `alternates`, so an index is not an identity. A line already in the
     * pool is replaced rather than appended, so replaying one does not make the pool grow.
     */
    const moves = activeLine.map((s) => s.moveSan).join(' ');
    if (moves.length > 0) {
      testPoolRef.current = [
        ...testPoolRef.current.filter((l) => l.id !== moves),
        { id: moves, steps: activeLine },
      ];
      // Tell the button the pool changed. Without this the "Test yourself" row keeps showing the
      // count it computed for the previous pool — which is how a line can finish and still have no
      // test offered.
      setPoolVersion((v) => v + 1);
    }
    /*
     * AND MARK THE STUDIES IT COVERED.
     *
     * Here, and not per ply, because a study is "started" by having been PLAYED - a partial line is
     * an attempt at a position, not at a study. Doing it on completion also means the count the user
     * sees moves exactly once per line rather than once per move, which is what makes it legible as
     * progress.
     */
    recordStudiedStudies(activeLine.map((s) => s.moveSan));
  }, [done, total, flushAdoptions, activeLine, recordStudiedStudies]);
  useEffect(() => {
    if (phase !== 'play') {
      prevDecisionsRef.current = null;
      return;
    }
    const prev = prevDecisionsRef.current;
    prevDecisionsRef.current = decisionsInLine;
    /*
     * ONLY RESTART IF THE LINE HAD ALREADY RUN OUT WITH NOTHING TO ASK.
     *
     * This transition is 0 -> n, and it used to restart unconditionally. That is right for the
     * dead end it was written for - the walk reached the last ply with no question anywhere -
     * and wrong at every other moment: the verdicts arrive while the walk is still moving, so
     * restarting replayed the opening from move 1 in front of a user who was watching it, over
     * and over, which is the "repeating the moves 3 times" report.
     *
     * Mid-walk nothing needs doing: `walkTo` stops on any step that is the user's to answer,
     * and a step that had no choice a moment ago now has one, so the question is there when he
     * arrives. The restart exists for the case where there is nothing left to arrive at.
     */
    if (prev === 0 && decisionsInLine > 0 && !answeredRef.current && stepIdx >= activeLine.length) {
      startLine();
    }
    // `startLine` and `activeLine` are intentionally absent: this must be driven by the
    // transition, not by identity churn, and the guard above reads the index rather than the
    // array so it cannot fire on a re-derivation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, openFamilyId, lineRef, decisionsInLine]);

  /** The current step, or null when the line is finished. */
  const step = activeLine[stepIdx] ?? null;

  /**
   * Which shipped study finishes this line, if any.
   *
   * Read off the tail rather than tracked separately: the book only ever
   * contributes the END of a line (see `withBookTail`/`continueLine`), so the
   * last tagged step names the study that carries it. Null when the whole line
   * is the user's own play, which is the case worth distinguishing in the UI.
   */
  const lineFromStudy = useMemo(() => {
    for (let i = activeLine.length - 1; i >= 0; i--) {
      if (activeLine[i].fromStudy) return activeLine[i].fromStudy as string;
    }
    return null;
  }, [activeLine]);

  /**
   * The shipped study that teaches this opening, so the finished line can hand
   * the user the full lesson ("the user get trained on his repertoire and ours
   * ... in the course also not just in training").
   *
   * Looked up from the played moves rather than from `openFamily.openingId`,
   * because the id is an ENTRY id while the course opens a STUDY id — and the
   * study we want is specifically the one whose tree this line follows.
   */
  const courseStudy = useMemo(() => {
    if (!openFamily) return null;
    return studyForLine(activeLine.map((s) => s.moveSan));
  }, [openFamily, activeLine]);

  /**
   * THE BOARD, DERIVED FROM THE LINE — ONE SOURCE OF TRUTH.
   *
   * THE BUG THIS FIXES (found on the device, not in a test)
   * ------------------------------------------------------
   * The board used to be a SECOND replay: `replayLine(playedSans)`, re-walking the
   * SAN list from the initial position, while the instruction came from
   * `activeLine[stepIdx]`. Two derivations of one position, which is exactly the
   * shape of bug that produces "play an illegal move": they agreed until the
   * engine published.
   *
   * `publish()` replaces the family with a re-rotated one, so `activeLine` gets a
   * new identity — but `stepIdx` is just an integer, and nothing reset it. The
   * screen was then showing step N of the NEW array's instruction over step N of
   * the OLD array's board. The 0 -> n restart only fires when the decision count
   * goes from zero to non-zero, so a publish that merely CHANGED the line left the
   * two permanently out of step. The user saw the Sicilian at "3 / 25 plies"
   * being asked for `cxd4` over a board where it cannot be played, with the
   * last-move highlight on two squares that are not a legal move pair.
   *
   * The fix is structural rather than a reset: the position is a function of the
   * LINE and the INDEX, walked once per line, so the board and the instruction
   * cannot disagree even if the array is swapped underneath. `plies[i]` is the
   * position the board must show when `stepIdx === i`; `plies[length]` is the
   * position after the last step, which is what the finished view shows.
   *
   * It is also cheaper than what it replaces: one walk per LINE CHANGE instead of
   * one replay per render, which is the `MEMORY.md` rule ("never derive state
   * with a `new Chess()` replay per value") finally applied to this screen.
   */
  const linePlies = useMemo(() => {
    const out: string[] = [];
    let fen = new Chess().fen();
    for (const s of activeLine) {
      out.push(fen);
      const next = new Chess(fen);
      try {
        if (next.move(s.moveSan)) fen = next.fen();
      } catch { /* the line is verified at build time; keep the last good fen */ }
    }
    out.push(fen);
    return out;
  }, [activeLine]);

  /** The position on the board right now — the line's own, never a re-replay. */
  const boardFen = pendingFen ?? linePlies[Math.min(stepIdx, linePlies.length - 1)];

  /** The last move, read off the step that made it rather than re-derived. */
  const lastMoveRef = useMemo(() => {
    const prev = stepIdx > 0 ? activeLine[stepIdx - 1] : null;
    if (!prev) return null;
    const uci = prev.moveUci;
    if (!uci || uci.length < 4) return null;
    return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  }, [activeLine, stepIdx]);

  const userSide: 'w' | 'b' = openFamily?.side ?? 'w';

  /**
   * MOVE ONE POSITION'S PROGRESS, IF IT HAS A KEY.
   *
   * The rings in "Your openings" read `positions[step.position.key].mastery`, and until
   * `recordPositions` existed the only writer of that map was the Train path - so a line drilled to
   * the end here moved nothing and every ring stayed at 0%. The user's report was exactly that:
   * *"there is no progress shown ( always 0%)"*.
   *
   * Steps with no position are book moves: `withBookTail` contributes them, and a book move is not
   * a position the user was asked about, so there is nothing to record and nothing is invented.
   */
  const recordStepProgress = useCallback((s: BuilderStep, correct: boolean) => {
    const key = s.position?.key;
    if (!key) return;
    recordPositions([{ key, correct }]);
  }, [recordPositions]);

  /**
   * Accept a move made on the board.
   *
   * A move is legal here if it is ANY of: the step's own move, our
   * recommendation, or one of the engine's alternatives. That is the whole
   * "keep mine or use ours" decision expressed as a chess move rather than a
   * button — and it means an alternative needs no extra UI at all, it is just
   * another legal answer.
   */
  const onBoardMove = useCallback((from: Square, to: Square, promotion?: string) => {
    if (!step) return false;
    const uci = `${from}${to}${promotion ?? ''}`;

    const c = new Chess(boardFen);
    let san: string;
    // Kept outside the `try` so the sound effect can see the real move (a capture
    // sounds different from a quiet move, and `playMoveSound` needs the flags).
    let made: { san: string; flags: string; captured?: string } | null = null;
    try {
      const m = c.move({ from, to, promotion });
      if (!m) return false;
      san = m.san;
      made = { san: m.san, flags: m.flags ?? '', captured: m.captured };
    } catch {
      return false;
    }

    /*
     * A MOVE THAT WAS WRONG AND IS BEING PLAYED AGAIN.
     *
     * Checked before anything else, because this position is not a decision: the user has already
     * been told the move and has been walked back here to play it. The only acceptable move is the
     * one that belongs here, and it is compared as SAN so that `Nd5` and `Nbd5` are not treated as
     * a second wrong attempt at the same idea.
     *
     * While the replay is still running the board is not his to play on, so `interactive` is off
     * until it lands - see the play view. A move that arrives before then belongs to a touch that
     * started before the replay, and is ignored rather than graded, because grading it would tell
     * him a move is wrong when he simply has not been given the position yet.
     */
    if (mistake) {
      if (san !== mistake.san) {
        setFeedback({
          ok: false,
          text: `Not yet — this position needs ${mistake.san}. Look at the board and play it.`,
        });
        return false;
      }
      /*
       * Played it. The correction is done, and the move now falls through to the ORDINARY handling
       * below rather than being applied here.
       *
       * That is deliberate. Applying it here as well would append the move twice and, on a decision
       * where our recommendation is not the line's own move, would then continue the line from a
       * branch the board is not on - the exact illegal-move fault the continuation fix exists to
       * prevent. One path applies a played move: the one that already worked.
       */
      setMistake(null);
    }

    const choice = step.choice;
    // From here on the user has moved, so the line is his and must not be
    // restarted underneath him (see `answeredRef`).
    answeredRef.current = true;
    // No decision at this step: the only move playable is the line's own move.
    if (!choice) {
      if (san !== step.moveSan) {
        /*
         * WRONG — SAY SO, SHOW THE MOVE, AND PUT THE POSITION BACK.
         *
         * This used to say only *"This line plays X — follow the arrow"*, which is right about the
         * move and useless about the lesson: the arrow is the answer, the user has already been told
         * the answer, and the board is still standing several moves past the mistake. The user
         * asked for the rest of it — *"then repeat the movement automatically until it gets to the
         * wrong move and let me play it myself"* — and that is now what happens.
         *
         * The mistake is recorded as a WRONG answer either way, whether or not he retries it, so a
         * ring that has not been earned stays unearned.
         */
        recordStepProgress(step, false);
        /*
         * A DEVIATION IS NOT A MISTAKE, AND SAYING OTHERWISE IS SIMPLY WRONG.
         *
         * After 1.d4 d5, playing 2.e3 leaves the Queen's Gambit Accepted altogether — it heads for
         * the Queen's Gambit Declined family — and it is a real move with a real point. This branch
         * used to say *"That is not this line"* in the same red error styling as an engine-judged
         * blunder, and drew a RED arrow on the user's move, so a legitimate alternative opening was
         * presented as a failed move. That is the *"you keep refering for my moves as blunder while
         * they are not"* complaint arriving by a different road than the eval-sign bug: that one
         * inverted the numbers, this one graded a deviation as a failure to agree.
         *
         * So: neutral wording, `ok: true` styling, and `severity: 'deviation'` — which is what stops
         * the red arrow being drawn. The line's own move is still shown in gold, because in a study
         * you are being TAUGHT this line and it is fair to say what it plays. The user's move is left
         * unmarked, because there is nothing wrong with it.
         */
        setFeedback({
          ok: true,
          text: `That leaves this line — it continues with ${step.moveSan}. Your move is fine, it just goes`
            + ' down a different opening path.',
        });
        setMistake({
          ply: stepIdx,
          san: step.moveSan,
          playedUci: uci,
          recommendUci: step.moveUci ?? uciFromSan(boardFen, step.moveSan),
          severity: 'deviation',
        });
        replayTo(activeLine, stepIdx);
        return false;
      }
      playMoveSound(made);
      recordStepProgress(step, true);
      setPlayedSans((s) => [...s, san]);

      /*
       * A CORRECT ANSWER IN A TEST MOVES ON TO THE NEXT QUESTION.
       *
       * The request: *"in the test i said it should be many to do and as a train loop until i get them
       * all correct not just one position"*.
       *
       * `startTest` used to pick ONE position and set `overrideLine` to its line, so a test was a
       * single question: answer it, walk the rest of that line, and the screen sat there with the
       * test still flagged as running and nothing left to ask. One position is not a test of anything.
       *
       * So a test is now a QUEUE. `startTest` builds every askable position in the pool and asks them
       * one at a time; a correct answer advances to the next; a WRONG answer leaves its position at
       * the back of the queue, which is what makes "until I get them all correct" true rather than
       * "until I have been lucky once". When the queue empties, the test ends and says so.
       */
      if (testing) {
        advanceTest();
        return true;
      }
      /*
       * RECORD THE MOVE — EVEN WHEN THERE WAS NOTHING TO DECIDE.
       *
       * The report: "i clicked on train in 'your openings' and it said there is no
       * train available since I didnt practice although I finished some lines".
       *
       * An adoption is the input to the Train drill, and adoptions were written
       * ONLY in the branch below, where the screen offered a choice. Most plies of
       * a line have no choice — the user simply plays the move the line plays, and
       * follows the arrow — so finishing a whole line recorded nothing and the
       * trainer was empty. The user's own moves ARE his repertoire; playing them is
       * choosing them.
       */
      /*
       * Recorded UNCONDITIONALLY, and with the move order as the prefix.
       *
       * `playedSans` is every move played so far in this line INCLUDING the one just
       * made, so the prefix for the record is everything before it. That is the move
       * order from the start of the game, which is what `prefixSan` means and what
       * `buildBookExercisesForAdoptions` needs in order to look the line up in the
       * shipped library.
       *
       * The old guard `if (step.position)` meant a book move — `position: null` —
       * recorded nothing at all.
       */
      void adopt(step, {
        uci, san, cp: NaN, lossCp: NaN, played: true,
        book: (step.position?.bookReplies ?? []).includes(san),
        note: 'Your line',
      }, [...playedSans, san].slice(0, -1));
      setTimeout(() => {
        if (!aliveRef.current) return;
        const next = stepIdx + 1;
        const steps = activeLine;
        const sans: string[] = [];
        for (let k = 0; k < next; k++) sans.push(steps[k].moveSan);
        let i = next;
        // The opponent's replies only — the user's next move is his to play.
        while (i < steps.length && !needsUser(steps[i])) { sans.push(steps[i].moveSan); i++; }
        setPlayedSans(sans);
        setStepIdx(i);
            setFeedback(null);
      }, 180);
      return true;
    }

    // A decision. Work out which option the user actually played.
    const opt = step.position?.options.find((o) => o.uci === uci) ?? null;
    const isPlayedMine = choice.playedUci === uci;
    const isOurs = choice.recommendUci === uci;
    const isKnown = isPlayedMine || isOurs || opt != null;

    /*
     * IN A TEST THERE IS ONE RIGHT ANSWER, AND ANYTHING ELSE IS A MISTAKE.
     *
     * Learning keeps the user's own move and records it as their repertoire - correctly, because
     * the repertoire is theirs and the app is showing them where they actually go. A test is asking
     * a different question: *do you know this position*. There is no repertoire to protect there, so
     * the move we teach is the answer and the rest are misses.
     *
     * This is the whole of what makes a test worth doing, and it is why the same position can be
     * answered acceptably while learning and count as a mistake ten seconds later. GATE 1m asserts
     * that the two paths are decided by this flag and not by anything incidental.
     */
    /*
     * A REAL MISTAKE IS CORRECTED WHILE LEARNING TOO, NOT ONLY IN A TEST.
     *
     * *"make sure the app gives me also positions in the openings where i make a mistake and it shows
     * me that it is a mistake and tell me what to play instead ( not just give me a good move of mine
     * and suggests another move)"*.
     *
     * Which is exactly what the `else` branch below used to do, and it is worth being precise about
     * why that is wrong rather than merely unhelpful. It said *"Nf3 kept, your own move — our move was
     * d4"* with `ok: true`, for EVERY deviation. A position the engine rates a blunder and a position
     * he chose for a reason he likes are the same shape of event to that code, so a move that throws
     * away a queen was reported with the same tone and the same green tick as a sideline he prefers.
     * The engine's own verdict is on the step - `choice.verdict` is `mistake` or `blunder` - and it was
     * not being read at this branch at all. It was read in `yourOpenings.ts`, for the ring, and
     * nowhere the user could see it.
     *
     * So: below the threshold it stays a preference, because the repertoire is his and the app is
     * showing him where he actually goes. Above it, it is a mistake, and it takes the same path as a
     * test miss - say so, name the move, walk the position back, and let him play it. The blunder
     * itself is NOT recorded: the only adoption at this step is the corrected move, so a mistake does
     * not sit in his repertoire because the app said not to while also keeping it.
     */
    const verdict = choice.verdict;
    const lost = opt ? Math.abs(opt.lossCp) : 0;
    // A deviation the engine calls a mistake or a blunder, or one that gives up more than a pawn's
    // worth of evaluation. The two thresholds overlap deliberately: `verdict` needs the engine to have
    // looked, and the centipawn test catches the case where it looked and said nothing decisive.
    const isRealMistake = verdict === 'mistake' || verdict === 'blunder' || lost > 150;
    if (!testing && isRealMistake && choice.recommendUci && !isOurs) {
      const want = choice.recommendSan ?? '(our move)';
      recordStepProgress(step, false);
      setFeedback({
        ok: false,
        text: verdict === 'blunder'
          ? `That is a blunder - it gives up too much. Play ${want} here instead.`
          : `That is a mistake${lost > 0 ? ` (${describeDelta(-lost)})` : ''}. Play ${want} instead.`,
      });
      setMistake({
        ply: stepIdx,
        san: want,
        playedUci: uci,
        recommendUci: choice?.recommendUci ?? uciFromSan(boardFen, want),
        severity: 'mistake',
      });
      replayTo(activeLine, stepIdx);
      return false;
    }

    if (testing && choice.recommendUci && !isOurs) {
      const want = choice.recommendSan ?? '(our move)';
      recordStepProgress(step, false);

      /*
       * A WRONG ANSWER PUTS ITS POSITION BACK ON THE QUEUE.
       *
       * This is the half of "until I get them all correct" that the correct-answer path cannot
       * supply on its own. Without it, one missed position is one missed position for ever: the
       * queue drains and the test reports complete with a hole in it, which is a passing grade the
       * user did not earn.
       *
       * Re-queued at the END, not the front, so a position the user cannot find does not become an
       * immediate loop — they are shown the correction, play it, and the test carries on round.
       */
      const wrongId = lastTestRef.current;
      if (wrongId && !testQueueRef.current.some((p) => p.id === wrongId)) {
        const asked = askablePositions<{ id: string; steps: BuilderStep[] }>(
          testPoolRef.current.length > 0
            ? testPoolRef.current
            : [{ id: 'current', steps: activeLine }],
        ).find((p) => p.id === wrongId);
        if (asked) testQueueRef.current.push(asked);
      }
      /*
       * AND THE POSITION IS MARKED, so the drill shows the four states the user asked for - to-do,
       * mistake, unclear, correct - rather than a count of answers.
       *
       * The state lives in the session and not in `PositionProgress`, which stores `asked`/`correct`
       * for statistics. Reading a loop state out of counters would claim knowledge the loop never
       * confirmed: one right answer after a wrong one is `unclear`, not solved, and only a second
       * clean pass confirms it. `nextLoopState` is the trainer's own transition, so the openings
       * drill and the trainer cannot drift into two different loops.
       */
      markTestResult(wrongId, false);
      setFeedback({
        ok: false,
        text: `Not this one — here it is ${want}. Watch the position again.`,
      });
      setMistake({
        ply: stepIdx,
        san: want,
        playedUci: uci,
        recommendUci: choice?.recommendUci ?? uciFromSan(boardFen, want),
        severity: 'mistake',
      });
      /*
       * THE CORRECTION NAMES THE MOVE, AND THAT IS THE POINT.
       *
       * The arrows are suppressed for the whole of a test, including through the replay that follows
       * a wrong answer — but this message tells him what to play, and the replay walks the position
       * back so he can play it himself. That is the difference between a test and a locked door: he
       * is asked to find the move, and once he has tried and been wrong he is told. He is never asked
       * twice about a position he has already been corrected on, because the replay ends on the same
       * position and the retry is graded against it.
       */
      replayTo(activeLine, stepIdx);
      return false;
    }

    /*
     * IS WHAT HE PLAYED THE LINE'S OWN MOVE — AND THE MOVE LANDS NOW.
     *
     * THE REPORT: *"i tried your opening and it showed me my move and a
     * suggested move but i played my move. the app stayed stuck a little bit
     * then it jumped to another position and told me that the line is
     * finished"*.
     *
     * Three faults, all here.
     *
     * 1. THE PIECE STAYED PUT. The board is driven by `stepIdx` and the steps
     *    only know the LINE's moves, so a decision used to leave the board
     *    untouched until `continueLineWithEngine` came back — on a phone that
     *    is a real search. The move he had just made sat back down on its
     *    origin square, and that is the whole of "stayed stuck".
     *
     * 2. THEN IT WENT THROUGH THE ENGINE AT ALL. A step's own move IS the
     *    move the position records (`stepFor(chosen, ..., chosen.playedSan!)`),
     *    so when the user plays it, the rest of the line was built on top of
     *    exactly this move: the continuation is already on the board and there
     *    is NOTHING to re-derive. Only a move the line does not contain needs
     *    the engine, because only then do the branches genuinely diverge.
     *    Sending every decision through `continueLineWithEngine` also meant
     *    that when the pool, the books and a contended engine had nothing past
     *    a move that was never the spine's, the line was truncated to what he
     *    played and the screen honestly called it finished — "and told me that
     *    the line is finished", about a line that still had moves.
     *
     * 3. THE BOARD JUMPED. Both the truncation and the re-derivation landed
     *    through `walkTo`, which re-seeds the whole position; with the piece
     *    never having stayed put, the net effect was a frozen board and then a
     *    jump. With the move held on the board (see `pendingFen`) the
     *    continuation can only ever move forward from where he actually is.
     *
     * So the handler now records the position the gesture reached, and the
     * decision of what to do next splits on ONE fact: did he play the line's
     * move, or one of ours?
     */
    const playsLineMove = san === step.moveSan;
    /*
     * His move is a position that exists — show it. `c` already has the move
     * applied, so its FEN is the board he made. Held until the branch below
     * resolves; the board stops accepting touches meanwhile (see `interactive`),
     * so no second move can queue behind this one.
     */
    setPendingFen(c.fen());

    recordStepProgress(step, isOurs || !testing);

    if (!isKnown) {
      // An engine alternative we did not have on the shortlist, or a genuine
      // third move. Either way it is the user's choice, so it IS accepted — the
      // repertoire is theirs. We just say what we know about it.
      setFeedback({ ok: true, text: `${san} saved to your repertoire.` });
    } else if (isOurs && !isPlayedMine) {
      setFeedback({ ok: true, text: `Good — ${san} is our move. Saved to your repertoire.` });
    } else if (isPlayedMine && isOurs) {
      setFeedback({ ok: true, text: `${san} is our move and yours. Saved.` });
    } else {
      /*
       * A PREFERENCE, NOT A MISTAKE - and the wording has to say which it is, because otherwise the
       * user cannot tell the two apart. This branch is only reached when the move was not rated a
       * mistake, so "your own move" is accurate and the figure beside it is a small one.
       *
       * The same wording used to cover a blunder as well, which is the report: *"not just give me a
       * good move of mine and suggests another move"*.
       */
      const loss = opt ? describeDelta(opt.lossCp) : '';
      setFeedback({
        ok: true,
        text: `${san} is your own move${loss ? ` (${loss})` : ''} — ours would be ${choice.recommendSan}. Both fine.`,
      });
    }

    playMoveSound(made);
    /*
     * The prefix is `playedSans` (every move before this one) — `setPlayedSans` has
     * not run yet at this point in the handler, so this is the move order leading TO
     * the decision, which is what `prefixSan` means.
     */
    void adopt(step, opt ?? {
      uci, san, cp: NaN, lossCp: NaN, played: false, book: false,
      note: 'Your own choice',
    }, [...playedSans]);

    /*
     * CONTINUE THE LINE FROM THE POSITION THE USER ACTUALLY REACHED.
     *
     * The line used to be advanced by appending the ORIGINAL line's following
     * moves (`steps[i].moveSan`) after the user's move. That is only right when
     * the user played the line's own move. The moment they take our
     * recommendation the branches have diverged, the appended moves belong to a
     * position that no longer exists, the board refuses the first one, and
     * `boardFen`'s replay breaks there — which is exactly what the user saw:
     * "an illegal move after i chose the app recommendation ... it doesn't
     * complete the line, i just played one move and that's it".
     *
     * The remainder is therefore RE-DERIVED rather than patched. `continueLine`
     * resumes the family walk at the deepest point of the user's history the
     * pool recognises and rotates forward from there, so every following ply is
     * legal by construction. The result becomes the new active line outright:
     * the board and the steps can then never disagree, because there is only one
     * list and it is the one that was actually played.
     */
    setTimeout(async () => {
      if (!aliveRef.current) return;
      const steps = activeLine;
      const played: string[] = [];
      for (let k = 0; k < stepIdx; k++) played.push(steps[k].moveSan);
      played.push(san);

      /*
       * HIS MOVE IS THE LINE'S MOVE — THE LINE ALREADY CONTINUES WITH IT.
       *
       * `step.moveSan` is the position's own recorded move, and every following
       * step was built on top of it, so there is nothing to re-derive and no
       * engine to wait for: walk the opponent's replies and stand on his next
       * move, exactly as the no-decision path does. This is the branch the
       * report's scenario takes now — the piece stayed where he put it, the
       * line walks on, and "line complete" only appears when the line is
       * actually complete.
       */
      if (playsLineMove) {
        setPendingFen(null);
        const next = stepIdx + 1;
        const sans: string[] = [];
        for (let k = 0; k < next; k++) sans.push(steps[k].moveSan);
        let i = next;
        // The opponent's replies only — the user's next move is his to play.
        while (i < steps.length && !needsUser(steps[i])) { sans.push(steps[i].moveSan); i++; }
        setPlayedSans(sans);
        setStepIdx(i);
        return;
      }

      /*
       * `continueLine` returns a COMPLETE list — it starts at move 1 and already
       * contains everything played — so it becomes the active line outright.
       * Nothing is stitched on: one list means the board and the step index
       * cannot drift apart, which is what produced the illegal move.
       *
       * AND WHEN THE BOOKS CANNOT CONTINUE, THE ENGINE DOES.
       *
       * *"i tried sicilian in your openings and the same problem that you keep repeating
       * each time : i only played one move and thats it!"*
       *
       * Measured, not assumed: for a real Sicilian the shipped studies match the move order
       * for about two plies, no resync depth yields a move that is legal where the game
       * actually is, and a position index — which does work, and does see transpositions —
       * also finds nothing, confirmed by an independent walk of 7,322 raw study-tree nodes.
       * The position is one we do not teach. So `continueLineWithEngine` lets the engine play
       * on, and hands the line back to the book the moment it reaches a position a book does
       * teach. Engine moves are flagged `fromEngine`, so nothing here is passed off as ours.
       */
      const merged = openFamily
        ? await continueLineWithEngine(openFamily, played, { isAlive: () => aliveRef.current })
        : [];

      if (!aliveRef.current) return;
      // The line is about to move; the held position has served its purpose.
      setPendingFen(null);

      const replaysPlayed = merged.length >= played.length
        && played.every((s, i) => merged[i]?.moveSan === s);
      /*
       * A CONTINUATION THAT DOES NOT CONTINUE IS THE SAME DEAD END AS NO CONTINUATION.
       *
       * `merged.length === 0` alone was not enough, and the miss is exactly the report — *"i tried
       * another opening and played two moves and it told me line finished!"*. `continueLineWithEngine`
       * returns the played history itself (its `head`) when the engine cannot answer — a busy host,
       * a contended search — and that list is not EMPTY, so it sailed past this guard into
       * `walkTo(merged, played.length)`: an end index at the end of the list, `done` true, "Line
       * complete" over a line that had barely started.
       *
       * The honest test is not "did anything come back" but "did anything NEW come back, and does it
       * replay what was played": equal length means nothing was added, and a prefix that does not
       * match `played` is the resume-drift the engine path exists to avoid. Both stop here, over the
       * position the user reached.
       */
      if (!replaysPlayed || merged.length === played.length) {
        /*
         * NOTHING CAN CONTINUE — AND THE BOARD GOES BACK TO THE QUESTION.
         *
         * This used to set `stepIdx = steps.length`: the board JUMPED to the
         * end of a line the user had not walked, and `done` rendered "line
         * complete" over it. That is the second half of the report — "then it
         * jumped to another position and told me that the line is finished" —
         * and it was doubly wrong, because the line had neither finished nor
         * been walked.
         *
         * The one position that is still true is the decision he is standing
         * on, so the board stays there and the message says what is and is not
         * available. Our move may well continue where his does not, so it is
         * named.
         */
        stopWalk();
        setFeedback({
          ok: true,
          text: `Nothing in your games or our books continues from ${san}`
            + (choice.recommendSan ? ` — play ${choice.recommendSan} to stay on the line.` : ' here.'),
        });
        return;
      }

      setOverrideLine(merged);
      /*
       * CONTINUE THE LINE FROM WHERE HE ACTUALLY IS - AND WALK IT.
       *
       * Two bugs, both reported.
       *
       * The first version searched from index 0 for the first decision in the whole
       * line, and put the board there. A decision at or before what he had already played
       * put the board BACKWARD, so his move appeared to be undone.
       *
       * The second searched from `played.length` but then jumped straight to the next
       * question - or, when the rest of the line had no further question, to
       * `merged.length`, which IS the finished state. That is "i chose two moves and it
       * told me we are finished": the line had run out of QUESTIONS, not out of MOVES, and
       * the two were being treated as the same thing.
       *
       * `walkTo` separates them. It starts at `played.length` - so nothing goes backward -
       * and then plays the remaining plies one at a time, stopping only on a step that is
       * his to answer, or at the genuine end of the line.
       */
      const from = Math.min(played.length, merged.length);
      walkTo(merged, from);
      }, 180);
    return true;
  }, [step, stepIdx, boardFen, activeLine, adopt, openFamily]);

  /* ------------------------------------------------- analyse the open family */

  /**
   * Once a family is open, run the engine over ITS positions only.
   *
   * This is what makes the recommendation real, and it is scoped: the engine
   * cost is one family, not the user's whole game history. Positions are the
   * family's own, so the recommendations land exactly on the moves being played.
   */
  useEffect(() => {
    if (phase !== 'play' || !openFamily || !username) return;
    const famId = openFamily.id;
    const markChecked = () => {
      setEngineChecked((prev) => (prev.includes(famId) ? prev : [...prev, famId]));
    };
    if (analysedRef.current.has(famId)) {
      // Already analysed on an earlier visit — nothing to wait for.
      markChecked();
      return;
    }

    let alive = true;
    setProgress(null);
    /**
     * Throttle the progress re-renders.
     *
     * `setProgress` lives at the top of this screen, so every tick re-renders the
     * whole subtree INCLUDING the board. The engine reports once per position, so
     * on a 60-position family that is 60 board re-renders while the user is trying
     * to play — which is what "i tried playing one move and it took too much time"
     * was: the screen was thrashing underneath him. Four updates a second is more
     * than enough for a progress line and leaves the interaction alone.
     */
    let lastTick = 0;

    (async () => {
      /*
       * DECLARED BEFORE THE `try`, NOT INSIDE IT.
       *
       * `finally` is a SIBLING of the `try` block, so a `const` declared inside `try {}` is not in
       * scope there — `sampleSize` and `accumulated.size` are both read in `finally` to decide
       * whether the pass actually produced anything, and declaring them inside the block made that
       * impossible to express. They are the two facts the `finally` exists to read, so they belong at
       * the scope the `finally` can see.
       */
      const accumulated = new Map<string, GamePosition>();
      let sampleSize = 0;
      try {
        /*
         * `sampleSize` is the "did we have anything to analyse?" flag the `finally` reads.
         *
         * The distinction that matters for `engineStalled`: a family whose games yielded no candidate
         * positions is a NORMAL outcome — there is nothing of the user's in that opening to check —
         * whereas a family that offered a sample and got no verdicts back is the engine failing, and
         * those two must not end up in the same state. `sampleSize > 0` is what separates them.
         */
        /*
         * LET THE TAP PAINT FIRST.
         *
         * This effect starts in the same tick as the `setPhase('play')` that
         * opened the family, and React runs effects after the commit — but the
         * screen's own start-up work (`startLine`, the arrows, the board layout)
         * is still queued behind whatever this effect does synchronously. A
         * single `await` on a macrotask hands the frame back, so the board is on
         * screen and answering touches before any of the work below starts.
         *
         * This is not a micro-optimisation. Every heavy step in here used to run
         * BEFORE the user could touch the board, which is the whole of the report:
         * "it take too much time to open, then when I click on a piece to move it
         * stays blocked".
         */
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!alive) return;

        /*
         * THE CANDIDATES ARE ALREADY DERIVED — DO NOT REPLAY THE GAMES.
         *
         * This used to call `fetchAllGames` and then `deriveCandidates` again,
         * which is the ~4,100-move chess.js replay described on `candsRef`. It
         * ran AFTER the play view was on screen, so the user tapped a card, saw
         * the board, and then found that nothing responded to a touch for the
         * whole replay. The board was never broken; the JS thread was busy.
         *
         * Three sources, cheapest first, and only the last one replays anything:
         *
         *   1. the cache, via `candidatesFromPositions` — zero chess work;
         *   2. the in-memory candidates from the list build — zero chess work;
         *   3. the games, scoped to THIS family with `deriveFamilyCandidates` —
         *      a handful of games, not the whole library, and only on a cold
         *      start where there is no cache to read.
         */
        let mine: Cand[];
        /*
         * MATCH ANY LABEL THE FAMILY ABSORBED, NOT THE DISPLAY STRING.
         *
         * This compared one game's Lichess opening against `sourceName` with `===`. Once
         * several labels are merged into one card that field reads "Queen's Gambit + Queen's
         * Pawn", which no single game equals - so a merged family recovered ZERO of its
         * games, the engine pass had nothing to analyse, and the user was shown no
         * evaluation for either the move he played or the move recommended.
         *
         * `sourceNames` is the set, and membership is what is tested. `'Unknown opening'`
         * is included because that is the fallback the candidate code itself uses when a
         * game has no opening label, and leaving it out would silently drop unlabelled
         * games that previously matched through the old string.
         */
        const labels = new Set(openFamily.sourceNames ?? []);
        if (labels.size === 0) labels.add(openFamily.sourceName);
        labels.add('Unknown opening');
        const inFamily = (c: Cand) =>
          labels.has(c.game.opening || 'Unknown opening') && sideOfCand(c) === openFamily.side;

        if (candsRef.current.length > 0) {
          mine = candsRef.current.filter(inFamily);
        } else {
          const kept = gamesRef.current.length > 0
            ? gamesRef.current
            : (await fetchAllGames(username, { maxGames: READ_GAMES }))
              .filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 6)
              .slice(0, 160);
          if (!alive) return;
          mine = deriveFamilyCandidates(kept, openFamily.sourceNames ?? [openFamily.sourceName], openFamily.side, { maxPly: MAX_PLY });
        }
        if (!alive) return;
        if (mine.length === 0) return;

        const sample = sampleForLine(mine, ENGINE_BUDGET_MIN, ENGINE_BUDGET_MAX, [
          /*
           * ONLY THE LINE HE WAS SENT TO.
           *
           * `lineWithDecisions` has already chosen between the spine and the
           * siblings, and it runs before `setPhase('play')` — so by the time this
           * effect runs, `lineRef` names the line the user is looking at. That is
           * the only line he will play in this session, and therefore the only
           * one whose positions are worth a search. Sampling the whole family
           * instead cost 91 searches on the device for one card.
           *
           * `lineRef` is deliberately not a dependency: switching lines mid-session
           * must not restart the engine, and the verdicts are cached per family.
           */
          stepsForLine(openFamily, lineRef),
        ]);

        /*
         * PUBLISH THE HEAD OF THE LINE FIRST, THEN THE REST.
         *
         * `sampleForLine` returns the positions in PLAY ORDER — along the line
         * the user was sent to — and the whole sample is up to `ENGINE_BUDGET_MAX`
         * searches, which is still a visible wait on a phone. Analysing it in one
         * go and publishing at the end is what "i thought it froze" was: nothing
         * the user could act on appeared until the entire sample was done.
         *
         * So the sample is cut in two. The head covers the opening moves of the
         * line — where the first few decisions live — and is published as soon as
         * it lands. The tail is analysed afterwards and published when it arrives;
         * by then the user is playing, and the choices he has not reached yet
         * simply appear as he gets there.
         */
        const publish = () => {
          const all = [...accumulated.values()];
          if (all.length === 0) return;
          analysedRef.current.set(famId, all);
          /*
           * AND LET THE SESSION ALREADY ON THE BOARD SEE THEM.
           *
           * This is the render trigger for the in-place join
           * (`withVerdicts` on `activeLine`). It runs for EVERY publish,
           * including the ones whose family rebuild is skipped below, because
           * the two do different jobs: the rebuild re-rotates the pool for the
           * NEXT session, the join enriches THIS one. That is what puts the
           * engine's "this was a blunder, play X" in front of the user while
           * he is still in the line it happened in, instead of a launch later.
           */
          setVerdictsTick((t) => t + 1);
          /*
           * Written to disk here, at the moment the verdicts become true, so the next launch reads
           * them instead of buying them again. Fire-and-forget: this is a cache write, and the
           * screen must not wait on the disk to show the user their board.
           */
          void saveCachedVerdicts(
            username,
            Object.fromEntries(analysedRef.current.entries()),
          );
          /*
           * NEVER REBUILD THE FAMILY UNDER A SESSION THAT IS ALREADY RUNNING.
           *
           * `publish` swaps the family's line out for a re-rotated one, which
           * changes `activeLine`'s identity underneath the board. When the user
           * has not moved yet that is exactly what we want — it is how the engine
           * turns a question-free walkthrough into a quiz, and the 0 -> n restart
           * then puts him at the first question. Once he HAS moved it is not:
           * `stepIdx` indexes into the old array, so a swap can move the board
           * under him mid-move. That is the "then nothing changed" class of bug.
           *
           * The verdicts are still recorded above, so they are picked up the next
           * time he opens the family. Nothing is lost by waiting.
           */
          if (answeredRef.current) return;
          /*
           * AND NEVER ONCE A LINE IS ON THE BOARD AT ALL - ANSWERED OR NOT.
           *
           * The guard above is kept because it says what it means ("he has moved, so nothing may
           * shift under him"), and it is the one that matters longest. It is NOT sufficient, and
           * the reason is the whole of this bug: it is false for the entire opening walkthrough,
           * which is exactly when the head stage of the engine pass lands. So the family was
           * rebuilt with the user watching, `buildFamilyLines` re-ran the pool rotation, and the
           * rotation prefers positions that carry decisions - so `alternates` came back as a
           * DIFFERENT LIST, twice, once for the head of the sample and once for the tail.
           *
           * That single call is all three of the reported symptoms, which is why fixing them one at
           * a time kept producing the next one:
           *
           *   1. "it plays automatically 3 times" - the walk restarts. `activeLine` is a new array,
           *      so the re-sync effect runs; the SANs now DISAGREE, because the rotation picked
           *      somebody else's line; so it calls `startLine()` and walks from move 1 again. The
           *      initial walk is the first, and each publish is another.
           *   2. "then I get a different new position" - the line being walked is not the line that
           *      was tapped. `resolveLine` looks the recorded moves up in the new list, does not
           *      find them, and falls back to the index - which now names a different move order.
           *   3. "i play one or two moves and it says done" - the swapped-in line is a DIFFERENT
           *      line, chosen by a rotation that prefers short decision-bearing fragments. A
           *      fragment is short by construction, so the 8-ply floor could not help: the line
           *      genuinely WAS that short, and nothing was lying. The floor was honest and the
           *      line was wrong.
           *
           * The verdicts are recorded above, keyed by position, so they are picked up the next time
           * this family is opened - and `analysedRef` survives a rebuild, so re-opening does not
           * re-search them. Nothing is lost by waiting; what is lost by not waiting is the user's
           * line.
           */
          if (sessionLiveRef.current) return;
          // Rebuild just this family with the engine verdicts attached.
          const rebuilt = buildFamilyLines(
            mergeAnalysed(families, famId, all),
            { maxPly: MAX_PLY, maxAlternates: MAX_ALTERNATES },
          );
          if (!alive) return;
          setFamilies((prev) => prev.map((f) => {
            const hit = rebuilt.find((r) => r.id === f.id);
            return hit ?? f;
          }));
        };

        /** Progress across the WHOLE sample, so the count does not restart. */
        const runStage = async (stage: Cand[], offset: number) => {
          if (stage.length === 0) return [];
          return analyseFamily(stage, {
            multipv: 3,
            /*
             * DEPTH 10, NOT 12.
             *
             * Depth 12 cost roughly three times the nodes of depth 10, and the
             * question this pass answers is coarse: "is there a better move here
             * than the one he played, and what is it?" In an opening, ten plies
             * settles that as reliably as twelve. The user's complaint was about
             * the wait, not the precision — "it kept comparing to 82 line i think
             * (which take very long and this is inacceptable for every move)" —
             * and this is the second of the two cuts that answer it, after
             * scoping the sample to the line being played.
             */
            depth: 10,
            movetime: ENGINE_SEARCH_CAP_MS,
            /*
             * THE PROBE IS CHEAPER THAN THE SEARCH THAT PICKS THE MOVE.
             *
             * `analyseFamily` spends a second search only when the move the user
             * played fell outside the MultiPV window. That search has no
             * alternatives to rank, so it gets its own, smaller cap — the main
             * cap is for the search whose answer becomes the recommendation.
             */
            probeMovetime: ENGINE_PROBE_CAP_MS,
            shouldStop: () => stopRef.current,
            onProgress: (done) => {
              if (!alive) return;
              const now = Date.now();
              if (done < sample.length && now - lastTick < 250) return;
              lastTick = now;
              setProgress({
                phase: 'Checking our ideas here…',
                done: offset + done,
                total: sample.length,
              });
            },
          });
        };

        const head = sample.slice(0, ENGINE_HEAD);
        const tail = sample.slice(ENGINE_HEAD);
        sampleSize = sample.length;

        for (const p of await runStage(head, 0)) accumulated.set(p.key, p);
        if (!alive) return;
        publish();

        if (tail.length > 0) {
          for (const p of await runStage(tail, head.length)) accumulated.set(p.key, p);
          if (!alive) return;
          publish();
        }
      } catch (err) {
        /*
         * A THROWN ENGINE PASS IS A STALL, NOT A SILENCE.
         *
         * The catch used to be a bare `catch { }` with a comment saying the family keeps its
         * engine-free line. That comment described the data and quietly excused the screen: a pass
         * that threw was indistinguishable from a pass that had nothing to check, and both were
         * marked done.
         */
        console.warn('[Your openings] engine pass failed for', famId, err);
      } finally {
        /*
         * MARK CHECKED — BUT ONLY IF SOMETHING CAME BACK.
         *
         * The old version marked the family checked on every path, and the reasoning was sound for
         * the case it was written for: a family with no usable games, a Lichess hiccup or an empty
         * sample must still be allowed to finish, because leaving it pending forever trades one dead
         * screen for another.
         *
         * That reasoning does not cover a family that OFFERED a sample and received no verdicts, which
         * is what a failed engine pass looks like. Marking those checked made `enginePending` false,
         * `awaitingVerdict` false and therefore `done` TRUE — so a line the app had never checked
         * anything on was reported as complete. The user's words: *"it showed nothing to play then
         * after a few time it says we are done while i didnt play anything."*
         *
         * So: something analysed, or nothing to analyse, means checked. A sample that came back empty
         * means STALLED — a distinct state that keeps the line honestly unfinished and lets the screen
         * name the cause. It is still not a permanent spinner: `enginePending` excludes a stalled
         * family, so the screen moves on and explains itself rather than waiting for ever.
         */
        if (alive) {
          setProgress(null);
          if (sampleSize > 0 && accumulated.size === 0) {
            setEngineStalled((prev) => (prev.includes(famId) ? prev : [...prev, famId]));
          } else {
            markChecked();
          }
        }
      }
    })();

    return () => { alive = false; };
    // `families` is intentionally NOT a dependency: this effect would re-run on
    // every rebuild it triggers and loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, openFamilyId, username, engineRetry]);

  /* ------------------------------------------------------------------ views */

  if (phase === 'boot') {
    return <Center><Spinner /><Text style={s.body}>Loading…</Text></Center>;
  }

  if (phase === 'empty') {
    return (
      <Center>
        <Card style={{ width: '100%', maxWidth: 380, gap: 10 }}>
          <View style={s.row}>
            <IconBookMarked size={18} color={colors.gold} />
            <Text style={s.h1}>Nothing to show yet</Text>
          </View>
          {error ? (
            <Text style={[s.body, { lineHeight: 18 }]}>{error}</Text>
          ) : (
            /*
             * CONNECT AND IMPORT IN PLACE.
             *
             * This used to say "Connect a Lichess account on the Stats tab, then come back" — an
             * instruction to leave the tab the user was looking at. The card below saves the
             * account right here and fires `build(true)` the moment it is saved, which IS this
             * screen's import: it reads the games and derives the openings the user actually
             * plays. An account that is already connected but has produced no lines gets the
             * card's note instead of a dead end.
             */
            <GameImportInline
              what="an openings report"
              connectedNote="Account saved — this list builds itself from the openings that account plays, and there is nothing to review from its games yet."
              onChanged={() => void build(true)}
            />
          )}
          <Btn label="Back" onPress={onExit} style={{ marginTop: 6 }} />
        </Card>
      </Center>
    );
  }

  if (phase === 'building') {
    const frac = progress && progress.total ? progress.done / progress.total : null;
    return (
      <Center>
        <Card style={{ width: '100%', maxWidth: 380, gap: 12 }}>
          <View style={s.row}>
            <IconSparkles size={18} color={colors.gold} />
            <Text style={s.h1}>Reading your openings…</Text>
          </View>
          <Text style={[s.body, { lineHeight: 18 }]}>
            This happens once. From now on your openings open instantly.
          </Text>
          {frac != null ? <Bar pct={frac} /> : <Spinner />}
          {/*
           * NEVER render "0 / 0".
           *
           * The first phases ("Looking up account…", "Finding your games…") have
           * no denominator — there is no month count yet, and no engine count
           * either. Printing `{done} / {total}` unconditionally showed the user a
           * literal "0 / 0" through the whole opening phase while the app was
           * busy, which is why the recharge looked broken: "when recharging the
           * openings i got 0/0 although its recharging really the games".
           *
           * So the number is printed ONLY when a real total exists, and the
           * phase text carries the message otherwise. Showing the phase is more
           * informative than showing a fake count — "Reading your games… (3/12
           * months)" beats "0 / 0" every time.
           */}
          <Text style={s.bodySm}>
            {progress && progress.total > 0
              ? `${progress.done} / ${progress.total}`
              : progress?.phase ?? 'Starting…'}
          </Text>
          <Btn label="Stop" variant="ghost" onPress={() => { stopRef.current = true; onExit(); }} />
        </Card>
      </Center>
    );
  }

  /* -------------------------------------------------------------- PLAY VIEW */

  if (phase === 'play' && openFamily) {
    const choice = step?.choice ?? null;

    const altNo = lineRef.kind === 'alt' ? lineRef.index + 1 : 0;

    const arrows: BoardArrow[] = [];

    /*
     * THE MOVE THAT IS THE USER'S TO PLAY HERE — ASKED OF THE POSITION, NOT OF AN INDEX.
     *
     * The arrows used to be driven by `step = activeLine[stepIdx]`. That is an INDEX into an array,
     * and `activeLine` is not always the array `goTo` walked:
     *
     *     if (overrideLine && overrideLine.length > 0) return overrideLine;
     *     const resolved = resolveLine(openFamily, lineRef, lineSansRef.current);
     *     ... else if (sessionLiveRef.current) return lastLineRef.current;
     *     ... else return alternates[lineRef.index];
     *
     * Every one of those can hand back a DIFFERENT line to the one `goTo` stopped in — a swapped
     * study, a re-resolved line, a recorded line still standing after the pool rotated. When they
     * disagree, `activeLine[stepIdx]` is simply some other step: often the OPPONENT's, which has
     * `isUserMove === false`, so the `else if (step?.isUserMove)` arm does not fire and the board
     * shows no arrow at all.
     *
     * That is the report — *"in queens gambit there is no arrows in the first line"* — and it is not
     * a fact about the Queen's Gambit. It is a fact about the index being untrustworthy, so it can
     * happen to any opening, at any ply, and it gets more likely the deeper the session runs and the
     * more the fallback paths above have been taken.
     *
     * The fix is to stop asking the index and ask the BOARD. "Which of this line's moves is the
     * user's, and does it actually apply here?" has an answer that cannot drift, because it is
     * checked against the position rather than assumed from an offset:
     *
     *   1. it is the user's turn at all — otherwise there is nothing to point at
     *   2. try the step the index points at, then every later step, so the common case is one probe
     *   3. accept a step only if its SAN is LEGAL in the current position
     *
     * Step 3 is what makes this general rather than a patch. An index that is off by one produces a
     * step whose move is simply not playable here, and it is skipped instead of being drawn.
     */
    const userMoveHere = (() => {
      if (testing) return null;
      /*
       * WHOSE TURN IT IS, WITHOUT PARSING THE POSITION.
       *
       * The board was built here only to read the FEN's second field, and this is the render
       * body of the play view, so it was paid on every frame the annotation is drawn. The probes
       * below still build boards because they have to - each one plays a move to test legality -
       * and they are now only reached when it IS the user's turn, the minority of plies.
       *
       * The `try` went with the board: it existed because `new Chess()` throws on a malformed
       * FEN, which `turnOf` cannot do. If `boardFen` were malformed, the probe below builds a
       * board and throws, and its own per-candidate `try` catches that and returns null - the
       * same outcome, on a path that cannot happen with a FEN this app produced.
       */
      const turn = turnOf(boardFen);
      if (turn !== openFamily.side) return null;   // not his move on this board
      const candidates = [step, ...activeLine.slice(stepIdx + 1)];
      for (const s of candidates) {
        if (!s || !s.isUserMove || !s.moveSan) continue;
        try {
          const probe = new Chess(boardFen);
          probe.move(s.moveSan);
          return s;
        } catch {
          // Not playable in this position, so it belongs to a different point in a different line.
        }
      }
      return null;
    })();
    /*
     * THE ANNOTATION IS ALWAYS ON. There is no reveal toggle.
     *
     * The request was explicit — "shows him the position + an arrow what he
     * played + an arrow what we recommend (+ a msg indicating to user what he
     * played and what we recommend ...)" — and then, seeing an earlier build
     * with a "Show" button, the correction was blunter: "you have to remove the
     * show btw / dont keep anything that says you have to activate the arrows
     * ... because this is a course so no you just show the arrows".
     *
     * So this is not a hint system. It is the teaching material. A course does
     * not make you ask to see the lesson.
     *
     * AND IT COVERS EVERY MOVE OF HIS, NOT ONLY THE DECISIONS.
     *
     * The arrows used to be built from `choice` alone, so a step where he simply
     * plays his own move — no question to answer, because we have no
     * recommendation that differs from what he played — drew NOTHING. That is the
     * report: "i see the board but no arrows". Such a step is also strict about
     * which move it accepts, so with no arrow to point at it every move he tried
     * was refused and the position did not change — "then nothing changed which
     * is another problem". Both complaints are the same missing arrow.
     *
     * An arrow is not a hint here, it is the instruction: if it is his move, he
     * is told which move it is.
     */
    /*
     * NO ARROWS IN A TEST, AND THAT IS NOT A HINT BEING HIDDEN.
     *
     * The user: *"in test yourself it shows me arrows. it is a test it shouldnt show me what to play
     * i should know that myself"*.
     *
     * The rule above is right for learning, and it is right for a reason worth keeping: the arrows
     * were made permanent because the user said so twice — *"dont keep anything that says you have to
     * activate the arrows ... because this is a course so no you just show the arrows"*. A course does
     * not make you ask for the lesson.
     *
     * A test is not a course. It is the check that the lesson took, and the arrow IS the answer
     * already drawn on the board. So in a test there is no arrow at all: no recommendation, no "the
     * move you played", and not the line's own move where he is asked to play it. He gets the
     * position and nothing else, which is the whole question.
     *
     * The arrows return the moment the test is over — on a wrong answer, because the correction has
     * to show the move, and on `endTest`, because learning resumes. So this is a difference between
     * two modes rather than a switch, and he does not have to go looking for a toggle to get his
     * lesson back.
     */
    /*
     * THE ARROW BUILDER, AND THE ONE PLACE THAT WAS TOO NARROW.
     *
     * This was one `if (!testing)` around everything, which meant that during a TEST the correction
     * had no arrow at all - only a sentence. The report was exactly that: *"in your openings in the
     * test when i play a wrong move it still says the correct move in msg but doesnt show it with an
     * arrow"*. A message is not a location: it names a move the board does not show, so the player is
     * told what to play and left to find it.
     *
     * So the two halves are separated, because they are different claims:
     *
     *   WHILE LEARNING (`!testing`)  the line's own move and the recommendation, because there is no
     *                                question to spoil - the screen is teaching.
     *   WHILE TESTING                nothing, until a mistake exists. The whole point of a test is that
     *                                the answer is not on the board before it is found.
     *
     * And the MISTAKE arrows are outside both: once the player has answered wrongly, the correction
     * has to be on the board, in the test as much as in learning, and red for what they played and
     * gold for what the position needs.
     */
    const add = (uci: string | null | undefined, color: string) => {
      if (!uci || uci.length < 4) return;
      arrows.push({ startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color });
    };
    if (!testing) {
      if (choice) {
        add(choice.playedUci, arrowColors.reply);
        add(choice.recommendUci, arrowColors.hint);
      } else if (userMoveHere) {
        // His own move in the line, with nothing to decide - still his to play.
        add(userMoveHere.moveUci, arrowColors.hint);
      }
    }

      /*
       * A MISTAKE IS SHOWN ON THE BOARD, NOT ONLY IN A SENTENCE.
       *
       * The request: *"when i do a mistake it should show me arrows that my move is mistake and shows
       * me what to play not just a message"*.
       *
       * Until now a mistake produced a red message and no arrows, which is the one form of feedback
       * that cannot be acted on without reading: the point of a mistake is WHERE it was, and an
       * arrow puts it on the square. So both are drawn — red for what he played, gold for what the
       * line wants — and they appear only once the mistake exists, so they can never pre-empt the
       * position.
       */
      if (mistake) {
        /*
         * BOTH ARROWS, ALWAYS, WHEN THE USER'S MOVE IS NOT THE ONE WE RECOMMEND.
         *
         * The owner asked for this twice, and the first correction I made was wrong in the other
         * direction: I removed the red arrow for a deviation because calling 2.e3 a "blunder" against
         * a study playing 2.c4 is false — after 1.d4 d5 that is not this opening at all. But dropping
         * the arrow entirely left the screen saying only "that leaves this line", and the report that
         * came back was *"the app didnt even show me where i am wrong"*. A message is not a location.
         *
         * So the two concerns are separated, because they are different things:
         *
         *   the RED ARROW   a statement of FACT — this is the move you played, and it is not the move
         *                    we recommend here. That is true of every deviation and costs the user
         *                    nothing to be told.
         *   the WORD "MISTAKE"  a claim about quality, and it is still made ONLY when the engine
         *                    judged the move (`severity === 'mistake'`). Nothing here claims the user
         *                    lost material or played badly; it shows what they played and what the
         *                    line wanted, and the two arrows are how you see the difference at a glance.
         *
         * The gold arrow is drawn once, not twice, when the two moves are the same move — there is
         * only one thing to point at.
         */
        const sameMove = !!mistake.playedUci && mistake.playedUci === mistake.recommendUci;
        if (mistake.playedUci && !sameMove) add(mistake.playedUci, colors.bad);
        add(mistake.recommendUci, arrowColors.hint);
      }

    /*
     * NO EVAL BAR HERE, DELIBERATELY.
     *
     * This screen's engine job is to say *their move* versus *our move* when
     * there is something to decide — a comparison between two candidate moves,
     * not a score for the position. The user was explicit: "when i told you i
     * want the engine is to tell me my move on the engine and the apps move if i
     * have to choose dont show the eval bar".
     *
     * A positional score would also be the wrong teaching signal in a course: it
     * invites the user to play the number instead of learning the move. The
     * comparison rows and the two arrows carry the whole lesson; the eval is
     * simply noise next to them.
     */

    const lastMove = lastMoveRef;

    return (
      <View style={[s.root, { flex: 1 }]}>
        <View style={{ paddingTop: insets.top + 12 }}>
          <View style={s.header}>
            <Pressable
              /*
               * BACK GOES TO THE LINE LIST, NOT PAST IT.
               *
               * The user arrived here by choosing a line out of the opening's lines, so that is
               * where Back belongs. Returning to the openings list skipped the screen he just used
               * to pick, which is the only place the other lines and their mastery rings are - so
               * backing out of a drill stranded him at the top level with no route to the others
               * except re-tapping the opening and losing his place.
               *
               * `openFamilyId` is deliberately NOT cleared, so the lines screen still knows which
               * opening it is showing. Only a jump straight to the list - via "Other openings" -
               * closes the family.
               */
              onPress={() => { setPhase(openFamilyId ? 'lines' : 'list'); stopRef.current = false; }}
              hitSlop={10}
              style={s.backBtn}
            >
              <IconChevronLeft size={18} color={colors.foreground} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={s.h1} numberOfLines={1}>{openFamily.name}</Text>
              <Text style={s.bodySm} numberOfLines={1}>
                {testing ? 'Test · ' : ''}
                You play {openFamily.side === 'w' ? 'White' : 'Black'}
                {altNo ? ` · line ${altNo + 1}` : ' · your main line'}
                {/*
                 * WHILE TESTING, THE HEADER COUNTS QUESTIONS, NOT MOVES.
                 *
                 * A test is a QUEUE of positions, so "move 4" is the wrong thing to show on it � and
                 * with a single position there was nothing to count at all, which is part of why it
                 * read as one question rather than a test. This prints how many are LEFT, which is the
                 * number that tells the user there is more to do.
                 */}
                {' · '}
                {testing
                  ? `${testQueueRef.current.length} position${testQueueRef.current.length === 1 ? '' : 's'} left`
                    + loopSummary
                  : done ? 'line complete' : `move ${Math.floor((step?.ply ?? 0) / 2) + 1}`}
                {lineFromStudy ? ` · finishes with our ${lineFromStudy}` : ''}
              </Text>
            </View>
            {/*
             * A WAY OUT OF A TEST, WHILE THE TEST IS RUNNING.
             *
             * The user asked for a test he starts deliberately, and a test he cannot leave is a trap.
             * "Other openings" is on the finished card, which is unreachable mid-test, so without
             * this the only exit is the back arrow — which discards the position he is on without
             * saying so, and looks like the app lost it.
             */}
            {testing ? (
              <Pressable
                onPress={endTest}
                hitSlop={8}
                style={s.stopTest}
                accessibilityLabel="Stop the test and go back to learning this line"
              >
                <Text style={s.stopTestText}>Stop</Text>
              </Pressable>
            ) : openFamily.inBook ? (
              <Chip text="We have this" color={colors.primary} bg="rgba(46,139,106,0.14)" border="rgba(46,139,106,0.4)" />
            ) : (
              <Chip text="New to us" color={colors.gold} bg="rgba(212,175,55,0.14)" border="rgba(212,175,55,0.4)" />
            )}
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24, gap: 12 }}>
          <ChessForgeBoard
            fen={boardFen}
            orientation={userSide === 'w' ? 'white' : 'black'}
            /*
             * THE point of the redesign: the user plays the move here.
             *
             * Not while a mistake is being played back to him. He is watching the moves repeat
             * because he was asked to, and a board that accepts a touch during that is a board that
             * will grade a position he has not been shown yet. `replaying` is true for exactly the
             * length of the replay and false the moment it lands, so the retry is the first thing
             * he can touch.
             *
             * AND NOT WHILE THE ENGINE IS STILL CHECKING (`awaitingVerdict`). At the end of the
             * walkthrough, before the family pass has come back, there is no step left to play —
             * every touch used to be accepted and then silently rejected, which is what "i cant
             * play any move" was describing. A board that lifts a piece and takes it back is
             * worse than one that never invited the touch.
             */
            interactive={!done && !replaying && !awaitingVerdict && pendingFen == null}
            onMove={onBoardMove}
            arrows={arrows}
            lastMove={lastMoveRef}
            /*
             * MARK THE BLUNDER ON THE BOARD.
             *
             * "showed in the board that it is a mistake" — so the move he actually
             * played is drawn in the danger colour and the squares it touched are
             * tinted, instead of the neutral "what you played" pink. Without this
             * the two arrows look identical whether he played a subtle improvement
             * or dropped a queen.
             */
            blunder={choice?.verdict ? choice.playedUci : null}
          />

          {/* progress through the line */}
          <View style={s.navRow}>
            <Text style={s.navText}>{playedSans.length} / {total} plies</Text>
            <View style={{ flex: 1 }}>
              <Bar pct={total ? playedSans.length / total : 0} />
            </View>
          </View>

          <Card style={{ gap: 12 }}>
            {progress && progress.total > 0 && !done ? (
              <View style={s.row}>
                <Spinner size={13} />
                <Text style={s.bodySm}>
                  {/*
                   * THE HEAD HAS LANDED — SAY SO.
                   *
                   * The pass publishes the first `ENGINE_HEAD` positions as soon as they
                   * are checked, and the tail then runs while the user is already playing.
                   * Leaving the same "Checking our ideas here…" line up for the tail made
                   * a ready board read like a screen that had not finished loading — the
                   * exact complaint the shorter head and per-search caps are fixing.
                   *
                   * Not while `awaitingVerdict`: there the line reached its end with no
                   * question yet, so the board is deliberately not interactive and
                   * "you can play" would be false.
                   */}
                  {progress.done >= Math.min(ENGINE_HEAD, progress.total) && !awaitingVerdict
                    ? `Opening checked — still checking the rest in the background… ${progress.done}/${progress.total}`
                    : `Checking our ideas here… ${progress.done}/${progress.total}`}
                </Text>
              </View>
            ) : null}

            {/*
             * NOT FINISHED — WE HAVE NOT ASKED HIM ANYTHING YET.
             *
             * This is the state the user never used to see, and its absence is
             * the bug: a line whose questions come from the engine painted as
             * "complete" the instant it opened, so the card looked dead. Saying
             * we are checking is the honest reading of the position — we walked
             * the line because there was no question in it, and we are still
             * deciding whether there should have been one.
             */}
            {awaitingVerdict ? (
              /*
               * TWO DIFFERENT THINGS SHARE THIS BRANCH, AND THEY MUST NOT LOOK ALIKE.
               *
               * `awaitingVerdict` now covers both "we are still checking" and "the check produced
               * nothing at all". The second used to be impossible: a failed engine pass marked the
               * family checked, which made `awaitingVerdict` false and `done` true, and the screen
               * congratulated the user on a line it had never checked.
               *
               * Showing a spinner forever for a stall would be its own lie, so the stall gets its own
               * copy, no spinner, and the actual cause. A spinner implies work is still happening;
               * here none is, and the thing to do is reopen the app — which is what fixes a dead
               * engine host.
               */
              engineStalledHere ? (
                <View style={{ gap: 8 }}>
                  <View style={s.row}>
                    <IconShieldAlert size={15} color={colors.bad} />
                    <Text style={s.h2}>The engine did not answer</Text>
                  </View>
                  <Text style={[s.body, { lineHeight: 17 }]}>
                    Nothing here has been checked, so this line is not finished and there is no test to
                    give you yet. Tap below and we will restart the engine, then check this line again.
                  </Text>
                  <Btn
                    label="Retry the engine"
                    onPress={() => {
                      /*
                       * THREE STEPS, ALL NEEDED: a fresh engine instance (the host replaces it and
                       * re-runs the handshake), this family cleared from BOTH lists — stalled, so
                       * the copy goes away, and checked, so the pass is allowed to run again — and
                       * the nonce bumped so the engine effect re-runs without a re-visit.
                       */
                      getEngine().restart('retry from Your openings');
                      setEngineStalled((prev) => prev.filter((id) => id !== openFamilyId));
                      setEngineChecked((prev) => prev.filter((id) => id !== openFamilyId));
                      setEngineRetry((n) => n + 1);
                    }}
                  />
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  <View style={s.row}>
                    <Spinner size={13} />
                    <Text style={s.h2}>Checking our ideas here…</Text>
                  </View>
                  <Text style={[s.body, { lineHeight: 17 }]}>
                    Your games follow our line to here, so there was nothing to ask you yet.
                    We are checking whether the engine would play any of it differently — if
                    it would, we will put the choice to you.
                  </Text>
                </View>
              )
            ) : done ? (
              /* The line is finished — only now do we offer the next thing. */
              <View style={{ gap: 10 }}>
                <View style={s.row}>
                  <IconCheckCircle size={17} color={colors.primary} />
                  <Text style={s.solvedText}>
                    {lineRef.kind === 'main' ? 'Main line complete' : `Line ${altNo + 1} complete`}
                  </Text>
                </View>
                <Text style={[s.body, { lineHeight: 18 }]}>
                  {openFamily.alternates.length > 0
                    ? `You played every decision in this line. ${openFamily.alternates.length} other line${openFamily.alternates.length > 1 ? 's' : ''} of your ${openFamily.name} — or move on to another opening.`
                    : `That is your whole ${openFamily.name}. Train it any time from the Train tab.`}
                </Text>

                {/*
                 * CHECK YOU ACTUALLY LEARNED IT.
                 *
                 * The user's words: *"when i complete a line i want you to give me random positions
                 * like the train do (from what i studed: the current line and the previous ones) and
                 * i try them to make sure i learned, exactly like in train mode. (but keep the train
                 * mode so i could practice these lines whenever i want)"*.
                 *
                 * Offered HERE, on completion, and not as another tab: finishing a line is the moment
                 * he has just decided whether he knows it, and a test he has to go and find is a
                 * test he will not do. Train is untouched and remains the place to practise.
                 *
                 * It only appears when there is something to ask, and the SAME PREDICATE DECIDES THAT
                 * as the handler uses. The first version showed the button whenever the line had any
                 * `choice` and then found nothing askable, because a re-derived line's steps carry
                 * `position: null` — and a button that silently does nothing is worse than no button,
                 * because the user cannot tell a bug from a mis-tap. That is the report: *"i
                 * completed a line in 'your openings' and clicked on test yourself but nothing
                 * happened"*.
                 */}
                {/*
                 * THE BUTTON IS ALWAYS HERE.
                 *
                 * It used to be hidden unless `askablePositions` returned something, which was a
                 * correct reaction to a dead tap and the wrong remedy for it: the user's words are
                 * *"i should always be able to test after finishing whether there is askable
                 * positions or not"*. Hiding the control tells him the app decided he was not ready,
                 * and he has just finished a line — he is the one who knows that.
                 *
                 * So the control is unconditional, and the thing that was actually fixed is behind
                 * it: `testPlaces` falls back to every ply of his own side, so a line always has
                 * something to ask. Only a line with no ply of his side at all reaches the message,
                 * and it says which case that is.
                 */}
                <Pressable
                  onPress={startTest}
                  style={s.courseRow}
                  accessibilityLabel="Test yourself on positions from the lines you studied"
                >
                  <IconDumbbell size={14} color={colors.gold} />
                  <Text style={s.courseRowText} numberOfLines={2}>
                    Test yourself{testAskable > 0 ? ` — ${testAskable} position${testAskable === 1 ? '' : 's'}` : ''}
                  </Text>
                  <IconArrowRight size={13} color={colors.gold} />
                </Pressable>
                {testAskable === 0 ? (
                  <Text style={[s.bodySm, { marginTop: 2 }]}>{noTestReason}</Text>
                ) : null}

                {/*
                 * THE STUDY FOR THIS OPENING, IF WE SHIP ONE.                 *
                 * "you can refer to what we have in the openings studies also in
                 * 'your openings', so the user get trained on his repertoire and
                 * ours (in the course also not just in training)". The line he
                 * just played may have ended in the book's tail rather than his
                 * own games, and either way the full lesson — with the comments
                 * and the branches — is a step away rather than something he has
                 * to go hunting for in the course tab.
                 */}
                {courseStudy && onCourse ? (
                  <Pressable
                    onPress={() => onCourse(courseStudy.id)}
                    style={s.courseRow}
                  >
                    <IconBookOpen size={14} color={colors.primary} />
                    <Text style={s.courseRowText} numberOfLines={2}>
                      Read our study: {courseStudy.title}
                    </Text>
                    <IconArrowRight size={13} color={colors.primary} />
                  </Pressable>
                ) : null}

                <View style={s.actionRow}>
                  <Btn label="Play again" variant="ghost" small onPress={startLine} style={{ flex: 1 }} />
                  {lineRef.kind === 'main' && openFamily.alternates.length > 0 ? (
                    <Btn
                      label={`Next line (${openFamily.alternates.length})`}
                      small
                      onPress={() => setLineRef({ kind: 'alt', index: 0 })}
                      style={{ flex: 1 }}
                    />
                  ) : lineRef.kind === 'alt' && lineRef.index < openFamily.alternates.length - 1 ? (
                    <Btn
                      label="Next line"
                      small
                      onPress={() => setLineRef({ kind: 'alt', index: lineRef.index + 1 })}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <Btn label="Other openings" small onPress={() => setPhase('list')} style={{ flex: 1 }} />
                  )}
                </View>
              </View>
            ) : choice ? (
              /* A REAL CHOICE — the user plays it on the board. */
              <>
                {/*
                 * IS THIS A MISTAKE, OR JUST A DIFFERENT MOVE?
                 *
                 * The request: *"show me some positions where I played a mistake
                 * and say a message to me that it is a mistake … not just giving me
                 * positions where I played a good move and suggest another move"*.
                 *
                 * So the headline leads with the verdict when the engine has
                 * measured one. The two framings are genuinely different lessons —
                 * "here is a better move" teaches repertoire, "you dropped a piece"
                 * teaches something you will lose games over — and presenting both
                 * in the same neutral tone is what made the first one invisible.
                 *
                 * `verdict` is null unless the engine actually judged the move, so
                 * the app never accuses the user of a mistake it has not measured.
                 */}
                {choice.verdict ? (
                  <View style={s.verdictBox}>
                    <IconXCircle size={15} color={colors.bad} />
                    <Text style={[s.h2, { color: colors.bad }]}>
                      {choice.verdict === 'blunder' ? 'That was a blunder' : 'That was a mistake'}
                    </Text>
                    <Text style={[s.body, { lineHeight: 17 }]}>
                      {`This is the move you chose in your own game`
                        + `${choice.playedCp != null ? ` (${formatEvalCp(choice.playedCp)})` : ''}. `
                        + `ChessForge would take ${choice.recommendSan}`
                        + `${choice.recommendCp != null ? ` (${formatEvalCp(choice.recommendCp)})` : ''} `
                        + `instead, worth ${describeDelta(choice.lossCp) || 'a clear margin'} more — `
                        + `it is the arrow already drawn on the board.`}
                    </Text>
                  </View>
                ) : (
                  <Text style={s.h2}>Your move — play it on the board</Text>
                )}

                <Text style={[s.body, { lineHeight: 17 }]}>
                  {choice.verdict ? '' : `From your own game you reached this point with ${choice.playedSan}.`}
                  {/*
                   * The sentence has to be about the MOVES, not the position.
                   *
                   * It used to branch on `inBook` — "some book for your colour has
                   * a move here" — and so told a user who played `1...Nf6` that we
                   * had no book, while the same screen's chip said "We have this".
                   * Both were true of different things and neither answered the
                   * question being asked, which is whether we teach the move he
                   * played. The reply set answers exactly that, and naming the book
                   * moves is the whole point of a repertoire.
                   */}
                  {choice.bookReplies.length > 0
                    ? ` The books here continue ${choice.bookReplies.join(', ')}.`
                    : ' Nothing in the books reaches this line yet, so the move above comes from the engine.'}
                  {' '}Either one can become part of your repertoire — take whichever you prefer.
                </Text>

                {/*
                 * The comparison is part of the course, so it is always shown.
                 * There used to be a "Show"/"Hide" bulb here; it made the lesson
                 * something the user had to switch on.
                 */}
                <View style={s.compareBox}>
                  <CompareRow
                    tag="You played"
                    move={choice.playedSan ?? '—'}
                    color={colors.bad}
                    note={playedNote(choice)}
                    eval={formatEvalCp(choice.playedCp)}
                  />
                  <View style={s.compareDivider} />
                  <CompareRow
                    tag={choice.recommendIsBookMove ? 'We play' : 'Engine suggests'}
                    move={choice.recommendSan ?? '—'}
                    color={colors.primary}
                    note={recNote(choice)}
                    eval={formatEvalCp(choice.recommendCp)}
                  />
                  <View style={s.arrowLegend}>
                    <LegendDot color={arrowColors.reply} label="what you played" />
                    <LegendDot color={arrowColors.hint} label="what we recommend" />
                  </View>

                  {choice.alternatives.length > 0 ? (
                    <View style={{ gap: 6 }}>
                      <Text style={s.bodySm}>
                        Also fine here (play any of them on the board):
                      </Text>
                      {choice.alternatives.map((o) => (
                        <View key={o.uci} style={s.altRow}>
                          <Text style={s.altMove}>{o.san}</Text>
                          <Text style={s.bodySm}>{describeDelta(o.lossCp) || 'strong'}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              </>
            ) : (
              /* NO CHOICE — we just show the move. */
              <View style={{ gap: 8 }}>
                <Text style={s.h2}>Play {step?.moveSan}</Text>
                <Text style={[s.body, { lineHeight: 17 }]}>
                  {step?.fromStudy
                    /*
                     * THE BOOK CARRIED THIS PART OF THE LINE.
                     *
                     * The user asked to be trained on "his repertoire and ours
                     * ... in the course also not just in training". Saying so
                     * here is what makes that true rather than implied: he knows
                     * the first half is what he really plays and this half is
                     * what we teach. Without the label the app would be passing
                     * our line off as his, which is exactly how a course loses
                     * someone's trust.
                     */
                    ? `Your games stop here — this comes from our ${step.fromStudy} study. Play it on the board.`
                    : step?.isUserMove
                      ? 'This is your move too — the same one you played in your game. Play it on the board.'
                      : 'Your opponent’s move in this line. Play it on the board to continue.'}
                </Text>
              </View>
            )}

            {feedback ? (
              <View style={[s.feedback, feedback.ok ? s.feedbackOk : s.feedbackBad]}>
                <IconCheckCircle size={14} color={feedback.ok ? colors.primary : colors.bad} />
                <Text style={[s.feedbackText, { color: feedback.ok ? colors.primary : colors.bad }]}>
                  {feedback.text}
                </Text>
              </View>
            ) : null}

            {stepIdx > 0 ? (
              <Pressable
                onPress={() => goTo(activeLine, Math.max(0, stepIdx - 1))}
                style={s.stepBack}
                hitSlop={8}
              >
                <IconChevronLeft size={13} color={colors.mutedForeground} />
                <Text style={s.bodySm}>Back a move</Text>
              </Pressable>
            ) : null}
          </Card>

          <View style={s.actionRow}>
            {openFamily.alternates.length > 0 ? (
              <Btn
                label={`Other lines (${openFamily.alternates.length})`}
                variant="ghost"
                small
                onPress={() => {
                  setLineRef({ kind: 'alt', index: lineRef.kind === 'alt' ? (lineRef.index + 1) % openFamily.alternates.length : 0 });
                }}
                style={{ flex: 1 }}
              />
            ) : null}
            <Btn
              label="Another opening"
              variant="ghost"
              small
              onPress={() => setPhase('list')}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>

        {justSaved ? (
          /*
           * `pointerEvents="none"` IS LOAD-BEARING HERE.
           *
           * The toast is `position: absolute`, `left: 14, right: 14` — a full-width
           * opaque bar — and it contains no interactive element. Without this it is
           * a touch target by accident: on a short screen it sits across the lower
           * part of the layout, and every tap in that band goes to a label that was
           * only ever meant to be read.
           *
           * It was harmless while it appeared once per DECISION. Now that every move
           * is recorded, it appeared on every ply, so the band was covered for most
           * of a line. Same class of bug as the board squares, and the same fix: a
           * view that is not a control must not be one.
           */
          <View style={[s.toast, { bottom: insets.bottom + 18 }]} pointerEvents="none">
            <IconCheckCircle size={14} color={colors.primary} />
            <Text style={s.toastText}>Saved {justSaved} to your repertoire</Text>
          </View>
        ) : null}
      </View>
    );
  }

  /* ------------------------------------------------- ONE OPENING: ITS LINES */

  /*
   * THE OPENING SCREEN AN OPENING TRAINER SHOULD HAVE.
   *
   * The opening's name, a streak, a "Current Rank -> Next Rank" path, and then the LINES - each a
   * node ringed with its mastery out of ten, ordered so the ones he is most likely to meet come first.
   *
   * What this replaces: tapping an opening dropped him straight into playing one arbitrary spine,
   * with its siblings behind an "Other lines (8)" control. He could not see what he was about to
   * play, how long it was, how well he already knew it, or how often he actually plays it - and
   * that is the whole of "it is not london and just 2-3 moves".
   */
  if (phase === 'lines' && openFamily) {
    /*
     * ONLY LINES LONG ENOUGH TO DRILL ARE OFFERED.
     *
     * `drillable` is the floor (`MIN_DRILL_PLIES`, four moves a side) and it existed as a flag
     * with no reader: every line was tappable, including the two-move ones, and the user played
     * one of those and got "Line complete" after two moves — *"i tried another opening and played
     * two moves and it told me line finished!"*. `describeLine` already refuses to call such a
     * line drillable; this is the screen finally agreeing with it. `familyLines` is kept so the
     * screen can say how many were held back instead of hiding them silently.
     */
    const familyLines = drillableLines(openFamily, positionProgress);
    const linesForFamily = familyLines.filter((l) => l.drillable);
    const totalMastery = linesForFamily.length === 0
      ? 0
      : Math.round(linesForFamily.reduce((a, l) => a + l.mastery, 0) / linesForFamily.length);
    const rank = rankFor(totalMastery);
    const rec = familyRecord(openFamily, gamesRef.current);
    // Over ALL lines, not only the offered ones: a family whose every line is still too short to
    // drill must not then be told "none of these lines is in your games yet".
    const totalGames = familyLines.reduce((a, l) => a + l.weight, 0);

    /*
     * THE OPENING MISTAKES, READ FROM THE MINED DECK.
     *
     * `null` until the deck has been read, which the empty state words differently from "read and
     * found nothing" — otherwise the first paint would claim the user had played this opening cleanly
     * before we had looked.
     *
     * Matched on the family's own name. `MinedPuzzle.opening` is the family Lichess recorded for
     * the game, which is the one the user will recognise from their own history; matching on a study
     * lookup instead would classify transpositions they cannot verify.
     */
    const familyMistakes = scanPuzzles === null
      ? []
      : (openingMistakes.get(openFamily.name) ?? []);
    const missedWinCount = familyMistakes.filter((m) => m.kind === 'missed-win').length;
    // `decided` is declared further down, next to the list view that owns it, so this screen
    // counts what it needs for itself rather than reaching into a later declaration.
    const savedHere = Object.keys(repertoire.positions).length;
    const unlocked = linesForRank(allLines, rank.current);
    const moreAtNext = nextRankLineCount(allLines, rank.current);

    return (
      <View style={[s.root, { flex: 1 }]}>
        <View style={{ paddingTop: insets.top + 12 }}>
          <View style={s.header}>
            <Pressable
              onPress={() => { setPhase('list'); setOpenFamilyId(null); stopRef.current = false; }}
              hitSlop={10}
              style={s.backBtn}
              accessibilityLabel="Back to your openings"
            >
              <IconChevronLeft size={18} color={colors.foreground} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={s.h1} numberOfLines={1}>{openFamily.name}</Text>
              <Text style={s.bodySm} numberOfLines={1}>
                {openFamily.side === 'w' ? 'as White' : 'as Black'}
                {rec.games > 0 ? ` · ${rec.games} game${rec.games === 1 ? '' : 's'}` : ''}
                {rec.winRate != null ? ` · ${Math.round(rec.winRate * 100)}% win` : ''}
              </Text>
            </View>
            {savedHere > 0 ? (
              /*
               * `onPress={onTrain}` would hand Train the Pressable's GESTURE EVENT as its
               * `openingId`, which is a truthy object - so the scope would be set to a garbage id
               * and the drill would silently come up empty. Every call site now passes explicitly.
               */
              <Pressable
                onPress={() => onTrain(openFamily.openingId)}
                hitSlop={8}
                style={s.trainBtn}
                accessibilityLabel={`Train what you have learned in ${openFamily.name}`}
              >
                <IconDumbbell size={14} color={colors.background} />
                <Text style={s.trainBtnText}>Train</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 24, gap: 12 }}>
          {/*
            * THE NAMED STUDIES OF THIS OPENING, and what advancing a rank ADDS.
            *
            * The user's correction: *"there isn't only beginner to novice, these are only
            * the beginning and they keep giving me different studies and lines (for example for
            * the sicilian: dragon, smith moora, classic,…) and keep adding every time i advance
            * not just one line study and keep repeating"*.
            *
            * So the rank is not a depth control. It decides how much of the opening EXISTS, and
            * what appears is different studies - the corpus's own chapters, whose titles are the
            * variation names, which for the Sicilian is Najdorf, Dragon, Classical, Sveshnikov,
            * Taimanov, Accelerated Dragon, Rossolimo.
            */}
          {/*
            * WHERE YOU WENT WRONG, IN THIS OPENING, IN YOUR OWN GAMES.
            *
            * The request was for examples rather than a verdict: *"give me examples from my games in
            * your openings where i made a mistake or blunder on the opening and tell me that i made a
            * mistake/blunder and shows me what to play instead"*. So this lists the actual positions,
            * names the move that was played, and names the move to play instead — three things a
            * rank and a percentage cannot tell you.
            *
            * The data is the mined deck, which `Stats -> Analyse games` already builds from the same
            * archive, so this costs no engine time and cannot disagree with the puzzles tab: both
            * read the same records.
            *
            * Empty states are worded to say WHY, because there are three different reasons and only
            * one of them is "you did nothing wrong": the scan may not have run, it may not have
            * reached these games, or there may genuinely be no opening mistakes here.
            */}
          <Card style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={s.bodySm}>Where you went wrong</Text>
                <Text style={s.rankName}>
                  {familyMistakes.length} in the opening
                </Text>
              </View>
              {missedWinCount > 0 ? (
                <View style={{ alignItems: 'flex-end', flex: 1 }}>
                  <Text style={s.bodySm}>missed wins</Text>
                  <Text style={[s.rankName, { color: colors.bad }]}>{missedWinCount}</Text>
                </View>
              ) : null}
            </View>

            {familyMistakes.length === 0 ? (
              <Text style={s.bodySm}>
                {scanPuzzles === null
                  ? 'Analyse your games in Stats and the openings you get wrong will be listed here.'
                  : 'No mistakes in this opening — either you played it clean, or the scan has not '
                    + 'analysed your games in it yet.'}
              </Text>
            ) : (
              familyMistakes.slice(0, 6).map((m) => (
                <Pressable
                  key={m.id}
                  onPress={() => Linking.openURL(m.gameUrl)}
                  style={s.mistakeRow}
                  accessibilityLabel={`Open the game where you played ${m.playedSan}`}
                >
                  <View style={s.mistakeBadge}>
                    <Text style={s.mistakeBadgeText}>
                      {m.kind === 'missed-win' ? '!' : '??'}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.mistakeLine}>
                      {m.playedSan}
                      <Text style={{ color: colors.mutedForeground }}>  move {m.moveNumber}</Text>
                    </Text>
                    <Text style={s.bodySm} numberOfLines={2}>
                      {describeOpeningMistake(m)}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
            {familyMistakes.length > 6 ? (
              <Text style={s.bodySm}>
                + {familyMistakes.length - 6} more in this opening.
              </Text>
            ) : null}
          </Card>

          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={s.bodySm}>Lines unlocked at {rank.current}</Text>
                <Text style={s.rankName}>{unlocked.length} of {allLines.length} lines</Text>
              </View>
              {rank.next && moreAtNext > 0 ? (
                <View style={{ alignItems: 'flex-end', flex: 1 }}>
                  <Text style={s.bodySm}>{rank.next} adds</Text>
                  <Text style={[s.rankName, { color: colors.gold }]}>+{moreAtNext}</Text>
                </View>
              ) : null}
            </View>
            <Bar
              pct={allLines.length === 0 ? 0 : unlocked.length / allLines.length}
              color={colors.primary}
              height={6}
            />
            <Text style={s.bodySm} numberOfLines={2}>
              {`A rank opens a slice of the opening: ${rank.current} shows ${unlocked.length} of its ${allLines.length} lines. Drilling lines raises the rank and unlocks more — this is not a count of games.`}
            </Text>
            <Text style={s.bodySm} numberOfLines={2}>
              {chaptersCovered(unlocked) > 0
                ? `From ${chaptersCovered(unlocked)} variations: `
                  + [...new Set(unlocked.map((l) => l.chapter))].slice(0, 4).join(' · ')
                : 'No studies for this opening yet.'}
            </Text>
          </Card>

          {/* CURRENT RANK -> NEXT RANK. Derived from something that grows: the mean ring of the
              opening's lines, so it moves when he has drilled. */}
          <Card style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={s.bodySm}>Current rank</Text>
                <Text style={s.rankName}>{rank.current}</Text>
              </View>
              {rank.next ? (
                <View style={{ alignItems: 'center', flex: 1 }}>
                  <Text style={s.bodySm}>Next rank</Text>
                  <Text style={[s.rankName, { color: colors.mutedForeground }]}>{rank.next}</Text>
                </View>
              ) : null}
              <View style={{ alignItems: 'flex-end', flex: 1 }}>
                <Text style={s.bodySm}>Mastery</Text>
                <Text style={[s.rankName, { color: colors.gold }]}>{totalMastery}/10</Text>
              </View>
            </View>
            <Bar pct={totalMastery / 10} color={colors.gold} height={6} />
            <Text style={s.bodySm}>
              Drills go {Math.round(depthForRank(rank.current) / 2)} moves deep at this rank
              {rank.next ? `, ${Math.round(depthForRank(rank.next) / 2)} at ${rank.next}` : ''}.
            </Text>
          </Card>

          <Text style={s.bodySm}>
            {linesForFamily.length} line{linesForFamily.length === 1 ? '' : 's'} from your games,
            {' '}most-played first. The ring is how well you know each one.
            {familyLines.length > linesForFamily.length
              ? ` ${familyLines.length - linesForFamily.length} more are still too short to drill`
                + ' — play more of this opening and they will grow.'
              : ''}
          </Text>

          {linesForFamily.map((l: DrillLine) => (
            <Pressable
              key={l.ref.kind === 'main' ? 'main' : `alt${l.ref.index}`}
              onPress={() => {
                // Record WHAT was chosen, not just where it sits in the list. The engine pass
                // re-derives the family and `alternates` comes back in a different order, so the
                // index alone would have this tapping a line and being given a different one.
                lineSansRef.current = [...l.sans];
                setLineRef(l.ref);
                setPhase('play');
              }}
              style={({ pressed }) => [s.famCard, pressed ? { borderColor: colors.gold } : null]}
              accessibilityLabel={`Drill ${l.preview}`}
            >
              <MasteryRing value={l.mastery} />
              <View style={{ flex: 1 }}>
                <Text style={s.famName} numberOfLines={1}>
                  {l.weight} game{l.weight === 1 ? '' : 's'} · {l.plies} ply{l.plies === 1 ? '' : 'ies'}
                </Text>
                <Text style={s.bodySm} numberOfLines={1}>{l.preview}</Text>
                <Text style={s.bodySm} numberOfLines={1}>
                  {l.decisions} to decide
                  {l.mistakes > 0 ? ` · ${l.mistakes} mistake${l.mistakes === 1 ? '' : 's'}` : ''}
                  {l.asked > 0 ? ` · drilled ${l.asked}x` : ' · not drilled yet'}
                </Text>
              </View>
              <IconChevronRight size={16} color={colors.mutedForeground} />
            </Pressable>
          ))}

          {totalGames === 0 ? (
            <Text style={s.bodySm}>
              None of these lines is in your games yet - they came from our book.
            </Text>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  /* -------------------------------------------------------------- LIST VIEW */

  const decided = Object.keys(repertoire.positions).length;
  const needsWork = families.filter((f) => f.totalDecisions > 0).length;

  return (
    <View style={[s.root, { flex: 1 }]}>
      <View style={{ paddingTop: insets.top + 12 }}>
        <View style={s.header}>
          <Pressable onPress={onExit} hitSlop={10} style={s.backBtn}>
            <IconChevronLeft size={18} color={colors.foreground} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={s.h1}>Your openings</Text>
            <Text style={s.bodySm}>
              {families.length} opening{families.length === 1 ? '' : 's'} from {gameCount} of your games
              {decided > 0 ? ` · ${decided} saved` : ''}
            </Text>
          </View>
          {decided > 0 ? (
            /*
             * The openings LIST, so there is no single opening to be about: Train covers every
             * opening the user has learned material in. See the note on the other call site about
             * why this is not `onPress={onTrain}`.
             */
            <Pressable onPress={() => onTrain()} hitSlop={8} style={s.trainBtn} accessibilityLabel="Train your openings">
              <IconDumbbell size={14} color={colors.background} />
              <Text style={s.trainBtnText}>Train</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24, gap: 10 }}>
        {needsWork > 0 ? (
          <Text style={[s.bodySm, { marginBottom: 2 }]}>
            Tap an opening to play through it. {needsWork} have decisions waiting for you.
          </Text>
        ) : null}

        {families.map((f) => {
          // Membership, not string equality - same reason as the engine pass: a merged
          // family's display name is "A + B" and matches no stored line, so the "N saved"
          // badge read 0 for exactly the families that had been practised most.
          const fLabels = new Set(f.sourceNames ?? [f.sourceName]);
          const adoptedHere = Object.values(repertoire.positions)
            .filter((l) => fLabels.has(l.opening)).length;
          /*
           * Open the line that actually has something to decide, and let the
           * badge describe THAT line.
           *
           * The badge used to count `totalDecisions` — every decision in the
           * family, main line and siblings together — while the tap always opened
           * the MAIN line. When the questions lived in a sibling, the card
           * promised "2 to decide" and the tap delivered a line with none: the
           * promise and the click disagreed, and the user got a dead board with
           * no way to tell why. Making both refer to the same line is the fix.
           */
          const targetRef = lineWithDecisions(f);
          const target = targetRef.kind === 'main'
            ? f.steps
            : (f.alternates[targetRef.index] ?? f.steps);
          /*
   * "N to decide" COUNTS DIFFERENCES; THE RED CHIP BELOW COUNTS MISTAKES.
   *
   * An earlier pass of mine replaced this count with a mistake count and renamed the chip
   * "N to review" - which duplicated the existing red "N mistakes" chip a few lines below,
   * so the same number appeared twice on one card. Reverted. The count here is left alone
   * because it does mean what it says: how many positions stop the line for a decision.
   *
   * The part of the request that DID need changing is upstream of this screen: the family
   * LIST is now ordered by real mistakes first (`mistakes` in openingBuilder), so the
   * openings the user actually got wrong are at the top rather than whichever opening
   * produced the most harmless differences.
   */
  const targetDecisions = target.filter((s) => s.choice != null).length;
          /*
           * How many of the engine-JUDGED positions in this line were actually bad.
           *
           * Counted over the line the user is being sent to, not the family, so the
           * number matches what they will meet if they open it. `verdict` is only
           * non-null once the engine has measured the move, so a family it has not
           * reached yet reads 0 — which is "not known" rather than "clean", and the
           * badge is simply absent, not shown as zero.
           */
          const mistakesHere = target.filter(
            (s) => s.choice?.verdict === 'mistake' || s.choice?.verdict === 'blunder',
          ).length;
          /*
           * "SEE YOUR WIN RATE FOR EACH OPENING TO PINPOINT WEAKNESSES."
           *
           * The weakness signal the list is supposed to be ordered by, measured from his own
           * games rather than asserted. Membership on `sourceNames`, not `===` on the display
           * name: a family that absorbed two Lichess labels has a display name of "A + B" that
           * no single game equals, so an equality test reports 0% on the opening he has played
           * most.
           */
          const rec = familyRecord(f, gamesRef.current);
          return (
            <Pressable
              key={f.id}
              onPress={() => {
                // A new family, so the recorded moves belong to the old one.
                lineSansRef.current = null;
                setOpenFamilyId(f.id);
                setLineRef(targetRef);
                setPhase('lines');
              }}
              style={({ pressed }) => [s.famCard, pressed ? { borderColor: colors.gold } : null]}
            >
              <View style={s.famIcon}>
                <Text style={s.famIconText}>{f.side === 'w' ? '♔' : '♚'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.famName} numberOfLines={1}>{f.name}</Text>
                <Text style={s.bodySm}>
                  {f.games} game{f.games === 1 ? '' : 's'}
                  {rec.winRate != null ? ` · ${Math.round(rec.winRate * 100)}% win` : ''}
                  {rec.meanAccuracy != null ? ` · ${Math.round(rec.meanAccuracy)}% acc` : ''}
                  {' · '}{lineCount(f)} line{lineCount(f) === 1 ? '' : 's'}
                  {adoptedHere > 0 ? ` · ${adoptedHere} saved` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                {targetDecisions > 0 ? (
                  <Chip
                    text={`${targetDecisions} to decide`}
                    color={colors.gold}
                    bg="rgba(212,175,55,0.14)"
                    border="rgba(212,175,55,0.4)"
                  />
                ) : f.inBook ? (
                  <Chip text="On track" color={colors.primary} bg="rgba(46,139,106,0.14)" border="rgba(46,139,106,0.4)" />
                ) : (
                  <Chip text="Engine only" color={colors.mutedForeground} bg="transparent" border={colors.border} />
                )}
                {/*
                 * THE MISTAKES IN THIS OPENING.
                 *
                 * The request: *"show me some positions where I played a mistake …
                 * and say a message to me that it is a mistake"* — so the places to
                 * look have to be findable, and a badge the user cannot see is no
                 * use. The count is of JUDGED positions only (`verdict` is null until
                 * the engine has measured the move), which is why it can be 0 on a
                 * family the engine has not reached yet rather than lying about it.
                 */}
                {mistakesHere > 0 ? (
                  <Chip
                    text={`${mistakesHere} ${mistakesHere === 1 ? 'mistake' : 'mistakes'}`}
                    color={colors.bad}
                    bg="rgba(220,80,80,0.14)"
                    border="rgba(220,80,80,0.4)"
                  />
                ) : null}
                <IconChevronRight size={14} color={colors.mutedForeground} />
              </View>
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => { void clearCachedOpenings(username ?? '').then(() => build(true)); }}
          style={s.refreshBtn}
        >
          <IconRotateCcw size={13} color={colors.mutedForeground} />
          <Text style={s.bodySm}>
            {builtAt
              ? `Up to date ${ageLabel(builtAt)} · re-read my games`
              : 'Re-read my games (takes a while)'}
          </Text>
        </Pressable>

        {decided > 0 ? (
          <Pressable onPress={() => onTrain()} style={s.trainRow}>
            <IconDumbbell size={15} color={colors.gold} />
            <Text style={s.trainRowText}>
              Train your {decided} saved move{decided === 1 ? '' : 's'}
            </Text>
            <IconArrowRight size={14} color={colors.gold} />
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * Positions used to NAME and ROTATE the families, from candidates we already have.
 *
 * Engine-free by design: this is the path that must paint instantly. The engine
 * verdicts for the family the user actually opens are fetched afterwards by the
 * effect above, which is what keeps the list fast and the analysis bounded.
 *
 * Takes the DERIVED CANDIDATES rather than the games, because the derivation is
 * the expensive half (a full chess.js replay of every game) and the screen needs
 * both products of it: the candidates for the engine pass and these positions for
 * the list. Deriving twice is what this signature exists to make impossible.
 */
function positionsFromCandidates(cands: Cand[]): GamePosition[] {
  return analysedPositionsFromCandidates(cands);
}

/**
 * Does this step need the USER, or can the app play it for him?
 *
 * Two things stop the auto-play, and they are not the same thing:
 *
 *   - `choice != null` — a real decision, where he may keep his move or take
 *     ours. This is the only place the comparison UI appears.
 *   - `isUserMove` — an ordinary move of his own with nothing to decide. We show
 *     it with an arrow and he plays it.
 *
 * Everything else is the opponent's reply, which is played for him so he is not
 * asked to guess an opponent's move.
 *
 * WHY THIS IS ONE FUNCTION
 * ------------------------
 * Four places advance the line — `goTo`, `startLine`, and the two branches of
 * `onBoardMove` — and they MUST agree. When they disagreed, a line with no
 * decisions left was walked to its end by whichever one ran last and the user
 * was told he had completed a line he had barely touched.
 */
function needsUser(step: BuilderStep): boolean {
  return step.choice != null || step.isUserMove;
}

/**
 * The squares a SAN move actually touches, from a position.
 *
 * Needed because the mistake record stores SAN — which is what belongs in a message written for a
 * person — while an ARROW needs squares. Deriving them here rather than at each call site keeps the
 * three places that record a mistake from each inventing their own conversion, and it returns null
 * when the move does not apply, which is the honest answer when the position and the recorded move
 * have drifted apart.
 */
function uciFromSan(fen: string, san: string): string | null {
  try {
    const c = new Chess(fen);
    const m = c.move(san);
    return m.from + m.to + (m.promotion ?? '');
  } catch {
    return null;
  }
}

/**
 * Which of a family's lines to open, so the user always lands on a question.
 *
 * WHY THIS EXISTS
 * ---------------
 * A family's decisions are not evenly spread across its lines. Measured on the
 * reference corpus, "Sicilian Defense|w" has a 23-ply main line with NO decision
 * at all while its two siblings carry two between them — and the card, which
 * counted the family total, advertised "2 to decide". Tapping it opened the main
 * line, found no question to stop at, walked the whole line, and painted the
 * finished state over a board with `interactive={false}`. From the outside that
 * is a button that does nothing, and the user said exactly that.
 *
 * The main line stays the default whenever it has a question of its own: it is
 * the line the user meets most often, and "your main line" is the honest label
 * for it. Only when it has nothing to ask do we fall through to the first
 * sibling that does, and if no line has one we return the main line and let the
 * play view explain itself (see `awaitingVerdict`) rather than refusing to open.
 */
/** How many lines a family offers: the spine plus its siblings. */
function lineCount(f: FamilyLine): number {
  return 1 + f.alternates.length;
}

/**
 * THE MASTERY RING - the thing the whole screen is built around.
 *
 * A line is scored on confidence, out of ten, and the score is what grows as you drill. Drawn as a
 * ring around the line's node: a circle with an arc over it, a star in the middle once it is full,
 * and the count underneath.
 *
 * Drawn as SVG rather than assembled from borders because an arc has to be a real arc: a partial
 * ring cannot be made from a bordered `View`, and faking one with two half-masks produces a seam
 * that shows at 1/10 and 9/10 - which are exactly the values a user sees first, and again after a
 * good session.
 */
function MasteryRing({ value, size = 44 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(10, value));
  const stroke = Math.max(3, size * 0.11);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const filled = c * (v / 10);
  const done = v >= 10;

  return (
    <View style={{ width: size, alignItems: 'center' }} accessibilityLabel={`mastery ${v} out of 10`}>
      <Svg width={size} height={size} viewBox="0 0 44 44">
        <Circle cx="22" cy="22" r={r} stroke={colors.subtleFill} strokeWidth={stroke} fill="none" />
        {v > 0 ? (
          <Circle
            cx="22" cy="22" r={r}
            stroke={done ? colors.primary : colors.gold}
            strokeWidth={stroke} fill="none"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${c - filled}`}
            // Start at 12 o'clock rather than 3, so a 1/10 ring is a small mark at the top
            // instead of a sliver on the right that reads as part of the frame.
            transform="rotate(-90 22 22)"
          />
        ) : null}
        <SvgText
          x="22" y="23" textAnchor="middle" alignmentBaseline="central"
          fill={v > 0 ? colors.foreground : colors.mutedForeground}
          fontSize="15" fontWeight="800"
        >
          {done ? '★' : v > 0 ? String(v) : '·'}
        </SvgText>
      </Svg>
      <Text style={{ fontSize: 9, color: colors.mutedForeground, fontFamily: fonts.sans, marginTop: 1 }}>
        {v}/10
      </Text>
    </View>
  );
}

function lineWithDecisions(f: FamilyLine): LineRef {
  if (f.steps.some((s) => s.choice != null)) return { kind: 'main' };
  const i = f.alternates.findIndex((a) => a.some((s) => s.choice != null));
  return i >= 0 ? { kind: 'alt', index: i } : { kind: 'main' };
}

/**
 * The steps of the line a `LineRef` names.
 *
 * `lineWithDecisions` picks the line and the tap records it in `lineRef`; this
 * turns that back into the step list, so the engine can be scoped to the ONE line
 * the user will play rather than the family's whole union of nine. Falls back to
 * the spine when the index is out of range, so a stale ref can never produce an
 * empty line and silently skip the analysis.
 */
function stepsForLine(f: FamilyLine, ref: LineRef): BuilderStep[] {
  if (ref.kind === 'main') return f.steps;
  return f.alternates[ref.index] ?? f.steps;
}

function sideOfCand(c: Cand): 'w' | 'b' {
  return c.side;
}

/**
 * Choose the positions worth spending engine time on for one family.
 *
 * THE SAMPLE IS THE LINE BEING PLAYED, NOT THE WHOLE FAMILY
 * --------------------------------------------------------
 * This used to walk `[family.steps, ...family.alternates]` — the main spine plus
 * all eight siblings — and collect every position on any of them. That union is
 * the whole family's decision set, and the budget scaled to it: measured on the
 * device, one open family produced **91 searches at depth 12**. The user watched
 * a counter climb ("it kept comparing to 82 line i think ... which take very long
 * and this is inacceptable for every move") while nothing he did mattered.
 *
 * But the user plays ONE line. Positions exist only on the trained side's moves,
 * so a 30-ply line offers ~15 of them, and the siblings' positions are only ever
 * reached if he switches lines — which is a different session, and `lineWithDecisions`
 * has already picked the sibling with questions if the main line has none.
 *
 * So the caller passes the steps of the line actually being played and the
 * sample collapses to it. Same coverage where it counts (every position the user
 * will be asked about), a sixth of the searches.
 *
 * WHY NOT `slice(0, N)`
 * ---------------------
 * Slicing the first N candidates looks fair and is not. Candidates come out in
 * game order, so the head is the shallow opening stem — which is shared, cheap
 * to judge, and rarely where the user needs help. The decisions that matter sit
 * DEEPER, and a family with a large pool loses them: Modern Defense had a
 * 160-position pool, only 40 were analysed, and just 16 of its 35 decisions got
 * an engine verdict. The other 19 kept the engine-free record, in which
 * `recommendUci === playedUci`, so those "decisions" silently became no-ops.
 *
 * So the budget is spent on the positions the LINE ACTUALLY LANDS ON first —
 * those are exactly the ones the user will be asked about — and only then padded
 * with the remaining pool so the rebuild still has the full set to rotate.
 */
function sampleForLine(
  candidates: Cand[],
  min: number,
  max: number,
  lines: BuilderStep[][],
): Cand[] {
  const byKey = new Map(candidates.map((c) => [c.key, c]));

  // Where the line stops: every position the user will be asked about, in play
  // order, along the line he is playing.
  const onLine: Cand[] = [];
  const seen = new Set<string>();
  for (const steps of lines) {
    for (const st of steps) {
      const k = st.position?.key;
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const c = byKey.get(k);
      if (c) onLine.push(c);
    }
  }

  // Enough to judge every position the line lands on, then pad with the pool.
  const budget = Math.min(max, Math.max(min, onLine.length));

  const out = onLine.slice(0, budget);
  if (out.length >= budget) return out;

  // Pad with the rest of the pool, most-played first (the same weight the
  // rotation uses), so a short line still gets a useful wider analysis.
  const rest = candidates
    .filter((c) => !seen.has(c.key))
    .sort((a, b) => (b.timesSeen ?? 1) - (a.timesSeen ?? 1));
  for (const c of rest) {
    if (out.length >= budget) break;
    out.push(c);
  }
  return out;
}

/**
 * Splice freshly analysed positions back into the family list.
 *
 * `buildFamilyLines` works on a flat position list, and the rotation needs the
 * family's WHOLE pool -- orphans included, because orphaned positions are what
 * the sibling lines get rotated out of. So this starts from `f.positions` (the
 * pool carried on the family) and substitutes in the analysed record by key.
 *
 * The earlier version rebuilt the pool from `steps` alone. That looked
 * equivalent and was not: it kept only the PLACED positions, so the re-rotation
 * ran over a smaller pool and could return a different, shorter line -- meaning
 * the engine pass silently undid the depth the builder had just recovered.
 * Positions with no engine verdict keep the engine-free record, so a partial
 * analysis still rebuilds correctly rather than dropping the family.
 */
function mergeAnalysed(
  families: FamilyLine[],
  famId: string,
  analysed: GamePosition[],
): GamePosition[] {
  const byKey = new Map(analysed.map((p) => [p.key, p]));
  for (const f of families) {
    if (f.id !== famId) continue;
    return f.positions.map((p) => byKey.get(p.key) ?? p);
  }
  return [];
}

/**
 * What to print under the move the user played.
 *
 * WHY THIS IS NOT `inBook ? 'not our book move' : 'your move'`
 * -----------------------------------------------------------
 * That was the whole of the "the knight move is not in our book while it is
 * clearly on our book" report. `inBook` is a fact about the POSITION — some book
 * for that colour has a move here — and it was being used to make a claim about
 * the MOVE. So a user who played `1...Nf6`, which our King's Indian Defense does
 * teach (as `1.d4 Nf6`), was told his knight was not a book move while the same
 * screen said "We have this".
 *
 * The question is only answerable from the reply set, so that is what it uses. The
 * three honest answers:
 *
 *   - the move is one our books play here  -> "one of our moves"
 *   - we have this position but not that move -> "your move — not one of ours"
 *   - we have nothing here at all           -> "your move"
 */
function playedNote(choice: NonNullable<BuilderStep['choice']>): string {
  const replies = choice.bookReplies;
  if (choice.playedSan && replies.includes(choice.playedSan)) return 'one of our moves';
  if (replies.length > 0) return 'your move — not one of ours';
  return 'your move';
}

/** What to print under our recommendation: a book move, or the engine's. */
function recNote(choice: NonNullable<BuilderStep['choice']>): string {
  return choice.recommendIsBookMove ? 'from our book' : 'engine’s pick';
}

/**
 * "just now" / "20 min ago" / "3 h ago" — how old the family list is.
 *
 * Deliberately coarse. The point is to let the user trust that a fresh read
 * happened, not to be a clock; a minute-level readout would invite them to watch
 * it tick, and an absolute timestamp ("at 14:03") makes them do timezone
 * arithmetic to answer the only question they have, which is "is this recent?".
 */
function ageLabel(builtAt: number): string {
  const mins = Math.floor((Date.now() - builtAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={s.center}>{children}</View>;
}

function CompareRow({ tag, move, color, note, eval: evalText }: {
  tag: string;
  move: string;
  color: string;
  note: string;
  /**
   * The engine's score for THIS move, beside it.
   *
   * The user asked for the eval on both rows: a comparison that says only
   * "your move" and "we recommend e6" leaves the reader to guess how much the
   * difference is. `—` is shown when the engine never judged the move, which is
   * different from a score of zero and must not be drawn as one.
   */
  eval?: string | null;
}) {
  return (
    <View style={s.compareRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.compareTag}>{tag}</Text>
        <Text style={[s.compareMove, { color }]}>{move}</Text>
      </View>
      {evalText ? (
        <View style={s.evalChip}>
          <Text style={s.evalText}>{evalText}</Text>
        </View>
      ) : (
        <Text style={[s.evalText, { opacity: 0.45 }]}>—</Text>
      )}
      <Text style={s.compareNote} numberOfLines={2}>{note}</Text>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={s.legendItem}>
      <View style={[s.legendDot, { backgroundColor: color }]} />
      <Text style={s.bodySm}>{label}</Text>
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const s = themedStyles(() => ({
  root: { flex: 1, paddingHorizontal: 14, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 20 },

  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  backBtn: {
    width: 34, height: 34, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center',
  },
  trainBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: colors.gold,
  },
  trainBtnText: { fontSize: 12, fontWeight: '700', color: colors.background, fontFamily: fonts.sansSemiBold },

  navRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  navText: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  // The eval readout sits directly under the line progress: one row, fixed
  // label, flexible bar, fixed value, so the bar is the only thing that moves.

  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },

  /* family card */
  famCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, padding: 14,
  },
  famIcon: {
    width: 38, height: 38, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)', alignItems: 'center', justifyContent: 'center',
  },
  famIconText: { fontSize: 20, color: colors.gold },
  famName: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground, marginBottom: 2 },
  /** A rank's name in the opening screen's Current -> Next ladder. */
  rankName: { fontFamily: fonts.sansSemiBold, fontSize: 19, color: colors.foreground },

  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, marginTop: 4,
  },
  trainRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)',
    backgroundColor: 'rgba(212,175,55,0.08)', padding: 14,
  },
  trainRowText: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.gold },

  /*
   * The "read our study" row. Green rather than gold, because it is the COURSE
   * (our teaching material) and not the user's own saved repertoire — the two
   * are deliberately different colours everywhere else in this screen.
   */
  courseRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(46,139,106,0.4)',
    backgroundColor: 'rgba(46,139,106,0.08)', padding: 12,
  },
  courseRowText: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.primary },

  /* The "stop testing" control in the play header. Gold, because it is about the test, not the line. */
  stopTest: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)',
  },
  stopTestText: { fontSize: 12, fontFamily: fonts.sansSemiBold, color: colors.gold },

  compareBox: {
    borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.02)', padding: 12, gap: 10,
  },
  /**
   * The "that was a mistake" banner.
   *
   * Deliberately loud, and deliberately separate from the comparison box below it.
   * The comparison says what the options are; this says what happened to HIM, and
   * conflating the two is why a blunder used to read as a repertoire suggestion.
   */
  verdictBox: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(220,80,80,0.45)',
    backgroundColor: 'rgba(220,80,80,0.10)',
  },
  compareRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  compareTag: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans, marginBottom: 2 },
  compareMove: { fontSize: 17, fontWeight: '700', fontFamily: fonts.sansBold },
  compareNote: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans, textAlign: 'right', maxWidth: 130 },
  /** The engine's score chip beside each compared move. */
  evalChip: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  evalText: { fontSize: 12, fontWeight: '700', fontFamily: fonts.sansBold, color: colors.foreground },
  compareDivider: { height: 1, backgroundColor: colors.border, opacity: 0.6 },

  arrowLegend: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 16, height: 3, borderRadius: 2 },

  actionRow: { flexDirection: 'row', gap: 8 },

  altRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  altMove: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },

  stepBack: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },

  feedback: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9,
    borderWidth: 1,
  },
  feedbackOk: { borderColor: 'rgba(46,139,106,0.45)', backgroundColor: 'rgba(46,139,106,0.1)' },
  feedbackBad: { borderColor: 'rgba(220,80,80,0.4)', backgroundColor: 'rgba(220,80,80,0.08)' },
  feedbackText: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 12 },

  toast: {
    position: 'absolute', left: 14, right: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14,
  },
  toastText: { fontSize: 12, color: colors.foreground, fontFamily: fonts.sansSemiBold },

  h1: { fontFamily: fonts.sansBold, fontSize: 17, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  /*
   * The opening-mistake rows.
   *
   * A filled badge in the QUALITY colour rather than the app's accent, so a mistake row reads as a
   * verdict at a glance and cannot be mistaken for a link. The missed-win badge is the same red � a
   * missed win is a blunder, and the difference is in the words beside it, not in a second colour
   * that would only be decorative.
   */
  mistakeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  mistakeBadge: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(220, 80, 80, 0.16)', borderWidth: 1, borderColor: 'rgba(220, 80, 80, 0.5)',
  },
  mistakeBadgeText: { color: colors.bad, fontSize: 13, fontFamily: fonts.sansBold },
  mistakeLine: { fontSize: 15, fontFamily: fonts.sansBold, color: colors.foreground },
  solvedText: { fontSize: 13, fontWeight: '600', color: colors.primary, fontFamily: fonts.sansSemiBold, flex: 1 },
}));
