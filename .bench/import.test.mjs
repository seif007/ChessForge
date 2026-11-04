/**
 * ONE IMPORT, TWO DOORS — the shared scan plan, the in-place connect/import card, and the
 * driver's contract, proven on the compiled source.
 *
 * WHY THIS EXISTS
 * ===============
 * The owner's request was that "From your games" in Puzzles and the empty state of Your openings
 * let the user CONNECT AND IMPORT IN PLACE — they used to be told "Connect a Lichess account on
 * the Stats tab, then come back", which asks the user to leave the thing they were doing. The
 * risk in granting that is obvious: a second copy of a multi-hour engine pipeline, drifting from
 * the first the moment either side is tuned, with the two decks disagreeing about the same
 * account.
 *
 * THE SHAPE THIS GATE HOLDS
 * -------------------------
 *   1. ONE PLAN, ONE DRIVER. Constants, filters, merge and the scan loop live in
 *      `src/lib/scanPlan.ts`. Only two surfaces call `importGames`: Stats, which keeps its
 *      detailed progress row, and the small in-place card. No screen defines a scan constant.
 *   2. TWO DOORS, BOTH IN PLACE. Each empty state renders the card; the old "go to Stats" copy is
 *      gone from code; Puzzles reloads the mined deck when the import ends, Your openings fires
 *      its own build on connect.
 *   3. THE CARD OBEYS THE HOUSE RULES the Stats screen learned: the account is persisted before
 *      any fetch, a switch wipes the previous account first, a failed engine boot is retried
 *      (`restart`) and reported, and the games come from cache unless it is stale.
 *   4. THE CONTRACT IS EXECUTED, NOT DESCRIBED. Section 4 compiles the REAL `scanPlan.ts` against
 *      a scripted game scanner and store and drives the run: what is kept, what is persisted and
 *      when, what stop does, what mining merges, and what `complete` means at each boundary.
 *
 * Run: node .bench/import.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comments stripped, so a claim in a comment can never satisfy a claim about code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
/** Whitespace collapsed, for the checks that measure a DISTANCE. */
const tight = (p) => code(p).replace(/[ \t]+/g, ' ');

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
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const planSrc = tight('src/lib/scanPlan.ts');
const cardSrc = tight('src/components/GameImportInline.tsx');
const statsSrc = tight('src/components/screens/StatsScreen.tsx');
const jobsSrc = tight('src/lib/statsJobs.ts');
const puzzlesSrc = tight('src/components/screens/PuzzlesScreen.tsx');
const openingsSrc = tight('src/components/screens/GameOpeningsScreen.tsx');
const ccStoreSrc = tight('src/lib/lichessStore.ts');

function filesWith(needle) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      // Comments are stripped before the search: a control about which MODULES call a helper must
      // not be satisfied — or broken — by prose that merely names it.
      const src = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (src.includes(needle)) {
        hits.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return hits.sort();
}

// ---------------------------------------------------------------------------
head('1. ONE PLAN, ONE DRIVER — AND NO SCREEN WITH A SECOND COPY OF IT');

ok(/export const SCAN_GAMES = 200;/.test(planSrc)
  && /export const SCAN_DEPTH = 8;/.test(planSrc)
  && /export const SCAN_MAX_PLIES = 40;/.test(planSrc)
  && /export const MINED_PUZZLE_LIMIT = 240;/.test(planSrc)
  && /export const MINE_DEPTH = 12;/.test(planSrc)
  && /export const MINE_MAX_PLY = 40;/.test(planSrc)
  && /export const MINE_EVERY = 20;/.test(planSrc),
  'every scan constant is defined once, in the shared plan');
ok(/export function keptScanGames\(games: readonly LichessGame\[\]\): LichessGame\[\] \{/.test(planSrc)
  && /\.filter\(\(g\) => g\.rated && g\.timeClass !== 'bullet' && g\.movesSan\.length >= 4\)/.test(planSrc)
  && /\.slice\(0, SCAN_GAMES\);/.test(planSrc),
  'what a scan reads is a named filter — rated, non-bullet, real moves, capped — not inline at a '
  + 'call site');
ok(/export function mergeMinedPuzzles\(previous: readonly MinedPuzzle\[\], mined: readonly MinedPuzzle\[\]\): MinedPuzzle\[\] \{/.test(planSrc)
  && /\.sort\(\(a, b\) => b\.lossCp - a\.lossCp\)/.test(planSrc)
  && /\.slice\(0, MINED_PUZZLE_LIMIT\);/.test(planSrc),
  'and how the deck grows is a named merge — idempotent by id, hardest first, capped');
ok(/export async function importGames\(/.test(planSrc)
  && /const kept = keptScanGames\(games\);/.test(planSrc),
  'the driver itself takes the fetched games and applies the same kept filter');

/*
 * THE ARCHITECTURAL CONTROL. `importGames` is the only way an import runs, and
 * one module is allowed to call it: `lib/statsJobs`. The screen and the in-place
 * card both start that job, so a scan keeps running when either surface
 * unmounts and the two cannot race each other.
 */
const importCallers = filesWith('importGames');
ok(importCallers.join(', ')
  === 'src/lib/scanPlan.ts, src/lib/statsJobs.ts',
  `CONTROL: only the shared job module calls importGames — got: ${importCallers.join(', ') || 'none'}`);
ok(/from '@\/lib\/statsJobs'/.test(statsSrc) && /startScanJob\(/.test(statsSrc)
  && /import \{ SCAN_GAMES \} from '@\/lib\/scanPlan';/.test(statsSrc),
  'Stats starts the shared scan job and keeps only the cap for its copy');
ok(!/from '@\/lib\/gameScan'/.test(statsSrc.replace(/type ScanRecord[^\n]*/, '')),
  'and no longer reaches into the scanner directly');
ok(!/\.filter\(\(g\) => g\.rated/.test(statsSrc),
  'CONTROL: the kept-games filter does not exist in the Stats screen any more');
ok(/const outcome = await importGames\(name, list, \{/.test(jobsSrc)
  && /shouldStop: \(\) => signal\.aborted,/.test(jobsSrc)
  && /onProgress: \(p: ImportProgress\) => \{[\s\S]{0,500}?pct: p\.fraction/.test(jobsSrc),
  'the job drives the driver with its abort signal and publishes the driver-reported phase');

for (const [name, src] of [['Stats', statsSrc], ['Puzzles', puzzlesSrc], ['Your openings', openingsSrc], ['the card', cardSrc]]) {
  ok(!/const (SCAN_GAMES|SCAN_DEPTH|SCAN_MAX_PLIES|MINED_PUZZLE_LIMIT|MINE_DEPTH|MINE_MAX_PLY|MINE_EVERY)\b/.test(src),
    `CONTROL: ${name} defines no scan constant of its own`);
}

ok(/export async function loadMinedDeck\(\): Promise<\{ username: string \| null; puzzles: ScanState\['puzzles'\] \}> \{/.test(ccStoreSrc),
  'the deck read is one helper in the store — active account plus its mined deck');
const deckReaders = filesWith('loadMinedDeck');
ok(deckReaders.join(', ') === 'src/components/screens/GameOpeningsScreen.tsx, src/components/screens/PuzzlesScreen.tsx, src/lib/lichessStore.ts',
  `CONTROL: only the two derived surfaces read the deck through it — got: ${deckReaders.join(', ') || 'none'}`);

// ---------------------------------------------------------------------------
head('2. TWO EMPTY STATES THAT CONNECT AND IMPORT IN PLACE — NOBODY IS SENT TO STATS');

ok(/import \{ GameImportInline \} from '@\/components\/GameImportInline';/.test(puzzlesSrc)
  && /import \{ GameImportInline \} from '@\/components\/GameImportInline';/.test(openingsSrc),
  'both screens import the card');
ok(/if \(puzzles\.length === 0\) \{[\s\S]{0,900}?<GameImportInline[\s\S]{0,300}?what="puzzles"[\s\S]{0,200}?importsGames[\s\S]{0,200}?onChanged=\{\(\) => void readDeck\(\)\}/.test(puzzlesSrc),
  'the From-your-games empty state hosts the card, runs the scan, and reloads the deck when it ends');
ok(/if \(phase === 'empty'\) \{[\s\S]{0,1200}?<GameImportInline[\s\S]{0,300}?what="an openings report"[\s\S]{0,400}?onChanged=\{\(\) => void build\(true\)\}/.test(openingsSrc),
  "Your openings' empty state hosts the card and fires its own build on connect — that build IS "
  + 'its import');
ok(!/Run Analyse on the Stats tab/.test(code('src/components/screens/PuzzlesScreen.tsx')),
  'CONTROL: the "go to Stats" instruction is gone from the Puzzles empty state');
ok(!/Connect a chess\.com account on the Stats tab/.test(code('src/components/screens/GameOpeningsScreen.tsx')),
  'and from the Your openings empty state');

const cardImporters = filesWith("from '@/components/GameImportInline'");
ok(cardImporters.join(', ') === 'src/components/screens/GameOpeningsScreen.tsx, src/components/screens/PuzzlesScreen.tsx',
  `CONTROL: exactly two screens mount the card and no others — got: ${cardImporters.join(', ') || 'none'}`);
ok(/await loadMinedDeck\(\)/.test(puzzlesSrc)
  && /if \(!alive\(\)\) return;[\s\S]{0,800}?setPuzzles\(playable\)/.test(puzzlesSrc),
  'the mount load and the post-import reload go through the one deck reader');

// ---------------------------------------------------------------------------
head('3. THE CARD OBEYS THE RULES THE IN-PLACE FLOW CANNOT SKIP');

/*
 * ONE IMPORT IS ENOUGH EVERYWHERE.
 *
 * THE REPORT: *"i imported the games in stats then went to your openings and it
 * told me to import the games! if i did import in a page i shouldn't redo in the
 * other page"*. Your openings always re-fetched; a rate-limited second request
 * collapsed into the "import your games" card. It now reads the game list the
 * import already cached, and only touches the network for an explicit refresh.
 */
ok(/const stored = opts\.force \? null : await loadCachedGames\(user\);[\s\S]{0,900}?games = stored\.games;[\s\S]{0,600}?fetchAllGames\(user,/.test(openingsSrc),
  'Your openings reuses the cached game list from the import instead of re-downloading it');

ok(/if \(!getEngine\(\)\.isReady\) getEngine\(\)\.restart\('retry from the Stats scan'\);/.test(jobsSrc)
  && /await getEngine\(\)\.init\(\);/.test(jobsSrc)
  && /The chess engine did not start/.test(jobsSrc),
  'a failed engine boot is retried in the shared job and said out loud');
ok(/if \(account && account !== resolved\) \{[\s\S]{0,160}?cancelJob\(SCAN_JOB\);[\s\S]{0,100}?await forgetAccount\(account\);[\s\S]{0,600}?await saveAccount\(\{/.test(cardSrc),
  'switching accounts cancels the old scan and wipes the old identity BEFORE the new one is saved');
ok(cardSrc.indexOf('await saveAccount(') < cardSrc.indexOf('onChanged();'),
  'and the account is persisted before anything (including a host rebuild) is told it changed');
ok(/const cached = await loadCachedGames\(name\);/.test(jobsSrc)
  && /gamesCacheIsStale\(cached\) \? cached\.games : null/.test(jobsSrc)
  && /await fetchAllGames\(name, \{[\s\S]{0,260}?maxGames: SCAN_GAMES,[\s\S]{0,120}?signal/.test(jobsSrc),
  'the job uses a fresh cached list as-is; the network is only touched when it is missing or old');
ok(/const outcome = await importGames\(name, list, \{/.test(jobsSrc)
  && /records: stored\.records,/.test(jobsSrc)
  && /shouldStop: \(\) => signal\.aborted,/.test(jobsSrc),
  'the job runs the SAME driver, resuming from the stored records and stopping on its signal');
ok(/setStage\(job\.result\.stopped \? 'idle' : 'done'\)[\s\S]{0,300}?onChanged\(\);/.test(cardSrc),
  'reload fires whether the import finished or the user stopped it — a stopped import is still the '
  + 'part that is done');
ok(/const stop = useCallback\(\(\) => \{ cancelJob\(SCAN_JOB\); \}, \[\]\);/.test(cardSrc)
  && /<Btn label="Stop" variant="ghost" onPress=\{stop\} \/>/.test(cardSrc),
  'and Stop is wired to the job signal, which the driver polls between games');
ok(!/from '@\/lib\/gameScan'/.test(cardSrc),
  'CONTROL: the card never reaches into the scanner — only through the shared job');

// ---------------------------------------------------------------------------
head('4. THE DRIVER RUNS ITS CONTRACT — PROVEN ON THE COMPILED PLAN AGAINST A SCRIPTED SCANNER');

const BUILD_DIR = path.join(ROOT, 'node_modules', '.cache', 'chessforge-import');
try { execFileSync('rm', ['-rf', BUILD_DIR], { stdio: 'pipe' }); } catch { /* best effort */ }
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.writeFileSync(path.join(BUILD_DIR, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2021', module: 'commonjs', skipLibCheck: true, noEmitOnError: false,
    esModuleInterop: true,
    paths: { '@/*': ['../../../src/*'] }, rootDir: ROOT, outDir: BUILD_DIR,
  },
  files: [path.join(ROOT, 'src', 'lib', 'scanPlan.ts')],
}, null, 2));
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project',
    path.join(BUILD_DIR, 'tsconfig.json'),
  ], { stdio: 'pipe' });
} catch (e) {
  console.error('tsc failed:', e.stdout?.toString()?.slice(0, 2500));
  process.exit(2);
}

/*
 * THE SCANNER AND THE STORE ARE NOT WHAT THIS SECTION IS ABOUT. Scripted fakes stand in for both
 * so the driver's own decisions — filtering, persistence boundaries, stop semantics, mining and
 * merging, the `complete` flag — are what actually runs, not something paraphrased.
 */
const log = { runs: [], mine: [], saves: [], records: [], cleared: [], progress: [] };
const mkGame = (id, over = {}) => ({
  id, rated: true, timeClass: 'blitz', movesSan: ['e4', 'e5', 'Nf3', 'Nc6'], color: 'w', ...over,
});
const gameScanStub = {
  async runGameScan(games, done, opts) {
    log.runs.push({ ids: games.map((g) => g.id), recordsAtStart: Object.keys(done).length });
    const records = { ...done };
    let scanned = 0;
    for (let i = 0; i < games.length; i += 1) {
      if (opts.shouldStop?.()) {
        return { records, summary: { scanned, failed: 0, skipped: 0, stopped: true } };
      }
      const rec = { gameId: games[i].id, depthReached: 8 };
      records[games[i].id] = rec;
      scanned += 1;
      opts.onGame?.(rec, scanned, games.length);
      if (i === 0) opts.onPly?.(games[i].id, 2, 4, 0, games.length);
      if (opts.batchEvery && scanned % opts.batchEvery === 0) {
        await opts.onBatch?.(records, { scanned, failed: 0, skipped: 0, stopped: false });
      }
    }
    return { records, summary: { scanned, failed: 0, skipped: 0, stopped: false } };
  },
  async minePuzzles(games, records, opts) {
    log.mine.push({
      total: games.length,
      recordsSeen: Object.keys(records).length,
      limit: opts.limit,
      depth: opts.depth,
      maxPly: opts.maxPly,
    });
    const out = [];
    for (const g of games) {
      if (!records[g.id]) continue;
      const n = parseInt(String(g.id).replace(/\D+/g, ''), 10) || 0;
      out.push({
        id: `${g.id}:0`, gameId: g.id, ply: 0,
        fen: '8/8/8/8/8/8/8/8 w - - 0 1', lossCp: 50 + n, bestSan: 'Qh5', playedSan: 'Nf3', kind: 'mistake',
      });
    }
    opts.onProgress?.(out.length);
    return out;
  },
};
let stored = { records: {}, puzzles: [], totalGames: 0, complete: false, updatedAt: 0 };
const lichessStoreStub = {
  async loadScanState() {
    return { ...stored, records: { ...stored.records }, puzzles: stored.puzzles.slice() };
  },
  async saveScanState(username, state) {
    stored = { ...state };
    log.saves.push({ username, complete: state.complete, records: Object.keys(state.records).length, puzzles: state.puzzles.length });
  },
  async saveScanRecords(username, records, totalGames, complete) {
    log.records.push({ username, complete, totalGames, count: Object.keys(records).length });
    stored = { ...stored, records: { ...records }, totalGames };
  },
  async clearCachedPositions(username) { log.cleared.push(username); },
};

const Module = require('node:module');
const origLoad = Module._load;
const runtimeStubs = { '@/lib/gameScan': gameScanStub, '@/lib/lichessStore': lichessStoreStub };
Module._load = function (request, parent, isMain) {
  if (runtimeStubs[request]) return runtimeStubs[request];
  if (typeof request === 'string' && request.startsWith('@/')) {
    return origLoad.call(this, path.join(BUILD_DIR, 'src', request.slice(2)), parent, isMain);
  }
  return origLoad.call(this, request, parent, isMain);
};

const plan = require(path.join(BUILD_DIR, 'src', 'lib', 'scanPlan.js'));
const resetLog = () => {
  log.runs.length = 0; log.mine.length = 0; log.saves.length = 0;
  log.records.length = 0; log.cleared.length = 0; log.progress.length = 0;
};

// (a) the kept filter, exercised directly: rated + non-bullet + real moves, newest first, capped.
const wide = [];
for (let i = 0; i < 205; i += 1) wide.push(mkGame(`g${i}`));
wide[3] = mkGame('g3', { rated: false });
wide[4] = mkGame('g4', { timeClass: 'bullet' });
wide[5] = mkGame('g5', { movesSan: ['e4', 'e5'] });
const kept = plan.keptScanGames(wide);
ok(kept.length === 200 && kept[0].id === 'g0' && kept[1].id === 'g1' && kept[2].id === 'g2'
  && kept[3].id === 'g6',
  'the kept list is rated non-bullet games with real moves, newest first, capped at 200',
  `len=${kept.length} head=${kept.slice(0, 5).map((g) => g.id).join(',')}`);
ok(!kept.some((g) => g.id === 'g3' || g.id === 'g4' || g.id === 'g5'),
  'and nothing the filter rejects is in it');

// (b) the merge, exercised directly: replace by id, hardest first, capped.
const merged = plan.mergeMinedPuzzles(
  [{ id: 'a:1', lossCp: 10 }, { id: 'b:1', lossCp: 900 }],
  [{ id: 'a:1', lossCp: 500 }, { id: 'c:1', lossCp: 100 }],
);
ok(merged.map((p) => p.id).join(',') === 'b:1,a:1,c:1' && merged[1].lossCp === 500,
  'a repeated id replaces its earlier puzzle in place; the deck sorts by loss, hardest first',
  JSON.stringify(merged.map((p) => [p.id, p.lossCp])));
const big = [];
for (let i = 0; i < 260; i += 1) big.push({ id: `x:${i}`, lossCp: i });
const capped = plan.mergeMinedPuzzles([], big);
ok(capped.length === 240 && capped[0].lossCp === 259 && capped[239].lossCp === 20,
  'and the deck cannot grow past its cap - the hardest 240 survive');

// The cap must not let a retired one-move record hide a real line, even when the old record has a
// much larger loss. Playable records are ordered first; legacy records only fill leftover room.
const withLegacy = plan.mergeMinedPuzzles(
  [
    { id: 'legacy:1', lossCp: 9000 },
    {
      id: 'line:1', lossCp: 10,
      solution: [
        { uci: 'e2e4', san: 'e4' }, { uci: 'e7e5', san: 'e5' }, { uci: 'g1f3', san: 'Nf3' },
      ],
    },
  ],
  [],
);
ok(withLegacy[0].id === 'line:1' && withLegacy.length === 2,
  'a playable forced line is kept ahead of a legacy one-move record, whatever its loss',
  JSON.stringify(withLegacy.map((p) => p.id)));

// (c) a full clean run on four kept games.
resetLog();
stored = { records: {}, puzzles: [], totalGames: 0, complete: false, updatedAt: 0 };
const games = [mkGame('g1'), mkGame('g2'), mkGame('g3'), mkGame('g4')];
const outcome = await plan.importGames('alice', games, {
  records: {},
  onProgress: (p) => log.progress.push(p),
});
ok(log.runs.length === 1 && log.runs[0].ids.join(',') === 'g1,g2,g3,g4',
  'the scanner is handed exactly the kept games, once');
ok(log.records.length === 4
  && log.records.every((r) => r.complete === false && r.totalGames === 4 && r.username === 'alice'),
  'every finished game is persisted as it lands, never as complete — a kill here must resume');
ok(log.runs[0].recordsAtStart === 0, 'the run starts from the caller\'s stored records');
ok(outcome.records && Object.keys(outcome.records).length === 4
  && outcome.scanned === 4 && outcome.stopped === false && outcome.puzzles === 4,
  'the outcome reports what happened, what it read and how big the deck became',
  JSON.stringify(outcome));
ok(log.mine.length === 1 && log.mine[0].recordsSeen === 4 && log.mine[0].limit === 240
  && log.mine[0].depth === 12 && log.mine[0].maxPly === 40,
  'a clean run ends with one full mining pass at mining depth over every record');
ok(log.cleared.join(',') === 'alice',
  'the derived positions cache is dropped when the scan changes the truth');
const lastSave = log.saves[log.saves.length - 1];
ok(lastSave.complete === true && lastSave.puzzles === 4 && log.saves[0].complete === true,
  'the stored scan is marked complete once the final mining pass has landed',
  JSON.stringify(log.saves));
const phases = log.progress.map((p) => p.phase);
ok(phases.some((p) => p === 'Analysing your games… (1/4)'),
  'progress talks in games done over games total, for the bar');
ok(phases.some((p) => p === 'Analysing game 1 of 4 — move 2 of 4'),
  'and inside a game, so a slow game is visible work rather than a hang');
ok(log.progress.some((p) => /Puzzles so far: \d+/.test(p.phase) && p.puzzles != null),
  'the mining pass reports the deck size it reached, mid-run included');

// (d) stop between games: everything paid for survives, nothing claims to be complete.
resetLog();
stored = { records: {}, puzzles: [], totalGames: 0, complete: false, updatedAt: 0 };
let stop = false;
const stoppedOutcome = await plan.importGames('alice', games, {
  records: {},
  onProgress: (p) => { if (p.gamesSoFar >= 2 && p.puzzles == null && p.fraction != null) stop = true; },
  shouldStop: () => stop,
});
ok(stoppedOutcome.stopped === true && stoppedOutcome.scanned === 2,
  'stopping is polled between games and leaves a consistent partial run', JSON.stringify(stoppedOutcome));
ok(log.records.length === 2 && log.records.every((r) => r.complete === false),
  'the two finished games are kept — stopping does not throw away work');
ok(log.saves.length === 1 && log.saves[0].complete === false,
  'the stored scan is NOT marked complete: a killed app must resume, not look finished',
  JSON.stringify(log.saves));
ok(log.mine.length === 0 && log.cleared.length === 1,
  'no final mining pass runs, but the derived cache is still invalidated by what did change');

// (e) a long run mines as it goes: batches at 20 and 40, full pass at the end.
resetLog();
stored = {
  records: {}, totalGames: 0, complete: false, updatedAt: 0,
  puzzles: [{ id: 'old:0', gameId: 'old', ply: 0, fen: 'FEN', lossCp: 9999, bestSan: 'Qh5', playedSan: 'Nf3', kind: 'blunder' }],
};
const many = [];
for (let i = 0; i < 45; i += 1) many.push(mkGame(`m${i}`));
const long = await plan.importGames('bob', many, { records: {} });
ok(log.mine.length === 3 && log.mine.map((m) => m.recordsSeen).join(',') === '20,40,45',
  'mining runs every batch AND once at the end, each time over everything scanned so far',
  JSON.stringify(log.mine.map((m) => m.recordsSeen)));
ok(long.puzzles === 46,
  'the pre-existing deck survives the merge and every mined position joins it', String(long.puzzles));
const midSaves = log.saves.filter((s) => s.complete === false);
ok(midSaves.length >= 2 && midSaves.every((s) => s.puzzles >= 20),
  'mid-run saves carry the merged deck and stay explicitly incomplete', JSON.stringify(log.saves));
ok(log.saves[log.saves.length - 1].complete === true,
  'and the run still ends complete');

// (f) nothing scanned before (first run, no games pass the filter).
resetLog();
stored = { records: {}, puzzles: [], totalGames: 0, complete: false, updatedAt: 0 };
const empty = await plan.importGames('carol', [mkGame('u1', { rated: false })], { records: {} });
ok(empty.scanned === 0 && empty.stopped === false && log.runs[0].ids.length === 0,
  'games that do not pass the filter are never handed to the engine at all');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);
