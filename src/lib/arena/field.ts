/**
 * WHO ACTUALLY PLAYS, OUT OF THE BOTS THE USER PICKED.
 *
 * Tournament creation used to take every selected bot, so the only way to have
 * a four-bot event was to own exactly four bots — and the form always preselected
 * the first four, which made "choose the number of players" impossible. The
 * request was explicit: *"for the tournaments, the user should be able to choose
 * the number of bots who would play in the tournament"*.
 *
 * So selection and field size are separate decisions:
 *
 *   - `selectedIds` is the pool the user wants, in the order they picked it.
 *   - `count` is how many of them enter.
 *
 * The field takes the selected bots first, in order, and tops up from the rest of
 * the library only when the requested count is larger than the selection. It is a
 * pure function so the rule can be tested without a screen.
 */
export function tournamentField(
  selectedIds: readonly string[],
  availableIds: readonly string[],
  count: number,
  minBots: number,
): string[] {
  const available = availableIds.filter((id, i) => availableIds.indexOf(id) === i);
  const wanted = Math.max(minBots, Math.min(available.length, Math.floor(count) || 0));
  if (available.length === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id) || !available.includes(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const id of selectedIds) {
    if (out.length >= wanted) break;
    add(id);
  }
  for (const id of available) {
    if (out.length >= wanted) break;
    add(id);
  }
  return out;
}

/** The legal range for the participant count, given the library and the mode. */
export function tournamentCountBounds(
  availableCount: number,
  minBots: number,
): { min: number; max: number } {
  const max = Math.max(0, availableCount);
  return { min: Math.min(minBots, max), max };
}