'use client';

/**
 * The streak celebration — a small banner that appears when a scored session STARTS or EXTENDS
 * the day streak, plus the first-session ("onboarding") variant of the same moment.
 *
 * WHY A BANNER AND NOT A MODAL. This fires at the end of a session, and every session end already
 * has its own surface — Practice's line summary, Train's "All exercises solved", the puzzle
 * result card, the endgame banner. A second MODAL would fight those for the same moment and one
 * of the two would win at random (React Native shows them in mount order, not by importance).
 * The banner is deliberately non-blocking: it slides in over the top of whatever is on screen,
 * can be tapped away, and hides itself. The screens keep their summaries; the streak gets a
 * moment that is nobody else's.
 *
 * WHY IT IS RAISED BY THE STORE. `persistTrainResult` is the only place in the app that knows the
 * day streak moved (see `CelebrationEvent` in `lib/store`), so the event travels through the
 * store and this component is a pure consumer — no screen has to remember to celebrate, and no
 * screen can accidentally claim a streak day that did not happen.
 *
 * WHAT IT SHOWS. One moment at a time, because there is only one slot. `first` is the onboarding
 * beat — the very first scored session the profile ever recorded; every later streak event is a
 * new day the streak survived. `test`, `train` and `lines` are the session shapes finishing, each
 * with its own copy, so a passed test cannot read like a cleared train session. When a completion
 * lands on the same tick as the day's streak moment, the completion absorbs the day and says so on
 * its own line (`streakNote`); the day number and the pending event's XP are carried along, so
 * neither moment is silently dropped. The day number is the streak the profile is actually on and
 * the XP figure is the pending moments' own gain, so neither can overstate a summary card.
 */

import React, { useEffect, useRef } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore, type CelebrationEvent } from '@/lib/store';
import { playEffect, playTournamentWinSound } from '@/lib/sounds';
import { IconTrophy } from '@/components/ui/Icons';
import { colors, fonts } from '@/theme/tokens';

/** How long the banner stays before hiding itself. */
const HOLD_MS = 5200;

/** Capitalises the first letter of a screen-authored clause before it is woven into a sentence. */
function cap(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * THE COPY, ONE MOMENT AT A TIME.
 *
 * Each kind gets its own voice because they are different achievements: the day streak is a habit
 * beat, the completion kinds are about the work just finished. The session kinds weave in the
 * `detail` clause the screen counted (never a figure the banner invents), and fall back to a plain
 * sentence when a screen raised the moment without one.
 */
function copyFor(e: CelebrationEvent): { title: string; sub: string } {
  switch (e.kind) {
    case 'first':
      return {
        title: 'First session done!',
        sub: 'Your streak has begun — come back tomorrow to keep it alive.',
      };
    case 'streak':
      return {
        title: `Day ${e.streakDays} streak`,
        sub: 'A new day, a new session — the streak is alive.',
      };
    case 'test':
      return {
        title: 'Test complete!',
        sub: e.detail ? `${cap(e.detail)}.` : 'Every position in the test answered.',
      };
    case 'train':
      return {
        title: 'Training done!',
        sub: e.detail ? `${cap(e.detail)} — the session is cleared.` : 'Every exercise in the session is solved.',
      };
    case 'lines':
      return {
        title: 'Lines complete!',
        sub: e.detail ? `${cap(e.detail)} trained start to finish.` : 'The lines are trained start to finish.',
      };
    case 'gamewin':
      return {
        title: 'Game won!',
        sub: e.detail ? `${cap(e.detail)}` : 'A win on the board — well played.',
      };
    case 'champion':
      return {
        title: 'Tournament won!',
        sub: e.detail ? `${cap(e.detail)}` : 'You finished top of the standings.',
      };
  }
}

export function CelebrationBanner() {
  const celebration = useAppStore((s) => s.celebration);
  const clear = useAppStore((s) => s.clearCelebration);
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!celebration) return;
    /*
     * A SOUND PER MOMENT. Winning a tournament gets the long fanfare; the rest
     * keep the short success chime. A game win does NOT add a second sting —
     * the board already played the game's ending sound, and two would read as a
     * glitch rather than a celebration.
     */
    if (celebration.kind === 'champion') playTournamentWinSound();
    else if (celebration.kind !== 'gamewin') playEffect('success');
    anim.setValue(0);
    Animated.spring(anim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 6,
      tension: 90,
    }).start();
    const timer = setTimeout(() => clear(), HOLD_MS);
    return () => clearTimeout(timer);
  }, [celebration, clear, anim]);

  if (!celebration) return null;

  const { title, sub } = copyFor(celebration);
  return (
    <View style={[styles.wrap, { top: insets.top + 10 }]} pointerEvents="box-none">
      <Pressable onPress={clear} accessibilityRole="button" accessibilityLabel="Dismiss">
        <Animated.View
          style={[
            styles.card,
            {
              opacity: anim,
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) },
                { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
              ],
            },
          ]}
        >
          <View style={styles.iconWrap}>
            <IconTrophy size={16} color={colors.gold} />
          </View>
          <View style={styles.textWrap}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.sub}>{sub}</Text>
            {celebration.streakNote ? (
              <Text style={styles.streakNote}>Day {celebration.streakDays} streak — kept alive.</Text>
            ) : null}
          </View>
          {celebration.xp > 0 ? <Text style={styles.xp}>+{celebration.xp} XP</Text> : null}
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Non-blocking by construction: the wrapper takes no touches, only the card does.
  wrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 50,
    elevation: 8,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 460,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.gold,
    backgroundColor: colors.card,
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.secondary,
  },
  textWrap: { flex: 1, gap: 1 },
  title: { color: colors.foreground, fontFamily: fonts.sansSemiBold, fontSize: 13 },
  sub: { color: colors.mutedForeground, fontFamily: fonts.sans, fontSize: 11, lineHeight: 15 },
  streakNote: { color: colors.gold, fontFamily: fonts.sansMedium, fontSize: 11, lineHeight: 15 },
  xp: { color: colors.gold, fontFamily: fonts.sansSemiBold, fontSize: 12 },
});

/** Exported for gates: the hide delay is part of the behaviour, not an internal detail. */
export const CELEBRATION_HOLD_MS = HOLD_MS;
