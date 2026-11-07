// safe-fs-allow: temporary production-shaped agent state is removed by SafeFsExecutor.
import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
vi.mock('../../src/scheduler/JobSupervisionRollout.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/scheduler/JobSupervisionRollout.js')>();
  return { ...original, jobSupervisionRolloutState: (config: unknown) => {
    const active = original.jobSupervisionCohortEligible('test-agent', config);
    return { auditReady: active, cohort: 'test-agent', active };
  } };
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup } from '../../src/core/AppRecordSignatures.js';
import { verifyFixedRegistrySnapshot } from '../../src/scheduler/JobFixedCertificateRegistry.js';
import { fixedCertificateBody, type FixedResultCertificate } from '../../src/scheduler/JobFixedResultCertificate.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { StateManager } from '../../src/core/StateManager.js';
import { buildThrowawayJobGuard } from '../../src/core/ThrowawayAgentGuard.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('fixed certificate authority production boot', () => {
  it('answers 200 with a fresh signed empty registry on its pinned machine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-alive-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    let server: AgentServer | null = null;
    try {
      const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'registry-writer' });
      server = new AgentServer({
        config: { projectName: 'registry-test', projectDir: dir, stateDir, port: 0,
          authToken: 'test-fixed-registry', jobResultSupervision: { fixedRegistry: {
            authorityMachineId: identity.machineId, ownerPublicKeys: {}, reviewerPublicKeys: {},
          } } }, meshSelfId: identity.machineId,
      } as any);
      const response = await request(server.getApp()).get('/jobs/fixed-registry')
        .set('Authorization', 'Bearer test-fixed-registry');
      expect(response.status).toBe(200);
      expect(response.body.epoch).toBe(0);
      expect(verifyFixedRegistrySnapshot(response.body, {
        pinnedAuthorityMachineId: identity.machineId, keyLookup: identityKeyLookup(stateDir),
        now: Date.now(), minimumEpoch: 0,
      })?.authority.activeIds.size).toBe(0);
    } finally {
      await server?.stop();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/job-fixed-registry-alive.test.ts' });
    }
  });

  it('routes a real scheduled fire to the prior runner after a signed pool revocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-joined-'));
    const stateDir = path.join(dir, '.instar');
    const jobsDir = path.join(stateDir, 'jobs');
    const slug = 'fixed-probe';
    fs.mkdirSync(path.join(jobsDir, 'schedule'), { recursive: true });
    fs.mkdirSync(path.join(jobsDir, 'instar', 'scripts'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]\n');
    fs.writeFileSync(path.join(jobsDir, 'schedule', `${slug}.json`), JSON.stringify({
      slug, origin: 'instar', schedule: '0 0 1 1 *', priority: 'low', model: 'haiku',
      expectedDurationMinutes: 1, enabled: true, execute: { type: 'script', value: `${slug}.mjs` },
      unrestrictedTools: false,
    }));
    fs.writeFileSync(path.join(jobsDir, 'instar', `${slug}.md`),
      `---\nname: Fixed Probe\ndescription: Signed revocation trial\nrunner: script\nscript: ${slug}.mjs\n` +
      'scriptTimeoutMinutes: 1\ntriageEvidence: structured-only\ntriageFields: [signal]\nscriptSupervision: triage\n---\nSynthetic only.\n');
    const ranFlag = path.join(dir, 'script-ran.flag');
    fs.writeFileSync(path.join(jobsDir, 'instar', 'scripts', `${slug}.mjs`),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ranFlag)}, 'ran'); console.log('JOB_RESULT success healthy');\n`);
    const identity = await new MachineIdentityManager(stateDir).generateIdentity({ name: 'registry-writer' });
    const owner = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const now = Date.now();
    const config = { projectName: 'fixed-registry-trial', projectDir: dir, stateDir, port: 0,
      authToken: 'fixed-registry-test', developmentAgent: true,
      jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } },
      throwawayAgent: { createdAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 60 * 60_000).toISOString(), keep: false },
      autostart: { autoInstall: false },
      jobResultSupervision: { fixedRegistry: { authorityMachineId: identity.machineId,
        ownerPublicKeys: { owner: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        reviewerPublicKeys: { reviewer: reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } },
    };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const state = new StateManager(stateDir);
    const sessions = createMockSessionManager();
    const scheduler = new JobScheduler({ jobsFile, enabled: true, maxParallelJobs: 1,
      authToken: config.authToken, projectName: config.projectName, port: 0,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessions as any, state, stateDir);
    scheduler.setThrowawayJobGuard(buildThrowawayJobGuard({ projectDir: dir, allowOnThrowawayAgent: true }));
    scheduler.setConfigReader(() => config);
    scheduler.setScriptStartOffsetEnabled(false);
    let server: AgentServer | null = null;
    try {
      scheduler.start();
      server = new AgentServer({ config, state, sessionManager: sessions as any,
        scheduler, meshSelfId: identity.machineId } as any);
      const cert: FixedResultCertificate = { id: 'fixed-probe-v1', version: 1,
        registryEpoch: 1, slug, templateDigest: 'old-script-digest', featureStateHash: 'old-features',
        result: 'success', summary: 'healthy', reasonCode: 'healthy', fields: {},
        observedOutcomes: 300, gradableOutcomes: 300, confirmedMisses: 0, reviewedMissEpoch: 0,
        testEvidenceId: 'independent-test', shadowEvidenceId: 'shadow-300',
        canaryAssertionId: 'canary', canaryPassedAt: new Date(now).toISOString(),
        owner: 'owner', reviewer: 'reviewer', ownerSignature: '', reviewerSignature: '' };
      const body = fixedCertificateBody(cert);
      cert.ownerSignature = crypto.sign(null, Buffer.from(body), owner.privateKey).toString('base64');
      cert.reviewerSignature = crypto.sign(null, Buffer.from(body), reviewer.privateKey).toString('base64');
      const auth = { Authorization: `Bearer ${config.authToken}` };
      expect((await request(server.getApp()).post('/jobs/fixed-registry/issue').set(auth).send(cert)).status).toBe(200);
      const issuedSnapshot = (await request(server.getApp()).get('/jobs/fixed-registry').set(auth)).body;
      const authority = verifyFixedRegistrySnapshot(issuedSnapshot, {
        pinnedAuthorityMachineId: identity.machineId, keyLookup: identityKeyLookup(stateDir),
        now: Date.now(), minimumEpoch: 1,
      })!.authority;
      const store = scheduler.getJobSupervisionStore();
      const attemptId = store.register({ runId: 'independently-graded-fixed', fireId: 'graded-fire', slug,
        templateDigest: cert.templateDigest, featureStateHash: cert.featureStateHash,
        decisionEligible: true, evidencePolicy: 'structured-v2', now: Date.now() });
      store.recordResult(attemptId, { result: 'success', completedAt: new Date().toISOString() });
      expect(store.resolveFixed(attemptId, { parsed: { result: 'success', summary: 'healthy',
        reasonCode: 'healthy', fields: {}, missingResultLine: false, overCap: false,
        ignoredAnomalies: 0, anomalies: [], droppedFields: 0 }, certificate: cert, authority })).toBe(true);
      expect(store.gradeOutcome({ attemptId, evidenceId: 'false-routine-proof', ruleId: 'review',
        gradedBy: 'independent-reviewer', grade: 'incorrect', now: Date.now() })).toBe(true);
      expect(store.slugHoldReason(slug)).toBe('confirmed-false-routine');
      const dispatchDeadline = Date.now() + 8000;
      let revokedSnapshot: any;
      while (Date.now() < dispatchDeadline) {
        revokedSnapshot = (await request(server.getApp()).get('/jobs/fixed-registry').set(auth)).body;
        if (revokedSnapshot.revokedIds?.includes(cert.id)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(revokedSnapshot.revokedIds).toContain(cert.id);
      expect(Object.values(revokedSnapshot.missEpochs)).toEqual([2]);
      while (store.pendingFixedRevocations().length > 0 && Date.now() < dispatchDeadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(store.pendingFixedRevocations()).toHaveLength(0);
      expect(await scheduler.triggerJob(slug, 'revoked-pool-certificate')).toBe('triggered');
      const deadline = Date.now() + 5000;
      while (sessions._spawnCount === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(sessions._spawnCount).toBe(1);
      expect(fs.existsSync(ranFlag)).toBe(false);
      // The source already holds on its independent false-routine grade; a
      // later pool revocation must not weaken that stronger local reason.
      expect(scheduler.getJobSupervisionStore().slugHoldReason(slug)).toBe('confirmed-false-routine');

      // A second machine state must make the same decision from a freshly
      // fetched, signed writer snapshot instead of the writer's local store.
      const peerDir = path.join(dir, 'peer');
      const peerStateDir = path.join(peerDir, '.instar');
      fs.mkdirSync(peerStateDir, { recursive: true });
      const peerIdentityManager = new MachineIdentityManager(peerStateDir);
      const peerIdentity = await peerIdentityManager.generateIdentity({ name: 'registry-peer' });
      peerIdentityManager.registerMachine(identity, 'primary');
      peerIdentityManager.storeRemoteIdentity(identity);
      const pairedSnapshot = (await request(server.getApp()).get('/jobs/fixed-registry').set(auth)).body;
      expect(verifyFixedRegistrySnapshot(pairedSnapshot, {
        pinnedAuthorityMachineId: identity.machineId, keyLookup: identityKeyLookup(peerStateDir),
        now: Date.now(), minimumEpoch: 2,
      })?.authority.revokedIds.has(cert.id)).toBe(true);
      fs.cpSync(jobsDir, path.join(peerStateDir, 'jobs'), { recursive: true });
      const peerJobsFile = path.join(peerStateDir, 'jobs.json');
      fs.writeFileSync(peerJobsFile, '[]\n');
      const peerConfig = { ...config, projectDir: peerDir, stateDir: peerStateDir };
      fs.writeFileSync(path.join(peerStateDir, 'config.json'), JSON.stringify(peerConfig));
      const peerState = new StateManager(peerStateDir);
      const peerSessions = createMockSessionManager();
      const peerScheduler = new JobScheduler({ jobsFile: peerJobsFile, enabled: true, maxParallelJobs: 1,
        authToken: config.authToken, projectName: config.projectName, port: 0,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      }, peerSessions as any, peerState, peerStateDir);
      const writerHttp = server.getApp().listen(0, '127.0.0.1');
      if (!writerHttp.listening) await new Promise<void>(resolve => writerHttp.once('listening', resolve));
      const writerPort = (writerHttp.address() as { port: number }).port;
      let peerServer: AgentServer | null = null;
      try {
        peerScheduler.setThrowawayJobGuard(buildThrowawayJobGuard({ projectDir: peerDir, allowOnThrowawayAgent: true }));
        peerScheduler.setConfigReader(() => peerConfig);
        peerScheduler.setScriptStartOffsetEnabled(false);
        peerScheduler.start();
        peerServer = new AgentServer({ config: peerConfig, state: peerState,
          sessionManager: peerSessions as any, scheduler: peerScheduler,
          meshSelfId: peerIdentity.machineId,
          resolvePeerUrls: () => [{ machineId: identity.machineId,
            url: `http://127.0.0.1:${writerPort}`, kind: 'lan' }],
        } as any);
        expect(await peerScheduler.triggerJob(slug, 'peer-revocation')).toBe('triggered');
        const peerDeadline = Date.now() + 5000;
        while (peerSessions._spawnCount === 0 && Date.now() < peerDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(peerSessions._spawnCount).toBe(1);
        expect(peerScheduler.getJobSupervisionStore().slugHoldReason(slug)).toBe('certificate-revoked');
        expect(fs.existsSync(ranFlag)).toBe(false);
      } finally {
        await peerServer?.stop();
        peerScheduler.stop();
        peerScheduler.getJobSupervisionStore().close();
        await new Promise<void>(resolve => writerHttp.close(() => resolve()));
      }
    } finally {
      await server?.stop();
      scheduler.stop();
      scheduler.getJobSupervisionStore().close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true,
        operation: 'tests/e2e/job-fixed-registry-alive.test.ts' });
    }
  }, 30_000);
});
