#!/usr/bin/env node
// rescore.mjs — recompute pass/correct/formatOk for every recorded row from
// its stored output, using the CURRENT score2 contract. Exists because scorer
// fixes land mid-run (e.g. the 2026-07-02 fence-tolerance production-parity
// fix): rows already on disk carry verdicts from the old contract, and the
// live runners keep the old module in memory until they exit.
// Pure recomputation — zero API calls. Run ONLY after the stamp's runner has
// exited (it rewrites raw.jsonl in place; concurrent appends would be lost).
//
// Usage: node rescore.mjs --stamp <id>
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCase } from './score2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', null);
if (!STAMP) { console.error('--stamp required'); process.exit(4); }

// Load task defs from BOTH tasks/ and tasks-wave2/ (a wave-2 row whose task
// id wasn't found was silently skipped before this fix — wave2 rescore no-op'd).
// IB2_TASKDIR overrides for scratch/variant dirs.
const TASKDIRS = process.env.IB2_TASKDIR
  ? [join(HERE, process.env.IB2_TASKDIR)]
  : [join(HERE, 'tasks'), join(HERE, 'tasks-wave2')];
const tasks = new Map();
for (const dir of TASKDIRS) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (!t.promptTemplate && t.promptTemplateFile) t.promptTemplate = readFileSync(join(dir, t.promptTemplateFile), 'utf8');
    tasks.set(t.id, t);
  }
}

const OUTDIR = join(HERE, '..', 'results', 'instar-bench-v2', STAMP);
const RAW = join(OUTDIR, 'raw.jsonl');
if (!existsSync(RAW)) { console.error(`no raw.jsonl for stamp ${STAMP}`); process.exit(4); }

const rows = readFileSync(RAW, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
let changed = 0, flippedToPass = 0, flippedToFail = 0;
for (const r of rows) {
  if (!r.ok || r.output == null) continue; // call-level failures keep their classification
  const task = tasks.get(r.task);
  const kase = task?.cases.find((c) => c.id === r.caseId);
  if (!task || !kase) continue; // task set drifted — leave the row untouched
  const sc = scoreCase(task, kase, r.output);
  const before = r.pass;
  if (r.pass !== sc.pass || r.correct !== sc.correct || r.formatOk !== sc.formatOk || r.failureClass !== sc.failureClass) {
    r.pass = sc.pass; r.correct = sc.correct; r.formatOk = sc.formatOk;
    r.got = typeof sc.got === 'object' ? JSON.stringify(sc.got) : sc.got;
    r.failureClass = sc.failureClass; r.detail = sc.detail;
    changed++;
    if (!before && sc.pass) flippedToPass++;
    if (before && !sc.pass) flippedToFail++;
  }
}
writeFileSync(RAW, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(OUTDIR, 'failures.jsonl'), rows.filter((r) => r.pass === false).map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ stamp: STAMP, rows: rows.length, changed, flippedToPass, flippedToFail }));
