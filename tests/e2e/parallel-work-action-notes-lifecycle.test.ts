// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for CMT-810 on the REAL AgentServer
 * boot path (the one server.ts uses):
 *  1. the action-derived note store is constructed and threaded into the index
 *     (wiring integrity: not null, delegates to the real store on disk);
 *  2. POST /action-claim/observe → GET /parallel-work/activities round-trips an
 *     approval request into focus/lastAction with NO config beyond stateDir;
 *  3. the ParallelWorkSentinel self-registers in the GuardRegistry the production
 *     init passes in, GET /parallel-work/sentinel is 200 (not 503), and GET /guards
 *     grades the sentinel on-confirmed after its first tick;
 *  4. the AgentServer source pins the registration callsite (a manifest that says
 *     expectRuntime:true with no registration would manufacture a phantom `missing`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('CMT-810 parallel-session awareness — E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const registry = new GuardRegistry();
  const AUTH = 'test-e2e-cmt-810';
  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt810-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'topic-intent'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      port: 0, projectName: 'e2e', agentName: 'E2E', authToken: AUTH,
      monitoring: { parallelWorkSentinel: { enabled: true, initialTickDelaySeconds: 0 } },
    }));
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { parallelWorkSentinel: { enabled: true, initialTickDelaySeconds: 0 } }, updates: {},
    } as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), guardRegistry: registry } as any);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/parallel-work-action-notes-lifecycle.test.ts' });
  });

  it('WIRING: the note store is constructed on the production path and delegates to disk', () => {
    const store = server.getTopicActionNoteStore();
    expect(store).not.toBeNull();
    expect(store!.directory).toBe(path.join(stateDir, 'topic-action-notes'));
  });

  it('ALIVE: an approval request observed on a topic becomes that topic\'s focus + lastAction in the index', async () => {
    const obs = await request(app).post('/action-claim/observe').set(auth())
      .send({ message: 'Kernel memory is climbing again. May I restart the Mac Studio? It will take about 3 minutes.', topicId: 102965 });
    expect(obs.status).toBe(200);
    // No actionClaim config on this boot → the commitment lane is disabled, yet the note lands.
    expect(obs.body).toMatchObject({ reason: 'feature-disabled', activityNote: { kind: 'approval-request', verb: 'restart' } });

    const act = await request(app).get('/parallel-work/activities').set(auth());
    expect(act.status).toBe(200);
    const row = act.body.activities.find((a: { topicId: number }) => a.topicId === 102965);
    expect(row).toBeDefined();
    expect(row.focus).toBe('Asked the operator to approve: restart — "May I restart the Mac Studio?"');
    expect(row.lastAction).toMatchObject({ kind: 'approval-request', verb: 'restart' });
    expect(row.tags).toEqual(expect.arrayContaining(['restart', 'studio']));
    // durable: the note is on disk, so a respawned server would still show it
    expect(fs.existsSync(path.join(stateDir, 'topic-action-notes', '102965.json'))).toBe(true);
  });

  it('ALIVE: GET /parallel-work/sentinel is 200 (not 503) and the sentinel is registered in the GuardRegistry', async () => {
    expect(server.getParallelWorkSentinel()).not.toBeNull();
    expect(registry.has('monitoring.parallelWorkSentinel.enabled')).toBe(true);
    const r = await request(app).get('/parallel-work/sentinel').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true });
    expect(typeof r.body.tickCount).toBe('number');
  });

  it('VERIFIABLE: GET /guards grades the sentinel on-confirmed from a real tick (never not-instrumented)', async () => {
    server.getParallelWorkSentinel()!.tick(Date.now());
    const g = await request(app).get('/guards').set(auth());
    expect(g.status).toBe(200);
    const row = g.body.guards.find((x: { key: string }) => x.key === 'monitoring.parallelWorkSentinel.enabled');
    expect(row).toBeDefined();
    expect(row.effective).toBe('on-confirmed');
    expect(row.runtimeReason).toBeUndefined();
    expect(row.runtime.lastTickAt).toBeGreaterThan(0);
    const s = await request(app).get('/parallel-work/sentinel').set(auth());
    expect(s.body.tickCount).toBeGreaterThanOrEqual(1);
  });

  it('SOURCE PIN: AgentServer registers the getter the manifest now expects', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/AgentServer.ts'), 'utf8');
    expect(src).toContain("guardRegistry?.register('monitoring.parallelWorkSentinel.enabled'");
    expect(src).toContain('new TopicActionNoteStore({ stateDir: options.config.stateDir })');
  });

  it('requires Bearer auth on the new read surface', async () => {
    expect((await request(app).get('/parallel-work/sentinel')).status).toBe(401);
  });
});
