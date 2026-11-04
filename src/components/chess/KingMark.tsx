'use client';

import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '@/theme/tokens';

/**
 * THE MARK ON A KING WHEN THE GAME IS OVER — the winner wears a crown, the loser a cross.
 *
 * THE REPORT: *"when the game is over i want you to show which one win and wich one lose
 * (add something to the king piece indicating win or lose)"*.
 *
 * Drawn as one inline SVG, exactly like `QualityBadge`, and for the same reason: the board puts
 * an overlay in a box that is a FRACTION of a square's size, so the badge fills whatever box the
 * board gives it and the board stays the single source of truth for geometry.
 *
 * Colour: the badge's own circle carries the verdict (`gold` for the win, `bad` for the loss) and
 * the glyph is drawn in `background`, which inverts naturally per theme — dark glyph on the light
 * theme's deep gold, light glyph on the dark theme's bright gold. The X is always white on red.
 */
export function KingMark({ kind }: { kind: 'win' | 'loss' }) {
  const win = kind === 'win';
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      accessibilityLabel={win ? 'This king won the game' : 'This king lost the game'}
    >
      <Circle
        cx="12"
        cy="12"
        r="11"
        fill={win ? colors.gold : colors.bad}
        stroke={colors.scrim}
        strokeWidth="1"
      />
      {win ? (
        <>
          <Path d="M6.5 17.5h11" stroke={colors.background} strokeWidth="1.8" strokeLinecap="round" />
          <Path d="M5.5 9 8.4 14.6h7.2L18.5 9l-3.1 1.5L12 6.2 8.6 10.5z" fill={colors.background} />
        </>
      ) : (
        <Path
          d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"
          stroke="#fff"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      )}
    </Svg>
  );
}
