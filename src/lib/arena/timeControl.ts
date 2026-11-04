/** Time controls and the small formatting rules shared by Arena screens. */

import type { ArenaTimeCategory, ArenaTimeControl } from './types';

export const TIME_CONTROLS: readonly ArenaTimeControl[] = [
  { id: 'bullet-1-0', label: 'Bullet 1+0', category: 'bullet', initialSeconds: 60, incrementSeconds: 0 },
  { id: 'bullet-2-1', label: 'Bullet 2+1', category: 'bullet', initialSeconds: 120, incrementSeconds: 1 },
  { id: 'blitz-3-0', label: 'Blitz 3+0', category: 'blitz', initialSeconds: 180, incrementSeconds: 0 },
  { id: 'blitz-5-3', label: 'Blitz 5+3', category: 'blitz', initialSeconds: 300, incrementSeconds: 3 },
  { id: 'rapid-10-5', label: 'Rapid 10+5', category: 'rapid', initialSeconds: 600, incrementSeconds: 5 },
  { id: 'rapid-15-10', label: 'Rapid 15+10', category: 'rapid', initialSeconds: 900, incrementSeconds: 10 },
  { id: 'classical-30-0', label: 'Classical 30+0', category: 'classical', initialSeconds: 1800, incrementSeconds: 0 },
  { id: 'classical-60-30', label: 'Classical 60+30', category: 'classical', initialSeconds: 3600, incrementSeconds: 30 },
  { id: 'untimed', label: 'Untimed', category: 'classical', initialSeconds: 0, incrementSeconds: 0, untimed: true },
] as const;

export const DEFAULT_TIME_CONTROL = TIME_CONTROLS[3];

export function timeControlById(id: string): ArenaTimeControl {
  return TIME_CONTROLS.find((t) => t.id === id) ?? DEFAULT_TIME_CONTROL;
}

export function classifyTimeControl(initialSeconds: number, incrementSeconds: number): ArenaTimeCategory {
  const estimate = initialSeconds + 40 * incrementSeconds;
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  if (estimate < 1500) return 'rapid';
  return 'classical';
}

export function customTimeControl(initialSeconds: number, incrementSeconds: number): ArenaTimeControl {
  const initial = Math.max(0, Math.round(initialSeconds));
  const inc = Math.max(0, Math.round(incrementSeconds));
  const category = classifyTimeControl(initial, inc);
  return {
    id: `custom-${initial}-${inc}`,
    label: initial > 0 ? `Custom ${formatClock(initial)}+${inc}` : 'Untimed',
    category,
    initialSeconds: initial,
    incrementSeconds: inc,
    untimed: initial <= 0,
  };
}

/** `m:ss`, or `h:mm:ss` for long classical games. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const whole = Math.ceil(safe);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function timeControlLabel(t: ArenaTimeControl): string {
  return t.untimed ? 'Untimed' : t.label;
}

/**
 * Can this time control be rated?
 *
 * YES, INCLUDING UNTIMED. The old rule ("untimed games are always unrated")
 * was the reason a user who played a rated tournament without clocks saw their
 * rating never move: the event was silently downgraded to unrated at creation
 * and again at start. An untimed game is still a game, and demanding a clock
 * before a result counts is a rule this app invented. Untimed results are
 * rated in the Classical pool.
 */
export function ratedAllowed(_t: ArenaTimeControl): boolean {
  return true;
}

export function ratingCategoryLabel(category: ArenaTimeCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}
