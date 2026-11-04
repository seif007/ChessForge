/**
 * The single coach knowledge base, built once from the shipped JSON.
 * 64 entries: 26 concepts, 11 structures, 17 openings, 10 endgames — the
 * prototype's kb.db, dumped to `src/data/coach_kb.json`.
 */

import kbData from '@/data/coach_kb.json';

import { Coach } from './coach';
import { KbIndex, KbRow, kbFromRows } from './kb';
import { CoachNarrator } from './template';

export const COACH_KB: KbIndex = kbFromRows(kbData as KbRow[]);

/** Build a coach; the narrator defaults to the offline template inside `Coach`. */
export function createCoach(narrator?: CoachNarrator): Coach {
  return narrator ? new Coach(COACH_KB, narrator) : new Coach(COACH_KB);
}
