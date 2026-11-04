'use client';

/**
 * Create a ChessForge Arena tournament.
 *
 * The form makes the important choices explicit: who plays, how the rounds are
 * drawn, how long a game lasts, and whether the result changes ChessForge
 * ratings. Bot snapshots are taken by the store at creation, so nothing selected
 * here can be rewritten by a later bot edit.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Btn, Card, Chip, IconBtn, Segmented } from '@/components/ui/Primitives';
import { IconChevronLeft, IconKnight, IconTrophy } from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { botDisplayName } from '@/lib/bots/display';
import { loadBot, loadBotSummaries } from '@/lib/bots/store';
import type { BotProfile, BotSummary } from '@/lib/bots/types';
import { createTournament } from '@/lib/arena/store';
import { tournamentCountBounds, tournamentField } from '@/lib/arena/field';
import {
  TIME_CONTROLS,
  customTimeControl,
  ratedAllowed,
  timeControlById,
} from '@/lib/arena/timeControl';
import type {
  ArenaFormat,
  ArenaMode,
  ArenaSettings,
  ArenaTimeControl,
  ColorPreference,
} from '@/lib/arena/types';

const FORMATS: { id: ArenaFormat; name: string; description: string }[] = [
  {
    id: 'round-robin',
    name: 'Round robin',
    description: 'Everyone plays everyone once. Byes and colours are balanced automatically.',
  },
  {
    id: 'double-round-robin',
    name: 'Double round robin',
    description: 'Everyone plays everyone twice, once with each colour.',
  },
  {
    id: 'knockout',
    name: 'Knockout',
    description: 'Single elimination. A draw is decided by the higher-rated tiebreak.',
  },
  {
    id: 'swiss',
    name: 'Swiss',
    description: 'Similar scores are paired each round. Nobody is eliminated.',
  },
  {
    id: 'arena',
    name: 'Arena',
    description: 'Repeated score-group pairings. Fast, lively, and rematches are allowed.',
  },
];

const FORMAT_NAME = Object.fromEntries(FORMATS.map((f) => [f.id, f.name])) as Record<ArenaFormat, string>;

export function CreateTournamentScreen({
  onCancel,
  onCreated,
  onManageBots,
}: {
  onCancel: () => void;
  onCreated: (id: string, autoStart: boolean) => void;
  onManageBots: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [summaries, setSummaries] = useState<BotSummary[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, BotProfile>>({});
  const [name, setName] = useState('ChessForge Championship');
  const [mode, setMode] = useState<ArenaMode>('human');
  const [format, setFormat] = useState<ArenaFormat>('round-robin');
  const [selected, setSelected] = useState<string[]>([]);
  /** How many bots actually enter. Independent of how many are selected. */
  const [playerCount, setPlayerCount] = useState(4);
  const [timeId, setTimeId] = useState('blitz-5-3');
  const [customInitial, setCustomInitial] = useState('10');
  const [customIncrement, setCustomIncrement] = useState('5');
  const [rated, setRated] = useState(true);
  const [rounds, setRounds] = useState(5);
  /** Knockout only: one game, or two legs with both colours. */
  const [knockoutLegs, setKnockoutLegs] = useState<1 | 2>(1);
  const [humanColor, setHumanColor] = useState<ColorPreference>('random');
  const [continuation, setContinuation] = useState<'immediate' | 'later'>('immediate');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    void (async () => {
      const list = await loadBotSummaries();
      if (!on) return;
      setSummaries(list);
      setSelected(list.slice(0, 4).map((b) => b.id));
      // "You vs bots" is the default and needs ONE opponent; a bot championship
      // needs at least two, and the mode switch clamps up to that.
      setPlayerCount(list.length > 0 ? 1 : 0);
      const loaded: Record<string, BotProfile> = {};
      for (const bot of list) {
        const profile = await loadBot(bot.id);
        if (profile) loaded[bot.id] = profile;
      }
      if (on) setProfiles(loaded);
    })();
    return () => {
      on = false;
    };
  }, []);

  const timeControl: ArenaTimeControl = useMemo(() => {
    if (timeId === 'custom') {
      // Initial is entered in minutes; increment is already seconds.
      return customTimeControl((Number(customInitial) || 0) * 60, Number(customIncrement) || 0);
    }
    return timeControlById(timeId);
  }, [customIncrement, customInitial, timeId]);

  const canRate = ratedAllowed(timeControl);

  useEffect(() => {
    if (!canRate) setRated(false);
  }, [canRate]);

  const toggle = useCallback((id: string) => {
    setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);

  /*
   * A bot championship needs two bots. A human event only needs one opponent,
   * because the human is the other player in the field.
   */
  const minBots = mode === 'bots' ? 2 : 1;
  const availableIds = useMemo(() => (summaries ?? []).map((b) => b.id), [summaries]);
  const bounds = tournamentCountBounds(availableIds.length, minBots);
  /*
   * THE FIELD IS THE COUNT, NOT THE SELECTION.
   *
   * `selected` is the pool; `playerCount` is how many of them enter. The helper
   * takes the picked bots first and tops up from the library when the count is
   * larger, so a four-bot event is possible with ten bots owned and three picked.
   */
  const effectiveCount = Math.max(bounds.min, Math.min(bounds.max, playerCount));
  const field = useMemo(
    () => tournamentField(selected, availableIds, effectiveCount, minBots),
    [availableIds, effectiveCount, minBots, selected],
  );
  const canCreate = field.length >= minBots && Object.keys(profiles).length > 0 && !busy;

  const create = useCallback(async () => {
    if (!canCreate) {
      Alert.alert(
        minBots === 2 ? 'Choose at least two bots' : 'Choose a bot opponent',
        minBots === 2
          ? 'A bot championship needs two bots. Create or select more in the Bots tab.'
          : 'A human tournament needs at least one bot opponent. Create or select one in the Bots tab.',
      );
      return;
    }
    const chosen = field.map((id) => profiles[id]).filter((p): p is BotProfile => !!p);
    if (chosen.length < minBots) {
      Alert.alert('Bots are still loading', 'Wait a moment and try again.');
      return;
    }
    const settings: ArenaSettings = {
      name,
      mode,
      format,
      timeControl,
      rated: rated && canRate,
      rounds,
      colourPreference: humanColor,
      continuation,
      botIds: chosen.map((b) => b.id),
      humanColor,
      knockoutLegs: format === 'knockout' ? knockoutLegs : 1,
    };
    setBusy(true);
    try {
      const { tournament } = await createTournament(settings, chosen);
      /*
       * NEVER JUMP STRAIGHT INTO A GAME.
       *
       * The owner: *"when i click create the tournament, the game start
       * automatically. the user should get to a page when he can see the pairings
       * and the standings and when he clicks on start game then the game
       * starts"*. Creating an event now always lands on the tournament sheet,
       * where the pairings, the standings and the Play button are, and the game
       * only opens on that tap.
       */
      onCreated(tournament.id, false);
    } catch (e) {
      Alert.alert('Could not create tournament', e instanceof Error ? e.message : 'Try again.');
      setBusy(false);
    }
  }, [
    canCreate,
    canRate,
    continuation,
    format,
    humanColor,
    knockoutLegs,
    minBots,
    mode,
    name,
    field,
    profiles,
    rated,
    rounds,
    timeControl,
    onCreated,
  ]);

  const formatInfo = FORMATS.find((f) => f.id === format) ?? FORMATS[0];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <IconBtn label="Back to Arena" onPress={onCancel}>
          <IconChevronLeft size={22} color={colors.foreground} />
        </IconBtn>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>New tournament</Text>
          <Text style={styles.subtitle}>ChessForge Arena</Text>
        </View>
        <View style={styles.headerGlyph}>
          <IconTrophy size={20} color={colors.gold} />
        </View>
      </View>

      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={styles.gap}>
          <Text style={styles.fieldLabel}>Tournament name</Text>
          <View style={styles.inputBox}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="ChessForge Championship"
              placeholderTextColor={colors.mutedForeground}
              style={styles.input}
              maxLength={48}
            />
          </View>
          <Text style={styles.note}>You can name it anything — it stays on this device.</Text>
        </Card>

        <Card style={styles.gap}>
          <Text style={styles.sectionLabel}>Who is playing?</Text>
          <Segmented
            options={[
              { id: 'human', label: 'You vs bots' },
              { id: 'bots', label: 'Bot championship' },
            ]}
            value={mode}
            onChange={(v: ArenaMode) => setMode(v)}
          />
          <Text style={styles.note}>
            {mode === 'bots'
              ? 'Your bots play each other. You watch, and their ChessForge ratings move.'
              : 'You are added to the field. Your games update your own ChessForge rating.'}
          </Text>
        </Card>

        <Card style={styles.gap}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionLabel}>Choose bots</Text>
            <Chip text={`${selected.length} selected`} color={selected.length >= minBots ? colors.primary : colors.gold} />
          </View>
          {summaries === null ? (
            <Text style={styles.note}>Loading your bots…</Text>
          ) : summaries.length === 0 ? (
            <View style={styles.noBots}>
              <IconKnight size={24} color={colors.gold} />
              <Text style={styles.noBotsTitle}>No bots yet</Text>
              <Text style={styles.note}>
                A human tournament needs at least one bot; a bot championship needs two. Create a personality bot or import a player first.
              </Text>
              <Btn label="Go to Bots" variant="gold" small onPress={onManageBots} />
            </View>
          ) : (
            <View style={styles.botGrid}>
              {summaries.map((bot) => {
                const on = selected.includes(bot.id);
                return (
                  <Pressable
                    key={bot.id}
                    onPress={() => toggle(bot.id)}
                    style={({ pressed }) => [
                      styles.botChip,
                      on ? styles.botChipOn : null,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <View style={styles.botChipTop}>
                      <Text style={[styles.botChipName, on ? styles.botChipNameOn : null]} numberOfLines={1}>
                        {botDisplayName(bot)}
                      </Text>
                      <View style={[styles.checkDot, on ? styles.checkDotOn : null]}>
                        {on ? <Text style={styles.checkMark}>✓</Text> : null}
                      </View>
                    </View>
                    <Text style={styles.botChipMeta}>{bot.rating} · {bot.personalityPreset ? 'personality' : 'imported'}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {summaries && summaries.length > 0 ? (
            <>
              {/*
                * HOW MANY BOTS PLAY — a separate decision from which bots are
                * in the pool. The owner asked for this explicitly: a tournament
                * is sized by the user, not by how many bots happen to be
                * selected.
                */}
              <View style={styles.countRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Bots in the tournament</Text>
                  <Text style={styles.noteSm}>
                    {field.length} of {availableIds.length} will play. Selected bots enter first;
                    the rest are filled from your library.
                  </Text>
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    accessibilityLabel="One fewer bot"
                    onPress={() => setPlayerCount(Math.max(bounds.min, effectiveCount - 1))}
                    disabled={effectiveCount <= bounds.min}
                    style={({ pressed }) => [
                      styles.stepBtn,
                      effectiveCount <= bounds.min ? styles.stepBtnOff : null,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={styles.stepGlyph}>−</Text>
                  </Pressable>
                  <Text style={styles.countValue}>{effectiveCount}</Text>
                  <Pressable
                    accessibilityLabel="One more bot"
                    onPress={() => setPlayerCount(Math.min(bounds.max, effectiveCount + 1))}
                    disabled={effectiveCount >= bounds.max}
                    style={({ pressed }) => [
                      styles.stepBtn,
                      effectiveCount >= bounds.max ? styles.stepBtnOff : null,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={styles.stepGlyph}>+</Text>
                  </Pressable>
                </View>
              </View>
              <Text style={styles.noteSm}>
                {minBots === 2 ? 'Select at least two bots.' : 'Select at least one bot opponent.'} Bot
                snapshots are frozen when the tournament is created.
              </Text>
            </>
          ) : null}
        </Card>

        <Card style={styles.gap}>
          <Text style={styles.sectionLabel}>Format</Text>
          <View style={styles.formatList}>
            {FORMATS.map((f) => {
              const on = f.id === format;
              return (
                <Pressable
                  key={f.id}
                  onPress={() => setFormat(f.id)}
                  style={({ pressed }) => [
                    styles.formatRow,
                    on ? styles.formatRowOn : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <View style={[styles.radio, on ? styles.radioOn : null]}>
                    {on ? <View style={styles.radioDot} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.formatName, on ? styles.formatNameOn : null]}>{f.name}</Text>
                    <Text style={styles.formatDescription}>{f.description}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          {(format === 'swiss' || format === 'arena') ? (
            <View style={styles.roundRow}>
              <Text style={styles.fieldLabel}>Rounds</Text>
              <Segmented
                options={[3, 5, 7, 9].map((n) => ({ id: String(n), label: String(n) }))}
                value={String(rounds)}
                onChange={(v: string) => setRounds(Number(v))}
              />
            </View>
          ) : null}
          {format === 'knockout' ? (
            <View style={styles.roundRow}>
              <Text style={styles.fieldLabel}>Match length</Text>
              <Segmented
                options={[
                  { id: '1', label: '1 game' },
                  { id: '2', label: '2 games (both colours)' },
                ]}
                value={String(knockoutLegs)}
                onChange={(v: string) => setKnockoutLegs(v === '2' ? 2 : 1)}
              />
              <Text style={styles.noteSm}>
                {knockoutLegs === 2
                  ? 'Each pairing plays once with White and once with Black. A level match goes to Armageddon: Black advances on a draw.'
                  : 'One game decides the tie. If it is drawn, an Armageddon game follows — Black advances on a draw.'}
              </Text>
            </View>
          ) : null}
          <Text style={styles.note}>{formatInfo.description}</Text>
        </Card>

        <Card style={styles.gap}>
          <Text style={styles.sectionLabel}>Time control</Text>
          <View style={styles.timeWrap}>
            {TIME_CONTROLS.map((t) => {
              const on = t.id === timeId;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setTimeId(t.id)}
                  style={({ pressed }) => [
                    styles.timeChip,
                    on ? styles.timeChipOn : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text style={[styles.timeChipText, on ? styles.timeChipTextOn : null]}>{t.label}</Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setTimeId('custom')}
              style={({ pressed }) => [
                styles.timeChip,
                timeId === 'custom' ? styles.timeChipOn : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={[styles.timeChipText, timeId === 'custom' ? styles.timeChipTextOn : null]}>
                Custom
              </Text>
            </Pressable>
          </View>

          {timeId === 'custom' ? (
            <View style={styles.customRow}>
              <View style={styles.customCol}>
                <Text style={styles.fieldLabel}>Minutes</Text>
                <View style={styles.inputBox}>
                  <TextInput
                    value={customInitial}
                    onChangeText={setCustomInitial}
                    keyboardType="number-pad"
                    style={styles.input}
                    placeholder="10"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>
              </View>
              <View style={styles.customCol}>
                <Text style={styles.fieldLabel}>Increment (s)</Text>
                <View style={styles.inputBox}>
                  <TextInput
                    value={customIncrement}
                    onChangeText={setCustomIncrement}
                    keyboardType="number-pad"
                    style={styles.input}
                    placeholder="5"
                    placeholderTextColor={colors.mutedForeground}
                  />
                </View>
              </View>
            </View>
          ) : null}

          <Text style={styles.fieldLabel}>Rated?</Text>
          <Segmented
            options={[
              { id: 'rated', label: canRate ? 'Rated' : 'Rated (untimed)' },
              { id: 'unrated', label: 'Unrated' },
            ]}
            value={rated && canRate ? 'rated' : 'unrated'}
            onChange={(v: string) => setRated(v === 'rated' && canRate)}
          />
          <Text style={styles.note}>
            {canRate
              ? `Rated games change your ChessForge ${timeControl.untimed ? 'Classical' : timeControl.category} rating. Untimed games can be rated too — Lichess is never contacted.`
              : 'Untimed games are always unrated. They are still saved and can be reviewed.'}
          </Text>
        </Card>

        <Card style={styles.gap}>
          <Text style={styles.sectionLabel}>Your side</Text>
          <Segmented
            options={[
              { id: 'random', label: 'Random' },
              { id: 'white', label: 'White' },
              { id: 'black', label: 'Black' },
            ]}
            value={humanColor}
            onChange={(v: ColorPreference) => setHumanColor(v)}
          />
          <Text style={styles.note}>Only used in “You vs bots”. Pairings keep colours balanced after round one.</Text>
          <Text style={styles.fieldLabel}>Start</Text>
          <Segmented
            options={[
              { id: 'immediate', label: 'Play now' },
              { id: 'later', label: 'Save for later' },
            ]}
            value={continuation}
            onChange={(v: 'immediate' | 'later') => setContinuation(v)}
          />
        </Card>

        <Card style={styles.summaryCard}>
          <View style={styles.summaryHead}>
            <IconTrophy size={20} color={colors.gold} />
            <Text style={styles.summaryTitle}>{name.trim() || 'ChessForge Arena'}</Text>
          </View>
          <Text style={styles.summaryLine}>
            {FORMAT_NAME[format]} · {mode === 'human' ? 'You vs bots' : 'Bot championship'}
          </Text>
          <Text style={styles.summaryLine}>
            {field.length} bots{mode === 'human' ? ' + you' : ''} · {timeControl.label} · {rated && canRate ? 'Rated' : 'Unrated'}
          </Text>
          <Btn
            label={busy ? 'Creating…' : 'Create tournament'}
            variant="gold"
            disabled={!canCreate}
            onPress={() => void create()}
            style={styles.createBtn}
          />
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = themedStyles(() => ({
  root: { flex: 1 },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontFamily: fonts.sansBold, fontSize: 18, color: colors.foreground },
  subtitle: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  headerGlyph: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.12)',
  },
  content: { padding: 12, gap: 10 },
  gap: { gap: 9 },
  fieldLabel: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.mutedForeground },
  sectionLabel: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  note: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  noteSm: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, lineHeight: 13 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2 },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: 999,
    backgroundColor: 'rgba(212,175,55,0.08)',
    paddingHorizontal: 2,
    paddingVertical: 2,
  },
  stepBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.18)',
  },
  stepBtnOff: { opacity: 0.35 },
  stepGlyph: { fontFamily: fonts.sansBold, fontSize: 16, color: colors.gold, lineHeight: 18 },
  countValue: {
    minWidth: 26,
    textAlign: 'center',
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.foreground,
  },
  inputBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
    paddingHorizontal: 10,
  },
  input: { fontFamily: fonts.sans, fontSize: 13, color: colors.foreground, paddingVertical: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  botGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  botChip: {
    width: '48%',
    gap: 3,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  botChipOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.09)' },
  botChipTop: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  botChipName: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 11, color: colors.foreground },
  botChipNameOn: { color: colors.gold },
  botChipMeta: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  checkDot: {
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDotOn: { backgroundColor: colors.gold, borderColor: colors.gold },
  checkMark: { fontFamily: fonts.sansBold, fontSize: 9, color: colors.background, lineHeight: 11 },
  noBots: { alignItems: 'center', gap: 5, paddingVertical: 8 },
  noBotsTitle: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  formatList: { gap: 5 },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  formatRowOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.07)' },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  radioOn: { borderColor: colors.gold },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.gold },
  formatName: { fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  formatNameOn: { color: colors.gold },
  formatDescription: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, lineHeight: 13, marginTop: 1 },
  roundRow: { gap: 4 },
  timeWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  timeChip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  timeChipOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.10)' },
  timeChipText: { fontFamily: fonts.sans, fontSize: 10, color: colors.foreground },
  timeChipTextOn: { color: colors.gold, fontFamily: fonts.sansMedium },
  customRow: { flexDirection: 'row', gap: 8 },
  customCol: { flex: 1, gap: 4 },
  summaryCard: { gap: 4, borderColor: 'rgba(212,175,55,0.4)', backgroundColor: 'rgba(212,175,55,0.06)' },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  summaryTitle: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  summaryLine: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  createBtn: { marginTop: 8 },
  pressed: { opacity: 0.75 },
}));
