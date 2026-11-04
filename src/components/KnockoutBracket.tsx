'use client';

/**
 * THE CUP DRAW.
 *
 * A knockout shown as a flat "standings" table reads like a league, which is
 * exactly the owner's complaint: *"in tournaments for the knockout, it should be
 * displayed as a cup ... but for the others it should be displayed as a league.
 * (the current implementation display the knockout as a league which is not
 * okay)"*.
 *
 * This is a bracket: one column per round, one card per tie, the winner in gold.
 * Future rounds show the players who COULD fill the slot — the two teams feeding
 * it — so as you advance you can see who might be waiting (the FIFA/PES cup
 * view). A card that has a played game opens it to watch or replay.
 */

import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { knockoutMatchWinner, knockoutMatches, knockoutScores, knockoutTiebreak } from '@/lib/arena/pairing';
import type { KnockoutMatch } from '@/lib/arena/pairing';
import type { ArenaTournament } from '@/lib/arena/types';
import { colors, fonts, radii } from '@/theme/tokens';

interface Slot {
  /** The two lines printed on the card: a player, or "A / B" possibilities. */
  sides: [string, string];
  /** Which side is the winner (0 or 1), when the tie is decided. */
  winnerSide: 0 | 1 | null;
  /** A bye: only one player, and they advance automatically. */
  bye?: boolean;
  /** The game to open, when one exists. */
  gameId?: string;
  scores?: [number, number];
  armageddon?: boolean;
}

function roundTitle(slots: number): string {
  if (slots === 1) return 'Final';
  if (slots === 2) return 'Semi-finals';
  if (slots === 4) return 'Quarter-finals';
  return `${slots * 2} players`;
}

export function KnockoutBracket({
  tournament,
  onOpenGame,
}: {
  tournament: ArenaTournament;
  onOpenGame: (gameId: string) => void;
}) {
  const rounds = Math.max(1, tournament.rounds || 1);
  const nameOf = useMemo(() => {
    const byId = new Map(tournament.participants.map((p) => [p.id, p.name]));
    return (id: string | null) => (id ? byId.get(id) ?? 'Player' : '—');
  }, [tournament.participants]);

  const columns = useMemo<Slot[][]>(() => {
    const first = knockoutMatches(tournament, 1);
    const firstCount = Math.max(1, first.length || Math.ceil(tournament.participants.length / 2));
    const out: Slot[][] = [];

    for (let r = 1; r <= rounds; r += 1) {
      const matches: KnockoutMatch[] = r === 1 ? first : knockoutMatches(tournament, r);
      const slots = Math.max(1, Math.ceil(firstCount / 2 ** (r - 1)));
      const column: Slot[] = [];

      for (let j = 0; j < slots; j += 1) {
        const match = matches[j];
        if (match) {
          const [a, b] = match.playerIds;
          const winner = knockoutMatchWinner(match);
          const scores = knockoutScores(match);
          column.push({
            sides: b ? [nameOf(a), nameOf(b)] : [nameOf(a), 'Bye'],
            bye: !b,
            winnerSide: winner && b ? (winner === a ? 0 : 1) : !b ? 0 : null,
            gameId: match.games[0]?.id,
            scores: b ? [scores[a] ?? 0, scores[b] ?? 0] : undefined,
            armageddon: !!knockoutTiebreak(match),
          });
          continue;
        }

        /*
         * A round that has not been drawn yet still shows its POSSIBLE players:
         * the two ties feeding this slot. That is how you know who you might
         * meet when you advance, which is the whole point of a cup view.
         */
        const prev = out[r - 2] ?? [];
        const feedA = prev[2 * j];
        const feedB = prev[2 * j + 1];
        const label = (s: Slot | undefined) => {
          if (!s) return 'Winner';
          if (s.bye || s.winnerSide != null) return s.winnerSide != null ? s.sides[s.winnerSide] : s.sides[0];
          return `${s.sides[0]} / ${s.sides[1]}`;
        };
        column.push({
          sides: [label(feedA), label(feedB)],
          winnerSide: null,
        });
      }
      out.push(column);
    }
    return out;
  }, [nameOf, rounds, tournament]);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title}>Cup draw</Text>
        <Text style={styles.note}>Single elimination · tap a tie to watch it</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.columns}>
        {columns.map((column, r) => (
          <View key={r} style={styles.column}>
            <Text style={[styles.round, r + 1 === tournament.currentRound ? styles.roundNow : null]}>
              {roundTitle(column.length)}
            </Text>
            {column.map((slot, j) => {
              const live = r + 1 === tournament.currentRound;
              return (
                <Pressable
                  key={`${r}-${j}`}
                  disabled={!slot.gameId}
                  onPress={() => { if (slot.gameId) onOpenGame(slot.gameId); }}
                  style={({ pressed }) => [
                    styles.tie,
                    live ? styles.tieLive : null,
                    slot.winnerSide != null ? styles.tieDone : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <View style={styles.sideRow}>
                    <Text
                      style={[
                        styles.side,
                        slot.winnerSide === 0 ? styles.winner : null,
                        slot.sides[0] === 'You' || slot.sides[0].startsWith('You') ? styles.you : null,
                      ]}
                      numberOfLines={1}
                    >
                      {slot.sides[0]}
                    </Text>
                    {slot.scores ? <Text style={styles.score}>{slot.scores[0]}</Text> : null}
                  </View>
                  {slot.bye ? null : (
                    <View style={styles.sideRow}>
                      <Text
                        style={[
                          styles.side,
                          slot.winnerSide === 1 ? styles.winner : null,
                          slot.sides[1] === 'You' || slot.sides[1].startsWith('You') ? styles.you : null,
                        ]}
                        numberOfLines={1}
                      >
                        {slot.sides[1]}
                      </Text>
                      {slot.scores ? <Text style={styles.score}>{slot.scores[1]}</Text> : null}
                    </View>
                  )}
                  {slot.armageddon ? <Text style={styles.arm}>Armageddon</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  head: { gap: 1 },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 13, color: colors.foreground },
  note: { fontFamily: fonts.sans, fontSize: 9, color: colors.mutedForeground },
  columns: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  column: { width: 132, gap: 6 },
  round: {
    fontFamily: fonts.sansMedium,
    fontSize: 9,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  roundNow: { color: colors.gold },
  tie: {
    gap: 3,
    padding: 7,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.card,
  },
  tieLive: { borderColor: 'rgba(212,175,55,0.5)' },
  tieDone: { backgroundColor: 'rgba(212,175,55,0.05)' },
  sideRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  side: { flex: 1, fontFamily: fonts.sans, fontSize: 10, color: colors.mutedForeground },
  winner: { color: colors.gold, fontFamily: fonts.sansSemiBold },
  you: { color: colors.primary },
  score: { fontFamily: fonts.mono, fontSize: 9, color: colors.mutedForeground },
  arm: { fontFamily: fonts.sansMedium, fontSize: 8, color: colors.gold },
  pressed: { opacity: 0.75 },
});