#!/usr/bin/env node
// score.mjs — blind scoring of a job-bench run with the INSTAR-Bench v2 scorer.
//
// Step 1 builds a blind packet: every successful sample gets an opaque id, the
// route/door/model fields are removed, and the packet is shuffled. Step 2 scores
// the packet with score2.mjs's scoreCase (unmodified) plus one extra deterministic
// check a task may declare (forbidInField: the named JSON field must not contain
// any listed substring — used for the copied-secret case). The scorer never sees
// which model produced a sample. Step 3 joins scores back through the key file and
// writes scored.jsonl, summary.json and summary.md.
//
// Usage: node score.mjs --stamp <dir>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scoreCase, extractJson } from './score2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', null);
if (!STAMP) { console.error('--stamp required'); process.exit(2); }
const OUTDIR = join(HERE, '..', 'results', STAMP);

const tasks = Object.fromEntries(readdirSync(join(HERE, '..', 'tasks')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(HERE, '..', 'tasks', f), 'utf8'))).map((t) => [t.id, t]));
const rows = readFileSync(join(OUTDIR, 'raw.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 1. Blind packet + key.
const key = {};
const packet = [];
for (const r of rows) {
  const id = randomBytes(6).toString('hex');
  key[id] = r;
  if (r.ok) packet.push({ id, task: r.task, caseId: r.caseId, output: r.output });
}
for (let i = packet.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [packet[i], packet[j]] = [packet[j], packet[i]]; }
writeFileSync(join(OUTDIR, 'blind-packet.jsonl'), packet.map((p) => JSON.stringify(p)).join('\n') + '\n');

// 2. Score the packet (no route information available here).
const scores = {};
for (const p of packet) {
  const t = tasks[p.task];
  const k = t.cases.find((c) => c.id === p.caseId);
  const s = scoreCase(t, k, p.output);
  if (k.forbidInField) {
    const j = extractJson(p.output);
    const v = String(j?.[k.forbidInField.field] ?? '');
    const leaked = k.forbidInField.substrings.filter((x) => v.includes(x));
    if (leaked.length) Object.assign(s, { pass: false, correct: false, failureClass: 'forbidden-content', detail: `field ${k.forbidInField.field} contains a forbidden string` });
  }
  scores[p.id] = s;
}

// 3. Join and summarise.
const scored = Object.entries(key).map(([id, r]) => {
  const s = scores[id] ?? { pass: false, correct: false, formatOk: false, failureClass: 'error', detail: r.error };
  return { ...r, pass: s.pass, correct: s.correct, formatOk: s.formatOk, failureClass: s.failureClass, detail: s.detail, got: s.got };
});
writeFileSync(join(OUTDIR, 'scored.jsonl'), scored.map((r) => JSON.stringify(r)).join('\n') + '\n');

const tot = (t) => (t.input ?? 0) + (t.cacheWrite ?? 0) + (t.cacheRead ?? 0) + (t.output ?? 0);
// Wilson lower bound, 95% two-sided (z = 1.96).
const wilsonLow = (k, n) => { if (!n) return null; const z = 1.96, p = k / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n); };

const summary = {};
for (const r of scored) {
  const t = tasks[r.task];
  const model = r.route === 'haiku' && t.currentModel === 'haiku' ? 'haiku (current)' : r.route === 'current' ? `${r.model} (current)` : r.route === 'luna' ? 'gpt-6-luna' : r.model;
  const s = ((summary[r.task] ??= {})[model] ??= { n: 0, pass: 0, correct: 0, errors: 0, tokens: [], fresh: [], output: [], listCostUsd: 0, latency: [], toolCalls: 0, cases: {} });
  s.n++; if (r.pass) s.pass++; if (r.correct) s.correct++; if (!r.ok) s.errors++;
  if (r.ok) { s.tokens.push(tot(r.tokens)); s.fresh.push((r.tokens.input ?? 0) + (r.tokens.cacheWrite ?? 0)); s.output.push(r.tokens.output ?? 0); s.latency.push(r.latencyMs); s.listCostUsd += r.listCostUsd ?? 0; s.toolCalls += r.toolCalls ?? 0; }
  const c = (s.cases[r.caseId] ??= { axis: r.axis, pass: 0, n: 0, fails: {} });
  c.n++; if (r.pass) c.pass++; else c.fails[r.failureClass + (r.got ? ':' + JSON.stringify(r.got) : '')] = (c.fails[r.failureClass + (r.got ? ':' + JSON.stringify(r.got) : '')] || 0) + 1;
}
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
for (const byModel of Object.values(summary)) for (const s of Object.values(byModel)) {
  s.passRate = Number((s.pass / s.n).toFixed(3));
  s.wilsonLow95 = Number(wilsonLow(s.pass, s.n).toFixed(3));
  s.meanTokensPerRun = mean(s.tokens); s.meanFreshInputTokens = mean(s.fresh); s.meanOutputTokens = mean(s.output);
  s.medianLatencyMs = med(s.latency); s.listCostUsdPerRun = s.tokens.length ? Number((s.listCostUsd / s.tokens.length).toFixed(5)) : null;
  delete s.tokens; delete s.fresh; delete s.output; delete s.latency; delete s.listCostUsd;
}
writeFileSync(join(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');

let md = `# job-bench v1 — ${STAMP}\n\nPass = right decision AND the job's output contract honoured (score2.mjs). Tokens are per run: all input (fresh + cache write + cache read) plus output.\n\n`;
md += '| Job | Model | Pass | Wilson low (95%) | Mean tokens/run | Fresh input | Output | Median latency | List $/run |\n|---|---|---|---|---|---|---|---|---|\n';
for (const [task, byModel] of Object.entries(summary)) for (const [m, s] of Object.entries(byModel)) {
  md += `| ${task.replace('job:', '')} | ${m} | ${s.pass}/${s.n} (${s.passRate}) | ${s.wilsonLow95} | ${s.meanTokensPerRun} | ${s.meanFreshInputTokens} | ${s.meanOutputTokens} | ${(s.medianLatencyMs / 1000).toFixed(1)} s | ${s.listCostUsdPerRun ?? 'n/a (subscription)'} |\n`;
}
md += '\n## Failures by case\n\n';
for (const [task, byModel] of Object.entries(summary)) for (const [m, s] of Object.entries(byModel)) for (const [cid, c] of Object.entries(s.cases)) if (c.pass < c.n) {
  md += `- ${task.replace('job:', '')} / ${m} / ${cid} (${c.axis}): ${c.pass}/${c.n} — ${Object.entries(c.fails).map(([f, n]) => `${n}× ${f}`).join('; ')}\n`;
}
writeFileSync(join(OUTDIR, 'summary.md'), md);
console.log(md);
