#!/usr/bin/env node
/** Real scheduler and child-process trial inside an OS network sandbox. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildThrowawayJobGuard, isUnderTempRoot, isThrowawayExpired } from '../dist/core/ThrowawayAgentGuard.js';
import { StateManager } from '../dist/core/StateManager.js';
import { JobScheduler } from '../dist/scheduler/JobScheduler.js';
import { jobSupervisionCohortEligible } from '../dist/scheduler/JobSupervisionRollout.js';

const agentDir = process.argv[2];
if (!agentDir || !path.isAbsolute(agentDir)) throw new Error('Pass an absolute throwaway-agent directory');
const config = JSON.parse(fs.readFileSync(path.join(agentDir, '.instar/config.json'), 'utf8'));
const now = Date.now();
assert.equal(isUnderTempRoot(agentDir), true, 'trial agent must live under a fixed temp root');
assert.equal(jobSupervisionCohortEligible('test-agent', config, now), true, 'trial agent must be expiring');
assert.equal(isThrowawayExpired(config.throwawayAgent, now), false);
assert.equal(config.autostart?.autoInstall, false, 'trial agent must have no auto-start');
assert.notEqual(config.scheduler?.allowOnThrowawayAgent, true,
  'the real agent must keep scheduled jobs disabled');

async function networkDenied() {
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
await networkDenied();

const runDir = path.join(agentDir, '.instar/state/job-supervision-scheduled-trial',
  `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
const stateDir = path.join(runDir, '.instar');
const jobsDir = path.join(stateDir, 'jobs');
const slug = 'trial-probe';
// Fake credential with a real provider-key shape: this tests the shared
// durable scrubber, rather than assuming an arbitrary marker is a secret.
const secret = 'sk-ant-api03-' + 'SCHEDULED-TRIAL-SENTINEL-' + 'A'.repeat(60);
fs.mkdirSync(path.join(jobsDir, 'schedule'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(jobsDir, 'instar', 'scripts'), { recursive: true, mode: 0o700 });
const jobsFile = path.join(stateDir, 'jobs.json');
fs.writeFileSync(jobsFile, '[]\n', { mode: 0o600 });
fs.writeFileSync(path.join(jobsDir, 'schedule', `${slug}.json`), JSON.stringify({
  slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'low', model: 'haiku',
  expectedDurationMinutes: 1, enabled: true,
  execute: { type: 'script', value: `${slug}.mjs` }, unrestrictedTools: false,
}), { mode: 0o600 });
fs.writeFileSync(path.join(jobsDir, 'instar', `${slug}.md`), `---\nname: Trial Probe\n` +
  `description: Isolated synthetic result for the job-supervision rollout trial\n` +
  `runner: script\nscript: ${slug}.mjs\nscriptTimeoutMinutes: 1\n` +
  `triageEvidence: structured-only\ntriageFields: [signal]\nscriptSupervision: triage\n` +
  `---\nThis is a synthetic trial job.\n`, { mode: 0o600 });
fs.writeFileSync(path.join(jobsDir, 'instar', 'scripts', `${slug}.mjs`), `
import net from 'node:net';
const client = net.connect(1, '127.0.0.1');
client.once('connect', () => { client.destroy(); process.exitCode = 2; });
client.once('error', error => {
  if (error?.code !== 'EPERM' && error?.code !== 'EACCES') { process.exitCode = 3; return; }
  console.log('JOB_FIELD signal healthy');
  console.log('JOB_RESULT ok synthetic');
  console.log(${JSON.stringify(secret)});
});
`, { mode: 0o600 });

const state = new StateManager(stateDir);
let sessionSpawns = 0;
const sessions = new Proxy({ listRunningSessions: () => [], getSession: () => null }, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && /spawn|create|resume/i.test(key)) {
      return () => { sessionSpawns++; throw new Error(`session creation forbidden in trial: ${key}`); };
    }
    return undefined;
  },
});
const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
  authToken: 'offline-placeholder', projectName: 'trial-agent', port: 0,
  quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
}, sessions, state, stateDir);
// Only this trial-local scheduler gets the throwaway override. The actual
// agent config and its 28 installed jobs remain untouched and blocked.
scheduler.setThrowawayJobGuard(buildThrowawayJobGuard({
  projectDir: agentDir, allowOnThrowawayAgent: true,
}));
scheduler.setConfigReader(() => ({ jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } } }));
scheduler.setScriptStartOffsetEnabled(false);
try {
  scheduler.start();
  assert.deepEqual(scheduler.listScriptJobs().map(job => job.slug), [slug],
    'only the synthetic script may be loaded');
  assert.equal(await scheduler.triggerJob(slug, 'isolated-trial'), 'triggered');
  const deadline = Date.now() + 15_000;
  while (state.getJobState(slug)?.lastResult === 'pending' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(state.getJobState(slug)?.lastResult, 'success');
  assert.equal(sessionSpawns, 0, 'the trial must create no session');
  const runs = scheduler.getRunHistory().query({ slug, limit: 10 }).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runner, 'script');
  assert.equal(runs[0].outputSummary?.includes(secret), false,
    'the durable run summary must not retain the credential');
  assert.ok(runs[0].outputSummary?.includes('[REDACTED:anthropic-key]'),
    'the durable run summary must carry a redaction marker');
  const store = scheduler.getJobSupervisionStore();
  const row = store.findByRunId(runs[0].runId);
  assert.equal(row?.status, 'unchecked', 'the production Jev gate must remain off');
  assert.equal(row?.reason, 'triage-dark');
  assert.ok(row?.evidenceHash && row?.completedAt, 'result must be recorded');
  assert.equal(store.callRows(row.attemptId).length, 0, 'no provider call is allowed');
  assert.equal(store.evidenceText(row.attemptId).includes(secret), false,
    'sensitive output must not enter model evidence');
  const summary = { trial: 'job-supervision-scheduled-v1',
    packageVersion: JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))).version,
    at: new Date().toISOString(), network: 'parent-and-child-outbound-denied-by-os',
    scheduledJobs: 'one synthetic job in trial-local scheduler; actual agent jobs remain blocked',
    sessionsSpawned: sessionSpawns, providerCalls: 0,
    result: { status: row.status, reason: row.reason, runResult: runs[0].result,
      evidenceHashPresent: Boolean(row.evidenceHash) } };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runDir, result: summary.result }));
} finally {
  scheduler.stop();
  scheduler.getJobSupervisionStore().close();
}
for (const subdir of ['state', 'ledger', 'logs']) {
  const dir = path.join(stateDir, subdir);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir, { recursive: true })) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isFile()) {
      assert.equal(fs.readFileSync(filePath).includes(secret), false,
        `sensitive output must not enter durable ${subdir}`);
    }
  }
}
