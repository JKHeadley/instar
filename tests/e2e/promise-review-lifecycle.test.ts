/**
 * Promise review is ALIVE on the production init path
 * (docs/specs/promise-review-and-priority.md §8): a started server on a
 * development-agent config answers the review queue 200 enabled:true, applies a
 * decision and writes the audit line; a fleet config answers enabled:false.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-promise-review-e2e';

async function boot(developmentAgent: boolean) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promise-review-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  // The shipped defaults, as an updated agent gets them (enabled omitted → the dev gate decides).
  const fileConfig: Record<string, unknown> = { ...(developmentAgent ? { developmentAgent: true } : {}) };
  applyDefaults(fileConfig, getMigrationDefaults('managed-project'));
  expect((fileConfig.commitments as { promiseReview?: { enabled?: unknown } }).promiseReview).toBeDefined();
  expect((fileConfig.commitments as { promiseReview: { enabled?: unknown } }).promiseReview.enabled).toBeUndefined();
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(fileConfig));
  const config = {
    projectName: 'promise-review-e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...(developmentAgent ? { developmentAgent: true } : {}),
    commitments: (fileConfig as { commitments?: unknown }).commitments,
  } as unknown as InstarConfig;
  const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
  const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir), commitmentTracker: tracker });
  await server.start();
  return { tmpDir, stateDir, tracker, server, app: server.getApp() };
}

describe('promise review lifecycle (e2e)', () => {
  let dev: Awaited<ReturnType<typeof boot>>;
  let fleet: Awaited<ReturnType<typeof boot>>;
  const auth = { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'promise-review-e2e' };

  beforeAll(async () => {
    dev = await boot(true);
    fleet = await boot(false);
  });
  afterAll(async () => {
    for (const b of [dev, fleet]) {
      await b.server.stop();
      b.tracker.stop();
      SafeFsExecutor.safeRmSync(b.tmpDir, { recursive: true, force: true, operation: 'tests/e2e/promise-review-lifecycle.test.ts' });
    }
  });

  it('is alive on a development agent: queue 200 enabled, closures shadowed by default, audit written', async () => {
    const created = await request(dev.app).post('/commitments').set(auth).send({
      type: 'one-time-action', userRequest: 'check the thing', agentResponse: 'I will check the thing',
      priority: 'low', followThroughOptOutReason: 'e2e row, no follow-through needed',
    }).expect(201);
    const id = (created.body.commitment ?? created.body).id;
    await dev.tracker.mutate(id, (x) => ({ ...x, prioritySetAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
    const q = await request(dev.app).get('/commitments/review/queue').set(auth).expect(200);
    expect(q.body).toMatchObject({ enabled: true, closureDryRun: true });
    expect(q.body.items.map((r: { id: string }) => r.id)).toContain(id);
    const a = await request(dev.app).post('/commitments/review/apply').set(auth)
      .send({ runId: 'e2e-1', decisions: [{ id, action: 'archive', kind: 'obsolete', reason: 'nothing left to check here' }] }).expect(200);
    expect(a.body.results[0].outcome).toBe('would-apply');
    expect(dev.tracker.get(id)!.status).toBe('pending');
    const audit = fs.readFileSync(path.join(dev.stateDir, 'logs', 'promise-review.jsonl'), 'utf-8');
    expect(audit).toContain('"outcome":"would-apply"');
  });

  it('is dark on the fleet', async () => {
    const q = await request(fleet.app).get('/commitments/review/queue?peek=1').set(auth).expect(200);
    expect(q.body).toEqual({ enabled: false, due: 0, runnable: false });
  });
});
