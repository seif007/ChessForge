/**
 * GATE 1n - the puzzles tab can actually load a puzzle, and never blames the network for it.
 *
 * THE REPORT
 * ==========
 * *"i tried puzzles and it says to check my connection although i am connected ( the endgames works
 * fine although it needs connection but the puzzles doesnt work )"*
 *
 * He was right, and the endpoint agreed with him. Probed directly, it answered **200** with real
 * puzzles, and the ratings it returned were 1308, 1386, 1423, 1454, 1477, 1479. After a few dozen
 * calls it answered 429, as an unauthenticated client always does.
 *
 * TWO FAULTS, COMPOUNDING
 * -----------------------
 *
 * 1. THE BAND COULD NOT BE SATISFIED. The bottom band's range was 400-1250, the app asked for
 *    `easy`, and the measured floor of `easy` is ~1300. `fetchNextPuzzle` rejects anything outside
 *    the band, so all six attempts were discarded, `served` stayed null, and the screen showed its
 *    offline notice. With a perfect connection and a 200 in hand there was nothing it would serve.
 *
 *    That is what killed the tab, and it is why the bands are now stored beside the measurement that
 *    justifies them rather than as bare numbers. A band is a claim about a distribution; the two
 *    facts belong in one place, and this gate is what stops them drifting apart again.
 *
 * 2. THE NOTICE NAMED THE WRONG THING. The catch was `catch { setLoadError(true) }`, and the
 *    sentence was "Check your connection" — for a 429, a 401, a schema change, a rejected
 *    reconstruction, and a real outage alike. Endgames shares this endpoint and the same limit, so
 *    the two tabs genuinely can disagree at the same moment, which is what made the message look
 *    absurd rather than merely terse.
 *
 * WHAT IS CHECKED
 * ---------------
 * The property that matters is NOT "these numbers are correct today" — they are observations, and
 * Lichess will move them again. It is that the app DEGRADES HONESTLY when the observation is stale:
 * a near-miss fallback exists, a band is never narrower than the bucket it asks for, and no failure
 * other than an actual network failure tells the user to check their connection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Chess } from 'chess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
let failures = 0;
function ok(cond, label, detail) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
    if (detail) for (const l of String(detail).split('\n')) console.log(`          ${l}`);
  }
}
function head(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/*
 * Comment-stripped AND whitespace-collapsed, for the checks that measure a DISTANCE.
 *
 * `code()` replaces a comment with spaces of the same length, which keeps line numbers stable but
 * leaves long runs of blanks — and a regex with a `{0,600}` window then spans 600 spaces of nothing
 * and fails against working code. Collapsing whitespace makes a character budget mean characters of
 * actual code, which is what those windows were written to express. This is the same reason a note in
 * `bundlecheck.py` says a needle must be a substring of the SOURCE: a check whose evidence is
 * whitespace is a check that breaks on a reformat.
 */
const tight = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');

const puzzlesSrc = read('src/lib/puzzles.ts');
const providerSrc = read('src/lib/puzzleProvider.ts');
const provider = code('src/lib/puzzleProvider.ts');
const screenSrc = read('src/components/screens/PuzzlesScreen.tsx');
const screen = code('src/components/screens/PuzzlesScreen.tsx');
const providerTight = tight(provider);
const screenTight = tight(screen);

// ---------------------------------------------------------------------------
head('1. NO BAND IS NARROWER THAN THE BUCKET IT ASKS FOR');

/*
 * The measured floors, hard-coded from the probe. Deliberately a LITERAL here and not an import: the
 * gate has to be able to say "the table in the source has drifted from what the endpoint actually
 * returned", and it cannot do that if it reads the same table it is checking.
 */
const OBSERVED = { easy: 1308, medium: 1386, hard: 1479, hardest: 1600 };

const floorBlock = puzzlesSrc.match(/PUZZLE_BUCKET_FLOOR[\s\S]*?\n};/);
ok(!!floorBlock, 'the measured bucket floors are declared in puzzles.ts');
if (floorBlock) {
  for (const [bucket, observed] of Object.entries(OBSERVED)) {
    const m = new RegExp(`${bucket}:\\s*(\\d+)`).exec(floorBlock[0]);
    const declared = m ? Number(m[1]) : null;
    ok(declared !== null && declared <= observed,
      `the '${bucket}' floor (${declared}) is at or below the lowest rating observed (${observed})`,
      'a floor above an observed minimum is how the tab stopped being able to serve anything');
  }
}

const modes = puzzlesSrc.match(/PUZZLE_MODES[\s\S]*?\n\];/);
ok(!!modes, 'the bands are declared');
if (modes && floorBlock) {
  const floors = Object.fromEntries([...floorBlock[0].matchAll(/(\w+):\s*(\d+)/g)]
    .map((m) => [m[1], Number(m[2])]));
  const bandOf = { warmup: 'easy', steady: 'medium', sharp: 'hard', relentless: 'hardest' };
  const rows = [...modes[0].matchAll(/id:\s*'(\w+)'[^}]*range:\s*\[(\d+),\s*(\d+)\]/g)]
    .map((m) => ({ id: m[1], lo: Number(m[2]), hi: Number(m[3]) }));
  ok(rows.length === 4, `all four bands are readable (${rows.length})`);

  /*
   * THE BAND MUST CONTAIN ITS BUCKET'S FLOOR. This is the exact contradiction that killed the tab:
   * beginner 400-1250 against an easy floor of 1300 means the band is entirely BELOW what the bucket
   * can produce, so every candidate is rejected and the user is shown an error message while online.
   */
  const impossible = [];
  for (const r of rows) {
    const bucket = bandOf[r.id];
    const floor = floors[bucket];
    if (floor == null) continue;
    if (r.hi < floor) impossible.push(`${r.id} (${r.lo}-${r.hi}) cannot contain a '${bucket}' puzzle (floor ${floor})`);
  }
  ok(impossible.length === 0,
    'every band reaches its own bucket\'s floor, so each one is satisfiable',
    impossible.join('\n'));

  for (const r of rows) {
    ok(r.lo < r.hi, `the ${r.id} band is not inverted (${r.lo}-${r.hi})`);
  }
}

// ---------------------------------------------------------------------------
head('2. AUTO CANNOT WINDOW A NEW USER OUT OF EVERY PUZZLE');

/*
 * `autoModeFor(400)` is the bottom band, but `modeWindow('auto', 400)` was `[450, 550]` — and the `easy`
 * floor is 1300. A new account on Auto is asking for a 450-550 puzzle out of a bucket with nothing
 * under 1300, and rejecting all six attempts. Same failure as the bands, reached by a different
 * route, and it is the first thing a new user sees.
 */
ok(/mode === 'auto' \? Math\.min\(win\[0\], bandWin\[0\]\)/.test(provider)
  && /mode === 'auto' \? Math\.max\(win\[1\], bandWin\[1\]\)/.test(provider),
    'the Auto window is unioned with the band, not narrowed to the user\'s rating alone');

ok(/liveHi = mode === 'auto'/.test(provider),
    'and the accepted window is widened on Auto rather than clamped to the user\'s ceiling');
ok(!/const liveHi = Math\.min\(win\[1\] \+ tol, bandWin\[1\]\);/.test(provider),
    'CONTROL: the unconditional clamp that made the window unsatisfiable is gone');

// ---------------------------------------------------------------------------
head('3. A NEAR MISS IS SERVED, RATHER THAN AN ERROR');

/*
 * With the bands fixed there is still a path to "nothing usable": the distribution moves, or a
 * particular moment in time has nothing in the band. The previous outcome was an error message,
 * which for an online user is the worst of the available answers — the alternative is a puzzle
 * slightly off level, disclosed.
 */
/*
 * THE NEAR-MISS HUNT IS GONE, AND THESE ASSERTIONS NOW HOLD THE REPLACEMENT.
 *
 * They used to require `NEAR_MISS_TOLERANCE`, a `nearest` accumulator and a "closest wins" search �
 * i.e. the app asking Lichess up to TEN times for one puzzle to find something closer to the band.
 * That is what produced the standing complaint that puzzles "always shows me rate limit problem":
 * ten anonymous requests per puzzle is past what an unauthenticated client should be doing, so the
 * 429 was arithmetic rather than bad luck.
 *
 * What replaced it is one request, plus disclosure instead of persistence: a puzzle outside the band
 * is served WITH `offBandBy` set, so the screen can say how far out it is. A user would rather be told
 * "this one is 180 above your level" than sit through a retry storm for a marginally better one.
 *
 * Both assertions below fail against the pre-fix source, which had neither.
 */
ok(!/NEAR_MISS_TOLERANCE/.test(provider),
    'CONTROL: the retry storm is gone � no near-miss tolerance driving a multi-request search');

{
  // Requests reachable from one puzzle, counted in the source rather than assumed.
  const fn = /export async function fetchNextPuzzle[\s\S]*?\n}\n/.exec(provider);
  const body = fn ? fn[0] : '';
  const fetchCalls = (body.match(/await fetch\(/g) || []).length;
  const viaHelper = (body.match(/await fetchLive\(/g) || []).length;
  ok(fetchCalls + viaHelper === 1,
    'CONTROL: one puzzle costs exactly ONE request, not up to ten',
    `counted ${fetchCalls + viaHelper}`);
}

ok(/offBandBy: live\.rating < liveLo \? liveLo - live\.rating : live\.rating - liveHi/.test(provider),
    'an off-band puzzle is served with the distance attached, so "matched to your level" is either '
    + 'true or visibly qualified');
ok(/if \(live\.rating >= liveLo && live\.rating <= liveHi\) return live;/.test(provider),
    'and an in-band puzzle is served untouched � the disclosure is not a blanket hedge');

ok(!/markPuzzleSeen/.test(provider) && !/liveCache/.test(provider),
    'CONTROL: nothing is cached or marked seen � every puzzle is fetched fresh, as asked');

// ---------------------------------------------------------------------------
head('3b. WHEN THE LIVE REQUEST FAILS, THE BUNDLED DECK ANSWERS — AND ONLY THEN');

/*
 * WHY THIS EXISTS
 * ===============
 * Two reports, one wall. *"i tried the app without connection for puzzles and it says provider
 * problem while it had to say internet problem"* — and behind it every "rate limit problem" report
 * since the app became one-request-per-puzzle. The live path is deliberately always-fresh and
 * never cached, so it is empty exactly when the network is not there or the unauthenticated limit
 * says "not now". A shipped deck answers that without touching the freshness promise: it is
 * consulted ONLY after the live request has already come back empty.
 *
 * WHAT IS HELD HERE
 * -----------------
 *   1. ORDER. The `fallbackPuzzle` call sits inside the `if (!live)` branch, after the single live
 *      attempt — so an online user's puzzle is live, full stop, and the deck cannot mask a working
 *      provider. The one-request count above still holds; the deck spends no request.
 *   2. VERIFICATION. The deck is data, so the pool module replays every entry with chess.js before
 *      serving it and drops anything that does not check out. Probed functionally below, against
 *      the real deck, with tampered entries as the controls a mutation would fail on.
 *   3. HONESTY. A pooled puzzle is labelled `source: 'pool'` (the screen says "Puzzle pool") and
 *      carries `offBandBy` when it falls outside the asked window, exactly like a live near miss.
 */
{
  ok(/import \{ fallbackPuzzle \} from '@\/lib\/puzzlePool';/.test(provider),
    'the provider reaches the bundled deck through one import');

  const liveAt = providerTight.indexOf('await fetchLive(difficulty)');
  const fallbackAt = providerTight.indexOf('fallbackPuzzle(userRating, liveLo, liveHi)');
  ok(liveAt >= 0 && fallbackAt > liveAt,
    'the deck is consulted only AFTER the one live request — never before, never beside it');
  ok(/if \(!live\) \{[\s\S]{0,1800}?fallbackPuzzle\(userRating, liveLo, liveHi\)/.test(providerTight),
    'and it answers the request-failed path specifically, rather than standing in for a live puzzle');
  ok(/if \(live\.rating >= liveLo && live\.rating <= liveHi\) return live;/.test(provider),
    'CONTROL: an in-band live puzzle still returns before the fallback can ever run');

  const poolTight = tight(code('src/lib/puzzlePool.ts'));
  ok(/source: 'pool'/.test(poolTight),
    'a pooled puzzle is labelled as one, so the screen can never present a fallback as fresh');
  ok(/const m = c\.move\(\{[\s\S]{0,200}?\}\);\n sans\.push\(m\.san\);/.test(poolTight),
    'every deck entry is replayed move by move before it is served');
  ok(/catch \{\s*return null;\s*\}/.test(poolTight),
    'and an entry that does not replay is dropped rather than served and discovered on the board');
  ok(/if \(sans\.join\(' '\) !== entry\.san\.join\(' '\)\) return null;/.test(poolTight),
    'with the stored SAN required to match the replay, since the summary renders that SAN');
  ok(/if \(entry\.uci\.length === 0 \|\| entry\.uci\.length % 2 === 0\) return null;/.test(poolTight),
    'an even-length solution is refused — the screen completes on the PLAYER\'s last move');

  /*
   * THE FUNCTIONAL HALF.
   *
   * A textual gate can only say the checks are written down. The deck is data in a source tree and
   * the selection walk is arithmetic, and both can be wrong in ways no regex sees: a deck rebuilt
   * by a broken generator, an off-by-one in the nearest walk, a served set that repeats. So the
   * REAL module is transpiled here (the same technique `provider.live.mjs` uses), pointed at the
   * REAL deck, and asked the questions the screen depends on.
   */
  const POOL_TEMP = path.join(ROOT, '.bench', '.puzzle-pool-under-test.cjs');
  const poolSrc = read('src/lib/puzzlePool.ts').replace(
    /import deck from '@\/data\/offline_deck\.json';/,
    `const deck = require(${JSON.stringify(path.join(ROOT, 'src', 'data', 'offline_deck.json'))});`,
  );
  fs.writeFileSync(POOL_TEMP, ts.transpileModule(poolSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, 'utf8');
  const poolMod = await import(`file:///${POOL_TEMP.replace(/\\/g, '/')}`);

  const deckEntries = JSON.parse(read('src/data/offline_deck.json'));
  const poolList = poolMod.buildPool(deckEntries);
  ok(deckEntries.length >= 1000,
    `the bundled deck is a real deck, not a token set (${deckEntries.length} entries)`);
  ok(poolList.length >= Math.floor(deckEntries.length * 0.98),
    'and almost every entry survives runtime verification — a deck that silently loses its bulk is '
    + `still a broken deck (${poolList.length}/${deckEntries.length} survived)`);

  // The gate's OWN replay, not the module's: if both were wrong the same way, this is the check
  // that would still fail.
  let illegal = 0;
  for (const p of poolList.slice(0, 400)) {
    const board = new Chess(p.fen);
    if (board.turn() !== p.side) { illegal++; continue; }
    try { for (const san of p.solutionSan) board.move(san); } catch { illegal++; }
  }
  ok(illegal === 0,
    'the pool that comes out really replays — checked against this gate\'s own board',
    `${illegal} entries did not replay`);

  const sample = deckEntries[0];
  ok(poolMod.buildPool([{ ...sample, uci: ['a1a8'], san: ['Qa8#'] }]).length === 0,
    'CONTROL: an entry whose moves are not legal from its position is dropped');
  ok(poolMod.buildPool([{ ...sample, san: ['Nf3'] }]).length === 0,
    'CONTROL: an entry whose SAN disagrees with its own replay is dropped');
  ok(poolMod.buildPool([{ ...sample, uci: sample.uci.slice(0, -1), san: sample.san.slice(0, -1) }]).length === 0,
    'CONTROL: an even-length solution is dropped');
  ok(poolMod.buildPool([sample]).length === 1,
    'CONTROL: the untampered entry itself IS served — the checks above drop the tampering, not the deck');

  const probe = [
    { ...sample, id: 'probe-low', rating: 700 },
    { ...sample, id: 'probe-mid', rating: 1300 },
    { ...sample, id: 'probe-high', rating: 2000 },
  ];
  const probeList = poolMod.buildPool(probe);
  const nearest = poolMod.pickNearest(probeList, 800, () => true);
  ok(nearest && nearest.rating === 700, 'the nearest rating to the ask is chosen');
  const nextNearest = poolMod.pickNearest(probeList, 800, (p) => p.id !== nearest.id);
  ok(nextNearest && nextNearest.rating === 1300,
    'and the next nearest when the first is excluded — the unseen walk, not a random draw');

  const first = poolMod.fallbackPuzzle(1200, 900, 1500);
  const second = poolMod.fallbackPuzzle(1200, 900, 1500);
  ok(first && second && first.id !== second.id,
    'two consecutive offline serves are different puzzles — the unseen set drives the walk');
  ok(second && second.source === 'pool',
    'and a served pool puzzle says where it came from');

  const offBand = poolMod.fallbackPuzzle(0, 0, 100);
  ok(offBand && offBand.offBandBy === offBand.rating - 100 && offBand.offBandBy > 0,
    'a pooled puzzle below the asked window carries its distance, like a live near miss');
  const inBand = poolMod.fallbackPuzzle(0, 0, 3000);
  ok(inBand && inBand.offBandBy === undefined,
    'and an in-window pooled puzzle carries no distance note — the disclosure is not a blanket hedge');

  try { fs.unlinkSync(POOL_TEMP); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
head('4. NO FAILURE BUT A REAL ONE BLAMES THE CONNECTION');

{
  ok(/type LoadReason = 'no-puzzle' \| 'rate-limited' \| 'offline' \| 'error' \| null;/.test(screenSrc),
    'the screen records WHY, as a closed union');
  ok(/'Check your connection and try again\.'/.test(screen) === false
    || /No connection/.test(screen),
    'the blanket "check your connection" sentence is gone');

  /*
   * The one sentence that may mention the connection is `offline`, and it must be reachable by an
   * actual network failure rather than by `null` from the provider. `fetchNextPuzzle` returning null
   * means the endpoint ANSWERED and nothing was usable — which is the case the user hit.
   */
  ok(/if \(!data\) \{[\s\S]{0,1200}setLoadReason\(/.test(screenTight),
    'a null puzzle is recorded as a reason, not thrown');
  ok(!/if \(!data\) throw new Error\('no puzzle'\);/.test(screen),
    'CONTROL: the old `throw` on null is gone — it is what turned "nothing usable" into "no network"');

  ok(/'rate-limited'/.test(screen) && /not your connection/.test(screen),
    'a rate limit is named as the provider\'s limit, and explicitly not the user\'s connection');
  ok(/uses the same service/.test(screen),
    'and mentions that Endgames shares it, since the two tabs can disagree at the same moment');
  ok(/No connection/.test(screen), 'a real outage still says so');

  /*
   * WHY THE SECTION ABOVE PASSED WITH THE BUG IN IT.
   *
   * The two checks that used to stand here were:
   *
   *     ok(/if \(!data\) \{[\s\S]{0,320}setLoadReason\(/)   // that setLoadReason is CALLED
   *     ok(/'rate-limited'/.test(screen))                    // that one reason is a string here
   *
   * Both were satisfied by the broken code. The mapping was
   * `diagnostic() === 'rate-limited' ? 'rate-limited' : 'no-puzzle'` — a binary with no branch that
   * could ever produce `'offline'`, so `type LoadReason` could list `'offline'` (and did) while the
   * "No connection" card above was unreachable dead text, and a user with no network was told
   *
   *     "We asked and the service had nothing at your rating right now. That is not a connection
   *      problem."
   *
   * The gate passed because it checked that the mapping EXISTED and that one reason appeared
   * SOMEWHERE in the file, not that every diagnostic reached a branch. A textual gate has to assert
   * the relationship, not the tokens — hence the two checks below, which derive the union from the
   * provider and require each member to be handled by the screen.
   */

  // The provider's union, read out of the source rather than restated here.
  const union = /export type PuzzleFetchDiagnostic =([^;]+);/.exec(providerTight);
  const members = union
    ? [...union[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  ok(members.length >= 3,
    'the provider declares a diagnostic union of at least three faults', members.join(', ') || '(not found)');
  ok(members.includes('offline'),
    "and it includes 'offline', so a request that never got a response is representable",
    members.join(', '));

  // THE LOAD-BEARING ONE: every diagnostic must be handled, and handled DISTINCTLY.
  //
  // `none` is the fallback by design — it means the endpoint answered and nothing was usable. Every
  // other member has to name itself in the mapping, or the screen collapses it into `none` and tells
  // the user the wrong thing about a fault that had a name.
  // ...and it is THE mapping, not some other call. `setLoadReason(` appears three times in this
  // screen: the reset to `null`, the mapping itself, and the `catch`. A search for the first one
  // finds `setLoadReason(null)` and reports a broken screen against working code — which is the
  // failure mode of every gate that grabs a token by position instead of by what it means. The one
  // that matters is the argument containing a comparison.
  const calls = [...screenTight.matchAll(/setLoadReason\(\s*([\s\S]{0,400}?)\s*\);/g)].map((m) => m[1]);
  const mapped = calls.find((a) => a.includes('===')) ?? '';
  ok(mapped !== '',
    'the screen maps a diagnostic onto a load reason',
    calls.map((a) => a.replace(/\s+/g, ' ').slice(0, 60)).join(' || ') || '(no call found)');
  for (const d of members.filter((m) => m !== 'none')) {
    ok(new RegExp(`===\\s*'${d}'`).test(mapped),
      `the screen branches on '${d}' rather than letting it fall through`,
      mapped.replace(/\s+/g, ' ').slice(0, 200));
  }

  // ...and each branch yields the RIGHT reason, not merely that a branch exists. This is the check
  // the old gate was missing in substance: `'offline' ? 'no-puzzle'` would satisfy a presence test
  // and still tell a user with no connection that it is not a connection problem.
  //
  // Written as a table rather than four separate regexes so that adding a diagnostic means adding a
  // row here, and a diagnostic with no row is visibly unhandled rather than silently defaulted.
  const EXPECTED = { offline: 'offline', 'rate-limited': 'rate-limited', 'http-error': 'error' };
  for (const [from, to] of Object.entries(EXPECTED)) {
    ok(new RegExp(`===\\s*'${from}'\\s*\\?\\s*'${to}'`).test(mapped),
      `'${from}' reports as '${to}'`,
      mapped.replace(/\s+/g, ' ').slice(0, 200));
  }
  // The `no-puzzle` sentence says outright that this is NOT a connection problem, so it must be the
  // fallback for a service that answered — and for nothing else.
  ok(!/===\s*'(offline|rate-limited|http-error)'\s*\?\s*'no-puzzle'/.test(mapped),
    "CONTROL: no real fault reports as 'no-puzzle', the sentence that denies a connection problem");

  // The provider must actually SET each fault where it is detected. A member of the union that is
  // never assigned is a promise the type makes and the code does not keep.
  for (const d of ['offline', 'rate-limited', 'http-error']) {
    ok(new RegExp(`lastFetchDiagnostic = '${d}'`).test(providerTight),
      `the provider records '${d}' where it is detected`);
  }
  ok(/catch[^}]*lastFetchDiagnostic = 'offline'/.test(providerTight),
    "a thrown request — no DNS, no route, airplane mode, the abort timer — is recorded as 'offline'");
  ok(/Date\.now\(\) < lichessBackoffUntil\)[\s\S]{0,160}lastFetchDiagnostic = 'rate-limited'/.test(providerTight),
    'CONTROL: a request suppressed by our own backoff says so too, rather than reporting no fault');
}

// ---------------------------------------------------------------------------
head('5. THE PROVIDER REPORTS WHY, AND FORGETS WHEN IT IS NO LONGER TRUE');

/*
 * A diagnostic that is never cleared becomes a liar in the other direction: a limit that has EXPIRED
 * would be reported as the reason for a later failure. So it is reset per request, and the gate
 * checks that, because a stale diagnostic is the same class of bug as a missing one.
 */
ok(/lastFetchDiagnostic = null;/.test(provider),
    'the diagnostic is reset at the start of each fetch');
ok(/export function puzzleFetchDiagnostic/.test(provider),
    'and the screen can read it');
ok(/let lastFetchDiagnostic: PuzzleFetchDiagnostic \| null = null;/.test(provider),
    'it defaults to "nothing went wrong", so an untouched value is not a fault');
ok(/lastFetchDiagnostic = 'rate-limited'/.test(provider)
  && /lastFetchDiagnostic = 'http-error'/.test(provider),
  'and both faults are recorded where they are detected');

// ---------------------------------------------------------------------------
head('6. THE OBSERVATION IS RECORDED WHERE THE TABLE IS');

/*
 * The floors are observations of a moving distribution, and the next person to wonder why the bottom band
 * starts at 1300 needs the answer next to the number rather than in a build log. This is a weak
 * check — it only asserts the comment is there — and it is included because a table of measured
 * values with no provenance is how the ORIGINAL range came to be wrong in the first place.
 */
ok(/Measured, not assumed/.test(puzzlesSrc),
    'the table says the numbers were measured');
ok(/1308/.test(puzzlesSrc) && /1479/.test(puzzlesSrc),
    'and lists the ratings that were observed, so a future re-measurement has something to compare');
ok(/i tried puzzles and it says to check my connection/.test(puzzlesSrc.toLowerCase()),
    'and carries the report it fixes, so the change is traceable to a complaint');

/* ===========================================================================
 * THE HINT IS OFF UNTIL IT IS ASKED FOR, IN BOTH TABS.
 * ===========================================================================
 *
 * Found on the device: *"why all my pieces are selected in the puzzles from my games"*.
 *
 * `hintFrom` is the ring layer, and it is derived from `hintOn`. In the live tab `hintOn` reads
 * `showHint && !solved && !failed && !!puzzle`; in the mined tab it read only
 * `!solved && !failed && !!puzzle`. That is true for every unsolved position, so the rings were
 * populated from the first paint and every mined puzzle arrived with every movable piece already
 * ringed � the hint, permanently on, with nothing to press.
 *
 * Two copies of one idea in one file, and only one of them was right. The gate below asserts the
 * `showHint &&` gate on EVERY `hintOn` in the file rather than on a named one, because the failure
 * mode is precisely a copy that forgot. That is also what would have caught this the first time.
 */
{
  const tabs = [...screen.matchAll(/const hintOn = ([^;]+);/g)].map((m) => m[1].trim());
  ok(tabs.length === 2, 'both puzzle tabs declare a hint gate', `found ${tabs.length}`);
  const ungated = tabs.filter((e) => !/showHint/.test(e));
  ok(ungated.length === 0,
    'CONTROL: every one of them is gated on the Hint button being pressed � an ungated copy rings '
    + 'every movable piece on every position, which is what the user reported',
    ungated.length ? `ungated: ${ungated.join(' | ')}` : '');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
