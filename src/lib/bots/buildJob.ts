/**
 * The bot-build job, owned by the module rather than by BotsScreen.
 *
 * A Lichess/OTB build is minutes of fetching and folding hundreds of games.
 * It used to live inside `BotsScreen.run`, so navigating to another tab threw
 * away the progress UI; returning showed an idle form while the old promise
 * was still running (or, worse, invited a second identical build). The work now
 * lives here, writes the finished bot through `saveBot`, and publishes progress
 * through the background-job store. The screen is only a viewer.
 */

import { runJob } from '@/lib/background';
import { buildBotProfile } from '@/lib/bots/profile';
import { fetchLichessBotGames } from '@/lib/bots/sources';
import { fetchOtbBotGames, OtbAmbiguityError, OtbNoGamesError } from '@/lib/bots/otb';
import { newBotId, saveBot } from '@/lib/bots/store';
import type { BotBuildProgress, BotProfile, BotSource, BotSummary } from '@/lib/bots/types';

export const BOT_BUILD_JOB = 'bot-build';

export type BotTimeClass = 'rapid' | 'blitz' | 'daily';

export interface BotBuildInput {
  source: BotSource;
  query: string;
  maxGames: number;
  timeClass: BotTimeClass;
}

export interface BotBuildResult {
  profile: BotProfile;
  list: BotSummary[];
}

/**
 * Start a build, or join the one already running for this query.
 *
 * The returned promise resolves to the saved profile/list on success and
 * `null` on failure; the job state carries the typed error. Callers on a screen
 * normally ignore the promise and subscribe with `useJob`.
 */
export function startBotBuild(input: BotBuildInput): Promise<BotBuildResult | null> {
  const q = input.query.trim();
  const owner = `${input.source}:${q.toLowerCase()}`;
  return runJob<BotBuildResult>(
    BOT_BUILD_JOB,
    'Building bot',
    async ({ signal, progress }) => {
      const report = (p: BotBuildProgress) => {
        progress({ pct: p.pct, label: p.label, detail: p.detail });
      };

      try {
        const fetched = input.source === 'lichess'
          ? await fetchLichessBotGames(q, report, {
              maxGames: input.maxGames,
              timeClass: input.timeClass,
              signal,
            })
          : await fetchOtbBotGames(q, report, { maxGames: input.maxGames, signal });

        const built = await buildBotProfile(fetched.games, fetched.meta, {
          onProgress: report,
        });

        /*
         * THE DELETE BUTTON MAY HAVE RUN WHILE THE PROFILE WAS BEING FOLDED.
         * Cancelling the job must stop the save as well as the fetch, or the
         * imported data the user just deleted would reappear as a new bot.
         */
        if (signal.aborted) throw new Error('Cancelled.');

        const profile: BotProfile = {
          ...built,
          id: newBotId(),
          name: built.meta.name,
          recipe: {
            kind: input.source,
            query: q,
            games: input.maxGames,
            timeClass: input.source === 'lichess' ? input.timeClass : undefined,
          },
          createdAt: Date.now(),
        };

        progress({
          pct: 100,
          label: 'Saving…',
          detail: `${fetched.games.length} games analysed`,
        });
        const list = await saveBot(profile);
        return { profile, list };
      } catch (e) {
        if (e instanceof OtbNoGamesError && e.suggestions.length > 0) {
          throw new Error(`${e.message}\n\nClosest players in the archive: ${e.suggestions.join(' · ')}`);
        }
        if (e instanceof OtbAmbiguityError) throw e;

        /*
         * NO RAW RESOLVER TEXT, EVER. A phone that hops networks can fail a DNS
         * lookup for one request; the sources retry, but if one still escapes,
         * the user must see what to do, not `UnknownHostException`.
         */
        const raw = (e as Error)?.message || 'Something went wrong.';
        if (/unknownhost|fetch failed|network request failed|failed to fetch|econn|enotfound/i.test(raw)) {
          throw new Error('Could not reach the source — check your internet connection and try again.');
        }
        throw e;
      }
    },
    { owner },
  );
}
