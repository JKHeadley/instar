// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createHash, createHmac } from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';
import { validateCanonicalPipelineRuntimeEvidence } from '../../src/core/canonicalPipelineRuntimeEvidence.js';
import { handleFeedbackSubmit } from '../../src/feedback-factory/receiver/handlers.js';
import { BlobInboxStore } from '../../src/feedback-factory/receiver/BlobInboxStore.js';
import { BlobInboxClient } from '../../src/feedback-factory/inbox/BlobInboxClient.js';
import { RateLimiter, RATE_LIMITS } from '../../src/feedback-factory/receiver/defense.js';
import { FakeBlobServer } from '../fixtures/FakeBlobServer.js';
import { BackupManager } from '../../src/core/BackupManager.js';

const AUTH = 'feedback-drain-e2e-auth';
const PIN = '481516';
const INBOX_SECRET = 'feedback-drain-e2e-inbox-secret';
const TOKEN_ENV = 'FEEDBACK_DRAIN_E2E_BLOB_TOKEN';

describe('feedback factory drain — real production-adapter lifecycle', () => {
  let root: string;
  let stateDir: string;
  let tracker: InitiativeTracker;
  let server: AgentServer;
  let blob: FakeBlobServer;
  let config: InstarConfig;
  let intelligence: IntelligenceProvider;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-e2e-'));
    stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN }));
    blob = new FakeBlobServer();
    await blob.start();
    process.env[TOKEN_ENV] = 'feedback-drain-e2e-blob-token';
    const inboxClient = new BlobInboxClient({ token: process.env[TOKEN_ENV]!, apiBase: blob.baseUrl });
    for (let index = 0; index < 6; index++) {
      const body = { feedbackId: `feedback-e2e-${index}`, title: 'Recurring scheduler crash', description: 'untrusted raw detail', type: 'bug' };
      const timestamp = String(Date.now() + index);
      const signature = createHmac('sha256', INBOX_SECRET).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
      const received = await handleFeedbackSubmit({
        headers: { 'user-agent': 'instar/1.3.0', 'x-instar-signature': signature, 'x-instar-timestamp': timestamp }, body,
      }, { store: new BlobInboxStore(inboxClient), rateLimiter: new RateLimiter(RATE_LIMITS), secret: INBOX_SECRET, now: Number(timestamp) });
      expect(received.status).toBe(200);
    }
    tracker = new InitiativeTracker(stateDir);
    intelligence = {
      evaluate: async (prompt, options) => {
        options?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
        const clusterId = [...prompt.matchAll(/"clusterId"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
        if (!clusterId) throw new Error('readiness prompt omitted the clustered intake id');
        return JSON.stringify({ decisions: [{
          clusterId, outcome: 'ready', confidence: 0.97,
          reasonCodes: ['coherent-recurrence'], evidenceIds: [`cluster:${clusterId}`],
        }] });
      },
    };
    config = {
      projectName: 'e2e', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: {
        receiverPersistence: { enabled: true, blobTokenEnv: TOKEN_ENV, blobApiBase: blob.baseUrl, pollIntervalMs: 60_000 },
        processing: {}, drain: {}, consumer: { dryRun: false },
      },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    const app = server.getApp();
    for (let attempt = 0; attempt < 100; attempt++) {
      const inbox = await request(app).get('/feedback-inbox/status').set({ Authorization: `Bearer ${AUTH}` });
      if (inbox.body?.drained >= 6) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterAll(async () => {
    await server.stop();
    await blob.stop();
    delete process.env[TOKEN_ENV];
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-factory-drain-lifecycle.test.ts' });
  });

  it('requires the operator root once, then agent approval drains without a human readiness mutation', async () => {
    const app = server.getApp();
    const inbox = await request(app).get('/feedback-inbox/status').set({ Authorization: `Bearer ${AUTH}` });
    expect(inbox.body.drained).toBe(6);
    expect(blob.count('inbox/')).toBe(0);
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ action: 'create', authorityId: 'self-registered' })).status).toBe(403);
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}` }).send({ pin: PIN, action: 'create' })).status).toBe(403);
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', Origin: 'https://attacker.invalid' })
      .send({ pin: PIN, action: 'create' })).status).toBe(403);
    const authority = await request(app)
      .post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({
        pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-spec',
        authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
        provider: 'claude-code', modelFamily: 'fable-5', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
        decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 5,
      });
    expect(authority.status).toBe(200);
    expect((await request(app).get('/feedback-factory/backlog/analysis')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'wrong-agent', 'X-Instar-Request-Nonce': 'feedback-backlog-nonce-0001' })).status).toBe(403);
    const backlog = await request(app).get('/feedback-factory/backlog/analysis?limit=500')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-backlog-nonce-0002' });
    expect(backlog.status).toBe(200);
    expect(backlog.body).toMatchObject({ boundedBatchSize: 50, counts: { clusters: expect.any(Number), reports: expect.any(Number) }, estimatedWorkItemVolume: expect.any(Number) });
    expect(backlog.body).not.toHaveProperty('title');

    const promotion = await request(app)
      .post('/feedback-factory/consumer/promote')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ pin: PIN, approvedBatchBound: 10, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'operator-approved-spec' });
    expect(promotion.status).toBe(200);
    expect((await request(app).post('/feedback-factory/consumer/promote')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ approvedBatchBound: 10, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'self' })).status).toBe(403);

    // No PIN in the operated tick: the registered frontier-model agent is the
    // default readiness authority, and human input is not the throughput gate.
    const tick = await request(app)
      .post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-e2e-nonce-0001' });
    expect(tick.status).toBe(202);
    expect(tick.body).toMatchObject({ runId: expect.stringMatching(/^run:/), accepted: true });

    let status = await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` });
    for (let attempt = 0; attempt < 100 && status.body?.drain?.work?.completed !== 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` });
    }

    const artifact = tracker.list().find((row) => row.feedbackWorkKey?.startsWith('feedback-work:'));
    expect(artifact, JSON.stringify(status.body)).toMatchObject({ kind: 'task', pipelineStage: 'outline', id: expect.stringMatching(/^feedback-/) });
    expect(artifact?.description).not.toContain('untrusted raw detail');

    expect(status.status).toBe(200);
    expect(status.body.drain.work.completed).toBe(1);
    expect(status.body.authority).toMatchObject({ agentId: 'e2e', revoked: false });
    expect(status.body.authority).not.toHaveProperty('provider');
    expect(status.body.authority).not.toHaveProperty('modelFamily');
    expect(status.body.consumerPromotion).not.toHaveProperty('evidenceHash');
    expect(validateCanonicalPipelineRuntimeEvidence({
      consumerConstructed: true, cadenceEnabled: true, productionConsumerAdapter: true, authoritativeReadBack: Boolean(artifact),
      attemptedDeliveries: 1, uniqueWorkRows: status.body.drain.work.completed,
      uniqueArtifactLinks: tracker.list().filter((row) => row.feedbackWorkKey === artifact?.feedbackWorkKey).length,
      progressMetricBefore: 0, progressMetricAfter: status.body.drain.lastCompletedAt,
    })).toEqual([]);

    const repeated = await Promise.all(['feedback-e2e-nonce-0002', 'feedback-e2e-nonce-0003'].map((nonce) => request(app)
      .post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': nonce })));
    expect(repeated.every((response) => response.status === 202)).toBe(true);
    expect(repeated.every((response) => /^run:/.test(response.body.runId))).toBe(true);
    let repeatStatus = await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` });
    for (let attempt = 0; attempt < 100 && ['accepted', 'running'].includes(repeatStatus.body?.lastRun?.state); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      repeatStatus = await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` });
    }
    expect(tracker.list().filter((row) => row.feedbackWorkKey === artifact?.feedbackWorkKey)).toHaveLength(1);

    expect((await request(app).post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}` })).status).toBe(403);
    expect((await request(app).post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-e2e-nonce-0001' })).status).toBe(409);
    const revoked = await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ pin: PIN, action: 'revoke', authorityId: 'feedback-readiness-default', operatorDecisionRef: 'operator-revoke' });
    expect(revoked.body).toMatchObject({ generation: 2, revoked: true });
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ action: 'restore', authorityId: 'feedback-readiness-default' })).status).toBe(403);
  });

  it('authenticates cancellation and durably fences the active run', async () => {
    const app = server.getApp();
    const drain = (server as unknown as { feedbackDrain: { store: { startRun(input: { ownerHost: string; ownerEpoch: number; leaseMs: number }): { runId: string }; stopCancelledRunAtBoundary(runId: string, fence: { ownerHost: string; ownerEpoch: number }): boolean } } }).feedbackDrain;
    const run = drain.store.startRun({ ownerHost: 'e2e', ownerEpoch: 1, leaseMs: 120_000 });
    expect((await request(app).post(`/feedback-factory/drain/runs/${encodeURIComponent(run.runId)}/cancel`)).status).toBe(401);
    expect((await request(app).post(`/feedback-factory/drain/runs/${encodeURIComponent(run.runId)}/cancel`)
      .set({ Authorization: `Bearer ${AUTH}` })).status).toBe(403);
    const cancelled = await request(app).post(`/feedback-factory/drain/runs/${encodeURIComponent(run.runId)}/cancel`)
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ runId: run.runId, cancellationRequested: true });
    expect(drain.store.stopCancelledRunAtBoundary(run.runId, { ownerHost: 'e2e', ownerEpoch: 1 })).toBe(true);
  });

  it('admits failover only on a destructively restored, checksum-bound snapshot', async () => {
    let app = server.getApp();
    const drain = (server as unknown as { feedbackDrain: { store: { checkpointForBackup(epoch: number): { snapshotId: string; manifestChecksum: string } } } }).feedbackDrain;
    const checkpoint = drain.store.checkpointForBackup(1);
    const manager = new BackupManager(stateDir, undefined, () => false);
    const snapshot = manager.createSnapshot('feedback-failover-e2e');
    await server.stop();
    const operatedDir = path.join(stateDir, 'state', 'feedback-factory', 'store');
    SafeFsExecutor.safeRmSync(operatedDir, { recursive: true, force: true, operation: 'feedback failover restored-host e2e' });
    manager.restoreSnapshot(snapshot.id);
    tracker = new InitiativeTracker(stateDir);
    server = new AgentServer({ config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never });
    await server.start();
    app = server.getApp();
    const restoredDrain = (server as unknown as { feedbackDrain: { store: { lastRun(): unknown; metrics(): unknown } } }).feedbackDrain;
    const beforePending = { run: restoredDrain.store.lastRun(), work: (restoredDrain.store.metrics() as { work: unknown }).work, initiatives: tracker.list().length };
    const drainDb = path.join(operatedDir, 'feedback-drain.db');
    const promotionFile = path.join(operatedDir, 'consumer-live.json');
    const durableBytes = () => ({
      db: createHash('sha256').update(fs.readFileSync(drainDb)).digest('hex'),
      promotion: createHash('sha256').update(fs.readFileSync(promotionFile)).digest('hex'),
    });
    const beforeBytes = durableBytes();
    const refusedTick = await request(app).post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-restore-pending-0001' });
    expect(refusedTick.status).toBe(409);
    const pendingHeaders = { Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' };
    expect((await request(app).get('/feedback-factory/backlog/analysis?limit=1')
      .set({ ...pendingHeaders, 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-pending-nonce-0001' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/readiness-authorities').set(pendingHeaders)
      .send({ pin: PIN, action: 'revoke', authorityId: 'feedback-readiness-default', operatorDecisionRef: 'pending-revoke' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/readiness/hold').set(pendingHeaders)
      .send({ pin: PIN, clusterId: 'cluster-1', reason: 'pending-hold' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/readiness/release').set(pendingHeaders)
      .send({ pin: PIN, clusterId: 'cluster-1', predicate: 'source-projection-authority' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/consumer/promote').set(pendingHeaders)
      .send({ pin: PIN, approvedBatchBound: 1, evidenceHash: 'd'.repeat(64), operatorDecisionId: 'pending-promote' })).status).toBe(409);
    expect((await request(app).post('/feedback-factory/consumer/revoke').set(pendingHeaders).send({ pin: PIN })).status).toBe(409);
    expect({ run: restoredDrain.store.lastRun(), work: (restoredDrain.store.metrics() as { work: unknown }).work, initiatives: tracker.list().length }).toEqual(beforePending);
    expect(durableBytes()).toEqual(beforeBytes);
    expect((await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` })).body.restorePending).toBe(true);
    expect((await request(app).post('/feedback-factory/drain/failover/finalize')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'restore-fixture-1', snapshotId: checkpoint.snapshotId, manifestChecksum: checkpoint.manifestChecksum, oldOwnerQuiesced: true })).status).toBe(403);
    const finalized = await request(app).post('/feedback-factory/drain/failover/finalize')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ pin: PIN, restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'restore-fixture-1', snapshotId: checkpoint.snapshotId, manifestChecksum: checkpoint.manifestChecksum, oldOwnerQuiesced: true });
    expect(finalized.status).toBe(200);
    expect(finalized.body).toMatchObject({ finalized: true, ownerAuthorityEpoch: 2, reconciliation: { checked: expect.any(Number) } });
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ pin: PIN, action: 'restore', authorityId: 'feedback-readiness-default', operatorDecisionRef: 'restore-authority-after-failover' })).status).toBe(200);
    expect((await request(app).post('/feedback-factory/readiness-authorities')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1' })
      .send({ pin: PIN, action: 'replace', operatorDecisionRef: 'rebind-authority-after-failover', authorityId: 'feedback-readiness-default',
        agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 2, provider: 'claude-code', modelFamily: 'fable-5',
        promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
        maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 5 })).status).toBe(200);
    expect((await request(app).get('/feedback-factory/backlog/analysis?limit=1')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-pending-nonce-0001' })).status).toBe(200);
    const resumedTick = await request(app).post('/feedback-factory/drain/tick')
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-restored-live-0001' });
    expect(resumedTick.status).toBe(202);
    expect((await request(app).get('/feedback-factory/drain/status').set({ Authorization: `Bearer ${AUTH}` })).body.restorePending).toBe(false);
  });
});
