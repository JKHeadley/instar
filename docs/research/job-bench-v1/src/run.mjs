#!/usr/bin/env node
// run.mjs — runs the job-bench v1 tasks against each route, N trials per case.
//
// Routes (subscription sign-ins only; API-key env vars are stripped):
//   luna    codex-cli, gpt-6-luna   (codex exec --json, read-only sandbox, no user config)
//   haiku   claude-code, haiku      (claude -p, no tools, no setting sources, no MCP)
//   current the job's current model (task.currentModel) via claude -p; skipped when
//           it is haiku, since the haiku route already covers it
// Every call runs in a fresh empty temp directory that is deleted afterwards, so
// no project CLAUDE.md / AGENTS.md / hooks load. No instar server, scheduler or
// init is touched.
//
// Usage: node run.mjs --stamp <dir> [--trials 3] [--concurrency 4] [--only task-id]
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const STAMP = arg('stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const TRIALS = Number(arg('trials', '3'));
const CONC = Number(arg('concurrency', '4'));
const ONLY = arg('only', null);
const TMPROOT = process.env.JOB_BENCH_TMP || tmpdir();
const OUTDIR = join(HERE, '..', 'results', STAMP);
mkdirSync(OUTDIR, { recursive: true });
const RAW = join(OUTDIR, 'raw.jsonl');

const tasks = readdirSync(join(HERE, '..', 'tasks')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(HERE, '..', 'tasks', f), 'utf8')))
  .filter((t) => !ONLY || t.id === ONLY);

const cleanEnv = () => { const e = { ...process.env }; delete e.ANTHROPIC_API_KEY; delete e.OPENAI_API_KEY; return e; };

function sh(cmd, args, input, cwd, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code, sig) => { clearTimeout(t); resolve({ code, sig, out, err }); });
    p.stdin.end(input);
  });
}

async function callClaude(model, prompt, cwd) {
  const r = await sh('claude', ['-p', '--model', model, '--setting-sources', '', '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--output-format', 'json'], prompt, cwd);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  if (!j) return { ok: false, error: (r.err || r.out).slice(0, 300) || `exit ${r.code} ${r.sig ?? ''}` };
  const u = j.usage ?? {};
  const resolved = Object.keys(j.modelUsage ?? {})[0] ?? model;
  return { ok: !j.is_error, output: j.result ?? '', resolvedModel: resolved,
    tokens: { input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.thinking_tokens ?? 0 },
    listCostUsd: j.total_cost_usd ?? null };
}

async function callCodex(model, prompt, cwd) {
  const r = await sh('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only', '-m', model, '-'], prompt, cwd);
  let text = null, usage = null, error = null, toolCalls = 0;
  for (const line of r.out.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text;
    if (e.type === 'item.completed' && e.item?.type && e.item.type !== 'agent_message' && e.item.type !== 'reasoning') toolCalls++;
    if (e.type === 'turn.completed') usage = e.usage;
    if (e.type === 'turn.failed' || e.type === 'error') error = JSON.stringify(e).slice(0, 300);
  }
  if (text == null) return { ok: false, error: error || (r.err || '').slice(-300) || `exit ${r.code}` };
  return { ok: true, output: text, resolvedModel: model, toolCalls,
    tokens: { input: (usage?.input_tokens ?? 0) - (usage?.cached_input_tokens ?? 0), cacheWrite: usage?.cache_write_input_tokens ?? 0, cacheRead: usage?.cached_input_tokens ?? 0, output: usage?.output_tokens ?? 0, reasoning: usage?.reasoning_output_tokens ?? 0 },
    listCostUsd: null };
}

const ROUTES = (task) => {
  const r = [
    { route: 'luna', door: 'codex-cli', model: 'gpt-6-luna', call: (p, c) => callCodex('gpt-6-luna', p, c) },
    { route: 'haiku', door: 'claude-code', model: 'haiku', call: (p, c) => callClaude('haiku', p, c) },
  ];
  if (task.currentModel !== 'haiku') r.push({ route: 'current', door: 'claude-code', model: task.currentModel, call: (p, c) => callClaude(task.currentModel, p, c) });
  return r;
};

const done = new Set();
if (existsSync(RAW)) for (const l of readFileSync(RAW, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (r.ok) done.add(`${r.task}|${r.caseId}|${r.route}|${r.trial}`); }

const jobs = [];
for (const t of tasks) for (const k of t.cases) for (const rt of ROUTES(t)) for (let i = 1; i <= TRIALS; i++) {
  const key = `${t.id}|${k.id}|${rt.route}|${i}`;
  if (!done.has(key)) jobs.push({ t, k, rt, i, key });
}
// Interleave routes so a slow door does not finish last in a block.
jobs.sort((a, b) => a.i - b.i || a.k.id.localeCompare(b.k.id));
console.log(`${jobs.length} calls to run (${done.size} already done) -> ${RAW}`);

let next = 0, finished = 0;
async function worker() {
  while (next < jobs.length) {
    const { t, k, rt, i } = jobs[next++];
    const prompt = t.promptTemplate.replace('{{INPUT}}', k.input);
    const dir = mkdtempSync(join(TMPROOT, 'jobbench-'));
    const t0 = Date.now();
    let res;
    try { res = await rt.call(prompt, dir); } catch (e) { res = { ok: false, error: String(e).slice(0, 300) }; }
    finally { rmSync(dir, { recursive: true, force: true }); }
    const row = { task: t.id, caseId: k.id, axis: k.axis, route: rt.route, door: rt.door, model: rt.model, trial: i, latencyMs: Date.now() - t0, ...res };
    appendFileSync(RAW, JSON.stringify(row) + '\n');
    finished++;
    if (finished % 10 === 0 || !res.ok) console.log(`${finished}/${jobs.length} ${row.task} ${row.caseId} ${row.route} t${i} ${res.ok ? 'ok' : 'ERR ' + res.error}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log('done');
