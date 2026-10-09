// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feedback triage — production construction path, end to end
 * (docs/specs/feedback-triage-and-execution.md, Phase 1).
 *
 * ingest (signed receiver → blob inbox → InboxDrainer) → drain readiness → Initiative →
 * triage authority approved with the operator PIN → triage tick → (work → class-review done,
 * ranked queue) and (ignore → shadow hold → Initiative paused). The routes answer 200 when the
 * feature is live and 503 when it is dark. Only the model and external I/O are scripted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';
import { handleFeedbackSubmit } from '../../src/feedback-factory/receiver/handlers.js';
import { BlobInboxStore } from '../../src/feedback-factory/receiver/BlobInboxStore.js';
import { BlobInboxClient } from '../../src/feedback-factory/inbox/BlobInboxClient.js';
import { RateLimiter, RATE_LIMITS } from '../../src/feedback-factory/receiver/defense.js';
import { FakeBlobServer } from '../fixtures/FakeBlobServer.js';
import { FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID } from '../../src/feedback-factory/triage/FeedbackTriageArbiter.js';
import { decisionRow, packetsFrom } from '../fixtures/feedbackTriageHarness.js';

const AUTH = 'feedback-triage-e2e-auth';
const PIN = '161803';
const INBOX_SECRET = 'feedback-triage-e2e-inbox-secret';
const TOKEN_ENV = 'FEEDBACK_TRIAGE_E2E_BLOB_TOKEN';
const H = { Authorization: `Bearer ${AUTH}` };
const HX = { ...H, 'X-Instar-Request': '1' };
const baseConfig = (root: string, stateDir: string, extra: Record<string, unknown>) => ({
  projectName: 'e2e', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, requestTimeoutMs: 30_000, version: '0.0.0',
  sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
  scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, ...extra,
}) as unknown as InstarConfig;
const noSessions = { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never;

function prepare(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'feedback-factory', 'store'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'e2e', authToken: AUTH, dashboardPin: PIN }));
  return { root, stateDir };
}

describe('feedback triage — production lifecycle (live on a development agent)', () => {
  let root: string;
  let stateDir: string;
  let server: AgentServer;
  let tracker: InitiativeTracker;
  let blob: FakeBlobServer;

  beforeAll(async () => {
    ({ root, stateDir } = prepare('feedback-triage-e2e-'));
    blob = new FakeBlobServer();
    await blob.start();
    process.env[TOKEN_ENV] = 'feedback-triage-e2e-blob-token';
    const inboxClient = new BlobInboxClient({ token: process.env[TOKEN_ENV]!, apiBase: blob.baseUrl });
    const submissions = [
      ...Array.from({ length: 3 }, (_, i) => ({ feedbackId: `fb-crash-${i}`, title: 'Scheduler crashes on resume', description: 'untrusted raw detail about the crash', type: 'bug' })),
      { feedbackId: 'fb-color-0', title: 'Tooltip colour slightly too pale', description: 'cosmetic only', type: 'feature' },
    ];
    for (const [index, body] of submissions.entries()) {
      const timestamp = String(Date.now() + index);
      const signature = createHmac('sha256', INBOX_SECRET).update(`${timestamp}.${JSON.stringify(body)}`).digest('hex');
      const received = await handleFeedbackSubmit({ headers: { 'user-agent': 'instar/1.3.0', 'x-instar-signature': signature, 'x-instar-timestamp': timestamp }, body },
        { store: new BlobInboxStore(inboxClient), rateLimiter: new RateLimiter(RATE_LIMITS), secret: INBOX_SECRET, now: Number(timestamp) });
      expect(received.status).toBe(200);
    }
    tracker = new InitiativeTracker(stateDir);
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt: string, options?: IntelligenceOptions) => {
        options?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
        if (prompt.includes('registered Feedback Factory triage authority')) {
          return JSON.stringify({ decisions: packetsFrom(prompt).map((p) => decisionRow(p.clusterId, /pale/i.test(p.title)
            ? { disposition: 'ignore', reason: 'low-value', severity: 'low', priority: 10 }
            : { severity: 'high', priority: 85 })) });
        }
        const ids = [...prompt.matchAll(/"clusterId"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter((id) => id !== '...');
        return JSON.stringify({ decisions: [...new Set(ids)].map((clusterId) => ({ clusterId, outcome: 'ready', confidence: 0.97, reasonCodes: ['coherent-recurrence'], evidenceIds: [`cluster:${clusterId}`] })) });
      },
    };
    const config = baseConfig(root, stateDir, {
      developmentAgent: true,
      feedbackFactory: {
        receiverPersistence: { enabled: true, blobTokenEnv: TOKEN_ENV, blobApiBase: blob.baseUrl, pollIntervalMs: 60_000 },
        processing: {}, drain: {}, consumer: { dryRun: false }, triage: {},
      },
    });
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence, sessionManager: noSessions,
      feedbackTriageDeps: { quotaUsedPercent: async () => 5, listMergedPrs: async () => [], secondOpinion: () => null },
    });
    await server.start();
    const app = server.getApp();
    for (let attempt = 0; attempt < 100; attempt++) {
      const inbox = await request(app).get('/feedback-inbox/status').set(H);
      if (inbox.body?.drained >= submissions.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  afterAll(async () => {
    await server.stop();
    await blob.stop();
    delete process.env[TOKEN_ENV];
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-triage-lifecycle.test.ts' });
  });

  it('ingest → readiness → Initiative → approved triage → work is queued, ignore is shadow-held and paused', async () => {
    const app = server.getApp();
    // The triage routes are alive (200, not 503) and wait for the operator.
    const waiting = await request(app).get('/feedback-factory/triage/summary').set(H);
    expect(waiting.status).toBe(200);
    expect(waiting.body.authority).toBe('awaiting-approval');

    // Drain: readiness authority + consumer promotion (operator PIN), then one tick creates the Initiatives.
    expect((await request(app).post('/feedback-factory/readiness-authorities').set(HX).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-readiness', authorityId: 'feedback-readiness-default', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'claude-code', modelFamily: 'fable-5', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 5,
    })).status).toBe(200);
    expect((await request(app).post('/feedback-factory/consumer/promote').set(HX)
      .send({ pin: PIN, approvedBatchBound: 10, evidenceHash: 'b'.repeat(64), operatorDecisionId: 'operator-promote' })).status).toBe(200);
    const drainTick = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...HX, 'X-Instar-AgentId': 'e2e', 'X-Instar-Request-Nonce': 'feedback-triage-e2e-0001' });
    expect(drainTick.status).toBe(202);
    for (let attempt = 0; attempt < 200 && tracker.list().filter((i) => i.feedbackWorkKey).length < 2; attempt++) await new Promise((r) => setTimeout(r, 10));
    const initiatives = tracker.list().filter((i) => i.feedbackWorkKey);
    const drainStatus = await request(app).get('/feedback-factory/drain/status').set(H);
    expect(initiatives, JSON.stringify(drainStatus.body)).toHaveLength(2);

    // Triage authority: the agent's Bearer cannot approve; the operator's PIN does.
    const triageAuthority = {
      action: 'create', operatorDecisionRef: 'operator-triage', agentId: 'e2e', ownerMachineId: 'e2e', ownerEpoch: 1,
      provider: 'claude-code', modelFamily: 'fable-5', maxBatch: 20, maxTokens: 8000, maxDailySpendUsd: 5,
    };
    expect((await request(app).post('/feedback-factory/triage/authority').set(HX).send(triageAuthority)).status).toBe(403);
    const approved = await request(app).post('/feedback-factory/triage/authority').set(HX).send({ ...triageAuthority, pin: PIN });
    expect(approved.status).toBe(200);

    const tick = await request(app).post('/feedback-factory/triage/tick').set(HX);
    expect(tick.status).toBe(202);
    let summary = await request(app).get('/feedback-factory/triage/summary').set(H);
    for (let attempt = 0; attempt < 200 && summary.body.lastTick?.runId !== tick.body.runId; attempt++) {
      await new Promise((r) => setTimeout(r, 10));
      summary = await request(app).get('/feedback-factory/triage/summary').set(H);
    }
    expect(summary.body).toMatchObject({ authority: 'active', counts: { work: 1, hold: 1 }, byReason: { 'hold:ignore-shadow': 1 }, ignoreLive: false });

    const queue = await request(app).get('/feedback-factory/triage/queue').set(H);
    expect(queue.status).toBe(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({ severity: 'high', priority: 85, executionState: 'queued' });
    const work = tracker.get(queue.body.items[0].initiativeId)!;
    expect(work.status).toBe('active');
    expect(work.phases.find((p) => p.id === 'class-review')!.status).toBe('done');
    const ignored = initiatives.find((i) => i.id !== work.id)!;
    expect(tracker.get(ignored.id)!.status).toBe('paused');

    // Triage never wrote Cluster.status or report statuses.
    const clusters = fs.readFileSync(path.join(stateDir, 'state', 'feedback-factory', 'store', 'clusters.jsonl'), 'utf8');
    expect(clusters).not.toMatch(/"status":"(resolved|wontfix|ignored|held)"/);
    // The audit log names the decisions without report text.
    const log = fs.readFileSync(path.join(stateDir, 'logs', 'feedback-triage.jsonl'), 'utf8');
    expect(log).toContain('"event":"decision"');
    expect(log).not.toContain('untrusted raw detail');
    // The digest shows one feedback summary line instead of per-item flags.
    const digest = tracker.digest(new Date(Date.now() + 8 * 24 * 60 * 60_000));
    expect(digest.items.filter((i) => i.reason === 'feedback-summary')).toHaveLength(1);
    expect(digest.items.filter((i) => initiatives.some((x) => x.id === i.initiativeId))).toHaveLength(0);
  });
});

describe('feedback triage — dark on the fleet', () => {
  let root: string;
  let server: AgentServer;

  beforeAll(async () => {
    let stateDir: string;
    ({ root, stateDir } = prepare('feedback-triage-dark-'));
    const config = baseConfig(root, stateDir, {
      developmentAgent: false,
      feedbackFactory: { processing: { enabled: true }, drain: { enabled: true }, consumer: { dryRun: true } },
    });
    server = new AgentServer({ config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), sessionManager: noSessions });
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-triage-lifecycle.test.ts' });
  });

  it('every triage route answers 503 while the drain itself is live', async () => {
    const app = server.getApp();
    expect((await request(app).get('/feedback-factory/drain/status').set(H)).status).toBe(200);
    for (const route of ['/feedback-factory/triage/summary', '/feedback-factory/triage/queue', '/feedback-factory/triage/authority/proposal']) {
      expect((await request(app).get(route).set(H)).status).toBe(503);
    }
    expect((await request(app).post('/feedback-factory/triage/tick').set(HX)).status).toBe(503);
    expect((await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'ignore-live' })).status).toBe(503);
  });
});

// Keep the registry constants referenced so a rename breaks this lifecycle test loudly.
void [FEEDBACK_TRIAGE_DECISION_POINT, FEEDBACK_TRIAGE_PROMPT_ID, FEEDBACK_TRIAGE_SCHEMA_ID];
