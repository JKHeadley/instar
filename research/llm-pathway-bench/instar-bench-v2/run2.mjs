#!/usr/bin/env node
// run2.mjs — INSTAR-Bench v2 runner: route × task × case × sample.
//
// Provider-adaptive: routes come from routes.mjs discovery — a missing door is
// a skip, a per-call failure is DATA (classified + recorded), never a crash.
// Metered calls ride the budget funnel (fail-closed wall); CLI calls mirror
// instar's production invocations (harness.mjs patterns, clean CWD).
//
// Outputs under results/instar-bench-v2/<stamp>/:
//   raw.jsonl       — every sample row (scored inline for deterministic tasks)
//   failures.jsonl  — every failing sample (forensics input)
//   judge-blind.json / judge-packet.json — blind packet for judged tasks
//   summary.json    — per-route per-task aggregates
//
// Usage: node run2.mjs --stamp <id> [--samples 2] [--concurrency 4]
//        [--tasks-filter id,id] [--routes-filter substr,substr]
//        [--critical-only] [--maxtok-floor 1024] [--groq-delay-ms 2500]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverRoutes } from './routes.mjs';
import { scoreCase } from './score2.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNNEL = join(HERE, '..', 'metered-funnel.mjs');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const STAMP = arg('stamp', 'run');
const SAMPLES = Number(arg('samples', 2));
const CONC = Number(arg('concurrency', 4));
const MAXTOK_FLOOR = Number(arg('maxtok-floor', 1024)); // reasoner headroom (v1 lesson: tight budgets clip answers)
const GROQ_DELAY = Number(arg('groq-delay-ms', 2500));  // free-tier pacing (v1 lesson: rate-limits corrupt scores)
const TASK_FILTER = arg('tasks-filter', '') ? new Set(arg('tasks-filter', '').split(',')) : null;
const CASE_FILTER = arg('cases-filter', '') ? new Set(arg('cases-filter', '').split(',')) : null;
const ROUTE_FILTER = arg('routes-filter', '') ? arg('routes-filter', '').split(',') : null;
const CRITICAL_ONLY = has('critical-only');
const CLEAN_CWD = mkdtempSync(join(tmpdir(), 'ibench2-'));

// ---- Load tasks ----
// IB2_TASKDIR env override = the A/B harness's variant-substitution hook.
const TASKDIR = process.env.IB2_TASKDIR || join(HERE, 'tasks');
const tasks = readdirSync(TASKDIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(TASKDIR, f), 'utf8')))
  .filter((t) => !TASK_FILTER || TASK_FILTER.has(t.id))
  .filter((t) => !CRITICAL_ONLY || t.critical)
  .map((t) => {
    // Large prompts live in sibling files (tone gate ≈12k chars) — keeps task
    // JSONs reviewable. promptTemplateFile is relative to the task dir.
    if (!t.promptTemplate && t.promptTemplateFile) t.promptTemplate = readFileSync(join(TASKDIR, t.promptTemplateFile), 'utf8');
    return t;
  });

// ---- Build concrete routes from discovery + bench-models ----
const disc = discoverRoutes();
const matrix = JSON.parse(readFileSync(join(HERE, 'bench-models.json'), 'utf8'));
const routes = [];
for (const door of disc.available) {
  const doorKey = door.kind === 'metered-funnel' ? `metered:${door.key}` : { 'claude-code': 'claude', 'codex-cli': 'codex', 'pi-cli': 'pi', 'gemini-cli': 'gemini' }[door.door];
  const entry = matrix.doors[doorKey];
  if (!entry) continue;
  for (const m of entry.models) {
    if (m.delistedAt) continue;
    if (!['benched-v1', 'new-unbenchmarked'].includes(m.benchStatus ?? 'benched-v1')) continue;
    routes.push({
      id: m.routeId ?? `${doorKey.replace(/[^a-z0-9]+/gi, '-')}-${m.id.replace(/[^a-z0-9]+/gi, '-')}`.toLowerCase(),
      door: door.door, doorKey, kind: door.kind, model: m.id, tier: m.tier ?? null,
      subsidized: door.subsidized ?? false, binary: door.binary ?? null, key: door.key ?? null,
      new: m.benchStatus === 'new-unbenchmarked',
    });
  }
}
const activeRoutes = ROUTE_FILTER ? routes.filter((r) => ROUTE_FILTER.some((f) => r.id.includes(f) || r.model.includes(f) || r.door.includes(f))) : routes;

// ---- Per-route invocation (harness.mjs patterns, production-faithful) ----
function buildInvocation(route, promptText, maxTokens) {
  if (route.kind === 'metered-funnel') {
    const pf = join(CLEAN_CWD, `p-${Math.abs(hash(promptText)) % 1e9}.txt`);
    writeFileSync(pf, promptText);
    return { cmd: process.execPath, args: [FUNNEL, 'call', '--key', route.key, '--model', route.model, '--prompt-file', pf, '--max-tokens', String(maxTokens), '--label', `ib2-${STAMP}-${route.id}`, '--timeout', '90000'], cwd: join(HERE, '..') };
  }
  switch (route.door) {
    case 'claude-code':
      return { cmd: route.binary, args: ['-p', promptText, '--model', route.model, '--max-turns', '1', '--output-format', 'json', '--setting-sources', 'user'], cwd: CLEAN_CWD };
    case 'codex-cli':
      return { cmd: route.binary, args: ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', CLEAN_CWD, '-m', route.model, promptText], cwd: CLEAN_CWD };
    case 'pi-cli':
      return { cmd: route.binary, args: ['--model', route.model, '--mode', 'json', promptText], cwd: CLEAN_CWD };
    case 'gemini-cli':
      return { cmd: route.binary, args: ['-m', route.model, '-o', 'json', '--yolo', '-p', promptText], cwd: CLEAN_CWD };
    default:
      return null;
  }
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ---- Per-route output-text extraction ----
function extractOutput(route, stdout) {
  try {
    if (route.kind === 'metered-funnel') {
      const j = JSON.parse(stdout.trim().split('\n').pop());
      return { text: j.output ?? null, ok: !!j.ok, costUsd: j.costUsd ?? null, tokensOut: j.tokensOut ?? null, funnelError: j.error ?? j.reason ?? null };
    }
    if (route.door === 'claude-code') {
      const j = JSON.parse(stdout);
      return { text: j.result ?? null, ok: !j.is_error, costUsd: j.total_cost_usd ?? null, tokensOut: j.usage?.output_tokens ?? null };
    }
    if (route.door === 'codex-cli') {
      let text = null, tout = null;
      for (const line of stdout.split('\n')) {
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        if (ev?.msg?.type === 'agent_message' && typeof ev.msg.message === 'string') text = ev.msg.message;
        if (ev?.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
        const u = ev.usage || ev.token_usage || ev?.msg?.usage || null;
        if (u) tout = u.output_tokens ?? u.completion_tokens ?? tout;
      }
      return { text, ok: text != null, costUsd: null, tokensOut: tout };
    }
    if (route.door === 'pi-cli') {
      let text = null, cost = null, tout = null;
      for (const line of stdout.split('\n')) {
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        const msg = ev?.message;
        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          const parts = msg.content.filter((c) => c.type === 'text').map((c) => c.text);
          if (parts.length) text = parts.join('\n');
        }
        const u = msg?.usage;
        if (u && (u.totalTokens ?? 0) > 0) { tout = u.output ?? tout; cost = typeof u.cost?.total === 'number' ? u.cost.total : cost; }
      }
      return { text, ok: text != null, costUsd: cost, tokensOut: tout };
    }
    if (route.door === 'gemini-cli') {
      const j = JSON.parse(stdout);
      const tk = Object.values(j?.stats?.models ?? {})[0]?.tokens;
      return { text: j.response ?? null, ok: j.response != null, costUsd: null, tokensOut: tk?.candidates ?? null };
    }
  } catch { /* fall through */ }
  return { text: null, ok: false, costUsd: null, tokensOut: null };
}

function classifyCallError(exitCode, stderr, stdout, timedOut, funnelError) {
  if (timedOut) return 'timeout';
  const s = (String(funnelError ?? '') + '\n' + stderr + '\n' + stdout).toLowerCase();
  if (/refused:.*(cap|budget|frozen)/.test(s) || /gate refused/.test(s)) return 'budget-refused';
  if (/http-402|payment required|insufficient credits/.test(s)) return 'vendor-wall';
  if (/rate.?limit|429|too many requests|quota|usage limit/.test(s)) return 'rate-limit';
  if (/usage policy|content policy|refus|cannot assist|i can't help/.test(s)) return 'refusal';
  if (/unauthor|invalid api key|not logged in|credential|401|403/.test(s)) return 'auth';
  if (/enoent|command not found/.test(s)) return 'binary-missing';
  if (/unknown model|invalid model|model.*not.*found|unsupported/.test(s)) return 'model-error';
  if (exitCode !== 0) return 'cli-error';
  return 'empty-output';
}

function runOnce(route, promptText, maxTokens, timeoutMs) {
  return new Promise((res) => {
    const inv = buildInvocation(route, promptText, maxTokens);
    if (!inv) return res({ ok: false, latencyMs: 0, text: null, callError: 'no-invocation' });
    const t0 = Date.now();
    let stdout = '', stderr = '', timedOut = false;
    let ch;
    try { ch = spawn(inv.cmd, inv.args, { cwd: inv.cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return res({ ok: false, latencyMs: 0, text: null, callError: 'spawn-throw', detail: String(e.message) }); }
    const killer = setTimeout(() => { timedOut = true; try { ch.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    ch.stdout.on('data', (d) => { stdout += d; });
    ch.stderr.on('data', (d) => { stderr += d; });
    ch.on('close', (code) => {
      clearTimeout(killer);
      const ext = extractOutput(route, stdout);
      const latencyMs = Date.now() - t0;
      if (ext.ok && ext.text != null) return res({ ok: true, latencyMs, text: ext.text, costUsd: ext.costUsd, tokensOut: ext.tokensOut });
      res({ ok: false, latencyMs, text: ext.text, costUsd: ext.costUsd, tokensOut: ext.tokensOut, callError: classifyCallError(code, stderr, stdout, timedOut, ext.funnelError), detail: (stderr || '').slice(0, 300) });
    });
    ch.on('error', (e) => { clearTimeout(killer); res({ ok: false, latencyMs: Date.now() - t0, text: null, callError: 'spawn-error', detail: String(e.message) }); });
  });
}

// ---- Pacing pool (per-door delay honors free tiers) ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- Work list ----
const OUTDIR = join(HERE, '..', 'results', 'instar-bench-v2', STAMP);
mkdirSync(OUTDIR, { recursive: true });
// Provenance is structural, not a memory: every run writes its manifest at start,
// so even an interrupted run records what code/batteries/prices it ran against.
// Fail-soft — a manifest failure must never kill a benchmark run.
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(HERE, 'gen-manifest.mjs'), '--stamp', STAMP], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch (e) { console.error(`[ib2] WARN run-manifest generation failed: ${e.message}`); }
const RAW = join(OUTDIR, 'raw.jsonl');
const FAILS = join(OUTDIR, 'failures.jsonl');

// --resume: rows already in raw.jsonl (same stamp) are skipped for execution
// but preloaded into results so summary + judge packet still cover them.
// A call killed mid-flight never wrote its row, so it re-runs — no gaps, no dupes.
const RESUME = has('resume');
// Infra-noise: environmental/plumbing failures that say nothing about the MODEL's
// behavior on the task. They are excluded from pass/total scoring (tracked as
// infra counts) and re-run on --resume. Deliberately NOT in this set: timeout,
// refusal, cli-error, model-error, empty-output — those are route behavior a
// router must care about, so they stay scored as failures.
// (budget-refused / vendor-wall never write a row at all — see exec().)
const INFRA_CLASSES = new Set(['rate-limit', 'auth', 'binary-missing', 'spawn-throw', 'spawn-error', 'no-invocation']);
const doneKeys = new Set();
const preloaded = [];
if (RESUME && existsSync(RAW)) {
  for (const line of readFileSync(RAW, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    let r; try { r = JSON.parse(t); } catch { continue; }
    if (!r.ok && INFRA_CLASSES.has(r.failureClass)) continue; // infra row: re-run, don't preload
    doneKeys.add(`${r.route}|${r.task}|${r.caseId}|${r.sample}`);
    preloaded.push(r);
  }
}

const work = [];
for (const route of activeRoutes) for (const task of tasks) for (const kase of task.cases) for (let s = 0; s < SAMPLES; s++) {
  if (CASE_FILTER && !CASE_FILTER.has(kase.id)) continue;
  if (doneKeys.has(`${route.id}|${task.id}|${kase.id}|${s}`)) continue;
  work.push({ route, task, kase, s });
}
if (RESUME) console.error(`[ib2] resume: ${preloaded.length} rows preloaded, ${work.length} calls remain`);
console.error(`[ib2] ${activeRoutes.length} routes × ${tasks.length} tasks (${tasks.reduce((a, t) => a + t.cases.length, 0)} cases) × ${SAMPLES} samples = ${work.length} calls, c=${CONC}`);
if (!work.length && !preloaded.length) { console.log(JSON.stringify({ calls: 0, note: 'nothing to run (filters or empty discovery)' })); process.exit(0); }

// Serialize free-tier RPM-limited doors (groq metered, gemini CLI) in a
// private 1-wide paced lane — concurrent calls there just buy rate-limit
// rows that corrupt scores (v1 Groq lesson; gemini repeat 2026-07-02).
const GEMINI_DELAY = Number(arg('gemini-delay-ms', 4000));
const isPaced = (w) => w.route.doorKey.includes('groq') || w.route.door === 'gemini-cli' || w.route.doorKey.includes('gemini_bench');
const groqWork = work.filter(isPaced);
const otherWork = work.filter((w) => !isPaced(w));

let done = 0; const results = [...preloaded];
// A budget-refused call means the funnel wall is hit: recording it would poison
// raw.jsonl (resume treats recorded rows as done), and continuing just grinds
// out refusals. Record nothing, abort loudly, resume after the wall is resolved.
let wallHits = 0;
async function exec(w) {
  const promptText = w.task.promptTemplate.replaceAll('{{INPUT}}', w.kase.input ?? '');
  const maxTok = Math.max(w.task.maxTokens ?? 256, MAXTOK_FLOOR);
  const r = await runOnce(w.route, promptText, maxTok, 120000);
  if (!r.ok && (r.callError === 'budget-refused' || r.callError === 'vendor-wall')) {
    if (++wallHits >= 3) {
      console.error(`[ib2] ABORT — ${r.callError} wall hit (${wallHits} refusals). Resolve the wall (cap / vendor balance), then re-run with --resume.`);
      process.exit(3);
    }
    return null; // not recorded → re-runs on resume
  }
  const sc = r.ok ? scoreCase(w.task, w.kase, r.text) : { pass: false, correct: false, formatOk: false, got: null, failureClass: r.callError, detail: r.detail ?? 'call failed' };
  const row = {
    stamp: STAMP, route: w.route.id, door: w.route.door, model: w.route.model, subsidized: w.route.subsidized,
    task: w.task.id, component: w.task.component, nature: w.task.nature, critical: !!w.task.critical,
    caseId: w.kase.id, axis: w.kase.axis, sample: w.s,
    ok: r.ok, latencyMs: r.latencyMs, costUsd: r.costUsd ?? null, tokensOut: r.tokensOut ?? null,
    pass: sc.pass, correct: sc.correct, formatOk: sc.formatOk, got: typeof sc.got === 'object' ? JSON.stringify(sc.got) : sc.got,
    failureClass: sc.failureClass, detail: sc.detail,
    output: r.text,
  };
  appendFileSync(RAW, JSON.stringify(row) + '\n');
  if (sc.pass === false) appendFileSync(FAILS, JSON.stringify(row) + '\n');
  results.push(row);
  if (++done % 50 === 0) console.error(`[ib2] ${done}/${work.length}`);
  return row;
}
await Promise.all([
  pool(otherWork, CONC, exec),
  (async () => { for (const w of groqWork) { await exec(w); await sleep(w.route.door === 'gemini-cli' || w.route.doorKey.includes('gemini_bench') ? GEMINI_DELAY : GROQ_DELAY); } })(),
]);

// ---- Aggregate ----
const summary = {};
for (const r of results) {
  const key = r.route;
  const s = (summary[key] ??= { door: r.door, model: r.model, subsidized: r.subsidized, tasks: {}, calls: 0, okCalls: 0, passes: 0, deterministic: 0, costUsd: 0, latencies: [] });
  s.calls++; if (r.ok) { s.okCalls++; s.latencies.push(r.latencyMs); }
  s.costUsd += r.costUsd || 0;
  const t = (s.tasks[r.task] ??= { cases: {}, passes: 0, total: 0 });
  const c = (t.cases[r.caseId] ??= { axis: r.axis, pass: 0, total: 0, failureClasses: {} });
  const isInfra = !r.ok && INFRA_CLASSES.has(r.failureClass);
  if (isInfra) { s.infraErrors = (s.infraErrors || 0) + 1; c.infra = (c.infra || 0) + 1; continue; }
  if (r.pass !== null) { s.deterministic++; t.total++; if (r.pass) { t.passes++; s.passes++; } }
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

// ---- Blind judge packet (judged tasks only) ----
const judgeRows = results.filter((r) => tasks.find((t) => t.id === r.task)?.scoring === 'judge' && r.ok);
const salt = judgeRows.length;
const shuffled = judgeRows.map((r, i) => ({ r, k: (i * 2654435761 + salt * 40503) % 100000 })).sort((a, b) => a.k - b.k)
  .map(({ r }, i) => ({ anonId: `B${String(i).padStart(3, '0')}`, taskId: r.task, caseId: r.caseId, rubric: tasks.find((t) => t.id === r.task)?.rubric ?? null, output: r.output, _route: r.route }));
writeFileSync(join(OUTDIR, 'judge-packet.json'), JSON.stringify(shuffled, null, 1));
writeFileSync(join(OUTDIR, 'judge-blind.json'), JSON.stringify(shuffled.map(({ _route, ...x }) => x), null, 1));

const failures = results.filter((r) => r.pass === false).length;
console.error(`[ib2] DONE — ${results.length} calls, ${failures} failing samples, cost $${Object.values(summary).reduce((a, s) => a + s.costUsd, 0).toFixed(3)} → ${OUTDIR}`);
console.log(JSON.stringify({ stamp: STAMP, routes: activeRoutes.length, tasks: tasks.length, calls: results.length, failures, judgeOutputs: shuffled.length, outdir: OUTDIR }));
