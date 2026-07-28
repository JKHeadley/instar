#!/usr/bin/env node
/**
 * recheck-parked-tests.mjs — the EXIT PATH for `FLAKY_TESTS`.
 *
 * THE DEFECT THIS CLOSES. `vitest.push.config.ts`'s `FLAKY_TESTS` array excludes tests from the
 * push/CI gate. Adding an entry costs nothing — the file is classified as ordinary config, so
 * removing a guard from CI needs no ELI16, no side-effects review, no trace. And NOTHING ever
 * re-checks whether a parked test could come back. Entry is free; exit is impossible. The ungated
 * surface can therefore only grow.
 *
 * That is not theoretical. Measured on 2026-07-27, three consecutive runs each:
 *
 *   notification-spam-prevention.test.ts  parked "assertion mismatch, emoji vs keyword"  15/15/15 PASS
 *   message-formatter.test.ts             parked "expects /msg reply format"             17/17/17 PASS
 *   ReflectionConsolidator.test.ts        parked "pattern detection non-deterministic"   16/16/16 PASS
 *
 * All three were repaired at some point and never re-armed. Note the INVERSE of the lesson already
 * recorded in that same file: the 2026-06-05 pair ROTTED while parked; these were FIXED while parked.
 * Nobody noticed either way, because nothing looks. A fourth entry,
 * `tests/unit/slack-stall-active-gate.test.ts`, does not exist on disk at all — an exclusion that
 * excludes nothing.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────────────────────────────
 *
 * It is a SIGNAL. It reports which parked entries now pass deterministically and which point at
 * missing files. It NEVER re-arms anything and never edits the config.
 *
 * That restraint is the design, not timidity: re-arming is a JUDGEMENT about whether the reason for
 * parking still holds. "Passes on this machine" does not establish "passes in CI" — a third of the
 * list is parked for a native-binding failure whose stated scope is literally "on this machine", and
 * CI is a different environment where it may genuinely fail. A tool that auto-re-armed on a local
 * green would be exactly the confident-wrong-answer this whole area is about.
 *
 * ── WHY IT IS CHEAP ENOUGH TO ACTUALLY RUN ──────────────────────────────────────────────────────
 *
 * A tool nobody runs is a decoration, and running ~90 test files repeatedly is not something anyone
 * will do. So the default is bounded: the missing-file scan is free (no test execution at all), and
 * only a small ROTATING slice is executed per invocation, chosen from a stable hash of the day. Over
 * successive runs the whole list is covered without any single run being expensive.
 *
 * Usage:
 *   node scripts/recheck-parked-tests.mjs                # missing-file scan + rotating slice
 *   node scripts/recheck-parked-tests.mjs --slice 20     # widen the slice
 *   node scripts/recheck-parked-tests.mjs --missing-only # free: no test execution
 *   node scripts/recheck-parked-tests.mjs --json         # machine-readable
 *   node scripts/recheck-parked-tests.mjs --runs 3       # runs per file (default 2)
 *
 * Always exits 0. It reports; it does not gate. Making it a gate would recreate the original
 * problem from the other side — a red build for a test somebody parked on purpose.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'vitest.push.config.ts');

function parseArgs(argv) {
  const out = { slice: 6, runs: 2, json: false, missingOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--missing-only') out.missingOnly = true;
    else if (a === '--slice') out.slice = Number(argv[++i]);
    else if (a === '--runs') out.runs = Number(argv[++i]);
  }
  if (!Number.isFinite(out.slice) || out.slice < 0) out.slice = 6;
  if (!Number.isFinite(out.runs) || out.runs < 1) out.runs = 2;
  return out;
}

/**
 * Read the parked entries out of the config.
 *
 * Deliberately a literal parse of the array rather than importing the config: importing would
 * execute it, and this must be safe to run against a config that does not load.
 */
function readParkedEntries() {
  const src = fs.readFileSync(CONFIG, 'utf-8');
  const m = /const FLAKY_TESTS = \[(.*?)\n\];/s.exec(src);
  if (!m) throw new Error(`could not locate FLAKY_TESTS in ${path.relative(ROOT, CONFIG)}`);

  // Parse LINE BY LINE and skip comments. A naive /'([^']+)'/g over the whole block also matches
  // apostrophes inside the prose — "the test's own beforeAll" yields a bogus entry `s own`. That is
  // not hypothetical: the first version of this script reported 42 dangling entries, nearly all of
  // them fragments of the explanatory comment added when two tests were re-armed. The array is
  // heavily commented BY DESIGN (those comments are what stop the next person re-parking on a wrong
  // label), so the parser has to tolerate prose rather than the prose having to stay terse.
  const entries = [];
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    const e = /^'([^']+)',?$/.exec(line);
    if (e) entries.push(e[1]);
  }
  return entries;
}

/** Stable rotation so successive runs cover the whole list without any run being expensive. */
function rotatingSlice(items, size, dayKey) {
  if (size <= 0 || items.length === 0) return [];
  let h = 0;
  for (const c of dayKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const start = h % items.length;
  return Array.from({ length: Math.min(size, items.length) }, (_, i) => items[(start + i) % items.length]);
}

function runOnce(file) {
  const res = spawnSync(
    process.execPath,
    ['./node_modules/.bin/vitest', 'run', file, '--reporter=basic'],
    { cwd: ROOT, encoding: 'utf-8', timeout: 300_000, env: { ...process.env } },
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status === 0) return 'pass';
  if (res.error || res.status === null) return 'errored';
  return /Tests\s+\d+\s+failed/.test(out) ? 'fail' : 'errored';
}

const opts = parseArgs(process.argv);
const entries = readParkedEntries();

// Glob patterns cannot be resolved to a single file; report them rather than pretending.
const isGlob = (e) => e.includes('*');
const concrete = entries.filter((e) => !isGlob(e));
const globs = entries.filter(isGlob);

const missing = concrete.filter((e) => !fs.existsSync(path.join(ROOT, e)));
const present = concrete.filter((e) => fs.existsSync(path.join(ROOT, e)));

const results = [];
if (!opts.missingOnly) {
  const dayKey = new Date().toISOString().slice(0, 10);
  for (const file of rotatingSlice(present, opts.slice, dayKey)) {
    const runs = Array.from({ length: opts.runs }, () => runOnce(file));
    const verdict = runs.every((r) => r === 'pass')
      ? 'deterministic-pass'
      : runs.every((r) => r === 'fail')
        ? 'deterministic-fail'
        : runs.includes('errored')
          ? 'could-not-run'
          : 'genuinely-flaky';
    results.push({ file, runs, verdict });
  }
}

const report = {
  parkedTotal: entries.length,
  concrete: concrete.length,
  globPatterns: globs,
  missingFiles: missing,
  checked: results,
  note:
    'SIGNAL ONLY — nothing is re-armed. A local deterministic-pass does NOT establish that the ' +
    'test passes in CI; a third of this list is parked for an environment reason whose stated ' +
    'scope is "on this machine". Re-arming remains a judgement.',
};

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nParked tests: ${report.parkedTotal} entries (${concrete.length} concrete, ${globs.length} glob patterns)\n`);
  if (missing.length) {
    console.log(`  ENTRIES POINTING AT NOTHING (${missing.length}) — excluding a file that does not exist:`);
    for (const f of missing) console.log(`    - ${f}`);
    console.log('');
  } else {
    console.log('  No dangling entries.\n');
  }
  if (results.length) {
    console.log(`  RE-CHECKED THIS RUN (rotating slice of ${results.length}, ${opts.runs} runs each):`);
    for (const r of results) console.log(`    ${r.verdict.padEnd(20)} ${r.file}`);
    const back = results.filter((r) => r.verdict === 'deterministic-pass');
    if (back.length) {
      console.log(`\n  ${back.length} entr${back.length === 1 ? 'y' : 'ies'} now pass deterministically HERE.`);
      console.log('  That is a prompt to look, not a verdict: re-arming is a judgement about whether');
      console.log('  the environment reason still holds, and CI is a different environment.');
    }
  }
  console.log(`\n${report.note}\n`);
}

process.exit(0);
