/**
 * SQLite schema for ChessForge mobile.
 *
 * Ported 1:1 from the web app's `prisma/schema.prisma`. Every Prisma model
 * becomes a table here; the shapes match exactly so the ported client code
 * (`store.ts`, stats aggregation) needs no changes to its data contracts.
 *
 * Prisma-specific notes:
 *  - `@id @default(cuid())`  -> TEXT PRIMARY KEY (ids generated in JS by `newId()`)
 *  - `DateTime`              -> TEXT (ISO 8601 strings — matches the JSON the
 *                               web API returned, so client code is unchanged)
 *  - `Boolean`               -> INTEGER (0/1)
 *  - `Float`/`Int`           -> REAL/INTEGER
 *  - fixed single-user row   -> Profile.id is always 'solo', as on the web
 */

import * as SQLite from 'expo-sqlite';

export const SOLO = 'solo';

/** Bump when the schema changes; migrations below key off this. */
export const DATABASE_VERSION = 4;

export const DATABASE_NAME = 'chessforge.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Open (once) and migrate the app database. */
export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (db) => {
      await migrate(db);
      return db;
    });
  }
  return dbPromise;
}

/**
 * Schema creation. Mirrors prisma/schema.prisma exactly, including the
 * indices Prisma declared (`@@index([rating])` on Puzzle, the three on
 * GameStat, and the unique constraints on every `@unique` field).
 */
/**
 * The GameStat table, defined once.
 *
 * Split out of `SCHEMA_V1` because the v2 -> v3 migration has to recreate the
 * table — SQLite cannot drop a NOT NULL constraint in place — and two copies of
 * this DDL would drift apart.
 *
 * `accuracy` / `opponentAccuracy` are NULLABLE on purpose. Lichess publishes no
 * per-game accuracy, and an absent value must stay distinguishable from a
 * genuine 0%. Storing 0 for "unknown" and then averaging would drag the average
 * down and look like a bug.
 */
const SCHEMA_GAMESTAT = `
CREATE TABLE IF NOT EXISTS GameStat (
  id               TEXT PRIMARY KEY NOT NULL,
  date             TEXT NOT NULL,
  openingKey       TEXT NOT NULL DEFAULT 'Other',
  openingLine      TEXT NOT NULL DEFAULT '',
  color            TEXT NOT NULL,
  result           TEXT NOT NULL,
  accuracy         REAL,
  opponentAccuracy REAL,
  plies            INTEGER NOT NULL DEFAULT 0,
  brilliant        INTEGER NOT NULL DEFAULT 0,
  great            INTEGER NOT NULL DEFAULT 0,
  bestCount        INTEGER NOT NULL DEFAULT 0,
  excellent        INTEGER NOT NULL DEFAULT 0,
  good             INTEGER NOT NULL DEFAULT 0,
  book             INTEGER NOT NULL DEFAULT 0,
  inaccuracy       INTEGER NOT NULL DEFAULT 0,
  miss             INTEGER NOT NULL DEFAULT 0,
  mistake          INTEGER NOT NULL DEFAULT 0,
  blunder          INTEGER NOT NULL DEFAULT 0,
  deviationPly     INTEGER,
  deviationMove    TEXT,
  createdAt        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS GameStat_openingKey_idx ON GameStat (openingKey);
CREATE INDEX IF NOT EXISTS GameStat_openingKey_openingLine_idx ON GameStat (openingKey, openingLine);
CREATE INDEX IF NOT EXISTS GameStat_date_idx ON GameStat (date);
`;

const SCHEMA_V1 = `
PRAGMA journal_mode = 'wal';

CREATE TABLE IF NOT EXISTS Profile (
  id             TEXT PRIMARY KEY NOT NULL,
  xp             INTEGER NOT NULL DEFAULT 0,
  streakDays     INTEGER NOT NULL DEFAULT 0,
  lastActiveDate TEXT,
  puzzleRating   INTEGER NOT NULL DEFAULT 800,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS StudyProgress (
  id          TEXT PRIMARY KEY NOT NULL,
  studyId     TEXT NOT NULL UNIQUE,
  mastery     REAL NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  perfectRuns INTEGER NOT NULL DEFAULT 0,
  bestStreak  INTEGER NOT NULL DEFAULT 0,
  level       INTEGER NOT NULL DEFAULT 1,
  dueAt       TEXT,
  lastTrained TEXT,
  updatedAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS PositionStat (
  id         TEXT PRIMARY KEY NOT NULL,
  key        TEXT NOT NULL UNIQUE,
  studyId    TEXT NOT NULL,
  fenKey     TEXT NOT NULL,
  asked      INTEGER NOT NULL DEFAULT 0,
  correct    INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  mastery    REAL NOT NULL DEFAULT 0,
  lastResult TEXT,
  dueAt      TEXT,
  updatedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS PuzzleStat (
  id        TEXT PRIMARY KEY NOT NULL,
  puzzleId  TEXT NOT NULL UNIQUE,
  solved    INTEGER NOT NULL DEFAULT 0,
  attempts  INTEGER NOT NULL DEFAULT 0,
  failed    INTEGER NOT NULL DEFAULT 0,
  lastTried TEXT,
  seenAt    TEXT
);

CREATE TABLE IF NOT EXISTS Puzzle (
  id        TEXT PRIMARY KEY NOT NULL,
  fen       TEXT NOT NULL,
  solution  TEXT NOT NULL,
  rating    INTEGER NOT NULL,
  themes    TEXT,
  source    TEXT NOT NULL DEFAULT 'pool',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS Puzzle_rating_idx ON Puzzle (rating);

CREATE TABLE IF NOT EXISTS EndgameProgress (
  id        TEXT PRIMARY KEY NOT NULL,
  lessonId  TEXT NOT NULL UNIQUE,
  completed INTEGER NOT NULL DEFAULT 0,
  attempts  INTEGER NOT NULL DEFAULT 0,
  bestMoves INTEGER,
  lastTried TEXT
);

CREATE TABLE IF NOT EXISTS TrainingSession (
  id        TEXT PRIMARY KEY NOT NULL,
  type      TEXT NOT NULL,
  xpEarned  INTEGER NOT NULL DEFAULT 0,
  correct   INTEGER NOT NULL DEFAULT 0,
  total     INTEGER NOT NULL DEFAULT 0,
  detail    TEXT,
  createdAt TEXT NOT NULL
);

${SCHEMA_GAMESTAT}`;

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;

  if (version >= DATABASE_VERSION) return;

  if (version === 0) {
    await db.execAsync(SCHEMA_V1);
    // The web app creates the single Profile row on first /api/state read.
    await ensureProfile(db);
    version = 1;
  }

  if (version === 1) {
    // v2 — endgames get their own rating, so their difficulty can follow the
    // user's results exactly as puzzles do (see src/lib/rating.ts). Guarded by
    // a column check so a half-applied migration cannot wedge the app.
    const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(Profile)');
    if (!cols.some((c) => c.name === 'endgameRating')) {
      await db.execAsync(
        'ALTER TABLE Profile ADD COLUMN endgameRating INTEGER NOT NULL DEFAULT 800',
      );
    }
    version = 2;
  }

  if (version === 2) {
    /*
     * v3 — `accuracy` / `opponentAccuracy` become NULLABLE.
     *
     * v2 declared them `NOT NULL DEFAULT 0`, which forced a "missing accuracy"
     * to be stored as 0. Averaging those zeros reported a 10% average for an
     * account whose real average was 68%: most imported games carry no accuracy
     * from the source.
     *
     * SQLite cannot drop NOT NULL in place, so the table is recreated. That is
     * safe here because GameStat holds ONLY derived data: every row is rebuilt
     * from the Lichess games we already cache locally, so nothing the user
     * typed is lost — the stats simply refetch on next open.
     */
    await db.execAsync('DROP TABLE IF EXISTS GameStat');
    await db.execAsync(SCHEMA_GAMESTAT);
    version = 3;
  }

  if (version === 3) {
    /*
     * v4 — TRAINING PROGRESS IS ACCOUNT-SCOPED.
     *
     * The study, position, puzzle and endgame tables were one global pool, so a
     * new imported username inherited the previous user's mastery rings, rank
     * and solved counts. The owner's rule: *"when i import and use new username
     * everything should be fresh for that user"*. Every table gains an `account`
     * column and its unique key becomes (account, id).
     *
     * Existing rows are copied with account = '' — "not claimed yet". On the
     * first load with an active account, the store claims them for that account
     * (`claimLegacyProgress` in store.ts), so the work of the user who was
     * already training is preserved exactly once.
     */
    await db.execAsync(`
      DROP TABLE IF EXISTS StudyProgress_v4;
      DROP TABLE IF EXISTS PositionStat_v4;
      DROP TABLE IF EXISTS PuzzleStat_v4;
      DROP TABLE IF EXISTS EndgameProgress_v4;

      CREATE TABLE StudyProgress_v4 (
        id          TEXT PRIMARY KEY NOT NULL,
        account     TEXT NOT NULL DEFAULT '',
        studyId     TEXT NOT NULL,
        mastery     REAL NOT NULL DEFAULT 0,
        attempts    INTEGER NOT NULL DEFAULT 0,
        perfectRuns INTEGER NOT NULL DEFAULT 0,
        bestStreak  INTEGER NOT NULL DEFAULT 0,
        level       INTEGER NOT NULL DEFAULT 1,
        dueAt       TEXT,
        lastTrained TEXT,
        updatedAt   TEXT NOT NULL,
        UNIQUE(account, studyId)
      );
      INSERT INTO StudyProgress_v4
        (id, account, studyId, mastery, attempts, perfectRuns, bestStreak, level, dueAt, lastTrained, updatedAt)
        SELECT id, '', studyId, mastery, attempts, perfectRuns, bestStreak, level, dueAt, lastTrained, updatedAt
        FROM StudyProgress;
      DROP TABLE StudyProgress;
      ALTER TABLE StudyProgress_v4 RENAME TO StudyProgress;

      CREATE TABLE PositionStat_v4 (
        id         TEXT PRIMARY KEY NOT NULL,
        account    TEXT NOT NULL DEFAULT '',
        key        TEXT NOT NULL,
        studyId    TEXT NOT NULL,
        fenKey     TEXT NOT NULL,
        asked      INTEGER NOT NULL DEFAULT 0,
        correct    INTEGER NOT NULL DEFAULT 0,
        streak     INTEGER NOT NULL DEFAULT 0,
        mastery    REAL NOT NULL DEFAULT 0,
        lastResult TEXT,
        dueAt      TEXT,
        updatedAt  TEXT NOT NULL,
        UNIQUE(account, key)
      );
      INSERT INTO PositionStat_v4
        (id, account, key, studyId, fenKey, asked, correct, streak, mastery, lastResult, dueAt, updatedAt)
        SELECT id, '', key, studyId, fenKey, asked, correct, streak, mastery, lastResult, dueAt, updatedAt
        FROM PositionStat;
      DROP TABLE PositionStat;
      ALTER TABLE PositionStat_v4 RENAME TO PositionStat;

      CREATE TABLE PuzzleStat_v4 (
        id        TEXT PRIMARY KEY NOT NULL,
        account   TEXT NOT NULL DEFAULT '',
        puzzleId  TEXT NOT NULL,
        solved    INTEGER NOT NULL DEFAULT 0,
        attempts  INTEGER NOT NULL DEFAULT 0,
        failed    INTEGER NOT NULL DEFAULT 0,
        lastTried TEXT,
        seenAt    TEXT,
        UNIQUE(account, puzzleId)
      );
      INSERT INTO PuzzleStat_v4
        (id, account, puzzleId, solved, attempts, failed, lastTried, seenAt)
        SELECT id, '', puzzleId, solved, attempts, failed, lastTried, seenAt
        FROM PuzzleStat;
      DROP TABLE PuzzleStat;
      ALTER TABLE PuzzleStat_v4 RENAME TO PuzzleStat;

      CREATE TABLE EndgameProgress_v4 (
        id        TEXT PRIMARY KEY NOT NULL,
        account   TEXT NOT NULL DEFAULT '',
        lessonId  TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        attempts  INTEGER NOT NULL DEFAULT 0,
        bestMoves INTEGER,
        lastTried TEXT,
        UNIQUE(account, lessonId)
      );
      INSERT INTO EndgameProgress_v4
        (id, account, lessonId, completed, attempts, bestMoves, lastTried)
        SELECT id, '', lessonId, completed, attempts, bestMoves, lastTried
        FROM EndgameProgress;
      DROP TABLE EndgameProgress;
      ALTER TABLE EndgameProgress_v4 RENAME TO EndgameProgress;
    `);
    version = 4;
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

/**
 * The profile row for an account.
 *
 * The column is still called `id`; it now holds the account name (or `solo`
 * when no account is connected), so XP, streak and the puzzle/endgame ratings
 * are per-account exactly like the training progress is.
 */
export async function ensureProfile(db: SQLite.SQLiteDatabase, id = SOLO): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO Profile (id, xp, streakDays, lastActiveDate, puzzleRating, createdAt, updatedAt)
     VALUES (?, 0, 0, NULL, 800, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    id,
    now,
    now,
  );
}

/**
 * Prisma used `@default(cuid())`. We only need uniqueness within a device-local
 * single-user DB, so a monotonic-ish random id with the same TEXT shape suffices
 * and avoids pulling in a cuid dependency.
 */
export function newId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `c${t}${r}`;
}

/** Local date as YYYY-MM-DD in the DEVICE timezone. */
export function todayString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Date offset by N days, as YYYY-MM-DD in the device timezone. */
export function daysAgoString(n: number): string {
  return todayString(new Date(Date.now() - n * 86_400_000));
}
