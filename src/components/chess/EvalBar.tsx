'use client';

/**
 * Vertical evaluation bar — React Native port of `components/chess/EvalBar.tsx`.
 *
 * The WHITE share of the bar equals lichess-style winning chances (sigmoid on
 * the white-POV centipawn eval). `flip` anchors White at the top so the USER's
 * color sits at the bottom on black-oriented boards, matching board orientation.
 *
 * The web version animated height with a CSS transition; here we use
 * LayoutAnimation for the same effect. Public API is unchanged.
 */

import { useEffect } from 'react';
import { View, Text, StyleSheet, LayoutAnimation, Platform, UIManager } from 'react-native';
import { winPercent } from '@/lib/accuracy';
import { colors, fonts, themedStyles } from '@/theme/tokens';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Kept as a re-export for callers that already import it from the bar; the
// implementation lives in `lib/accuracy` so the bar and the review cannot drift.
export { winPercent } from '@/lib/accuracy';

export function evalLabel(cp: number): string {
  if (cp >= 9700) return `#${Math.max(1, Math.round((10000 - cp) / 10))}`;
  if (cp <= -9700) return `#-${Math.max(1, Math.round((10000 + cp) / 10))}`;
  const v = cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

/**
 * Eval-bar tones. Deliberately theme-independent.
 *
 * The eval bar is a diagram of a quantity, like the board: white's share is the
 * light tone and black's the dark one, and that mapping must not invert when
 * the UI palette flips to light. Exported so the analysis screen's vertical
 * strip (a second rendering of the same value) can share them instead of
 * repeating the hex — the two had already drifted into a duplicate literal.
 */
export const EVAL_LIGHT = '#e9e7e0';
export const EVAL_DARK = '#31403a';

const LIGHT = EVAL_LIGHT;
const DARK = EVAL_DARK;

export function EvalBar({
  cp,
  flip = false,
  dim = false,
}: {
  cp: number;
  flip?: boolean;
  dim?: boolean;
}) {
  const whitePct = Math.max(3, Math.min(97, winPercent(cp)));

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [whitePct]);

  return (
    <View style={[styles.column, dim ? styles.dim : null]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              height: `${whitePct}%`,
              ...(flip ? { top: 0 } : { bottom: 0 }),
            },
          ]}
        />
      </View>
      <Text allowFontScaling={false} style={styles.label}>
        {evalLabel(cp)}
      </Text>
    </View>
  );
}

const styles = themedStyles(() => ({
  column: {
    width: 32,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  dim: { opacity: 0.5 },
  track: {
    position: 'relative',
    flex: 1,
    width: 12,
    minHeight: 0,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: DARK,
    borderWidth: 1,
    borderColor: colors.subtleFillStrong,
  },
  fill: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: LIGHT,
  },
  label: {
    marginTop: 4,
    fontSize: 9,
    fontFamily: fonts.mono,
    fontWeight: '700',
    color: colors.mutedForeground,
  },
}));
