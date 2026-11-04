import type { BotSource } from './types';

/**
 * How a saved bot is named in the UI.
 *
 * A Lichess bot is a style model built from a public account, not the person
 * behind that account. Showing the account handle keeps the claim honest and
 * avoids presenting a real name or photograph as if the player endorsed it.
 * OTB bots keep their archive name because that is the identifier the source
 * itself publishes. The coach is a local engine level, not an account.
 */
export function botDisplayName(bot: {
  name: string;
  source: BotSource;
  /** The account handle, when the caller has it. */
  key?: string;
}): string {
  if (bot.source !== 'lichess') return bot.name;

  const handle = (bot.key || bot.name).replace(/^@+/, '').trim();
  return handle ? `Style of @${handle}` : 'Lichess bot';
}
