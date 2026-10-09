// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feedback triage over the real HTTP pipeline (docs/specs/feedback-triage-and-execution.md §1–§3, §5–§7).
 *
 * A real AgentServer with a real IntelligenceRouter whose codex door is a scripted fake at the
 * network edge. Covers: the triage authority card (Bearer cannot approve; PIN can), the tick
 * with valid / invalid / low-confidence / critical-ignore / truncated-ignore / chain-duplicate /
 * runaway-ignore model outputs, the queue and summary, the PIN plan/commit routes, and the
 * non-owner posture (409 on ticks, owner proxy then stale copy then 503 on GETs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import { resolveCliModelFlag } from '../../src/providers/adapters/openai-codex/models.js';
import type { InstarConfig, IntelligenceOptions } from '../../src/core/types.js';
import { decisionRow, packetsFrom, type Decide } from '../fixtures/feedbackTriageHarness.js';

const AUTH = 'feedback-triage-routes-auth';
const PIN = '314159';
const H = { Authorization: `Bearer ${AUTH}` };
const HX = { ...H, 'X-Instar-Request': '1' };

function writeStore(canonical: string, clusters: Array<{ id: string; reports: number; title?: string; body?: string }>) {
  const clusterLines: string[] = [];
  const feedbackLines: string[] = [];
  for (const c of clusters) {
    clusterLines.push(JSON.stringify({ clusterId: c.id, title: c.title ?? `Problem ${c.id}`, type: 'bug', reportCount: c.reports, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' }));
    for (let i = 0; i < c.reports; i++) {
      feedbackLines.push(JSON.stringify({ feedbackId: `fb-${c.id}-${i}`, title: c.title ?? `Problem ${c.id}`, description: c.body ?? `report ${i}`, type: 'bug', status: 'processing', clusterId: c.id, receivedAt: `2026-09-0${(i % 9) + 1}T00:00:00Z` }));
    }
  }
  fs.appendFileSync(path.join(canonical, 'clusters.jsonl'), clusterLines.map((l) => `${l}\n`).join(''));
  fs.appendFileSync(path.join(canonical, 'feedback.jsonl'), feedbackLines.map((l) => `${l}\n`).join(''));
}

async function makeServer(opts: { root: string; meshSelfId?: string; operatedHostMachineId?: string; resolvePeerUrls?: () => Array<{ machineId: string; url: string }>; decide: { fn: Decide }; clock: { now: number }; attention: unknown[] }) {
  const stateDir = path.join(opts.root, '.instar');
  const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'studio', authToken: AUTH, dashboardPin: PIN }));
  const tracker = new InitiativeTracker(stateDir);
  const codex = {
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      options?.onModel?.({ model: resolveCliModelFlag(options?.model), framework: 'codex-cli' });
      const out = opts.decide.fn(packetsFrom(prompt), prompt);
      return typeof out === 'string' ? out : JSON.stringify({ decisions: out });
    },
  };
  const intelligence = new IntelligenceRouter({ defaultProvider: codex, defaultFramework: 'codex-cli', resolveConfig: () => undefined, buildProvider: () => null });
  const config = {
    projectName: 'studio', projectDir: opts.root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
    developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    feedbackFactory: { ...(opts.operatedHostMachineId ? { operatedHostMachineId: opts.operatedHostMachineId } : {}), processing: {}, drain: {}, consumer: { dryRun: true }, triage: { maxBatchChars: 200_000 } },
  } as unknown as InstarConfig;
  const secondOpinion = {
    evaluate: async (_p: string, options?: IntelligenceOptions) => {
      options?.onModel?.({ model: 'claude-opus-4-8', framework: 'claude-code' });
      return '{"ignore":false}';
    },
  };
  const server = new AgentServer({
    config, state: new StateManager(stateDir), initiativeTracker: tracker, intelligence,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    resolvePeerUrls: opts.resolvePeerUrls,
    ...(opts.meshSelfId ? { meshSelfId: opts.meshSelfId } : {}),
    feedbackTriageDeps: {
      secondOpinion: () => secondOpinion, quotaUsedPercent: async () => 10, listMergedPrs: async () => [],
      raiseAttention: async (item) => { opts.attention.push(item); }, clock: () => opts.clock.now,
    },
  });
  await server.start();
  return { server, tracker, canonical };
}

async function addItems(tracker: InitiativeTracker, canonical: string, items: Array<{ id: string; reports: number; title?: string; body?: string }>) {
  writeStore(canonical, items);
  for (const item of items) {
    await tracker.create({
      id: `feedback-${item.id}`, kind: 'task', pipelineStage: 'outline', feedbackWorkKey: `feedback-work:${item.id}:1`, title: item.title ?? `Problem ${item.id}`, description: 'd',
      phases: [{ id: 'class-review', name: 'Class review' }, { id: 'spec', name: 'Spec' }, { id: 'build', name: 'Build' }, { id: 'verify', name: 'Verify' }],
      links: [{ type: 'other', label: 'Feedback cluster', ref: item.id }],
    });
  }
}

async function tickAndWait(app: import('express').Express, clock: { now: number }) {
  clock.now += 60_000;
  const tick = await request(app).post('/feedback-factory/triage/tick').set(HX);
  expect(tick.status).toBe(202);
  for (let i = 0; i < 200; i++) {
    const summary = await request(app).get('/feedback-factory/triage/summary').set(H);
    if (summary.body.lastTick?.runId === tick.body.runId) return summary.body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('tick did not finish');
}

describe('feedback triage routes — owner', () => {
  let root: string;
  let server: AgentServer;
  let tracker: InitiativeTracker;
  let canonical: string;
  const decide = { fn: ((packets) => packets.map((p) => decisionRow(p.clusterId))) as Decide };
  const clock = { now: Date.UTC(2026, 9, 7, 16, 0) };
  const attention: unknown[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-triage-routes-'));
    ({ server, tracker, canonical } = await makeServer({ root, decide, clock, attention }));
  });
  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-triage-routes.test.ts' });
  });

  it('awaits the operator: the agent cannot approve the triage authority with its Bearer token; the PIN can', async () => {
    const app = server.getApp();
    const before = await request(app).get('/feedback-factory/triage/summary').set(H);
    expect(before.status).toBe(200);
    expect(before.body.authority).toBe('awaiting-approval');
    const proposal = await request(app).get('/feedback-factory/triage/authority/proposal').set(H);
    expect(proposal.body).toMatchObject({ status: 'none', approveAction: 'create', blockers: [] });
    expect((await request(app).post('/feedback-factory/triage/authority').set(HX).send({ action: 'create', useProposal: true, operatorDecisionRef: 'agent-self' })).status).toBe(403);
    const approved = await request(app).post('/feedback-factory/triage/authority').set(HX).send({ action: 'create', useProposal: true, pin: PIN, operatorDecisionRef: 'operator-dashboard-1' });
    expect(approved.status).toBe(200);
    expect((await request(app).get('/feedback-factory/triage/summary').set(H)).body.authority).toBe('active');
  });

  it('applies valid, low-confidence, critical-ignore, truncated-ignore and chain-duplicate outputs through the floors', async () => {
    const app = server.getApp();
    await addItems(tracker, canonical, [
      { id: 'valid', reports: 3, title: 'Dashboard crashes when opening jobs tab' },
      { id: 'lowconf', reports: 1 },
      { id: 'critical', reports: 2 },
      { id: 'truncated', reports: 6 },
      { id: 'canon', reports: 1, title: 'login fails with expired token' },
      { id: 'chain', reports: 1, title: 'login fails with expired token again' },
    ]);
    decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, {
      valid: { severity: 'high', priority: 80 },
      lowconf: { confidence: 0.4 },
      critical: { disposition: 'ignore', reason: 'not-a-defect', severity: 'critical' },
      truncated: { disposition: 'ignore', reason: 'low-value', severity: 'low' },
      canon: {},
      chain: { disposition: 'ignore', reason: 'duplicate', duplicateOf: 'canon', severity: 'low' },
    }[p.clusterId] ?? {}));
    const summary = await tickAndWait(app, clock);
    expect(summary.lastTick).toMatchObject({ result: 'succeeded', decided: 6 });
    expect(summary.byReason).toMatchObject({ 'hold:needs-evidence': 1, 'hold:needs-review': 1, 'hold:evidence-truncated': 1, 'hold:duplicate-unverified': 1 });
    const queue = await request(app).get('/feedback-factory/triage/queue').set(H);
    expect(queue.body.items.map((i: { clusterId: string }) => i.clusterId)).toEqual(['valid', 'canon']);
    expect(queue.body.items[0]).toMatchObject({ severity: 'high', executionState: 'queued', prLink: null });
    expect(tracker.get('feedback-lowconf')!.status).toBe('paused');
    expect(tracker.get('feedback-valid')!.phases[0].status).toBe('done');
  });

  it('an invalid model answer leaves items untriaged (never defaulted)', async () => {
    const app = server.getApp();
    await addItems(tracker, canonical, [{ id: 'invalid', reports: 1 }]);
    decide.fn = () => 'this is not json';
    const summary = await tickAndWait(app, clock);
    expect(summary.lastTick).toMatchObject({ result: 'degraded', reason: 'triage-output-unusable' });
    expect(summary.counts.untriaged).toBeGreaterThanOrEqual(1);
  });

  it('a runaway ignore rate engages the brake and holds the next ignores', async () => {
    const app = server.getApp();
    decide.fn = (packets) => packets.map((p) => decisionRow(p.clusterId, { disposition: 'ignore', reason: 'low-value', severity: 'low' }));
    await addItems(tracker, canonical, Array.from({ length: 60 }, (_, i) => ({ id: `junk${i}`, reports: 1 })));
    await tickAndWait(app, clock);
    await addItems(tracker, canonical, [{ id: 'afterbrake', reports: 1 }]);
    const summary = await tickAndWait(app, clock);
    expect(summary.ignoreBrake.engaged).toBe(true);
    expect(summary.byReason['hold:ignore-rate-brake']).toBeGreaterThanOrEqual(1);
  });

  it('a tick is single-flight and rate-limited', async () => {
    const app = server.getApp();
    clock.now += 60_000;
    expect((await request(app).post('/feedback-factory/triage/tick').set(H)).status).toBe(403);
    const first = await request(app).post('/feedback-factory/triage/tick').set(HX);
    expect(first.status).toBe(202);
    const second = await request(app).post('/feedback-factory/triage/tick').set(HX);
    expect([409, 429]).toContain(second.status);
  });

  it('a read whose local handler throws answers 500 instead of hanging', async () => {
    const app = server.getApp();
    const triage = (server as unknown as { feedbackTriage: { service: { summary: () => unknown } } }).feedbackTriage;
    const original = triage.service.summary;
    triage.service.summary = () => { throw new Error('summary exploded'); };
    try {
      const res = await request(app).get('/feedback-factory/triage/summary').set(H).timeout(5_000);
      expect(res.status).toBe(500);
    } finally { triage.service.summary = original; }
  });

  it('PIN plan/commit: ignore-live commits once with the PIN; executor actions are refused as not yet available', async () => {
    const app = server.getApp();
    const executor = await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'publish-secret-shape' });
    expect(executor.status).toBe(400);
    expect(executor.body.error).toMatch(/not available until the feedback executor ships/);
    const plan = await request(app).post('/feedback-factory/triage/plan').set(HX).send({ action: 'ignore-live' });
    expect(plan.status).toBe(200);
    expect(plan.body.renderedText).toMatch(/Turn ON live ignores/);
    expect((await request(app).post('/feedback-factory/triage/commit').set(HX).send({ planId: plan.body.planId, nonce: plan.body.nonce })).status).toBe(403);
    expect((await request(app).post('/feedback-factory/triage/commit').set(HX).send({ pin: '000000', planId: plan.body.planId, nonce: plan.body.nonce })).status).toBe(403);
    const committed = await request(app).post('/feedback-factory/triage/commit').set(HX).send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(committed.status).toBe(200);
    expect(committed.body.ignoreLive).toBe(true);
    expect((await request(app).post('/feedback-factory/triage/commit').set(HX).send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce })).status).toBe(409);
    expect((await request(app).get('/feedback-factory/triage/summary').set(H)).body.ignoreLive).toBe(true);
  });
});

describe('feedback triage routes — non-owner posture', () => {
  let root: string;
  let server: AgentServer;
  let stub: http.Server;
  let stubUrl = '';
  const clock = { now: Date.UTC(2026, 9, 7, 16, 0) };

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      // The owner's auth middleware requires the AGENT id (projectName), not the machine id.
      if (req.headers['x-instar-agentid'] !== 'studio' || req.headers.authorization !== `Bearer ${AUTH}`) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'agent_id_mismatch', expected: 'studio' }));
        return;
      }
      res.end(JSON.stringify(req.url === '/feedback-factory/triage/summary' ? { authority: 'active', counts: { work: 7 } } : { items: [] }));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-triage-peer-'));
    ({ server } = await makeServer({ root, meshSelfId: 'standby-machine', operatedHostMachineId: 'owner-machine', resolvePeerUrls: () => [{ machineId: 'owner-machine', url: stubUrl }],
      decide: { fn: () => [] }, clock, attention: [] }));
  });
  afterAll(async () => {
    await server.stop();
    await new Promise<void>((r) => stub.close(() => r()));
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-triage-routes.test.ts' });
  });

  it('ticks answer 409 naming the owner; GETs proxy to the owner, then serve the last copy tagged stale', async () => {
    const app = server.getApp();
    const tick = await request(app).post('/feedback-factory/triage/tick').set(HX);
    expect(tick.status).toBe(409);
    expect(tick.body.owner).toBe('owner-machine');
    const proxied = await request(app).get('/feedback-factory/triage/summary').set(H);
    expect(proxied.status).toBe(200);
    expect(proxied.body).toMatchObject({ authority: 'active', counts: { work: 7 }, servedBy: 'owner-machine' });
    const closed = new Promise<void>((r) => stub.close(() => r()));
    stub.closeAllConnections?.();
    await closed;
    const stale = await request(app).get('/feedback-factory/triage/summary').set(H);
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ stale: true, servedBy: 'owner-machine' });
    const neverFetched = await request(app).get('/feedback-factory/triage/queue').set(H);
    expect(neverFetched.status).toBe(503);
    expect(neverFetched.body.owner).toBe('owner-machine');
    stub = http.createServer(); stub.listen(0);
  });
});
