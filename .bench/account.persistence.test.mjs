/**
 * Does the app remember the user's Lichess account between launches?
 *
 * WHY THIS IS A SOURCE TEST AND NOT A RUNTIME TEST
 * ------------------------------------------------
 * The bug is a STATEMENT-ORDERING bug: the account is only persisted by
 * `saveAccount`, and the only call site used to sit after a successful
 * `fetchAllGames`. So the account survived a launch iff a full Lichess fetch
 * completed in that session — enter a name, close the app early (or fetch while
 * offline, which is caught), and nothing was written. `loadActiveUsername()`
 * then returns null on the next boot and the user is asked again. The reported
 * symptom, "the user dont need to enter his account everytime he opens the app".
 *
 * Reproducing that at runtime needs expo-sqlite's native module and a simulated
 * app kill around a network call — a lot of machinery to assert something that
 * is fully visible in the call order. Two things must hold, and both are
 * structural:
 *
 *   1. `connect` must persist BEFORE it fetches, so a failed or interrupted
 *      fetch cannot lose the account.
 *   2. The whole read path must exist: something must write the active key
 *      (here) and something must read it at boot (there), or the write is dead.
 *
 * The mutation this guards against is someone "tidying" the two `saveAccount`
 * calls back into one, or moving it back inside the try-block after the fetch.
 *
 * Usage: node .bench/account.persistence.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures++;
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stats = read('src/components/screens/StatsScreen.tsx');
const store = read('src/lib/lichessStore.ts');

console.log('\n[1] the store can remember which account is active');

ok('the active key is written by saveAccount',
  /function saveAccount[\s\S]{0,400}?Storage\.setItem\(ACTIVE_KEY/.test(store));
ok('the active key is read by loadActiveUsername',
  /function loadActiveUsername[\s\S]{0,300}?Storage\.getItem\(ACTIVE_KEY\)/.test(store));
ok('there is a way to forget ONLY the pointer, not the data',
  /export async function clearActiveUsername[\s\S]{0,400}?removeItem\(ACTIVE_KEY\)/.test(store)
  && !/export async function clearActiveUsername[\s\S]{0,400}?removeItem\(ACCOUNT_KEY/.test(store));

console.log('\n[2] connecting persists the account WITHOUT needing the network');

/*
 * Find the `connect` callback and assert the ORDER of its two load-bearing
 * effects: the saveAccount call must come before the fetchAllGames-driven
 * `loadGames` call. Index comparison rather than a regex across the whole
 * function, so a comment mentioning either name cannot satisfy it.
 */
const connectStart = stats.indexOf('const connect = useCallback');
ok('connect exists', connectStart >= 0);
const connectBody = connectStart >= 0 ? stats.slice(connectStart, connectStart + 6000) : '';

const saveIdx = connectBody.indexOf('await saveAccount(');
const loadIdx = connectBody.indexOf('await loadGames(');
ok('connect calls saveAccount', saveIdx >= 0, saveIdx >= 0 ? `at +${saveIdx}` : 'not found');
ok('connect calls loadGames', loadIdx >= 0, loadIdx >= 0 ? `at +${loadIdx}` : 'not found');
ok('saveAccount runs BEFORE the fetch-dependent loadGames',
  saveIdx >= 0 && loadIdx >= 0 && saveIdx < loadIdx,
  saveIdx >= 0 && loadIdx >= 0 ? `save +${saveIdx} < load +${loadIdx}` : '');

/*
 * AND A BAD NAME IS NOT SAVED — the later requirement: *"the account import
 * should validate/resolve the username before saving it"*. Both rules hold at
 * once: the handle is remembered across a network failure, and a handle Lichess
 * says does not exist (or says is closed) is rejected before storage, so a typo
 * cannot become the connected account.
 */
ok('the save is not reachable for a not-found handle',
  saveIdx >= 0 && connectBody.indexOf("kind === 'not-found'") >= 0
  && connectBody.indexOf("kind === 'not-found'") < saveIdx,
  'the not-found branch returns before saveAccount');
ok('the handle is resolved by the profile lookup before it is saved',
  connectBody.indexOf('await fetchProfile(') >= 0
  && connectBody.indexOf('await fetchProfile(') < saveIdx,
  'a resolved handle is what gets stored');

console.log('\n[3] the boot path actually reads it back');

// The boot effect is the other half: writing a key nothing reads is just as
// broken as reading a key nothing writes.
const bootIdx = stats.indexOf('const saved = await loadActiveUsername()');
ok('StatsScreen boot reads the active username', bootIdx >= 0);
if (bootIdx >= 0) {
  const boot = stats.slice(bootIdx, bootIdx + 700);
  ok('boot loads the saved account profile', /loadAccount\(saved\)/.test(boot));
  ok('boot adopts the saved account into state', /setAccount\(acc\)/.test(boot));
  ok('the screen waits for boot before showing the form',
    /if \(!booted\)/.test(stats) && /setBooted\(true\)/.test(stats),
    'otherwise the connect form flashes on every launch');
}

console.log('\n[4] the other screens read the same key — and the in-place card persists like Stats');

for (const f of ['GameOpeningsScreen', 'PuzzlesScreen']) {
  const src = read(`src/components/screens/${f}.tsx`);
  ok(`${f} resolves the active account`,
    /loadActiveUsername\(\)/.test(src) || /loadMinedDeck\(\)/.test(src),
    'directly, or through the shared deck read that resolves it in the store');
}
ok('the shared deck read resolves through the same loader',
  /export async function loadMinedDeck[\s\S]{0,240}?await loadActiveUsername\(\)/.test(store));

/*
 * THE IN-PLACE CARD IS A SECOND CONNECT DOOR, and must obey the same lesson:
 * the handle survives a failed request, a wrong handle is never saved, and
 * switching away from an account wipes it first. A second door that forgot any
 * of this would reintroduce exactly the bug this file exists for.
 */
const cardSrc = read('src/components/GameImportInline.tsx');
const cardConnectStart = cardSrc.indexOf('const connect = useCallback');
const cardConnectEnd = cardSrc.indexOf('const runImport = useCallback', cardConnectStart);
ok('the card has its own connect', cardConnectStart >= 0);
const cardConnect = cardConnectStart >= 0 && cardConnectEnd > cardConnectStart
  ? cardSrc.slice(cardConnectStart, cardConnectEnd) : '';
const cardSaveIdx = cardConnect.indexOf('await saveAccount(');
ok('the card saves the account without needing the network', cardSaveIdx >= 0,
  cardSaveIdx >= 0 ? `at +${cardSaveIdx}` : 'not found');
ok('the card wipes a replaced account before the save',
  cardConnect.indexOf('await forgetAccount(') >= 0
  && cardConnect.indexOf('await forgetAccount(') < cardSaveIdx);
ok('the card looks the handle up before saving it',
  cardConnect.indexOf('await fetchProfile(') >= 0
  && cardConnect.indexOf('await fetchProfile(') < cardSaveIdx,
  'a resolved handle is what gets stored');
ok('and a handle Lichess says is wrong returns before the save',
  cardConnect.indexOf("kind === 'not-found'") >= 0
  && cardConnect.indexOf("kind === 'not-found'") < cardSaveIdx,
  'a typo is not persisted as the connected account');

console.log('\n[5] TRAINING PROGRESS IS PER ACCOUNT');

/*
 * THE OWNER'S RULE: *"when i import and use new username everything should be
 * fresh for that user"*. The study/position/puzzle/endgame tables were one
 * global pool, so a new username inherited the previous user's mastery rings
 * and rank. The v4 migration adds an account column and makes the unique key
 * composite; the store scopes every read/write and swaps the maps on a switch.
 */
const dbSrc = read('src/lib/db.ts');
const progressStore = read('src/lib/store.ts');
ok(/export const DATABASE_VERSION = 4/.test(dbSrc),
  'the schema version steps to 4');
ok((dbSrc.match(/account\s+TEXT NOT NULL DEFAULT ''/g) ?? []).length >= 4,
  'study, position, puzzle and endgame tables all gain an account column');
ok((dbSrc.match(/UNIQUE\(account, /g) ?? []).length >= 4,
  'and their unique keys become (account, id), so two accounts can share an id');
ok(/UPDATE StudyProgress SET account = \? WHERE account = ''/.test(progressStore)
  && /claimLegacyProgress/.test(progressStore),
  'legacy progress is claimed once, by the first account that loads');
ok(/activeAccount = \(await loadActiveUsername\(\)/.test(progressStore),
  'the store resolves the active account on every load');
ok((progressStore.match(/WHERE account = \?/g) ?? []).length >= 8,
  'reads and updates are scoped to that account');
ok(/reloadForAccount: async/.test(progressStore),
  'a switch can re-read progress without a relaunch');
ok(/reloadForAccount\(\)/.test(stats) && /reloadForAccount\(\)/.test(cardSrc),
  'both connect doors swap the scope when an account is saved');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}  (${checks - failures}/${checks})`);
process.exit(failures === 0 ? 0 : 1);
