/**
 * Opt-in, content-safe Jev battery for job-result-supervision-v2. Every call
 * goes through the production worker and its fsynced pre-call SQLite audit.
 * The run directory is retained even on interruption for later inspection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobSupervisionStore } from '../dist/scheduler/JobSupervisionStore.js';
import { JobSupervisionWorker } from '../dist/scheduler/JobSupervisionWorker.js';
import { triageQuestions, TRIAGE_JEV_MODEL } from '../dist/scheduler/JobResultTriage.js';
import { SecretStore } from '../dist/core/SecretStore.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentStateDir = process.env.INSTAR_AGENT_STATE_DIR;
if (process.env.INSTAR_LIVE_JOB_SUPERVISION_BENCH !== '1' || !agentStateDir) {
  throw new Error('Live benchmark requires INSTAR_LIVE_JOB_SUPERVISION_BENCH=1 and INSTAR_AGENT_STATE_DIR');
}
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/job-result-supervision-benchmark-v1.json'), 'utf8'));
const promptHash = crypto.createHash('sha256').update(JSON.stringify(triageQuestions())).digest('hex');
if (fixture.taskId !== 'job-result-supervision-v2' || !Array.isArray(fixture.cases)
  || fixture.promptHash !== promptHash || fixture.cases.length < 15
  || new Set(fixture.cases.map(c => c.id)).size !== fixture.cases.length) {
  throw new Error('invalid benchmark corpus');
}
const key = new SecretStore({ stateDir: agentStateDir }).get('typesafe_api_key');
if (typeof key !== 'string' || !key) throw new Error('Jev key unavailable');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
const runDir = path.join(agentStateDir, 'benchmarks', fixture.taskId, runId);
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const store = new JobSupervisionStore(runDir);
const attempts = new Map();
const now = Date.now();
try {
  for (const item of fixture.cases) {
    if (!/^[a-z0-9-]{1,64}$/.test(item.id)
      || !['routine', 'needs-session', 'cannot-tell'].includes(item.expected)
      || typeof item.evidence !== 'string' || Array.from(item.evidence).length > 2000
      || typeof item.sufficient !== 'boolean') throw new Error('invalid benchmark case');
    const attemptId = store.register({ runId: `bench:${runId}:${item.id}`, fireId: `bench:${item.id}`,
      slug: `bench-${item.id}`, decisionEligible: true, evidencePolicy: fixture.promptVersion, now });
    const evidenceHash = crypto.createHash('sha256').update(item.evidence).digest('hex');
    store.recordResult(attemptId, { result: 'success', completedAt: new Date(now).toISOString(),
      evidenceHash, evidenceText: item.evidence, evidenceSufficient: item.sufficient });
    attempts.set(item.id, attemptId);
  }
  const worker = new JobSupervisionWorker({ store, readJevKey: () => key, auditReady: () => true });
  await worker.drain(fixture.cases.length);
  const cases = fixture.cases.map(item => {
    const attemptId = attempts.get(item.id);
    const row = store.get(attemptId);
    const call = store.callRows(attemptId)[0] ?? null;
    const correct = row?.verdict === item.expected;
    if (row?.verdict) store.gradeOutcome({ attemptId,
      evidenceId: `${fixture.taskId}:${fixture.promptVersion}:${item.id}`,
      ruleId: 'bench-expected-label-v1', gradedBy: 'independent-benchmark-corpus',
      grade: correct ? 'correct' : 'incorrect' });
    return { id: item.id, expected: item.expected, verdict: row?.verdict ?? null,
      status: row?.status ?? 'missing', reason: row?.reason ?? null, correct,
      latencyMs: call?.latency_ms ?? null, tokensIn: call?.tokens_in ?? null,
      tokensOut: call?.tokens_out ?? null, settlement: call?.settlement ?? null };
  });
  const summary = {
    taskId: fixture.taskId, corpusVersion: fixture.promptVersion, model: TRIAGE_JEV_MODEL,
    promptHash,
    runId, finishedAt: new Date().toISOString(), total: cases.length,
    correct: cases.filter(c => c.correct).length,
    falseRoutine: cases.filter(c => c.expected === 'needs-session' && c.verdict === 'routine').length,
    unchecked: cases.filter(c => c.status === 'unchecked' || c.status === 'expired-unchecked').length,
    cases,
  };
  const output = path.join(runDir, 'summary.json');
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId, output, total: summary.total, correct: summary.correct,
    falseRoutine: summary.falseRoutine, unchecked: summary.unchecked }));
} finally {
  store.close();
}
