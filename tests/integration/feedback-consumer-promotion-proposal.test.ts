// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Consumer promotion is proposal-set bound (docs/specs/feedback-factory-operating-drain.md,
 * Security). Over the real HTTP pipeline: GET /feedback-factory/consumer/promotion/proposal
 * states and precedence, the promote route re-deriving the batch and refusing a stale or
 * invented hash, and the non-owner read that is never locally actionable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { consumerPromotionSetHash } from '../../src/feedback-factory/drain/consumerPromotionProposal.js';
import type { FeedbackConsumerPromotionStore } from '../../src/feedback-factory/drain/FeedbackConsumerPromotionStore.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'feedback-promotion-proposal-auth';
const PIN = '141421';
const H = { Authorization: `Bearer ${AUTH}` };
const HX = { ...H, 'X-Instar-Request': '1' };
const ROUTE = '/feedback-factory/consumer/promotion/proposal';

type Drain = { store: { db: Database.Database }; promotion: FeedbackConsumerPromotionStore };

async function makeServer(root: string, opts: { dryRun: boolean; maxClaimsPerTick?: number; meshSelfId?: string; operatedHostMachineId?: string; resolvePeerUrls?: () => Array<{ machineId: string; url: string }> }) {
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'studio', authToken: AUTH, dashboardPin: PIN }));
  const config = {
    projectName: 'studio', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
    developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    feedbackFactory: {
      ...(opts.operatedHostMachineId ? { operatedHostMachineId: opts.operatedHostMachineId } : {}),
      processing: {}, drain: {}, triage: {},
      consumer: { dryRun: opts.dryRun, ...(opts.maxClaimsPerTick ? { maxClaimsPerTick: opts.maxClaimsPerTick } : {}) },
    },
  } as unknown as InstarConfig;
  const server = new AgentServer({
    config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir),
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    resolvePeerUrls: opts.resolvePeerUrls,
    ...(opts.meshSelfId ? { meshSelfId: opts.meshSelfId } : {}),
    feedbackTriageDeps: { quotaUsedPercent: async () => 10, listMergedPrs: async () => [], secondOpinion: () => null },
  });
  await server.start();
  return { server, drain: () => (server as unknown as { feedbackDrain: Drain }).feedbackDrain };
}

function queueWork(db: Database.Database, ids: Array<{ id: string; firstSeenAt: number }>) {
  const insert = db.prepare(`INSERT INTO work(work_id,idempotency_key,cluster_id,readiness_epoch,state,title,summary,priority,report_count,first_seen_at,last_seen_at,authority_ref,evidence_ref,created_at,updated_at)
    VALUES (?,?,?,1,'queued',?,?,?,?,?,?,'authority','evidence',?,?)`);
  for (const row of ids) insert.run(row.id, `feedback-work:${row.id}:1`, `cluster-${row.id}`, `Title ${row.id}`, 'raw report body must not appear', 'P1', 3, row.firstSeenAt, row.firstSeenAt, row.firstSeenAt, row.firstSeenAt);
}

describe('consumer promotion proposal — owner, consumer configured live', () => {
  let root: string;
  let server: AgentServer;
  let drain: () => Drain;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-live-'));
    ({ server, drain } = await makeServer(root, { dryRun: false, maxClaimsPerTick: 2 }));
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-consumer-promotion-proposal.test.ts' });
  });

  it('no-work, then the exact capped batch in claim order, then promotes only with the fresh hash', async () => {
    const app = server.getApp();
    expect((await request(app).get(ROUTE)).status).toBe(401);
    const empty = await request(app).get(ROUTE).set(H);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ state: 'no-work', reason: expect.any(String), localAction: false, promotionRecord: { present: false, revoked: false, approvedBatchBound: null, requiresReapproval: false } });

    queueWork(drain().store.db, [{ id: 'w-c', firstSeenAt: 3 }, { id: 'w-a', firstSeenAt: 1 }, { id: 'w-b', firstSeenAt: 2 }]);
    const pending = await request(app).get(ROUTE).set(H);
    expect(pending.body).toMatchObject({ state: 'pending', localAction: true, approvedBatchBound: 2, claimsPerRun: 2 });
    expect(pending.body.items).toEqual([
      { workId: 'w-a', title: 'Title w-a', priority: 'P1', reportCount: 3 },
      { workId: 'w-b', title: 'Title w-b', priority: 'P1', reportCount: 3 },
    ]);
    expect(pending.body.proposalSetHash).toBe(consumerPromotionSetHash(['w-b', 'w-a']));
    expect(JSON.stringify(pending.body)).not.toContain('raw report body');

    // Invented hash, wrong bound, and no PIN are all refused; nothing is recorded.
    const invented = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 2, evidenceHash: 'b'.repeat(64), operatorDecisionId: 'operator' });
    expect(invented.status).toBe(409);
    expect(invented.body).toMatchObject({ error: 'promotion-proposal-changed', state: 'pending' });
    expect((await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 1, evidenceHash: pending.body.proposalSetHash, operatorDecisionId: 'operator' })).body.error).toBe('promotion-batch-bound-mismatch');
    expect((await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ approvedBatchBound: 2, evidenceHash: pending.body.proposalSetHash, operatorDecisionId: 'self' })).status).toBe(403);
    expect(drain().promotion.read()).toBeNull();

    // The queue changes after the operator read the proposal: the old hash is stale.
    queueWork(drain().store.db, [{ id: 'w-0', firstSeenAt: 0 }]);
    const stale = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 2, evidenceHash: pending.body.proposalSetHash, operatorDecisionId: 'operator' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('promotion-proposal-changed');

    const fresh = (await request(app).get(ROUTE).set(H)).body;
    expect(fresh.items.map((i: { workId: string }) => i.workId)).toEqual(['w-0', 'w-a']);
    const ok = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: fresh.approvedBatchBound, evidenceHash: fresh.proposalSetHash, operatorDecisionId: 'operator-approved' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ promoted: true, approvedBatchBound: 2 });

    expect(drain().promotion.read()?.approvedWorkIds).toEqual(['w-0', 'w-a']);
    expect(drain().promotion.read()?.approvedAttempts).toEqual({ 'w-0': 0, 'w-a': 0 });
    expect(drain().promotion.approvedWorkIds()).toMatchObject({ ids: ['w-0', 'w-a'], attemptBaselines: { 'w-0': 0, 'w-a': 0 } });
    expect(drain().promotion.isLive()).toBe(true);
    const live = (await request(app).get(ROUTE).set(H)).body;
    expect(live).toMatchObject({ state: 'already-live', localAction: false, promotionRecord: { present: true, revoked: false, approvedBatchBound: 2 } });
    const replay = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: fresh.approvedBatchBound, evidenceHash: fresh.proposalSetHash, operatorDecisionId: 'replay' });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('promotion-not-pending:already-live');
  });

  it('dryRun false with a revoked record proposes again; the pre-revoke approval cannot be replayed for the same set', async () => {
    const app = server.getApp();
    const approvedBefore = drain().promotion.read()!;
    expect((await request(app).post('/feedback-factory/consumer/revoke').set(HX).send({ pin: PIN })).status).toBe(200);
    const replay = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: approvedBefore.approvedBatchBound, evidenceHash: approvedBefore.evidenceHash, operatorDecisionId: 'replay-after-revoke' });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe('promotion-proposal-changed');
    const again = (await request(app).get(ROUTE).set(H)).body;
    expect(again.items.map((i: { workId: string }) => i.workId)).toEqual(approvedBefore.approvedWorkIds);
    expect(again.proposalSetHash).not.toBe(approvedBefore.evidenceHash);
    expect(again).toMatchObject({ state: 'pending', localAction: true, promotionRecord: { present: true, revoked: true, approvedBatchBound: 2 } });
  });

  it('a legacy record from the old syntax-only route needs re-approval and is not live', async () => {
    const app = server.getApp();
    drain().promotion.promote({ approvedBatchBound: 2, evidenceHash: 'e'.repeat(64), operatorDecisionId: 'legacy-syntax-only' });
    expect(drain().promotion.isLive()).toBe(false);
    const body = (await request(app).get(ROUTE).set(H)).body;
    expect(body).toMatchObject({ state: 'pending', localAction: true, promotionRecord: { present: true, revoked: false, requiresReapproval: true } });
  });
});

describe('consumer promotion proposal — consumer configured for simulation', () => {
  let root: string;
  let server: AgentServer;
  let drain: () => Drain;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-sim-'));
    ({ server, drain } = await makeServer(root, { dryRun: true }));
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-consumer-promotion-proposal.test.ts' });
  });

  it('dryRun true wins over a valid record and queued work; promote is refused', async () => {
    const app = server.getApp();
    queueWork(drain().store.db, [{ id: 'w-1', firstSeenAt: 1 }]);
    drain().promotion.promote({ approvedBatchBound: 1, evidenceHash: consumerPromotionSetHash(['w-1']), operatorDecisionId: 'earlier', approvedWorkIds: ['w-1'], approvedAttempts: { 'w-1': 0 } });
    const body = (await request(app).get(ROUTE).set(H)).body;
    expect(body).toMatchObject({ state: 'configured-simulation', localAction: false, promotionRecord: { present: true, revoked: false, approvedBatchBound: 1 } });
    const refused = await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 1, evidenceHash: consumerPromotionSetHash(['w-1']), operatorDecisionId: 'operator' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'promotion-not-pending:configured-simulation', state: 'configured-simulation' });
  });
});

describe('consumer promotion proposal — non-owner', () => {
  let root: string;
  let server: AgentServer;
  let stub: http.Server;
  let ownerBody: Record<string, unknown> = {};

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-instar-agentid'] !== 'studio' || req.headers.authorization !== `Bearer ${AUTH}`) { res.statusCode = 403; res.end('{}'); return; }
      res.end(JSON.stringify(req.url === ROUTE ? ownerBody : {}));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-peer-'));
    ({ server } = await makeServer(root, { dryRun: false, meshSelfId: 'standby-machine', operatedHostMachineId: 'owner-machine', resolvePeerUrls: () => [{ machineId: 'owner-machine', url }] }));
  });
  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => stub.close(() => r()));
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-consumer-promotion-proposal.test.ts' });
  });

  it("proxies the owner's pending proposal but marks it servedBy the owner and never locally actionable", async () => {
    const app = server.getApp();
    ownerBody = { state: 'pending', localAction: true, items: [{ workId: 'w-1', title: 't', priority: 'P1', reportCount: 1 }], proposalSetHash: consumerPromotionSetHash(['w-1']), approvedBatchBound: 1, claimsPerRun: 10, promotionRecord: { present: false, revoked: false, approvedBatchBound: null } };
    const proxied = await request(app).get(ROUTE).set(H);
    expect(proxied.status).toBe(200);
    expect(proxied.body).toMatchObject({ state: 'pending', localAction: false, servedBy: 'owner-machine' });
  });

  it('with the owner unreachable it answers non-owner, servedBy the owner, never actionable', async () => {
    const app = server.getApp();
    const closed = new Promise<void>((r) => stub.close(() => r()));
    stub.closeAllConnections?.();
    await closed;
    const local = await request(app).get(ROUTE).set(H);
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({ state: 'non-owner', localAction: false, servedBy: 'owner-machine' });
    stub = http.createServer(); stub.listen(0);
  });
});
