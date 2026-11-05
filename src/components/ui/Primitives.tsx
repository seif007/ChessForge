'use client';

/**
 * Shared RN primitives used by every ported screen: Card, buttons, progress
 * bars, chips, segmented control and a spacer. These stand in for the web
 * app's Tailwind utility classes (`card`, `rounded-xl bg-primary`, `bg-white/5`
 * …) so the screens read close to the web version without a styling engine.
 */

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Easing,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { colors, fonts, radii, themedStyles } from '@/theme/tokens';

/* --------------------------------------------------------------------- card */

export function Card({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return <View style={[ui.card, style]}>{children}</View>;
}

/* ------------------------------------------------------------------ buttons */

type BtnVariant = 'primary' | 'gold' | 'ghost' | 'danger' | 'sky';

const BTN_BG: Record<BtnVariant, string> = {
  primary: colors.primary,
  gold: 'rgba(212,175,55,0.16)',
  ghost: 'transparent',
  danger: '#e04545',
  sky: '#3b9ee0',
};

export function Btn({
  label,
  onPress,
  variant = 'primary',
  disabled,
  small,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: BtnVariant;
  disabled?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const outline = variant === 'gold' || variant === 'ghost';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        ui.btn,
        small ? ui.btnSmall : null,
        { backgroundColor: BTN_BG[variant] },
        variant === 'gold' && { borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)' },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.border },
        disabled ? { opacity: 0.4 } : null,
        pressed && !disabled ? { opacity: 0.85 } : null,
        style,
      ]}
    >
      <Text
        allowFontScaling={false}
        style={[
          ui.btnText,
          small ? ui.btnTextSmall : null,
          variant === 'gold' ? { color: colors.gold } : null,
          variant === 'ghost' ? { color: colors.foreground } : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Icon-only square button (the web's small `p-2 rounded-lg hover:bg-white/5`). */
export function IconBtn({
  onPress,
  disabled,
  style,
  children,
  label,
}: {
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={({ pressed }) => [
        ui.iconBtn,
        disabled ? { opacity: 0.35 } : null,
        pressed && !disabled ? { backgroundColor: colors.subtleFill } : null,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ metrics */

export function Bar({
  pct,
  color,
  height = 6,
  trackColor,
  indeterminate = false,
  style,
}: {
  /** 0..1 */
  pct: number;
  color?: string;
  height?: number;
  trackColor?: string;
  /**
   * True when the work CANNOT say how far along it is — an engine booting, a
   * body being read before the first line arrives, a mining pass over an
   * unknown amount of work. The fill is replaced by a band sliding across the
   * track, so a phase with no percentage reads as running instead of as a bar
   * that has stopped five percent in.
   */
  indeterminate?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = color ?? colors.primary;
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!indeterminate) return;
    const loop = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        // `left` is a layout prop, so the JS driver is required here.
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      slide.setValue(0);
    };
  }, [indeterminate, slide]);

  return (
    <View
      style={[
        {
          height,
          borderRadius: 999,
          backgroundColor: trackColor ?? colors.subtleFillStrong,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {indeterminate ? (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: '38%',
            borderRadius: 999,
            backgroundColor: c,
            left: slide.interpolate({ inputRange: [0, 1], outputRange: ['-38%', '100%'] }),
          }}
        />
      ) : (
        <View
          style={{
            height: '100%',
            width: `${Math.max(0, Math.min(100, pct * 100))}%`,
            borderRadius: 999,
            backgroundColor: c,
          }}
        />
      )}
    </View>
  );
}

export function Chip({
  text,
  color,
  bg,
  border,
  style,
  textStyle,
}: {
  text: string;
  color?: string;
  bg?: string;
  border?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View
      style={[
        {
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 999,
          backgroundColor: bg ?? colors.subtleFill,
          borderWidth: 1,
          borderColor: border ?? colors.border,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text
        allowFontScaling={false}
        style={[{ fontSize: 10, color: color ?? colors.mutedForeground }, textStyle]}
      >
        {text}
      </Text>
    </View>
  );
}

/* --------------------------------------------------------- segmented control */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[ui.segmentWrap, style]}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <Pressable key={o.id} onPress={() => onChange(o.id)} style={[ui.segment, active ? ui.segmentActive : null]}>
            <Text allowFontScaling={false} style={[ui.segmentText, active ? ui.segmentTextActive : null]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ loading */

export function Spinner({ size = 22 }: { size?: number }) {
  return <ActivityIndicator size={size} color={colors.gold} />;
}

/* -------------------------------------------------------------------- styles */

export const ui = themedStyles(() => ({
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },

  btn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.lg,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 10 },
  btnText: {
    fontFamily: fonts.sansSemiBold,
    fontSize: 14,
    color: colors.primaryForeground,
  },
  btnTextSmall: { fontSize: 12 },

  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    padding: 8,
  },

  segmentWrap: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: 4,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radii.md },
  segmentActive: { backgroundColor: 'rgba(212,175,55,0.15)' },
  segmentText: { fontFamily: fonts.sansSemiBold, fontSize: 12, color: colors.mutedForeground },
  segmentTextActive: { color: colors.gold },

  h1: { fontFamily: fonts.sansBold, fontSize: 20, color: colors.foreground },
  h2: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
  body: { fontFamily: fonts.sans, fontSize: 12, color: colors.mutedForeground },
  bodySm: { fontFamily: fonts.sans, fontSize: 11, color: colors.mutedForeground },
  title: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.foreground },
}));
