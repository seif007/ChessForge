'use client';

/**
 * Small circular classification badge drawn as inline SVG so it can be embedded
 * in the move list, report cards and directly on board squares.
 *
 * React Native port of `components/chess/QualityBadge.tsx` — the SVG maps 1:1.
 */

import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import { ACTIVE_KINDS, QUALITY_META, type QualityKind } from '@/lib/moveQuality';
import { colors, fonts, themedStyles } from '@/theme/tokens';

export function QualityBadge({
  kind,
  size = 16,
  fill,
  style,
}: {
  kind: QualityKind;
  size?: number;
  /**
   * Fill whatever box the parent gives this badge, instead of being a fixed number of pixels.
   *
   * THE REPORT: *"the mark of the move is not on the piece"*.
   *
   * The board puts an overlay in the bottom-right corner of the destination square in a box
   * 34% of that square's size, and the review screen was handing it a hardcoded 34-PIXEL badge.
   * On a phone a square is about 45px, so the box was roughly 15px and the badge more than
   * twice its size: anchored to the corner it overflowed inwards, sat too low and too small to
   * read, and read as "the mark is not on the piece". The badge cannot know the square's size,
   * and the board will not measure one for it, so the badge is told to fill the box it is given
   * and the board stays the single source of truth for geometry.
   */
  fill?: boolean;
  style?: object;
}) {
  const meta = QUALITY_META[kind];
  // With a viewBox of 24, the glyph size is a fraction of the badge regardless of how it is
  // sized, so one number works for both modes.
  const fs = fill ? 11 : (size >= 15 ? size * 0.46 : size * 0.52);
  return (
    <Svg
      width={fill ? '100%' : size}
      height={fill ? '100%' : size}
      viewBox="0 0 24 24"
      accessibilityLabel={meta.name}
      style={style}
    >
      <Circle cx="12" cy="12" r="11" fill={meta.color} stroke={colors.scrim} strokeWidth="1" />
      <SvgText
        x="12"
        y="13.2"
        textAnchor="middle"
        alignmentBaseline="central"
        fill="#fff"
        fontSize={fs}
        fontWeight="800"
      >
        {meta.glyph}
      </SvgText>
    </Svg>
  );
}

export function QualityLegend() {
  // `ACTIVE_KINDS`, not `QUALITY_ORDER`: the legend is the app's vocabulary, and the four
  // retired labels must not be advertised as verdicts the app can still hand out.
  return (
    <View style={styles.legend}>
      {ACTIVE_KINDS.map((k) => (
        <View key={k} style={styles.legendItem}>
          <QualityBadge kind={k} size={13} />
          <Text allowFontScaling={false} style={styles.legendText}>
            {QUALITY_META[k].name}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = themedStyles(() => ({
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 6,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendText: {
    fontSize: 10,
    color: colors.mutedForeground,
  },
}));
