/**
 * RUN EVERY GATE, AND COUNT THEM HONESTLY.
 *
 * "All gates pass" is a claim about how many files were run, so this prints the file count as well as
 * the assertion count. A summary line that reports 46/46 while executing 22 files is worse than no
 * summary at all, and that is exactly the mistake this script exists to make impossible.
 *
 *   node scripts/run-gates.mjs            every gate
 *   node scripts/run-gates.mjs youropen   only gates whose name contains "youropen"
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = path.join(ROOT, '.bench');
const filter = process.argv[2] ?? '';

const files = readdirSync(BENCH)
  .filter((f) => f.endsWith('.test.mjs') && f.includes(filter))
  .sort();

let ran = 0;
let filesOk = 0;
const problems = [];
const skipped = [];
let totalOk = 0;
let totalAll = 0;

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(BENCH, f)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  ran += 1;
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  /*
   * A GATE THAT SKIPPED IS NOT A GATE THAT PASSED.
   *
   * `endgame.live` needs the network. When it cannot reach it, it prints SKIPPED and exits 0, and a
   * runner that only looks at the exit code counts that as green - which is a claim about code that
   * was never executed. Skips are collected and printed separately, and the run is marked incomplete.
   */
  if (/^\s*SKIPPED\b/m.test(out)) {
    skipped.push(f);
    const why = out.split('\n').find((l) => /SKIPPED/.test(l)) ?? '';
    console.log(`  --  ${f}  (SKIPPED: ${why.trim()})`);
    continue;
  }

  // Several summary shapes exist in this repo and all of them are real: "169/169 passed",
  // "ALL CHECKS PASSED: 24/24 checks passed", "ALL PASSED: 39 passed, 0 failed", "OK - ...". The exit
  // code is the oracle, but trusting it alone would accept a file that printed OK and then crashed,
  // so each format is matched explicitly and a file printing none is reported as unknown rather
  // than silently counted green.
  // Two summary shapes, and they are NOT interchangeable: "24/24 checks passed" has the TOTAL second,
  // while "39 passed, 0 failed" has the FAILURES second. Reading the second number of the latter as a
  // total gives 39/0, which is how round4.fixes was about to be reported as a failing gate.
  const over = [...out.matchAll(/(\d+)\/(\d+)\s*(?:checks\s*)?passed/g)].pop();
  const of = [...out.matchAll(/(\d+)\s+passed,\s*(\d+)\s+failed/g)].pop();
  const frac = over ? { ok: Number(over[1]), all: Number(over[2]) }
    : of ? { ok: Number(of[1]), all: Number(of[1]) + Number(of[2]) }
      : null;
  const plainOk = /^\s*(?:OK\b|ALL CHECKS PASSED|ALL PASSED)/m.test(out);

  if (frac) {
    const { ok, all } = frac;
    totalOk += ok;
    totalAll += all;
    if (ok === all && r.status === 0) {
      filesOk += 1;
      console.log(`  ok  ${f}  (${ok}/${all})`);
    } else {
      problems.push(`${f}  — ${ok}/${all} passed, exit ${r.status}`);
      console.log(`  XX  ${f}  (${ok}/${all}, exit ${r.status})`);
      for (const line of out.split('\n')) {
        if (/\bFAIL\b/.test(line)) console.log(`        ${line.trim()}`);
      }
      if (!/\bFAIL\b/.test(out) && r.stderr) {
        console.log(`        ${r.stderr.trim().split('\n').slice(-4).join('\n        ')}`);
      }
    }
    continue;
  }

  if (plainOk && r.status === 0) {
    filesOk += 1;
    console.log(`  ok  ${f}  (summary line)`);
    continue;
  }

  problems.push(`${f}  — no recognised summary (exit ${r.status})`);
  console.log(`  ??  ${f}  — NO SUMMARY (exit ${r.status})`);
  const tail = out.trim().split('\n').slice(-4).join('\n        ');
  if (tail) console.log(`        ${tail}`);
}

console.log('');
console.log(`GATE FILES RUN  : ${ran}`);
console.log(`GATE FILES OK   : ${filesOk}`);
console.log(`GATE FILES SKIP : ${skipped.length}${skipped.length ? `  (${skipped.join(', ')})` : ''}`);
console.log(`ASSERTIONS      : ${totalOk}/${totalAll}`);
if (problems.length) {
  console.log('');
  console.log('PROBLEMS:');
  for (const p of problems) console.log(`  - ${p}`);
}
if (skipped.length) {
  console.log('');
  console.log('NOT RUN - these are NOT evidence of anything:');
  for (const s of skipped) console.log(`  - ${s}`);
}
if (problems.length) process.exit(1);
if (ran === 0) {
  console.log('no gate matched that filter — a filter that runs nothing is not a pass');
  process.exit(1);
}
console.log(skipped.length ? 'GREEN, BUT INCOMPLETE - see the skipped list above' : 'ALL GREEN');