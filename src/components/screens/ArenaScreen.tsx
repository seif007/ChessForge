'use client';

/**
 * ChessForge Arena — the tournament lobby.
 *
 * The ratings card is the first thing on the screen on purpose: these are
 * ChessForge ratings, not Lichess ratings, and the separation is a product
 * promise rather than a footnote. Tournaments are local files; every card opens
 * the same persisted object the games write into.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Btn, Card, Chip, IconBtn, Spinner } from '@/components/ui/Primitives';
import { IconChevronRight, IconCrown, IconTrash, IconTrophy } from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { computeStandings, nextPendingGame } from '@/lib/arena/pairing';
import { deleteTournament, loadArenaData } from '@/lib/arena/store';
import { RATING_CATEGORIES } from '@/lib/arena/ratings';
import { ratingCategoryLabel } from '@/lib/arena/timeControl';
import type { ArenaData, ArenaFormat, ArenaMode, ArenaTournament } from '@/lib/arena/types';

const FORMAT_LABEL: Record<ArenaFormat, string> = {
  'round-robin': 'Round robin',
  'double-round-robin': 'Double round robin',
  knockout: 'Knockout',
  swiss: 'Swiss',
  arena: 'Arena',
};

const MODE_LABEL: Record<ArenaMode, string> = {
  human: 'You vs bots',
  bots: 'Bot championship',
};

function nameOf(t: ArenaTournament, id: string | null): string {
  if (!id) return 'Bye';
  return t.participants.find((p) => p.id === id)?.name ?? 'Player';
}

function TournamentCard({
  tournament,
  onOpen,
  onDelete,
}: {
  tournament: ArenaTournament;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const standings = computeStandings(tournament);
  const champion = tournament.championId
    ? tournament.participants.find((p) => p.id === tournament.championId)
    : standings[0]?.participant;
  const next = nextPendingGame(tournament);
  const done = tournament.status === 'completed';
  const draft = tournament.status === 'draft';
  const played = tournament.games.filter((g) => g.status === 'done').length;
  const total = tournament.games.length;
  const medalStandings = tournament.format === 'knockout' && champion
    ? [
        ...standings.filter((s) => s.participant.id === champion.id),
        ...standings.filter((s) => s.participant.id !== champion.id),
      ]
    : standings;

  return (
    <Card style={styles.gap}>
      <Pressable onPress={onOpen} style={({ pressed }) => [styles.cardPress, pressed ? styles.pressed : null]}>
        <View style={styles.cardHead}>
          <View style={styles.cardHeadText}>
            <Text style={styles.cardTitle} numberOfLines={1}>{tournament.name}</Text>
            <Text style={styles.cardMeta}>
              {FORMAT_LABEL[tournament.format]} · {MODE_LABEL[tournament.mode]} · {tournament.participants.length} players
            </Text>
          </View>
          <Chip
            text={done ? 'Completed' : draft ? 'Draft' : 'Live'}
            color={done ? colors.gold : draft ? colors.mutedForeground : colors.primary}
            bg={done ? 'rgba(212,175,55,0.12)' : draft ? colors.subtleFill : 'rgba(46,139,106,0.14)'}
            border={done ? 'rgba(212,175,55,0.4)' : draft ? colors.border : 'rgba(46,139,106,0.4)'}
          />
        </View>

        <View style={styles.chipRow}>
          <Chip text={tournament.timeControl.label} />
          <Chip text={tournament.rated ? 'Rated' : 'Unrated'} color={tournament.rated ? colors.primary : colors.mutedForeground} />
          <Chip text={draft ? 'Setup saved' : `${played}/${total} games`} />
        </View>

        {draft ? (
          <Text style={styles.nextText}>Draft · start it when you are ready. Settings can still be edited.</Text>
        ) : done ? (
          <View style={styles.championRow}>
            <View style={styles.trophyCircle}>
              <IconTrophy size={18} color={colors.gold} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.championLabel}>Champion</Text>
              <Text style={styles.championName} numberOfLines={1}>
                {champion?.name ?? 'Awaiting final result'}
              </Text>
            </View>
            {medalStandings.slice(0, 3).map((s, i) => (
              <View key={s.participant.id} style={styles.medalMini}>
                <Text style={styles.medalMiniRank}>{i + 1}</Text>
                <Text style={styles.medalMiniName} numberOfLines={1}>{s.participant.name}</Text>
              </View>
            ))}
          </View>
        ) : next ? (
          <View style={styles.nextRow}>
            <View style={styles.nextDot} />
            <Text style={styles.nextText} numberOfLines={1}>
              Round {next.round} · {nameOf(tournament, next.whiteId)} vs {nameOf(tournament, next.blackId)}
            </Text>
            <IconChevronRight size={16} color={colors.mutedForeground} />
          </View>
        ) : (
          <Text style={styles.nextText}>Round complete — open to draw the next one.</Text>
        )}
      </Pressable>

      <View style={styles.cardActions}>
        <Btn
          label={done ? 'View final standings' : draft ? 'Open setup' : 'Open tournament'}
          variant={done ? 'ghost' : 'gold'}
          small
          onPress={onOpen}
          style={{ flex: 1 }}
        />
        <IconBtn label={`Delete ${tournament.name}`} onPress={onDelete}>
          <IconTrash size={16} color={colors.destructive} />
        </IconBtn>
      </View>
    </Card>
  );
}

export function ArenaScreen({
  onOpenTournament,
  onCreate,
  onManageBots,
}: {
  onOpenTournament: (id: string) => void;
  onCreate: () => void;
  onManageBots: () => void;
}) {
  const [data, setData] = useState<ArenaData | null>(null);

  const refresh = useCallback(async () => {
    setData(await loadArenaData());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const confirmDelete = useCallback((t: ArenaTournament) => {
    Alert.alert(
      'Delete this tournament?',
      `"${t.name}" and its game archive will be removed. ChessForge ratings already earned stay.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void deleteTournament(t.id).then(setData);
          },
        },
      ],
    );
  }, []);

  const humanGames = data?.history.filter((h) => h.participantId === 'you').length ?? 0;
  const tournaments = data?.tournaments ?? [];

  return (
    <View style={styles.wrap}>
      <View style={styles.hero}>
        <View style={styles.heroGlyph}>
          <IconCrown size={24} color={colors.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>ChessForge Arena</Text>
          <Text style={styles.subtitle}>
            Create your own tournaments. Put your bots on the board, or step in yourself.
          </Text>
        </View>
      </View>

      <Card style={styles.ratingCard}>
        <View style={styles.ratingHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ratingTitle}>ChessForge rating</Text>
            <Text style={styles.ratingSub}>
              Independent of your Lichess Elo · {humanGames} rated {humanGames === 1 ? 'game' : 'games'}
            </Text>
          </View>
          <Chip text="Local" color={colors.primary} />
        </View>
        <View style={styles.ratingGrid}>
          {RATING_CATEGORIES.map((category) => (
            <View key={category} style={styles.ratingBox}>
              <Text style={styles.ratingLabel}>{ratingCategoryLabel(category)}</Text>
              <Text style={styles.ratingValue}>{data?.humanRatings[category] ?? 1500}</Text>
            </View>
          ))}
        </View>
      </Card>

      <View style={styles.actionRow}>
        <Btn label="Create tournament" variant="gold" onPress={onCreate} style={{ flex: 1 }} />
        <Btn label="Manage bots" variant="ghost" onPress={onManageBots} />
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>Your tournaments</Text>
        <Text style={styles.sectionMeta}>{tournaments.length} saved</Text>
      </View>

      {data === null ? (
        <View style={styles.loading}><Spinner /></View>
      ) : tournaments.length === 0 ? (
        <Card>
          <View style={styles.emptyGlyph}>
            <IconTrophy size={28} color={colors.gold} />
          </View>
          <Text style={styles.emptyTitle}>The arena is waiting</Text>
          <Text style={styles.emptyText}>
            Build a bot, then create a round robin, Swiss, knockout or Arena event. A bot
            championship needs two; a human event needs one opponent. Every game is saved
            locally and can be reviewed afterwards.
          </Text>
          <Btn label="Create the first tournament" variant="gold" onPress={onCreate} style={styles.emptyBtn} />
        </Card>
      ) : (
        tournaments.map((t) => (
          <TournamentCard
            key={t.id}
            tournament={t}
            onOpen={() => onOpenTournament(t.id)}
            onDelete={() => confirmDelete(t)}
          />
        ))
      )}

      <Text style={styles.footnote}>
        Bot-vs-bot games update bot ratings. Your rated games update your ChessForge rating.
        Neither ever touches Lichess.
      </Text>
    </View>
  );
}

const styles = themedStyles(() => ({
  wrap: { gap: 12 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.38)',
  },
  title: { fontFamily: fonts.sansBold, fontSize: 23, color: colors.foreground },
  subtitle: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, lineHeight: 17, marginTop: 2 },
  ratingCard: { gap: 10, borderColor: 'rgba(212,175,55,0.35)', backgroundColor: 'rgba(212,175,55,0.06)' },
  ratingHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ratingTitle: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  ratingSub: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, marginTop: 2 },
  ratingGrid: { flexDirection: 'row', gap: 6 },
  ratingBox: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    paddingVertical: 7,
  },
  ratingLabel: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  ratingValue: { fontFamily: fonts.sansSemiBold, fontSize: 16, color: colors.foreground },
  actionRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  sectionTitle: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground },
  sectionMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  gap: { gap: 9 },
  cardPress: { gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardHeadText: { flex: 1, gap: 2 },
  cardTitle: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground },
  cardMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  championRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  trophyCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.13)',
  },
  championLabel: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  championName: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.gold },
  medalMini: {
    maxWidth: 58,
    alignItems: 'center',
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    paddingLeft: 6,
  },
  medalMiniRank: { fontFamily: fonts.sansBold, fontSize: 11, color: colors.gold },
  medalMiniName: { fontFamily: fonts.sans, fontSize: 8, color: colors.mutedForeground },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  nextDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primary },
  nextText: { flex: 1, fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pressed: { opacity: 0.75 },
  loading: { paddingVertical: 26, alignItems: 'center' },
  emptyGlyph: { alignSelf: 'center', marginBottom: 4 },
  emptyTitle: { fontFamily: fonts.sansSemiBold, fontSize: 15, color: colors.foreground, textAlign: 'center' },
  emptyText: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, lineHeight: 17, textAlign: 'center', marginTop: 4 },
  emptyBtn: { marginTop: 8, alignSelf: 'center' },
  footnote: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14, textAlign: 'center', marginTop: 2 },
}));
