/** Human labels shared by the Arena lobby, creator and tournament sheet. */

import type { ArenaFormat, ArenaMode, ArenaResult } from './types';

export const ARENA_FORMAT_LABEL: Record<ArenaFormat, string> = {
  'round-robin': 'Round robin',
  'double-round-robin': 'Double round robin',
  knockout: 'Knockout',
  swiss: 'Swiss',
  arena: 'Arena',
};

export const ARENA_MODE_LABEL: Record<ArenaMode, string> = {
  human: 'You vs bots',
  bots: 'Bot championship',
};

export function resultLabel(result: ArenaResult | undefined): string {
  if (result === '1-0') return '1–0';
  if (result === '0-1') return '0–1';
  if (result === '1/2-1/2') return '½–½';
  if (result === 'bye') return 'Bye';
  return '—';
}
