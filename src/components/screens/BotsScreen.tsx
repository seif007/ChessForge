'use client';

/**
 * Bots — an opponent who plays like a real player.
 *
 * This screen is the workshop: a public account handle goes in, its games are
 * read (Lichess by username, or the FIDE/OTB archives by name or FIDE ID),
 * the games are folded into a profile, and the profile is kept under "Your bots"
 * so it can be played again next week without rebuilding anything.
 *
 * THE THREE THINGS ON THIS SCREEN, IN THE ORDER THEY HAPPEN:
 *
 *   1. CREATE   — source, name, how many games, which time class. The build
 *                 reports what it is doing the whole way, because the OTB scan
 *                 in particular can take minutes and a silent screen is a
 *                 broken screen as far as anyone can tell.
 *   2. REVIEW   — every bot opens its profile: the record, the four style
 *                 dials, what it does more or less often than a typical player,
 *                 and the openings it actually meets. This is what makes the
 *                 bot checkable rather than magic.
 *   3. PLAY     — hands off to the play screen with the bot's id.
 *
 * A BOT IS A FILE, NOT A SESSION. The web kept the built profile in memory and
 * threw it away on reload; here the profile is stored the moment it is built
 * and the list of bots is consulted on every mount, so "create it once, play it
 * for months" is what the screen actually promises.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Bar, Btn, Card, Chip, IconBtn, Segmented, Spinner } from '@/components/ui/Primitives';
import { IconChevronLeft, IconSearch, IconTrash } from '@/components/ui/Icons';
import { CoachAvatar } from '@/components/CoachAvatar';
import { CoachModelManager } from '@/components/CoachModelManager';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { clearJob, cancelJob, useJob } from '@/lib/background';
import { BOT_BUILD_JOB, startBotBuild, type BotBuildResult } from '@/lib/bots/buildJob';
import { COACH_BOT_ID, COACH_LEVELS, DEFAULT_COACH_ELO } from '@/lib/bots/coachBot';
import { botDisplayName } from '@/lib/bots/display';
import { OtbAmbiguityError } from '@/lib/bots/otb';
import {
  PERSONALITY_PRESETS,
  PRESET_STRENGTHS,
  createPresetProfile,
  customPersonalityFromStyle,
  normalizePersonality,
  personalityFor,
  personalityLabel,
  personalitySummary,
  presetById,
} from '@/lib/bots/personality';
import { deleteBot, loadBot, loadBotSummaries, newBotId, saveBot } from '@/lib/bots/store';
import type {
  BotProfile,
  BotSummary,
  PersonalityId,
  PersonalityWeights,
} from '@/lib/bots/types';

const GAME_COUNTS = [25, 50, 100, 200];

type Source = 'lichess' | 'otb';
/*
 * THREE CLASS ROUTES, NO BULLET.
 *
 * The owner: *"i dont want any bullet games"* and *"the user chooses between
 * rapid, blitz and classic"*. The walk in `sources.ts` enforces the ban too —
 * this list is not hiding a path, it is naming the three that exist.
 * "Classical" covers Lichess's classical and correspondence games: the slow
 * online formats, spoken of with the same word the rest of the app uses for
 * slow chess, and labelled Classical everywhere the finished bot is shown.
 */
type TimeClass = 'rapid' | 'blitz' | 'daily';
const TIME_CLASSES: { id: TimeClass; label: string }[] = [
  { id: 'rapid', label: 'Rapid' },
  { id: 'blitz', label: 'Blitz' },
  { id: 'daily', label: 'Classical' },
];
type AmbiguousPlayer = { name: string; games: number; latestDate?: string };

/** The one-line readable read of the four dials, same as the play screen's card. */
function styleSummary(p: BotProfile): string {
  const s = p.style;
  const head =
    s.aggression >= 65
      ? 'An aggressive attacker'
      : s.aggression <= 35
        ? 'A cautious positional player'
        : 'A balanced player';
  const rest: string[] = [];
  if (s.kingSafety >= 62) rest.push('castles early');
  else if (s.kingSafety <= 38) rest.push('keeps the king in the centre');
  if (s.pieceActivity >= 62) rest.push('fights for piece activity');
  if (s.endgame >= 62) rest.push('grinds out long endgames');
  else if (s.endgame <= 38) rest.push('decides games before the endgame');
  if (s.castlePly) rest.push(`usually castles by move ${Math.max(1, Math.round(s.castlePly / 2))}`);
  return `${head}${rest.length ? ` who ${rest.slice(0, 3).join(', ')}` : ''}.`;
}

/** Just the day part of a stored timestamp; the list does not need an hour. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (d?: string) => (d ? d.slice(0, 7).replaceAll('.', '-') : '');

export function BotsScreen({ onPlay }: { onPlay: (botId: string, coachElo?: number) => void }) {
  /*
   * THE SHEET LIVES INSIDE A MODAL. The app's tab bar clears the system
   * navigation strip, but a React Native Modal is its own window and does
   * not: the Play/Delete row was half-covered by the gesture bar on device.
   * The inset is added to the action row's own padding below.
   */
  const insets = useSafeAreaInsets();
  const [source, setSource] = useState<Source>('lichess');
  const [query, setQuery] = useState('');
  // 50, not 60: the options are 25/50/100/200 and the default must light one
  // of them up, or the row reads as "nothing selected".
  const [maxGames, setMaxGames] = useState(50);
  // Blitz by default: the format most accounts actually play, and the middle
  // of the three on offer. The user picks Rapid or Classical when they want it.
  const [timeClass, setTimeClass] = useState<TimeClass>('blitz');

  const [list, setList] = useState<BotSummary[] | null>(null);
  const [coachElo, setCoachElo] = useState(DEFAULT_COACH_ELO);
  const [detail, setDetail] = useState<BotProfile | null>(null);

  // Preset creation. The preset id is separate from the strength: character and
  // accuracy are independent choices, which is the whole point of the layer.
  const [presetId, setPresetId] = useState<Exclude<PersonalityId, 'custom'>>('aggressive');
  const [presetRating, setPresetRating] = useState<number>(1800);
  const [presetName, setPresetName] = useState('');

  // Personality editor for an existing bot (preset or imported).
  const [editing, setEditing] = useState<BotProfile | null>(null);
  const [editPreset, setEditPreset] = useState<PersonalityId>('custom');
  const [editWeights, setEditWeights] = useState<PersonalityWeights | null>(null);
  const [editElo, setEditElo] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  /*
   * THE BUILD IS NOT THIS COMPONENT'S CHILD.
   *
   * It lives in `lib/bots/buildJob`, so switching tabs does not cancel it and
   * coming back shows the live job (or the profile it finished while away).
   */
  const job = useJob<BotBuildResult>(BOT_BUILD_JOB);
  const busy = job?.status === 'running';
  const progress = busy ? job.progress : null;
  const error = job?.status === 'error' ? job.error : null;
  const ambiguity: AmbiguousPlayer[] | null =
    job?.status === 'error' && job.errorData instanceof OtbAmbiguityError
      ? job.errorData.options
      : null;
  const appliedJob = useRef<number | null>(null);

  useEffect(() => {
    let on = true;
    void loadBotSummaries().then((s) => {
      if (on) setList(s);
    });
    return () => {
      on = false;
    };
  }, []);

  const openProfile = useCallback(async (id: string) => {
    const p = await loadBot(id);
    if (p) setDetail(p);
    else Alert.alert('Could not open profile', 'That bot could not be loaded — it may have been removed.');
  }, []);

  /** Create a personality-only bot: no fake imported history, no fake sample count. */
  const createPreset = useCallback(async () => {
    const profile = createPresetProfile({
      id: newBotId(),
      preset: presetId,
      name: presetName,
      rating: presetRating,
    });
    const next = await saveBot(profile);
    setList(next);
    setPresetName('');
    setDetail(profile);
  }, [presetId, presetName, presetRating]);

  const beginEditPersonality = useCallback((p: BotProfile) => {
    setEditing(p);
    setEditPreset(p.personality?.preset ?? 'custom');
    setEditWeights(
      p.personality?.weights
        ? { ...p.personality.weights }
        : customPersonalityFromStyle(p.style),
    );
    // A preset must always keep an explicit playing strength: "source" would
    // otherwise mean uncapped Stockfish, not the character's stated rating.
    setEditElo(p.playElo ?? (p.source === 'preset' ? p.rating : null));
    setEditName(p.name);
  }, []);

  const chooseEditPreset = useCallback((id: PersonalityId) => {
    setEditPreset(id);
    if (id === 'custom') {
      if (editing) setEditWeights(customPersonalityFromStyle(editing.style));
      return;
    }
    const preset = presetById(id);
    if (preset) setEditWeights(normalizePersonality({ ...preset.weights }));
  }, [editing]);

  const changeWeight = useCallback((key: keyof PersonalityWeights, delta: number) => {
    setEditPreset('custom');
    setEditWeights((w) => {
      const base = w ?? { attack: 0.5, position: 0.5, defence: 0.5, gambit: 0.5, endgame: 0.5, risk: 0.5 };
      return normalizePersonality({ ...base, [key]: Math.max(0, Math.min(1, base[key] + delta)) });
    });
  }, []);

  const savePersonality = useCallback(async () => {
    if (!editing || !editWeights) return;
    const personality = personalityFor(editPreset, editing.style, editWeights);
    const presetStrength = editing.source === 'preset'
      ? editElo ?? editing.rating
      : null;
    const nextProfile: BotProfile = {
      ...editing,
      name: editName.trim() || editing.name,
      meta: { ...editing.meta, name: editName.trim() || editing.meta.name },
      personality,
      // The card's rating and the engine cap are the same number for a preset;
      // an imported bot keeps its measured rating unless the user overrides the
      // cap explicitly.
      rating: presetStrength ?? editing.rating,
      playElo: presetStrength ?? editElo ?? undefined,
    };
    const next = await saveBot(nextProfile);
    setList(next);
    setDetail(nextProfile);
    setEditing(null);
  }, [editElo, editName, editPreset, editWeights, editing]);

  /**
   * ONE BUILD, FROM NAME TO SAVED BOT.
   *
   * The work itself is in `startBotBuild`; this only snapshots the form and
   * starts it. If the user leaves Bots, the job keeps reading/analysing games,
   * saves the profile through `saveBot`, and is waiting here on return.
   */
  const run = useCallback(
    (rawQuery: string) => {
      const q = rawQuery.trim();
      if (!q || busy) return;
      // A finished job is a receipt, not a lock: clear it before a new build.
      clearJob(BOT_BUILD_JOB);
      void startBotBuild({ source, query: q, maxGames, timeClass });
    },
    [busy, maxGames, source, timeClass],
  );

  /*
   * The job may finish while this screen is unmounted. On return (and on the
   * normal mounted path) apply its saved result exactly once.
   */
  useEffect(() => {
    if (!job || job.status !== 'done' || !job.result) return;
    if (appliedJob.current === job.startedAt) return;
    appliedJob.current = job.startedAt;
    setList(job.result.list);
    setQuery('');
    setDetail(job.result.profile);
    // The saved profile/list are now screen state; consume the receipt so a
    // later remount does not pop the profile open again.
    clearJob(BOT_BUILD_JOB);
  }, [job]);

  const cancel = useCallback(() => {
    cancelJob(BOT_BUILD_JOB);
  }, []);

  const confirmDelete = useCallback(
    (s: BotSummary) => {
      Alert.alert(
        'Delete this bot?',
        `"${botDisplayName(s)}" and everything learned from its games will be removed.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                setList(await deleteBot(s.id));
                setDetail((d) => (d && d.id === s.id ? null : d));
              })();
            },
          },
        ],
      );
    },
    [],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Bots</Text>
      <Text style={styles.subtitle}>
        Build an opponent from a public account or a tournament archive — its openings, choices
        and habits — then play against it.
      </Text>

      {/* ── coach bot ─────────────────────────────────────────────────────── */}
      <Card style={styles.gap}>
        <View style={styles.coachHead}>
          <CoachAvatar size={44} />
          <View style={styles.coachHeadText}>
            <Text style={styles.coachTitle}>Coach bot</Text>
            <Text style={styles.coachMeta}>
              Play him at your level · hints and chess chat during the game
            </Text>
          </View>
        </View>

        <Text style={styles.fieldLabel}>Opponent strength</Text>
        <View style={styles.levelRow}>
          {COACH_LEVELS.map((level) => {
            const on = level.elo === coachElo;
            return (
              <Pressable
                key={level.elo}
                onPress={() => setCoachElo(level.elo)}
                accessibilityLabel={`Play the coach at ${level.elo}, ${level.label}`}
                style={({ pressed }) => [
                  styles.level,
                  on ? styles.levelOn : null,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text style={[styles.levelElo, on ? styles.levelEloOn : null]}>
                  {level.elo}
                </Text>
                <Text style={[styles.levelName, on ? styles.levelNameOn : null]}>
                  {level.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.note}>
          He plays at exactly the chosen strength. During the game, tap Hint and he explains the
          move; ask him about the position or a tactic — he only talks chess.
        </Text>
        {/*
          * The brain belongs here, before the game: a user who only ever opens
          * Bots must be able to download the model without visiting Analyse.
          * The manager persists the choice, so the same weights narrate the
          * game and the review.
          */}
        <CoachModelManager />
        <Btn
          label={`Play the coach · ${coachElo}`}
          onPress={() => onPlay(COACH_BOT_ID, coachElo)}
          style={styles.coachPlay}
        />
      </Card>

      {/* ── personality presets ───────────────────────────────────────────── */}
      <Card style={styles.gap}>
        <View style={styles.coachHead}>
          <View style={styles.presetGlyph}>
            <Text style={styles.presetGlyphText}>♜</Text>
          </View>
          <View style={styles.coachHeadText}>
            <Text style={styles.coachTitle}>Personality bots</Text>
            <Text style={styles.coachMeta}>
              Character first, strength second. These use the same move model as imported bots.
            </Text>
          </View>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
          {PERSONALITY_PRESETS.map((preset) => {
            const on = preset.id === presetId;
            return (
              <Pressable
                key={preset.id}
                onPress={() => setPresetId(preset.id)}
                accessibilityLabel={`Choose ${preset.name}`}
                style={({ pressed }) => [
                  styles.presetCard,
                  on ? styles.presetCardOn : null,
                  pressed ? styles.pressed : null,
                ]}
              >
                <Text style={[styles.presetName, on ? styles.presetNameOn : null]}>
                  {preset.name}
                </Text>
                <Text style={styles.presetTagline}>{preset.tagline}</Text>
                <Text style={styles.presetDescription} numberOfLines={2}>
                  {preset.description}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.fieldLabel}>Name (optional)</Text>
        <View style={styles.inputBox}>
          <TextInput
            value={presetName}
            onChangeText={setPresetName}
            placeholder={presetById(presetId)?.name ?? 'Personality bot'}
            placeholderTextColor={colors.mutedForeground}
            style={styles.input}
          />
        </View>

        <Text style={styles.fieldLabel}>Playing strength</Text>
        <Segmented
          options={PRESET_STRENGTHS.map((n) => ({ id: String(n), label: String(n) }))}
          value={String(presetRating)}
          onChange={(v: string) => setPresetRating(Number(v))}
        />
        <Text style={styles.noteSm}>
          Strength caps Stockfish; personality chooses among the reasonable moves. The same
          character can be 1400 or 2600.
        </Text>

        <Btn
          label={`Create ${presetById(presetId)?.short ?? 'personality'} bot`}
          variant="gold"
          onPress={() => void createPreset()}
          style={styles.coachPlay}
        />
      </Card>

      {/* ── create ─────────────────────────────────────────────────────────── */}
      <Card style={styles.gap}>
        <Segmented
          options={[
            { id: 'lichess', label: 'Lichess' },
            { id: 'otb', label: 'Tournament (OTB)' },
          ]}
          value={source}
          onChange={(v: Source) => {
            setSource(v);
            // Errors belong to the previous attempt; do not carry them across a
            // source switch. A running build is left alone (the form is busy).
            clearJob(BOT_BUILD_JOB);
          }}
        />

        <Text style={styles.fieldLabel}>
          {source === 'lichess' ? 'Lichess username' : 'Player name or FIDE ID'}
        </Text>
        <View style={styles.inputRow}>
          <View style={styles.inputBox}>
            <IconSearch size={15} color={colors.mutedForeground} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={source === 'lichess' ? 'Lichess username' : 'Player name or FIDE ID'}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              onSubmitEditing={() => void run(query)}
              returnKeyType="search"
              style={styles.input}
            />
          </View>
          <Btn
            label={busy ? 'Working…' : 'Create bot'}
            onPress={() => void run(query)}
            disabled={busy || query.trim().length === 0}
          />
        </View>

        <Text style={styles.note}>
          {source === 'lichess'
            ? "That account's recent public games come straight from the Lichess API and the profile is built on this phone."
            : 'Any FIDE-rated player: searches the notable-players archive (PGN Mentor) plus the last six months of weekly international reports (TWIC). Name or FIDE ID both work.'}
        </Text>

        <View style={styles.optionGrid}>
          <View style={styles.optionCol}>
            <Text style={styles.fieldLabel}>Games to analyse</Text>
            <Segmented
              options={GAME_COUNTS.map((n) => ({ id: String(n), label: String(n) }))}
              value={String(maxGames)}
              onChange={(v: string) => setMaxGames(Number(v))}
            />
          </View>
          {source === 'lichess' ? (
            <View style={styles.optionCol}>
              <Text style={styles.fieldLabel}>Time control</Text>
              <Segmented options={TIME_CLASSES} value={timeClass} onChange={setTimeClass} />
            </View>
          ) : null}
        </View>
        <Text style={styles.noteSm}>
          {source === 'lichess'
            ? 'More games = a richer fingerprint but a slower build. Bullet games are never used.'
            : 'More games reach further back in the archives — classical over-the-board tournament games only.'}
        </Text>

        {busy && progress ? (
          <View style={styles.progressBox}>
            <View style={styles.progressHead}>
              <Spinner size={16} />
              <Text style={styles.progressLabel} numberOfLines={2}>
                {progress.label}
              </Text>
              <Text style={styles.progressPct}>{progress.pct}%</Text>
            </View>
            <Bar pct={progress.pct / 100} style={styles.progressBar} />
            {progress.detail ? <Text style={styles.progressDetail}>{progress.detail}</Text> : null}
            <Btn label="Cancel" variant="ghost" small onPress={cancel} style={styles.cancelBtn} />
          </View>
        ) : null}

        {ambiguity ? (
          <View style={styles.amberBox}>
            <Text style={styles.amberTitle}>Multiple players match — pick one:</Text>
            {ambiguity.map((o) => (
              <Pressable
                key={o.name}
                disabled={busy}
                onPress={() => {
                  setQuery(o.name);
                  void run(o.name);
                }}
                style={({ pressed }) => [styles.amberRow, pressed && styles.pressed]}
              >
                <Text style={styles.amberRowName}>{o.name.replace(/,(\S)/, ', $1')}</Text>
                <Text style={styles.amberRowMeta}>
                  {o.games} games
                  {o.latestDate ? ` · up to ${o.latestDate.replaceAll('.', '-')}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Text style={styles.disclaimer}>
          Unofficial statistical style model, not the player. Not affiliated with, endorsed by,
          or sponsored by Lichess or any player.
        </Text>
      </Card>

      {/* ── the list ───────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Your bots</Text>
      {list === null ? (
        <View style={styles.loading}>
          <Spinner />
        </View>
      ) : list.length === 0 ? (
        <Card>
          <Text style={styles.emptyText}>
            No bots yet. Build one above — every bot keeps its own file, so it is still here
            after a restart.
          </Text>
        </Card>
      ) : (
        list.map((s) => {
          const displayName = botDisplayName(s);
          const showAvatar = s.source !== 'lichess' && s.avatar;
          const glyph = s.source === 'lichess'
            ? ((s.key || s.name).replace(/^@+/, '').charAt(0) || '♞').toUpperCase()
            : '♞';

          return (
            <Card key={s.id} style={styles.gap}>
              <View style={styles.botHead}>
                {showAvatar ? (
                  <Image source={{ uri: showAvatar }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarGlyph}>{glyph}</Text>
                  </View>
                )}
                <View style={styles.botHeadText}>
                  <Text style={styles.botName} numberOfLines={1}>
                    {s.title ? <Text style={styles.botTitle}>{s.title} </Text> : null}
                    {displayName}
                  </Text>
                  <Text style={styles.botMeta} numberOfLines={1}>
                    {s.source === 'preset'
                      ? `${s.rating} · ${s.ratingLabel} · preset`
                      : `${s.rating} · ${s.ratingLabel} · ${s.gamesAnalyzed} games · built ${dayOf(s.createdAt)}`}
                  </Text>
                  {s.personalityPreset ? (
                    <View style={styles.chipRow}>
                      <Chip text={personalityLabel(s.personalityPreset)} color={colors.gold} />
                    </View>
                  ) : null}
                </View>
              </View>

              <View style={styles.miniBars}>
                {(
                  [
                    ['Aggro', s.style.aggression],
                    ['King', s.style.kingSafety],
                    ['Activity', s.style.pieceActivity],
                    ['Endgame', s.style.endgame],
                  ] as const
                ).map(([label, v]) => (
                  <View key={label} style={styles.miniBar}>
                    <Text style={styles.miniBarLabel}>
                      {label} {v}
                    </Text>
                    <Bar pct={v / 100} height={3} color={v >= 60 ? colors.primary : v <= 40 ? colors.gold : colors.chart3} />
                  </View>
                ))}
              </View>

              <View style={styles.botActions}>
                <Btn label="Play" onPress={() => onPlay(s.id)} small style={styles.playBtn} />
                <Btn label="Profile" variant="gold" small onPress={() => void openProfile(s.id)} />
                <IconBtn label={`Delete ${displayName}`} onPress={() => confirmDelete(s)}>
                  <IconTrash size={17} color={colors.destructive} />
                </IconBtn>
              </View>
            </Card>
          );
        })
      )}

      {/* ── profile ────────────────────────────────────────────────────────── */}
      <Modal
        visible={detail !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setDetail(null)}
      >
        <View style={styles.modalBackdrop}>
          {detail ? (
            <View style={styles.modalSheet}>
              <View style={styles.modalHead}>
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {botDisplayName({ name: detail.name, source: detail.source, key: detail.meta.key })}
                </Text>
                <IconBtn label="Close profile" onPress={() => setDetail(null)}>
                  <IconChevronLeft size={20} color={colors.foreground} />
                </IconBtn>
              </View>
              <ProfileBody profile={detail} onEditPersonality={() => beginEditPersonality(detail)} />
              <View style={[styles.modalActions, { paddingBottom: insets.bottom + 16 }]}>
                <Btn
                  label="Play this bot"
                  onPress={() => {
                    setDetail(null);
                    onPlay(detail.id);
                  }}
                  style={styles.modalPlay}
                />
                <Btn
                  label="Delete"
                  variant="danger"
                  small
                  onPress={() => confirmDelete(detail)}
                />
              </View>
            </View>
          ) : null}
        </View>
      </Modal>

      {/* ── personality editor ─────────────────────────────────────────────── */}
      <Modal
        visible={editing !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        <View style={styles.modalBackdrop}>
          {editing && editWeights ? (
            <View style={styles.modalSheet}>
              <View style={styles.modalHead}>
                <Text style={styles.modalTitle} numberOfLines={1}>Bot personality</Text>
                <IconBtn label="Close personality editor" onPress={() => setEditing(null)}>
                  <IconChevronLeft size={20} color={colors.foreground} />
                </IconBtn>
              </View>
              <ScrollView contentContainerStyle={styles.editorScroll} showsVerticalScrollIndicator={false}>
                <Text style={styles.fieldLabel}>Name</Text>
                <View style={styles.inputBox}>
                  <TextInput
                    value={editName}
                    onChangeText={setEditName}
                    placeholder={editing.name}
                    placeholderTextColor={colors.mutedForeground}
                    style={styles.input}
                  />
                </View>

                <Text style={styles.fieldLabel}>Personality preset</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>
                  {PERSONALITY_PRESETS.map((preset) => {
                    const on = preset.id === editPreset;
                    return (
                      <Pressable
                        key={preset.id}
                        onPress={() => chooseEditPreset(preset.id)}
                        style={({ pressed }) => [
                          styles.editPresetChip,
                          on ? styles.editPresetChipOn : null,
                          pressed ? styles.pressed : null,
                        ]}
                      >
                        <Text style={[styles.editPresetText, on ? styles.presetNameOn : null]}>
                          {preset.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    onPress={() => chooseEditPreset('custom')}
                    style={({ pressed }) => [
                      styles.editPresetChip,
                      editPreset === 'custom' ? styles.editPresetChipOn : null,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={[styles.editPresetText, editPreset === 'custom' ? styles.presetNameOn : null]}>
                      Custom blend
                    </Text>
                  </Pressable>
                </ScrollView>
                <Text style={styles.noteSm}>
                  The preset is a starting point. Changing a dial below turns it into a custom
                  blend while keeping the imported book.
                </Text>

                <Text style={styles.fieldLabel}>Playing strength</Text>
                <Segmented
                  options={
                    editing.source === 'preset'
                      ? PRESET_STRENGTHS.map((n) => ({ id: String(n), label: String(n) }))
                      : [
                          { id: 'source', label: 'Source' },
                          ...PRESET_STRENGTHS.map((n) => ({ id: String(n), label: String(n) })),
                        ]
                  }
                  value={editElo === null ? 'source' : String(editElo)}
                  onChange={(v: string) => setEditElo(v === 'source' ? null : Number(v))}
                />
                <Text style={styles.noteSm}>
                  {editing.source === 'preset'
                    ? 'Strength caps Stockfish; the personality still chooses among reasonable moves.'
                    : 'Source keeps the imported profile uncapped. A number caps Stockfish at that level.'}
                </Text>

                <Text style={styles.blockTitle}>Style dials</Text>
                <WeightStepper
                  label="Attack"
                  value={editWeights.attack}
                  onChange={(d) => changeWeight('attack', d)}
                />
                <WeightStepper
                  label="Position"
                  value={editWeights.position}
                  onChange={(d) => changeWeight('position', d)}
                />
                <WeightStepper
                  label="Defence"
                  value={editWeights.defence}
                  onChange={(d) => changeWeight('defence', d)}
                />
                <WeightStepper
                  label="Gambit"
                  value={editWeights.gambit}
                  onChange={(d) => changeWeight('gambit', d)}
                />
                <WeightStepper
                  label="Endgame"
                  value={editWeights.endgame}
                  onChange={(d) => changeWeight('endgame', d)}
                />
                <WeightStepper
                  label="Risk"
                  value={editWeights.risk}
                  onChange={(d) => changeWeight('risk', d)}
                />
                <Text style={styles.noteSm}>
                  Style only chooses among competitive moves. The safety rail pulls it back when
                  a move falls too far below the engine's best.
                </Text>
              </ScrollView>
              <View style={[styles.modalActions, { paddingBottom: insets.bottom + 16 }]}>
                <Btn label="Save personality" onPress={() => void savePersonality()} style={styles.modalPlay} />
                <Btn label="Cancel" variant="ghost" small onPress={() => setEditing(null)} />
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

/* --------------------------------------------------------------- the editor */

function WeightStepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (delta: number) => void;
}) {
  return (
    <View style={styles.weightRow}>
      <Text style={styles.weightLabel}>{label}</Text>
      <Pressable
        accessibilityLabel={`Lower ${label}`}
        onPress={() => onChange(-0.1)}
        style={({ pressed }) => [styles.stepBtn, pressed ? styles.pressed : null]}
      >
        <Text style={styles.stepText}>−</Text>
      </Pressable>
      <View style={styles.weightTrack}>
        <View style={[styles.weightFill, { width: `${Math.round(value * 100)}%` }]} />
      </View>
      <Text style={styles.weightValue}>{Math.round(value * 100)}</Text>
      <Pressable
        accessibilityLabel={`Raise ${label}`}
        onPress={() => onChange(0.1)}
        style={({ pressed }) => [styles.stepBtn, pressed ? styles.pressed : null]}
      >
        <Text style={styles.stepText}>+</Text>
      </Pressable>
    </View>
  );
}

/* --------------------------------------------------------------- the profile */

/**
 * What a bot is made of, on one scrollable sheet.
 *
 * Every number here was measured from the player's games, and the panel is
 * arranged so that claim is checkable: the record and the dates at the top
 * (what was read), the rates and dials in the middle (what was concluded), the
 * openings and first moves at the bottom (what the bot will actually play).
 */
function ProfileBody({
  profile: p,
  onEditPersonality,
}: {
  profile: BotProfile;
  onEditPersonality?: () => void;
}) {
  const displayName = botDisplayName({ name: p.name, source: p.source, key: p.meta.key });
  const showAvatar = p.source !== 'lichess' && p.meta.avatar;
  const glyph = p.source === 'lichess'
    ? ((p.meta.key || p.name).replace(/^@+/, '').charAt(0) || '♞').toUpperCase()
    : '♞';
  const t = p.typeRates;
  const tot = t.opening.total + t.middle.total + t.end.total || 1;
  const overall = (k: 'capture' | 'check' | 'sac') =>
    (t.opening[k] * t.opening.total + t.middle[k] * t.middle.total + t.end[k] * t.end.total) / tot;
  const totalGames = p.wins + p.draws + p.losses || 1;
  const winRate = Math.round((p.wins / totalGames) * 100);
  const bookSize = Object.keys(p.book).length;
  const r = p.meta.ratings ?? {};
  const ratingBoxes =
    p.meta.source === 'preset'
      ? [{ label: 'Playing strength', value: p.playElo ?? p.rating, active: true }]
      : p.meta.source === 'lichess'
        ? [
            { label: 'Blitz', value: r.blitz, active: p.ratingLabel === 'Lichess blitz' },
            { label: 'Rapid', value: r.rapid, active: p.ratingLabel === 'Lichess rapid' },
            { label: 'Classical', value: r.daily, active: p.ratingLabel === 'Lichess classical' },
            { label: 'FIDE', value: r.fide, active: false },
          ].filter((x) => x.value)
        : [{ label: 'FIDE', value: r.fide, active: p.ratingLabel === 'FIDE standard' }].filter(
            (x) => x.value,
          );

  const traits = [
    { label: 'Captures', v: overall('capture'), base: 0.28, pct: 0 },
    { label: 'Checks', v: overall('check'), base: 0.065, pct: 1 },
    { label: 'Sacrifices', v: overall('sac'), base: 0.005, pct: 1 },
  ];
  const maxOpening = p.openings[0]?.count || 1;

  return (
    <ScrollView contentContainerStyle={styles.profileScroll} showsVerticalScrollIndicator={false}>
      <View style={styles.profileHead}>
        {showAvatar ? (
          <Image source={{ uri: showAvatar }} style={styles.profileAvatar} />
        ) : (
          <View style={[styles.profileAvatar, styles.avatarFallback]}>
            <Text style={styles.profileAvatarGlyph}>{glyph}</Text>
          </View>
        )}
        <View style={styles.botHeadText}>
          <Text style={styles.botName} numberOfLines={1}>
            {p.source !== 'lichess' && p.meta.title
              ? <Text style={styles.botTitle}>{p.meta.title} </Text>
              : null}
            {displayName}
          </Text>
          <Text style={styles.botMeta}>
            {p.rating} · {p.ratingLabel}
          </Text>
          <Text style={styles.botMeta}>
            {p.source === 'preset' ? 'Personality preset · no imported games' : `${p.gamesAnalyzed} games analysed`}
          </Text>
        </View>
      </View>

      <Text style={styles.summary}>{styleSummary(p)}</Text>

      <View style={styles.personalityBox}>
        <View style={styles.personalityHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.personalityTitle}>
              {p.personality ? personalityLabel(p.personality.preset) : 'Custom Player'}
            </Text>
            <Text style={styles.personalityMeta}>{personalitySummary(p)}</Text>
          </View>
          {onEditPersonality ? (
            <Btn label={p.personality ? 'Edit' : 'Add style'} variant="gold" small onPress={onEditPersonality} />
          ) : null}
        </View>
        {p.personality ? (
          <View style={styles.personalityBars}>
            {(
              [
                ['Attack', p.personality.weights.attack],
                ['Position', p.personality.weights.position],
                ['Defence', p.personality.weights.defence],
                ['Gambit', p.personality.weights.gambit],
                ['Endgame', p.personality.weights.endgame],
                ['Risk', p.personality.weights.risk],
              ] as const
            ).map(([label, value]) => (
              <View key={label} style={styles.miniBar}>
                <Text style={styles.miniBarLabel}>
                  {label} {Math.round(value * 100)}
                </Text>
                <Bar pct={value} height={3} color={colors.gold} />
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.chipRow}>
        <Chip
          text={
            p.meta.source === 'preset'
              ? 'Personality preset'
              : p.meta.source === 'lichess'
                ? 'Lichess'
                : p.meta.source === 'coach'
                  ? 'Coach'
                  : 'FIDE · OTB'
          }
        />
        {p.meta.fideId ? <Chip text={`FIDE ID ${p.meta.fideId}`} /> : null}
        {p.dateRange.from ? (
          <Chip
            text={`${monthOf(p.dateRange.from)} → ${monthOf(p.dateRange.to ?? p.dateRange.from)}`}
          />
        ) : null}
        {p.meta.source === 'lichess'
          ? p.timeControlMix.map((tc) => (
              <Chip key={tc.label} text={`${tc.label} ×${tc.count}`} color={colors.primary} />
            ))
          : null}
      </View>

      {ratingBoxes.length > 0 ? (
        <View style={styles.ratingRow}>
          {ratingBoxes.map((b) => (
            <View key={b.label} style={[styles.ratingBox, b.active && styles.ratingBoxActive]}>
              <Text style={styles.ratingLabel}>{b.label}</Text>
              <Text style={[styles.ratingValue, b.active && { color: colors.primary }]}>
                {b.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.blockTitle}>Record</Text>
      <View style={styles.recordHead}>
        <Text style={styles.blockMeta}>
          {p.wins}W · {p.draws}D · {p.losses}L
        </Text>
        <Text style={styles.blockMeta}>{winRate}% win rate</Text>
      </View>
      <View style={styles.recordBar}>
        <View style={[styles.recordSeg, { flex: Math.max(p.wins, 0.0001), backgroundColor: colors.primary }]} />
        <View style={[styles.recordSeg, { flex: Math.max(p.draws, 0.0001), backgroundColor: colors.chart3 }]} />
        <View style={[styles.recordSeg, { flex: Math.max(p.losses, 0.0001), backgroundColor: colors.destructive }]} />
      </View>

      <View style={styles.quickRow}>
        <View style={styles.quickBox}>
          <Text style={styles.quickValue}>{p.style.avgGameLength}</Text>
          <Text style={styles.quickLabel}>avg plies / game</Text>
        </View>
        <View style={styles.quickBox}>
          <Text style={styles.quickValue}>
            {p.style.castlePly ? Math.max(1, Math.round(p.style.castlePly / 2)) : '—'}
          </Text>
          <Text style={styles.quickLabel}>castles by move</Text>
        </View>
        <View style={styles.quickBox}>
          <Text style={styles.quickValue}>{bookSize}</Text>
          <Text style={styles.quickLabel}>book positions</Text>
        </View>
      </View>

      <Text style={styles.blockTitle}>Traits vs a typical player</Text>
      {traits.map((row) => {
        const delta = (row.v - row.base) * 100;
        const up = delta > 0.05;
        const down = delta < -0.05;
        return (
          <View key={row.label} style={styles.traitRow}>
            <Text style={styles.traitLabel}>{row.label}</Text>
            <Text style={styles.traitValue}>
              {(row.v * 100).toFixed(row.pct)}% of moves
            </Text>
            <Chip
              text={`${up ? '+' : ''}${delta.toFixed(1)} pts`}
              color={up ? colors.primary : down ? colors.bad : colors.mutedForeground}
              style={styles.traitDelta}
            />
          </View>
        );
      })}
      <Text style={styles.noteSm}>Positive = does it more often than a typical rated player.</Text>

      <Text style={styles.blockTitle}>Style profile</Text>
      {(
        [
          ['Aggression', p.style.aggression],
          ['King safety', p.style.kingSafety],
          ['Piece activity', p.style.pieceActivity],
          ['Endgame', p.style.endgame],
        ] as const
      ).map(([label, v]) => (
        <View key={label} style={styles.styleRow}>
          <View style={styles.styleHead}>
            <Text style={styles.traitLabel}>{label}</Text>
            <Text style={styles.blockMeta}>{v}</Text>
          </View>
          <Bar
            pct={v / 100}
            height={5}
            color={v >= 60 ? colors.primary : v <= 40 ? colors.gold : colors.chart3}
          />
        </View>
      ))}

      <Text style={styles.blockTitle}>Opening repertoire</Text>
      {p.openings.length === 0 ? (
        <Text style={styles.noteSm}>No opening names were recorded in this set of games.</Text>
      ) : (
        p.openings.slice(0, 14).map((o) => (
          <View key={`${o.name}-${o.asColor}`} style={styles.openingRow}>
            <View style={styles.openingHead}>
              <Text style={styles.openingName} numberOfLines={1}>
                <Text style={styles.openingSide}>{o.asColor === 'white' ? 'W' : 'B'} </Text>
                {o.name}
                {o.eco ? <Text style={styles.openingEco}> {o.eco}</Text> : null}
              </Text>
              <Text style={styles.blockMeta}>
                {o.count}× · {o.wins}W/{o.draws}D/{o.losses}L
              </Text>
            </View>
            <View style={[styles.openingTrack, { width: `${Math.max(22, (o.count / maxOpening) * 100)}%` }]}>
              <View style={[styles.recordSeg, { flex: Math.max(o.wins, 0.0001), backgroundColor: colors.primary }]} />
              <View style={[styles.recordSeg, { flex: Math.max(o.draws, 0.0001), backgroundColor: colors.chart3 }]} />
              <View style={[styles.recordSeg, { flex: Math.max(o.losses, 0.0001), backgroundColor: colors.destructive }]} />
            </View>
          </View>
        ))
      )}

      {p.firstMoves.length > 0 || p.repliesToE4.length > 0 || p.repliesToD4.length > 0 ? (
        <>
          <Text style={styles.blockTitle}>Opening book — first moves</Text>
          {p.firstMoves.length > 0 ? (
            <Text style={styles.bookLine}>
              <Text style={styles.traitLabel}>As White  </Text>
              <Text style={styles.bookMoves}>
                {p.firstMoves.map((m) => `${m.san} (${m.count})`).join(' · ')}
              </Text>
            </Text>
          ) : null}
          {p.repliesToE4.length > 0 ? (
            <Text style={styles.bookLine}>
              <Text style={styles.traitLabel}>vs 1.e4   </Text>
              <Text style={styles.bookMoves}>
                {p.repliesToE4.map((m) => `${m.san} (${m.count})`).join(' · ')}
              </Text>
            </Text>
          ) : null}
          {p.repliesToD4.length > 0 ? (
            <Text style={styles.bookLine}>
              <Text style={styles.traitLabel}>vs 1.d4   </Text>
              <Text style={styles.bookMoves}>
                {p.repliesToD4.map((m) => `${m.san} (${m.count})`).join(' · ')}
              </Text>
            </Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------- styles */

const styles = themedStyles(() => ({
  wrap: { gap: 12 },
  gap: { gap: 10 },
  title: { fontFamily: fonts.sansBold, fontSize: 22, color: colors.foreground },
  subtitle: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, lineHeight: 17 },
  sectionTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 15,
    color: colors.foreground,
    marginTop: 6,
  },
  fieldLabel: { fontFamily: fonts.sansMedium, fontSize: 11, color: colors.mutedForeground },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
    paddingHorizontal: 10,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.foreground,
    paddingVertical: 9,
  },
  note: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground, lineHeight: 15 },
  noteSm: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  disclaimer: {
    fontFamily: fonts.sans,
    fontSize: 10,
    color: colors.mutedForeground,
    lineHeight: 14,
    marginTop: 2,
  },
  optionGrid: { gap: 10 },
  optionCol: { gap: 5 },
  progressBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.background,
    padding: 10,
    gap: 8,
  },
  progressHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  progressLabel: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  progressPct: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.gold },
  progressBar: { marginTop: 2 },
  progressDetail: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  cancelBtn: { alignSelf: 'flex-start' },
  amberBox: {
    borderWidth: 1,
    borderColor: 'rgba(217,164,65,0.5)',
    backgroundColor: 'rgba(217,164,65,0.10)',
    borderRadius: radii.lg,
    padding: 10,
    gap: 6,
  },
  amberTitle: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.gold },
  amberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  amberRowName: { fontFamily: fonts.sansMedium, fontSize: 13, color: colors.foreground },
  amberRowMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  pressed: { opacity: 0.75 },
  errorBox: {
    borderWidth: 1,
    borderColor: 'rgba(224,69,69,0.55)',
    backgroundColor: 'rgba(224,69,69,0.12)',
    borderRadius: radii.lg,
    padding: 10,
  },
  errorText: { fontFamily: fonts.sans, fontSize: 12, color: colors.foreground, lineHeight: 17 },
  loading: { paddingVertical: 24, alignItems: 'center' },
  emptyText: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, lineHeight: 17 },

  coachHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coachHeadText: { flex: 1, gap: 2 },
  coachTitle: { fontFamily: fonts.sansBold, fontSize: 15, color: colors.foreground },
  coachMeta: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground, lineHeight: 15 },
  levelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  level: {
    flexGrow: 1,
    flexBasis: '22%',
    alignItems: 'center',
    gap: 1,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.subtleFill,
  },
  levelOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.14)' },
  levelElo: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  levelEloOn: { color: colors.gold },
  levelName: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  levelNameOn: { color: colors.foreground },
  coachPlay: { alignSelf: 'flex-start' },

  presetGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.4)',
  },
  presetGlyphText: { fontSize: 22, color: colors.gold },
  presetRow: { gap: 8, paddingVertical: 2, paddingRight: 4 },
  presetCard: {
    width: 170,
    gap: 3,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  presetCardOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.10)' },
  presetName: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  presetNameOn: { color: colors.gold },
  presetTagline: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.mutedForeground },
  presetDescription: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 13 },

  personalityBox: {
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.35)',
    borderRadius: radii.md,
    backgroundColor: 'rgba(212,175,55,0.06)',
    padding: 10,
    gap: 8,
  },
  personalityHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  personalityTitle: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  personalityMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  personalityBars: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  editorScroll: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
  editPresetChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  editPresetChipOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.12)' },
  editPresetText: { fontFamily: fonts.sansMedium, fontSize: 11, color: colors.foreground },
  weightRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  weightLabel: { width: 62, fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  stepBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  stepText: { fontFamily: fonts.sansSemiBold, fontSize: 16, color: colors.foreground, lineHeight: 18 },
  weightTrack: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.subtleFill ?? colors.card,
  },
  weightFill: { height: '100%', backgroundColor: colors.gold },
  weightValue: { width: 28, textAlign: 'right', fontFamily: fonts.sansMedium, fontSize: 11, color: colors.foreground },

  botHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.background },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarGlyph: { fontSize: 20, color: colors.gold },
  botHeadText: { flex: 1, gap: 2 },
  botName: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  botTitle: { color: colors.gold },
  botMeta: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  miniBars: { flexDirection: 'row', gap: 8, marginTop: 8 },
  miniBar: { flex: 1, gap: 3 },
  miniBarLabel: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  botActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  playBtn: { flex: 1 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  modalSheet: {
    maxHeight: '92%',
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  modalTitle: { flex: 1, fontFamily: fonts.sansBold, fontSize: 17, color: colors.foreground },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalPlay: { flex: 1 },

  profileScroll: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  profileHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  profileAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.card },
  profileAvatarGlyph: { fontSize: 24, color: colors.gold },
  summary: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, lineHeight: 17 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ratingRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratingBox: {
    minWidth: 68,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  ratingBoxActive: { borderColor: colors.primary, backgroundColor: 'rgba(16,150,105,0.12)' },
  ratingLabel: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  ratingValue: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  blockTitle: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 13,
    color: colors.foreground,
    marginTop: 8,
  },
  blockMeta: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  recordHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  recordBar: { flexDirection: 'row', height: 8, borderRadius: 999, overflow: 'hidden' },
  recordSeg: { height: '100%' },
  quickRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  quickBox: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    paddingVertical: 6,
  },
  quickValue: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  quickLabel: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  traitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  traitLabel: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground, width: 86 },
  traitValue: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  traitDelta: { minWidth: 68 },
  styleRow: { gap: 4, marginTop: 6 },
  styleHead: { flexDirection: 'row', justifyContent: 'space-between' },
  openingRow: { marginTop: 7, gap: 4 },
  openingHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  openingName: { flex: 1, fontFamily: fonts.sans, fontSize: 11, color: colors.foreground },
  openingSide: { fontFamily: fonts.sansBold, color: colors.gold },
  openingEco: { color: colors.mutedForeground },
  openingTrack: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: colors.subtleFill ?? colors.card,
  },
  bookLine: { flexDirection: 'row', marginTop: 4 },
  bookMoves: { flex: 1, fontFamily: fonts.mono, fontSize: 11, color: colors.foreground },
}));
