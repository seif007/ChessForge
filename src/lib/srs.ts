/**
 * Lightweight spaced-repetition scheduler (SM-2 inspired) for opening positions.
 * Mastery 0..1 per position; intervals: 0 (same session), 1d, 3d, 7d, 14d, 30d, 60d.
 */

export const INTERVALS_DAYS = [0, 1, 3, 7, 14, 30, 60];

export interface PositionSrsState {
  asked: number;
  correct: number;
  streak: number;
  mastery: number; // 0..1
  dueAt: string | null; // ISO
}

export function newPosSrs(): PositionSrsState {
  return { asked: 0, correct: 0, streak: 0, mastery: 0, dueAt: null };
}

/** Record an answer for a position. Returns updated state. */
export function recordAnswer(s: PositionSrsState, correct: boolean, now = new Date()): PositionSrsState {
  const streak = correct ? s.streak + 1 : 0;
  const intervalIdx = Math.min(streak, INTERVALS_DAYS.length - 1);
  const days = correct ? INTERVALS_DAYS[intervalIdx] : 0;
  const dueAt = new Date(now.getTime() + days * 24 * 3600 * 1000);
  // mastery: exponential moving average — correct streaks push toward 1
  const mastery = correct
    ? Math.min(1, s.mastery + Math.max(0.08, (1 - s.mastery) * 0.25))
    : Math.max(0, s.mastery * 0.4);
  return {
    asked: s.asked + 1,
    correct: s.correct + (correct ? 1 : 0),
    streak,
    mastery,
    dueAt: dueAt.toISOString(),
  };
}

export function isDue(s: PositionSrsState, now = new Date()): boolean {
  if (!s.dueAt) return true;
  return new Date(s.dueAt).getTime() <= now.getTime();
}

export function intervalLabel(s: PositionSrsState): string {
  if (!s.dueAt) return 'new';
  const days = Math.max(0, Math.round((new Date(s.dueAt).getTime() - Date.now()) / 86400000));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Deterministic level ladder from study mastery (Spark → Crucible). Shared client + server. */
export function unlockByMastery(m: number): number {
  if (m >= 0.9) return 6;
  if (m >= 0.75) return 5;
  if (m >= 0.55) return 4;
  if (m >= 0.35) return 3;
  if (m >= 0.15) return 2;
  return 1;
}
