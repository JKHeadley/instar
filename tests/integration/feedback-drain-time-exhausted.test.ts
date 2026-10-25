// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * A readiness pass that runs out of tick time, through the production AgentServer wiring
 * and the HTTP tick/status routes (live 2026-10-01: runs ef0f6cbf and 10674e04 made two good
 * calls, then a one-candidate call cut by the tick clock labelled the run degraded with zero
 * provider errors). Each model call advances the drain clock by a fixed start-up cost plus a
 * per-candidate pace; the run must end succeeded with the informational note in
 * /feedback-factory/drain/status, and the rows not reached must stay due.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { READINESS_TIME_EXHAUSTED } from '../../src/feedback-factory/drain/FeedbackDrainService.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';

const AUTH = 'feedback-time-exhausted-auth';
const PIN = '141421';

describe('feedback drain — out of tick time is a succeeded run with a note (HTTP + production wiring)', () => {
  let root: string;
  let server: AgentServer;
  const calls: number[] = [];
  const realNow = Date.now.bind(Date);
  let offset = 0;
  const auth = { Authorization: `Bearer ${AUTH}` };

  beforeAll(async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
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
        offset += 9_000 + 4_500 * packet.length;
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
      feedbackFactory: { processing: {}, drain: { readinessChunkSize: 5, maxWallClockMs: 90_000 }, consumer: { dryRun: true } },
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
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5,
    })).status).toBe(200);
  });

  afterAll(async () => {
    await server?.stop();
    vi.restoreAllMocks();
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

  it('stops before a call that cannot fit; status reports succeeded with the note; the rest stays due', async () => {
    // 70 s readiness window, 9 s + 4.5 s per candidate: 5 (31.5 s), 4 (27 s), then 11.5 s left —
    // under the floor for a later call. Before the fix a one-candidate call (13.5 s) started
    // with an 11.5 s budget and was cut, labelling the run degraded.
    const last = await tick(1);
    expect(last).toMatchObject({ state: 'succeeded', reason: READINESS_TIME_EXHAUSTED });
    expect(calls).toEqual([5, 4]);
    const db = (server as unknown as { feedbackDrain: { store: { db: import('better-sqlite3').Database } } }).feedbackDrain.store.db;
    expect(db.prepare(`SELECT COUNT(*) n FROM readiness WHERE reason_code='readiness-authority-failed'`).get()).toEqual({ n: 0 });
    const reviewed = calls.reduce((a, b) => a + b, 0);
    expect(reviewed).toBeLessThan(12);
    expect((db.prepare(`SELECT COUNT(*) n FROM readiness WHERE state='collecting' AND last_evaluated_at IS NULL`).get() as { n: number }).n).toBe(12 - reviewed);
    // The next tick picks up the rows left due.
    const before = calls.length;
    expect((await tick(2)).state).toBe('succeeded');
    expect(calls.length).toBeGreaterThan(before);
  });
});
