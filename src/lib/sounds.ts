'use client';

/**
 * ChessForge sound engine — React Native port of `lib/sounds.ts`.
 *
 * The synthesis logic is UNCHANGED: every sound is still generated procedurally
 * with WebAudio (filtered noise clicks + sine thumps), so there are no binary
 * audio assets to ship and the timbre matches the web exactly.
 *
 * What changed:
 *  - RN has no AudioContext, so synthesis runs in a hidden WebView
 *    (`SoundHost.tsx`) and we send it a one-line message per effect.
 *    This is the same trick the engine uses, and it keeps the DSP code verbatim.
 *  - `localStorage` -> `expo-sqlite/kv-store` (sync API, drop-in replacement).
 *
 * Public API is identical to the web module: `playMoveSound`, `playEffect`,
 * `isSoundOn`, `setSoundOn`.
 */

import Storage from 'expo-sqlite/kv-store';
import type { WebViewHandle } from '@/lib/engine';

export type SoundKind =
  | 'move' | 'capture' | 'castle' | 'check' | 'promote' | 'wrong' | 'success'
  | 'checkmate' | 'gamewin' | 'gamelose' | 'draw' | 'tournament' | 'fanfare';

const LS_KEY = 'chessforge.sound.v1';

/** The hidden sound WebView, registered by <SoundHost/>. */
let host: WebViewHandle | null = null;

/**
 * Cache the preference so `readPref()` can stay synchronous (the web version was
 * sync via localStorage, and callers rely on that). Hydrated by `hydrateSoundPref()`.
 */
let soundOn = true;
let hydrated = false;

export function attachSoundHost(h: WebViewHandle | null): void {
  host = h;
}

/** Load the persisted preference once at startup. */
export async function hydrateSoundPref(): Promise<void> {
  try {
    const v = await Storage.getItem(LS_KEY);
    soundOn = v !== 'off';
  } catch {
    soundOn = true;
  }
  hydrated = true;
}

export function isSoundOn(): boolean {
  return soundOn;
}

export function setSoundOn(v: boolean): void {
  soundOn = v;
  void Storage.setItem(LS_KEY, v ? 'on' : 'off').catch(() => undefined);
  if (v) play('move'); // audible confirmation when re-enabling
}

function play(kind: SoundKind): void {
  if (!soundOn) return;
  if (!host) {
    // Sound host not mounted yet (very early call) — silently skip.
    return;
  }
  try {
    host.postMessage(JSON.stringify({ cmd: 'sfx', kind }));
  } catch {
    /* host gone */
  }
}

/** Minimal structural shape of a chess.js Move — avoids importing chess.js here. */
export type MoveSoundInfo = {
  san: string;
  captured?: string | null;
  flags?: string;
};

/** Pick the right sound for a chess move and play it. */
export function playMoveSound(m: MoveSoundInfo | null | undefined): void {
  if (!m) return;
  const flags = m.flags ?? '';
  // Checkmate is its own moment: it ends the game and deserves more than the
  // check ping. Order matters — a mating capture is a checkmate, not a capture.
  if (m.san.includes('#')) play('checkmate');
  else if (flags.includes('p')) play('promote');
  else if (flags.includes('k') || flags.includes('q')) play('castle');
  else if (m.captured) play('capture');
  else if (m.san.includes('+')) play('check');
  else play('move');
}

/** How a game ended, from one player's point of view. */
export type GameEndSound = 'win' | 'loss' | 'draw';

/**
 * The end-of-game sting.
 *
 * Deliberately separate from `playMoveSound`: a game can end without a mating
 * move (resignation, agreement, timeout), and the last move of a resigned game
 * is an ordinary move that must not steal the ending's own sound.
 */
export function playGameEnd(outcome: GameEndSound): void {
  play(outcome === 'win' ? 'gamewin' : outcome === 'loss' ? 'gamelose' : 'draw');
}

/** The arrival fanfare when a tournament is entered. */
export function playTournamentSound(): void {
  play('tournament');
}

/** The bigger fanfare for winning a tournament. */
export function playTournamentWinSound(): void {
  play('fanfare');
}

/** Non-move effects. */
export function playEffect(kind: 'wrong' | 'success'): void {
  play(kind);
}

/** True once `hydrateSoundPref()` has resolved (used by the settings screen). */
export function isSoundHydrated(): boolean {
  return hydrated;
}
