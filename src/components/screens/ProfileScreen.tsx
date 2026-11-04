'use client';

/**
 * Profile screen — RN port of the web `screens/ProfileScreen.tsx`.
 * XP level, streak, module totals, ChessForge ratings, sound toggle, reset.
 * The web's `POST /api/reset` becomes `store.reset()` (local SQLite).
 *
 * Chapter progress and the old "Analyzed games" explainer were removed at the
 * owner's request: the profile is about who you are and how you are doing, not a
 * second copy of the openings screen and the Stats tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, View, Text, Pressable, StyleSheet } from 'react-native';
import { useAppStore } from '@/lib/store';
import { xpTitle } from './HomeScreen';
import { OPENINGS } from '@/lib/openings';
import { clearAllImportedData } from '@/lib/privacy';
import { isSoundOn, setSoundOn } from '@/lib/sounds';
import { Card, Btn } from '@/components/ui/Primitives';
import {
  IconArrowLeft, IconSparkles, IconFlame, IconPuzzle, IconCrown, IconBookOpen,
  IconTrophy, IconShieldAlert, IconVolumeOn,
  IconPalette, IconMoon, IconSun,
} from '@/components/ui/Icons';
import { colors, fonts, themedStyles, type ThemeName, useThemeName } from '@/theme/tokens';
import { setTheme } from '@/lib/theme';
import { loadArenaData } from '@/lib/arena/store';
import { RATING_CATEGORIES } from '@/lib/arena/ratings';
import { ratingCategoryLabel } from '@/lib/arena/timeControl';
import type { ArenaRatings, ArenaTimeCategory } from '@/lib/arena/types';

/** The two themes offered, in display order. Light first — it is the default. */
const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const TOTAL_STUDIES = OPENINGS.reduce((a, o) => a + (o.repertoire?.stats.studies ?? 0), 0);

export function ProfileScreen({ onBack }: { onBack: () => void }) {
  const store = useAppStore();
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDeleteImported, setConfirmDeleteImported] = useState(false);
  const [deletingImported, setDeletingImported] = useState(false);
  const [sound, setSound] = useState<boolean | null>(null); // null = not yet hydrated
  const [arenaRatings, setArenaRatings] = useState<ArenaRatings | null>(null);
  /**
   * The pool the user actually plays, so the hero figure is their rating rather
   * than a default. The last rated game's category is the honest answer; blitz
   * is the fallback before any rated game exists.
   */
  const [primaryCategory, setPrimaryCategory] = useState<ArenaTimeCategory>('blitz');
  // Subscribes to the palette store, so this screen (and its inline styles)
  // repaint immediately when the user picks a theme.
  const themeName = useThemeName();

  useEffect(() => {
    void loadArenaData().then((d) => {
      setArenaRatings(d.humanRatings);
      const lastHuman = [...d.history].reverse().find((h) => h.participantId === 'you');
      if (lastHuman) setPrimaryCategory(lastHuman.category);
    });
  }, []);

  const stats = useMemo(() => {
    const studiesStarted = Object.values(store.studies).filter((x) => x.attempts > 0).length;
    const mastered = Object.values(store.studies).filter((x) => x.mastery >= 0.95).length;
    const positionsTrained = Object.values(store.positions).length;
    const positionsStrong = Object.values(store.positions).filter((p) => p.mastery >= 0.8).length;
    const puzzlesSolved = Object.values(store.puzzles).filter((p) => p.solved).length;
    const endgamesDone = Object.values(store.endgames).filter((e) => e.completed).length;
    return { studiesStarted, mastered, positionsTrained, positionsStrong, puzzlesSolved, endgamesDone };
  }, [store.studies, store.positions, store.puzzles, store.endgames]);

  const xp = store.profile.xp;
  const next = xpTitle(xp);

  const resetAll = async () => {
    setConfirmReset(false);
    try {
      await store.reset();
      await store.load();
    } catch { /* ignore */ }
  };

  const deleteImported = async () => {
    if (deletingImported) return;
    setConfirmDeleteImported(false);
    setDeletingImported(true);
    try {
      await clearAllImportedData();
      Alert.alert(
        'Imported data deleted',
        'Imported games, derived openings, mined puzzles and bots were removed from this device. Training progress was kept.',
      );
    } catch {
      Alert.alert(
        'Could not delete imported data',
        'Please try again. If the problem continues, restart the app and retry.',
      );
    } finally {
      setDeletingImported(false);
    }
  };

  const soundOnNow = sound ?? isSoundOn();

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backBtn} accessibilityLabel="Back">
          <IconArrowLeft size={20} color={colors.foreground} />
        </Pressable>
        <Text style={styles.h1}>Profile</Text>
      </View>

      {/* Hero card */}
      <Card style={{ alignItems: 'center', gap: 4 }}>
        <View style={styles.heroIcon}>
          <IconSparkles size={26} color={colors.gold} />
        </View>
        <Text style={styles.h1}>{next}</Text>
        <Text style={styles.bodySm}>{xp.toLocaleString()} XP total</Text>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <IconFlame size={16} color={colors.gold} />
            <View>
              <Text style={styles.heroStatNum}>{store.profile.streakDays}</Text>
              <Text style={styles.heroStatLabel}>streak</Text>
            </View>
          </View>
          <View style={styles.heroStat}>
            <IconTrophy size={16} color={colors.gold} />
            <View>
              {/*
                * YOUR RATING, NOT THE PUZZLE RATING. The puzzle rating measures
                * one drill mode; it was the number in the profile header while
                * the rating games actually moved sat further down the page. The
                * hero figure is now the ChessForge Elo from rated games.
                */}
              <Text style={styles.heroStatNum}>{arenaRatings?.[primaryCategory] ?? 1500}</Text>
              <Text style={styles.heroStatLabel}>{ratingCategoryLabel(primaryCategory).toLowerCase()} rating</Text>
            </View>
          </View>
          <View style={styles.heroStat}>
            <IconTrophy size={16} color={colors.primary} />
            <View>
              <Text style={styles.heroStatNum}>{stats.mastered}</Text>
              <Text style={styles.heroStatLabel}>mastered lines</Text>
            </View>
          </View>
        </View>
      </Card>

      {/* ChessForge Arena ratings — deliberately separate from Lichess. */}
      <Card>
        <View style={styles.arenaHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.h2}>ChessForge ratings</Text>
            <Text style={[styles.bodySm, { marginTop: 2 }]}>
              From rated Arena and bot games · separate from your Lichess Elo
            </Text>
          </View>
          <IconTrophy size={18} color={colors.gold} />
        </View>
        <View style={styles.arenaGrid}>
          {RATING_CATEGORIES.map((category) => (
            <View key={category} style={styles.arenaBox}>
              <Text style={styles.arenaLabel}>{ratingCategoryLabel(category)}</Text>
              <Text style={styles.arenaValue}>{arenaRatings?.[category] ?? 1500}</Text>
            </View>
          ))}
        </View>
      </Card>

      {/* Module stats */}
      <View style={styles.row2}>
        <StatCard icon={<IconBookOpen size={16} color={colors.primary} />} value={`${stats.studiesStarted}/${TOTAL_STUDIES}`} label="studies started" />
        <StatCard icon={<IconSparkles size={16} color={colors.gold} />} value={`${stats.positionsStrong}/${stats.positionsTrained}`} label="positions strong" />
      </View>
      <View style={styles.row2}>
        <StatCard icon={<IconPuzzle size={16} color={colors.chessforge} />} value={`${stats.puzzlesSolved}`} label="puzzles solved" />
        <StatCard icon={<IconCrown size={16} color={colors.gold} />} value={`${stats.endgamesDone}`} label="endgames done" />
      </View>

      {/*
        * Chapter progress and the "Analyzed games" explainer were removed at the
        * owner's request: the profile is about who you are and how you are
        * doing, not a second copy of the openings screen and the Stats tab.
        */}

      {/* Appearance */}
      <Card>
        <View style={styles.sectionHeader}>
          <IconPalette size={14} color={colors.gold} />
          <Text style={styles.h2}>Appearance</Text>
        </View>
        <Text style={[styles.body, { marginBottom: 12, lineHeight: 17 }]}>
          Dark is the ChessForge default. The light theme swaps every surface, chart tone and accent across the whole app.
        </Text>
        <View style={styles.segment}>
          {THEMES.map((t) => {
            const on = themeName === t.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => void setTheme(t.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${t.label} theme`}
                style={[styles.segmentItem, on ? styles.segmentItemOn : null]}
              >
                {t.id === 'dark'
                  ? <IconMoon size={13} color={on ? colors.gold : colors.mutedForeground} />
                  : <IconSun size={13} color={on ? colors.gold : colors.mutedForeground} />}
                <Text style={[styles.segmentText, on ? { color: colors.gold } : null]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* Sound effects */}
      <Card>
        <View style={styles.sectionHeader}>
          <IconVolumeOn size={14} color={colors.gold} />
          <Text style={styles.h2}>Sound effects</Text>
        </View>
        <Text style={[styles.body, { marginBottom: 12, lineHeight: 17 }]}>
          Piece moves, captures, checks and success chimes across Course, Practice, Train, Puzzles and Endgames.
        </Text>
        <Btn
          label={soundOnNow ? 'Sound on' : 'Sound off'}
          variant="ghost"
          small
          onPress={() => {
            const v = !(sound ?? isSoundOn());
            setSound(v);
            setSoundOn(v);
          }}
        />
      </Card>

      {/* Imported data & privacy */}
      <Card>
        <View style={styles.sectionHeader}>
          <IconShieldAlert size={14} color={colors.primary} />
          <Text style={styles.h2}>Data & privacy</Text>
        </View>
        <Text style={[styles.body, { lineHeight: 17 }]}>
          ChessForge is independent and local-first. It has no ChessForge account of its own, no
          analytics, and no ChessForge server. When you enter a Lichess username, the app reads that account&apos;s
          public games directly from Lichess. Imported games, derived openings, mined puzzles and
          bots stay on this device.
        </Text>
        <Text style={[styles.bodySm, { lineHeight: 16, marginTop: 8 }]}>
          Not affiliated with, endorsed by, or sponsored by Lichess or any player. Lichess is a
          trademark of its respective owner.
        </Text>
        <Text style={[styles.bodySm, { lineHeight: 16, marginTop: 8 }]}>
          Deleting imports also removes every saved bot, including tournament (OTB) bots. XP,
          streaks, mastery and SRS schedules are kept. Use Reset progress below to delete those
          separately.
        </Text>
        {confirmDeleteImported ? (
          <View style={[styles.row2, { marginTop: 12 }]}>
            <Btn
              label="Cancel"
              variant="ghost"
              small
              onPress={() => setConfirmDeleteImported(false)}
              style={{ flex: 1 }}
            />
            <Btn
              label="Yes, delete imports"
              variant="danger"
              small
              onPress={() => void deleteImported()}
              style={{ flex: 1 }}
            />
          </View>
        ) : (
          <Btn
            label={deletingImported ? 'Stopping imports and deleting…' : 'Delete imported data'}
            variant="ghost"
            small
            disabled={deletingImported}
            onPress={() => setConfirmDeleteImported(true)}
            style={{ alignSelf: 'flex-start', marginTop: 12 }}
          />
        )}
      </Card>

      {/* Reset */}
      <Card>
        <View style={styles.sectionHeader}>
          <IconShieldAlert size={14} color="#e05252" />
          <Text style={styles.h2}>Danger zone</Text>
        </View>
        <Text style={[styles.body, { marginBottom: 12, lineHeight: 17 }]}>
          Training data is stored locally on this device (single-user app). Wiping deletes all XP, streaks, mastery and SRS schedules.
        </Text>
        {confirmReset ? (
          <View style={styles.row2}>
            <Btn label="Cancel" variant="ghost" small onPress={() => setConfirmReset(false)} style={{ flex: 1 }} />
            <Btn label="Yes, wipe everything" variant="danger" small onPress={resetAll} style={{ flex: 1 }} />
          </View>
        ) : (
          <Btn
            label="Reset progress"
            variant="ghost"
            small
            onPress={() => setConfirmReset(true)}
            style={{ alignSelf: 'flex-start', borderColor: 'rgba(224,69,69,0.4)' }}
          />
        )}
      </Card>
    </View>
  );
}

function StatCard({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <Card style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 }}>
      <View style={styles.statIcon}>{icon}</View>
      <View>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    </Card>
  );
}

const styles = themedStyles(() => ({
  root: { gap: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { padding: 6, borderRadius: 999 },
  row2: { flexDirection: 'row', gap: 12 },
  arenaHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  arenaGrid: { flexDirection: 'row', gap: 6 },
  arenaBox: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.background,
    paddingVertical: 7,
  },
  arenaLabel: { fontFamily: fonts.sans, fontSize: 8, color: colors.mutedForeground, textTransform: 'uppercase' },
  arenaValue: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground },

  heroIcon: {
    width: 64, height: 64, borderRadius: 20,
    backgroundColor: 'rgba(212,175,55,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  heroStats: { flexDirection: 'row', gap: 24, marginTop: 12 },
  heroStat: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  heroStatNum: { fontSize: 14, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans },
  heroStatLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },

  statIcon: {
    width: 36, height: 36, borderRadius: 12, backgroundColor: colors.subtleFill,
    alignItems: 'center', justifyContent: 'center',
  },
  statValue: { fontSize: 16, fontWeight: '700', color: colors.foreground, fontFamily: fonts.sans },
  statLabel: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans, marginTop: 2 },

  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },

  /* two-option theme switch */
  segment: {
    flexDirection: 'row', gap: 6, padding: 4, borderRadius: 12,
    backgroundColor: colors.subtleFill,
  },
  segmentItem: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 8, borderRadius: 9,
  },
  segmentItemOn: { backgroundColor: colors.card },
  segmentText: { fontSize: 12, fontWeight: '600', color: colors.mutedForeground, fontFamily: fonts.sansSemiBold },

  chapterRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  chapterTitle: { fontSize: 11, color: colors.mutedForeground, fontFamily: fonts.sans, flex: 1, marginRight: 8 },
  openingNameWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: 8 },
  openingTitle: { fontSize: 12, fontWeight: '600', color: colors.foreground, fontFamily: fonts.sansSemiBold, flex: 1 },
  chapterNest: {
    gap: 10, marginTop: 12, paddingLeft: 12,
    borderLeftWidth: 1, borderLeftColor: colors.border,
  },

  h1: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
}));
