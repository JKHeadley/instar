#!/usr/bin/env node
// forensics.mjs — INSTAR-Bench v2 failure forensics: mechanical half.
//
// Reads a run's failures.jsonl and produces the FORENSIC QUEUE — one record
// per failing (task, case, model) group, with everything the in-session
// Fable-5 judge needs to rule promptFault per the spec §4:
//   model-limit | prompt-improvable | context-missing | case-defect
// The judge (me, in-session) reads the queue, writes verdicts into
// forensics-verdicts.jsonl; rank-improvements.mjs then builds the ranked
// prompt-improvement queue from those verdicts.
//
// Cross-model clustering is computed as a PRIORITIZATION layer (spec: the
// strongest prompt-defect signal), never the trigger — EVERY failure gets a
// record, even single-model ones (operator directive #3, 2026-07-01).
//
// Usage: node forensics.mjs --run <stamp> [--min-samples 1]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RUN = arg('run', null);
if (!RUN) { console.error('--run <stamp> required'); process.exit(4); }
const RUNDIR = join(HERE, '..', 'results', 'instar-bench-v2', RUN);
const FAILS = join(RUNDIR, 'failures.jsonl');
const RAW = join(RUNDIR, 'raw.jsonl');
if (!existsSync(FAILS)) { console.log(JSON.stringify({ run: RUN, groups: 0, note: 'no failures file — nothing failed or run missing' })); process.exit(0); }

const failures = readFileSync(FAILS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const raw = existsSync(RAW) ? readFileSync(RAW, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

// ---- Group failures by (task, case, route-model) ----
const groups = new Map();
for (const f of failures) {
  const key = `${f.task}::${f.caseId}::${f.model}`;
  const g = groups.get(key) ?? { task: f.task, component: f.component, nature: f.nature, critical: f.critical, caseId: f.caseId, axis: f.axis, model: f.model, door: f.door, samples: [] };
  g.samples.push({ sample: f.sample, failureClass: f.failureClass, got: f.got, output: f.output, detail: f.detail, latencyMs: f.latencyMs });
  groups.set(key, g);
}

// ---- Cross-model clusters per (task, case): how many DISTINCT models failed,
//      and how many models ran it at all (from raw). Prioritization signal. ----
const caseModelRuns = new Map(); // task::case → Set(models that ran)
for (const r of raw) {
  const key = `${r.task}::${r.caseId}`;
  (caseModelRuns.get(key) ?? caseModelRuns.set(key, new Set()).get(key)).add(r.model);
}
const caseFailModels = new Map();
for (const f of failures) {
  const key = `${f.task}::${f.caseId}`;
  (caseFailModels.get(key) ?? caseFailModels.set(key, new Set()).get(key)).add(f.model);
}

// ---- Emit the queue, priority-ordered ----
const queue = [...groups.values()].map((g) => {
  const caseKey = `${g.task}::${g.caseId}`;
  const failedModels = caseFailModels.get(caseKey)?.size ?? 1;
  const ranModels = caseModelRuns.get(caseKey)?.size ?? 1;
  const crossModelShare = ranModels ? failedModels / ranModels : 0;
  // Persistent = every sample of this (task,case,model) failed (not flake).
  const persistent = g.samples.length > 1 ? g.samples.every((s) => s.failureClass) : true;
  const dominantClass = mode(g.samples.map((s) => s.failureClass));
  return {
    ...g,
    failedModels, ranModels, crossModelShare: Number(crossModelShare.toFixed(2)),
    persistent, dominantClass,
    // priority: criticality × cross-model share × persistence
    priority: Number(((g.critical ? 2 : 1) * (0.5 + crossModelShare) * (persistent ? 1 : 0.5)).toFixed(2)),
    judgeInstruction: 'Rule promptFault: model-limit | prompt-improvable | context-missing | case-defect. Read the raw output(s) and ask: is there ANY indication a better-structured prompt or better context would have prevented this failure? Provide rationale and, when improvable, a concrete proposedEdit to the REAL component prompt (cite its source file).',
    verdict: null,
  };
}).sort((a, b) => b.priority - a.priority);

writeFileSync(join(RUNDIR, 'forensic-queue.json'), JSON.stringify(queue, null, 1));
const crossModel = queue.filter((q) => q.crossModelShare >= 0.5).length;
console.error(`[forensics] ${queue.length} failure groups (${crossModel} with ≥50% cross-model share) → forensic-queue.json`);
console.log(JSON.stringify({ run: RUN, groups: queue.length, crossModelGroups: crossModel }));

function mode(xs) {
  const c = {}; let best = null, n = 0;
  for (const x of xs) { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } }
  return best;
}
