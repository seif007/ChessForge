'use client';

/**
 * Home dashboard — RN port of the web `screens/HomeScreen.tsx`.
 * Greeting, streak & XP, due-review "daily plan", module cards.
 * The web's `/api/stats` summary for the module card is read from local
 * SQLite via `loadStats()` instead.
 */

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useAppStore } from '@/lib/store';
import { OPENINGS } from '@/lib/openings';
import { loadStats } from '@/lib/stats';
import { Card, Bar, Btn } from '@/components/ui/Primitives';
import {
  IconFlame, IconSparkles, IconKnight, IconBookOpen, IconPuzzle, IconCrown, IconLineChart,
  IconChevronRight, IconPlay, IconUser, IconDumbbell, IconBarChart, IconTrophy,
} from '@/components/ui/Icons';
import { loadArenaData } from '@/lib/arena/store';
import type { ArenaTimeCategory } from '@/lib/arena/types';
import { colors, fonts, themedStyles } from '@/theme/tokens';
import type { Tab } from '@/components/AppShell';
import { buildDailyPlan } from '@/lib/dailyPlan';
import { isReferenceStudy } from '@/lib/repertoire';
import { loadCustomRepertoire } from '@/lib/lichessStore';

/**
 * EVERY SHIPPED STUDY, WITH THE OPENING AND CHAPTER IT BELONGS TO.
 *
 * The opening id is carried here rather than looked up per study. The old plan had a flat list of
 * studies and no way to ask which opening any of them belonged to — which is precisely why it could
 * not prefer an opening the user plays. The chapter title is carried for the same reason: the plan
 * says "new, in The Najdorf", and a study id cannot produce that.
 */
const ALL_STUDIES = OPENINGS.flatMap((o) =>
  (o.repertoire ? o.repertoire.chapters : []).flatMap((c) =>
    c.studies.map((s) => ({ ...s, openingId: o.id, chapter: c.title })),
  ),
);
const TOTAL_STUDIES = OPENINGS.reduce((a, o) => a + (o.repertoire?.stats.studies ?? 0), 0);

/**
 * The XP ladder on the Home card. Same six names as `LEVELS` and `RANKS`, on the same order, so a
 * player's title for their XP agrees with the tier they are training at.
 *
 * The XP thresholds are untouched; only the six labels are. They used to be chess strength titles,
 * which were themselves read off a different product's screens — see the note on `LEVELS` in
 * `repertoire.ts`. The thresholds are hard-coded here rather than read from `LEVELS` because this is
 * an XP scale and that is a per-study mastery scale; they share names, not numbers, and nothing
 * enforces the sharing.
 */
export function xpTitle(xp: number): string {
  if (xp >= 20000) return 'Crucible';
  if (xp >= 10000) return 'Forge';
  if (xp >= 5000) return 'Blaze';
  if (xp >= 2500) return 'Flame';
  if (xp >= 1000) return 'Ember';
  return 'Spark';
}

function xpForNext(xp: number): { next: number; pct: number } {
  const tiers = [1000, 2500, 5000, 10000, 20000];
  const next = tiers.find((t) => t > xp) ?? xp;
  const prev = tiers.filter((t) => t <= xp).pop() ?? 0;
  return { next, pct: next > prev ? Math.min(100, Math.round(((xp - prev) / (next - prev)) * 100)) : 100 };
}

interface Props {
  onNavigate: (t: Tab) => void;
  onPractice: (studyId: string, level: number) => void;
  onTrain: () => void;
}

export function HomeScreen({ onNavigate, onPractice, onTrain }: Props) {
  const { profile, studies, positions, puzzles, endgames } = useAppStore();

  // Aggregate stats from analyzed games (same data the Stats tab shows)
  const [summary, setSummary] = useState<{ games: number; winRate: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    loadStats()
      .then((d) => {
        if (alive && d?.overall) setSummary({ games: d.overall.games ?? 0, winRate: d.overall.winRate ?? null });
      })
      .catch(() => { /* stats optional on home */ });
    return () => { alive = false; };
  }, []);

  /*
   * THE CLOCK IS STATE, NOT A CALL IN RENDER.
   *
   * `const now = Date.now()` looks harmless and was not: it was a dependency of BOTH due-count
   * memos and of `buildDailyPlan`, so it changed identity on every render and every one of them
   * recomputed — including a full plan build over the study catalogue — on every store write, on
   * every touch of anything that sets state, on every re-render at all. The memo arrays were
   * correct and could never hit.
   *
   * A clock that only answers "is this due today" does not need millisecond resolution, so it is
   * refreshed at a minute: fine enough for a day-granularity question, coarse enough that the
   * expensive derivations run when the data changes rather than when the screen blinks.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);

  const duePositions = useMemo(
    () => Object.values(positions).filter((p) => !p.dueAt || new Date(p.dueAt).getTime() <= now).length,
    [positions, now],
  );
  const dueStudies = useMemo(
    () => Object.values(studies).filter((s) => s.dueAt && new Date(s.dueAt).getTime() <= now).length,
    [studies, now],
  );

  /*
   * `suggested` USED TO LIVE HERE, and is deleted rather than left.
   *
   * It was the old plan: the lowest-mastery study the user had started, or `allStudies[0]` if he had
   * started none. It stopped being used the moment the plan moved into `@/lib/dailyPlan`, but leaving
   * it would have been worse than dead code — it still contains `allStudies[0]`, the exact line that
   * pinned the card to `Study 1.1` on every new account, and a future reader restoring it by accident
   * would reinstate the bug with no trace of why it had been removed. Dead code that embodies a fixed
   * defect is a trap; GATE 1m asserts the line is gone.
   */

  /*
   * FOUR SCANS OF THE WHOLE STORE, MEMOISED.
   *
   * Each of these walks a map that is large in the state this app actually carries: the study
   * catalogue is 1,204 entries before the user has done anything, and the SRS position map grows
   * with every analysed game. They ran on every render — including every render caused by a store
   * write elsewhere on the screen — and each one allocated a fresh `Object.values` array to filter.
   *
   * The maps only change when the store changes, so the dependency is the map itself. This is the
   * same rule as the due counts above; they were the only three that remembered it.
   */
  const startedCount = useMemo(
    () => Object.values(studies).filter((s) => s.attempts > 0).length,
    [studies],
  );
  const masteredCount = useMemo(
    () => Object.values(studies).filter((s) => s.mastery >= 0.95).length,
    [studies],
  );
  const puzzlesSolved = useMemo(
    () => Object.values(puzzles).filter((p) => p.solved).length,
    [puzzles],
  );
  const endgamesDone = useMemo(
    () => Object.values(endgames).filter((e) => e.completed).length,
    [endgames],
  );

  /*
   * THE RATING TO SHOW, AND WHERE IT CAME FROM.
   *
   * Lichess first, the app's own puzzle rating second. The time class is chosen
   * rather than averaged, because averaging is meaningless: Lichess's blitz,
   * rapid and daily ratings routinely differ by 200+ points, and a mean of them is
   * a number that describes no game the user ever played. The preference order is
   * the order in which the user is most likely to have played, so the header
   * describes a real format rather than an average of several.
   */
  /*
   * THE HEADER NUMBER IS THE APP'S OWN RATING.
   *
   * THE REPORT: *"at home there is still a rating 800 on puzzles! it should be
   * his rating in the app, no more his puzzle rating there (but he should have
   * puzzle rating in puzzles)"*. The fallback here used to be the PUZZLE rating,
   * so a fresh install showed 800 — a number that grades one drill mode — in the
   * slot for "how good are you". It is the ChessForge Elo that rated games move,
   * in the category the user last played.
   */
  const [arenaRating, setArenaRating] = useState<{ value: number; label: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      /*
       * WHICH FORMAT IS "YOUR RATING"?
       *
       * *"i meant the elo of the app not of lichess, but according to the games he
       * plays the most in this app"*. So the pool is chosen from the games played
       * HERE: every ChessForge game (tournament boards and rated casual games) the
       * user took part in, grouped by its time-control category. The most-played
       * category names the rating; blitz is the fallback before any app game.
       */
      const d = await loadArenaData().catch(() => null);
      if (!alive || !d) return;
      const counts = new Map<ArenaTimeCategory, number>();
      const bump = (c: ArenaTimeCategory) => counts.set(c, (counts.get(c) ?? 0) + 1);
      for (const t of d.tournaments) {
        for (const g of t.games) {
          if (g.whiteId === 'you' || g.blackId === 'you') bump(t.timeControl.category);
        }
      }
      for (const h of d.history) {
        if (h.participantId === 'you') bump(h.category);
      }
      const category = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'blitz';
      setArenaRating({
        value: Math.round(d.humanRatings?.[category] ?? 1500),
        label: `${category} rating`,
      });
    })();
    return () => { alive = false; };
  }, []);

  const rating = useMemo(() => ({
    value: String(arenaRating?.value ?? 1500),
    label: arenaRating?.label ?? 'rating',
    source: 'ChessForge Arena',
  }), [arenaRating]);
  const ratingValue = rating.value;
  const ratingLabel = rating.label;
  const ratingSource = rating.source;

  /*
   * TODAY'S PLAN, BUILT BY NEED.
   *
   * The old card picked one study: the lowest-mastery study the user had started, or `allStudies[0]`
   * if he had started none. `Array.sort` is stable, so equal-mastery studies stayed in corpus order
   * and a new account was offered `Study 1.1` every day for ever. It never consulted his repertoire,
   * so the plan could not tell a Sicilian from a Reti, and "nothing due" produced the same button
   * anyway.
   *
   * The user: *"if you can make real todays plan changing everyday as how i need (not just random
   * stuff)"*. The requirement is that the plan follow from his own state, so the ranking lives in
   * `@/lib/dailyPlan` where it can be tested, and this is only its rendering.
   *
   * The repertoire is read from the custom repertoire, which is written by drilling in "Your
   * openings" - so it is the openings he actually plays rather than a guess about them. Read here and
   * not through the store on purpose: it is not SRS state, and filing a derived list in the SRS
   * export would put it among the user's own records.
   */
  const [repertoireOpenings, setRepertoireOpenings] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    loadCustomRepertoire()
      .then((custom) => {
        if (!alive) return;
        const seen: string[] = [];
        for (const line of Object.values(custom.positions ?? {})) {
          const id = (line as { openingId?: string | null }).openingId;
          if (id && !seen.includes(id)) seen.push(id);
        }
        setRepertoireOpenings(seen);
      })
      .catch(() => { /* no repertoire yet: the plan says so rather than inventing one */ });
    return () => { alive = false; };
  }, []);

  const planCatalogue = useMemo(() => {
    // Repertoire FIRST, so "new material" prefers an opening he plays. Without this the corpus
    // order alone decides, and it starts with the Sicilian for everybody whether they play it or not.
    const inRep = repertoireOpenings;
    const ordered = [
      ...ALL_STUDIES.filter((s) => inRep.includes(s.openingId)),
      ...ALL_STUDIES.filter((s) => !inRep.includes(s.openingId)),
    ];
    return ordered.map((s) => ({
      id: s.id,
      title: s.title,
      openingId: s.openingId,
      chapter: s.chapter,
      // The REAL rule, from the module that owns it. A second copy here would be free to disagree,
      // and a disagreement means the plan offers a contents page as a lesson.
      isReference: isReferenceStudy(s),
    }));
  }, [repertoireOpenings]);

  const plan = useMemo(() => buildDailyPlan({
    now,
    positions,
    studies,
    repertoire: repertoireOpenings,
    catalogue: planCatalogue,
    puzzlesAvailable: true,
  }), [now, positions, studies, repertoireOpenings, planCatalogue]);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.logoBox}>
            <IconKnight size={22} color={colors.chessforge} />
          </View>
          <View>
            {/*
             * NO XP LINE UNDER THE APP NAME.
             *
             * The user: *"in the home screen under the name of app there is beginner xp remove
             * it"*. It read `Beginner · 60 XP`.
             *
             * `xpTitle` and the whole XP ladder are NOT deleted, and that is the point worth
             * recording. The XP total is still the app's progression currency, it is still what the
             * `xpForNext` bar and the levels table are built on, and the Puzzles and Endgames
             * ratings still move it. What was wrong is the placement: a rank and a number under the
             * product's own name reads as a grade for the app rather than as progress in it, and it
             * is the first thing on the screen.
             */}
            <Text style={styles.h1}>ChessForge</Text>
          </View>
        </View>
        <Pressable onPress={() => onNavigate('profile')} style={styles.userBtn} accessibilityLabel="Profile">
          <IconUser size={22} color={colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Streak + XP progress */}
      <View style={styles.row2}>
        <Card style={styles.statCard}>
          <View style={styles.statRow}>
            <IconFlame size={18} color={colors.gold} />
            <Text style={styles.bigNum}>{profile.streakDays}</Text>
          </View>
          <Text style={styles.bodySm}>day streak</Text>
        </Card>
        <Card style={styles.statCard}>
          <View style={styles.statRow}>
            <IconTrophy size={18} color={colors.chessforge} />
            <Text style={styles.bigNum}>{ratingValue}</Text>
          </View>
          <Text style={styles.bodySm}>{ratingLabel}</Text>
          {/*
           * THE USER'S REAL STRENGTH, NOT AN XP COUNTER.
           *
           * This card read `0 XP to Novice` with a bar at 0%. The request: *"in home
           * screen, we have at the top 0 xp to novice, i want you to replace it with
           * the user's elo from Lichess else with his elo in the app puzzles"*.
           *
           * The old card was worse than useless: it was a progress bar toward a
           * rank ladder derived from XP, on the one screen a player checks to find
           * out how good they are. It said nothing about chess.
           *
           * The order is the user's own: Lichess first, because that is their real
           * rating against real opponents, and the app's puzzle rating only when no
           * account is linked — which is a real state, not a hypothetical one, and
           * inventing a Lichess number for it would be a lie.
           *
           * The source is named in the caption, because "1600" means something
           * different depending on which system produced it.
           */}
          <Text style={styles.ratingSrc} numberOfLines={1}>{ratingSource}</Text>
        </Card>
      </View>

      {/*
       * DAILY PLAN / DUE REVIEWS
       *
       * A LIST, each row naming the thing and the reason, because a single button cannot say why
       * today differs from yesterday. The user asked for a plan that changes with what he needs; a
       * plan you cannot read is not one, it is a notification.
       *
       * Rows are tappable and open the right thing, so the card is the shortest route to the work
       * rather than a summary of it.
       */}
      <Card>
        <View style={styles.planHeader}>
          <View style={styles.planTitleRow}>
            <IconDumbbell size={15} color={colors.gold} />
            <Text style={styles.h2}>Today&apos;s plan</Text>
          </View>
          <View style={styles.planBadge}>
            <Text style={styles.planBadgeText}>
              {duePositions + dueStudies > 0 ? `${duePositions + dueStudies} due` : 'clear'}
            </Text>
          </View>
        </View>

        {plan.length === 0 ? (
          <Text style={[styles.body, { lineHeight: 17 }]}>
            Nothing is due and there is nothing new waiting for you. Come back tomorrow, or drill a
            line in Your openings — a finished line adds itself to this plan.
          </Text>
        ) : (
          <View style={{ gap: 8, marginTop: 4 }}>
            {plan.map((item, i) => (
              <Pressable
                key={`${item.kind}:${item.studyId ?? item.title}`}
                onPress={() => {
                  if (item.kind === 'puzzles') { onNavigate('puzzles'); return; }
                  /*
                   * DUE POSITIONS HAVE NO STUDY ID.
                   *
                   * `review-position` is built from the position schedule and names only a count,
                   * so the old `if (item.studyId)` fall-through made the one row badged "start"
                   * the only row that did nothing. The mixed review is the session that drills
                   * learned positions, which is exactly what the row promises.
                   */
                  if (item.kind === 'review-position') { onTrain(); return; }
                  if (item.studyId) onPractice(item.studyId, item.level ?? 1);
                }}
                style={({ pressed }) => [styles.planRow, pressed ? { opacity: 0.7 } : null]}
                accessibilityLabel={`${item.title}. ${item.why}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.planRowTitle} numberOfLines={1}>{item.title}</Text>
                  {/* The reason is the whole point of this card, so it is never truncated away. */}
                  <Text style={styles.planRowWhy} numberOfLines={2}>{item.why}</Text>
                </View>
                {i === 0 ? (
                  <View style={styles.planRowBadge}>
                    <Text style={styles.planRowBadgeText}>start</Text>
                  </View>
                ) : (
                  <IconChevronRight size={14} color={colors.mutedForeground} />
                )}
              </Pressable>
            ))}
          </View>
        )}
      </Card>

      {/* Modules */}
      <View style={styles.modules}>
        <ModuleCard
          icon={<IconBookOpen size={20} color={colors.primary} />}
          title="Openings"
          desc="Opening repertoires for White and Black — train every line from Spark to Crucible"
          stat={`${startedCount}/${TOTAL_STUDIES} started · ${masteredCount} mastered`}
          onClick={() => onNavigate('openings')}
        />
        <ModuleCard
          icon={<IconPuzzle size={20} color={colors.chessforge} />}
          title="Puzzles"
          desc="Tactics from real games — mate patterns and crushing strikes"
          stat={`${puzzlesSolved} solved · rating ${profile.puzzleRating}`}
          onClick={() => onNavigate('puzzles')}
        />
        <ModuleCard
          icon={<IconCrown size={20} color={colors.gold} />}
          title="Endgames"
          desc="Fundamental checkmates and technique, played out vs the engine"
          stat={`${endgamesDone} completed`}
          onClick={() => onNavigate('endgames')}
        />
        <ModuleCard
          icon={<IconLineChart size={20} color={colors.whiteSide} />}
          title="Analyze my mistakes"
          desc="Import a game — find blunders and where you left your repertoire"
          stat="Paste PGN to begin"
          onClick={() => onNavigate('analysis')}
        />
        <ModuleCard
          icon={<IconBarChart size={20} color={colors.chart5} />}
          title="Stats"
          desc="Your results from analyzed games — win rates, accuracy, deviations"
          stat={summary && summary.games > 0
            ? `${summary.games} game${summary.games === 1 ? '' : 's'} analyzed${summary.winRate != null ? ` · ${Math.round(summary.winRate * 100)}% win rate` : ''}`
            : 'Analyze a game to build your stats'}
          onClick={() => onNavigate('stats')}
        />
      </View>
    </View>
  );
}

function ModuleCard({ icon, title, desc, stat, onClick }: {
  icon: React.ReactNode; title: string; desc: string; stat: string; onClick: () => void;
}) {
  return (
    <Pressable onPress={onClick} style={({ pressed }) => [styles.moduleCard, pressed ? { backgroundColor: colors.surfaceRaised } : null]}>
      <View style={styles.moduleIcon}>{icon}</View>
      <View style={styles.moduleText}>
        <Text style={styles.h2}>{title}</Text>
        <Text style={styles.bodySm} numberOfLines={1}>{desc}</Text>
        <Text style={[styles.bodySm, { opacity: 0.8 }]} numberOfLines={1}>{stat}</Text>
      </View>
      <IconChevronRight size={17} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = themedStyles(() => ({
  root: { gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logoBox: {
    width: 44, height: 44, borderRadius: 16,
    backgroundColor: colors.emeraldDeep,
    alignItems: 'center', justifyContent: 'center',
  },
  userBtn: { padding: 8, borderRadius: 999 },
  row2: { flexDirection: 'row', gap: 12 },
  statCard: { flex: 1, gap: 4, padding: 16 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bigNum: { fontSize: 24, fontWeight: '800', color: colors.foreground, lineHeight: 28 },

  planHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  planTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  planBadge: {
    backgroundColor: 'rgba(46,139,106,0.2)', borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 2,
    borderWidth: 1, borderColor: 'rgba(46,139,106,0.35)',
  },
  planBadgeText: { fontSize: 11, color: colors.primary, fontFamily: fonts.sans },

  /*
   * ONE ROW OF THE PLAN. Tappable, because the card's job is to be the shortest route to the work
   * rather than a summary of it - a plan you have to read and then go and find is two steps.
   */
  planRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.02)',
  },
  planRowTitle: { fontSize: 13, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold },
  planRowWhy: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans, marginTop: 2, lineHeight: 15 },
  planRowBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    backgroundColor: colors.primary,
  },
  planRowBadgeText: { fontSize: 10, fontWeight: '700', color: colors.background, fontFamily: fonts.sansSemiBold },

  modules: { gap: 12 },
  moduleCard: {
    backgroundColor: colors.card, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
  },
  moduleIcon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.subtleFill,
    alignItems: 'center', justifyContent: 'center',
  },
  moduleText: { flex: 1, gap: 2 },

  h1: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  /**
   * The provenance line under the rating.
   *
   * Small on purpose and lower-contrast than the number: it exists so a "1600" can
   * never be mistaken for a Lichess rating when it is the app's puzzle rating,
   * which is a materially different claim about the same person.
   */
  ratingSrc: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, opacity: 0.7, marginTop: 2 },
}));
