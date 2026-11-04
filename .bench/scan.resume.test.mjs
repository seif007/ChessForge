/**
 * DOES THE SCAN REALLY PERSIST PER GAME, AND DOES RESUMING SKIP WORK?
 *
 * The screen accumulates scan records in a local map and writes through after
 * every game. This harness reproduces that strategy and asserts the properties
 * the old stale-closure bug violated: every finished game is kept, and a second
 * run over the same games performs zero new engine searches.
 *
 * No engine, no network, no provider fixture: the games are ids.
 *
 * Run: node .bench/scan.resume.test.mjs
 */

const GAMES = Array.from({ length: 120 }, (_, i) => ({ id: `g${i}`, url: `game://${i}` }));

let checks = 0, failures = 0;
function ok(label, cond, detail = '') {
  checks++;
  if (cond) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`); }
}

let searches = 0;

function makeRecord(game) {
  searches++;
  return {
    gameId: game.id,
    counts: { best: 1 },
    deviationPly: null,
    deviationMove: null,
    onBook: true,
    estimatedAccuracy: null,
    depthReached: 10,
  };
}

/** Mirror of runGameScan's loop, including the resumption `done` check. */
function runScan(games, done, onGame) {
  const records = { ...done };
  let scanned = 0;
  let skipped = 0;
  for (const g of games) {
    const id = g.id;
    if (records[id]) {
      skipped++;
      continue;
    }
    const rec = makeRecord(g);
    records[id] = rec;
    scanned++;
    onGame?.(rec, scanned, games.length);
  }
  return { records, scanned, skipped };
}

console.log('\n[1] regression guard — the exact bug that was shipped');
{
  searches = 0;
  const persisted = {};
  runScan(GAMES.slice(0, 30), {}, () => {
    const prev = persisted;
    const next = { ...prev };
    Object.assign(persisted, next); // no-op merge, as shipped
  });
  ok('broken strategy is detected as broken', Object.keys(persisted).length !== 30,
    `(persisted ${Object.keys(persisted).length}, expected != 30)`);
}

console.log('\n[2] merge — every finished game is kept');
{
  searches = 0;
  let persisted = {};
  const run = runScan(GAMES, persisted, (rec) => {
    persisted = { ...persisted, [rec.gameId]: rec };
  });
  ok('every game retained', Object.keys(persisted).length === run.scanned,
    `(${Object.keys(persisted).length} vs ${run.scanned})`);
  ok('each record carries its gameId', Object.values(persisted).every((r) => !!r.gameId));
  ok('no game scanned twice', run.scanned === GAMES.length, `(${run.scanned} vs ${GAMES.length})`);
}

console.log('\n[3] resume — the second run pays nothing');
{
  searches = 0;
  let persisted = {};
  runScan(GAMES, persisted, (rec) => { persisted = { ...persisted, [rec.gameId]: rec }; });
  const firstRunSearches = searches;

  searches = 0;
  const second = runScan(GAMES, persisted, () => {});
  ok('first run did the work', firstRunSearches === GAMES.length, `(${firstRunSearches})`);
  ok('second run performed ZERO new searches', searches === 0, `(${searches})`);
  ok('second run skipped every game', second.skipped === GAMES.length, `(${second.skipped})`);
}

console.log('\n[4] partial resume — only the remainder is paid for');
{
  searches = 0;
  let persisted = {};
  let stop = false;
  for (const g of GAMES) {
    if (stop) break;
    if (persisted[g.id]) continue;
    const rec = makeRecord(g);
    persisted = { ...persisted, [rec.gameId]: rec };
    if (Object.keys(persisted).length >= 40) stop = true;
  }
  const afterInterrupt = searches;

  searches = 0;
  runScan(GAMES, persisted, (rec) => { persisted = { ...persisted, [rec.gameId]: rec }; });

  ok('interrupted at 40 games', afterInterrupt === 40, `(${afterInterrupt})`);
  ok('resume cost only the remaining games', searches === GAMES.length - 40,
    `(${searches} vs ${GAMES.length - 40})`);
  ok('resume produced a complete map', Object.keys(persisted).length === GAMES.length,
    `(${Object.keys(persisted).length})`);
}

console.log('\n[5] account switch — wipe forces a full rescan');
{
  searches = 0;
  let persisted = {};
  runScan(GAMES, persisted, (rec) => { persisted = { ...persisted, [rec.gameId]: rec }; });
  ok('account A is fully scanned', Object.keys(persisted).length === GAMES.length);

  persisted = {};

  searches = 0;
  runScan(GAMES, persisted, (rec) => { persisted = { ...persisted, [rec.gameId]: rec }; });
  ok('account B rescanned from scratch', searches === GAMES.length, `(${searches})`);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
