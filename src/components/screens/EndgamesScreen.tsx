'use client';

/**
 * Endgames screen — RN port of the web `screens/EndgamesScreen.tsx`.
 *
 * Two tabs, mirroring the Puzzles screen (Training / Classics):
 *
 *  • Training — an always-fresh endgame position served the moment the tab is
 *    shown, tiered to the user's advancement (Auto / Beginner / Intermediate /
 *    Advanced / Pro). Positions are generated live (random theoretical mates)
 *    or drawn from the engine-verified pool; nothing repeats until the pool
 *    runs dry. There is no "start" gate — the board is playable immediately.
 *
 *  • Course — the curated lesson catalogue, played out vs a human-like
 *    Stockfish (UCI_Elo limited).
 *
 * Goals: 'mate' (deliver mate), 'promote' (win the pawn race), 'survive'
 * (hold the draw for N moves).
 *
 * Deviation from the web: the web renders the trainer as a card you must press
 * "Start training" on, below a long lesson list. Here the trainer is the
 * default tab and behaves like the puzzle trainer.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import Storage from 'expo-sqlite/kv-store';
import { Chess } from 'chess.js';
import endgamesData from '@/data/endgames.json';
import { ChessForgeBoard } from '@/components/chess/ChessForgeBoard';
import { DriftBadge } from '@/components/chess/DriftBadge';
import { EvalBar } from '@/components/chess/EvalBar';
import { MoveList } from '@/components/chess/MoveList';
import { getEngine, type EngineEval } from '@/lib/engine';
import { playMoveSound, playEffect } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import {
  nextTrainerExercise, nextTrainerExerciseOnline, fetchLessonExample, autoTier, tierLabel,
  type TrainerExercise, type TrainerTier,
} from '@/lib/endgameTrainer';
import { deltaForAttempt } from '@/lib/rating';
import { movableSquares, targetSquares } from '@/lib/hint';
import { Card, Btn, IconBtn, Segmented, Spinner } from '@/components/ui/Primitives';
import {
  IconChevronLeft, IconChevronDown, IconCrown, IconGraduationCap, IconPlay, IconRotateCcw,
  IconTrophy, IconXCircle, IconBookOpen, IconLightbulb, IconEye, IconGlobe,
} from '@/components/ui/Icons';
import { arrowColors, colors, fonts, themedStyles } from '@/theme/tokens';

interface EndgameDef {
  id: string;
  title: string;
  category: string;
  fen: string;
  userSide: 'w' | 'b';
  goal: 'mate' | 'promote' | 'survive';
  maxMoves: number;
  engineElo: number;
  lesson: string;
  keyIdea: string;
  /**
   * Provenance line shown on the brief when the board is a fetched internet
   * position rather than the lesson's canonical FEN. Absent for book lessons.
   */
  sourceNote?: string;
}

const ENDGAMES = endgamesData as unknown as EndgameDef[];

const GOAL_LABEL: Record<EndgameDef['goal'], string> = {
  mate: 'Deliver checkmate',
  promote: 'Promote / win the pawn',
  survive: 'Hold the draw',
};

const TIER_KEY = 'chessforge.endgame.tier.v1';
const TRAINER_SOLVED_KEY = 'chessforge.endgame.trainerSolved.v1';
/**
 * The four bands plus `auto`, in menu order.
 *
 * `TIER_KEY` persists the chosen id, so renaming these ids means a previously saved choice no longer
 * matches and the screen falls back to `auto` — which is the desired behaviour anyway, since `auto`
 * recomputes the band from the player's rating. Nothing is lost that the user chose deliberately;
 * there is no migration to write, because the guard below treats an unrecognised stored value as
 * "no choice made" rather than passing it through.
 */
const TIERS = ['auto', 'warmup', 'steady', 'sharp', 'relentless'] as const;

/** Adapt a generated/pool exercise to the shape the player understands. */
function toDef(ex: TrainerExercise): EndgameDef {
  return {
    id: ex.id,
    title: ex.title,
    category: ex.category,
    fen: ex.fen,
    userSide: ex.userSide,
    goal: ex.goal,
    maxMoves: ex.maxMoves,
    engineElo: ex.engineElo,
    lesson: ex.brief,
    keyIdea: ex.keyIdea,
  };
}

export function EndgamesScreen() {
  const store = useAppStore();
  const progress = store.endgames;

  const [tab, setTab] = useState<'training' | 'course'>('training');
  const [openLesson, setOpenLesson] = useState<EndgameDef | null>(null);
  const [tierChoice, setTierChoice] = useState<'auto' | TrainerTier>('auto');
  const [trainerSolved, setTrainerSolved] = useState(0);
  const [session, setSession] = useState({ solved: 0, total: 0 });
  const [trainerEx, setTrainerEx] = useState<TrainerExercise | null>(null);
  const [lastDelta, setLastDelta] = useState<number | null>(null);
  const usedPoolIds = useRef<Set<string>>(new Set());
  // Live "real game" examples fetched per lesson, keyed by lesson id. Held here
  // (not in EndgameSession) so reopening a lesson reuses what we already paid
  // for instead of hitting the network again.
  const [liveExamples, setLiveExamples] = useState<Record<string, TrainerExercise>>({});
  const [exampleBusy, setExampleBusy] = useState<string | null>(null);
  const [exampleFailed, setExampleFailed] = useState<string | null>(null);
  const exampleIds = useRef<Set<string>>(new Set());
  const hydrated = useRef(false);

  /**
   * Fetch a real internet position matching a course lesson's theme.
   *
   * THE USER'S CORRECTION
   * ---------------------
   * "in the course just start playing directly and whenever he clicks on next he
   * gets a new example (that's what i wanted, not giving him to choose between
   * start playing and 'or practise in a real game')"
   *
   * So the example is no longer an OPTION the user opts into — it IS the lesson
   * content. Opening a lesson fetches one and drops you straight onto the board,
   * and "Next" fetches the following one. The two-button brief is gone.
   *
   * `force` is what makes "Next" work: without it the cache short-circuit below
   * would hand back the position already on the board, so pressing Next would
   * appear to do nothing.
   */
  const loadExample = useCallback(async (lesson: EndgameDef, force = false) => {
    if (exampleBusy) return;
    setExampleFailed(null);
    setExampleBusy(lesson.id);
    const ex = await fetchLessonExample(lesson.category, exampleIds.current);
    setExampleBusy(null);
    if (!ex) {
      // Offline, rate-limited, or no puzzle in this theme. Kept as an
      // explanation rather than an error, and the lesson's own position is
      // still playable underneath.
      if (force) setExampleFailed(lesson.id);
      return;
    }
    setLiveExamples((prev) => ({ ...prev, [lesson.id]: ex }));
  }, [exampleBusy]);

  /**
   * Opening a course lesson fetches its example and plays it immediately.
   *
   * Doing it in an effect on `openLesson` (rather than behind a button) is the
   * whole change: "just start playing directly". Guarded on `liveExamples` so
   * returning to a lesson you already fetched does not re-hit the network.
   */
  useEffect(() => {
    if (!openLesson) return;
    if (liveExamples[openLesson.id]) return;
    void loadExample(openLesson);
    // `liveExamples` deliberately omitted: including it would re-run this on the
    // very state change it produces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLesson?.id]);

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [savedTier, savedSolved] = await Promise.all([
          Storage.getItem(TIER_KEY),
          Storage.getItem(TRAINER_SOLVED_KEY),
        ]);
        if (!alive) return;
        // Flip the flag *before* the setState calls so the persist effect below
        // cannot overwrite the stored count with the initial 0.
        hydrated.current = true;
        if (savedTier && (TIERS as readonly string[]).includes(savedTier)) {
          setTierChoice(savedTier as 'auto' | TrainerTier);
        }
        const n = Math.floor(Number(savedSolved ?? '0'));
        if (Number.isFinite(n) && n > 0) setTrainerSolved(n);
      } catch {
        hydrated.current = true; // kv unavailable — run with defaults
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    void Storage.setItem(TRAINER_SOLVED_KEY, String(trainerSolved)).catch(() => {});
  }, [trainerSolved]);

  const changeTier = (t: 'auto' | TrainerTier) => {
    setTierChoice(t);
    void Storage.setItem(TIER_KEY, t).catch(() => {});
  };

  /* ---------------- trainer ---------------- */

  const completedCount = useMemo(
    () => Object.entries(progress).filter(([id, p]) => id !== 'trainer' && p.completed).length,
    [progress],
  );

  const effTier: TrainerTier = tierChoice === 'auto'
    ? autoTier(store.profile.endgameRating, completedCount, trainerSolved)
    : tierChoice;

  /*
   * A REQUEST TOKEN, NOT A CLEANUP FUNCTION.
   *
   * Declared above the effect below, because the effect closes over it and a
   * `const` read from a closure created earlier in the same render is a
   * temporal-dead-zone trap waiting for the next person to reorder these.
   *
   * `nextTrainer` used to `return () => { alive = false; }` — but it is wired
   * straight to a `Pressable`'s `onPress`, so its return value is DISCARDED. The
   * guard was inert: `alive` was set true and never set false, and every fetch
   * applied itself whenever it landed.
   *
   * The damage is worse than a wasted fetch. `EndgameSession` is keyed on
   * `trainerEx.id`, so a slow fetch from press #1 arriving after press #2 changes
   * the key and React REMOUNTS the session — discarding the drill the user is in
   * the middle of, along with every move they have played in it.
   *
   * A monotonically increasing token is the shape that fits both callers: each
   * request takes the current number and only applies if the number is still
   * current when it resolves. It needs no cooperation from the caller, so it is
   * correct whether invoked from a press, an effect, or a timeout.
   */
  const trainerReq = useRef(0);

  // Serve a fresh position as soon as Training is shown, and again whenever the
  // effective tier changes (new difficulty → new position).
  //
  // The ONLINE variant is used so the position is a real endgame from the
  // internet whenever we have a connection, falling back to a generated / pooled
  // one offline. Both paths always yield a position, so the effect can stay
  // fire-and-forget.
  useEffect(() => {
    if (tab !== 'training') return;
    // Same token as `nextTrainer`, so an in-flight fetch from this effect cannot
    // land on top of a position the user has since asked for by pressing "Next".
    // Before this, switching tiers and pressing Next raced each other.
    const req = ++trainerReq.current;
    setSession({ solved: 0, total: 0 });
    void (async () => {
      const ex = await nextTrainerExerciseOnline(effTier, usedPoolIds.current);
      if (req === trainerReq.current) setTrainerEx(ex);
    })();
    // No cleanup needed: the token invalidates this request when the next one
    // starts, which is the same guarantee a cleanup flag gave, and it also covers
    // the case a cleanup could not — the user leaving the tab and coming back.
  }, [tab, effTier]);

  const nextTrainer = useCallback(() => {
    // Set a local position immediately so the button feels instant, then upgrade
    // to an internet one when it arrives. Serving the local position first also
    // means the trainer is fully usable offline.
    const req = ++trainerReq.current;
    setTrainerEx(nextTrainerExercise(effTier, usedPoolIds.current));
    void (async () => {
      const ex = await nextTrainerExerciseOnline(effTier, usedPoolIds.current);
      // Only if no newer request has been issued since this one started.
      if (req === trainerReq.current) setTrainerEx(ex);
    })();
  }, [effTier]);

  const handleTrainerComplete = useCallback((xp: number, usedHint = false) => {
    setSession((st) => ({ solved: st.solved + 1, total: st.total + 1 }));
    setTrainerSolved((n) => n + 1);
    // Elo against the position's own engine Elo, so a harder drill is worth
    // more and a hint costs real rating (see src/lib/rating.ts).
    const { delta } = deltaForAttempt(
      useAppStore.getState().profile.endgameRating,
      trainerEx?.engineElo ?? 1500,
      { solved: true, madeMistake: false, usedHint },
    );
    setLastDelta(delta);
    useAppStore.getState().applyResult({
      type: 'endgame', xp, correct: 1, total: 1,
      endgame: { lessonId: 'trainer', completed: true, ratingDelta: delta },
    });
  }, [trainerEx]);

  const handleTrainerAttempt = useCallback((xp: number, usedHint = false) => {
    setSession((st) => ({ ...st, total: st.total + 1 }));
    const { delta } = deltaForAttempt(
      useAppStore.getState().profile.endgameRating,
      trainerEx?.engineElo ?? 1500,
      { solved: false, madeMistake: true, usedHint },
    );
    setLastDelta(delta);
    useAppStore.getState().applyResult({
      type: 'endgame', xp, correct: 0, total: 1,
      endgame: { lessonId: 'trainer', completed: false, ratingDelta: delta },
    });
  }, [trainerEx]);

  /* ---------------- course lessons ---------------- */

  const categories = useMemo(() => {
    const map = new Map<string, EndgameDef[]>();
    for (const e of ENDGAMES) {
      if (!map.has(e.category)) map.set(e.category, []);
      map.get(e.category)!.push(e);
    }
    return [...map.entries()];
  }, []);

  const lessonId = openLesson?.id ?? null;
  // When a real-game example is on the board, credit and rate against ITS
  // difficulty rather than the book lesson's — the fetched position is scaled by
  // the source puzzle's rating, so using the lesson's fixed Elo would misprice
  // the attempt in both directions.
  const activeElo = openLesson
    ? (liveExamples[openLesson.id]?.engineElo ?? openLesson.engineElo)
    : 1500;
  const handleComplete = useCallback((xp: number, usedHint = false) => {
    if (!lessonId) return;
    const { delta } = deltaForAttempt(
      useAppStore.getState().profile.endgameRating,
      activeElo,
      { solved: true, madeMistake: false, usedHint },
    );
    setLastDelta(delta);
    useAppStore.getState().applyResult({
      type: 'endgame', xp, correct: 1, total: 1,
      endgame: { lessonId, completed: true, ratingDelta: delta },
    });
  }, [lessonId, activeElo]);
  const handleAttempt = useCallback((xp: number, usedHint = false) => {
    if (!lessonId) return;
    const { delta } = deltaForAttempt(
      useAppStore.getState().profile.endgameRating,
      activeElo,
      { solved: false, madeMistake: true, usedHint },
    );
    setLastDelta(delta);
    useAppStore.getState().applyResult({
      type: 'endgame', xp, correct: 0, total: 1,
      endgame: { lessonId, completed: false, ratingDelta: delta },
    });
    // `activeElo` is read in the body, so it belongs in the deps. It was not, and
    // `openLesson` was — which is a proxy for it only until the user presses "New
    // example": that swaps the example without changing the lesson, so `openLesson`
    // stays referentially identical, the callback is never rebuilt, and every
    // subsequent failed attempt is scored against the PREVIOUS position's engine.
    //
    // `handleComplete` two blocks up already gets this right with
    // `[lessonId, activeElo]`. The asymmetry between the two was the tell: one
    // handler rated a real-time example and one rated a book lesson, and only the
    // book one could go stale.
  }, [lessonId, activeElo]);

  /* ---------------- course lesson player (full screen) ---------------- */

  if (openLesson) {
    // When a live example is active, the board plays the *internet* position but
    // keeps the lesson's prose, goal and key idea. `EndgameSession` is keyed on
    // the id so switching positions remounts it with a clean board rather than
    // trying to carry move history across two unrelated positions.
    const example = liveExamples[openLesson.id] ?? null;
    const busy = exampleBusy === openLesson.id;

    /*
     * The lesson keeps its own prose, goal and key idea; the EXAMPLE supplies
     * the position. That split is deliberate — the text is the teaching, the
     * position is the practice, and a fetched position's theme string is shown
     * as provenance rather than replacing the lesson's own idea.
     *
     * When no example has arrived yet (still fetching, or offline) the lesson's
     * canonical position is played instead, so a lesson is never a dead screen.
     */
    const activeLesson: EndgameDef = example
      ? {
          ...openLesson,
          fen: example.fen,
          userSide: example.userSide,
          goal: example.goal,
          lesson: example.brief,
          sourceNote: `Real game position · ${example.category}`,
        }
      : openLesson;

    return (
      <View style={s.playerRoot}>
        <View style={s.topBar}>
          <Pressable onPress={() => setOpenLesson(null)} style={s.backBtn} accessibilityLabel="Back">
            <IconChevronLeft size={20} color={colors.foreground} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={s.topTitle} numberOfLines={1}>{openLesson.title}</Text>
            <Text style={s.bodySm}>
              {GOAL_LABEL[activeLesson.goal]} · ≤{activeLesson.maxMoves} moves
              {busy ? ' · finding a position…' : example ? ' · real game' : ''}
            </Text>
          </View>
          {/*
            "whenever he clicks on next he gets a new example" — so the refresh
            control lives in the top bar, not on the board. It is available while
            playing, because wanting a different position is exactly the moment
            you realise the current one is not the theme you came for.
          */}
          <Pressable
            onPress={() => { void loadExample(openLesson, true); }}
            hitSlop={8}
            style={s.nextExBtn}
            accessibilityLabel="Get another example"
          >
            {busy ? <Spinner size={13} /> : <IconRotateCcw size={14} color={colors.chessforge} />}
            <Text style={s.nextExText}>{exampleFailed === openLesson.id ? 'Retry' : 'New example'}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <EndgameSession
            key={`${openLesson.id}:${example ? example.id : 'book'}`}
            lesson={activeLesson}
            // "just start playing directly" — the brief is no longer a gate.
            autoStart
            onComplete={handleComplete}
            onAttempt={handleAttempt}
            /* "Next" loads the next real position rather than a book one. */
            onNext={() => { void loadExample(openLesson, true); }}
            nextLabel="New example"
          />
        </ScrollView>
      </View>
    );
  }

  /* ---------------- hub ---------------- */

  return (
    <View style={s.root}>
      <View style={s.titleRow}>
        <IconCrown size={20} color={colors.gold} />
        <Text style={s.h1}>Endgames</Text>
        <View style={{ flex: 1 }} />
        {/* Endgame rating — moves with results, and drives the Auto tier. */}
        <Text style={s.ratingText}>
          {store.profile.endgameRating}
          {lastDelta !== null ? (
            <Text style={lastDelta >= 0 ? s.deltaUp : s.deltaDown}>
              {'  '}{lastDelta >= 0 ? `+${lastDelta}` : `${lastDelta}`}
            </Text>
          ) : null}
        </Text>
      </View>
      <Text style={[s.body, { lineHeight: 17 }]}>
        {tab === 'training'
          ? 'Fresh endgame positions, matched to your level — nothing repeats until the pool runs dry.'
          : 'Fundamental mates and practical technique — played out against a human-like engine until converted.'}
      </Text>

      <Segmented
        options={[
          { id: 'training' as const, label: 'Training' },
          { id: 'course' as const, label: 'Course' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'training' ? (
        trainerEx ? (
          <View style={{ gap: 12 }}>
            {/* tier selector — Auto follows your results */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {TIERS.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => changeTier(t)}
                  style={[s.tierChip, tierChoice === t ? s.tierChipActive : null]}
                >
                  <Text style={[s.tierChipText, tierChoice === t ? { color: colors.gold } : null]}>
                    {t === 'auto'
                      ? `Auto · ${tierLabel(autoTier(store.profile.endgameRating, completedCount, trainerSolved))}`
                      : tierLabel(t)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <EndgameSession
              key={trainerEx.id}
              lesson={toDef(trainerEx)}
              autoStart
              onComplete={handleTrainerComplete}
              onAttempt={handleTrainerAttempt}
              onNext={nextTrainer}
              footer={
                <View style={{ gap: 4 }}>
                  <Text style={[s.bodySm, { textAlign: 'center' }]}>
                    {/*
                     * THREE DISTINCT CLAIMS, THREE DISTINCT LABELS.
                     *
                     * This was a two-way branch, so a position fetched from a real
                     * internet game — and a position this app synthesised — both
                     * printed "Generated live", while "Engine-verified position" was
                     * reserved for the local pool. The user was told the app had
                     * invented a position it had actually downloaded, and the one
                     * label meaning "somebody checked this" was spent on the
                     * smallest of the three categories.
                     */}
                    {trainerEx.source === 'pool' ? 'Engine-verified position'
                      : trainerEx.source === 'live' ? 'Real game position'
                        : 'Generated live'} · {tierLabel(effTier)} tier
                  </Text>
                  <Text style={[s.bodySm, { textAlign: 'center' }]}>
                    This session: <Text style={{ color: colors.primary, fontWeight: '600' }}>{session.solved}</Text> solved
                    {' '}· positions never repeat until the pool runs dry
                  </Text>
                </View>
              }
            />
          </View>
        ) : (
          <Card style={{ padding: 32, alignItems: 'center', gap: 12 }}>
            <Spinner />
            <Text style={[s.bodySm, { textAlign: 'center' }]}>Building a fresh position for your level…</Text>
          </Card>
        )
      ) : (
        <View style={{ gap: 16 }}>
          <Text style={s.bodySm}>
            <Text style={{ color: colors.foreground, fontWeight: '600' }}>{completedCount}</Text>/{ENDGAMES.length} completed
          </Text>
          {categories.map(([cat, lessons]) => (
            <View key={cat} style={{ gap: 8 }}>
              <Text style={s.categoryTitle}>{cat}</Text>
              {lessons.map((l) => {
                const done = progress[l.id]?.completed;
                const tries = progress[l.id]?.attempts ?? 0;
                return (
                  <Pressable
                    key={l.id}
                    onPress={() => setOpenLesson(l)}
                    style={({ pressed }) => [s.lessonCard, pressed ? { borderColor: 'rgba(212,175,55,0.3)' } : null]}
                  >
                    <View style={[s.lessonIcon, done ? { backgroundColor: 'rgba(212,175,55,0.15)' } : null]}>
                      {done
                        ? <IconTrophy size={18} color={colors.gold} />
                        : <IconGraduationCap size={18} color={colors.mutedForeground} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.lessonTitle} numberOfLines={1}>{l.title}</Text>
                      <Text style={s.bodySm} numberOfLines={1}>{l.keyIdea}</Text>
                      <Text style={[s.bodySm, { opacity: 0.7 }]}>
                        {GOAL_LABEL[l.goal]} · ≤{l.maxMoves} moves{tries > 0 ? ` · ${tries} attempt${tries > 1 ? 's' : ''}` : ''}
                      </Text>
                    </View>
                    <IconPlay size={16} color={colors.gold} />
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/* ============================ shared player ============================ */

/**
 * The board session used by both the endless trainer and the course lessons.
 * `autoStart` skips the lesson brief so a fresh trainer position is playable
 * the instant it appears.
 */
function EndgameSession({ lesson, autoStart, onComplete, onAttempt, onNext, nextLabel, footer }: {
  lesson: EndgameDef;
  autoStart: boolean;
  /** `usedHint` is passed through so the caller can dock the rating for help. */
  onComplete: (xp: number, usedHint: boolean) => void;
  onAttempt: (xp: number, usedHint: boolean) => void;
  onNext?: () => void;
  /**
   * What the next-position button says.
   *
   * In the course it is "New example", because `onNext` fetches a fresh
   * internet position for the lesson's theme; in the endless trainer it is the
   * default "Next position". The label is a prop rather than a branch inside the
   * button so the two callers state their own intent.
   */
  nextLabel?: string;
  footer?: React.ReactNode;
}) {
  const userSide = lesson.userSide;
  const engineSide = userSide === 'w' ? 'b' : 'w';

  const [showBrief, setShowBrief] = useState(!autoStart);
  const [chess] = useState(() => new Chess(lesson.fen));
  const [fen, setFen] = useState(lesson.fen);
  const [sans, setSans] = useState<string[]>([]);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [status, setStatus] = useState<'playing' | 'won' | 'lost'>('playing');
  const [resultMsg, setResultMsg] = useState('');
  const [showLessonText, setShowLessonText] = useState(false);
  const [engineWarming, setEngineWarming] = useState(false);
  // Hint stage: 0 = none, 1 = ring the ONE piece the engine would move, 2 = also dot where it can go.
  const [hintStage, setHintStage] = useState(0);
  /**
   * The square the hint rings, once the engine has answered.
   *
   * THE REPORT: *"the hint doesnt work in a place and selects all the pieces in another place"*.
   *
   * Endgames was the "all the pieces" half. A hint here was `movableSquares`, which falls back to
   * EVERY piece with a legal move whenever nothing captures or checks — and in an endgame that is the
   * normal case, because the right move is usually a quiet king or rook improvement. So the button
   * that is supposed to narrow the position widened it, and told the player nothing.
   *
   * There is no stored answer on this screen. It is a play-out against the engine, not a puzzle with a
   * solution, so "which piece" has to be asked of the engine — and asking it for the PIECE and drawing
   * only the ORIGIN square keeps the module's contract intact: the hint names a piece, never the move.
   * The engine's full answer is still not shown.
   *
   * The search is 400ms and it happens on the press rather than on every render, so it costs one
   * bounded wait when the user asks for help and nothing at all when they do not.
   */
  const [hintPiece, setHintPiece] = useState<string[]>([]);
  const userMoveCount = useRef(0);
  const [moveCountDisplay, setMoveCountDisplay] = useState(0);
  const recorded = useRef(false);
  /** Revealed help is not free — see src/lib/rating.ts. */
  const usedHintRef = useRef(false);

  const engine = useMemo(() => getEngine(), []);
  useEffect(() => { void engine.init(); }, [engine]);

  const turn = chess.turn();
  const userTurn = turn === userSide && status === 'playing' && !showBrief;
  const engineThinking = !showBrief && status === 'playing' && turn === engineSide;

  const evaluateEnd = useCallback((c: Chess, justPromoted: boolean, afterEngine: boolean): { end: 'won' | 'lost' | null; msg: string } => {
    const userWon = c.turn() !== userSide && c.isCheckmate(); // side to move got mated = user delivered
    const userMated = c.turn() === userSide && c.isCheckmate();
    if (userWon) return { end: 'won', msg: 'Checkmate — goal accomplished!' };
    if (userMated) return { end: 'lost', msg: 'Your king is mated. Review the key idea and retry.' };
    if (c.isStalemate()) {
      return lesson.goal === 'survive'
        ? { end: 'won', msg: 'Stalemate — a draw is a success here!' }
        : { end: 'lost', msg: 'Stalemate — no legal moves. Try keeping more winning chances.' };
    }
    if (c.isInsufficientMaterial()) {
      return lesson.goal === 'survive'
        ? { end: 'won', msg: 'Insufficient material — draw held!' }
        : { end: 'lost', msg: 'Draw by insufficient material — not enough winning chances left.' };
    }
    if (justPromoted && lesson.goal === 'promote') {
      return { end: 'won', msg: 'Pawn promoted — technique complete!' };
    }
    const budgetReached = afterEngine || lesson.goal === 'survive';
    if (budgetReached && userMoveCount.current >= lesson.maxMoves) {
      if (lesson.goal === 'survive') return { end: 'won', msg: `Survived ${lesson.maxMoves} moves — draw held!` };
      if (c.isDraw()) return { end: 'lost', msg: 'Draw — the win slipped away within the move budget.' };
      return { end: 'lost', msg: `Out of the ${lesson.maxMoves}-move budget. Try a more direct method.` };
    }
    return { end: null, msg: '' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSide, lesson]);

  const finishWith = useCallback((end: 'won' | 'lost', msg: string) => {
    setStatus(end);
    setResultMsg(msg);
    if (end === 'won') playEffect('success');
    if (!recorded.current) {
      recorded.current = true;
        if (end === 'won') onComplete(30, usedHintRef.current);
      else onAttempt(5, usedHintRef.current);
    }
  }, [onComplete, onAttempt]);

  // engine reply effect
  useEffect(() => {
    if (showBrief || status !== 'playing') return;
    if (chess.turn() !== engineSide) return;
    let cancelled = false;
    (async () => {
      const fenNow = chess.fen();
      await engine.init();
      if (cancelled || status !== 'playing') return;

      // Only wait on a real search when the engine is actually up; otherwise the
      // first move would hang for the full search timeout.
      const uci = engine.isReady ? await engine.bestMove(fenNow, 500, lesson.engineElo) : null;
      if (cancelled || status !== 'playing') return;

      let played: { from: string; to: string; san: string } | null = null;
      if (uci) {
        try {
          const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
          played = { from: m.from, to: m.to, san: m.san };
        } catch { played = null; }
      }
      if (!played) {
        // Engine unavailable or unusable — play a legal move so the drill keeps
        // going instead of freezing on "Engine thinking…".
        const legal = chess.moves();
        if (!legal.length) return;
        try {
          const m = chess.move(legal[Math.floor(Math.random() * legal.length)]);
          played = { from: m.from, to: m.to, san: m.san };
          setEngineWarming(true);
        } catch { return; }
      } else {
        setEngineWarming(false);
      }

      const move = played;
      playMoveSound(move);
      setSans((st) => [...st, move.san]);
      setLastMove({ from: move.from, to: move.to });
      setFen(chess.fen());
      const r = evaluateEnd(chess, false, true);
      if (r.end) finishWith(r.end, r.msg);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen, showBrief, status, evaluateEnd, finishWith, engine, engineSide, chess, lesson.engineElo]);

  const handleMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!userTurn) return false;
    let m;
    try { m = chess.move({ from, to, promotion }); } catch { return false; }
    playMoveSound(m);
    setHintStage(0);
    userMoveCount.current += 1;
    setMoveCountDisplay(userMoveCount.current);
    setSans((st) => [...st, m.san]);
    setLastMove({ from: m.from, to: m.to });
    setFen(chess.fen());
    const r = evaluateEnd(chess, Boolean(m.promotion), false);
    if (r.end) finishWith(r.end, r.msg);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userTurn, chess, evaluateEnd, finishWith]);

  /*
   * Hint: ring the pieces that can move. Press again to dot where they can go.
   *
   * THIS USED TO ASK THE ENGINE FOR ITS BEST MOVE AND DRAW IT AS AN ARROW, which is the solution
   * rather than a hint — see `@/lib/hint` for why that is not a smaller problem than it looks. The
   * engine call, the Elo override and the 700ms search are all gone with it, which also means the
   * button no longer blocks on a search: highlighting is a board read, not a computation.
   *
   * The hint still costs rating (`usedHintRef`), because the second press genuinely narrows the
   * position a long way, and a hint that was free would be pressed on every position.
   */
  /*
   * THE PRESS ONLY ADVANCES THE STAGE.
   *
   * The engine ask lives in the effect below rather than here, for two reasons that both bite: it
   * reads `boardFen`, which is declared further down the component, and a search started from an
   * event handler cannot be cancelled when the user moves on — so a late answer would ring a square
   * on a position it was never asked about.
   */
  const showHint = useCallback(() => {
    if (!userTurn || status !== 'playing') return;
    usedHintRef.current = true;
    // 0 -> ring the piece, 1 -> add the destination dots, 2 -> off again.
    setHintStage((s) => (s + 1) % 3);
  }, [userTurn, status]);


  const reset = () => {
    // Restarting invalidates any side line: bump the search generation first so
    // an in-flight reply from an exploration cannot land on the fresh drill.
    exploreGenRef.current++;
    setExplore(null);
    setExploreEval(null);
    setExploreReplyMove(null);
    setExploreThinking(false);
    recorded.current = false;
    usedHintRef.current = false;
    userMoveCount.current = 0;
    setMoveCountDisplay(0);
    setHintStage(0);
    chess.load(lesson.fen);
    setFen(lesson.fen);
    setSans([]);
    setLastMove(null);
    setStatus('playing');
    setResultMsg('');
    setShowBrief(!autoStart);
    setShowLessonText(false);
  };

  /*
   * Explore ("drift") mode for endgames.
   *
   * The endgame drill has a goal and a move budget, so free play must not be
   * allowed to touch any of that state — otherwise a curiosity would burn the
   * attempt. Instead exploring runs on a *shadow* board : `baseFen`/`baseSans`
   * snapshot the drill position, and every move in the side line lives only in
   * `exploreSans`. "Return to drill" throws the side line away and the drill is
   * exactly as it was. Like every other screen there is no depth cap, and the
   * engine answers every move the user does not make themselves.
   */
  const [explore, setExplore] = useState<{ baseFen: string; baseSans: string[]; sans: string[] } | null>(null);
  const [exploreEval, setExploreEval] = useState<EngineEval | null>(null);
  const [exploreThinking, setExploreThinking] = useState(false);
  const [exploreReplyMove, setExploreReplyMove] = useState<{ from: string; to: string } | null>(null);
  const exploreGenRef = useRef(0);

  /*
   * WHOSE MOVE IT IS — ASK THE BOARD, DO NOT COUNT PLIES.
   *
   * This was `(baseSans.length + sans.length) % 2 === 0 ? 'w' : 'b'`, which
   * assumes the side-line started with White to move. It did not: `baseSans` is the
   * position the user branched from, and for every black-to-move drill — `userSide:
   * 'b'` in the pool, and every live internet position that comes back that way —
   * the parity is inverted. The consequences were concrete and visible:
   *
   *   - the first "Explore" move was played BY THE ENGINE while the status line said
   *     "Engine answering your idea…", so the user appeared to be ignored; and
   *   - the eval bar's sign was flipped for the whole side line
   *     (`scoreCp` is White-relative, so the wrong side gets the wrong sign), which
   *     is the easiest way to tell a player their +0.6 is really -0.6.
   *
   * The fix is to replay the branch. The side-line state is `baseFen` plus every
   * move in `sans`, and chess.js knows whose turn that is — so asking the position
   * is both correct and no more work than the arithmetic it replaces. It is
   * replayed here rather than read from `exploreFen` on purpose: `exploreFen` is
   * declared BELOW this block, and a `useMemo` reading a later `const` is a
   * temporal-dead-zone trap that happens to work until someone reorders the file.
   * Counting plies works right up until the first black-to-move drill, and then it
   * is silently wrong.
   */
  const exploreTurn: 'w' | 'b' = useMemo(() => {
    if (!explore) return userSide;
    try {
      const c = new Chess(explore.baseFen);
      for (const san of explore.sans) c.move(san);
      return c.turn();
    } catch {
      // A branch we cannot replay has no meaningful turn; the drill's own side is
      // the safest answer, and it is what the non-exploring board already assumes.
      return userSide;
    }
  }, [explore, userSide]);

  const exploreUserTurn = !!explore && exploreTurn === userSide && !exploreThinking;

  /** FEN of the current side-line position, or null when not exploring. */
  const exploreFen = useMemo(() => {
    if (!explore) return null;
    try {
      const c = new Chess(explore.baseFen);
      for (const san of explore.sans) c.move(san);
      return c.fen();
    } catch { return explore.baseFen; }
  }, [explore]);

  const boardFen = exploreFen ?? fen;

/*
 * WHICH PIECE, ASKED OF THE ENGINE THE MOMENT THE FIRST PRESS WANTS IT.
 *
 * Endgames has no stored solution — it is a play-out, not a puzzle — so "which piece" cannot be read
 * from data the way it is on the puzzle tabs and in training. It has to be asked, and the engine is
 * already running here because it plays the opponent.
 *
 * ONLY THE ORIGIN SQUARE IS DRAWN. The engine's full answer is a move, and a move is the solution;
 * the module's contract is that a hint names a PIECE and never a square to move it to. Pressing again
 * dots the destinations, which is still the same two-step contract as everywhere else.
 *
 * 400ms, and only after a press. The wait is bounded and it is asked for; the alternative that was
 * here before — ring every piece that can move — answered instantly and told the player nothing.
 */
useEffect(() => {
  if (hintStage !== 1 || explore) return;
  let cancelled = false;
  // Clear the previous answer first: a ring from the last press must not be read as this one's.
  setHintPiece([]);
  void (async () => {
    let square: string | null = null;
    try {
      await engine.init();
      const uci = engine.isReady ? await engine.bestMove(boardFen, 400, lesson.engineElo) : null;
      square = uci ? uci.slice(0, 2) : null;
    } catch { /* an engine that cannot answer falls through to the legal-move set */ }
    /*
     * FALLBACK, NOT DEFAULT. Only when the engine cannot answer at all does the ring widen to the
     * capture/check set. That is what this screen did unconditionally before, and it is a poor hint —
     * but a hint button that silently does nothing is worse, and it is the other half of the same
     * report. The engine is initialised on mount and plays the opponent here, so this is the rare
     * path rather than the normal one.
     */
    if (cancelled) return;
    setHintPiece(square ? [square] : movableSquares(boardFen));
  })();
  // A position that has moved on has no outstanding question: cancel rather than let a stale ring land.
  return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [hintStage, explore, boardFen]);

/*
 * Ring the ONE piece the engine named, then dot where it can go — see `@/lib/hint`.
 *
 * Declared here rather than beside `showHint` because both read `boardFen`, which is the EXPLORING
 * position when the user is exploring. A hint during exploration would highlight the board they are
 * looking at while costing rating for a drill they are not playing, so it is suppressed there.
 */
const hintFrom = useMemo(
  () => (hintStage >= 1 && !explore ? hintPiece : []),
  [hintStage, explore, hintPiece],
);
const hintTo = useMemo(
  () => (hintStage >= 2 && !explore ? targetSquares(boardFen, hintFrom) : []),
  [hintStage, explore, boardFen, hintFrom],
);

  const startExploring = useCallback(() => {
    if (showBrief || status !== 'playing' || explore) return;
    exploreGenRef.current++;
    setHintStage(0);
    setExploreReplyMove(null);
    setExploreEval(null);
    setExplore({ baseFen: chess.fen(), baseSans: sans, sans: [] });
  }, [showBrief, status, explore, chess, sans]);

  const returnToDrill = useCallback(() => {
    exploreGenRef.current++;
    setExplore(null);
    setExploreEval(null);
    setExploreReplyMove(null);
    setExploreThinking(false);
    // `lastMove` is shared with the drill, so clear the side line's highlight
    // rather than leaving a move drawn that the drill position never had.
    setLastMove(null);
  }, []);

  const handleExploreMove = useCallback((from: string, to: string, promotion?: string): boolean => {
    if (!exploreFen || !exploreUserTurn || !explore) return false;
    const c = new Chess(exploreFen);
    let m;
    try { m = c.move({ from, to, promotion: promotion ?? 'q' }); } catch { return false; }
    if (!m) return false;
    setExploreReplyMove(null);
    playMoveSound(m);
    setExplore((prev) => (prev ? { ...prev, sans: [...prev.sans, m.san] } : prev));
    return true;
  }, [exploreFen, exploreUserTurn, explore]);

  // Engine answers the side the user is not playing, and feeds the eval bar.
  useEffect(() => {
    if (!explore || !exploreFen || showBrief) return;
    if (exploreTurn === userSide) { setExploreThinking(false); return; }
    const gen = ++exploreGenRef.current;
    let cancelled = false;
    setExploreThinking(true);
    (async () => {
      try {
        await engine.init();
        const res = await engine.analyse(exploreFen, { movetime: 450 });
        if (cancelled || gen !== exploreGenRef.current) return;
        setExploreEval(res);
        const uci = res.bestMoveUci;
        if (!uci || uci.length < 4) return;
        let applied;
        try {
          const cc = new Chess(exploreFen);
          applied = cc.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        } catch { applied = null; }
        if (!applied) return;
        if (cancelled || gen !== exploreGenRef.current) return;
        setExploreReplyMove({ from: applied.from, to: applied.to });
        setLastMove({ from: applied.from, to: applied.to });
        playMoveSound(applied);
        setExplore((prev) => (prev ? { ...prev, sans: [...prev.sans, applied!.san] } : prev));
      } catch { /* engine unavailable — the side line simply stays put */ }
      finally { if (gen === exploreGenRef.current) setExploreThinking(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [explore, exploreFen, exploreTurn, userSide, showBrief]);

  const drift = useMemo(() => {
    if (!explore) return null;
    return {
      drifting: true,
      driftPly: explore.baseSans.length,
      bookMove: null as string | null,
      playedMove: explore.sans[0] ?? null,
    };
  }, [explore]);

  const exploreCp = exploreEval && exploreEval.scoreCp !== null
    ? (exploreTurn === 'w' ? exploreEval.scoreCp : -exploreEval.scoreCp)
    : null;

  const turnLabel = engineThinking    ? (engineWarming ? 'Engine warming up — playing a safe defence…' : 'Engine thinking…')
    : userTurn
      ? 'Your move'
      : status === 'playing' ? 'Engine to move' : '';

  /*
   * The brief is now reachable ONLY when a caller explicitly asks for it.
   *
   * It used to be the gate on every course lesson — with "Start playing" and
   * "Or practise it in a real game" as the two ways out. The user removed that:
   * "just start playing directly … not giving him to choose between start
   * playing and 'or practise it in a real game'". Course lessons now pass
   * `autoStart`, so this branch is dead for them and the lesson opens on the
   * board.
   *
   * It is kept rather than deleted because `autoStart={false}` is still a
   * meaningful option for a future caller that wants a read-then-play lesson,
   * and deleting it would silently break that call shape. With `autoStart` the
   * falsy path is unreachable, which is exactly the intent.
   */
  if (showBrief) {
    return (
      <Card style={{ gap: 4 }}>
        <View style={s.briefHeader}>
          <IconBookOpen size={17} color={colors.chessforge} />
          <Text style={s.h1}>Lesson</Text>
        </View>
        <Text style={[s.body, { lineHeight: 20 }]}>{lesson.lesson}</Text>
        <Text style={[s.keyIdea, { lineHeight: 17 }]}>Key idea: {lesson.keyIdea}</Text>
        <Text style={s.bodySm}>
          You play <Text style={{ color: colors.foreground, fontWeight: '600' }}>{userSide === 'w' ? 'White' : 'Black'}</Text> ·
          engine ≈{lesson.engineElo} Elo · {GOAL_LABEL[lesson.goal]} within {lesson.maxMoves} of your moves
        </Text>
        {lesson.sourceNote ? (
          <View style={s.exampleNote}>
            <IconGlobe size={13} color={colors.chessforge} />
            <Text style={s.exampleNoteText} numberOfLines={2}>{lesson.sourceNote}</Text>
          </View>
        ) : null}
        <Btn label="Start playing" onPress={() => setShowBrief(false)} style={{ marginTop: 12 }} />
      </Card>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={s.boardRow}>
        {explore ? (
          <EvalBar cp={exploreCp ?? 0} flip={userSide === 'b'} dim={exploreThinking && !exploreEval} />
        ) : null}
        <View style={{ flex: 1 }}>
          <ChessForgeBoard
            fen={boardFen}
            orientation={userSide === 'w' ? 'white' : 'black'}
            interactive={explore ? exploreUserTurn : userTurn}
            onMove={explore ? handleExploreMove : handleMove}
            lastMove={lastMove}
            arrows={explore
              ? (exploreReplyMove ? [{ startSquare: exploreReplyMove.from, endSquare: exploreReplyMove.to, color: arrowColors.reply }] : [])
              : []}
            hintFrom={hintStage >= 1 ? hintFrom : []}
            hintTo={hintStage >= 2 ? hintTo : []}
          />
        </View>
      </View>

      <Card style={{ minHeight: 56 }}>
        <View style={s.statusRow}>
          <Text style={[s.statusText, (explore ? exploreUserTurn : userTurn) ? { color: colors.gold } : null]}>
            {explore
              ? (exploreUserTurn ? '● Exploring — your move' : '○ Engine answering your idea…')
              : turnLabel}
          </Text>
          <View style={s.statusActions}>
            {userTurn && !explore ? (
              <Pressable onPress={showHint} style={s.hintBtn} accessibilityLabel="Show hint">
                <IconLightbulb size={12} color={colors.gold} />
                {/* The label says which press comes next, because the button now reveals in
                    two steps and an unlabelled second press reads as "it did nothing". */}
                <Text style={s.hintText}>
                  {hintStage === 0 ? 'Hint' : hintStage === 1 ? 'Where?' : 'Hide'}
                </Text>
              </Pressable>
            ) : null}
            {explore ? (
              <Pressable onPress={returnToDrill} style={s.returnBtn} accessibilityLabel="Return to drill">
                <IconRotateCcw size={12} color={colors.gold} />
                <Text style={s.returnText}>Return to drill</Text>
              </Pressable>
            ) : status === 'playing' ? (
              <Pressable onPress={startExploring} style={s.hintBtn} accessibilityLabel="Explore other moves">
                <IconEye size={12} color={colors.mutedForeground} />
                <Text style={s.exploreText}>Explore</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setShowLessonText((v) => !v)} style={s.lessonToggle}>
              <IconBookOpen size={12} color={colors.mutedForeground} />
              <Text style={s.bodySm}>Lesson</Text>
              <View style={{ transform: [{ rotate: showLessonText ? '180deg' : '0deg' }] }}>
                <IconChevronDown size={11} color={colors.mutedForeground} />
              </View>
            </Pressable>
            <IconBtn onPress={reset} label="Restart position">
              <IconRotateCcw size={14} color={colors.mutedForeground} />
            </IconBtn>
          </View>
        </View>
        {explore && drift ? (
          <View style={{ marginTop: 6, gap: 5 }}>
            <DriftBadge state={drift} />
            <Text style={[s.body, { lineHeight: 17 }]} numberOfLines={3}>
              <Text style={{ color: colors.gold, fontWeight: '500' }}>Exploring: </Text>
              {explore.sans.length === 0
                ? 'try any idea — the pink arrow is the engine answering, and the bar tracks it. Your drill result and move budget are untouched.'
                : `${explore.sans.join(' ')} — the pink arrow is the engine's answer to your idea. Go as deep as you like, then return to the drill.`}
            </Text>
          </View>
        ) : null}
        {showLessonText ? (
          <Text style={[s.body, { lineHeight: 17, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 8 }]}>
            {lesson.lesson}
          </Text>
        ) : null}
        {status !== 'playing' ? (
          <View style={s.resultRow}>
            {status === 'won' ? <IconTrophy size={16} color={colors.primary} /> : <IconXCircle size={16} color={colors.bad} />}
            <Text style={[s.body, { color: colors.mutedForeground, flex: 1 }]}>{resultMsg}</Text>
          </View>
        ) : null}
      </Card>

      <Card style={{ padding: 8 }}>
        {/*
         * `startFen` IS THE POINT HERE.
         *
         * An endgame lesson begins in the middle of a game, so without it the list numbered
         * every drill from move 1 and printed Black's first move in the White column whenever
         * the lesson gave Black to move — telling the reader the wrong player made it. The
         * user asked to see the last move "like in lichess" and to be able to tell which colour
         * he is playing; that is not possible from a list whose colours may be inverted.
         */}
        <MoveList sans={sans} currentPly={sans.length} startFen={lesson.fen} />
      </Card>

      {status !== 'playing' ? (
        <View style={s.row2}>
          {onNext ? (
            <>
              <Btn label="Replay" variant="ghost" onPress={reset} style={{ flex: 1 }} />
              <Btn label={nextLabel ?? 'Next position'} onPress={onNext} style={{ flex: 1 }} />
            </>
          ) : (
            <Btn
              label={status === 'won' ? 'Play again' : 'Try again'}
              onPress={reset}
              style={{ flex: 1 }}
            />
          )}
        </View>
      ) : null}

      {footer}
    </View>
  );
}

const s = themedStyles(() => ({
  root: { gap: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Endgame rating + the change from the last attempt. Green = gained.
  ratingText: { fontFamily: fonts.sansBold, fontSize: 14, color: colors.gold },
  deltaUp: { color: colors.primary },
  deltaDown: { color: colors.bad },
  categoryTitle: {
    fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
    color: colors.mutedForeground, fontFamily: fonts.sansSemiBold, paddingHorizontal: 4,
  },

  tierChip: {
    borderRadius: 999, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, paddingHorizontal: 12, paddingVertical: 6,
  },
  tierChipActive: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.15)' },
  tierChipText: { fontSize: 11, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },

  lessonCard: {
    backgroundColor: colors.card, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  lessonIcon: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: colors.subtleFill,
    alignItems: 'center', justifyContent: 'center',
  },
  lessonTitle: { fontSize: 14, fontWeight: '500', color: colors.foreground, fontFamily: fonts.sansMedium },

  playerRoot: { flex: 1, backgroundColor: colors.background, marginTop: -8, marginHorizontal: -16 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 6, borderRadius: 999 },
  topTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },

  briefHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  // Outcome row shown when the board is playing a fetched internet position.
  exampleNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 10,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(212,175,55,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.28)',
  },
  exampleNoteText: { flex: 1, fontSize: 11, lineHeight: 15, color: colors.muted },

  /*
   * "New example" in the top bar.
   *
   * Deliberately compact and top-bar-sized: it is a refresh of the POSITION, not
   * a call to action. It replaces the old `exampleBtn`, which was a full-width
   * dashed button offering the position as an *alternative* to the lesson — the
   * exact framing the user asked to remove.
   */
  nextExBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.35)',
    backgroundColor: 'rgba(212,175,55,0.10)',
  },
  nextExText: { fontSize: 11.5, fontWeight: '600', color: colors.chessforge, fontFamily: fonts.sansSemiBold },
  keyIdea: {
    fontSize: 12, color: 'rgba(212,175,55,0.9)', fontFamily: fonts.sans,
    borderLeftWidth: 2, borderLeftColor: 'rgba(212,175,55,0.5)', paddingLeft: 12, marginTop: 8,
  },

  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  statusActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold, flex: 1 },
  lessonToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  hintBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  hintText: { fontSize: 11, color: colors.gold, fontFamily: fonts.sans },
  exploreText: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  // The way back out of explore mode has to be unmissable, so it is a filled pill.
  returnBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999,
    borderWidth: 1, borderColor: '#c9922e', backgroundColor: 'rgba(212,175,55,0.18)',
  },
  returnText: { fontSize: 11, color: '#ffcf7a', fontFamily: fonts.sansSemiBold },
  boardRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  resultRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 8 },
  row2: { flexDirection: 'row', gap: 8 },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
