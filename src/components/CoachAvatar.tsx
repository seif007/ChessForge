'use client';

/**
 * The coach's avatar — a friendly mentor in a gold graduation cap, drawn as
 * inline SVG (no asset pipeline, scales cleanly, works on both themes).
 */

import Svg, { Circle, Line, Path } from 'react-native-svg';

export function CoachAvatar({ size = 40 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityLabel="Coach avatar">
      {/* brand disc */}
      <Circle cx="24" cy="24" r="22" fill="#14342a" stroke="#d4af37" strokeWidth="2" />
      {/* face */}
      <Circle cx="24" cy="26" r="9.2" fill="#f1c9a5" />
      {/* graduation cap */}
      <Path d="M11 17.5 L24 11 L37 17.5 L24 24 Z" fill="#d4af37" />
      <Path d="M15 20.5 V24 q9 4 18 0 v-3.5" fill="#c39c2c" />
      {/* tassel */}
      <Line x1="36" y1="18" x2="36" y2="23.5" stroke="#d4af37" strokeWidth="1.4" strokeLinecap="round" />
      <Circle cx="36" cy="24.5" r="1.4" fill="#d4af37" />
      {/* beard */}
      <Path d="M15.2 26 q8.8 12.5 17.6 0 v2.6 q-8.8 8.6 -17.6 0 z" fill="#6b5138" />
      {/* eyes */}
      <Circle cx="20.6" cy="25.2" r="1.15" fill="#22303a" />
      <Circle cx="27.4" cy="25.2" r="1.15" fill="#22303a" />
      {/* smile hint under the beard edge */}
      <Path d="M21.4 29.2 q2.6 1.6 5.2 0" stroke="#3a2c1d" strokeWidth="0.9" fill="none" strokeLinecap="round" />
    </Svg>
  );
}
