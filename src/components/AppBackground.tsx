'use client';

/**
 * App background — reproduces the web `body` background from `globals.css`:
 *
 *   background: #0a1310;
 *   background-image:
 *     radial-gradient(1200px 600px at 80% -10%, rgba(46,139,106,0.12), transparent 60%),
 *     radial-gradient(900px 500px at -10% 110%, rgba(232,143,162,0.07), transparent 55%);
 *   background-attachment: fixed;
 *
 * React Native has no radial-gradient, so we approximate each glow with a stack
 * of concentric circles at decreasing opacity (a cheap radial falloff). Two
 * layers: emerald top-right, chessforge-pink bottom-left.
 *
 * WHY THE RINGS ARE STATIC, MEMOISED AND RASTERISED
 * -------------------------------------------------
 * This is the one component that is on screen for every frame of the app, so it
 * is the one place where per-render work is paid by every screen.
 *
 * Three costs were being paid here and all three were avoidable:
 *
 *   1. The ring list was rebuilt during render (`Array.from({ length: RINGS })`
 *      inside the component), so every re-render of the shell — every tab tap,
 *      every overlay opening or closing — produced 28 new View elements and 28
 *      new inline style objects for React to reconcile. The geometry is a
 *      constant: it depends on the window size, which is fixed at module load.
 *      So it is computed once, at module scope.
 *
 *   2. The component re-rendered with the shell. There is nothing to re-render:
 *      the background has no state and, in this app, no props from the shell.
 *      `memo` makes that a fact rather than an accident.
 *
 *   3. The 28 circles are large, translucent and overlapping, so Android has to
 *      alpha-blend them on every frame that redraws the window. `renderToHardwareTextureAndroid`
 *      (and `shouldRasterizeIOS` on the other platform) composites them ONCE into
 *      a texture and then draws one opaque layer per frame. A static background
 *      is exactly the case that prop exists for; a screen transition on a
 *      low-end device is exactly the case where the difference is visible.
 *
 * The visual result is byte-for-byte the same: same geometry, same tints, same
 * falloff. Only the work moved — out of the frame and into startup.
 */

import { memo } from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, themedStyles } from '@/theme/tokens';

const { width: W, height: H } = Dimensions.get('window');

/** Number of concentric rings used to fake each radial gradient. */
const RINGS = 14;

/** One ring's geometry and colour, resolved once. */
interface Ring {
  left: number;
  top: number;
  size: number;
  color: string;
}

/**
 * Build a glow's rings. Runs at module load only — see the header for why.
 *
 * Outermost first so inner ones stack on top, with a quadratic falloff, which
 * reads closer to a real radial gradient than a linear one.
 */
function glowRings(cx: number, cy: number, radius: number, tint: string, peak: number): Ring[] {
  const centerX = cx * W;
  const centerY = cy * H;
  const rings: Ring[] = [];
  for (let i = 0; i < RINGS; i++) {
    const t = (RINGS - i) / RINGS; // 1 -> 1/RINGS
    const size = radius * t;
    const alpha = peak * Math.pow(1 - t, 1.6);
    if (alpha <= 0.001) continue;
    rings.push({
      left: centerX - size,
      top: centerY - size,
      size,
      color: tint.replace('ALPHA', alpha.toFixed(4)),
    });
  }
  return rings;
}

const EMERALD_RINGS = glowRings(0.8, -0.1, Math.max(W, H) * 0.9, 'rgba(46,139,106,ALPHA)', 0.12);
const PINK_RINGS = glowRings(-0.1, 1.1, Math.max(W, H) * 0.75, 'rgba(232,143,162,ALPHA)', 0.07);

function RadialGlow({ rings }: { rings: Ring[] }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {rings.map((r, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: r.left,
            top: r.top,
            width: r.size * 2,
            height: r.size * 2,
            borderRadius: r.size,
            backgroundColor: r.color,
          }}
        />
      ))}
    </View>
  );
}

export const AppBackground = memo(function AppBackground({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.base, style]}
      pointerEvents="none"
      // Static content: composite the ring stack once instead of blending it every frame.
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
    >
      <RadialGlow rings={EMERALD_RINGS} />
      <RadialGlow rings={PINK_RINGS} />
    </View>
  );
});

const styles = themedStyles(() => ({
  base: { backgroundColor: colors.background },
}));
