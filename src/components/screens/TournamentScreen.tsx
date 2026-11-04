'use client';

/**
 * One ChessForge Arena tournament: the live board of pairings, the table, and
 * the final podium. It is deliberately a single scrollable sheet rather than a
 * tabbed admin screen — the user came here to see who is winning and play the
 * next game.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Btn, Card, Chip, IconBtn, Segmented, Spinner } from '@/components/ui/Primitives';
import { KnockoutBracket } from '@/components/KnockoutBracket';
import { IconChevronLeft, IconCrown, IconPlay, IconTrophy } from '@/components/ui/Icons';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';
import { ARENA_FORMAT_LABEL, ARENA_MODE_LABEL, resultLabel } from '@/lib/arena/labels';
import { playTournamentSound } from '@/lib/sounds';
import { useAppStore } from '@/lib/store';
import { championTiebreakNote, computeStandings, nextPendingGame, roundComplete } from '@/lib/arena/pairing';
import { isBotOnlyGame, simulateBotGame } from '@/lib/arena/autoPlay';
import {
  advanceTournamentAndSave,
  loadTournament,
  startTournament,
  updateDraftSettings,
} from '@/lib/arena/store';
import {
  TIME_CONTROLS,
  customTimeControl,
  ratedAllowed,
  timeControlById,
} from '@/lib/arena/timeControl';
import type {
  ArenaFormat,
  ArenaGame,
  ArenaStanding,
  ArenaTimeControl,
  ArenaTournament,
} from '@/lib/arena/types';

const MEDAL = ['#d4af37', '#b8c0c8', '#b87333'] as const;

/**
 * WHAT EACH FORMAT ACTUALLY DOES.
 *
 * The owner's report: *"the app doesnt differ knockout and other tournaments"*.
 * The scheduling differs in the engine, but the screen never said so — a
 * knockout and a league looked like the same list of games. This sentence is
 * the difference made visible, and it is also where a tie is explained.
 */
const FORMAT_RULES: Record<ArenaFormat, string> = {
  'round-robin': 'Everyone plays everyone once. Ties: head-to-head, Buchholz, Sonneborn-Berger, wins, then games with Black.',
  'double-round-robin': 'Everyone plays everyone twice, once with each colour. Same tie-breaks as round robin.',
  knockout: 'Single elimination. A level match goes to Armageddon: Black advances on a draw.',
  swiss: 'Score-group pairings each round; nobody is eliminated.',
  arena: 'Repeated score-group pairings; rematches are allowed.',
};

function nameOf(t: ArenaTournament, id: string | null): string {
  if (!id) return 'Bye';
  return t.participants.find((p) => p.id === id)?.name ?? 'Player';
}

function Podium({ standings }: { standings: ArenaStanding[] }) {
  const top = standings.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  return (
    <View style={styles.podiumRow}>
      {order.map((s) => {
        const rank = s.rank;
        return (
          <View key={s.participant.id} style={[styles.podiumItem, rank === 1 ? styles.podiumFirst : null]}>
            <View style={[styles.podiumMedal, { borderColor: MEDAL[rank - 1] ?? colors.border }]}>
              <IconTrophy size={rank === 1 ? 18 : 14} color={MEDAL[rank - 1] ?? colors.gold} />
            </View>
            <Text style={styles.podiumName} numberOfLines={1}>{s.participant.name}</Text>
            <Text style={[styles.podiumRank, { color: MEDAL[rank - 1] ?? colors.mutedForeground }]}>
              {rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd'}
            </Text>
            <Text style={styles.podiumPoints}>{s.points} pts</Text>
          </View>
        );
      })}
    </View>
  );
}

function StandingRow({ row, completed }: { row: ArenaStanding; completed: boolean }) {
  const p = row.participant;
  const medal = completed && row.rank <= 3 ? MEDAL[row.rank - 1] : null;
  return (
    <View style={[styles.standingRow, p.kind === 'human' ? styles.standingYou : null]}>
      <View style={[styles.rankBadge, medal ? { borderColor: medal, backgroundColor: `${medal}20` } : null]}>
        <Text style={[styles.rankText, medal ? { color: medal } : null]}>{row.rank}</Text>
      </View>
      <View style={styles.standingNameCol}>
        <Text style={styles.standingName} numberOfLines={1}>
          {p.name}
          {p.kind === 'human' ? <Text style={styles.youTag}> · you</Text> : null}
        </Text>
        <Text style={styles.standingMeta}>
          {p.rating} · {row.played} played · {row.wins}/{row.draws}/{row.losses}
        </Text>
      </View>
      <View style={styles.pointsCol}>
        <Text style={styles.pointsText}>{row.points}</Text>
        <Text style={styles.pointsLabel}>pts</Text>
      </View>
      <View style={styles.perfCol}>
        <Text style={styles.perfText}>{row.performance ?? '—'}</Text>
        <Text style={styles.pointsLabel}>perf</Text>
      </View>
    </View>
  );
}

function GameRow({
  tournament,
  game,
  onOpen,
}: {
  tournament: ArenaTournament;
  game: ArenaGame;
  onOpen: () => void;
}) {
  const done = game.status === 'done';
  const bye = game.result === 'bye';
  const future = !done && game.round > tournament.currentRound;
  // Pending games are playable too, so the user can choose the order inside the
  // current round. Future round-robin rounds wait until the current round is
  // finished, otherwise the tournament's round counter can be skipped.
  const canOpen = !bye && !future;
  return (
    <Pressable
      onPress={canOpen ? onOpen : undefined}
      style={({ pressed }) => [styles.gameRow, pressed && canOpen ? styles.pressed : null]}
    >
      <Text style={styles.boardNo}>{game.board}</Text>
      <View style={styles.gameNames}>
        <Text style={styles.gameWhite} numberOfLines={1}>{nameOf(tournament, game.whiteId)}</Text>
        <Text style={styles.gameBlack} numberOfLines={1}>{nameOf(tournament, game.blackId)}</Text>
      </View>
      {bye ? (
        <Chip text="Bye" color={colors.mutedForeground} />
      ) : done ? (
        <View style={styles.resultBox}>
          <Text style={styles.resultText}>{resultLabel(game.result)}</Text>
          <Text style={styles.resultReason} numberOfLines={1}>{game.reason ?? 'finished'}</Text>
        </View>
      ) : game.status === 'playing' ? (
        <Chip text="Live" color={colors.primary} />
      ) : future ? (
        <Chip text="Later" color={colors.mutedForeground} />
      ) : (
        <View style={styles.playChip}>
          <IconPlay size={11} color={colors.gold} />
          <Text style={styles.playChipText}>Play</Text>
        </View>
      )}
    </Pressable>
  );
}

export function TournamentScreen({
  tournamentId,
  autoStart,
  onBack,
  onOpenGame,
}: {
  tournamentId: string;
  autoStart?: boolean;
  onBack: () => void;
  onOpenGame: (gameId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tournament, setTournament] = useState<ArenaTournament | null>(null);
  const [missing, setMissing] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editFormat, setEditFormat] = useState<ArenaFormat>('round-robin');
  const [editTimeId, setEditTimeId] = useState('blitz-5-3');
  const [editRated, setEditRated] = useState(true);
  const [editRounds, setEditRounds] = useState(5);
  const [editCustomInitial, setEditCustomInitial] = useState('10');
  const [editCustomIncrement, setEditCustomIncrement] = useState('5');
  const autoStarted = useRef(false);
  const championCelebrated = useRef(false);
  const celebrate = useAppStore((s) => s.celebrate);
  /** "Simulating the other boards…" label while bot-only games are played out. */
  const [simulating, setSimulating] = useState<string | null>(null);
  /** Games we already tried, so a failing simulation cannot retry forever. */
  const simTried = useRef<Set<string>>(new Set());
  const simRunning = useRef(false);

  /*
   * THE ARRIVAL. Entering a tournament is an event, and the owner asked for the
   * sound of it. Played once when this screen mounts, so going back and forth
   * between the board and the tournament re-announces the event rather than
   * firing on every re-render.
   */
  useEffect(() => {
    playTournamentSound();
  }, []);

  const refresh = useCallback(async () => {
    const t = await loadTournament(tournamentId);
    if (t) setTournament(t);
    else setMissing(true);
  }, [tournamentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const standings = useMemo(
    () => (tournament ? computeStandings(tournament) : []),
    [tournament],
  );
  const next = tournament ? nextPendingGame(tournament) : null;
  const done = tournament?.status === 'completed';
  const draft = tournament?.status === 'draft';
  const roundDone = tournament ? roundComplete(tournament, tournament.currentRound) : false;
  const finalRound = tournament ? tournament.currentRound >= tournament.rounds : false;
  const played = tournament?.games.filter((g) => g.status === 'done').length ?? 0;
  const total = tournament?.games.length ?? 0;
  /*
   * ONE WINNER, ALWAYS. The tiebreak ladder in `computeStandings` orders every
   * player 1..n, so the champion is the first row (or the knockout bracket's
   * winner). The note beside the name says which rule separated first from
   * second when the points were level.
   */
  const champion = tournament?.championId
    ? tournament.participants.find((p) => p.id === tournament.championId)
    : standings[0]?.participant;
  const tiebreakNote = useMemo(
    () => (tournament && done ? championTiebreakNote(tournament) : null),
    [done, tournament],
  );
  /*
   * A knockout's champion is the last player standing, which is not always the
   * player with the most points — a final decided on the tiebreak can leave the
   * runner-up ahead on score. Put the champion first on the final sheet and let
   * the remaining places follow the normal tiebreak order.
   */
  const orderedStandings = useMemo(() => {
    if (!tournament || tournament.format !== 'knockout' || !tournament.championId) return standings;
    const first = standings.find((s) => s.participant.id === tournament.championId);
    if (!first) return standings;
    return [first, ...standings.filter((s) => s.participant.id !== tournament.championId)]
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }, [standings, tournament]);
  const championStanding = orderedStandings.find((s) => s.participant.id === champion?.id) ?? orderedStandings[0];

  /*
   * THE TOURNAMENT-WIN MOMENT — once, when the final sheet appears.
   *
   * A shared title counts: finishing level on every counted tiebreak is a win,
   * not a runner-up place, and the copy says which it was.
   */
  useEffect(() => {
    if (!done || championCelebrated.current || !tournament) return;
    const youWon = tournament.championId === 'you'
      || (!tournament.championId && standings[0]?.participant.id === 'you');
    if (!youWon) return;
    championCelebrated.current = true;
    celebrate('champion', `You won ${tournament.name}.`);
  }, [celebrate, done, standings, tournament]);

  /* The legacy auto-start prop: nothing passes `true` any more (creating an
   * event lands on this sheet), but a draft the user starts themselves still
   * uses the sheet's own Play button. */
  useEffect(() => {
    if (!autoStart || autoStarted.current || !tournament) return;
    if (tournament.status !== 'active') return;
    const game = nextPendingGame(tournament);
    if (game) {
      autoStarted.current = true;
      onOpenGame(game.id);
    }
  }, [autoStart, onOpenGame, tournament]);

  /*
   * THE OTHER BOARDS PLAY THEMSELVES — ONE AT A TIME, IN THE BACKGROUND.
   *
   * The owner: *"the user shouldnt stop and watch games between bots. he plays
   * his games and gets the results of other bots in the page, and if he want to
   * watch a game of bots in that tournament, he can click on that game and watch
   * it"*. So each pass simulates ONE pending bot-only board, saves it, and
   * reloads; the reload re-runs this effect for the next board. A finished board
   * stays in the games list and can be opened to watch at any time.
   */
  useEffect(() => {
    if (!tournament || tournament.status !== 'active' || tournament.mode !== 'human') return;
    if (simRunning.current) return;
    const game = tournament.games.find((g) =>
      g.round === tournament.currentRound
      && g.status !== 'done'
      && !!g.blackId
      && isBotOnlyGame(tournament, g)
      && !simTried.current.has(g.id));
    if (!game) return;

    simRunning.current = true;
    simTried.current.add(game.id);
    let alive = true;
    const white = tournament.participants.find((p) => p.id === game.whiteId)?.name ?? 'Bot';
    const black = tournament.participants.find((p) => p.id === game.blackId)?.name ?? 'Bot';
    setSimulating(`${white} vs ${black}`);
    void (async () => {
      const played = await simulateBotGame(tournament, game).catch(() => false);
      const fresh = await loadTournament(tournament.id);
      simRunning.current = false;
      if (!alive) return;
      setSimulating(null);
      if (played && fresh) setTournament(fresh);
    })();
    return () => {
      alive = false;
      simRunning.current = false;
    };
  }, [tournament]);

  const advance = useCallback(async () => {
    setAdvancing(true);
    try {
      const data = await advanceTournamentAndSave(tournamentId);
      const t = data.tournaments.find((x) => x.id === tournamentId) ?? null;
      setTournament(t);
    } catch (e) {
      Alert.alert('Could not draw the next round', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setAdvancing(false);
    }
  }, [tournamentId]);

  const editTime: ArenaTimeControl = useMemo(() => {
    if (editTimeId !== 'custom') return timeControlById(editTimeId);
    const minutes = Number.parseInt(editCustomInitial, 10);
    const increment = Number.parseInt(editCustomIncrement, 10);
    return customTimeControl(
      Number.isFinite(minutes) ? Math.max(0, minutes) * 60 : 0,
      Number.isFinite(increment) ? Math.max(0, increment) : 0,
    );
  }, [editCustomIncrement, editCustomInitial, editTimeId]);

  const beginEdit = useCallback(() => {
    if (!tournament) return;
    const current = tournament.timeControl;
    setEditName(tournament.name);
    setEditFormat(tournament.format);
    setEditTimeId(current.id.startsWith('custom-') ? 'custom' : current.id);
    setEditCustomInitial(String(
      current.untimed ? 10 : Math.max(1, Math.round(current.initialSeconds / 60)),
    ));
    setEditCustomIncrement(String(current.incrementSeconds));
    setEditRated(tournament.rated);
    setEditRounds(
      (tournament.format === 'swiss' || tournament.format === 'arena')
        && ![3, 5, 7, 9].includes(tournament.rounds)
        ? 5
        : tournament.rounds,
    );
    setEditing(true);
  }, [tournament]);

  const saveEdit = useCallback(async () => {
    if (!tournament) return;
    try {
      const data = await updateDraftSettings(tournament.id, {
        name: editName,
        format: editFormat,
        timeControl: editTime,
        rated: editRated && ratedAllowed(editTime),
        rounds: editRounds,
        // Editing the other settings must not silently shorten a two-leg match.
        knockoutLegs: tournament.knockoutLegs,
      });
      setTournament(data.tournaments.find((t) => t.id === tournament.id) ?? null);
      setEditing(false);
    } catch (e) {
      Alert.alert('Could not save the setup', e instanceof Error ? e.message : 'Try again.');
    }
  }, [editFormat, editName, editRated, editRounds, editTime, tournament]);

  const startDraft = useCallback(async () => {
    if (!tournament) return;
    setStarting(true);
    try {
      const data = await startTournament(tournament.id);
      setTournament(data.tournaments.find((t) => t.id === tournament.id) ?? null);
    } catch (e) {
      Alert.alert('Could not start the tournament', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setStarting(false);
    }
  }, [tournament]);

  if (missing) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>This tournament could not be loaded.</Text>
        <Btn label="Back to Arena" variant="ghost" onPress={onBack} />
      </View>
    );
  }

  if (!tournament) {
    return <View style={styles.center}><Spinner /></View>;
  }

  const allRounds = [...new Set(tournament.games.map((g) => g.round))].sort((a, b) => b - a);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <IconBtn label="Back to Arena" onPress={onBack}>
          <IconChevronLeft size={22} color={colors.foreground} />
        </IconBtn>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{tournament.name}</Text>
          <Text style={styles.subtitle}>
            {ARENA_FORMAT_LABEL[tournament.format]} · {ARENA_MODE_LABEL[tournament.mode]}
            {tournament.format === 'knockout'
              ? ` · round ${tournament.currentRound} of ${tournament.rounds}`
              : ''}
          </Text>
        </View>
        <Chip
          text={done ? 'Completed' : draft ? 'Draft' : `Round ${tournament.currentRound}`}
          color={done ? colors.gold : draft ? colors.mutedForeground : colors.primary}
          bg={done ? 'rgba(212,175,55,0.12)' : draft ? colors.subtleFill : 'rgba(46,139,106,0.14)'}
        />
      </View>

      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.formatRule}>{FORMAT_RULES[tournament.format]}</Text>
        {simulating ? (
          <View style={styles.simRow}>
            <Spinner size={13} />
            <Text style={styles.noteSm}>
              {`Simulating ${simulating}… the result will appear with the other boards.`}
            </Text>
          </View>
        ) : null}
        {draft ? (
          <Card style={styles.draftCard}>
            <View style={styles.championTop}>
              <View style={styles.championTrophy}>
                <IconTrophy size={26} color={colors.gold} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.championKicker}>Saved for later</Text>
                <Text style={styles.championTitle} numberOfLines={1}>{tournament.name}</Text>
                <Text style={styles.championMeta}>
                  {ARENA_FORMAT_LABEL[tournament.format]} · {tournament.timeControl.label} ·{' '}
                  {tournament.rated ? 'Rated' : 'Unrated'}
                </Text>
              </View>
              <Chip text="Draft" />
            </View>
            <View style={styles.draftField}>
              {tournament.participants.map((p) => (
                <Chip key={p.id} text={`${p.name} ${p.rating}`} />
              ))}
            </View>
            <Text style={styles.note}>
              Settings can be edited until the first game. The bot snapshots and the field are
              already frozen.
            </Text>
            <View style={styles.actionRow}>
              <Btn
                label={starting ? 'Starting…' : 'Start tournament'}
                variant="gold"
                disabled={starting}
                onPress={() => void startDraft()}
                style={{ flex: 1 }}
              />
              <Btn label="Edit settings" variant="ghost" onPress={beginEdit} />
            </View>
          </Card>
        ) : done ? (
          <Card style={styles.championCard}>
            <View style={styles.championTop}>
              <View style={styles.championTrophy}>
                <IconTrophy size={30} color={colors.gold} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.championKicker}>Tournament champion</Text>
                <Text style={styles.championTitle} numberOfLines={2}>
                  {champion?.name ?? 'Champion'}
                </Text>
                <Text style={styles.championMeta}>
                  {championStanding?.points ?? 0} points · performance {championStanding?.performance ?? '—'}
                  {tiebreakNote ? ` · won on the tiebreak (${tiebreakNote})` : ''}
                </Text>
              </View>
              <IconCrown size={24} color={colors.gold} />
            </View>
            <Podium standings={orderedStandings} />
          </Card>
        ) : (
          <Card style={styles.nextCard}>
            <View style={styles.nextTop}>
              <View style={styles.nextDot} />
              <Text style={styles.nextLabel}>
                {roundDone
                  ? 'Round complete'
                  : next?.armageddon
                    ? `Armageddon tiebreak · round ${tournament.currentRound}`
                    : `Next game · round ${tournament.currentRound}`}
              </Text>
              {next?.armageddon ? <Chip text="ARMAGEDDON" color={colors.gold} /> : null}
              <Chip text={`${played}/${total} games`} />
            </View>
            {next?.armageddon ? (
              <Text style={styles.note}>
                The match is level. Black advances on a draw; White has the longer clock.
              </Text>
            ) : null}
            {next ? (
              <>
                <View style={styles.matchup}>
                  <View style={styles.side}>
                    <Text style={styles.sideColor}>WHITE</Text>
                    <Text style={styles.sideName} numberOfLines={1}>{nameOf(tournament, next.whiteId)}</Text>
                  </View>
                  <Text style={styles.vs}>vs</Text>
                  <View style={[styles.side, { alignItems: 'flex-end' }]}>
                    <Text style={styles.sideColor}>BLACK</Text>
                    <Text style={styles.sideName} numberOfLines={1}>{nameOf(tournament, next.blackId)}</Text>
                  </View>
                </View>
                <Btn
                  label={
                    next.armageddon
                      ? 'Play the tiebreak'
                      : tournament.mode === 'human' && (next.blackId === 'you' || next.whiteId === 'you')
                        ? 'Play this game'
                        : 'Watch this game'
                  }
                  variant="gold"
                  onPress={() => onOpenGame(next.id)}
                />
                <Text style={styles.note}>
                  {next.armageddon
                    ? 'Armageddon'
                    : `${tournament.timeControl.label} · ${tournament.rated ? 'Rated ChessForge game' : 'Unrated'}`}
                  {next.leg ? ` · leg ${next.leg} of ${tournament.knockoutLegs ?? 1}` : ''}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.roundDoneTitle}>
                  {finalRound ? 'All scheduled games are finished.' : 'All games in this round are finished.'}
                </Text>
                <Text style={styles.note}>
                  {finalRound
                    ? 'Finish the tournament to crown the champion.'
                    : tournament.format === 'round-robin' || tournament.format === 'double-round-robin'
                      ? 'Open the next scheduled round.'
                      : 'Draw the next round from the current standings.'}
                </Text>
                <Btn
                  label={
                    advancing
                      ? finalRound ? 'Finishing…' : 'Drawing…'
                      : finalRound ? 'Finish tournament' : 'Draw next round'
                  }
                  variant="gold"
                  disabled={advancing}
                  onPress={() => void advance()}
                />
              </>
            )}
          </Card>
        )}

        {draft ? (
          <Card style={styles.gap}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Field</Text>
              <Text style={styles.sectionMeta}>{tournament.participants.length} players</Text>
            </View>
            {tournament.participants.map((p) => (
              <View key={p.id} style={styles.draftPlayer}>
                <Text style={styles.draftPlayerName} numberOfLines={1}>{p.name}</Text>
                <Text style={styles.draftPlayerMeta}>
                  {p.kind === 'human' ? 'You' : 'Bot'} · {p.rating}
                </Text>
              </View>
            ))}
            <Text style={styles.noteSm}>
              The field is set. Starting the tournament creates the first pairings; until then the
              settings above can still change.
            </Text>
          </Card>
        ) : tournament.format === 'knockout' ? (
          /*
           * A CUP IS NOT A LEAGUE. Knockouts get the bracket — rounds as columns,
           * ties as cards, the possible opponent shown in every future slot, and
           * any played tie tappable to watch.
           */
          <Card style={styles.gap}>
            <KnockoutBracket tournament={tournament} onOpenGame={onOpenGame} />
            <Text style={styles.noteSm}>
              A level match is decided by an Armageddon: Black advances on a draw.
            </Text>
          </Card>
        ) : (
          <Card style={styles.gap}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>League table</Text>
              <Text style={styles.sectionMeta}>
                {tournament.rated ? 'ChessForge rated' : 'Unrated'}
              </Text>
            </View>
            {orderedStandings.map((row) => (
              <StandingRow key={row.participant.id} row={row} completed={done} />
            ))}
            <Text style={styles.noteSm}>
              Points first, then head-to-head, Buchholz, Sonneborn-Berger, wins, then games with
              Black. Performance is the local Elo estimate against the field.
            </Text>
          </Card>
        )}

        {draft ? null : (
          <Card style={styles.gap}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Pairings & games</Text>
              <Text style={styles.sectionMeta}>{total} games</Text>
            </View>
            {allRounds.map((round) => {
              const games = tournament.games
                .filter((g) => g.round === round)
                .sort((a, b) => a.board - b.board);
              return (
                <View key={round} style={styles.roundBlock}>
                  <View style={styles.roundHead}>
                    <Text style={styles.roundTitle}>Round {round}</Text>
                    <Text style={styles.sectionMeta}>
                      {games.filter((g) => g.status === 'done').length}/{games.length}
                    </Text>
                  </View>
                  {games.map((g) => (
                    <GameRow key={g.id} tournament={tournament} game={g} onOpen={() => onOpenGame(g.id)} />
                  ))}
                </View>
              );
            })}
          </Card>
        )}

        <Text style={styles.footnote}>
          Every finished game keeps its moves and PGN. Open any result to replay it or send it to
          Analyse.
        </Text>
      </ScrollView>

      <Modal visible={editing} transparent animationType="slide" onRequestClose={() => setEditing(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>Edit draft</Text>
              <IconBtn label="Close editor" onPress={() => setEditing(false)}>
                <IconChevronLeft size={20} color={colors.foreground} />
              </IconBtn>
            </View>
            <ScrollView contentContainerStyle={styles.editScroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.fieldLabel}>Tournament name</Text>
              <View style={styles.inputBox}>
                <TextInput
                  value={editName}
                  onChangeText={setEditName}
                  placeholder="ChessForge Arena"
                  placeholderTextColor={colors.mutedForeground}
                  style={styles.input}
                  maxLength={48}
                />
              </View>

              <Text style={styles.fieldLabel}>Format</Text>
              <View style={styles.editChipRow}>
                {(Object.keys(ARENA_FORMAT_LABEL) as ArenaFormat[]).map((id) => {
                  const on = id === editFormat;
                  return (
                    <Pressable
                      key={id}
                      onPress={() => {
                        setEditFormat(id);
                        // Swiss and Arena use the 3/5/7/9 selector below. A
                        // round-robin draft may carry a different round count.
                        if ((id === 'swiss' || id === 'arena') && ![3, 5, 7, 9].includes(editRounds)) {
                          setEditRounds(5);
                        }
                      }}
                      style={({ pressed }) => [
                        styles.editChip,
                        on ? styles.editChipOn : null,
                        pressed ? styles.pressed : null,
                      ]}
                    >
                      <Text style={[styles.editChipText, on ? styles.editChipTextOn : null]}>
                        {ARENA_FORMAT_LABEL[id]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <Text style={styles.fieldLabel}>Time control</Text>
              <View style={styles.editChipRow}>
                {TIME_CONTROLS.map((t) => {
                  const on = t.id === editTimeId;
                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => setEditTimeId(t.id)}
                      style={({ pressed }) => [
                        styles.editChip,
                        on ? styles.editChipOn : null,
                        pressed ? styles.pressed : null,
                      ]}
                    >
                      <Text style={[styles.editChipText, on ? styles.editChipTextOn : null]}>{t.label}</Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  onPress={() => setEditTimeId('custom')}
                  style={({ pressed }) => [
                    styles.editChip,
                    editTimeId === 'custom' ? styles.editChipOn : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text style={[styles.editChipText, editTimeId === 'custom' ? styles.editChipTextOn : null]}>
                    Custom
                  </Text>
                </Pressable>
              </View>

              {editTimeId === 'custom' ? (
                <View style={styles.editCustomRow}>
                  <View style={styles.editCustomCol}>
                    <Text style={styles.fieldLabel}>Minutes</Text>
                    <View style={styles.inputBox}>
                      <TextInput
                        value={editCustomInitial}
                        onChangeText={setEditCustomInitial}
                        keyboardType="number-pad"
                        style={styles.input}
                        placeholder="10"
                        placeholderTextColor={colors.mutedForeground}
                      />
                    </View>
                  </View>
                  <View style={styles.editCustomCol}>
                    <Text style={styles.fieldLabel}>Increment (s)</Text>
                    <View style={styles.inputBox}>
                      <TextInput
                        value={editCustomIncrement}
                        onChangeText={setEditCustomIncrement}
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
                  { id: 'rated', label: ratedAllowed(editTime) ? 'Rated' : 'Rated (untimed)' },
                  { id: 'unrated', label: 'Unrated' },
                ]}
                value={editRated && ratedAllowed(editTime) ? 'rated' : 'unrated'}
                onChange={(v: string) => setEditRated(v === 'rated' && ratedAllowed(editTime))}
              />

              {(editFormat === 'swiss' || editFormat === 'arena') ? (
                <>
                  <Text style={styles.fieldLabel}>Rounds</Text>
                  <Segmented
                    options={[3, 5, 7, 9].map((n) => ({ id: String(n), label: String(n) }))}
                    value={String(editRounds)}
                    onChange={(v: string) => setEditRounds(Number(v))}
                  />
                </>
              ) : null}

              <Text style={styles.noteSm}>
                The bot snapshots and the field are frozen. Only the tournament setup can change
                before the first game.
              </Text>
            </ScrollView>
            <View style={[styles.modalActions, { paddingBottom: insets.bottom + 16 }]}>
              <Btn label="Save settings" onPress={() => void saveEdit()} style={styles.modalPlay} />
              <Btn label="Cancel" variant="ghost" small onPress={() => setEditing(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = themedStyles(() => ({
  root: { flex: 1 },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontFamily: fonts.sansBold, fontSize: 17, color: colors.foreground },
  subtitle: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  content: { padding: 12, gap: 10 },
  gap: { gap: 8 },
  championCard: { gap: 10, borderColor: 'rgba(212,175,55,0.45)', backgroundColor: 'rgba(212,175,55,0.07)' },
  draftCard: { gap: 9, borderColor: 'rgba(212,175,55,0.35)', backgroundColor: 'rgba(212,175,55,0.05)' },
  draftField: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  draftPlayer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  draftPlayerName: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  draftPlayerMeta: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  championTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  championTrophy: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,175,55,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.5)',
  },
  championKicker: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, textTransform: 'uppercase' },
  championTitle: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.gold },
  championMeta: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  podiumRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 8, marginTop: 2 },
  podiumItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    padding: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  podiumFirst: { borderColor: 'rgba(212,175,55,0.6)', paddingVertical: 11 },
  podiumMedal: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  podiumName: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.foreground, maxWidth: '100%' },
  podiumRank: { fontFamily: fonts.sansBold, fontSize: 10 },
  podiumPoints: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  nextCard: { gap: 9 },
  nextTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  nextDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  nextLabel: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.foreground },
  matchup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  side: { flex: 1, gap: 2 },
  sideColor: { fontFamily: fonts.sans, fontSize: 8, color: colors.mutedForeground, letterSpacing: 0.6 },
  sideName: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  vs: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  note: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground, lineHeight: 14 },
  formatRule: {
    fontFamily: fonts.sans,
    fontSize: 10,
    color: colors.mutedForeground,
    lineHeight: 14,
    paddingHorizontal: 2,
  },
  simRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2 },
  noteSm: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, lineHeight: 13 },
  roundDoneTitle: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sectionTitle: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  sectionMeta: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  standingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  standingYou: { backgroundColor: 'rgba(46,139,106,0.08)', borderRadius: radii.sm },
  rankBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: { fontFamily: fonts.sansBold, fontSize: 11, color: colors.mutedForeground },
  standingNameCol: { flex: 1, gap: 1 },
  standingName: { fontFamily: fonts.sansMedium, fontSize: 12, color: colors.foreground },
  youTag: { color: colors.primary, fontFamily: fonts.sansBold },
  standingMeta: { fontFamily: fonts.sans, fontSize: 8, color: colors.mutedForeground },
  pointsCol: { width: 30, alignItems: 'center' },
  pointsText: { fontFamily: fonts.sansBold, fontSize: 14, color: colors.foreground },
  pointsLabel: { fontFamily: fonts.sans, fontSize: 7, color: colors.mutedForeground, textTransform: 'uppercase' },
  perfCol: { width: 38, alignItems: 'center' },
  perfText: { fontFamily: fonts.sansMedium, fontSize: 11, color: colors.mutedForeground },
  roundBlock: { gap: 4, marginTop: 4 },
  roundHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 },
  roundTitle: { fontFamily: fonts.sansSemiBold, fontSize: 11, color: colors.foreground },
  gameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 5,
    borderRadius: radii.sm,
    backgroundColor: colors.card,
  },
  boardNo: { width: 14, fontFamily: fonts.mono, fontSize: 9, color: colors.mutedForeground, textAlign: 'center' },
  gameNames: { flex: 1, gap: 1 },
  gameWhite: { fontFamily: fonts.sansMedium, fontSize: 11, color: colors.foreground },
  gameBlack: { fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  resultBox: { alignItems: 'flex-end', gap: 1, maxWidth: 92 },
  resultText: { fontFamily: fonts.sansBold, fontSize: 11, color: colors.gold },
  resultReason: { fontFamily: fonts.sans, fontSize: 7, color: colors.mutedForeground },
  playChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.4)',
    backgroundColor: 'rgba(212,175,55,0.09)',
  },
  playChipText: { fontFamily: fonts.sansMedium, fontSize: 9, color: colors.gold },
  pressed: { opacity: 0.75 },
  emptyText: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground, textAlign: 'center' },
  footnote: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground, lineHeight: 13, textAlign: 'center' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    maxHeight: '88%',
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.xl ?? 18,
    borderTopRightRadius: radii.xl ?? 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: { flex: 1, fontFamily: fonts.sansBold, fontSize: 17, color: colors.foreground },
  editScroll: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  fieldLabel: { fontFamily: fonts.sansMedium, fontSize: 10, color: colors.mutedForeground },
  inputBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
    paddingHorizontal: 10,
  },
  input: { fontFamily: fonts.sans, fontSize: 13, color: colors.foreground, paddingVertical: 8 },
  editCustomRow: { flexDirection: 'row', gap: 8 },
  editCustomCol: { flex: 1, gap: 4 },
  editChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  editChip: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  editChipOn: { borderColor: colors.gold, backgroundColor: 'rgba(212,175,55,0.10)' },
  editChipText: { fontFamily: fonts.sans, fontSize: 10, color: colors.foreground },
  editChipTextOn: { color: colors.gold, fontFamily: fonts.sansMedium },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalPlay: { flex: 1 },
}));
