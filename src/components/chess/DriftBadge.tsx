'use client';

/**
 * DriftBadge — the "you are off the line now" indicator.
 *
 * Drift mode lets you step off the recorded line and try your own idea, which
 * is valuable practice but confusing without feedback: the board simply stops
 * matching anything you memorised. This badge is what makes that legible, so it
 * is designed to be noticed rather than to blend in:
 *
 *  • IN LINE   — quiet, muted, low contrast. It is the resting state and should
 *                not compete with the board.
 *  • OFF LINE  — amber, filled, with a ply marker, so the change is obvious at
 *                a glance from across the board.
 *
 * Kept as a shared component so Openings and Analysis use the identical visual
 * language — a badge that meant something different per screen would be worse
 * than none.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts, themedStyles } from '@/theme/tokens';
import { IconNavigation } from '@/components/ui/Icons';
import type { DriftState } from '@/lib/drift';

interface Props {
  state: DriftState;
  /** Show the one-line explanation beneath. Off in tight rows. */
  detail?: boolean;
  /** Hide entirely while still on book (for screens with no room). */
  hideWhenInBook?: boolean;
}

export function DriftBadge({ state, detail = false, hideWhenInBook = false }: Props) {
  if (!state.drifting && hideWhenInBook) return null;

  const off = state.drifting;

  return (
    <View style={detail ? s.wrapDetail : undefined}>
      <View style={[s.badge, off ? s.badgeOff : s.badgeOn]}>
        <IconNavigation
          size={10}
          color={off ? '#ffcf7a' : colors.mutedForeground}
        />
        <Text style={[s.label, off ? s.labelOff : s.labelOn]}>
          {off ? 'OFF LINE' : 'IN LINE'}
        </Text>
        {off && state.driftPly !== null ? (
          <Text style={s.plyText}>move {Math.floor(state.driftPly / 2) + 1}</Text>
        ) : null}
      </View>
      {detail && off ? (
        <Text style={s.detailText}>
          {state.bookMove && state.playedMove
            ? (state.bookMove === state.playedMove
              // They played the booked move but are exploring from a position the
              // repertoire does not cover, so "instead of X" would read as nonsense.
              ? 'The engine is answering your idea — this position is past your repertoire.'
              : `You played ${state.playedMove} instead of your ${state.bookMove} — the engine is answering your idea.`)
            : 'You have left your repertoire — the engine is answering your idea.'}
        </Text>
      ) : null}
    </View>
  );
}

const s = themedStyles(() => ({
  wrapDetail: { gap: 5 },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeOn: {
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  badgeOff: {
    borderColor: '#c9922e',
    backgroundColor: 'rgba(212,175,55,0.18)',
  },

  label: {
    fontSize: 10,
    letterSpacing: 0.6,
    fontFamily: fonts.sansSemiBold,
  },
  labelOn: { color: colors.mutedForeground },
  labelOff: { color: '#ffcf7a' },

  plyText: {
    fontSize: 10,
    color: '#d9b76a',
    fontFamily: fonts.sans,
  },

  detailText: {
    fontSize: 11,
    lineHeight: 15,
    color: colors.mutedForeground,
    fontFamily: fonts.sans,
  },
}));
