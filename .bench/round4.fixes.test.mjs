/**
 * Round-4 regression bench.
 *
 * Four things were reported on the device and each one has a specific cause:
 *
 *  1. "i see the board but no arrows" — the arrow layer was built from
 *     `step.choice` alone, so a step where the user simply plays his own move
 *     (nothing to decide) drew nothing.
 *  2. "it kept comparing to 82 line i think (which take very long and this is
 *     inacceptable for every move)" — the engine sample walked the family's main
 *     spine AND all eight siblings: 91 searches for one card, measured on device.
 *  3. "then nothing changed" — a swipe on the board scrolled the page instead of
 *     moving the piece: the squares were `Pressable`s, which win the responder
 *     over the board's handlers and yield the gesture to the parent ScrollView.
 *  4. "the light mode keep it dark. there is no difference" — every module-level
 *     `StyleSheet.create` froze the dark palette at import, and the opaque
 *     full-screen `AppBackground` was one of them.
 *
 * §1 tests the REAL `themedStyles` by transpiling `src/theme/tokens.ts` and
 * loading it with only `react` and `react-native` stubbed — the same technique
 * the ts-module-harness skill prescribes. The stubs are faithful for this
 * purpose (`StyleSheet.create` is identity in React Native; `useMemo`/`useSyncExternalStore`
 * are not reached by `themedStyles`), so a green here is a statement about the
 * shipping code rather than about a mirror.
 *
 * §2 pins the other three fixes in the source, the way
 * `openings.clickandboot.test.mjs` does, because they live in call sites and
 * constants that no pure function can expose.
 *
 * Run:  node .bench/round4.fixes.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('module');
const ts = require('typescript');

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/* ===================================================================== §1 ====
 * The REAL tokens.ts, loaded with only react / react-native stubbed.
 * ========================================================================== */

const STUBS = {
  'react-native': {
    StyleSheet: { create: (o) => o },
  },
  react: {
    useMemo: (f) => f(),
    useSyncExternalStore: () => 'dark',
  },
};

function loadTsModule(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: absPath,
  }).outputText;

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return `\0stub:${request}`;
    return origResolve.call(this, request, ...rest);
  };
  try {
    for (const [name, exports] of Object.entries(STUBS)) {
      const id = `\0stub:${name}`;
      require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const m = new Module(absPath, null);
    m.filename = absPath;
    m.paths = Module._nodeModulePaths(dirname(absPath));
    m._compile(js, absPath);
    return m.exports;
  } finally {
    Module._resolveFilename = origResolve;
  }
}

console.log('\n§1  themedStyles actually follows the theme (real tokens.ts)');

const tokens = loadTsModule(join(ROOT, 'src/theme/tokens.ts'));

/*
 * The exact shape every converted sheet now has. `colors` is the live Proxy, so
 * a sheet built inside a function reads the palette at BUILD time rather than at
 * import time — which is the whole fix.
 */
const themedSheet = tokens.themedStyles(() => ({
  base: { backgroundColor: tokens.colors.background },
  text: { color: tokens.colors.foreground },
}));

const darkBg = tokens.darkPalette.background;
const lightBg = tokens.lightPalette.background;

ok('dark and light palettes really differ', darkBg !== lightBg, `${darkBg} vs ${lightBg}`);

/*
 * THE APP OPENS LIGHT, AND THE THEME IS SET BEFORE ANY OF THIS IS BUILT.
 *
 * The app's default is light - the requirement was a white default theme - and this bench used to
 * capture its "frozen" literal at import time and then assert it held the DARK value, on the
 * assumption that dark was the default. That assumption died with the rebrand, and the failure it
 * produced was the gate complaining about the default theme while saying nothing about the freeze.
 *
 * So the theme is set explicitly here, first, and the freeze is asserted against the value that was
 * actually current when the literal was built. The property under test does not care which palette
 * that is; what it cares about is that the value does not follow.
 */
tokens.setActiveTheme('dark');

const frozenSheet = { base: { backgroundColor: tokens.colors.background } };
const frozenAtBuild = tokens.colors.background;
ok('the literal captured the palette that was active when it was built',
  frozenSheet.base.backgroundColor === frozenAtBuild,
  `${frozenSheet.base.backgroundColor} vs ${frozenAtBuild}`);

ok('themed sheet starts dark', themedSheet.base.backgroundColor === darkBg,
  themedSheet.base.backgroundColor);

tokens.applyTheme('light');
ok('themed sheet switches to light', themedSheet.base.backgroundColor === lightBg,
  `got ${themedSheet.base.backgroundColor}, want ${lightBg}`);
ok('themed sheet switches its text colour too',
  themedSheet.text.color === tokens.lightPalette.foreground,
  themedSheet.text.color);

/*
 * THE REGRESSION ITSELF. This is what the old code did, and it must still be
 * broken - if a plain object literal ever started following the theme, the
 * premise of the fix (and of this bench) would be wrong.
 *
 * Asserted as "unchanged by the switch", not as "equals dark": the second form only works while dark
 * happens to be the default, which is a fact about the app's configuration rather than about the
 * mechanism, and it is how this check came to be reporting the wrong thing.
 */
ok('a plain literal does NOT follow the theme (the original bug)',
  frozenSheet.base.backgroundColor === frozenAtBuild
  && frozenSheet.base.backgroundColor !== tokens.colors.background,
  `literal ${frozenSheet.base.backgroundColor}, live ${tokens.colors.background}`);

tokens.applyTheme('dark');
ok('switching back restores dark', themedSheet.base.backgroundColor === darkBg);

/* The cache must not leak one theme's sheet into another's. */
tokens.applyTheme('light');
const lightFirst = themedSheet.base.backgroundColor;
tokens.applyTheme('dark');
tokens.applyTheme('light');
ok('the per-theme cache is stable across switches',
  themedSheet.base.backgroundColor === lightFirst && lightFirst === lightBg);

/* ===================================================================== §2 ====
 * The three call-site fixes.
 * ========================================================================== */

const SCREEN = read('src/components/screens/GameOpeningsScreen.tsx');
const BOARD = read('src/components/chess/ChessForgeBoard.tsx');

console.log('\n§2a  arrows cover the user\'s own move, not only the decisions');

/*
 * These three assertions were written against the literal `step?.isUserMove` / `add(step.moveUci`, and
 * they stopped matching when the arrow was re-derived from the board instead of from the line index.
 *
 * `activeLine` can come from `overrideLine`, `resolveLine`, `lastLineRef` or `alternates[...]`, so
 * `step.moveUci` names a move in SOME line - not necessarily in the position on the board, which is the
 * arrow bug the "i see the board but no arrows" report was about. The arm now reads `userMoveHere`,
 * which tries each candidate move ON THE LIVE FEN and keeps the first one that is legal there.
 *
 * So the behaviour asserted here is unchanged and stronger, and the assertions follow it. The rejection
 * text moved too: it used to read "This line plays X - follow the arrow", which named the answer and
 * then told the user to obey it while the board stood several moves past the mistake. It now names the
 * move and sends them back to play it, and the two arrows are drawn on the board - which is the "points
 * at the arrow" half of the original assertion, now true of the board rather than of a sentence.
 */
ok('an isUserMove branch exists in the arrow build',
  /else if \(userMoveHere\) \{/.test(SCREEN),
  'the arm that draws the user own move where there is nothing to decide');
ok('it adds the user own move as an arrow',
  /add\(userMoveHere\.moveUci, arrowColors\.hint\)/.test(SCREEN));
ok('CONTROL: and the move it draws is validated against the board being shown',
  /probe\.move\(s\.moveSan\)/.test(SCREEN),
  'userMoveHere must not read a move off a line index');
ok('the decision arrows are still there',
  /add\(choice\.playedUci, arrowColors\.reply\)/.test(SCREEN)
  && /add\(choice\.recommendUci, arrowColors\.hint\)/.test(SCREEN));
ok('a rejected move names the move',
  /this position needs \$\{mistake\.san\}/.test(SCREEN),
  'the rejection must say which move, not only that it was wrong');
ok('and both arrows are drawn where the mistake is',
  /add\(mistake\.recommendUci, arrowColors\.hint\)/.test(SCREEN)
  && /add\(mistake\.playedUci, colors\.bad\)/.test(SCREEN),
  'the board must show what was played and what to play, which is what "points at the arrow" means');

console.log('\n§2b  the engine sample is the LINE, not the family');

ok('sampleForLine takes the lines to walk', /lines: BuilderStep\[\]\[\],/.test(SCREEN));
ok('it walks only those lines', /for \(const steps of lines\) \{/.test(SCREEN));
ok('it no longer walks the family\'s own spine + alternates',
  !/for \(const steps of \[family\.steps, \.\.\.family\.alternates\]\)/.test(SCREEN));
ok('the call site passes the line being played',
  /stepsForLine\(openFamily, lineRef\)/.test(SCREEN));
ok('stepsForLine resolves a LineRef back to steps',
  /function stepsForLine\(f: FamilyLine, ref: LineRef\): BuilderStep\[\]/.test(SCREEN));
{
  const m = /const ENGINE_BUDGET_MAX = (\d+);/.exec(SCREEN);
  const max = m ? Number(m[1]) : NaN;
  ok('the engine budget is capped at 24 positions or fewer', max <= 24, `ENGINE_BUDGET_MAX=${max}`);
  const h = /const ENGINE_HEAD = (\d+);/.exec(SCREEN);
  const head = h ? Number(h[1]) : NaN;
  ok('the first publish happens after 4 positions or fewer', head <= 4, `ENGINE_HEAD=${head}`);
  const cap = /const ENGINE_SEARCH_CAP_MS = (\d+);/.exec(SCREEN);
  const capMs = cap ? Number(cap[1]) : NaN;
  ok('the main search has a sub-second cap', capMs > 0 && capMs <= 500, `ENGINE_SEARCH_CAP_MS=${capMs}`);
  const probe = /const ENGINE_PROBE_CAP_MS = (\d+);/.exec(SCREEN);
  const probeMs = probe ? Number(probe[1]) : NaN;
  ok('the played-move probe has its own, smaller cap',
    probeMs > 0 && probeMs <= capMs, `ENGINE_PROBE_CAP_MS=${probeMs}`);
  ok('the engine searches at depth 10', /depth: 10,/.test(SCREEN) && !/depth: 12,/.test(SCREEN));
}
ok('the family is not rebuilt under a session already in progress',
  /if \(answeredRef\.current\) return;/.test(SCREEN));

console.log('\n§2c  the board owns the gesture, so a swipe moves a piece');

ok('the board captures the responder', /onStartShouldSetResponderCapture/.test(BOARD));
ok('and captures movement', /onMoveShouldSetResponderCapture/.test(BOARD));
ok('it refuses to hand the gesture to the ScrollView',
  /onResponderTerminationRequest: \(\) => false/.test(BOARD));
ok('the squares are no longer Pressables', !/<Pressable/.test(BOARD));
ok('the square render is a plain View', /<View\n\s+key=\{square\}/.test(BOARD));
ok('the pending selection is readable from the one-shot handler',
  /const selectedRef = useRef<string \| null>\(null\);/.test(BOARD));
ok('legality is asked of the board, not of the last render\'s memo',
  /const isLegalTarget = useCallback/.test(BOARD));
ok('a second tap completes a click-to-move',
  /const origin = from \?\? pending;/.test(BOARD));

console.log('\n§2d  every palette-reading sheet is themed');

const SHEETS = [
  'src/components/AppBackground.tsx',
  'src/components/AppShell.tsx',
  'src/components/screens/ProfileScreen.tsx',
  'src/components/screens/HomeScreen.tsx',
  'src/components/screens/GameOpeningsScreen.tsx',
  'src/components/screens/StatsScreen.tsx',
  'src/components/ui/Primitives.tsx',
];
for (const p of SHEETS) {
  const src = read(p);
  const frozen = /^const \w+ = StyleSheet\.create\(\{/m.test(src)
    || /^export const \w+ = StyleSheet\.create\(\{/m.test(src);
  ok(`${p.split('/').pop()} has no frozen palette sheet`, !frozen);
}
ok('AppBackground (the opaque backdrop) is themed',
  /const styles = themedStyles\(\(\) => \(\{/.test(read('src/components/AppBackground.tsx')));

console.log(`\n${fail === 0 ? 'ALL PASSED' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
