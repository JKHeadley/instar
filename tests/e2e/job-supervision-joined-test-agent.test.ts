/** Test-only cohort opens the production scheduler -> server worker path. */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import request from 'supertest';

vi.mock('../../src/scheduler/JobSupervisionRollout.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/scheduler/JobSupervisionRollout.js')>();
  return { ...original, jobSupervisionRolloutState: (config: unknown) => {
    const active = original.jobSupervisionCohortEligible('test-agent', config);
    return { auditReady: active, cohort: 'test-agent', active };
  } };
});

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { buildThrowawayJobGuard } from '../../src/core/ThrowawayAgentGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TRIAGE_JEV_MODEL } from '../../src/scheduler/JobResultTriage.js';
import { fixedCertificateBody, type FixedResultCertificate } from '../../src/scheduler/JobFixedResultCertificate.js';
import { parseScriptOutput } from '../../src/scheduler/jobScriptProtocol.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('joined scheduled-result supervision on an expiring test agent', () => {
  it('constructs the real server worker, audits one mock provider call, and leaves investigation closed', async () => {
    if (process.env.JOB_SUPERVISION_SANDBOX_TRIAL === '1') {
      await new Promise<void>((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
          client.once('connect', () => { client.destroy(); server.close(); reject(new Error('outbound networking available')); });
          client.once('error', error => {
            server.close();
            if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') resolve();
            else reject(error);
          });
        });
      });
    }
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jev-joined-'));
    const stateDir = path.join(agentDir, '.instar');
    const jobsDir = path.join(stateDir, 'jobs');
    const slug = 'trial-probe';
    const token = 'joined-test-only';
    const secret = 'sk-ant-api03-' + 'JOINED-TRIAL-SENTINEL-' + 'A'.repeat(60);
    fs.mkdirSync(path.join(jobsDir, 'schedule'), { recursive: true });
    fs.mkdirSync(path.join(jobsDir, 'instar', 'scripts'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]\n');
    fs.writeFileSync(path.join(jobsDir, 'schedule', `${slug}.json`), JSON.stringify({
      slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'low', model: 'haiku',
      expectedDurationMinutes: 1, enabled: true, execute: { type: 'script', value: `${slug}.mjs` },
      unrestrictedTools: false,
    }));
    fs.writeFileSync(path.join(jobsDir, 'instar', `${slug}.md`), `---\nname: Trial Probe\n` +
      `description: Synthetic result for joined supervision\nrunner: script\nscript: ${slug}.mjs\n` +
      `scriptTimeoutMinutes: 1\ntriageEvidence: structured-only\ntriageFields: [signal]\n` +
      `scriptSupervision: triage\n---\nSynthetic only.\n`);
    if (process.env.JOB_SUPERVISION_SANDBOX_TRIAL === '1') {
      fs.writeFileSync(path.join(jobsDir, 'instar', 'scripts', 'sandbox-probe.flag'), '1');
    }
    fs.writeFileSync(path.join(jobsDir, 'instar', 'scripts', `${slug}.mjs`), `
import net from 'node:net';
import fs from 'node:fs';
if (fs.existsSync(new URL('./sandbox-probe.flag', import.meta.url))) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const client = net.connect(server.address().port, '127.0.0.1');
      client.once('connect', () => { client.destroy(); server.close(); reject(new Error('child outbound networking available')); });
      client.once('error', error => {
        server.close();
        if (error?.code === 'EPERM' || error?.code === 'EACCES') resolve(); else reject(error);
      });
    });
  });
}
console.log('JOB_FIELD signal degraded');
console.log('JOB_RESULT failed dependency-down');
console.log(${JSON.stringify(secret)});
`);

    const now = Date.now();
    const config: InstarConfig = { projectName: 'trial-agent', projectDir: agentDir, stateDir,
      port: 0, authToken: token, secrets: { forceFileKey: true },
      developmentAgent: true, jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } },
      throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(), keep: false },
      autostart: { autoInstall: false },
    } as InstarConfig;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const secretStore = new SecretStore({ stateDir, forceFileKey: true });
    secretStore.set('typesafe_api_key', 'mock-typesafe-key');
    const state = new StateManager(stateDir);
    const sessions = createMockSessionManager();
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
      authToken: token, projectName: 'trial-agent', port: 0,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessions as any, state, stateDir);
    scheduler.setThrowawayJobGuard(buildThrowawayJobGuard({ projectDir: agentDir,
      allowOnThrowawayAgent: true }));
    scheduler.setConfigReader(() => config);
    scheduler.setScriptStartOffsetEnabled(false);
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== 'https://api.typesafe.ai/v1/systemone') throw new Error(`unexpected fetch: ${url}`);
      calls.push(String(init?.body));
      return Response.json({ model: TRIAGE_JEV_MODEL,
        usage: { input_tokens: 30, output_tokens: 8 },
        answers: { triage: { choice: 'needs_session', probabilities: { needs_session: 0.99 } },
          triage_rev: { choice: 'needs_session', probabilities: { needs_session: 0.99 } } } });
    }) as typeof fetch;
    let server: AgentServer | null = null;
    try {
      scheduler.start();
      expect(scheduler.getJobs().map(job => job.slug)).toEqual([slug]);
      expect(scheduler.listScriptJobs().map(job => job.slug)).toEqual([slug]);
      expect(scheduler.scriptRunnersActiveFor(slug)).toBe(true);
      server = new AgentServer({ config, state, sessionManager: sessions as any, scheduler });
      expect(await scheduler.triggerJob(slug, 'joined-e2e')).toBe('triggered');
      const deadline = Date.now() + 15_000;
      let row = null;
      while (Date.now() < deadline) {
        const run = scheduler.getRunHistory().query({ slug, limit: 1 }).runs[0];
        row = run ? scheduler.getJobSupervisionStore().findByRunId(run.runId) : null;
        if (row?.status === 'unresolved') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(row).toMatchObject({ status: 'unresolved', verdict: 'needs-session', provider: 'jev' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain(secret);
      expect(scheduler.getJobSupervisionStore().evidenceText(row!.attemptId)).not.toContain(secret);
      const audits = scheduler.getJobSupervisionStore().callRows(row!.attemptId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ provider: 'jev', actual_model: TRIAGE_JEV_MODEL, settlement: 'current' });
      expect(audits[0].prompt_hash).toBeTruthy();
      expect(audits[0].evidence_hash).toBeTruthy();
      expect(sessions._spawnCount).toBe(0);
      if (process.env.JOB_SUPERVISION_SANDBOX_TRIAL !== '1') {
        const triage = await request(server.getApp()).get('/jobs/triage')
          .set('Authorization', `Bearer ${token}`);
        expect(triage.status).toBe(200);
        expect(triage.body.supervision.rollout).toMatchObject({ cohort: 'test-agent', active: true });
      }

      // A provider that times out must leave a visible unchecked result.
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('mock provider timed out');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        })) as typeof fetch;
      expect(await scheduler.triggerJob(slug, 'joined-timeout-e2e')).toBe('triggered');
      const timeoutDeadline = Date.now() + 30_000;
      let timeoutRow = null;
      while (Date.now() < timeoutDeadline) {
        const runs = scheduler.getRunHistory().query({ slug, limit: 2 }).runs;
        const later = runs.find(run => run.runId !== row!.runId);
        timeoutRow = later ? scheduler.getJobSupervisionStore().findByRunId(later.runId) : null;
        if (timeoutRow?.status === 'unchecked' && timeoutRow.reason === 'provider-timeout') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(timeoutRow).toMatchObject({ status: 'unchecked', reason: 'provider-timeout', verdict: null });
      expect(scheduler.getJobSupervisionStore().callRows(timeoutRow!.attemptId)[0])
        .toMatchObject({ settlement: 'failed', verdict: null });
      expect(sessions._spawnCount).toBe(0);
      // Retire this retryable mock case so it cannot consume the late-response probe.
      scheduler.getJobSupervisionStore().markUnchecked(timeoutRow!.attemptId, 'evidence-withheld');

      // A provider that ignores its abort signal can answer after its lease.
      // Keep that answer as audit, never as the current result's verdict.
      const priorRunIds = new Set(scheduler.getRunHistory().query({ slug, limit: 10 }).runs.map(run => run.runId));
      globalThis.fetch = (async () => new Promise<Response>(resolve => {
        setTimeout(() => resolve(Response.json({ model: TRIAGE_JEV_MODEL,
          usage: { input_tokens: 31, output_tokens: 9 },
          answers: { triage: { choice: 'needs_session', probabilities: { needs_session: 0.99 } },
            triage_rev: { choice: 'needs_session', probabilities: { needs_session: 0.99 } } } })), 16_500);
      })) as typeof fetch;
      expect(await scheduler.triggerJob(slug, 'joined-late-response-e2e')).toBe('triggered');
      const lateDeadline = Date.now() + 35_000;
      let lateRow = null;
      let lateCall = null;
      while (Date.now() < lateDeadline) {
        const runs = scheduler.getRunHistory().query({ slug, limit: 10 }).runs;
        const later = runs.find(run => !priorRunIds.has(run.runId));
        lateRow = later ? scheduler.getJobSupervisionStore().findByRunId(later.runId) : null;
        lateCall = lateRow ? scheduler.getJobSupervisionStore().callRows(lateRow.attemptId)[0] : null;
        if (lateRow?.status === 'unchecked' && lateRow.reason === 'provider-timeout'
          && lateCall?.settlement === 'late') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(lateRow).toMatchObject({ status: 'unchecked', reason: 'provider-timeout', verdict: null });
      expect(lateCall).toMatchObject({ settlement: 'late', verdict: 'needs-session',
        actual_model: TRIAGE_JEV_MODEL });
      expect(sessions._spawnCount).toBe(0);

      // Hold a second synthetic script while its async gate is still running.
      // The fire must switch to the old session route, which stays queued here
      // behind a synthetic capacity holder; the script must never launch.
      const raceSlug = 'trial-gate-race';
      const gateStarted = path.join(agentDir, 'gate-started.flag');
      const gateRelease = path.join(agentDir, 'gate-release.flag');
      fs.writeFileSync(path.join(jobsDir, 'schedule', `${raceSlug}.json`), JSON.stringify({
        slug: raceSlug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'low', model: 'haiku',
        expectedDurationMinutes: 1, enabled: true, execute: { type: 'script', value: `${raceSlug}.mjs` },
        gate: `touch '${gateStarted}'; while [ ! -f '${gateRelease}' ]; do sleep 0.05; done`,
        unrestrictedTools: false,
      }));
      fs.writeFileSync(path.join(jobsDir, 'instar', `${raceSlug}.md`), `---\nname: Trial Gate Race\n` +
        `description: Synthetic gate race\nrunner: script\nscript: ${raceSlug}.mjs\n` +
        `scriptTimeoutMinutes: 1\ntriageEvidence: structured-only\ntriageFields: [signal]\n` +
        `scriptSupervision: triage\n---\nSynthetic only.\n`);
      fs.writeFileSync(path.join(jobsDir, 'instar', 'scripts', `${raceSlug}.mjs`),
        "console.log('JOB_RESULT success healthy');\n");
      sessions._sessions.push({ id: 'synthetic-capacity', name: 'synthetic-capacity',
        status: 'running', tmuxSession: 'synthetic-capacity', startedAt: new Date().toISOString(),
        jobSlug: 'capacity-holder', prompt: '' });
      const gatedFire = scheduler.triggerJob(raceSlug, 'hold-during-gate');
      const gateDeadline = Date.now() + 5_000;
      while (!fs.existsSync(gateStarted) && Date.now() < gateDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(fs.existsSync(gateStarted)).toBe(true);
      scheduler.getJobSupervisionStore().holdSlug(raceSlug, 'certificate-revoked');
      fs.writeFileSync(gateRelease, 'go');
      expect(await gatedFire).toBe('queued');
      expect(scheduler.getRunHistory().query({ slug: raceSlug, limit: 10 }).runs).toHaveLength(0);
      expect(sessions._spawnCount).toBe(0);
      sessions._sessions.length = 0;

      // A revocation written after startup must close this scheduler's next
      // script admission, even if its startup hold cache was already loaded.
      const owner = crypto.generateKeyPairSync('ed25519');
      const reviewer = crypto.generateKeyPairSync('ed25519');
      const cert: FixedResultCertificate = {
        id: 'synthetic-healthy-v1', version: 1, registryEpoch: 7, slug,
        templateDigest: 'sha256:synthetic-v1', featureStateHash: 'features-v1',
        result: 'success', summary: 'healthy', reasonCode: 'healthy', fields: {},
        observedOutcomes: 300, gradableOutcomes: 300, confirmedMisses: 0,
        testEvidenceId: 'synthetic-test', shadowEvidenceId: 'synthetic-shadow',
        canaryAssertionId: 'synthetic-canary', canaryPassedAt: new Date().toISOString(),
        owner: 'synthetic-owner', reviewer: 'synthetic-reviewer',
        ownerSignature: '', reviewerSignature: '',
      };
      const body = Buffer.from(fixedCertificateBody(cert));
      cert.ownerSignature = crypto.sign(null, body, owner.privateKey).toString('base64');
      cert.reviewerSignature = crypto.sign(null, body, reviewer.privateKey).toString('base64');
      const store = scheduler.getJobSupervisionStore();
      const certAttempt = store.register({ runId: 'synthetic-cert-revocation',
        fireId: 'synthetic-cert-revocation', slug,
        templateDigest: cert.templateDigest, featureStateHash: cert.featureStateHash,
        decisionEligible: true, evidencePolicy: 'structured-v2' });
      store.recordResult(certAttempt, { result: 'success' });
      expect(store.resolveFixed(certAttempt, {
        parsed: parseScriptOutput('JOB_RESULT success healthy', 0), certificate: cert,
        authority: { epoch: 7, activeIds: new Set([cert.id]), revokedIds: new Set([cert.id]),
          now: Date.now(),
          ownerPublicKeys: { 'synthetic-owner': owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
          reviewerPublicKeys: { 'synthetic-reviewer': reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        },
      })).toBe(false);
      expect(store.get(certAttempt)).toMatchObject({ status: 'unchecked', reason: 'certificate-revoked' });
      expect(scheduler.scriptRunnersActiveFor(slug)).toBe(false);
      expect(sessions._spawnCount).toBe(0);
      expect(scheduler.getRunHistory().query({ limit: 100 }).runs.every(run => run.slug === slug)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await server?.stop();
      scheduler.stop();
      scheduler.getJobSupervisionStore().close();
      SafeFsExecutor.safeRmSync(agentDir, { recursive: true, force: true,
        operation: 'tests/e2e/job-supervision-joined-test-agent.test.ts' });
    }
  }, 90_000);
});
