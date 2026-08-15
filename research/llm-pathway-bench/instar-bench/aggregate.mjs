#!/usr/bin/env node
// aggregate.mjs — rebuild summary + judge packet from one or more raw.jsonl files.
// Decouples analysis from the run (survives a killed run; merges runs). Later
// files WIN per (pathway,task,sample) so a floor-corrected re-run overrides the
// tight-budget original. Usage: node aggregate.mjs <out-stamp> <raw1> [raw2 ...]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [outStamp, ...rawPaths] = process.argv.slice(2);
if (!outStamp || !rawPaths.length) { console.error('usage: aggregate.mjs <out-stamp> <raw1> [raw2 ...]'); process.exit(1); }
const tasks = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks;
const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));

// Merge rows; later file wins per (pathway|task|sample).
const merged = new Map();
for (const p of rawPaths) {
  if (!existsSync(p)) { console.error('skip (missing):', p); continue; }
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    merged.set(`${r.pathway}|${r.task}|${r.sample}`, r);
  }
}
const rows = [...merged.values()];

const byPw = {};
for (const r of rows) {
  (byPw[r.pathway] ??= { model: r.model, tier: r.tier, tasks: {}, rows: [] });
  byPw[r.pathway].rows.push(r);
  (byPw[r.pathway].tasks[r.task] ??= { family: r.family, samples: [] }).samples.push({ score: r.score ?? null, ok: r.ok });
}
const summary = {};
for (const [pwId, d] of Object.entries(byPw)) {
  const taskArr = Object.entries(d.tasks).map(([tid, t]) => ({ task: tid, family: t.family, samples: t.samples }));
  const agg = aggregate(taskArr);
  const okRows = d.rows.filter((r) => r.ok);
  const lat = okRows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const toks = okRows.map((r) => r.tokensOut).filter((x) => x != null).sort((a, b) => a - b);
  summary[pwId] = {
    model: d.model, tier: d.tier, familyScores: agg.familyScores, overallDeterministic: agg.overallDeterministic,
    p50ms: lat[Math.floor(lat.length * 0.5)] ?? null, medianTokensOut: toks[Math.floor(toks.length / 2)] ?? null,
    okRate: Number((okRows.length / d.rows.length).toFixed(3)), costUsd: Number(d.rows.reduce((a, r) => a + (r.costUsd || 0), 0).toFixed(5)),
    detSamples: d.rows.filter((r) => r.family !== 'agent' && r.family !== 'background').length,
    judgeSamples: d.rows.filter((r) => r.family === 'agent' || r.family === 'background').length,
  };
}

// Blind judge packet (deterministic shuffle).
const judgeRows = rows.filter((r) => r.family === 'agent' || r.family === 'background');
const salt = judgeRows.length;
const shuffled = judgeRows
  .map((r, i) => ({ r, k: (i * 2654435761 + salt * 40503) % 100000 }))
  .sort((a, b) => a.k - b.k)
  .map(({ r }, i) => ({ anonId: `A${String(i).padStart(3, '0')}`, taskId: r.task, rubric: taskById[r.task]?.rubric, output: r.output, _model: r.pathway }));

const OUT = join(HERE, '..', 'results', 'instar-bench', outStamp);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(OUT, 'judge-packet.json'), JSON.stringify(shuffled, null, 1));
writeFileSync(join(OUT, 'judge-blind.json'), JSON.stringify(shuffled.map(({ _model, ...x }) => x), null, 1));
console.log(JSON.stringify({ mergedRows: rows.length, pathways: Object.keys(summary).length, judgeOutputs: shuffled.length, out: OUT }));
