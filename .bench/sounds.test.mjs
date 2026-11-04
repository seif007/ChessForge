/**
 * GATE — the sound vocabulary exists on both sides of the WebView.
 *
 * React Native cannot play the procedurally synthesised sounds, so they are made
 * in a hidden WebView (`src/engine/sound-host.html`) and that file is inlined
 * into `src/engine/assets.ts` by `scripts/build-engine-assets.mjs`. A kind added
 * to one side and not the other fails silently: `play('checkmate')` posts a
 * message no `case` handles, and the ending is quiet with no error anywhere.
 *
 * So this gate checks the contract, not the audio: every kind the TypeScript API
 * can send has a synthesis branch, every new ending kind is reachable through the
 * helpers, and the generated asset carries the updated host.
 *
 * Run: node .bench/sounds.test.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const sounds = read('src/lib/sounds.ts');
const host = read('src/engine/sound-host.html');
const assets = read('src/engine/assets.ts');

let checks = 0;
let failures = 0;
function ok(cond, label, detail = '') {
  checks += 1;
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}

/* ------------------------------------------------- 1. the API's own kinds */

const apiKinds = sounds
  .match(/export type SoundKind =([\s\S]*?);/)?.[1]
  .match(/'([a-z]+)'/g)
  ?.map((s) => s.replace(/'/g, '')) ?? [];

ok(apiKinds.length >= 10, 'the sound API declares its vocabulary', apiKinds.join(', '));
for (const kind of ['move', 'capture', 'check', 'checkmate', 'gamewin', 'gamelose', 'draw', 'tournament', 'fanfare']) {
  ok(apiKinds.includes(kind), `"${kind}" is part of the API vocabulary`);
}

/* -------------------------------------- 2. every kind has a synth branch */

for (const kind of apiKinds) {
  // `case 'kind':` in the host's `synth` switch.
  ok(new RegExp(`case '${kind}':`).test(host),
    `the sound host synthesises "${kind}"`);
}

/* ------------------------- 3. the ending helpers route to the right sting */

ok(/if \(m\.san\.includes\('#'\)\) play\('checkmate'\)/.test(sounds),
  'a mating move plays the checkmate sting, before the capture/promote branches');
ok(/export function playGameEnd\(outcome: GameEndSound\)[\s\S]{0,300}play\(outcome === 'win' \? 'gamewin'/.test(sounds),
  'playGameEnd maps win/loss/draw to their own sounds');
ok(/export function playTournamentSound\(\)[\s\S]{0,120}play\('tournament'\)/.test(sounds),
  'entering a tournament has a helper');
ok(/export function playTournamentWinSound\(\)[\s\S]{0,120}play\('fanfare'\)/.test(sounds),
  'winning a tournament has its own, bigger fanfare');

/* ---------------------- 4. the generated asset actually carries the host */

ok(/case 'checkmate':/.test(assets) && /case 'fanfare':/.test(assets),
  'the inlined SOUND_HOST_HTML is regenerated (run scripts/build-engine-assets.mjs)',
  'the generated asset is stale — the app would play silence for the new kinds');

/* ------------------------- 5. the screens that own endings use the helpers */

for (const [file, label] of [
  ['src/components/screens/BotPlayScreen.tsx', 'bot games'],
  ['src/components/screens/ArenaGameScreen.tsx', 'Arena games'],
]) {
  const src = read(file);
  ok(/playMoveSound/.test(src), `${label} play a sound per move`);
  ok(/playGameEnd/.test(src), `${label} play an ending sound`);
}
ok(/playTournamentSound/.test(read('src/components/screens/TournamentScreen.tsx')),
  'the tournament screen plays the arrival fanfare');
ok(/playTournamentWinSound/.test(read('src/components/CelebrationBanner.tsx')),
  'a tournament win celebrates with the fanfare');

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures > 0 ? 1 : 0);