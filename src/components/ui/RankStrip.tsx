'use client';

/**
 * The user's RANK in an opening — "from novice to pro like in chessforge chess".
 *
 * The request, twice and for two different screens: *"i want you to show to me in
 * each opening my advancement (from novice to pro like in chessforge chess) in 'your
 * openings' and in the normal openings of the app"*.
 *
 * It is a COMPONENT rather than markup pasted into two screens because the whole
 * failure mode of that request is the two drifting apart: a rank shown on the
 * Openings tab and a different number inside "Your openings" would be worse than
 * showing neither, because the user would have no way to tell which to believe.
 * One component, one set of props, both screens.
 *
 * WHAT IT SHOWS, AND WHY
 * ----------------------
 *   - the rank reached (`Ember`, `Flame`, …) and the next one, because a
 *     rank with nothing to aim at is just a label;
 *   - a bar over studies started, which is the honest measure of coverage;
 *   - the mastered count, which is the one that means "you know this".
 *
 * `Not started` is deliberately a different state from `Spark`: a fresh account
 * must not be told it is at the first rank over something it has never opened.
 */

import React from 'react';
import { View, Text } from 'react-native';
import { Bar } from '@/components/ui/Primitives';
import { colors, fonts, themedStyles } from '@/theme/tokens';

export function RankStrip({
  label,
  next,
  pct,
  started,
  mastered,
  total,
  ownPractised = 0,
  compact = false,
}: {
  label: string;
  next: string | null;
  pct: number;
  started: number;
  mastered: number;
  total: number;
  /**
   * Positions practised in "Your openings" for this opening.
   *
   * Shown SEPARATELY from `started`, not added to it. A study and a position are not
   * the same unit, so one ratio over both would mean nothing — and a rank that moved
   * for no visible reason would be worse than one that never moved, because the user
   * would have no way to tell which number to believe.
   *
   * It was added to the RANK (the level), which is a claim about skill rather than a
   * ratio, and that is where the two kinds of practice legitimately combine.
   */
  ownPractised?: number;
  /** The one-line form, for a list card where vertical space is tight. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <View style={s.compactRow}>
        <Text style={[s.rankText, { color: started > 0 ? colors.gold : colors.mutedForeground }]}>
          {label}
        </Text>
        {next ? <Text style={s.nextText}>→ {next}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={s.countText}>{started}/{total} studies{mastered > 0 ? ` · ${mastered} mastered` : ''}</Text>
      </View>
    );
  }
  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Text style={[s.rankText, { color: started > 0 ? colors.gold : colors.mutedForeground }]}>
          {label}
        </Text>
        {next ? <Text style={s.nextText}>next: {next}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={s.countText}>
          {started}/{total} studies{mastered > 0 ? ` · ${mastered} mastered` : ''}
          {ownPractised ? ` · ${ownPractised} yours` : ''}
        </Text>
      </View>
      <Bar pct={pct} color={colors.gold} height={5} style={{ marginTop: 6 }} />
    </View>
  );
}

const s = themedStyles(() => ({
  wrap: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(212,175,55,0.06)',
    marginTop: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rankText: { fontSize: 13, fontWeight: '700', fontFamily: fonts.sansBold },
  nextText: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },
  countText: { fontSize: 10, color: colors.mutedForeground, fontFamily: fonts.sans },
}));
