#!/usr/bin/env node
// run.mjs — INSTAR-Bench runner. Drives each funnel pathway through every task
// N times, scores deterministic families inline (score.mjs), and collects judge
// families into a BLIND packet (anonymized + shuffled) for the interactive
// Fable-5 agent to score in-session. Spec: docs/planning/2026-07-01-instar-bench-v1-spec.md.
//
// Usage: node run.mjs [--samples 3] [--concurrency 4] [--pathways funnel|all|id,id]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreSample, aggregate } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, 'tasks.json');
const REG = join(HERE, '..', 'pathways.json');
const FUNNEL = join(HERE, '..', 'metered-funnel.mjs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLES = Number(arg('samples', 3));
const CONC = Number(arg('concurrency', 4));
// Token floor: reasoning models (Gemini 3.x, GLM, Kimi, gpt-oss) spend output
// budget on hidden reasoning BEFORE the answer; a tight per-task maxTokens
// truncates the answer mid-JSON and mis-scores capability as failure. Floor the
// budget so we measure "can it do the task", separate from "can it be terse"
// (terseness is captured as tokensOut). Default high enough for any reasoner.
const MAXTOK_FLOOR = Number(arg('maxtok-floor', 1024));
const PATHSEL = arg('pathways', 'funnel');
// A fixed stamp is passed in (Date.now unavailable-agnostic): default to argv.
const STAMP = arg('stamp', 'run');

const tasksDoc = JSON.parse(readFileSync(BENCH, 'utf8'));
const reg = JSON.parse(readFileSync(REG, 'utf8'));
let pathways = reg.pathways.filter((p) => p.framework === 'funnel');
if (PATHSEL !== 'funnel' && PATHSEL !== 'all') {
  const ids = new Set(PATHSEL.split(','));
  pathways = pathways.filter((p) => ids.has(p.id));
}
const tasks = tasksDoc.tasks;
const OUTDIR = join(HERE, '..', 'results', 'instar-bench', STAMP);
mkdirSync(OUTDIR, { recursive: true });
const RAW = join(OUTDIR, 'raw.jsonl');

function callFunnel(pw, task) {
  return new Promise((res) => {
    const pf = join(OUTDIR, `.prompt-${task.id}.txt`);
    writeFileSync(pf, task.prompt);
    const maxTok = Math.max(task.maxTokens ?? 256, MAXTOK_FLOOR);
    const args = [FUNNEL, 'call', '--key', pw.key, '--model', pw.model,
      '--prompt-file', pf, '--max-tokens', String(maxTok),
      '--label', `ibench-${pw.id}-${task.id}`, '--timeout', '90000'];
    const t0 = Date.now();
    let out = '';
    const ch = spawn(process.execPath, args, { cwd: join(HERE, '..') });
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('close', () => {
      let j = {};
      try { j = JSON.parse(out.trim().split('\n').pop()); } catch { /* leave empty */ }
      res({ ok: !!j.ok, latencyMs: Date.now() - t0, output: j.output ?? null, costUsd: j.costUsd ?? null,
        tokensOut: j.tokensOut ?? null, error: j.error ?? (j.reason ? `refused:${j.reason}` : null) });
    });
    ch.on('error', (e) => res({ ok: false, latencyMs: Date.now() - t0, output: null, error: String(e.message) }));
  });
}

const DELAY_MS = Number(arg('delay-ms', 0)); // pace call starts (free-tier RPM limits, e.g. Groq)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async (_, worker) => {
    if (DELAY_MS) await sleep(DELAY_MS * worker / Math.max(1, n)); // stagger worker starts
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); if (DELAY_MS) await sleep(DELAY_MS); }
  }));
  return out;
}

// Build the full work list: pathway × task × sample.
const work = [];
for (const pw of pathways) for (const task of tasks) for (let s = 0; s < SAMPLES; s++) work.push({ pw, task, s });
console.error(`[ibench] ${pathways.length} pathways × ${tasks.length} tasks × ${SAMPLES} = ${work.length} calls, c=${CONC}`);

let done = 0;
const results = await pool(work, CONC, async (w) => {
  const r = await callFunnel(w.pw, w.task);
  const row = { pathway: w.pw.id, model: w.pw.model, tier: w.pw.tier, task: w.task.id, family: w.task.family, sample: w.s,
    ok: r.ok, latencyMs: r.latencyMs, tokensOut: r.tokensOut, costUsd: r.costUsd, output: r.output, error: r.error };
  // Deterministic scoring inline.
  const sc = w.task.scoring !== 'judge' ? scoreSample(w.task, r.output ?? '') : null;
  if (sc) { row.score = sc.score; row.scoreDetail = sc.detail; }
  appendFileSync(RAW, JSON.stringify(row) + '\n');
  if (++done % 50 === 0) console.error(`[ibench] ${done}/${work.length}`);
  return row;
});

// Per-pathway aggregate (deterministic families only; judge scored later).
const byPw = {};
for (const r of results) {
  (byPw[r.pathway] ??= { model: r.model, tier: r.tier, tasks: {} });
  (byPw[r.pathway].tasks[r.task] ??= { family: r.family, samples: [] }).samples.push({ score: r.score ?? null, ok: r.ok, latencyMs: r.latencyMs, costUsd: r.costUsd });
}
const summary = {};
for (const [pwId, d] of Object.entries(byPw)) {
  const taskArr = Object.entries(d.tasks).map(([tid, t]) => ({ task: tid, family: t.family, samples: t.samples }));
  const agg = aggregate(taskArr);
  const lat = results.filter((r) => r.pathway === pwId && r.ok).map((r) => r.latencyMs).sort((a, b) => a - b);
  const cost = results.filter((r) => r.pathway === pwId).reduce((a, r) => a + (r.costUsd || 0), 0);
  const okRate = results.filter((r) => r.pathway === pwId && r.ok).length / results.filter((r) => r.pathway === pwId).length;
  summary[pwId] = { model: d.model, tier: d.tier, familyScores: agg.familyScores, overallDeterministic: agg.overallDeterministic,
    p50ms: lat[Math.floor(lat.length * 0.5)] ?? null, okRate: Number(okRate.toFixed(3)), costUsd: Number(cost.toFixed(5)) };
}
writeFileSync(join(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 1));

// Blind judge packet: every judge-family output, anonymized + shuffled (deterministic
// shuffle by a fixed salt so it's reproducible without Math.random).
const judgeRows = results.filter((r) => r.family === 'agent' || r.family === 'background');
const salt = judgeRows.length;
const shuffled = judgeRows
  .map((r, i) => ({ r, k: (i * 2654435761 + salt * 40503) % 100000 }))
  .sort((a, b) => a.k - b.k)
  .map(({ r }, i) => ({ anonId: `A${String(i).padStart(3, '0')}`, taskId: r.task,
    rubric: tasks.find((t) => t.id === r.task).rubric, output: r.output,
    _model: r.pathway })); // _model kept for de-anon; the judging view strips it
writeFileSync(join(OUTDIR, 'judge-packet.json'), JSON.stringify(shuffled, null, 1));
// The blind view I actually read (no _model):
writeFileSync(join(OUTDIR, 'judge-blind.json'), JSON.stringify(shuffled.map(({ _model, ...x }) => x), null, 1));

console.error(`[ibench] DONE — summary.json, judge-packet.json (${shuffled.length} judge outputs) in ${OUTDIR}`);
console.log(JSON.stringify({ pathways: pathways.length, tasks: tasks.length, calls: work.length, judgeOutputs: shuffled.length, outdir: OUTDIR }));
