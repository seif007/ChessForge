'use client';

/**
 * Hand-rolled lucide-react replacements (react-native-svg). Only the glyphs the
 * ported screens actually use are included. `strokeWidth` mirrors the web's
 * lucide default (1.8) with the tab bar's active emphasis (2.4).
 */

import React from 'react';
import Svg, { Circle, Path, Line, Polyline } from 'react-native-svg';
import { colors } from '@/theme/tokens';

export interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export type IconComponent = (p: IconProps) => React.ReactElement;

function strokeProps(p: IconProps) {
  return {
    stroke: p.color ?? colors.foreground,
    strokeWidth: p.strokeWidth ?? 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
}

function wrap(children: (s: IconProps) => React.ReactNode, viewBox = '0 0 24 24'): IconComponent {
  return (p: IconProps) => {
    const s = p.size ?? 20;
    return (
      <Svg width={s} height={s} viewBox={viewBox}>
        {children(p)}
      </Svg>
    );
  };
}

export const IconHome = wrap((p) => (
  <>
    <Path d="M3 10.5 12 3l9 7.5" {...strokeProps(p)} />
    <Path d="M5.5 9.5V20h13V9.5" {...strokeProps(p)} />
  </>
));

export const IconBookOpen = wrap((p) => (
  <>
    <Path d="M2 4.5h6.5A3.5 3.5 0 0 1 12 8v12a3 3 0 0 0-3-3H2z" {...strokeProps(p)} />
    <Path d="M22 4.5h-6.5A3.5 3.5 0 0 0 12 8v12a3 3 0 0 1 3-3h7z" {...strokeProps(p)} />
  </>
));

export const IconPuzzle = wrap((p) => (
  <Path
    d="M9.5 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3H4.5a2 2 0 1 1 0-4H6V7a1 1 0 0 1 1-1h2.5z"
    {...strokeProps(p)}
  />
));

export const IconCrown = wrap((p) => (
  <>
    <Path d="M4 18h16" {...strokeProps(p)} />
    <Path d="M5 9.5 8 15h8l3-5.5-3.2 1.6L12 6l-3.8 5.1z" {...strokeProps(p)} />
  </>
));

export const IconLineChart = wrap((p) => (
  <>
    <Path d="M3.5 16.5 9 11l3.5 3.5L20 7" {...strokeProps(p)} />
    <Path d="M15.5 7H20v4.5" {...strokeProps(p)} />
  </>
));

export const IconBarChart = wrap((p) => (
  <>
    <Path d="M4 20h16" {...strokeProps(p)} />
    <Path d="M7 20v-9" {...strokeProps(p)} />
    <Path d="M12 20V5" {...strokeProps(p)} />
    <Path d="M17 20v-6" {...strokeProps(p)} />
  </>
));

export const IconUser = wrap((p) => (
  <>
    <Circle cx={12} cy={8} r={4} {...strokeProps(p)} />
    <Path d="M4.5 21a7.5 7.5 0 0 1 15 0" {...strokeProps(p)} />
  </>
));

/**
 * The app mark: a chess knight.
 *
 * It was a four-point sparkle in a rounded box, which read as a flower rather than as chess, and the
 * Home header is the first thing on the screen. The knight is drawn on the same 24-unit grid as every
 * other icon here and stroked with the same `strokeProps`, so it is the same weight as the tab icons
 * beside it — the point of the mark is to look like part of the set, not to stand out from it.
 *
 * The profile is the two things that make a knight read as a knight at 20px: the muzzle jutting left,
 * and the mane stepped back in three notches. Everything below the collar is the standard Staunton
 * base, so it sits on the same optical line as the crown and the book next to it.
 */
export const IconKnight = wrap((p) => (
  <>
    {/* head and mane: muzzle to the left, three mane notches down the back of the neck */}
    <Path d="M6.2 17.5 4.6 14l2-1.4-1.5-2.6 2.3-1.1-.6-2.4 2.6.4.9-2.3 2.3 1.4 1.9-1.3 1.6 2.2-2.6 1.1z" {...strokeProps(p)} />
    {/* the eye, so the head has a front at 20px rather than reading as a blob */}
    <Circle cx="9.4" cy="9.6" r={0.9} {...strokeProps(p)} />
    {/* collar */}
    <Path d="M6.6 17.5h9.2l.9 2.1H5.7z" {...strokeProps(p)} />
    {/* Staunton base */}
    <Path d="M5.7 19.6h11l1.3 1.9H4.4z" {...strokeProps(p)} />
  </>
));

export const IconSparkles = wrap((p) => (
  <>
    <Path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" {...strokeProps(p)} />
    <Path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" {...strokeProps(p)} />
  </>
));

export const IconFlame = wrap((p) => (
  <Path
    d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 1.5.5 2.5 1.5 3C10 8 10.5 5 12 3z"
    {...strokeProps(p)}
  />
));

export const IconPlay = wrap((p) => <Path d="M7 4.5v15l13-7.5z" {...strokeProps(p)} />);

export const IconPause = wrap((p) => (
  <>
    <Path d="M7 4.5v15" {...strokeProps(p)} />
    <Path d="M17 4.5v15" {...strokeProps(p)} />
  </>
));

export const IconRotateCcw = wrap((p) => (
  <>
    <Path d="M3 12a9 9 0 1 0 2.6-6.3L3 8" {...strokeProps(p)} />
    <Path d="M3 3v5h5" {...strokeProps(p)} />
  </>
));

export const IconChevronRight = wrap((p) => <Path d="M9 5l7 7-7 7" {...strokeProps(p)} />);

export const IconChevronLeft = wrap((p) => <Path d="M15 5l-7 7 7 7" {...strokeProps(p)} />);

export const IconChevronDown = wrap((p) => <Path d="M5 9l7 7 7-7" {...strokeProps(p)} />);

export const IconChevronsLeft = wrap((p) => (
  <>
    <Path d="M18 5l-7 7 7 7" {...strokeProps(p)} />
    <Path d="M11 5l-7 7 7 7" {...strokeProps(p)} />
  </>
));

export const IconChevronsRight = wrap((p) => (
  <>
    <Path d="M6 5l7 7-7 7" {...strokeProps(p)} />
    <Path d="M13 5l7 7-7 7" {...strokeProps(p)} />
  </>
));

export const IconArrowLeft = wrap((p) => (
  <>
    <Path d="M19 12H5" {...strokeProps(p)} />
    <Path d="M11 6l-6 6 6 6" {...strokeProps(p)} />
  </>
));

export const IconArrowRight = wrap((p) => (
  <>
    <Path d="M5 12h14" {...strokeProps(p)} />
    <Path d="M13 6l6 6-6 6" {...strokeProps(p)} />
  </>
));

export const IconCheck = wrap((p) => <Path d="M4.5 12.5l5 5 10-11" {...strokeProps(p)} />);

export const IconCheckCircle = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Path d="M8 12.5l2.5 2.5 5-6" {...strokeProps(p)} />
  </>
));

export const IconX = wrap((p) => (
  <>
    <Path d="M6 6l12 12" {...strokeProps(p)} />
    <Path d="M18 6L6 18" {...strokeProps(p)} />
  </>
));

export const IconXCircle = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Path d="M9 9l6 6M15 9l-6 6" {...strokeProps(p)} />
  </>
));

export const IconLightbulb = wrap((p) => (
  <>
    <Path d="M9 18h6M10 21h4" {...strokeProps(p)} />
    <Path d="M12 3a6 6 0 0 0-3.5 10.9c.8.6 1.5 1.6 1.5 2.6h4c0-1 .7-2 1.5-2.6A6 6 0 0 0 12 3z" {...strokeProps(p)} />
  </>
));

/** The resign flag — a pennant on a pole. */
export const IconFlag = wrap((p) => (
  <>
    <Path d="M6 21V3.5" {...strokeProps(p)} />
    <Path d="M6 4.5h11.5l-2.8 3.4 2.8 3.4H6" {...strokeProps(p)} />
  </>
));

export const IconTrophy = wrap((p) => (
  <>
    <Path d="M8 4h8v5a4 4 0 0 1-8 0z" {...strokeProps(p)} />
    <Path d="M8 5H5a3 3 0 0 0 3 4M16 5h3a3 3 0 0 1-3 4" {...strokeProps(p)} />
    <Path d="M12 13v3M8.5 20a4 4 0 0 1 7 0" {...strokeProps(p)} />
  </>
));

export const IconDumbbell = wrap((p) => (
  <>
    <Path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11" {...strokeProps(p)} />
  </>
));

export const IconStar = wrap((p) => (
  <Path
    d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.9-5.3-2.8-5.3 2.8 1-5.9L4.5 9.7l5.9-.9z"
    {...strokeProps(p)}
  />
));

export const IconClock = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Path d="M12 7v5l3.5 2" {...strokeProps(p)} />
  </>
));

export const IconGraduationCap = wrap((p) => (
  <>
    <Path d="M2.5 9L12 4.5 21.5 9 12 13.5z" {...strokeProps(p)} />
    <Path d="M6.5 11v4c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4" {...strokeProps(p)} />
  </>
));

export const IconLock = wrap((p) => (
  <>
    <Path d="M6 10.5h12V20H6z" {...strokeProps(p)} />
    <Path d="M9 10.5V7a3 3 0 0 1 6 0v3.5" {...strokeProps(p)} />
  </>
));

export const IconEye = wrap((p) => (
  <>
    <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...strokeProps(p)} />
    <Circle cx={12} cy={12} r={3} {...strokeProps(p)} />
  </>
));

export const IconBrain = wrap((p) => (
  <Path
    d="M9.5 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1.5 5.5A3 3 0 0 0 12 20V4a3 3 0 0 0-2.5 0zM14.5 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1.5 5.5A3 3 0 0 1 12 20"
    {...strokeProps(p)}
  />
));

export const IconCompass = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Polyline points="15.5,8.5 13.5,13.5 8.5,15.5 10.5,10.5" fill="none" stroke={p.color ?? colors.foreground} strokeWidth={p.strokeWidth ?? 1.8} strokeLinejoin="round" />
  </>
));

export const IconUndo = wrap((p) => (
  <>
    <Path d="M9 14L4 9l5-5" {...strokeProps(p)} />
    <Path d="M4 9h10a6 6 0 0 1 0 12h-3" {...strokeProps(p)} />
  </>
));

export const IconSearch = wrap((p) => (
  <>
    <Circle cx={11} cy={11} r={7} {...strokeProps(p)} />
    <Path d="M16.5 16.5L21 21" {...strokeProps(p)} />
  </>
));

export const IconGlobe = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" {...strokeProps(p)} />
  </>
));

export const IconBookMarked = wrap((p) => (
  <>
    <Path d="M4 4.5h7a2 2 0 0 1 2 2V20a2.5 2.5 0 0 0-2.5-2.5H4z" {...strokeProps(p)} />
    <Path d="M20 4.5h-7 2 2 0 0 0-2 2V20a2.5 2.5 0 0 1 2.5-2.5H20z" {...strokeProps(p)} />
    <Path d="M11 4.5v6M8.5 7.5h5" {...strokeProps(p)} />
  </>
));

export const IconInfinity = wrap((p) => (
  <Path
    d="M8.5 9a3 3 0 1 0 0 6c2 0 3-1.5 3.5-3s1.5-3 3.5-3a3 3 0 1 1 0 6c-2 0-3-1.5-3.5-3s-1.5-3-3.5-3z"
    {...strokeProps(p)}
  />
));

export const IconGauge = wrap((p) => (
  <>
    <Path d="M4 14a8 8 0 1 1 16 0" {...strokeProps(p)} />
    <Path d="M12 14l4-4" {...strokeProps(p)} />
  </>
));

export const IconActivity = wrap((p) => <Path d="M3 12h4l3-8 4 16 3-8h4" {...strokeProps(p)} />);

export const IconTarget = wrap((p) => (
  <>
    <Circle cx={12} cy={12} r={9} {...strokeProps(p)} />
    <Circle cx={12} cy={12} r={5} {...strokeProps(p)} />
    <Circle cx={12} cy={12} r={1.2} fill={p.color ?? colors.foreground} stroke="none" />
  </>
));

export const IconShieldAlert = wrap((p) => (
  <>
    <Path d="M12 3l8 3v6c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9V6z" {...strokeProps(p)} />
    <Path d="M12 8.5v4.5M12 16.5v.5" {...strokeProps(p)} />
  </>
));

export const IconTrendingUp = wrap((p) => (
  <>
    <Path d="M3.5 17l6-6 3.5 3.5 7-7" {...strokeProps(p)} />
    <Path d="M14.5 7.5h6v6" {...strokeProps(p)} />
  </>
));

export const IconTrash = wrap((p) => (
  <>
    <Path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" {...strokeProps(p)} />
  </>
));

export const IconVolumeOn = wrap((p) => (
  <>
    <Path d="M4 9.5v5h3.5l5 4v-13l-5 4z" {...strokeProps(p)} />
    <Path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" {...strokeProps(p)} />
  </>
));

export const IconVolumeOff = wrap((p) => (
  <>
    <Path d="M4 9.5v5h3.5l5 4v-13l-5 4z" {...strokeProps(p)} />
    <Path d="M16 9.5l5 5M21 9.5l-5 5" {...strokeProps(p)} />
  </>
));

export const IconHourglass = wrap((p) => (
  <Path d="M7 3.5h10M7 20.5h10M8 3.5v3.5c0 2 4 3.5 4 5s-4 3-4 5v3.5M16 3.5v3.5c0 2-4 3.5-4 5s4 3 4 5v3.5" {...strokeProps(p)} />
));

export const IconSliders = wrap((p) => {
  const sp = strokeProps(p);
  return (
    <>
      <Line x1={4} y1={6} x2={20} y2={6} {...sp} />
      <Line x1={4} y1={12} x2={20} y2={12} {...sp} />
      <Line x1={4} y1={18} x2={20} y2={18} {...sp} />
      <Circle cx={9} cy={6} r={1.8} fill={colors.card} stroke={sp.stroke} strokeWidth={sp.strokeWidth} />
      <Circle cx={15} cy={12} r={1.8} fill={colors.card} stroke={sp.stroke} strokeWidth={sp.strokeWidth} />
      <Circle cx={8} cy={18} r={1.8} fill={colors.card} stroke={sp.stroke} strokeWidth={sp.strokeWidth} />
    </>
  );
});

export const IconNavigation = wrap((p) => (
  <Path d="M12 3l7 18-7-4-7 4z" {...strokeProps(p)} />
));

/* ---- appearance / theme ---- */

export const IconMoon = wrap((p) => (
  <Path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" {...strokeProps(p)} />
));

export const IconSun = wrap((p) => {
  const sp = strokeProps(p);
  return (
    <>
      <Circle cx={12} cy={12} r={4} {...sp} />
      <Path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" {...sp} />
    </>
  );
});

export const IconPalette = wrap((p) => {
  const sp = strokeProps(p);
  return (
    <>
      <Path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 2-1.8 0-1.6-2-1.7-2-3.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.4-4-6.2-9-6.2z" {...sp} />
      <Circle cx={8} cy={9.5} r={1.1} fill={sp.stroke} stroke="none" />
      <Circle cx={12} cy={7.5} r={1.1} fill={sp.stroke} stroke="none" />
      <Circle cx={16} cy={9.5} r={1.1} fill={sp.stroke} stroke="none" />
    </>
  );
});

export const IconSkipForward = wrap((p) => (
  <>
    <Path d="M5 5l9 7-9 7z" {...strokeProps(p)} />
    <Path d="M19 5v14" {...strokeProps(p)} />
  </>
));

export const IconWifiOff = wrap((p) => (
  <>
    <Path d="M3 3l18 18" {...strokeProps(p)} />
    <Path d="M5 12.5a11 11 0 0 1 3-2M9 10a11 11 0 0 1 9 .5M8 16a6 6 0 0 1 2-1.2" {...strokeProps(p)} />
    <Circle cx={12} cy={19} r={0.8} fill={p.color ?? colors.foreground} stroke="none" />
  </>
));

export const IconLoader = wrap((p) => (
  <Path d="M12 3a9 9 0 1 0 9 9" {...strokeProps(p)} />
));
