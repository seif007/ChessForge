'use client';

/**
 * Client state store (zustand) — SQLite-backed port of the web `lib/store.ts`.
 *
 * The web version loaded from `/api/state` and POSTed to `/api/train`. Both are
 * gone: this file talks to the local SQLite database directly and now owns the
 * server-side logic that used to live in `src/app/api/train/route.ts`
 * (profile/XP/streak, study upsert, per-position SRS, puzzle & endgame stats,
 * training-session rows).
 *
 * IMPORTANT: the public interface is deliberately IDENTICAL to the web store —
 * same `AppState` shape, same `load()`, same `applyResult(payload)`, same
 * `TrainPayload` — so every ported screen consumes it unchanged.
 */

import { create } from 'zustand';
import { unlockByMastery, INTERVALS_DAYS } from '@/lib/srs';
import { loadActiveUsername } from '@/lib/lichessStore';
import {
  getDatabase,
  ensureProfile,
  newId,
  todayString,
  daysAgoString,
  SOLO,
} from '@/lib/db';

export { unlockByMastery };

/**
 * The account whose progress this store is showing.
 *
 * Training progress is per Lichess account (see the v4 migration in db.ts). The
 * store keeps the active name here so every read and write is scoped without
 * each screen passing it around. Empty means "no account connected" — the
 * legacy single-user pool.
 */
let activeAccount = '';
const accountId = (): string => activeAccount || SOLO;

/**
 * ADOPT PRE-v4 PROGRESS FOR THE FIRST ACCOUNT THAT LOADS.
 *
 * The migration copied old rows with `account = ''`. Claiming them once means a
 * user who was already training keeps their work under their current account,
 * while any later account starts genuinely fresh.
 */
async function claimLegacyProgress(db: Awaited<ReturnType<typeof getDatabase>>): Promise<void> {
  if (!activeAccount) return;
  await db.runAsync(`UPDATE StudyProgress SET account = ? WHERE account = ''`, activeAccount);
  await db.runAsync(`UPDATE PositionStat SET account = ? WHERE account = ''`, activeAccount);
  await db.runAsync(`UPDATE PuzzleStat SET account = ? WHERE account = ''`, activeAccount);
  await db.runAsync(`UPDATE EndgameProgress SET account = ? WHERE account = ''`, activeAccount);
  try {
    await db.runAsync('UPDATE Profile SET id = ? WHERE id = ?', accountId(), SOLO);
  } catch {
    // An account profile already exists; the legacy row is simply left behind.
  }
}

export interface ProfileState {
  xp: number;
  streakDays: number;
  lastActiveDate: string | null;
  puzzleRating: number;
  /** Separate Elo for the endgame trainer, so its difficulty follows results
   *  independently of puzzle form. */
  endgameRating: number;
}

export interface StudyProg {
  studyId: string;
  mastery: number;
  attempts: number;
  perfectRuns: number;
  bestStreak: number;
  level: number;
  dueAt: string | null;
  lastTrained: string | null;
}

export interface PositionProg {
  key: string;
  asked: number;
  correct: number;
  streak: number;
  mastery: number;
  dueAt: string | null;
}

export interface AppState {
  profile: ProfileState;
  studies: Record<string, StudyProg>;
  positions: Record<string, PositionProg>;
  puzzles: Record<string, { solved: boolean; attempts: number }>;
  endgames: Record<string, { completed: boolean; attempts: number }>;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  /**
   * Re-read progress for whichever account is now active.
   *
   * Called after a Lichess account is connected or switched, so the training
   * rings, rank and solved counts swap to that account instead of staying on
   * the previous one's numbers.
   */
  reloadForAccount: () => Promise<void>;
  applyResult: (payload: TrainPayload) => void;
  /**
   * Move position progress without running a Train session. See the implementation for why the
   * rings in "Your openings" could not move without it.
   */
  recordPositions: (rows: { key: string; correct: boolean; studyId?: string }[]) => void;
  reset: () => Promise<void>;
  /** Record one analyzed game (replaces POST /api/stats/game). */
  saveGameStat: (row: GameStatRow) => Promise<void>;
  /** Bump a puzzle's `seenAt` so it is not served twice (replaces the API side-effect). */
  markPuzzleSeen: (puzzleId: string) => Promise<void>;
  /**
   * The one-shot celebration raised by the last scored event, waiting to be shown.
   *
   * Set by `persistTrainResult` ONLY when the event started or extended the day streak — an
   * ordinary training result raises nothing — and consumed by `CelebrationBanner`, which calls
   * `clearCelebration` once it has been shown or dismissed.
   */
  celebration: CelebrationEvent | null;
  clearCelebration: () => void;
  /**
   * A session SHAPE finished — a line test passed, a train session cleared, every line of a
   * practice session trained. See `CelebrationEvent`; raised by the screens that finish them.
   */
  completeSession: (kind: SessionCelebrationKind, detail?: string, xp?: number) => void;
  /**
   * A game or a tournament was WON. Raised by the board and the tournament
   * screen; shares the banner's one slot with the session moments.
   */
  celebrate: (kind: GlobalCelebrationKind, detail?: string) => void;
}

export interface TrainPayload {
  type: 'opening' | 'puzzle' | 'endgame' | 'analysis';
  xp: number;
  correct: number;
  total: number;
  studyId?: string;
  study?: Partial<StudyProg> & { studyId: string };
  positions?: { key: string; studyId?: string; correct: boolean }[];
  puzzle?: { puzzleId: string; solved: boolean; ratingDelta: number };
  endgame?: { lessonId: string; completed: boolean; bestMoves?: number; ratingDelta?: number };
}

/**
 * What the celebration banner shows — the day's streak, and the shapes a session can finish.
 *
 * The loop this closes: the profile has always counted a day streak, but nothing in the app ever
 * SAID so. A user who trained today saw a small number on Home change and nothing else — no
 * moment, no acknowledgement, no reason to come back tomorrow. This event is that moment, raised
 * by the one place that knows the streak moved (`persistTrainResult`), and it is capped at once
 * per day by the same test the streak maths itself uses.
 *
 * `test`, `train` and `lines` close the second half: finishing the line test, the last exercise
 * of a train session, or every line of a practice session are each a moment in their own right,
 * and each is raised by the screen that finished it through `completeSession` — never by a screen
 * hand-rolling its own banner.
 */
export type SessionCelebrationKind = 'test' | 'train' | 'lines';

/**
 * Victories, as opposed to sessions.
 *
 * `gamewin` is a win on the board; `champion` is a tournament won outright or
 * shared. They share the banner's slot with the session kinds, so one banner is
 * ever on screen, and the banner gives each its own voice and sound.
 */
export type GlobalCelebrationKind = 'gamewin' | 'champion';

export interface CelebrationEvent {
  /**
   * `first` is the very first scored session the profile has ever recorded — the onboarding one;
   * `streak` is a later day whose streak survived; the session kinds are the completions above.
   */
  kind: 'first' | 'streak' | SessionCelebrationKind | GlobalCelebrationKind;
  /** The streak day the profile is on when the event fires (1 on the first session of all). */
  streakDays: number;
  /**
   * XP earned by the pending moment(s) this banner is the first to report, so the figure can
   * never overstate a session total and a pending event's gain is never silently dropped.
   */
  xp: number;
  /** Monotonic token, so a later event re-animates the banner rather than reusing the old one. */
  n: number;
  /** A short screen-authored clause the session copy weaves in, e.g. "8 exercises solved". */
  detail?: string;
  /** True when this event absorbed the day's pending streak moment — the banner then says so. */
  streakNote?: boolean;
}

/** The three "we finished something" moments, as opposed to the two day-streak ones. */
const isSessionKind = (k: CelebrationEvent['kind']): k is SessionCelebrationKind =>
  k === 'test' || k === 'train' || k === 'lines';

export interface GameStatRow {
  date: string;
  openingKey: string;
  openingLine: string;
  color: 'w' | 'b';
  result: 'win' | 'loss' | 'draw' | 'unknown';
  accuracy: number;
  opponentAccuracy: number;
  plies: number;
  brilliant: number;
  great: number;
  bestCount: number;
  excellent: number;
  good: number;
  book: number;
  inaccuracy: number;
  miss: number;
  mistake: number;
  blunder: number;
  deviationPly: number | null;
  deviationMove: string | null;
}

/* ------------------------------------------------------------------ */
/* Row types as stored in SQLite (Dates are ISO strings, bools are 0/1) */
/* ------------------------------------------------------------------ */

interface ProfileRow {
  id: string;
  xp: number;
  streakDays: number;
  lastActiveDate: string | null;
  puzzleRating: number;
  endgameRating: number;
}

interface StudyRow {
  studyId: string;
  mastery: number;
  attempts: number;
  perfectRuns: number;
  bestStreak: number;
  level: number;
  dueAt: string | null;
  lastTrained: string | null;
}

interface PositionRow {
  key: string;
  asked: number;
  correct: number;
  streak: number;
  mastery: number;
  dueAt: string | null;
}

interface PuzzleRow {
  puzzleId: string;
  solved: number;
  attempts: number;
}

interface EndgameRow {
  lessonId: string;
  completed: number;
  attempts: number;
}

export const useAppStore = create<AppState>((set, get) => ({
  profile: { xp: 0, streakDays: 0, lastActiveDate: null, puzzleRating: 800, endgameRating: 800 },
  studies: {},
  positions: {},
  puzzles: {},
  endgames: {},
  loaded: false,
  loading: false,

  celebration: null,
  clearCelebration: () => set({ celebration: null }),

  /**
   * THE COMPLETION MOMENT — the only non-streak raiser of a celebration (see `CelebrationEvent`).
   *
   * Screens call this when the shape they teach is finished; the store stays the only constructor
   * of a celebration, so the slot cannot hold two banners and nothing can schedule one behind the
   * app's back. NEWEST WINS — but the day is not lost: a pending streak moment (raised by
   * `persistTrainResult`, whose write races this same session end) is absorbed into this event,
   * and its XP is summed with `xp`, because a banner the user never saw has not said anything yet.
   */
  completeSession: (kind, detail = '', xp = 0) => set((s) => {
    const prev = s.celebration;
    return {
      celebration: {
        kind,
        streakDays: prev?.streakDays ?? s.profile.streakDays,
        xp: (prev?.xp ?? 0) + xp,
        detail,
        streakNote: prev != null && !isSessionKind(prev.kind),
        n: Date.now(),
      },
    };
  }),

  /**
   * A WIN IS A MOMENT TOO.
   *
   * Deliberately not `completeSession`: that action absorbs a pending day-streak
   * moment and awards its XP, which a victory must not consume. This one just
   * takes the banner slot; the streak moment, if any, is still raised by the
   * next session and nothing is lost.
   */
  celebrate: (kind, detail = '') => set((s) => ({
    celebration: {
      kind,
      streakDays: s.profile.streakDays,
      xp: 0,
      detail,
      n: Date.now(),
    },
  })),

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      /*
       * WHOSE PROGRESS IS THIS? The active Lichess account, read fresh on every
       * load, so a switch made on another screen is picked up by the next load.
       */
      activeAccount = (await loadActiveUsername().catch(() => null)) ?? '';
      const db = await getDatabase();
      await claimLegacyProgress(db);
      await ensureProfile(db, accountId());

      const [profile, studies, positions, puzzles, endgames] = await Promise.all([
        db.getFirstAsync<ProfileRow>('SELECT * FROM Profile WHERE id = ?', accountId()),
        db.getAllAsync<StudyRow>('SELECT * FROM StudyProgress WHERE account = ?', activeAccount),
        db.getAllAsync<PositionRow>('SELECT * FROM PositionStat WHERE account = ?', activeAccount),
        db.getAllAsync<PuzzleRow>('SELECT * FROM PuzzleStat WHERE account = ?', activeAccount),
        db.getAllAsync<EndgameRow>('SELECT * FROM EndgameProgress WHERE account = ?', activeAccount),
      ]);

      set({
        profile: {
          xp: profile?.xp ?? 0,
          streakDays: profile?.streakDays ?? 0,
          lastActiveDate: profile?.lastActiveDate ?? null,
          puzzleRating: profile?.puzzleRating ?? 800,
          endgameRating: profile?.endgameRating ?? 800,
        },
        studies: Object.fromEntries(studies.map((s) => [s.studyId, s])),
        positions: Object.fromEntries(positions.map((p) => [p.key, p])),
        puzzles: Object.fromEntries(
          puzzles.map((p) => [p.puzzleId, { solved: !!p.solved, attempts: p.attempts }]),
        ),
        endgames: Object.fromEntries(
          endgames.map((e) => [e.lessonId, { completed: !!e.completed, attempts: e.attempts }]),
        ),
        loaded: true,
        loading: false,
      });
    } catch (err) {
      console.error('store.load failed', err);
      set({ loading: false, loaded: true });
    }
  },

  /**
   * Optimistic local update + synchronous-ish persistence, mirroring the web
   * store's split (optimistic `set`, then fire-and-forget write).
   */
  reloadForAccount: async () => {
    // A completed load is the lock; clearing it lets the next load re-read the
    // active username and swap every map.
    set({ loading: false, loaded: false });
    await get().load();
  },

  applyResult: (payload: TrainPayload) => {
    set((s) => {
      const profile = { ...s.profile };
      profile.xp += payload.xp || 0;
      if (payload.puzzle) {
        profile.puzzleRating = Math.max(400, profile.puzzleRating + payload.puzzle.ratingDelta);
      }
      if (payload.endgame?.ratingDelta) {
        profile.endgameRating = Math.max(400, profile.endgameRating + payload.endgame.ratingDelta);
      }

      const studies = { ...s.studies };
      if (payload.study) {
        const prev: StudyProg =
          studies[payload.study.studyId] ?? {
            studyId: payload.study.studyId,
            mastery: 0,
            attempts: 0,
            perfectRuns: 0,
            bestStreak: 0,
            level: 1,
            dueAt: null,
            lastTrained: null,
          };
        const merged: StudyProg = { ...prev, ...payload.study, studyId: payload.study.studyId };
        merged.attempts = prev.attempts + 1;
        merged.level = Math.min(
          6,
          Math.max(prev.level, payload.study.level ?? prev.level, unlockByMastery(merged.mastery)),
        );
        studies[merged.studyId] = merged;
      }

      const positions = { ...s.positions };
      for (const p of payload.positions ?? []) {
        const prev: PositionProg =
          positions[p.key] ?? { key: p.key, asked: 0, correct: 0, streak: 0, mastery: 0, dueAt: null };
        const next = mergePositionMastery(prev, p.correct);
        positions[p.key] = {
          ...prev,
          asked: prev.asked + 1,
          correct: prev.correct + (p.correct ? 1 : 0),
          streak: next.streak,
          mastery: next.mastery,
          dueAt: new Date(
            Date.now() + (p.correct ? Math.min(next.streak, 6) : 0) * 86_400_000,
          ).toISOString(),
        };
      }

      const puzzles = { ...s.puzzles };
      if (payload.puzzle) {
        const prev = puzzles[payload.puzzle.puzzleId] ?? { solved: false, attempts: 0 };
        puzzles[payload.puzzle.puzzleId] = {
          solved: prev.solved || payload.puzzle.solved,
          attempts: prev.attempts + 1,
        };
      }

      const endgames = { ...s.endgames };
      if (payload.endgame) {
        const prev = endgames[payload.endgame.lessonId] ?? { completed: false, attempts: 0 };
        endgames[payload.endgame.lessonId] = {
          completed: prev.completed || payload.endgame.completed,
          attempts: prev.attempts + 1,
        };
      }

      // streak is computed in the persistence pass below (needs the stored value)
      return { profile, studies, positions, puzzles, endgames };
    });

    void persistTrainResult(payload, set);
  },

  /**
   * RECORD PROGRESS FOR A FEW POSITIONS, WITHOUT RUNNING A TRAIN SESSION.
   *
   * WHY THIS EXISTS - the user's words: *"there is no progress shown ( always 0%)"*.
   *
   * Every ring in "Your openings" is derived from `positions[step.position.key].mastery`. The only
   * writer of `positions` was `applyResult`, which is the TRAIN path. Drilling in "Your openings"
   * wrote ADOPTIONS - the custom repertoire, which is what the trainer reads to know what to drill -
   * and nothing else. So the one place the user spends his time was the one place that could not
   * move its own rings: a line completed to the end left every ring on that line at 0%, and would
   * do so on every completion.
   *
   * Two things are deliberately NOT done here:
   *
   *   - no XP, no streak, no session. This is not a training session and must not be scored as one;
   *     `persistTrainResult` writes `Profile` as a side effect, and the drill is not that.
   *   - no study progress. A line from the user's own games is not a shipped study, so marking one
   *     "started" would inflate the study count with material the study list does not contain.
   *
   * It reuses `mergePositionMastery`, so a position moved by drilling and a position moved by
   * training land on exactly the same number. Two curves would drift, and the user's rings would
   * depend on which screen he used.
   */
  recordPositions: (rows: { key: string; correct: boolean; studyId?: string }[]) => {
    if (!rows || rows.length === 0) return;
    set((s) => {
      const positions = { ...s.positions };
      for (const r of rows) {
        if (!r?.key) continue;
        const prev: PositionProg =
          positions[r.key] ?? { key: r.key, asked: 0, correct: 0, streak: 0, mastery: 0, dueAt: null };
        const next = mergePositionMastery(prev, r.correct);
        positions[r.key] = {
          ...prev,
          asked: prev.asked + 1,
          correct: prev.correct + (r.correct ? 1 : 0),
          streak: next.streak,
          mastery: next.mastery,
          dueAt: new Date(
            Date.now() + (r.correct ? Math.min(next.streak, 6) : 0) * 86_400_000,
          ).toISOString(),
        };
      }
      return { positions };
    });
    // Persist on its own terms: `persistTrainResult` would also touch Profile, and this is not a
    // session, so the write is issued directly rather than by bending a session payload around it.
    void persistPositionRows(rows);
  },

  reset: async () => {
    const db = await getDatabase();
    await db.withTransactionAsync(async () => {
      // Only THIS account's progress: another account's training is not this
      // button's to destroy.
      await db.runAsync('DELETE FROM PositionStat WHERE account = ?', activeAccount);
      await db.runAsync('DELETE FROM StudyProgress WHERE account = ?', activeAccount);
      await db.runAsync('DELETE FROM PuzzleStat WHERE account = ?', activeAccount);
      await db.runAsync('DELETE FROM EndgameProgress WHERE account = ?', activeAccount);
      await db.runAsync('DELETE FROM TrainingSession');
      await db.runAsync('DELETE FROM GameStat');
      await db.runAsync('DELETE FROM Profile WHERE id = ?', accountId());
      await ensureProfile(db, accountId());
    });
    set({
      profile: { xp: 0, streakDays: 0, lastActiveDate: null, puzzleRating: 800, endgameRating: 800 },
      studies: {},
      positions: {},
      puzzles: {},
      endgames: {},
      celebration: null,
    });
  },

  saveGameStat: async (row: GameStatRow) => {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO GameStat (
        id, date, openingKey, openingLine, color, result, accuracy, opponentAccuracy, plies,
        brilliant, great, bestCount, excellent, good, book, inaccuracy, miss, mistake, blunder,
        deviationPly, deviationMove, createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      row.date,
      row.openingKey || 'Other',
      row.openingLine ?? '',
      row.color === 'w' ? 'w' : 'b',
      row.result,
      Math.round(row.accuracy) || 0,
      Math.round(row.opponentAccuracy) || 0,
      Math.round(row.plies) || 0,
      Math.round(row.brilliant) || 0,
      Math.round(row.great) || 0,
      Math.round(row.bestCount) || 0,
      Math.round(row.excellent) || 0,
      Math.round(row.good) || 0,
      Math.round(row.book) || 0,
      Math.round(row.inaccuracy) || 0,
      Math.round(row.miss) || 0,
      Math.round(row.mistake) || 0,
      Math.round(row.blunder) || 0,
      row.deviationPly ?? null,
      row.deviationMove ? row.deviationMove.slice(0, 12) : null,
      new Date().toISOString(),
    );
  },

  markPuzzleSeen: async (puzzleId: string) => {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO PuzzleStat (id, account, puzzleId, solved, attempts, failed, seenAt)
       VALUES (?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT(account, puzzleId) DO UPDATE SET seenAt = excluded.seenAt`,
      newId(),
      activeAccount,
      puzzleId,
      new Date().toISOString(),
    );
  },
}));

/* ------------------------------------------------------------------ */
/* Persistence — mirrors src/app/api/train/route.ts + /api/state logic  */
/* ------------------------------------------------------------------ */

/**
 * THE MASTERY CURVE. ONE COPY, USED BY EVERY WRITER.
 *
 * There were two, and they disagreed:
 *
 *   - the optimistic in-memory merge in `applyResult` did `mastery + 0.25` on a correct answer and
 *     `mastery - 0.3` on a wrong one;
 *   - the persistence pass did `mastery + max(0.08, (1 - mastery) * 0.25)` and `mastery * 0.4`.
 *
 * So the ring the user saw while drilling was computed on a different curve from the one stored, and
 * it CHANGED UNDER HIM on the next launch, when the store reloaded from SQLite. That is not
 * cosmetic: progress that moves on relaunch reads as a bug, and this project's standing complaint
 * about "Your openings" is that its progress never moves at all.
 *
 * The persisted form is the one kept, because it is the better curve - the increment shrinks as
 * mastery approaches 1, so a position cannot reach full confidence and then be re-earned by a flat
 * 0.25 every single time.
 *
 * At module scope rather than inside the store object, so the persistence helper below can use it
 * without reaching through the store it is persisting.
 */
export function mergePositionMastery(
  prev: { mastery: number; streak: number },
  correct: boolean,
): { mastery: number; streak: number } {
  return {
    mastery: correct
      ? Math.min(1, prev.mastery + Math.max(0.08, (1 - prev.mastery) * 0.25))
      : Math.max(0, prev.mastery * 0.4),
    streak: correct ? prev.streak + 1 : 0,
  };
}

/**
 * Write position rows to SQLite on their own, with no session side effects.
 *
 * Split out of `persistTrainResult` so `recordPositions` reuses the EXACT write - the same columns,
 * the same upsert, the same mastery function - rather than a second, near-identical copy that would
 * be free to drift. A position moved by drilling and a position moved by training must be
 * indistinguishable on disk, or the rings will disagree with themselves after a relaunch.
 */
async function persistPositionRows(
  rows: { key: string; correct: boolean; studyId?: string }[],
): Promise<void> {
  try {
    const db = await getDatabase();
    await ensureProfile(db, accountId());
    for (const p of rows) {
      if (!p?.key) continue;
      const prev = await db.getFirstAsync<PositionRow>(
        'SELECT * FROM PositionStat WHERE account = ? AND key = ?',
        activeAccount,
        p.key,
      );
      const next = mergePositionMastery(
        { mastery: prev?.mastery ?? 0, streak: prev?.streak ?? 0 },
        p.correct,
      );
      const days = p.correct ? INTERVALS_DAYS[Math.min(next.streak, 6)] : 0;
      const dueAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const now = new Date().toISOString();
      const fenKey = p.key.split('|')[1] || p.key;
      if (prev) {
        await db.runAsync(
          `UPDATE PositionStat
             SET asked = ?, correct = ?, streak = ?, mastery = ?, dueAt = ?, lastResult = ?, updatedAt = ?
           WHERE account = ? AND key = ?`,
          prev.asked + 1,
          prev.correct + (p.correct ? 1 : 0),
          next.streak,
          next.mastery,
          dueAt,
          p.correct ? 'correct' : 'wrong',
          now,
          activeAccount,
          p.key,
        );
      } else {
        await db.runAsync(
          `INSERT INTO PositionStat
             (id, account, key, studyId, fenKey, asked, correct, streak, mastery, lastResult, dueAt, updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId(),
          activeAccount,
          p.key,
          p.studyId || '',
          fenKey,
          1,
          p.correct ? 1 : 0,
          next.streak,
          next.mastery,
          p.correct ? 'correct' : 'wrong',
          dueAt,
          now,
        );
      }
    }
  } catch (err) {
    // A failed write degrades to "progress stays where it was". It must not throw into a move
    // handler: the user made a move, and the app's job is to answer that, not to complain about
    // storage it will retry next time.
    console.warn('store.persistPositionRows failed', err);
  }
}

async function persistTrainResult(
  payload: TrainPayload,
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
): Promise<void> {
  try {
    const db = await getDatabase();
    await ensureProfile(db, accountId());

    const stored = await db.getFirstAsync<ProfileRow>(
      'SELECT * FROM Profile WHERE id = ?',
      accountId(),
    );

    // --- profile: xp + streak ---
    const today = todayString();
    const yesterday = daysAgoString(1);
    let streakDays = stored?.streakDays ?? 0;
    if (stored?.lastActiveDate !== today) {
      streakDays = stored?.lastActiveDate === yesterday ? streakDays + 1 : 1;
    }
    const puzzleRating = payload.puzzle
      ? Math.max(400, (stored?.puzzleRating ?? 800) + (payload.puzzle.ratingDelta || 0))
      : stored?.puzzleRating ?? 800;
    const endgameRating = payload.endgame?.ratingDelta
      ? Math.max(400, (stored?.endgameRating ?? 800) + payload.endgame.ratingDelta)
      : stored?.endgameRating ?? 800;

    await db.runAsync(
      `UPDATE Profile
         SET xp = ?, streakDays = ?, lastActiveDate = ?, puzzleRating = ?, endgameRating = ?, updatedAt = ?
       WHERE id = ?`,
      (stored?.xp ?? 0) + (payload.xp || 0),
      streakDays,
      today,
      puzzleRating,
      endgameRating,
      new Date().toISOString(),
      accountId(),
    );

    /*
     * REFLECT THE AUTHORITATIVE VALUES BACK — AND RAISE THE CELEBRATION AT THE SAME MOMENT.
     *
     * This is the one place that computes the day streak, so it is the ONE place that can know an
     * event STARTED or EXTENDED it. `stored.lastActiveDate !== today` is that test, exactly as the
     * streak maths above uses it: the first scored session of a day raises one event, every later
     * session that day raises none — which is what keeps a celebration from stacking on top of the
     * session summaries the screens already show.
     *
     * A SESSION MOMENT IS NOT REPLACED BY THIS ONE. The session end that got here called
     * `completeSession` in the same breath, and this write lands after it: raising a streak banner
     * over the completion banner would swap the moment the user just earned for a day counter.
     * When the pending event is a session kind, the day is STAMPED onto it instead — same event,
     * same copy, plus the streak line it must now also say.
     *
     * `xp` is the payload's own figure, never `profile.xp`: XP is written concurrently (the
     * optimistic add in `applyResult` and this persisted add race), so the profile total is not
     * trustworthy for a single event. A stamped event keeps its own `xp` untouched for the same
     * reason — its screen already passed the same figure through `completeSession`.
     */
    const streakBumped = stored?.lastActiveDate !== today;
    set((s) => {
      const pending = s.celebration;
      const stamped: CelebrationEvent | null = pending != null && isSessionKind(pending.kind)
        ? { ...pending, streakDays, streakNote: true, n: Date.now() }
        : null;
      const raised: CelebrationEvent = {
        kind: (stored?.lastActiveDate == null ? 'first' : 'streak') as CelebrationEvent['kind'],
        streakDays,
        xp: payload.xp || 0,
        n: Date.now(),
      };
      return {
        profile: { ...s.profile, streakDays, puzzleRating, endgameRating },
        ...(streakBumped ? { celebration: stamped ?? raised } : {}),
      };
    });

    // --- study progress ---
    if (payload.study?.studyId) {
      const studyId = payload.study.studyId;
      const prev = await db.getFirstAsync<StudyRow>(
        'SELECT * FROM StudyProgress WHERE account = ? AND studyId = ?',
        activeAccount,
        studyId,
      );
      const mastery = payload.study.mastery ?? prev?.mastery ?? 0;
      const level = Math.min(
        6,
        Math.max(prev?.level ?? 1, payload.study.level ?? 1, unlockByMastery(mastery)),
      );
      const merged = {
        mastery,
        attempts: (prev?.attempts ?? 0) + 1,
        perfectRuns: (prev?.perfectRuns ?? 0) + (payload.study.perfectRuns ? 1 : 0),
        bestStreak: Math.max(prev?.bestStreak ?? 0, payload.study.bestStreak ?? 0),
        level,
        dueAt: payload.study.dueAt ? new Date(payload.study.dueAt).toISOString() : null,
        lastTrained: new Date().toISOString(),
      };

      if (prev) {
        await db.runAsync(
          `UPDATE StudyProgress
             SET mastery = ?, attempts = ?, perfectRuns = ?, bestStreak = ?, level = ?,
                 dueAt = ?, lastTrained = ?, updatedAt = ?
           WHERE account = ? AND studyId = ?`,
          merged.mastery,
          merged.attempts,
          merged.perfectRuns,
          merged.bestStreak,
          merged.level,
          merged.dueAt,
          merged.lastTrained,
          new Date().toISOString(),
          activeAccount,
          studyId,
        );
      } else {
        await db.runAsync(
          `INSERT INTO StudyProgress
             (id, account, studyId, mastery, attempts, perfectRuns, bestStreak, level, dueAt, lastTrained, updatedAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          newId(),
          activeAccount,
          studyId,
          merged.mastery,
          merged.attempts,
          merged.perfectRuns,
          merged.bestStreak,
          merged.level,
          merged.dueAt,
          merged.lastTrained,
          new Date().toISOString(),
        );
      }
    }

    // --- position stats (SRS) ---
    if (Array.isArray(payload.positions)) {
      for (const p of payload.positions) {
        if (!p?.key) continue;
        const prev = await db.getFirstAsync<PositionRow>(
          'SELECT * FROM PositionStat WHERE account = ? AND key = ?',
          activeAccount,
          p.key,
        );
        const next = mergePositionMastery(
          { mastery: prev?.mastery ?? 0, streak: prev?.streak ?? 0 },
          p.correct,
        );
        const streak = next.streak;
        const days = p.correct ? INTERVALS_DAYS[Math.min(streak, 6)] : 0;
        const dueAt = new Date(Date.now() + days * 86_400_000).toISOString();
        const mastery = next.mastery;
        const lastResult = p.correct ? 'correct' : 'wrong';
        const fenKey = p.key.split('|')[1] || p.key;
        const now = new Date().toISOString();

        if (prev) {
          await db.runAsync(
            `UPDATE PositionStat
               SET asked = ?, correct = ?, streak = ?, mastery = ?, dueAt = ?, lastResult = ?, updatedAt = ?
             WHERE account = ? AND key = ?`,
            prev.asked + 1,
            prev.correct + (p.correct ? 1 : 0),
            streak,
            mastery,
            dueAt,
            lastResult,
            now,
            activeAccount,
            p.key,
          );
        } else {
          await db.runAsync(
            `INSERT INTO PositionStat
               (id, account, key, studyId, fenKey, asked, correct, streak, mastery, lastResult, dueAt, updatedAt)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            newId(),
            activeAccount,
            p.key,
            p.studyId || '',
            fenKey,
            1,
            p.correct ? 1 : 0,
            streak,
            mastery,
            lastResult,
            dueAt,
            now,
          );
        }
      }
    }

    // --- puzzle stat ---
    if (payload.puzzle?.puzzleId) {
      const { puzzleId, solved } = payload.puzzle;
      const prev = await db.getFirstAsync<PuzzleRow>(
        'SELECT * FROM PuzzleStat WHERE account = ? AND puzzleId = ?',
        activeAccount,
        puzzleId,
      );
      const now = new Date().toISOString();
      if (prev) {
        await db.runAsync(
          `UPDATE PuzzleStat
             SET solved = ?, attempts = ?, failed = ?, lastTried = ?
           WHERE account = ? AND puzzleId = ?`,
          prev.solved || solved ? 1 : 0,
          prev.attempts + 1,
          solved ? 0 : 1,
          now,
          activeAccount,
          puzzleId,
        );
      } else {
        await db.runAsync(
          `INSERT INTO PuzzleStat (id, account, puzzleId, solved, attempts, failed, lastTried)
           VALUES (?,?,?,?,?,?,?)`,
          newId(),
          activeAccount,
          puzzleId,
          solved ? 1 : 0,
          1,
          solved ? 0 : 1,
          now,
        );
      }
    }

    // --- endgame progress ---
    if (payload.endgame?.lessonId) {
      const { lessonId, completed, bestMoves } = payload.endgame;
      const prev = await db.getFirstAsync<EndgameRow>(
        'SELECT * FROM EndgameProgress WHERE account = ? AND lessonId = ?',
        activeAccount,
        lessonId,
      );
      const now = new Date().toISOString();
      if (prev) {
        await db.runAsync(
          `UPDATE EndgameProgress
             SET completed = ?, attempts = ?, bestMoves = COALESCE(?, bestMoves), lastTried = ?
           WHERE account = ? AND lessonId = ?`,
          prev.completed || completed ? 1 : 0,
          prev.attempts + 1,
          bestMoves ?? null,
          now,
          activeAccount,
          lessonId,
        );
      } else {
        await db.runAsync(
          `INSERT INTO EndgameProgress (id, account, lessonId, completed, attempts, bestMoves, lastTried)
           VALUES (?,?,?,?,?,?,?)`,
          newId(),
          activeAccount,
          lessonId,
          completed ? 1 : 0,
          1,
          bestMoves ?? null,
          now,
        );
      }
    }

    // --- session record ---
    await db.runAsync(
      `INSERT INTO TrainingSession (id, type, xpEarned, correct, total, detail, createdAt)
       VALUES (?,?,?,?,?,?,?)`,
      newId(),
      payload.type || 'unknown',
      payload.xp || 0,
      payload.correct ?? 0,
      payload.total ?? 0,
      JSON.stringify({
        study: payload.study?.studyId,
        puzzle: payload.puzzle?.puzzleId,
        endgame: payload.endgame?.lessonId,
      }),
      new Date().toISOString(),
    );
  } catch (err) {
    console.error('persistTrainResult failed', err);
  }
}
