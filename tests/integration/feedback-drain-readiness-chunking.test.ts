// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Readiness chunking through the production AgentServer wiring and the HTTP tick
 * route: feedbackFactory.drain.readinessChunkSize and .maxWallClockMs reach the
 * service, and one tick makes several bounded model calls up to the authority's
 * maxBatch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-chunking-auth';
const PIN = '314159';

describe('feedback drain readiness chunking — HTTP + production wiring', () => {
  let root: string;
  let server: AgentServer;
  const calls: number[] = [];
  const auth = { Authorization: `Bearer ${AUTH}` };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-chunking-'));
    const stateDir = path.join(root, '.instar');
    const canonical = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'chunking', authToken: AUTH, dashboardPin: PIN }));
    fs.writeFileSync(path.join(canonical, 'feedback.jsonl'), '');
    fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), Array.from({ length: 12 }, (_, i) => `${JSON.stringify({
      clusterId: `cluster-chunk-${String(i).padStart(2, '0')}`, title: `Scheduler regression ${i}`, type: 'bug', reportCount: 2,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    })}\n`).join(''));
    const intelligence: IntelligenceProvider = {
      evaluate: async (prompt, options) => {
        const packet = JSON.parse(prompt.slice(prompt.indexOf('Candidates: ') + 12)) as Array<{ clusterId: string }>;
        calls.push(packet.length);
        await new Promise((resolve) => setTimeout(resolve, 5 * packet.length));
        options?.onModel?.({ model: 'gpt-6-astra', framework: 'codex-cli' });
        return JSON.stringify({ decisions: packet.map(({ clusterId }) => ({
          clusterId, outcome: clusterId.endsWith('03') ? 'ready' : 'collecting', confidence: 0.9,
          reasonCodes: ['generic-symptom-report'], evidenceIds: [`cluster:${clusterId}`],
        })) });
      },
    };
    const config = {
      projectName: 'chunking', projectDir: root, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      developmentAgent: true, requestTimeoutMs: 30_000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
      feedbackFactory: { processing: {}, drain: { readinessChunkSize: 4, maxWallClockMs: 90_000 }, consumer: { dryRun: true } },
    } as InstarConfig;
    server = new AgentServer({
      config, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), intelligence,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [], on: () => undefined } as never,
    });
    await server.start();
    expect((await request(server.getApp()).post('/feedback-factory/readiness-authorities').set({ ...auth, 'X-Instar-Request': '1' }).send({
      pin: PIN, action: 'create', operatorDecisionRef: 'operator-approved-chunking',
      authorityId: 'feedback-readiness-default', agentId: 'chunking', ownerMachineId: 'chunking', ownerEpoch: 1,
      provider: 'codex-cli', modelFamily: 'gpt-6-astra', promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 10, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback-drain-readiness-chunking.test.ts' });
  });

  async function tick(nonce: number): Promise<{ state: string; reason: string }> {
    const app = server.getApp();
    const accepted = await request(app).post('/feedback-factory/drain/tick')
      .set({ ...auth, 'X-Instar-Request': '1', 'X-Instar-AgentId': 'chunking', 'X-Instar-Request-Nonce': `feedback-chunking-${String(nonce).padStart(4, '0')}` });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    for (let attempt = 0; attempt < 500; attempt++) {
      const last = (await request(app).get('/feedback-factory/drain/status').set(auth)).body?.lastRun;
      if (last?.runId === accepted.body.runId && !['accepted', 'running'].includes(last.state)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('drain run did not finish');
  }

  it('wires both config fields into the live service', () => {
    const service = (server as unknown as { feedbackDrain: { service: Record<string, unknown> } }).feedbackDrain.service;
    expect(service.readinessChunkSize).toBe(4);
    expect(service.maxWallClockMs).toBe(90_000);
  });

  it('one tick makes bounded calls up to the authority maxBatch; the next tick takes the rest', async () => {
    expect((await tick(1)).state).toBe('succeeded');
    expect(calls).toEqual([4, 4, 2]);
    expect((await tick(2)).state).toBe('succeeded');
    expect(calls).toEqual([4, 4, 2, 2]);
    const status = (await request(server.getApp()).get('/feedback-factory/drain/status').set(auth)).body;
    expect(status.drain.readiness.queued).toBe(1);
    const db = (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;
    expect((db.prepare(`SELECT COUNT(*) n FROM readiness WHERE state='collecting' AND last_evaluated_at IS NULL`).get() as { n: number }).n).toBe(0);
    expect(db.prepare(`SELECT committed_usd usd, decisions FROM authority_daily_usage`).get()).toEqual({ usd: 0.04, decisions: 12 });
  });
});
