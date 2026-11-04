/*
 * MUTATION PROOF FOR A GATE.
 *
 * A gate that passes proves nothing on its own: it passes just as happily when the code it describes
 * is wrong. The question a gate has to answer is "would you have caught it if it broke", and the only
 * way to answer that is to break it and watch the gate complain.
 *
 * This reverts each fix in turn, runs the gate, and requires the gate to FAIL. A mutation that leaves
 * the gate green is reported as a failure of the GATE, not of the fix.
 *
 * The source file is snapshotted byte-for-byte before every mutation and restored in a `finally`, so
 * an interrupted run cannot leave the tree dirty. Nothing here is a `*.test.mjs` because these
 * mutations WRITE to src/: it must never be picked up by `run-gates.mjs`.
 *
 *   node scripts/mutate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = (...p) => path.join(ROOT, 'src', 'components', 'screens', ...p);
const CP = (...p) => path.join(ROOT, 'src', 'components', ...p);
const L = (...p) => path.join(ROOT, 'src', 'lib', ...p);
const C = (...p) => path.join(ROOT, 'src', 'components', 'chess', ...p);
const E = (...p) => path.join(ROOT, 'src', 'engine', ...p);

const GATE = '.bench/train.hint.test.mjs';
const COACHBOT_GATE = '.bench/coachbot.test.mjs';
const COACH_APP_GATE = '.bench/coach.app.test.mjs';
const COACH_CORE_GATE = '.bench/coach.core.test.mjs';
const BACKGROUND_GATE = '.bench/background.test.mjs';
/**
 * Each entry: revert ONE claim the gate makes, as an exact-text replacement.
 * `edits` is a list so a mutation can stay valid TypeScript (e.g. re-add an import).
 */
const MUTATIONS = [
  {
    name: 'train: the played move is not recorded',
    file: S('TrainScreen.tsx'),
    edits: [[`      setMistakeUci(m.from + m.to + (m.promotion ?? ''));`,
      `      void 0;`]],
  },
  {
    name: 'train: a mistake stops counting toward the pipeline cards',
    file: S('TrainScreen.tsx'),
    edits: [[`      setMistakesThisPass((n) => n + 1);`, `      void 0;`]],
  },
  {
    name: 'train: the notice after a wrong move describes a move that never happened',
    file: S('TrainScreen.tsx'),
    edits: [[`Try that position again - it returns later in the pass.`,
      `Play the line on - this position returns later.`]],
  },
  {
    name: 'train: the arrows never reach the board',
    file: S('TrainScreen.tsx'),
    edits: [[`            arrows={arrows}`, `            arrows={[]}`]],
  },
  {
    name: 'train: arrows drawn before a mistake, revealing the line',
    file: S('TrainScreen.tsx'),
    edits: [[`  if (phase !== 'playing' || !mistakeUci) return [];`,
      `  if (false) return [];`]],
  },
  {
    name: 'train: the hint rings every movable piece again',
    file: S('TrainScreen.tsx'),
    edits: [
      [`  () => (hintStage >= 1 ? solvingPiece(fen, sans[ply]) : []),`,
        `  () => (hintStage >= 1 ? movableSquares(fen) : []),`],
      [`import { solvingPiece, targetSquares } from '@/lib/hint';`,
        `import { movableSquares, solvingPiece, targetSquares } from '@/lib/hint';`],
    ],
  },
  {
    name: 'endgames: the hint rings the movable set instead of the engine move',
    file: S('EndgamesScreen.tsx'),
    edits: [[`    setHintPiece(square ? [square] : movableSquares(boardFen));`,
      `    setHintPiece(movableSquares(boardFen));`]],
  },
  {
    name: 'pieces: the captured square is not re-keyed',
    file: C('pieces.tsx'),
    edits: [[`  return <PieceArtwork key={piece} piece={piece} size={size} />;`,
      `  return <PieceArtwork piece={piece} size={size} />;`]],
  },
  {
    name: 'verdicts: the stored blob is trusted across versions',
    file: L('lichessStore.ts'),
    edits: [[`  if (!raw || raw.v !== VERDICTS_CACHE_VERSION) return null;`,
      `  if (!raw) return null;`]],
  },
  {
    name: 'verdicts: an empty map overwrites what the pass found',
    file: L('lichessStore.ts'),
    edits: [[`  if (Object.keys(families).length === 0) return;`,
      `  if (false) return;`]],
  },
  {
    name: 'your openings: stored verdicts are never restored',
    file: S('GameOpeningsScreen.tsx'),
    edits: [[`      if (analysedRef.current.size === 0) {`,
      `      if (false) {`]],
  },
  {
    name: 'your openings: an account switch keeps the old account in memory',
    file: S('GameOpeningsScreen.tsx'),
    edits: [[`        analysedRef.current = new Map();`, `        void 0;`]],
  },
  {
    name: 'your openings: verdicts are not written back',
    file: S('GameOpeningsScreen.tsx'),
    edits: [[`          void saveCachedVerdicts(
            username,
            Object.fromEntries(analysedRef.current.entries()),
          );`,
      `          void 0;`]],
  },
  {
    name: 'puzzles: the DECK hint button stays after the puzzle ends',
    file: S('PuzzlesScreen.tsx'),
    edits: [[`            {!solved && !failed ? (
              <IconBtn
                onPress={() => {`,
      `            {true ? (
              <IconBtn
                onPress={() => {`, 1]],
  },
  {
    name: 'puzzles: the LESSON hint button stays after the puzzle ends',
    file: S('PuzzlesScreen.tsx'),
    edits: [[`            {!solved && !failed ? (
              <IconBtn
                onPress={() => {`,
      `            {true ? (
              <IconBtn
                onPress={() => {`, 2]],
  },
  {
    name: 'stats: a refresh no longer invalidates the derived openings',
    file: L('statsJobs.ts'),
    edits: [[`    if (before != null && all.length !== before) {`,
      `    if (before != null && all.length === before) {`]],
  },
  {
    name: 'new data: a painted list never notices a refresh that added games',
    file: S('GameOpeningsScreen.tsx'),
    edits: [[`            || openingsCacheGameCountIsStale(cached, gamesNow?.games.length)`,
      `            || false`]],
  },
  {
    name: 'new data: an unknown game count is treated as stale',
    file: L('lichessStore.ts'),
    edits: [[`  if (typeof gameCount !== 'number') return false;`,
      `  if (typeof gameCount !== 'number') return true;`]],
  },
  {
    name: 'openings: the name parser goes back to the last path segment',
    file: L('lichess.ts'),
    gate: '.bench/openingbuilder.families.test.mjs',
    edits: [[`  const unknown: OpeningRef = { family: 'Unknown Opening', name: 'Unknown Opening', slug: '' };
  const marker = '/openings/';
  const at = ecoUrl ? ecoUrl.indexOf(marker) : -1;
  if (!ecoUrl || at < 0) return unknown;
  const slug = ecoUrl.slice(at + marker.length).split(/[/?#]/)[0];
  if (!slug) return unknown;`,
      `  const unknown: OpeningRef = { family: 'Unknown Opening', name: 'Unknown Opening', slug: '' };
  if (!ecoUrl) return unknown;
  const slug = ecoUrl.split('/').pop() ?? '';
  if (!slug) return unknown;`]],
  },
  {
    name: 'labels: the correction is dropped, so a fetched game keeps Lichess\'s name',
    file: L('lichess.ts'),
    gate: '.bench/openinglabel.test.mjs',
    edits: [[`  return correctedOpeningRef(source, sans);`,
      `  return source;`]],
  },
  {
    name: 'labels: any book match counts as evidence, however short',
    file: L('lichess.ts'),
    gate: '.bench/openinglabel.test.mjs',
    edits: [[`  if (!best || best.depth < MIN_LABEL_PLIES) return null;`,
      `  if (!best || best.depth < 1) return null;`]],
  },
  {
    name: 'labels: our verdict is never allowed to override the URL',
    file: L('lichess.ts'),
    gate: '.bench/openinglabel.test.mjs',
    edits: [[`  if (!ours || ours.toLowerCase() === source.family.toLowerCase()) return source;`,
      `  if (!ours || true) return source;`]],
  },
  {
    name: 'labels: stored games are never relabelled',
    file: L('lichessStore.ts'),
    gate: '.bench/openinglabel.cache.test.mjs',
    edits: [[`  if ((raw.labelsV ?? 0) !== OPENING_LABEL_VERSION) {`,
      `  if (false) {`]],
  },
  {
    name: 'labels: the migration stamps a fresh savedAt',
    file: L('lichessStore.ts'),
    gate: '.bench/openinglabel.cache.test.mjs',
    edits: [[`    const migrated: CachedGames = { ...raw, games, labelsV: OPENING_LABEL_VERSION };`,
      `    const migrated: CachedGames = { ...raw, games, labelsV: OPENING_LABEL_VERSION, savedAt: Date.now() };`]],
  },
  {
    name: 'labels: a freshly saved list is written as pre-migration',
    file: L('lichessStore.ts'),
    gate: '.bench/openinglabel.cache.test.mjs',
    edits: [[`    labelsV: OPENING_LABEL_VERSION,`, `    labelsV: 0,`, 1]],
  },
  {
    name: 'adoptions: reading falls back to the shared key for every account',
    file: L('lichessStore.ts'),
    gate: '.bench/adoptions.account.test.mjs',
    edits: [[`  const key = u ? CUSTOM_KEY(u) : CUSTOM_KEY_LEGACY;`,
      `  const key = CUSTOM_KEY_LEGACY;`]],
  },
  {
    name: 'adoptions: writing falls back to the shared key for every account',
    file: L('lichessStore.ts'),
    gate: '.bench/adoptions.account.test.mjs',
    edits: [[`  return u ? CUSTOM_KEY(u) : CUSTOM_KEY_LEGACY;`,
      `  return CUSTOM_KEY_LEGACY;`]],
  },
  {
    name: 'adoptions: the claimed legacy blob is left where the next account will claim it too',
    file: L('lichessStore.ts'),
    gate: '.bench/adoptions.account.test.mjs',
    edits: [[`      try { await Storage.removeItem(CUSTOM_KEY_LEGACY); } catch { /* keep going */ }`,
      `      void 0;`]],
  },
  /* --------------------------------------------------------------- bots */
  {
    name: 'bots: a win as Black is not a win',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`    const won = (side === 'w' && result === '1-0') || (side === 'b' && result === '0-1');`,
      `    const won = result === '1-0';`]],
  },
  {
    name: 'bots: a near-miss name matches anyway',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`  if (w.sur === kk.sur && (!kk.init || !w.init || kk.init === w.init)) return 'w';`,
      `  if (w.sur === kk.sur) return 'w';`]],
  },
  {
    name: 'bots: the book keeps storing moves past its window',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`      if (ply <= BOOK_PLIES) {`, `      if (ply <= BOOK_PLIES * 4) {`]],
  },
  {
    name: 'bots: a game that broke mid-replay is still analysed',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`    if (plies < MIN_PLIES) continue;`, `    if (plies < -1) continue;`]],
  },
  {
    name: 'bots: the build progress reports the wrong game count',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`        done: gi + 1,`, `        done: gi,`]],
  },
  {
    name: 'bots: the wandering-queen penalty never fires',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`      if (f.earlyQueen) adj -= 0.28;`, `      if (f.earlyQueen) adj -= 0;`]],
  },
  {
    name: 'bots: a queen still on its home rank counts as wandering',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    earlyQueen: piece === 'q' && ply <= 10 && from[1] !== '8' && from[1] !== '1',`,
      `    earlyQueen: piece === 'q' && ply <= 10,`]],
  },
  {
    name: 'bots: the queen penalty ignores the ply window',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    earlyQueen: piece === 'q' && ply <= 10 && from[1] !== '8' && from[1] !== '1',`,
      `    earlyQueen: piece === 'q' && from[1] !== '8' && from[1] !== '1',`]],
  },
  {
    name: 'bots: the human score ignores naturalness',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    const h = clamp01(0.62 * rankScore + 0.38 * naturalness);`,
      `    const h = clamp01(rankScore);`]],
  },
  {
    name: 'bots: the signals are added without their weights',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    const s = weights.alpha * e + weights.beta * h + weights.gamma * p;`,
      `    const s = e + h + p;`]],
  },
  {
    name: 'bots: the book signal is a constant',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`      bookSignal = cnt > 0 ? 0.5 + 0.5 * Math.sqrt(cnt / bookTotal) : 0.42;`,
      `      bookSignal = 0.5;`]],
  },
  {
    name: 'bots: the engine is asked for a single line',
    file: L('bots', 'play.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    multipv: BOT_MULTIPV,`, `    multipv: 1,`]],
  },
  {
    name: 'bots: the best-move fallback drops its variation',
    file: L('bots', 'play.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`        pv: ev.pvUci && ev.pvUci.length > 0 ? ev.pvUci : [ev.bestMoveUci],`,
      `        pv: ev.pvUci ?? [],`]],
  },
  {
    name: 'bots: mates are not carried into the mimic lines',
    file: L('bots', 'play.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`      mate: l.mateIn,`, `      mate: null,`]],
  },
  {
    name: 'bots: the index is written before the profile it points at',
    file: L('bots', 'store.ts'),
    gate: '.bench/bots.store.test.mjs',
    edits: [[`  await Storage.setItem(botProfileKey(safe.id), JSON.stringify({ v: BOT_V, profile: safe }));
  const bots = await readIndex();
  const next = [botSummaryOf(safe), ...bots.filter((b) => b.id !== safe.id)];
  await writeIndex(next);`,
      `  const bots = await readIndex();
  const next = [botSummaryOf(safe), ...bots.filter((b) => b.id !== safe.id)];
  await writeIndex(next);
  await Storage.setItem(botProfileKey(safe.id), JSON.stringify({ v: BOT_V, profile: safe }));`]],
  },
  {
    name: 'bots: deleting a bot leaves its profile behind',
    file: L('bots', 'store.ts'),
    gate: '.bench/bots.store.test.mjs',
    edits: [[`    await Storage.removeItem(botProfileKey(id));`, `    void botProfileKey(id);`]],
  },
  {
    name: 'bots: a card is shown for a profile that cannot be read back',
    file: L('bots', 'store.ts'),
    gate: '.bench/bots.store.test.mjs',
    edits: [[`    const profile = await loadBot(s.id);
    if (profile) alive.push(botSummaryOf(profile));`,
      `    await loadBot(s.id);
    alive.push(s);`]],
  },
  /* ------------------------------------------------------------- bot sources */
  {
    name: 'bots: the synthesized PGN loses the result in its movetext',
    file: L('bots', 'sources.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`    moves ? \`\${moves} \${result}\` : result,`, `    moves ? moves : result,`]],
  },
  {
    name: 'bots: an empty time-class filter is accepted as a bot',
    file: L('bots', 'sources.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`  if (kept.length < MIN_GAMES_FOR_BOT) {`, `  if (kept.length < 0) {`]],
  },
  {
    name: 'bots: bullet games are kept after all',
    file: L('bots', 'sources.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`    (g) => g.timeClass !== 'bullet' && (timeClass === 'all' || g.timeClass === timeClass),`,
      `    (g) => timeClass === 'all' || g.timeClass === timeClass,`]],
  },
  {
    name: 'bots: the OTB merge fuses different given names',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`      if ((vg.startsWith(mg) || mg.startsWith(vg)) && Math.min(vg.length, mg.length) <= 4) {`,
      `      if (vg.startsWith(mg) || mg.startsWith(vg)) {`]],
  },
  {
    name: 'bots: an ambiguous OTB lookup silently picks the first spelling',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`      if (runner.games >= 5 && runner.games >= 0.3 * leader.games) {`,
      `      if (runner.games >= 1e9) {`]],
  },
  {
    name: 'bots: the weekly scan never stops early',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`      if (found >= maxGames) break scan;`, `      if (found >= 1e9) break scan;`]],
  },
  {
    name: 'bots: the FIDE title keeps the words around the name',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`  const name = title.replace(/\\s*FIDE\\s+Profile.*$/i, '').trim();`,
      `  const name = title.trim();`]],
  },
  {
    name: 'bots: a glued move number reaches chess.js',
    file: L('lichess.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`    const numbered = tok.replace(/^\\d+\\.+/, '');`, `    const numbered = tok;`]],
  },
  {
    name: 'bots: the rating label falls back to blitz whatever was played',
    file: L('bots', 'profile.ts'),
    gate: '.bench/bots.profile.test.mjs',
    edits: [[`    const rated = tc ?? dominant;`, `    const rated = tc;`]],
  },
  {
    name: 'bots: a lost position is played on instead of resigned',
    file: L('bots', 'play.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`  return ev.scoreCp !== null && ev.scoreCp !== undefined && ev.scoreCp <= BOT_RESIGN_CP;`,
      `  return false;`]],
  },
  {
    name: 'bots: a forced mate against the bot is not resignable',
    file: L('bots', 'play.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`  if (ev.mateIn !== null && ev.mateIn !== undefined && ev.mateIn < 0 && ev.mateIn >= -BOT_RESIGN_MATE_IN) {`,
      `  if (false) {`]],
  },
  {
    name: 'bots: an archive fetch is never retried',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`  for (let attempt = 0; attempt < attempts; attempt++) {`,
      `  for (let attempt = attempts - 1; attempt < attempts; attempt++) {`]],
  },
  {
    name: 'bots: a refused resolver is reported as the raw Java exception',
    file: L('bots', 'otb.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`    super(\`Could not reach \${source} — check your internet connection and try again.\`);`,
      `    super(\`fetch failed: UnknownHostException — \${source}\`);`]],
  },
  {
    name: 'bots: a Lichess network blip is not retried',
    file: L('bots', 'sources.ts'),
    gate: '.bench/bots.sources.test.mjs',
    edits: [[`    if (!(err instanceof LichessError) || err.kind !== 'network') throw err;`,
      `    throw err;`]],
  },
  /* ------------------------------------------------------- openings: the time cap */
  {
    name: 'cap: the host page ignores the time cap again',
    file: E('stockfish-host.js'),
    gate: '.bench/engine.multipv.test.mjs',
    edits: [[`      engine.postMessage(msg.movetime
        ? 'go depth ' + msg.depth + ' movetime ' + msg.movetime
        : 'go depth ' + msg.depth);`,
      `      engine.postMessage('go depth ' + msg.depth);`]],
  },
  {
    name: 'cap: the shipped host copy loses the cap',
    file: E('assets.ts'),
    gate: '.bench/engine.multipv.test.mjs',
    edits: [[`        ? 'go depth ' + msg.depth + ' movetime ' + msg.movetime`,
      `        ? 'go depth ' + msg.depth`]],
  },
  {
    name: 'cap: engine.ts invents a 300ms cap for depth searches again',
    file: L('engine.ts'),
    gate: '.bench/engine.init.test.mjs',
    edits: [[`    const { depth, elo = null, onInfo } = opts;
    const movetime = opts.movetime;`,
      `    const { depth, elo = null, onInfo } = opts;
    const movetime = opts.movetime ?? 300;`]],
  },
  {
    name: 'cap: the safety timer reads a NaN budget for a capless search',
    file: L('engine.ts'),
    gate: '.bench/engine.init.test.mjs',
    edits: [[`      }, (waiter.opts.movetime ?? 0) + ChessEngine.NO_REPLY_GRACE_MS);`,
      `      }, waiter.opts.movetime + ChessEngine.NO_REPLY_GRACE_MS);`]],
  },
  {
    name: 'cap: the family pass drops the caller\'s time cap',
    file: L('gameOpenings.ts'),
    gate: '.bench/gameopenings.cap.test.mjs',
    edits: [[`    movetime: opts.movetime,`, `    movetime: undefined,`]],
  },
  {
    name: 'cap: the family pass searches without the cap it was handed',
    file: L('gameOpenings.ts'),
    gate: '.bench/gameopenings.cap.test.mjs',
    edits: [[`      info = await engine.analyse(cand.fen, { depth, multipv, movetime });`,
      `      info = await engine.analyse(cand.fen, { depth, multipv });`]],
  },
  {
    name: 'cap: one silent search ends every family pass',
    file: L('gameOpenings.ts'),
    gate: '.bench/gameopenings.cap.test.mjs',
    edits: [[`const MAX_SILENT_SEARCHES = 3;`, `const MAX_SILENT_SEARCHES = 1;`]],
  },
  {
    name: 'cap: a silent engine grinds through the whole family',
    file: L('gameOpenings.ts'),
    gate: '.bench/gameopenings.cap.test.mjs',
    edits: [[`      silent++;
      if (silent >= MAX_SILENT_SEARCHES) break;`,
      `      silent++;
      if (silent >= 999) break;`]],
  },
  {
    name: 'cap: the silence counter never resets after an answer',
    file: L('gameOpenings.ts'),
    gate: '.bench/gameopenings.cap.test.mjs',
    edits: [[`    silent = 0;`, `    void silent;`]],
  },
  {
    name: 'cap: the screen asks for the cap but never passes it',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/lineloop.test.mjs',
    edits: [[`            movetime: ENGINE_SEARCH_CAP_MS,`, `            movetime: undefined,`]],
  },
  {
    name: 'cap: the cap is set so high it is not a cap',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/lineloop.test.mjs',
    edits: [[`const ENGINE_SEARCH_CAP_MS = 800;`, `const ENGINE_SEARCH_CAP_MS = 80000;`]],
  },
  /* --------------------------------------------------------------- mimicry */
  {
    name: 'mimic: maximum mimicry falls back to engine-first weights',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`  const alpha = 1 - 0.95 * t;
  const beta = 0.15 * t;
  const gamma = 0.8 * t;`,
      `  const alpha = 1 - 0.9 * t;
  const beta = 0.55 * t;
  const gamma = 0.35 * t;`]],
  },
  {
    name: 'mimic: maximum mimicry dilutes book evidence with style',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`    const p = clamp01(0.7 * bookSignal + 0.3 * prefScore);`,
      `    const p = clamp01(0.5 * bookSignal + 0.5 * prefScore);`]],
  },
  {
    name: 'mimic: the book cannot nominate moves outside the engine window',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`  if (weights.gamma >= 0.6 && bookSlot && bookTotal > 0) {`,
      `  if (weights.gamma >= 9.9 && bookSlot && bookTotal > 0) {`]],
  },
  {
    name: 'mimic: a one-off game nominates a move outside the engine window',
    file: L('bots', 'mimic.ts'),
    gate: '.bench/bots.mimic.test.mjs',
    edits: [[`      if (cnt < 2 || seenSan.has(san)) continue;`,
      `      if (cnt < 1 || seenSan.has(san)) continue;`]],
  },
  /* ---------------------------------------------------------- own-move loop */
  {
    name: 'ownmove: the verdict join is a no-op',
    file: L('openingBuilder.ts'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`  if (analysed.length === 0 || steps.length === 0) return steps;`,
      `  if (true || analysed.length === 0 || steps.length === 0) return steps;`]],
  },
  {
    name: 'ownmove: the join swaps the position but never rebuilds the choice',
    file: L('openingBuilder.ts'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`    return { ...s, position: rebuilt.position, choice: rebuilt.choice };`,
      `    return { ...s, position: rebuilt.position, choice: s.choice };`]],
  },
  {
    name: 'ownmove: every decision goes back through the engine',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`      if (playsLineMove) {
        setPendingFen(null);`,
      `      if (playsLineMove) {
        void continueLineWithEngine(openFamily, played, { isAlive: () => aliveRef.current });
        setPendingFen(null);`]],
  },
  {
    name: 'ownmove: the own-move test is inverted to always false',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`    const playsLineMove = san === step.moveSan;`, `    const playsLineMove = false;`]],
  },
  {
    name: 'ownmove: the dead end jumps to the end of the line again',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`        stopWalk();
        setFeedback({`,
      `        stopWalk();
        setStepIdx(steps.length);
        setFeedback({`]],
  },
  {
    name: 'ownmove: the move is not held on the board while the line catches up',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`    setPendingFen(c.fen());`, `    setPendingFen(null);`]],
  },
  {
    name: 'ownmove: publish records verdicts but never re-renders',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`          setVerdictsTick((t) => t + 1);`, `          void verdictsTick;`]],
  },
  {
    name: 'ownmove: the live line ignores the verdicts it was just given',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`    () => withVerdicts(resolvedLine, livePositions),`,
      `    () => withVerdicts(resolvedLine, []),`]],
  },
  {
    name: 'ownmove: the board accepts a second move while the line catches up',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`            interactive={!done && !replaying && !awaitingVerdict && pendingFen == null}`,
      `            interactive={!done && !replaying && !awaitingVerdict}`]],
  },
  /* ------------------------------------------------------------- post-game */
  {
    name: 'postgame: a drawn game is reported as an unknown result',
    file: L('bots', 'postgame.ts'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`  return '1/2-1/2';`, `  return '*';`]],
  },
  {
    name: 'postgame: kingSquare counts empty squares as one file',
    file: L('bots', 'postgame.ts'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }`,
      `      if (ch >= '1' && ch <= '8') {
        file += 1;
        continue;
      }`]],
  },
  {
    name: 'postgame: the PGN never wraps',
    file: L('bots', 'postgame.ts'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`const PGN_WRAP = 80;`, `const PGN_WRAP = 8000;`]],
  },
  {
    name: 'postgame: the result token is missing from the movetext',
    file: L('bots', 'postgame.ts'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`  tokens.push(opts.result);`, `  void 0;`]],
  },
  {
    name: 'postgame: the kings stay marked while stepping through the game',
    file: S('BotPlayScreen.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`    if (!over || winnerColor == null || reviewAt != null) return out;`,
      `    if (!over || winnerColor == null) return out;`]],
  },
  {
    name: 'postgame: the board is live during the review',
    file: S('BotPlayScreen.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`            interactive={reviewAt == null && userTurn}`, `            interactive={userTurn}`]],
  },
  {
    name: 'postgame: copying the PGN does nothing',
    file: S('BotPlayScreen.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`      Clipboard.setString(pgn);`, `      void pgn;`]],
  },
  {
    name: 'ring: mastery counts engine verdicts instead of his own moves',
    file: L('yourOpenings.ts'),
    gate: '.bench/youropenings.test.mjs',
    edits: [[`const mine = steps.filter((s) => s.position != null);`,
      `const mine = steps.filter((s) => s.choice != null);`]],
  },
  {
    name: 'lineid: a line that shrank is accepted as the line the user chose',
    file: L('yourOpenings.ts'),
    gate: '.bench/youropenings.test.mjs',
    edits: [[`    // A candidate that ends before the recording does cannot be the line that was recorded.
    if (cand.length < recordedSans.length) continue;
    let same = true;
    for (let i = 0; i < recordedSans.length; i++) {
      if (cand[i].moveSan !== recordedSans[i]) { same = false; break; }
    }`,
      `    const n = Math.min(recordedSans.length, cand.length);
    let same = true;
    for (let i = 0; i < n; i++) {
      if (cand[i].moveSan !== recordedSans[i]) { same = false; break; }
    }`]],
  },
  {
    name: 'ring: short lines are offered for drilling again',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/youropenings.test.mjs',
    edits: [[`const linesForFamily = familyLines.filter((l) => l.drillable);`,
      `const linesForFamily = familyLines.filter((l) => l);`]],
  },
  {
    name: 'ownmove: a no-op continuation is treated as a finished line',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/openings.ownmove.test.mjs',
    edits: [[`if (!replaysPlayed || merged.length === played.length) {`,
      `if (!replaysPlayed) {`]],
  },
  {
    name: 'postgame: game review does not reach the analysis page',
    file: S('BotPlayScreen.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`onPress={() => (onAnalyse ? onAnalyse(pgn) : setReviewAt(history.length))}`,
      `onPress={() => (onAnalyse ? setReviewAt(history.length) : setReviewAt(history.length))}`]],
  },
  {
    name: 'postgame: the analysis page ignores the handed-over PGN',
    file: S('AnalysisScreen.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`setPgnText(initialPgn);`, `void initialPgn;`]],
  },
  {
    name: 'postgame: the shell never hands the PGN over',
    file: CP('AppShell.tsx'),
    gate: '.bench/bots.postgame.test.mjs',
    edits: [[`setAnalysisPgn(pgn);`, `void pgn;`]],
  },
  /* ------------------------------------------------------ engine self-repair */
  {
    name: 'engine: a search that never answers is waited on for ever',
    file: E('stockfish-host.js'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`    searchOutstanding = true;`, `    searchOutstanding = false;`]],
  },
  {
    name: 'engine: the host answers ready without an engine again',
    file: E('stockfish-host.js'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`    if (ready) {
      send({ type: 'ready' });
      return;
    }
    if (booting) return;
    if (engine) {
      engine.postMessage('uci');
      return;
    }
    boot();`,
      `    send({ type: 'ready' });`]],
  },
  {
    name: 'engine: restart() releases waiters but never asks the host to rebuild',
    file: L('engine.ts'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`    this.post({ cmd: 'restart' });`, `    void 0;`]],
  },
  {
    name: 'engine: the shipped host copy loses the search watchdog',
    file: E('assets.ts'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`markDead('a search never answered');`, `markDead('a search stopped');`]],
  },
  {
    name: 'engine: a failed wasm asset read is never retried',
    file: CP('EngineHost.tsx'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`          retryTimer = setTimeout(() => void resolveAsset(), WASM_ASSET_RETRY_MS * attempts);`,
      `          retryTimer = null;`]],
  },
  {
    name: 'engine: the Stats retry never restarts the engine',
    file: L('statsJobs.ts'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`      if (!getEngine().isReady) getEngine().restart('retry from the Stats scan');`,
      `      void getEngine().isReady;`]],
  },
  {
    name: 'engine: the Your-openings retry never restarts the engine',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/engine.boot.test.mjs',
    edits: [[`                      getEngine().restart('retry from Your openings');`,
      `                      void openFamilyId;`]],
  },
  /* ----------------------------------------------------- celebration loop */
  {
    name: 'celebration: every scored event celebrates, not just a new day',
    file: L('store.ts'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`      ...(streakBumped`, `      ...(true`]],
  },
  {
    name: 'celebration: the banner never hides itself',
    file: CP('CelebrationBanner.tsx'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`    const timer = setTimeout(() => clear(), HOLD_MS);`,
      `    const timer = setTimeout(() => void 0, HOLD_MS);`]],
  },
  {
    name: 'celebration: the shell stops mounting the banner',
    file: CP('AppShell.tsx'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`      <CelebrationBanner />`, `      {null}`]],
  },
  {
    name: 'celebration: the streak write replaces the completion instead of stamping it',
    file: L('store.ts'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`      const stamped: CelebrationEvent | null = pending != null && isSessionKind(pending.kind)`,
      `      const stamped: CelebrationEvent | null = null`]],
  },
  {
    name: 'celebration: a completion forgets the day it absorbed',
    file: L('store.ts'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`        streakNote: prev != null && !isSessionKind(prev.kind),`, `        streakNote: false,`]],
  },
  {
    name: 'celebration: a completion double-counts the XP it absorbs',
    file: L('store.ts'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`        xp: (prev?.xp ?? 0) + xp,`, `        xp: xp + 1,`]],
  },
  {
    name: 'celebration: the train session stops raising its moment',
    file: S('TrainScreen.tsx'),
    gate: '.bench/celebration.test.mjs',
    edits: [[`        const solved = items.filter((x) => x.state === 'solved').length;
        store.completeSession('train', \`\${solved} exercise\${solved === 1 ? '' : 's'} solved\`, XP_SESSION_BONUS);`,
      `        void items;`]],
  },
  /* ------------------------------------------------------- offline deck */
  {
    name: 'offline: a failed live request returns nothing again',
    file: L('puzzleProvider.ts'),
    gate: '.bench/puzzles.test.mjs',
    edits: [[`    return fallbackPuzzle(userRating, liveLo, liveHi);`, `    return null;`]],
  },
  {
    name: 'offline: the pool is consulted even when the live request worked',
    file: L('puzzleProvider.ts'),
    gate: '.bench/puzzles.test.mjs',
    edits: [[`  if (!live) {`, `  if (true) {`]],
  },
  {
    name: 'offline: the pool trusts the stored SAN without replaying it',
    file: L('puzzlePool.ts'),
    gate: '.bench/puzzles.test.mjs',
    edits: [[`  const sans: string[] = [];
  try {
    for (const uci of entry.uci) {
      const m = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      sans.push(m.san);
    }
  } catch {
    return null;
  }
  if (sans.join(' ') !== entry.san.join(' ')) return null;`,
      `  const sans: string[] = entry.san;`]],
  },
  {
    name: 'offline: the pool serves a solution the screen cannot finish',
    file: L('puzzlePool.ts'),
    gate: '.bench/puzzles.test.mjs',
    edits: [[`  if (entry.uci.length === 0 || entry.uci.length % 2 === 0) return null;`,
      `  if (entry.uci.length === 0) return null;`]],
  },
  {
    name: 'offline: two offline serves can be the same puzzle',
    file: L('puzzlePool.ts'),
    gate: '.bench/puzzles.test.mjs',
    edits: [[`  let chosenEntry = pickNearest(list, rating, (e) => !servedIds.has(e.id) && usable(e));`,
      `  let chosenEntry = pickNearest(list, rating, usable);`]],
  },
  /* --------------------------------------------------------- in-place import */
  {
    name: 'import: a scan reads bullet games too',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`.filter((g) => g.rated && g.timeClass !== 'bullet' && g.movesSan.length >= 4)`,
      `.filter((g) => g.rated && g.movesSan.length >= 4)`]],
  },
  {
    name: 'import: a scan stopped by the user is stored as complete',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`complete: !summary.stopped,`, `complete: true,`]],
  },
  {
    name: 'import: the final mining pass never runs',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`if (!summary.stopped) {`, `if (false) {`]],
  },
  {
    name: 'import: the mined deck grows without its cap',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`.slice(0, MINED_PUZZLE_LIMIT);`, `.slice(0);`]],
  },
  {
    name: 'import: a finished game is never persisted, so a kill loses the run',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`void saveScanRecords(username, next, kept.length, false);`, `void next;`]],
  },
  {
    name: 'import: the derived positions cache is left stale after a scan',
    file: L('scanPlan.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`await clearCachedPositions(username);`, `void clearCachedPositions;`]],
  },
  {
    name: 'import: the final stored scan drops the records it just produced',
    file: L('scanPlan.ts'),
    gate: '.bench/youropenings.test.mjs',
    edits: [[`    records: finalRecords,
    puzzles: previous.puzzles,`, `    records: opts.records,
    puzzles: previous.puzzles,`]],
  },
  {
    name: 'import: the in-place card assumes the engine booted',
    file: L('statsJobs.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`if (!getEngine().isReady) getEngine().restart('retry from the Stats scan');`,
      `void getEngine().isReady;`]],
  },
  {
    name: 'import: switching accounts leaves the previous account data behind',
    file: CP('GameImportInline.tsx'),
    gate: '.bench/import.test.mjs',
    edits: [[`      if (account && account !== next) {`,
      `      if (false) {`]],
  },
  {
    name: 'import: the card always refetches instead of using fresh cached games',
    file: L('statsJobs.ts'),
    gate: '.bench/import.test.mjs',
    edits: [[`        list = cached && !gamesCacheIsStale(cached) ? cached.games : null;`,
      `        list = cached && false ? cached.games : null;`]],
  },
  {
    name: 'import: Puzzles never reloads the deck after an in-place import',
    file: S('PuzzlesScreen.tsx'),
    gate: '.bench/import.test.mjs',
    edits: [[`onChanged={() => void readDeck()}`, `onChanged={() => void 0}`]],
  },
  {
    name: 'import: connecting in Your openings never triggers its build',
    file: S('GameOpeningsScreen.tsx'),
    gate: '.bench/import.test.mjs',
    edits: [[`onChanged={() => void build(true)}`, `onChanged={() => void 0}`]],
  },

  /* --------------------------------------------------------------- coach app */
  {
    name: 'coach: the adapter numbers plies from zero',
    file: L('coach', 'app.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`    moveNumber: Math.floor(m.ply / 2) + 1,`, `    moveNumber: Math.floor(m.ply / 2),`]],
  },
  {
    name: 'coach: a missed chance is narrated as the best move',
    file: L('coach', 'review.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`    case 'miss':\n    case 'mistake': return 'mistake';`,
      `    case 'miss':\n    case 'mistake': return 'best';`]],
  },
  {
    name: 'coach: a gaining move is reported as a loss of winning chances',
    file: L('coach', 'app.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`  const wpLoss = Math.max(0, winP(m.cpBefore, moverIsWhite) - winP(m.cpAfter, moverIsWhite));`,
      `  const wpLoss = winP(m.cpBefore, moverIsWhite) - winP(m.cpAfter, moverIsWhite);`]],
  },
  {
    name: 'coach: the engine PV never reaches the review',
    file: L('coach', 'app.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`  const pv = m.pvUci && m.pvUci.length > 0
    ? [...m.pvUci]
    : (m.bestMoveUci ? [m.bestMoveUci] : []);`,
      `  const pv: string[] = [];`]],
  },
  {
    name: 'coach: attaching a model does not change the narrator',
    file: L('coach', 'session.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`  coach = rt ? createCoach(new LocalModelNarrator(rt)) : createCoach();`,
      `  coach = createCoach();`]],
  },
  {
    name: 'coach: the runtime is recorded but the first coach keeps answering',
    file: L('coach', 'session.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`  runtime = rt;`, `  void rt;`]],
  },
  {
    name: 'coach: a model download forgets to overwrite its half-written file',
    file: L('coach', 'model.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`    idempotent: true,`, `    idempotent: false,`]],
  },
  {
    name: 'coach: unloading the model leaves the dead runtime attached',
    file: L('coach', 'model.ts'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`  attachRuntime(null);\n  await Storage.removeItem(ACTIVE_KEY).catch(() => {});`,
      `  await Storage.removeItem(ACTIVE_KEY).catch(() => {});`]],
  },
  {
    name: 'coach: a follow-up forgets the conversation it continues',
    file: CP('CoachPanel.tsx'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`        const a = await activeCoach().ask(q, fen, history, moves);`,
      `        const a = await activeCoach().ask(q, fen);`]],
  },
  {
    name: 'coach: the panel offers the game move while a branch is on the board',
    file: S('AnalysisScreen.tsx'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`        move={exploring ? null : currentMove}`, `        move={currentMove}`]],
  },
  {
    name: 'coach: the review drops the engine continuation it captured',
    file: S('AnalysisScreen.tsx'),
    gate: '.bench/coach.app.test.mjs',
    edits: [[`        pvUci: evals[i].lines?.[0]?.pvUci ?? evals[i].pvUci ?? [],`, `        pvUci: [],`]],
  },
  {
    name: 'coach: a question about the shown board is refused',
    file: L('coach', 'topic.ts'),
    gate: '.bench/coach.core.test.mjs',
    edits: [[`  if (words.length <= 8 && FOLLOW_UP_RE.test(q) && POSITIONAL_RE.test(q)) return true;`,
      `  if (false && POSITIONAL_RE.test(q)) return true;`]],
  },
  {
    name: 'coach: two-letter fragments make any sentence chess related',
    file: L('coach', 'kb.ts'),
    gate: '.bench/coach.core.test.mjs',
    edits: [[`        if (t.length >= 4 && (ix.name.includes(t) || ix.akas.some((a) => a.includes(t)))) return true;`,
      `        if (ix.name.includes(t) || ix.akas.some((a) => a.includes(t))) return true;`]],
  },
  {
    name: 'coach: the curated probe answers yes to everything',
    file: L('coach', 'kb.ts'),
    gate: '.bench/coach.core.test.mjs',
    edits: [[`  matchesCurated(tokens: readonly string[]): boolean {`,
      `  matchesCurated(tokens: readonly string[]): boolean {\n    return true;`]],
  },
  /* ---------------------------------------------------------- frame cost */
  {
    name: 'perf: the turn from a FEN always says White',
    file: L('fen.ts'),
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`  return fen.split(' ')[1] === 'b' ? 'b' : 'w';`, `  return 'w';`]],
  },
  {
    name: 'perf: the Analyse review builds a board to read the turn again',
    file: S('AnalysisScreen.tsx'),
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`  const turnAtView = turnOf(boardFen ?? viewFen);`,
      `  const turnAtView = new Chess(boardFen ?? viewFen).turn();`]],
  },
  {
    name: 'perf: the background re-renders with the shell again',
    file: 'src/components/AppBackground.tsx',
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`export const AppBackground = memo(function AppBackground(`,
      `export const AppBackground = (function AppBackground(`]],
  },
  {
    name: 'perf: the ring list is rebuilt during the background render again',
    file: 'src/components/AppBackground.tsx',
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`    >\n      <RadialGlow rings={EMERALD_RINGS} />`,
      `    >\n      {Array.from({ length: RINGS }).map((_, i) => <View key={i} />)}\n      <RadialGlow rings={EMERALD_RINGS} />`]],
  },
  {
    name: 'perf: Home goes back to a per-render clock',
    file: S('HomeScreen.tsx'),
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`  const [now, setNow] = useState(() => Date.now());\n  useEffect(() => {\n    const tick = setInterval(() => setNow(Date.now()), 60_000);\n    return () => clearInterval(tick);\n  }, []);`,
      `  const now = Date.now();`]],
  },
  {
    name: 'perf: the Home counts scan the store on every render again',
    file: S('HomeScreen.tsx'),
    gate: '.bench/perf.jank.test.mjs',
    edits: [[`  const startedCount = useMemo(\n    () => Object.values(studies).filter((s) => s.attempts > 0).length,\n    [studies],\n  );`,
      `  const startedCount = Object.values(studies).filter((s) => s.attempts > 0).length;`]],
  },

  /* ------------------------------------------------------- coach bot */
  {
    name: 'coachbot: the chosen level is not sent to the engine',
    file: L('bots', 'coachBot.ts'),
    gate: COACHBOT_GATE,
    edits: [[`    elo,\n    multipv: 1,`, `    elo: null,\n    multipv: 1,`]],
  },
  {
    name: 'coachbot: the offline hint never names the engine move',
    file: L('coach', 'template.ts'),
    gate: COACHBOT_GATE,
    edits: [[`    const paras: string[] = [\`The engine's move here is \${san}.\`];`,
      `    const paras: string[] = ['The engine is ready to move.'];`]],
  },
  {
    name: 'coachbot: an off-topic question reaches the model',
    file: L('coach', 'coach.ts'),
    gate: COACHBOT_GATE,
    edits: [[`    if (!isChessRelated(question, this.kb)) return CHESS_ONLY_APOLOGY;`,
      `    if (false) return CHESS_ONLY_APOLOGY;`]],
  },
  {
    name: 'coachbot: the hint button never asks the coach',
    file: S('BotPlayScreen.tsx'),
    gate: COACHBOT_GATE,
    edits: [[`      await askCoach('Hint, please.', fresh.san);`, `      void 0;`]],
  },
  {
    name: 'coachbot: the shell drops the chosen level',
    file: 'src/components/AppShell.tsx',
    gate: COACHBOT_GATE,
    edits: [[`                coachElo={coachElo}`, `                coachElo={null}`]],
  },
  {
    name: 'coachbot: the picker starts the coach without a level',
    file: S('BotsScreen.tsx'),
    gate: COACHBOT_GATE,
    edits: [[`          onPress={() => onPlay(COACH_BOT_ID, coachElo)}`,
      `          onPress={() => onPlay(COACH_BOT_ID)}`]],
  },

  /* --------------------------------------- shared coach brain + UI corrections */
  {
    name: 'coachcore: 1.e4 e5 is called a closed centre again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  if (locked(wD, bD) && locked(wE, bE)) tags.push('closed_center');`,
      `  if (whiteHas(3) && whiteHas(4) && blackHas(3) && blackHas(4)) tags.push('closed_center');`]],
  },
  {
    name: 'coachcore: the starting bishop symmetry becomes an advantage',
    file: L('coach', 'facts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (r.material[WHITE].bishopPair !== r.material[BLACK].bishopPair) t.push('bishop_pair');`,
      `    if (r.material.some((m) => m.bishopPair)) t.push('bishop_pair');`]],
  },
  {
    name: 'coachcore: the related idea falls back to an unrelated opening',
    file: L('coach', 'template.ts'),
    gate: COACHBOT_GATE,
    edits: [[`  const second = hits.find((h) => h !== first && h.kind === priority);`,
      `  const second = hits.find((h) => h !== first && h.kind === priority) ?? hits.find((h) => h !== first);`]],
  },
  {
    name: 'coachbrain: Bots cannot download the brain',
    file: S('BotsScreen.tsx'),
    gate: COACH_APP_GATE,
    edits: [[`        <CoachModelManager />\n`, ``]],
  },
  {
    name: 'coachbrain: loading a model does not notify open screens',
    file: L('coach', 'session.ts'),
    gate: COACH_APP_GATE,
    edits: [[`  coach = rt ? createCoach(new LocalModelNarrator(rt)) : createCoach();\n  emit();`,
      `  coach = rt ? createCoach(new LocalModelNarrator(rt)) : createCoach();`]],
  },
  {
    name: 'coachbrain: every screen mount reloads the weights',
    file: L('coach', 'model.ts'),
    gate: COACH_APP_GATE,
    edits: [[`  restoreAttempt ??= restoreActiveModel();`,
      `  restoreAttempt = restoreActiveModel();`]],
  },
  {
    name: 'coachbrain: a half-downloaded file is offered as installed',
    file: L('coach', 'model.ts'),
    gate: COACH_APP_GATE,
    edits: [[`    return f.exists && f.size === def.bytes;`,
      `    return f.exists && f.size > 1_000_000;`]],
  },
  {
    name: 'coachbrain: the Analyse panel pins the rulebook tier',
    file: CP('CoachPanel.tsx'),
    gate: COACH_APP_GATE,
    edits: [[`  const { narrator: tier } = useCoachSession();`,
      `  const tier = 'Rulebook (offline)';`]],
  },
  {
    name: 'coachui: the chat header advertises the rulebook tier again',
    file: CP('CoachGameChat.tsx'),
    gate: COACH_APP_GATE,
    edits: [[`        <View style={s.headText}>\n          <Text style={s.title}>Coach</Text>\n        </View>`,
      `        <View style={s.headText}>\n          <Text style={s.title}>Coach</Text>\n          <Text style={s.tier}>Rulebook (offline) · chess only</Text>\n        </View>`]],
  },
  {
    name: 'coachui: undo becomes a text button again',
    file: S('BotPlayScreen.tsx'),
    gate: COACHBOT_GATE,
    edits: [[`          <IconBtn\n            onPress={undo}\n            disabled={!userTurn || history.length < 2}\n            label="Undo"\n          >\n            <IconUndo size={16} color={colors.foreground} />\n          </IconBtn>`,
      `          <Btn\n            label="Undo"\n            variant="ghost"\n            small\n            disabled={!userTurn || history.length < 2}\n            onPress={undo}\n          />`]],
  },
  {
    name: 'coachrel: generic questions retrieve book prose again',
    file: L('coach', 'kb.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  findMentioned(query: string, limit = 3): KbEntry[] {
    return this.entries.filter((e) => entryMentioned(e, query)).slice(0, limit);
  }`,
      `  findMentioned(query: string, limit = 3): KbEntry[] {
    return this.search(query, ALL_KINDS, limit);
  }`]],
  },
  {
    name: 'coachrel: the plan answer is a canned English line again',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`function planAnswer(ctx: GroundedContext): string {
  const namedPlan = planBlock(ctx);`,
      `function planAnswer(ctx: GroundedContext): string {
  return 'Plan: Rc1, then b4 against c5 in the English Opening.';
  const namedPlan = planBlock(ctx);`]],
  },
  {
    name: 'coachrel: a weak-square question falls through to the book list',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (/\\b(weak squares?|holes?)\\b/.test(q)) return weakSquareAnswer(ctx);`,
      `    if (false) return weakSquareAnswer(ctx);`]],
  },
  {
    name: 'coachrel: the guard stops checking material claims',
    file: L('coach', 'guard.ts'),
    gate: COACH_CORE_GATE,
    edits: [
      [`  if (BISHOP_PAIR.test(text) && !supported(ctx, 'bishop_pair', /bishop pair/i)) {`,
        `  if (false && BISHOP_PAIR.test(text) && !supported(ctx, 'bishop_pair', /bishop pair/i)) {`],
      [`  if (KING_AND_PAWN.test(text) && !supported(ctx, 'kpk', /king and pawn/i)) {`,
        `  if (false && KING_AND_PAWN.test(text) && !supported(ctx, 'kpk', /king and pawn/i)) {`],
    ],
  },
  {
    name: 'coachrel: hints wait for the model again',
    file: L('coach', 'coach.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`      () => TemplateNarrator.explainHint(ctx, san),
      () => TemplateNarrator.explainHint(ctx, san),`,
      `      () => this.narrator.explainHint(ctx, san),
      () => TemplateNarrator.explainHint(ctx, san),`]],
  },

  /* --------------------------------------- jobs outlive their screens */
  {
    name: 'background: a terminal job is announced while still marked running',
    file: L('background.ts'),
    gate: BACKGROUND_GATE,
    edits: [[`      running.delete(id);
      update({
        status: 'done',`,
      `      update({
        status: 'done',`]],
  },
  {
    name: 'background: a second caller starts the same work again',
    file: L('background.ts'),
    gate: BACKGROUND_GATE,
    edits: [[`  const existing = running.get(id);
  if (existing) {`,
      `  const existing = running.get(id);
  if (false && existing) {`]],
  },
  {
    name: 'background: a different owner silently joins the running job',
    file: L('background.ts'),
    gate: BACKGROUND_GATE,
    edits: [[`    if (opts.owner != null && existing.owner != null && existing.owner !== opts.owner) {`,
      `    if (false) {`]],
  },
  {
    name: 'background: progress updates never notify subscribers',
    file: L('background.ts'),
    gate: BACKGROUND_GATE,
    edits: [[`    jobs.set(id, { ...(current as JobState<T>), ...patch });
    emit();`,
      `    jobs.set(id, { ...(current as JobState<T>), ...patch });`]],
  },
  {
    name: 'statsjob: the scan ignores cancellation',
    file: L('statsJobs.ts'),
    gate: BACKGROUND_GATE,
    edits: [[`        shouldStop: () => signal.aborted,`, `        shouldStop: () => false,`]],
  },
  {
    name: 'statsjob: saving the downloaded games waits for the screen',
    file: S('StatsScreen.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`      await saveCachedGames(name, all);`, `      void 0;`]],
  },
  {
    name: 'statsjob: Stats runs importGames itself again',
    file: S('StatsScreen.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`    void startScanJob(account.username, games);`,
      `    importGames(account.username, games, { records });`]],
  },
  {
    name: 'statsjob: the inline card runs importGames itself again',
    file: CP('GameImportInline.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`    void startScanJob(account);`,
      `    importGames(account, [], { records: {} });`]],
  },
  {
    name: 'statsjob: refresh is not a module job again',
    file: S('StatsScreen.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`    void startGamesRefresh(account.username, {`,
      `    void 0; /* screen-owned */ ({`]],
  },
  {
    name: 'botjob: Bots fetches the player games itself again',
    file: S('BotsScreen.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`      void startBotBuild({ source, query: q, maxGames, timeClass });`,
      `      void fetchLichessBotGames(q, () => {});`]],
  },
  {
    name: 'modeljob: the model card awaits the download itself again',
    file: CP('CoachModelManager.tsx'),
    gate: BACKGROUND_GATE,
    edits: [[`    void startModelDownload(def);`,
      `    await downloadModel(def);`]],
  },

  /* ------------------------------- the coach over many positions */
  {
    name: 'survey: an edge pawn is called an isolated pawn again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`      if (f > 0 && f < 7 && !hasPawnOn(f - 1) && !hasPawnOn(f + 1)) isolated[side].push(sq);`,
      `      if (!hasPawnOn(f - 1) && !hasPawnOn(f + 1)) isolated[side].push(sq);`]],
  },
  {
    name: 'survey: a list of three squares is joined with "and" twice again',
    file: L('coach', 'facts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  return \`\${sqs.slice(0, -1).join(', ')} and \${sqs[sqs.length - 1]}\`;`,
      `  return sqs.join(' and ');`]],
  },
  {
    name: 'survey: a pawnless ending reports weak squares again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (!canExploit || !hasPawnsToDefend) continue;`,
      `    if (!canExploit) continue;`]],
  },
  {
    name: 'survey: a king is in danger from files no rook can reach again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (enemyHasRook && openNear.length > 0) danger += 1;
    if (enemyHasRook && shield === 0) danger += 1;
    if (enemyHasRook && castledSide === null && b.fullmove > 12) danger += 1;`,
      `    if (openNear.length > 0) danger += 1;
    if (shield === 0) danger += 1;
    if (castledSide === null && b.fullmove > 12) danger += 1;`]],
  },
  {
    name: 'survey: an ending is taught by the wrong technique again',
    file: L('coach', 'facts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    const lesson = report.phase === 'endgame' ? endgameLessonFor(report, kb) : null;`,
      `    const lesson = null;`]],
  },
  {
    name: 'survey: a closed centre is taught the wrong structure plan again',
    file: L('coach', 'facts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (tags.includes('kid_closed')) return 'kid_closed';`,
      `    if (false) return 'kid_closed';`]],
  },
  {
    name: 'survey: the defender is handed the attacker plan again',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  const plan = roleAttacker === null
    ? (ctx.stm === 0 ? structure.whitePlan : structure.blackPlan)
    : (ctx.stm === roleAttacker ? structure.whitePlan : structure.blackPlan);`,
      `  const plan = ctx.stm === 0 ? structure.whitePlan : structure.blackPlan;`]],
  },
  {
    name: 'survey: the plan does not say what to attack and what to watch',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  if (targets.length > 0) bits.push(\`Your targets: \${joinWords(targets)}\`);
  if (assets.length > 0) bits.push(\`Use it: \${joinWords(assets)}\`);
  if (cautions.length > 0) bits.push(\`Watch out: \${joinWords(cautions)}\`);`,
      `  if (targets.length > 0) bits.push(joinWords(targets));
  if (assets.length > 0) bits.push(joinWords(assets));
  if (cautions.length > 0) bits.push(joinWords(cautions));`]],
  },
  {
    name: 'survey: the bishop pair answer does not say who has it',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`      if (pair) parts.push(bishopPairStatus(ctx));`,
      `      if (false) parts.push(bishopPairStatus(ctx));`]],
  },
  {
    name: 'survey: a question matches every fact because "the" is a word',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    question.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && !QUESTION_STOPWORDS.has(w)),`,
      `    question.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2),`]],
  },
  {
    name: 'survey: a majority is listed as a weakness to attack again',
    file: L('coach', 'template.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`  const targets = ctx.facts
    .filter((f) => f.side === them && f.role === 'weakness')`,
      `  const targets = ctx.facts
    .filter((f) => f.side === them)`]],
  },
  {
    name: 'survey: a dead position is taught as one to convert again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (deadPosition) endgameTags.push('endgame_dead');
    else if (oppositeBishops) endgameTags.push('endgame_opposite_bishops');`,
      `    if (oppositeBishops) endgameTags.push('endgame_opposite_bishops');`]],
  },
  {
    name: 'survey: the isolated pawn is quoted as a book page again',
    file: L('coach', 'facts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (tags.includes('iqp_white') || tags.includes('iqp_black')) return 'iqp';`,
      `    if (tags.includes('carlsbad')) return 'carlsbad';
    if (tags.includes('iqp_white') || tags.includes('iqp_black')) return 'iqp';`]],
  },
  {
    name: 'survey: the last ending tested decides every ending again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (deadPosition) endgameTags.push('endgame_dead');
    else if (oppositeBishops) endgameTags.push('endgame_opposite_bishops');
    else if (bishopVsKnight) endgameTags.push('endgame_bishop_knight');`,
      `    if (deadPosition) endgameTags.push('endgame_dead');
    endgameTags.push('endgame_fortress');
    if (oppositeBishops) endgameTags.push('endgame_opposite_bishops');
    if (bishopVsKnight) endgameTags.push('endgame_bishop_knight');`]],
  },
  {
    name: 'survey: a queen against a bare king is taught as a fortress again',
    file: L('coach', 'features.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`      endgameTags.push(queenVsBareKing ? 'endgame_qk' : 'endgame_fortress');`,
      `      endgameTags.push('endgame_fortress');`]],
  },
  {
    name: 'survey: the model is shown the attacker plan for the defender again',
    file: L('coach', 'prompts.ts'),
    gate: COACH_CORE_GATE,
    edits: [[`    if (roleAttacker !== null && (entry.name === 'iqp' || entry.name === 'iq_pawn'
      || entry.name === 'hanging_pawns')) {
      return ctx.stm === roleAttacker ? entry.whitePlan : entry.blackPlan;
    }`,
      `    if (false) {
      return ctx.stm === roleAttacker ? entry.whitePlan : entry.blackPlan;
    }`]],
  },
];

const run = (gate) => spawnSync(process.execPath, [gate], { cwd: ROOT, encoding: 'utf8' });

let bad = 0;

// Precondition: on unmutated source every gate used below passes, so a red result means the mutation.
/*
 * `node scripts/mutate.mjs --filter coach:` runs only the mutations whose name
 * starts with the prefix — useful while a feature is still being built, so a
 * new batch can be proven without paying for the whole suite. The full run
 * (no flag) stays the release gate.
 */
const FILTER = process.argv[2] === '--filter' ? process.argv[3] : null;
if (process.argv[2] === '--filter' && !FILTER) {
  console.log('usage: node scripts/mutate.mjs --filter <name-prefix>');
  process.exit(2);
}
const SELECTED = FILTER ? MUTATIONS.filter((m) => m.name.startsWith(FILTER)) : MUTATIONS;
if (SELECTED.length === 0) {
  console.log(`no mutations match the filter "${FILTER}"`);
  process.exit(2);
}

const GATES = [...new Set([GATE, ...SELECTED.map((m) => m.gate ?? GATE)])];
for (const gate of GATES) {
  const base = run(gate);
  if (base.status !== 0) {
    console.log(`PRECONDITION FAILED: ${gate} is already red on unmutated source.`);
    console.log(base.stdout ?? base.stderr ?? '');
    process.exit(1);
  }
  console.log(`baseline: ${gate} green on unmutated source`);
}
console.log('-'.repeat(78));

for (const m of SELECTED) {
  const original = fs.readFileSync(m.file, 'utf8');
  // These sources are checked out with CRLF on Windows; a multi-line needle written with LF would
  // silently match nothing, and a mutation that never applied looks exactly like a gate that works.
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const keep = (s) => (nl === '\n' ? s : s.replace(/\n/g, nl));
  let applied = 0;
  try {
    let text = original;
    for (const [from, to, nth] of m.edits) {
      const find = keep(from);
      const hits = text.split(find).length - 1;
      // `nth` targets one occurrence of a block that appears verbatim more than once — two hint
      // buttons with identical bodies must each be provable, because guarding one of them is exactly
      // the bug this gate is about.
      const need = nth ?? 1;
      if (hits < need || (nth === undefined && hits !== 1)) {
        console.log(`SETUP    ${m.name}`);
        console.log(`         the text to revert occurs ${hits} times, ${nth === undefined ? 'exactly 1' : `at least ${need}`} needed`);
        console.log(`         ${JSON.stringify(find.slice(0, 70))}`);
        bad += 1;
        text = null;
        break;
      }
      let at = text.indexOf(find);
      for (let k = 1; k < need; k += 1) at = text.indexOf(find, at + find.length);
      text = text.slice(0, at) + keep(to) + text.slice(at + find.length);
      applied += 1;
    }
    if (text === null) continue;
    fs.writeFileSync(m.file, text);
    const r = run(m.gate ?? GATE);
    if (r.status === 0) {
      console.log(`NOT CAUGHT  ${m.name}  (${path.relative(ROOT, m.file)})`);
      console.log(`            the gate stayed GREEN with this reverted -- it does not test it`);
      bad += 1;
    } else {
      console.log(`caught   ${m.name}`);
    }
  } finally {
    fs.writeFileSync(m.file, original);
    if (fs.readFileSync(m.file, 'utf8') !== original) {
      console.log(`RESTORE FAILED  ${m.file}`);
      process.exit(1);
    }
  }
}

console.log(`${'-'.repeat(78)}`);
console.log(bad === 0
  ? `${MUTATIONS.length}/${MUTATIONS.length} mutations caught; every source file restored`
  : `${bad} of ${MUTATIONS.length} mutations were NOT caught`);
process.exit(bad === 0 ? 0 : 1);
