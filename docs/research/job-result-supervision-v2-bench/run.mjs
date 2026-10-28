#!/usr/bin/env node
/** Audited synthetic benchmark for the exact v2 job-supervision prompts. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const flag = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const stateDir = flag('state-dir');
const route = flag('route');
const stamp = flag('stamp');
const only = flag('only');
const trials = Number(flag('trials', '1'));
if (!stateDir || !['jev', 'haiku', 'luna'].includes(route) || !stamp || !/^[a-zA-Z0-9_-]{1,64}$/.test(stamp)
  || !Number.isSafeInteger(trials) || trials < 1 || trials > 10) {
  throw new Error('usage: node run.mjs --state-dir /agent/.instar --route jev|haiku|luna --stamp NAME --trials 1..10');
}

const { triageQuestions, TRIAGE_JEV_MODEL } = await import('../../../dist/scheduler/JobResultTriage.js');
const { parseJevSupervisionVerdict } = await import('../../../dist/scheduler/JobSupervisionWorker.js');
const { buildJobReplacementPrompt, parseJobReplacementVerdict, JOB_REPLACEMENT_PROMPT_HASH } =
  await import('../../../dist/scheduler/JobSupervisionReplacementPrompt.js');
const { SecretStore } = await import('../../../dist/core/SecretStore.js');
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/job-result-supervision-benchmark-v1.json'), 'utf8'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const questions = triageQuestions();
const jevPromptHash = hash(JSON.stringify(questions));
if (corpus.taskId !== 'job-result-supervision-v2' || corpus.promptHash !== jevPromptHash) {
  throw new Error('benchmark corpus and live Jev question set differ');
}
const key = route === 'jev' ? new SecretStore({ stateDir: path.resolve(stateDir) }).get('typesafe_api_key') : null;
if (route === 'jev' && (typeof key !== 'string' || key.length === 0)) throw new Error('Jev key unavailable in selected agent store');

const outDir = path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${stamp}.jsonl`);
const done = new Set();
const rows = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
for (const row of rows) {
  if (row.event === 'settled' && row.route === route) done.add(`${row.caseId}:${row.trial}`);
}
function audit(row) {
  const fd = fs.openSync(out, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
// A killed benchmark process cannot report whether its provider call finished.
// Preserve that uncertainty explicitly before trying the case again.
const terminal = new Set(rows.filter(row => ['settled', 'failed', 'unknown'].includes(row.event)).map(row => row.callId));
for (const row of rows) if (row.event === 'pre-call' && !terminal.has(row.callId)) {
  audit({ event: 'unknown', callId: row.callId, taskId: row.taskId, caseId: row.caseId,
    trial: row.trial, route: row.route, reason: 'prior-process-ended-before-settlement',
    observedAt: new Date().toISOString() });
}

async function callJev(evidence) {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: evidence, model: TRIAGE_JEV_MODEL, questions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const data = await response.json();
  if (data.model !== TRIAGE_JEV_MODEL) throw new Error('Jev served a different model');
  const compactAnswer = (value) => ({
    choice: typeof value?.choice === 'string' ? value.choice : null,
    needsSessionProbability: typeof value?.probabilities?.needs_session === 'number'
      ? value.probabilities.needs_session : null,
  });
  return { verdict: parseJevSupervisionVerdict(data), actualProvider: 'typesafe-api',
    actualModel: data.model, tokensIn: data.usage?.input_tokens ?? null,
    tokensOut: data.usage?.output_tokens ?? null, costUsd: null,
    forward: compactAnswer(data.answers?.triage), reverse: compactAnswer(data.answers?.triage_rev),
    responseHash: hash(JSON.stringify(data)) };
}

async function callHaiku(evidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-result-bench-'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CLAUDECODE;
  try {
    const prompt = buildJobReplacementPrompt(evidence);
    const result = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p', '--model', 'haiku', '--setting-sources', '', '--tools', '',
        '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'],
      { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          let report;
          try { report = JSON.parse(stdout); } catch { /* failure stays unclassified */ }
          reject(new Error(report?.api_error === 'usage_limit_reached' ? 'claude-usage-limit' : `Claude exit ${code}`));
        }
        else resolve(JSON.parse(stdout));
      });
      child.stdin.end(prompt);
    });
    const models = Object.keys(result.modelUsage ?? {});
    if (result.is_error || models.length !== 1) throw new Error('Claude error or ambiguous served model');
    const usage = result.usage ?? {};
    return { verdict: parseJobReplacementVerdict(result.result ?? ''), actualProvider: 'claude-code',
      actualModel: models[0], tokensIn: usage.input_tokens ?? null,
      tokensOut: usage.output_tokens ?? null, costUsd: result.total_cost_usd ?? null,
      responseHash: hash(result.result ?? '') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function callLuna(evidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-result-bench-'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  try {
    const prompt = buildJobReplacementPrompt(evidence);
    const result = await new Promise((resolve, reject) => {
      const child = spawn('codex', ['exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--ignore-user-config', '-s', 'read-only', '-m', 'gpt-6-luna', '-'],
      { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Codex exit ${code}`));
        else resolve(stdout);
      });
      child.stdin.end(prompt);
    });
    let output = null, usage = null, servedModel = null, failed = false;
    for (const line of result.split('\n')) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') output = event.item.text;
      if (event.type === 'turn.completed') {
        usage = event.usage;
        if (typeof event.model === 'string') servedModel = event.model;
      }
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
    }
    if (failed || output === null) throw new Error('Codex produced no verified answer');
    return { verdict: parseJobReplacementVerdict(output), actualProvider: 'codex-cli',
      actualModel: servedModel, modelEvidence: servedModel ? 'response' : 'unverified-command-pin',
      tokensIn: usage?.input_tokens ?? null, tokensOut: usage?.output_tokens ?? null,
      costUsd: null, responseHash: hash(output) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

let scored = 0, correct = 0, failed = 0;
cases: for (const item of corpus.cases) for (let trial = 1; trial <= trials; trial++) {
  if (only && item.id !== only) continue;
  if (done.has(`${item.id}:${trial}`)) continue;
  const callId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  audit({ event: 'pre-call', callId, taskId: corpus.taskId, caseId: item.id, trial,
    route, intendedProvider: route === 'jev' ? 'typesafe-api' : route === 'haiku' ? 'claude-code' : 'codex-cli',
    intendedModel: route === 'jev' ? TRIAGE_JEV_MODEL : route === 'haiku' ? 'haiku' : 'gpt-6-luna',
    promptHash: route === 'jev' ? jevPromptHash : JOB_REPLACEMENT_PROMPT_HASH,
    evidencePolicy: 'job-result-structured-v2', evidenceHash: hash(item.evidence),
    gold: item.expected, goldSource: 'reviewed-synthetic-corpus-v1', startedAt });
  try {
    const answer = route === 'jev' ? await callJev(item.evidence)
      : route === 'haiku' ? await callHaiku(item.evidence) : await callLuna(item.evidence);
    const isCorrect = answer.verdict === item.expected;
    audit({ event: 'settled', callId, taskId: corpus.taskId, caseId: item.id, trial, route,
      ...answer, gold: item.expected, correct: isCorrect, latencyMs: Date.now() - startedMs,
      settledAt: new Date().toISOString() });
    scored++; if (isCorrect) correct++;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : 'unknown-error';
    audit({ event: 'failed', callId, taskId: corpus.taskId, caseId: item.id, trial, route,
      error: reason,
      latencyMs: Date.now() - startedMs, settledAt: new Date().toISOString() });
    failed++;
    if (reason === 'claude-usage-limit') break cases;
  }
}
console.log(JSON.stringify({ route, scored, correct, failed, out }));
