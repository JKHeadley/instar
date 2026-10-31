#!/usr/bin/env node
// aggregate.mjs — offline re-aggregation of a run's summary.json from raw.jsonl.
// Byte-faithful to run2.mjs's Aggregate block (lines ~267-291), but reads the
// FULL raw file instead of one invocation's in-memory rows — needed after
// rescore.mjs rewrites raw.jsonl, and after multi-invocation resumed runs
// where the last invocation's routes-filter saw only a slice of the rows.
// Usage: node aggregate.mjs --stamp <stamp>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', null);
if (!STAMP) { console.error('--stamp required'); process.exit(4); }
const OUTDIR = join(HERE, '..', 'results', 'instar-bench-v2', STAMP);
const rows = readFileSync(join(OUTDIR, 'raw.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const summary = {};
for (const r of rows) {
  const key = r.route;
  const s = (summary[key] ??= { door: r.door, model: r.model, subsidized: r.subsidized, tasks: {}, calls: 0, okCalls: 0, passes: 0, deterministic: 0, costUsd: 0, latencies: [] });
  s.calls++; if (r.ok) { s.okCalls++; s.latencies.push(r.latencyMs); }
  s.costUsd += r.costUsd || 0;
  const t = (s.tasks[r.task] ??= { cases: {}, passes: 0, total: 0 });
  if (r.pass !== null) { s.deterministic++; t.total++; if (r.pass) { t.passes++; s.passes++; } }
  const c = (t.cases[r.caseId] ??= { axis: r.axis, pass: 0, total: 0, failureClasses: {} });
  if (r.pass !== null) { c.total++; if (r.pass) c.pass++; else c.failureClasses[r.failureClass] = (c.failureClasses[r.failureClass] || 0) + 1; }
}
for (const s of Object.values(summary)) {
  s.latencies.sort((a, b) => a - b);
  s.p50ms = s.latencies[Math.floor(s.latencies.length * 0.5)] ?? null;
  s.p95ms = s.latencies[Math.floor(s.latencies.length * 0.95)] ?? null;
  delete s.latencies;
  s.passRate = s.deterministic ? Number((s.passes / s.deterministic).toFixed(3)) : null;
  s.costUsd = Number(s.costUsd.toFixed(5));
}
writeFileSync(join(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ stamp: STAMP, rows: rows.length, routes: Object.keys(summary).length, failures: rows.filter((r) => r.pass === false).length }));
