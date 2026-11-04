import Storage from 'expo-sqlite/kv-store';

import { cancelJob, waitForJob } from '@/lib/background';
import { BOT_BUILD_JOB } from '@/lib/bots/buildJob';
import { clearGameCache } from '@/lib/lichess';
import { SCAN_JOB } from '@/lib/statsJobs';

/**
 * Everything an online import can leave on the device.
 *
 * The prefixes are deliberately specific. Training progress lives in SQLite
 * and in other kv-store keys, and deleting imported games must not wipe XP,
 * streaks, SRS schedules or puzzle history. The custom repertoire is included
 * because its lines are derived from the imported account's games. The old
 * provider's prefix is included so a device upgrading mid-migration is cleaned
 * by the same user-facing control.
 */
const IMPORTED_PREFIXES = [
  'chessforge.li.',
  'chessforge.cc.',
  'chessforge.openings.',
  'chessforge.rep.custom.',
  'chessforge.bots.',
] as const;

/**
 * Delete imported account data and every bot/opening/puzzle derived from it.
 *
 * This is the action behind the Profile screen's "Delete imported data"
 * control. It removes all accounts' cached imports, not only the active one,
 * because the user is asking for the imports to be gone rather than asking to
 * switch accounts. The in-memory month cache is cleared too, so the current
 * session cannot keep serving games from memory after the disk copy is gone.
 */
export async function clearAllImportedData(): Promise<number> {
  /*
   * Stop the work that could put the data straight back, then WAIT for it to
   * settle before clearing. Cancellation is cooperative: the scan still has to
   * leave its current engine search and write its partial state, and the bot
   * build still has to leave the profile fold. Clearing in the same tick as the
   * abort would let one of those late writes recreate imported data after the
   * user asked for it to be gone.
   */
  cancelJob(SCAN_JOB);
  cancelJob(BOT_BUILD_JOB);
  await Promise.all([waitForJob(SCAN_JOB), waitForJob(BOT_BUILD_JOB)]);

  const keys = await Storage.getAllKeys();
  const imported = keys.filter((key) =>
    IMPORTED_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

  await Promise.all(imported.map((key) => Storage.removeItem(key)));
  clearGameCache();
  return imported.length;
}
