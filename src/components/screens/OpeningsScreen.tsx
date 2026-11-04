'use client';

/**
 * Openings screen — RN port of the web `screens/OpeningsScreen.tsx`.
 * Level 1: the openings hub. Level 2: a repertoire's chapter accordion with
 * study rows (mastery bars, level badges, practice buttons).
 */

import { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { OPENINGS, type OpeningEntry } from '@/lib/openings';
import type { Repertoire, RepStudy } from '@/lib/repertoire';
import { LEVELS, studyShortTitle, openingProgress, isReferenceStudy } from '@/lib/repertoire';
import { loadCustomRepertoire } from '@/lib/lichessStore';
import { RankStrip } from '@/components/ui/RankStrip';
import { useAppStore } from '@/lib/store';
import { Card, Bar, Btn } from '@/components/ui/Primitives';
import {
  IconChevronDown, IconPlay, IconStar, IconClock, IconTrophy, IconBookOpen,
  IconGraduationCap, IconDumbbell, IconLock, IconSparkles, IconKnight, IconBookMarked,
} from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

interface Props {
  onPractice: (studyId: string, level: number) => void;
  onCourse: (studyId: string) => void;
  onTrain: () => void;
  /**
   * Open "Your openings" — the builder that turns the openings the user actually
   * plays on Lichess into their own trainable repertoire. It lives as an
   * overlay rather than a tab because it is a natural extension of this screen:
   * the library is what we ship, this is what the user makes from it.
   */
  onMyOpenings: () => void;
}

function masteryColor(m: number): string {
  if (m >= 0.95) return colors.gold;
  if (m >= 0.8) return colors.primary;
  if (m >= 0.4) return colors.primary;
  return colors.border;
}

function StudyRow({ study, onPractice, onCourse }: { study: RepStudy; onPractice: Props['onPractice']; onCourse: Props['onCourse'] }) {
  const prog = useAppStore((s) => s.studies[study.id]);
  const [open, setOpen] = useState(false);
  const mastery = prog?.mastery ?? 0;
  const level = prog?.level ?? 1;
  const levelDef = LEVELS[level - 1];
  const due = prog?.dueAt ? new Date(prog.dueAt).getTime() <= Date.now() : false;
  const isDueNew = !prog?.attempts;

  /*
   * A REFERENCE INDEX IS NOT A HALF-FINISHED DRILL.
   *
   * `type: 'Reference'` studies are prose — a "Tactical Motifs Index" whose content
   * is a `commentAfter` checklist pointing at the studies that demonstrate each
   * motif. They have no opening to learn and zero lines, by design.
   *
   * Rendered as an ordinary study row, they claimed "Lv 1 · Beginner · 0 lines" and
   * showed a mastery bar pinned at zero forever, which reads as "you have not done
   * this yet" about something the user cannot do. They were also offered in Train's
   * Customize list, where selecting one silently produced no exercises.
   *
   * So the row says what it is, shows no progress bar, and offers no practice button.
   */
  const isReference = isReferenceStudy(study);

  return (
    <View style={s.studyRow}>
      <Pressable onPress={() => setOpen(!open)} style={s.studyHeader}>
        <View style={s.studyHeaderText}>
          <View style={s.studyTitleRow}>
            <Text style={s.studyTitle} numberOfLines={1}>{studyShortTitle(study.title)}</Text>
            {mastery >= 0.95 ? <IconTrophy size={13} color={colors.gold} /> : null}
          </View>
          <View style={s.studyMetaRow}>
            <View style={s.studyMetaLeft}>
              {isReference ? (
                <>
                  <IconBookMarked size={10} color="rgba(212,175,55,0.8)" />
                  <Text style={s.studyMeta}>Reference index · not a drill</Text>
                </>
              ) : (
                <>
                  <IconStar size={10} color="rgba(212,175,55,0.8)" />
                  <Text style={s.studyMeta}>Lv {level} · {levelDef.name}</Text>
                  <Text style={s.studyMeta}>· {study.lineCount} lines</Text>
                  {prog?.attempts ? <Text style={s.studyMeta}>· {prog.perfectRuns} perfect</Text> : null}
                </>
              )}
            </View>
          </View>
          {/* No mastery bar on a reference index: a bar that can never move is a
              progress indicator lying about the absence of progress. */}
          {isReference ? null : (
            <Bar pct={mastery} color={masteryColor(mastery)} height={6} style={{ marginTop: 8 }} />
          )}
        </View>
        <View style={s.studyPctCol}>
          {isReference ? null : <Text style={s.studyPct}>{Math.round(mastery * 100)}%</Text>}
          <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
            <IconChevronDown size={16} color={colors.mutedForeground} />
          </View>
        </View>
      </Pressable>

      {open ? (
        <View style={s.studyBody}>
          {study.intro ? (
            <Text style={[s.studyIntro, { borderLeftColor: 'rgba(232,143,162,0.4)' }]} numberOfLines={4}>
              {study.intro}
            </Text>
          ) : null}
          <View style={s.studyChips}>
            <View style={s.chip}><Text style={s.chipText}>{study.type}</Text></View>
            {isReference ? (
              <View style={s.chip}><Text style={s.chipText}>reading, not drilling</Text></View>
            ) : (
              <>
                <View style={s.chip}><Text style={s.chipText}>{study.mainPlies} plies mainline</Text></View>
                {due && !isDueNew ? (
                  <View style={[s.chip, { borderColor: 'rgba(212,175,55,0.35)', backgroundColor: 'rgba(212,175,55,0.15)' }]}>
                    <IconClock size={10} color={colors.gold} />
                    <Text style={[s.chipText, { color: colors.gold }]}>review due</Text>
                  </View>
                ) : null}
                {isDueNew ? (
                  <View style={[s.chip, { borderColor: 'rgba(46,139,106,0.35)', backgroundColor: 'rgba(46,139,106,0.15)' }]}>
                    <Text style={[s.chipText, { color: colors.primary }]}>new</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>
          {/*
           * NO PRACTICE BUTTON ON A REFERENCE INDEX. A "Practice" button that starts a
           * drill with no lines to drill is the same dead control the Train picker
           * had, and the user has already reported that shape twice.
           */}
          {isReference ? null : (
            <>
              <View style={s.studyBtns}>
                <Btn label="Course" variant="ghost" small onPress={() => onCourse(study.id)} style={{ flex: 1 }} />
                <Btn label="Practice" small onPress={() => onPractice(study.id, level)} style={{ flex: 1 }} />
              </View>
              <Text style={s.studyNote}>
                Course walks you through the moves with arrows and coach notes; Practice drills them until they are automatic.
              </Text>
            </>
          )}
          {isReference && study.tree[0]?.commentAfter ? (
            <Text style={[s.studyIntro, { borderLeftColor: 'rgba(232,143,162,0.4)' }]}>
              {study.tree[0].commentAfter}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Level 2: the selected opening's full repertoire (chapters + studies). */
function RepertoireView({ entry, onBack, onPractice, onCourse, onTrain }: {
  entry: OpeningEntry;
  onBack: () => void;
  onPractice: Props['onPractice'];
  onCourse: Props['onCourse'];
  onTrain: () => void;
}) {
  const rep = entry.repertoire as Repertoire;
  const studiesMap = useAppStore((st) => st.studies);
  const started = useMemo(() => Object.values(studiesMap).filter((x) => x.attempts > 0).length, [studiesMap]);
  const mastered = useMemo(() => Object.values(studiesMap).filter((x) => x.mastery >= 0.95).length, [studiesMap]);
  /*
   * NO CHAPTER IS OPEN UNTIL THE USER OPENS ONE.
   *
   * The request: *"i dont want the first chapter to be open by default while i
   * didnt click on it yet"*.
   *
   * `-1` is the same sentinel the toggle already uses to close a chapter
   * (`setOpenChapter(isOpen ? -1 : ch.order)`), so there is one "nothing is open"
   * value rather than a special case for the first render. Starting at `0` also
   * made the opening screen do the most expensive thing it could do on arrival:
   * render every study in chapter 1, which is up to 20 rows of bars and metadata,
   * before the user had expressed any interest in them.
   */
  const [openChapter, setOpenChapter] = useState<number>(-1);
  // `rank` is the same derived value on the card and in this header, so the two
  // can never disagree — they are one function of the same store slice.
  /*
   * PRACTICE FROM "YOUR OPENINGS" COUNTS TOWARDS THIS OPENING'S RANK.
   *
   * The rank used to be derived only from the SRS record for the SHIPPED studies, so
   * it could not move for a user whose practice happens in "Your openings" — which is
   * what that screen is for. The card was honestly reporting effort the user had not
   * made, and the user read it as the app not counting them.
   *
   * `loadCustomRepertoire()` is a kv-store read, not a network call, once per opening
   * screen. The counts are DISTINCT recorded positions per opening id, joined on the
   * ID rather than the display name: a name join fails silently, and a silent failure
   * looks exactly like "the rank is broken".
   */
  const [ownByOpening, setOwnByOpening] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    loadCustomRepertoire()
      .then((custom) => {
        if (!alive) return;
        const counts: Record<string, number> = {};
        for (const line of Object.values(custom.positions)) {
          if (!line?.openingId) continue;
          counts[line.openingId] = (counts[line.openingId] ?? 0) + 1;
        }
        setOwnByOpening(counts);
      })
      .catch(() => { /* no custom repertoire yet: the rank is the shipped one */ });
    return () => { alive = false; };
  }, []);

  const rank = useMemo(
    () => openingProgress(
      rep,
      studiesMap,
      useAppStore.getState().positions,
      entry.side === 'white' ? 'w' : 'b',
      ownByOpening,
      entry.id,
    ),
    [rep, studiesMap, entry.side, ownByOpening, entry.id],
  );

  return (
    <View style={s.root}>
      <Pressable onPress={onBack} style={s.backBtn}>
        <Text style={s.backText}>‹ All openings</Text>
      </Pressable>
      <View style={s.repHeaderRow}>
        <IconBookOpen size={20} color={colors.gold} />
        <Text style={s.h1}>{entry.name}</Text>
      </View>
      <Text style={[s.body, { lineHeight: 17 }]}>
        You play <Text style={{ color: colors.foreground }}>{entry.side === 'black' ? 'Black' : 'White'}</Text> against a simulated opponent. Repeat lines until they are automatic — zero mistakes raises mastery, mastery unlocks the next level.
      </Text>
      <View style={s.repStatsRow}>
        <View style={s.repStats}>
          <Text style={s.repStat}><Text style={s.repStatNum}>{started}</Text>/{rep.stats.studies} started</Text>
          <Text style={s.repStat}><Text style={{ color: colors.gold, fontWeight: '700' }}>{mastered}</Text> mastered</Text>
          <Text style={s.repStat}><Text style={{ color: colors.chessforge, fontWeight: '700' }}>{rep.stats.lines}</Text> lines</Text>
        </View>
        <Btn label="Train" variant="gold" small onPress={onTrain} />
      </View>
      {/*
       * THE USER'S RANK IN THIS OPENING — "from novice to pro like in chessforge chess".
       *
       * A count of started studies tells you how much you have touched; it does not
       * tell you how well you know it, and it is not comparable between openings.
       * The rank is the highest LEVEL reached, beside the next one to aim for, so
       * the number on the card is a claim about skill and not about attention span.
       */}
      <RankStrip
        label={rank.label}
        next={rank.nextLabel}
        pct={rank.pct}
        started={rank.started}
        mastered={rank.mastered}
        total={rank.total}
        ownPractised={rank.ownPractised}
      />
      <Text style={[s.bodySm, { opacity: 0.7, lineHeight: 15 }]}>
        Train mixes random positions from every study you already practiced — from the beginning, middle, or end of each line — and repeats them until all are solved.
      </Text>

      {rep.chapters.map((ch) => {
        const isOpen = openChapter === ch.order;
        const chMastered = ch.studies.filter((x) => (studiesMap[x.id]?.mastery ?? 0) >= 0.95).length;
        return (
          <Card key={ch.title} style={{ padding: 0, overflow: 'hidden' }}>
            <Pressable onPress={() => setOpenChapter(isOpen ? -1 : ch.order)} style={s.chapterHeader}>
              <View>
                <Text style={s.h2}>{ch.title}</Text>
                <Text style={s.bodySm}>{ch.studies.length} studies · {chMastered} mastered</Text>
              </View>
              <View style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}>
                <IconChevronDown size={17} color={colors.mutedForeground} />
              </View>
            </Pressable>
            {isOpen ? (
              <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
                {ch.studies.map((st) => (
                  <StudyRow key={st.id} study={st} onPractice={onPractice} onCourse={onCourse} />
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

/** Level 1: the openings hub. */
export function OpeningsScreen({ onPractice, onCourse, onTrain, onMyOpenings }: Props) {
  const studiesMap = useAppStore((st) => st.studies);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /*
   * PER-OPENING PROGRESS, IN ONE MEMOISED PASS.
   *
   * This used to be computed inside the `OPENINGS.map` below:
   *
   *     const started  = rep.chapters.flatMap((c) => c.studies).filter(...).length;
   *     const mastered = rep.chapters.flatMap((c) => c.studies).filter(...).length;
   *
   * Two `flatMap`s and two `filter`s per card, on every render, with no memo. Each
   * `flatMap` allocates a fresh array of every study in the opening just to count them, so
   * the hub did 2 x (number of openings) full walks of the library each time it painted.
   *
   * That was survivable at twenty openings and painful at thirty-one. The user added
   * eleven, the library went to roughly nine hundred studies, and the screen they had
   * already complained about being slow got slower in proportion. The cost is linear in
   * openings, which is why adding openings made it worse rather than merely keeping it.
   *
   * One pass over `OPENINGS` counts every opening's started and mastered studies, and the
   * result is memoised on the store slice that can change it. Same numbers, one walk.
   */
  const progressByOpening = useMemo(() => {
    const out: Record<string, { started: number; mastered: number }> = {};
    for (const o of OPENINGS) {
      const rep = o.repertoire;
      if (!rep) continue;
      let started = 0, mastered = 0;
      for (const c of rep.chapters) {
        for (const st of c.studies) {
          const s = studiesMap[st.id];
          if (!s) continue;
          if ((s.attempts ?? 0) > 0) started++;
          if ((s.mastery ?? 0) >= 0.95) mastered++;
        }
      }
      out[o.id] = { started, mastered };
    }
    return out;
  }, [studiesMap]);

  const selected = OPENINGS.find((o) => o.id === selectedId) ?? null;

  if (selected && selected.available && selected.repertoire) {
    return (
      <RepertoireView
        entry={selected}
        onBack={() => setSelectedId(null)}
        onPractice={onPractice}
        onCourse={onCourse}
        onTrain={onTrain}
      />
    );
  }

  return (
    <View style={s.root}>
      <View style={s.repHeaderRow}>
        <IconBookOpen size={20} color={colors.gold} />
        <Text style={s.h1}>Openings</Text>
      </View>
      <Text style={[s.body, { lineHeight: 17 }]}>
        Your repertoire library. Pick an opening to study its chapters, or hit Train for a mixed review of everything you have already learned.
      </Text>
      <Btn
        label="Train — mixed review of all learned openings"
        variant="gold"
        small
        onPress={onTrain}
      />

      {/* The bridge between our library and the user's own games. Placed here,
          above the list, because it is the one thing on this screen that is about
          the user rather than about us. */}
      <Pressable
        onPress={onMyOpenings}
        style={({ pressed }) => [s.myOpeningsCard, pressed ? { backgroundColor: colors.subtleFill } : null]}
      >
        <View style={s.myOpeningsIcon}>
          <IconKnight size={18} color={colors.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.h2}>Your openings</Text>
          <Text style={[s.bodySm, { lineHeight: 15 }]}>
            Build a repertoire from positions you actually reached in your games.
          </Text>
        </View>
        <View style={{ transform: [{ rotate: '-90deg' }] }}>
          <IconChevronDown size={18} color={colors.mutedForeground} />
        </View>
      </Pressable>
      <View style={{ gap: 12 }}>
        {OPENINGS.map((o) => {
          const rep = o.repertoire;
          const stats = progressByOpening[o.id];
          const started = stats?.started ?? 0;
          const mastered = stats?.mastered ?? 0;
          const total = rep?.stats.studies ?? 0;

          if (o.available && rep) {
            return (
              <Pressable key={o.id} onPress={() => setSelectedId(o.id)} style={({ pressed }) => [s.hubCard, pressed ? { backgroundColor: colors.subtleFill } : null]}>
                <View style={{ flex: 1 }}>
                  <View style={s.hubTitleRow}>
                    <Text style={s.hubTitle}>{o.name}</Text>
                    <View style={s.chip}>
                      <Text style={s.chipText}>{o.side === 'black' ? 'for Black' : 'for White'}</Text>
                    </View>
                  </View>
                  <Text style={[s.bodySm, { lineHeight: 15 }]}>{o.tagline}</Text>
                  <View style={s.hubStats}>
                    <Text style={s.studyMeta}><Text style={{ color: colors.foreground, fontWeight: '700' }}>{started}</Text>/{total} started</Text>
                    <Text style={s.studyMeta}><Text style={{ color: colors.gold, fontWeight: '700' }}>{mastered}</Text> mastered</Text>
                  </View>
                  <Bar pct={total ? started / total : 0} color={colors.primary} height={6} style={{ marginTop: 8, maxWidth: 220 }} />
                </View>
                <View style={{ transform: [{ rotate: '-90deg' }] }}>
                  <IconChevronDown size={18} color={colors.mutedForeground} />
                </View>
              </Pressable>
            );
          }

          return (
            <View key={o.id} style={[s.hubCard, { opacity: 0.55 }]}>
              <View style={{ flex: 1 }}>
                <View style={s.hubTitleRow}>
                  <Text style={s.hubTitle}>{o.name}</Text>
                  <View style={s.chip}>
                    <Text style={s.chipText}>{o.side === 'black' ? 'for Black' : 'for White'}</Text>
                  </View>
                </View>
                <Text style={[s.bodySm, { lineHeight: 15 }]}>{o.tagline}</Text>
              </View>
              <View style={[s.chip, { gap: 4, paddingHorizontal: 8, paddingVertical: 4 }]}>
                <IconLock size={10} color={colors.mutedForeground} />
                <Text style={s.chipText}>Coming soon</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const s = themedStyles(() => ({
  root: { gap: 16 },
  backBtn: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 4, borderRadius: 8 },
  backText: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  repHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  repStatsRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  repStats: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  repStat: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  repStatNum: { color: colors.foreground, fontWeight: '700' },

  hubCard: {
    backgroundColor: colors.card, borderRadius: radii.lg, borderWidth: 1,
    borderColor: colors.border, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  hubTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  hubTitle: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans },
  hubStats: { flexDirection: 'row', gap: 12, marginTop: 8 },

  chapterHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
  },

  studyRow: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.muted, overflow: 'hidden',
  },
  studyHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  studyHeaderText: { flex: 1 },
  studyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  studyTitle: { fontSize: 14, fontWeight: '500', color: colors.foreground, fontFamily: fonts.sansMedium, flex: 1 },
  studyMetaRow: { flexDirection: 'row', marginTop: 4, gap: 6 },
  studyMetaLeft: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  studyMeta: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  studyPctCol: { alignItems: 'flex-end', gap: 4 },
  studyPct: { fontSize: 12, fontWeight: '600', color: colors.gold, fontFamily: fonts.sansSemiBold },
  studyBody: { paddingHorizontal: 14, paddingBottom: 14, gap: 12 },
  studyIntro: {
    fontSize: 12, color: colors.mutedForeground, fontFamily: fonts.sans,
    lineHeight: 17, borderLeftWidth: 2, paddingLeft: 12,
  },
  studyChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: colors.subtleFill, borderWidth: 1, borderColor: colors.border,
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2,
  },
  chipText: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans },
  studyBtns: { flexDirection: 'row', gap: 8 },
  studyNote: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans, lineHeight: 14 },

  // 'Your openings' entry card.
  myOpeningsCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)',
    backgroundColor: 'rgba(212,175,55,0.07)', padding: 12,
  },
  myOpeningsIcon: {
    width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.16)',
  },

  h1: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
