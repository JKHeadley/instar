#!/usr/bin/env node
/** Offline, simulated worker trial. Run inside an OS sandbox that denies outbound networking. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnderTempRoot, isThrowawayExpired } from '../dist/core/ThrowawayAgentGuard.js';
import { jobSupervisionCohortEligible } from '../dist/scheduler/JobSupervisionRollout.js';
import { parseScriptOutput } from '../dist/scheduler/jobScriptProtocol.js';
import { projectSupervisionEvidence } from '../dist/scheduler/JobSupervisionEvidence.js';
import { JobSupervisionStore } from '../dist/scheduler/JobSupervisionStore.js';
import { JobSupervisionWorker } from '../dist/scheduler/JobSupervisionWorker.js';
import { TRIAGE_JEV_MODEL } from '../dist/scheduler/JobResultTriage.js';

const agentDir = process.argv[2];
if (!agentDir || !path.isAbsolute(agentDir)) throw new Error('Pass an absolute throwaway-agent directory');
const config = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar/config.json'), 'utf8'));
const now = Date.now();
assert.equal(isUnderTempRoot(agentDir), true, 'trial agent must live under a fixed temp root');
assert.equal(jobSupervisionCohortEligible('test-agent', config, now), true, 'trial record must be expiring');
assert.equal(isThrowawayExpired(config.throwawayAgent, now), false);
assert.equal(config.autostart?.autoInstall, false, 'trial agent must have no auto-start');
assert.notEqual(config.scheduler?.allowOnThrowawayAgent, true, 'trial agent must not run scheduled jobs');

// Prove this PROCESS cannot make even a loopback outbound connection. If the
// sandbox was omitted, the connection succeeds and the trial refuses to run.
async function assertNetworkDenied() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1');
      const timer = setTimeout(() => { client.destroy(); server.close(); reject(new Error('network probe timed out')); }, 2000);
      client.once('connect', () => {
        clearTimeout(timer); client.destroy(); server.close(); reject(new Error('outbound networking is available'));
      });
      client.once('error', error => {
        clearTimeout(timer); server.close();
        if (error?.code === 'EPERM' || error?.code === 'EACCES') resolve();
        else reject(error);
      });
    });
  });
}
await assertNetworkDenied();

const runDir = path.join(agentDir, '.instar/state/job-supervision-offline-trial',
  `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
const store = new JobSupervisionStore(runDir);
const secret = 'PRIVATE KEY-----TRIAL-SENTINEL';
const scenarios = [
  { id: 'routine', output: 'JOB_RESULT ok idle', signal: true, answer: 'routine', expected: 'resolved' },
  { id: 'needs-session', output: 'JOB_RESULT failed dependency-down', signal: false,
    answer: 'needs_session', expected: 'unresolved' },
  { id: 'bare-ok', output: 'JOB_RESULT ok idle', signal: false, answer: 'routine', expected: 'unresolved' },
  { id: 'timeout', output: 'JOB_RESULT ok idle', signal: true, answer: 'timeout', expected: 'unchecked' },
  { id: 'sensitive', output: `JOB_RESULT ok idle\n${secret}`, signal: true,
    answer: 'routine', expected: 'resolved' },
];
const calls = [];
const attempts = new Map();
const responses = new Map(scenarios.map(s => [`trial-${s.id}`, s.answer]));
try {
  for (const scenario of scenarios) {
    const slug = `trial-${scenario.id}`;
    const job = { slug, triageEvidence: 'structured', triageFields: [] };
    const parsed = parseScriptOutput(scenario.output, scenario.id === 'needs-session' ? 1 : 0);
    const projected = projectSupervisionEvidence({ job, parsed, scrubbedOutput: scenario.output,
      independentSignal: scenario.signal ? { source: 'independent-health', independentOfSlug: slug,
        status: 'healthy', observedAt: new Date(now).toISOString() } : null, now });
    assert.equal(projected.ok, true, `${scenario.id} evidence projection`);
    assert.equal(projected.text.includes(secret), false, 'sensitive output must not enter evidence');
    const attemptId = store.register({ runId: `offline:${scenario.id}`, fireId: `offline-fire:${scenario.id}`,
      slug, decisionEligible: true, evidencePolicy: projected.policy, now });
    store.recordResult(attemptId, { result: parsed.result, completedAt: new Date(now).toISOString(),
      evidenceHash: projected.hash, evidenceText: projected.text,
      evidenceSufficient: projected.sufficientForRoutine });
    attempts.set(scenario.id, attemptId);
  }
  const fetchImpl = async (_url, request) => {
    const state = JSON.parse(request.body).state;
    assert.equal(state.includes(secret), false, 'sensitive output must not reach provider request');
    const slug = /^job: (\S+)/m.exec(state)?.[1];
    const answer = responses.get(slug);
    assert.ok(answer, `unexpected mock call for ${slug}`);
    calls.push({ slug, answer });
    if (answer === 'timeout') throw new DOMException('simulated timeout', 'TimeoutError');
    const p = answer === 'needs_session' ? 0.99 : 0.01;
    return Response.json({ model: TRIAGE_JEV_MODEL, usage: { input_tokens: 20, output_tokens: 5 },
      answers: { triage: { choice: answer, probabilities: { needs_session: p } },
        triage_rev: { choice: answer, probabilities: { needs_session: p } } } });
  };
  const worker = new JobSupervisionWorker({ store, readJevKey: () => 'offline-placeholder',
    auditReady: () => true, fetchImpl, now: () => now + 1000 });
  assert.equal(await worker.drain(scenarios.length), scenarios.length);
  const results = scenarios.map(scenario => {
    const attemptId = attempts.get(scenario.id);
    const row = store.get(attemptId);
    const audit = store.callRows(attemptId);
    assert.equal(row.status, scenario.expected, `${scenario.id} status`);
    assert.equal(audit.length, 1, `${scenario.id} call audit count`);
    assert.equal(audit[0].intended_model, TRIAGE_JEV_MODEL);
    assert.ok(audit[0].prompt_hash && audit[0].evidence_hash, `${scenario.id} call identity`);
    return { id: scenario.id, status: row.status, verdict: row.verdict,
      reason: row.reason, audit: {
        provider: audit[0].provider, intendedModel: audit[0].intended_model,
        actualModel: audit[0].actual_model, settlement: audit[0].settlement,
        promptHashPresent: Boolean(audit[0].prompt_hash),
        evidenceHashPresent: Boolean(audit[0].evidence_hash),
        tokensIn: audit[0].tokens_in, tokensOut: audit[0].tokens_out,
      } };
  });
  assert.equal(calls.length, scenarios.length);
  const summary = { trial: 'job-supervision-offline-v1',
    packageVersion: JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))).version,
    at: new Date().toISOString(), network: 'outbound-denied-by-os-probe',
    scheduledJobs: 'blocked-by-throwaway-config; server-not-started-in-this-worker-run',
    provider: 'simulated-in-process; no external call', results };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runDir, count: results.length, statuses: results.map(r => r.status) }));
} finally { store.close(); }
for (const file of fs.readdirSync(runDir, { recursive: true })) {
  const filePath = path.join(runDir, file);
  if (fs.statSync(filePath).isFile()) {
    assert.equal(fs.readFileSync(filePath).includes(secret), false, 'sensitive output must not enter trial state');
  }
}
