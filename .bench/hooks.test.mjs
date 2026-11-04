/**
 * GATE 1j - no hook may be called after the component's first early return.
 *
 * The bug this exists for, verbatim from the device:
 *
 *     com.facebook.react.common.JavascriptException:
 *       Error: Rendered more hooks than during the previous render.
 *
 * A hook inside a conditional runs on the renders that take that branch and not on the others, so
 * React's hook list changes length between renders and it throws. It is thrown on the TRANSITION -
 * the render where the condition first differs - which is why nothing else in this project sees it:
 *
 *   - tsc is clean, because the code is legal TypeScript. This is a runtime contract, not a type.
 *   - the behaviour gates pass, because they test the pure functions. The crash needs a
 *     component, a conditional and a tap.
 *   - the screen LOOKS right beforehand. Opening "Your openings" renders the list, which skips the
 *     conditional block entirely, so the old list shows and the new UI looks like it never shipped.
 *     Only tapping an opening enters the block and throws.
 *
 * That last point is what makes it expensive. It does not crash on arrival, it crashes on first use
 * of the feature, and it presents as the feature not existing. It has now been made twice in one
 * file - once with an effect, once with a memo.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GATE IS, SO IT IS NOT OVER-TRUSTED
 * ---------------------------------------------------------------------------
 *
 * It is a textual analysis. It understands `if` / `else` / `switch` / `case` / `? :` / `for` /
 * `while` / `do` / `try` / `catch` / `finally` / `=>` / `function`, and hooks by name. Given that,
 * two things are certain rather than inferred:
 *
 *   - a hook called inside a conditional in a component body IS a runtime error, whether or not
 *     the branch is ever taken; and
 *   - a hook called after that component's first `return` is unreachable, so it is dead code.
 *
 * It cannot see a hook that is unconditional but reads a value from a hook called later, an effect
 * whose dependency array changes meaning, or a rule broken inside a custom hook. Those need the
 * device. What this buys is that the mistake is loud in a second rather than silent in a
 * forty-minute build.
 *
 * Legal shapes:
 *
 *   - unconditional in the body.       Legal. Where hooks belong.
 *   - inside a NESTED function.        Legal: a different function, its own hook list.
 *   - conditional, before any return.  Legal - a hook called on every render.
 *   - conditional, after the return.   ILLEGAL. This is the bug.
 *
 * Getting this right took three corrections, each of which the gate recorded about itself, because
 * a gate that cries wolf on its first run trains its reader to ignore it:
 *
 *   1. it treated any `return` as the component's early return, so a helper above the component
 *      supplied it and every legitimate hook in the file was reported dead - 166 false positives;
 *   2. it stored only the OPEN braces, so by the time it looked a kind up the map was empty and it
 *      reported every screen clean;
 *   3. it classified `useEffect(() => {` as a plain block, because the arrow's brace sits inside an
 *      unclosed paren group - blind to hooks in callbacks, and 147 more false positives.
 *
 * §1 and §3 exist so that a future change to this file has to prove itself before §2's "0 found"
 * is allowed to mean anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const HOOKS = new Set([
  'useState', 'useReducer', 'useEffect', 'useLayoutEffect', 'useInsertionEffect',
  'useCallback', 'useMemo', 'useRef', 'useImperativeHandle', 'useDebugValue',
  'useContext', 'useDeferredValue', 'useTransition', 'useId', 'useSyncExternalStore',
  'useOptimistic', 'useActionState', 'useEffectEvent',
]);

const COND_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);

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

// ---------------------------------------------------------------------------
// Lexing. Brace counting has to survive prose, because this codebase is mostly prose.
// ---------------------------------------------------------------------------

/**
 * Blank out comments, strings and template LITERALS, preserving every offset.
 *
 * A naive scan is not good enough here, and this project has been burned by that class of shortcut:
 * a `for (const [from, to] of FLAT_ARRAY_OF_STRINGS)` destructured each string's CHARACTERS and
 * replaced every parenthesis in two source files.
 *
 * The hard part is templates, because a template can contain code that contains a template:
 *
 *     label: `${QUALITY_META[m.kind].name}${worse ? ` was ${m.bestMoveSan}` : ''}`,
 *
 * An earlier version handled `${...}` by scanning to the next unbalanced `}` and giving up at the
 * first backtick. On that line - real code, in AnalysisScreen - it consumed the rest of the
 * template as code, the enclosing `useMemo` frame never closed, and the analyser then reported the
 * next two `useMemo` calls as dead code. The gate was not wrong about the code, it was wrong about
 * the file, and it said so with complete confidence. That is the failure mode that matters most.
 *
 * So templates are tracked with a stack: each level is either in its literal body or inside a `${}`
 * hole, and the brace depth at the hole is recorded so its closing `}` is distinguishable from an
 * inner one. Everything inside a hole is code again, all the way down.
 */
function neutralise(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '; };

  const tmpl = [];                                   // { state: 'body' | 'hole', base }
  const inHole = () => tmpl.length > 0 && tmpl[tmpl.length - 1].state === 'hole';
  const inBody = () => tmpl.length > 0 && tmpl[tmpl.length - 1].state === 'body';

  let i = 0;
  let depth = 0;
  let prev = '';                                     // last significant CODE char: division vs regex

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (inBody()) {                                  // literal text: everything is inert
      if (c === '`') {                               // ...except the backtick that ENDS it
        out[i] = ' '; tmpl.pop(); prev = '`'; i += 1; continue;
      }
      if (c === '$' && c2 === '{') {
        out[i] = ' '; out[i + 1] = ' ';              // delimiters go, the hole itself is code
        tmpl[tmpl.length - 1].state = 'hole';
        tmpl[tmpl.length - 1].base = depth;
        depth += 1;   // the hole's `{` is structural: its `}` must find it, and it is blanked
        i += 2; continue;
      }
      out[i] = ' '; i += 1; continue;
    }
    if (c === '{') { depth += 1; prev = c; i += 1; continue; }
    if (c === '}') {
      if (inHole() && depth === tmpl[tmpl.length - 1].base + 1) {
        out[i] = ' ';                                // this `}` closed the hole, not a block
        depth -= 1;
        tmpl[tmpl.length - 1].state = 'body';
        i += 1; continue;
      }
      depth = Math.max(0, depth - 1); prev = c; i += 1; continue;
    }
    if (c === '/' && c2 === '/') {
      let j = i; while (j < n && src[j] !== '\n') j += 1;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    /*
     * ORDER IS LOAD-BEARING, in both directions, and both mistakes have been made here.
     *
     * Template LITERALS are handled above, before comments: a URL inside a template body contains
     * `//`, and treating that as a line comment swallows the closing backtick.
     *
     * Backticks come after comments: this codebase is mostly prose, and the prose is full of
     * backticks - "`allLinesOf` is the round-robin merge". A backtick inside a comment that opens a
     * template blanks every hook after it. The version that did that saw 94 hooks across the eleven
     * screens where the one before it saw 275, and reported every screen clean.
     */
    if (c === '`') {                                 // opens a template; a hole's nested ones
      out[i] = ' ';
      tmpl.push({ state: 'body', base: depth });
      prev = '`'; i += 1; continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        if (src[j] === '\n') break;                  // unterminated: do not run away
        j += 1;
      }
      blank(i, Math.min(j + 1, n)); i = j + 1; prev = q; continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev))) {
      let j = i + 1; let cls = false; let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(src[j])) j += 1;
        blank(i, j); i = j; prev = '/'; continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Scanning. Every brace, paren, return and hook becomes an event tagged with its CHAIN.
// ---------------------------------------------------------------------------

function scan(src) {
  const events = [];
  const parens = [];

  /*
   * `allFrames` keeps every brace that was opened, for the whole run; `open` is the stack of the
   * currently open ones, and a chain is made of those.
   *
   * They must be separate. A version that stored only the open frames and deleted them as braces
   * closed, then looked kinds up afterwards, found an empty map and reported every screen clean.
   * A gate that says "clean" because its own bookkeeping was thrown away is worse than no gate.
   */
  const allFrames = new Map();                        // id -> { kind, at, line, chain }
  const open = [];

  const starts = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === '\n') starts.push(k + 1);
  const lineAt = (idx) => {
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const lineText = (idx) => {
    const li = lineAt(idx) - 1;
    return src.slice(starts[li], (starts[li + 1] ?? src.length + 1) - 1).trim();
  };

  /**
   * The most recently CLOSED paren group. `if (x) {` closes its group before the brace arrives, so
   * the keyword has to be remembered rather than read off the open-paren stack - a version that read
   * it off the stack classified every `if` body as a plain block.
   */
  let lastParen = { kw: '', text: '', at: -99 };
  let id = 0;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (c === '{') {
      const before = src.slice(Math.max(0, i - 140), i);
      const top = parens[parens.length - 1];         // non-null: this brace is INSIDE a group
      const justClosed = /\)\s*$/.test(before) && i - lastParen.at <= 3;
      let kind = 'block';
      /*
       * `=>` is tested FIRST, before the enclosing paren group is consulted. Every
       * `useEffect(() => {` and every `items.map((x) => {` puts the arrow's brace inside an
       * unclosed paren group, and a version that asked the paren group what it was classified all
       * of them as plain blocks - blind to hooks in callbacks, and 147 more false positives.
       */
      if (/=>\s*$/.test(before)) kind = 'fn';
      else if (top) {
        if (top.kw === 'fn' || (top.kw === 'other' && /\bfunction\b[^()]*$/.test(top.text))) kind = 'fn';
        else if (COND_KEYWORDS.has(top.kw)) kind = 'cond';
      } else if (justClosed && (lastParen.kw === 'fn'
        || (lastParen.kw === 'other' && /\bfunction\b[^()]*$/.test(lastParen.text)))) kind = 'fn';
      else if (justClosed && COND_KEYWORDS.has(lastParen.kw)) kind = 'cond';
      else if (/\b(else|do|try|finally)\s*$/.test(before)) kind = 'cond';
      else if (/\b(case|default)\b[^:{}()]*:?$/.test(before)) kind = 'cond';
      else if (/\b(function|class)\b[\w\s]*$/.test(before)) kind = 'fn';
      // A ternary branch. `?:` also occurs in type annotations, object literals and labels, so the
      // branch is decided by the NEAREST unclosed `?` or `:`.
      else if (/\?[^?:]*$/.test(before)) kind = 'cond';
      allFrames.set(++id, { kind, at: i, line: lineAt(i), chain: [...open, id] });
      open.push(id);
      continue;
    }
    if (c === '}') { open.pop(); continue; }
    if (c === '(') {
      const before = src.slice(Math.max(0, i - 140), i);
      const m = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
      const word = m ? m[1] : '';
      parens.push({
        kw: word === 'function' ? 'fn' : (COND_KEYWORDS.has(word) ? word : 'other'),
        text: before,
      });
      continue;
    }
    if (c === ')') {
      const top = parens.pop();
      lastParen = { kw: top?.kw ?? '', text: top?.text ?? '', at: i };
      continue;
    }
    if (!/[A-Za-z_$]/.test(c)) continue;
    if (/[A-Za-z0-9_$.]/.test(src[i - 1] ?? '')) continue;   // mid-identifier, or a property

    let j = i;
    while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
    const word = src.slice(i, j);
    const after = src.slice(j).match(/^\s*(.)/)?.[1] ?? '';
    const ch = [...open];

    if (word === 'return' && after !== ':') {
      events.push({ kind: 'return', chain: ch, line: lineAt(i), text: lineText(i) });
    } else if ((HOOKS.has(word) || /^use[A-Z]/.test(word)) && after === '(') {
      events.push({ kind: 'hook', chain: ch, line: lineAt(i), text: lineText(i), name: word });
    }
    i = j - 1;
  }
  return { events, frames: allFrames };
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

function ownFnIndex(chain, frames) {
  for (let i = chain.length - 1; i >= 0; i -= 1) if (frames.get(chain[i])?.kind === 'fn') return i;
  return -1;
}

function analyse(src) {
  const { events, frames } = scan(src);

  /*
   * Each function's FIRST return, keyed by the chain up to and including its own function frame. A
   * return inside a nested helper therefore belongs to the helper and cannot be mistaken for the
   * component's - which is the mistake that produced 166 false positives.
   */
  const firstReturn = new Map();
  for (const e of events) {
    if (e.kind !== 'return') continue;
    const f = ownFnIndex(e.chain, frames);
    if (f < 0) continue;
    const key = e.chain.slice(0, f + 1).join(',');
    if (!firstReturn.has(key)) firstReturn.set(key, e);
  }

  const findings = [];
  const dead = [];
  for (const e of events) {
    if (e.kind !== 'hook') continue;
    const f = ownFnIndex(e.chain, frames);
    if (f < 0) continue;                              // no enclosing function: not this gate's job
    const ret = firstReturn.get(e.chain.slice(0, f + 1).join(','));
    if (!ret || e.line <= ret.line) continue;

    let conditional = false;
    let nestedFn = false;
    for (let i = f + 1; i < e.chain.length; i += 1) {
      const k = frames.get(e.chain[i])?.kind;
      if (k === 'fn') { nestedFn = true; break; }      // a different component: legal
      if (k === 'cond') conditional = true;
    }
    if (nestedFn) continue;
    (conditional ? findings : dead).push(e);
  }
  return { findings, dead, events, frames, firstReturn };
}

// ---------------------------------------------------------------------------
head('1. THE ANALYSIS KNOWS THESE CASES APART');

/*
 * If any of these is wrong, §2's "0 found" means nothing. Case 8 is the regression that produced
 * 166 false positives; the last case is a property, not a hook.
 *
 * `f` counts findings (a hook inside a conditional) and `d` counts dead hooks (a hook after the
 * return with nothing conditional around it). Both are reports, so either satisfies "the gate sees
 * it". The ternary case is 0/1 rather than 1/0 because a ternary creates no brace for the analyser
 * to enter, so it reads as unconditional - still reported, which is what matters.
 */
{
  const wrap = (body) => `const x = 1;\nexport default function C() {\n${body}\n}\n`;
  const cases = [
    ['hook in the body, no return', 'const [a, setA] = useState(0);\nreturn null;', 0, 0],
    ['hook before the return', 'const [a] = useState(0);\nreturn a;', 0, 0],
    ['hook in a conditional BEFORE the return - legal', 'if (x) { const [a] = useState(0); }\nreturn null;', 0, 0],
    ['hook in a conditional AFTER the return - THE BUG', 'return null;\nif (x) { const [a] = useState(0); }', 1, 0],
    ['hook after the return, unconditional - dead', 'return null;\nconst [a] = useState(0);', 0, 1],
    ['hook in a NESTED component after the return - legal', 'return null;\nfunction Sub() { const [a] = useState(0); return a; }', 0, 0],
    ['hook in a for loop after the return', 'return null;\nfor (const x of y) { const [a] = useState(0); }', 1, 0],
    ['hook in a ternary after the return', 'return null;\nconst a = x ? useMemo(f, []) : 1;', 0, 1],
    ['hook inside a map callback after the return - legal', 'return null;\n{y.map((i) => { const [a] = useState(i); return a; })}', 0, 0],
    ['custom hook in a conditional after the return', 'return null;\nif (x) { const a = useMyThing(); }', 1, 0],
    ['else-if after the return', 'return null;\nelse if (x) { const [a] = useState(0); }', 1, 0],
    ['switch case after the return', 'return null;\nswitch (k) { case 1: { const [a] = useState(0); } }', 1, 0],
    ['a property named useMemo is not a hook', 'return null;\nif (x) { obj.useMemo(f); }', 0, 0],
    ['hook inside a try after the return', 'return null;\ntry { const [a] = useState(0); } catch (e) {}', 1, 0],
    ['arrow component declared before the return', 'const Sub = () => { const [a] = useState(0); return a; };\nreturn null;', 0, 0],
    ['a hook in a helper above the component is not dead', 'return null;\nconst [a] = useState(0);', 0, 1, 'helper'],
  ];

  const wrong = [];
  for (const [label, body, wf, wd, mod] of cases) {
    let src = wrap(body);
    if (mod === 'helper') src = `function helper(k) {\n  if (!k) return 0;\n  return 1;\n}\n` + src;
    const { findings, dead } = analyse(neutralise(src));
    if (findings.length !== wf || dead.length !== wd) {
      wrong.push(`${label}: expected ${wf}/${wd}, got ${findings.length}/${dead.length}`);
    }
  }
  ok(wrong.length === 0, `all ${cases.length} shapes are classified correctly`, wrong.join('\n'));
}

// ---------------------------------------------------------------------------
head('2. NO HOOK IS CALLED AFTER AN EARLY RETURN, IN THE REAL SCREENS');

const files = fs.readdirSync(path.join(SRC, 'components', 'screens'))
  .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
  .map((f) => path.join(SRC, 'components', 'screens', f));

const allFindings = [];
const allDead = [];
let hooksSeen = 0;
let retsSeen = 0;
let fnSeen = 0;

for (const file of files) {
  const { findings, dead, events, frames } = analyse(neutralise(fs.readFileSync(file, 'utf8')));
  hooksSeen += events.filter((e) => e.kind === 'hook').length;
  retsSeen += events.filter((e) => e.kind === 'return').length;
  fnSeen += [...frames.values()].filter((f) => f.kind === 'fn').length;
  const rel = path.relative(ROOT, file);
  for (const f of findings) allFindings.push({ ...f, file: rel });
  for (const d of dead) allDead.push({ ...d, file: rel });
}

ok(hooksSeen > 200, `the sweep sees the screens' hooks (${hooksSeen} hooks)`);
ok(retsSeen > 20, `and their returns (${retsSeen})`);
ok(fnSeen > 60, `and it distinguishes functions (${fnSeen} function bodies)`);

ok(allFindings.length === 0,
  `no hook is called inside a conditional that can be skipped (${allFindings.length} in ${files.length} screens)`,
  allFindings.map((f) => `${f.file}:${f.line}  ${f.name}()   ${f.text}`).join('\n'));

ok(allDead.length === 0,
  `no hook is unreachable behind an early return (${allDead.length} in ${files.length} screens)`,
  allDead.slice(0, 30).map((f) => `${f.file}:${f.line}  ${f.name}()   ${f.text}`).join('\n')
  + (allDead.length > 30 ? `\n          ... and ${allDead.length - 30} more` : ''));

// ---------------------------------------------------------------------------
head('3. THE SWEEP CATCHES THE REAL BUG, IN A REAL FILE');

/*
 * §1 proves the analysis on synthetic shapes and §2 reports the screens as clean. Neither matters if
 * §2's verdict is an artefact of the analyser being blind on real code. So take the screen that
 * actually crashed, inject the mistake the device reported - a `useMemo` inside a conditional render
 * block placed after an early return - and require it to be reported.
 */
{
  const target = path.join(SRC, 'components', 'screens', 'GameOpeningsScreen.tsx');
  const original = fs.readFileSync(target, 'utf8');
  const src = neutralise(original);

  const before = analyse(src);
  ok(before.findings.length === 0 && before.dead.length === 0,
    'the screen that crashed is clean BEFORE the injection',
    [...before.findings, ...before.dead].map((f) => `line ${f.line} ${f.name}()`).join('\n'));

  /*
   * Pick a conditional frame whose PARENT is a function frame - so the injected hook is unambiguously
   * in that function's body rather than in some nested callback - and whose function has already
   * returned by that line. Those two conditions are what make the injection reproduce the crash
   * rather than merely adding a hook somewhere harmless.
   */
  const { frames, firstReturn } = before;
  const targets = [...frames.values()].filter((f) => {
    if (f.kind !== 'cond') return false;
    const parent = f.chain[f.chain.length - 2];
    if (parent == null || frames.get(parent)?.kind !== 'fn') return false;
    const ret = firstReturn.get(f.chain.slice(0, f.chain.length - 1).join(','));
    return !!ret && ret.line < f.line;
  });

  ok(targets.length > 0,
    `a conditional render block after an early return exists to inject into (${targets.length} found)`);

  if (targets.length > 0) {
    const victim = targets[0];
    const at = victim.at + 1;
    const injected = `${src.slice(0, at)}\n  const __gateControl = useMemo(() => 1, []);${src.slice(at)}`;
    const { findings, dead } = analyse(injected);
    const reported = [...findings, ...dead].some((f) => f.name === 'useMemo' && f.text.includes('__gateControl'));
    ok(reported,
      'CONTROL: the sweep reports the injected conditional hook, so 0 found means clean',
      [...findings, ...dead].map((f) => `line ${f.line} ${f.name}() ${f.text}`).join('\n'));
  }
}

// ---------------------------------------------------------------------------
head('4. LEXING IS HONEST');

{
  // The real shape from AnalysisScreen: a template whose hole contains another template.
  const nested = [
    'const l = `${A[m.kind].name}${w ? ` was ${m.best}` : \'\'}`;',
    'function C() {',
    '  useEffect(() => {',
    '    if (p) return () => { alive = false; };',
    '  }, [p]);',
    '  const x = useMemo(() => 1, []);',
    '  return null;',
    '}',
  ].join('\n');
  const { events, frames } = analyse(neutralise(nested));
  const fns = [...frames.values()].filter((f) => f.kind === 'fn');
  ok(fns.length === 3, `a nested template does not swallow the code after it (${fns.length} functions seen, expected 3)`);
  ok(events.filter((e) => e.kind === 'return').length === 2,
    `and its returns are still seen (${events.filter((e) => e.kind === 'return').length})`);
  ok(events.filter((e) => e.kind === 'return').every((e) => e.chain.length <= 3),
    'no return is left stranded inside the template');

  // Comments and strings must not contribute structure or control flow.
  const inert = 'function C() {\n  // } { return 1; useMemo(f);\n  const s = "} { return 2;";\n  const r = /[}{]/;\n  return 3;\n}\n';
  const ie = analyse(neutralise(inert));
  ok(ie.events.filter((e) => e.kind === 'return').length === 1,
    'braces, `return` and `useMemo` inside comments and strings are not code',
    ie.events.map((e) => `${e.kind} line ${e.line} ${e.text}`).join('\n'));
  ok(ie.events.filter((e) => e.kind === 'hook').length === 0,
    'and a hook inside a comment is not counted as a hook');
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
