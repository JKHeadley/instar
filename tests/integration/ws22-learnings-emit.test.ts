// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration test for WS2.2 — the EvolutionManager learning-record replication
 * emit seam wired into a real AgentServer. Proves the emit-on-mutation contract holds
 * end-to-end OVER HTTP (not just in unit):
 *   (1) POST /evolution/learnings (a route-driven learning write) fires a `put` through
 *       the same funnel the server-wired manager carries;
 *   (2) PATCH /evolution/learnings/:id/apply (a route-driven mutation) re-fires the put
 *       funnel for the now-applied learning;
 *   (3) GET /evolution/learnings still serves the list (regression — the wired manager
 *       serves its routes with the replication seam attached).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { EvolutionManager, type LearningReplicationEmitter } from '../../src/core/EvolutionManager.js';
import { deriveLearningRecordKey } from '../../src/core/LearningsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('WS2.2 learning-record emit funnel (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let evolution: EvolutionManager;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-int-ws22';
  const putKeys: string[] = [];
  const deleteKeys: string[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws22-int-'));
    stateDir = path.join(tmpDir, 'state-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'int', agentName: 'INT' }));

    evolution = new EvolutionManager({ stateDir });
    const emitter: LearningReplicationEmitter = {
      emitPut: (r) => { const k = deriveLearningRecordKey(r.title, r.category, r.source); if (k) putKeys.push(k); },
      emitDelete: (title, category, source) => { const k = deriveLearningRecordKey(title, category, source); if (k) deleteKeys.push(k); },
    };
    evolution.setLearningReplicationEmitter(emitter);

    const config = {
      projectName: 'int', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
      evolution,
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/ws22-learnings-emit.test.ts' });
  });

  const hdr = () => ({ Authorization: `Bearer ${AUTH}` });
  let createdId: string;
  let expectedKey: string;

  it('(1) POST /evolution/learnings fires a put through the server-wired emit funnel', async () => {
    const res = await request(app).post('/evolution/learnings').set(hdr()).send({
      title: 'integration lesson', category: 'infra',
      description: 'a lesson written over HTTP so the funnel fires end-to-end',
      source: { discoveredAt: '2026-06-01T00:00:00.000Z', contentId: 'thread-7' },
      context: 'integration lesson context for the evidence bridge',
    });
    expect(res.status).toBe(201);
    createdId = res.body.id;
    const k = deriveLearningRecordKey(res.body.title, res.body.category, res.body.source);
    expect(k).not.toBeNull();
    expectedKey = k!;
    expect(putKeys).toContain(expectedKey);
  });

  it('(2) PATCH /evolution/learnings/:id/apply re-fires the put funnel', async () => {
    putKeys.length = 0;
    const res = await request(app).patch(`/evolution/learnings/${createdId}/apply`).set(hdr()).send({ appliedTo: 'MEMORY.md' });
    expect(res.status).toBe(200);
    expect(putKeys).toContain(expectedKey); // the applied learning re-emitted its put
  });

  it('(3) GET /evolution/learnings still serves the list with the seam attached', async () => {
    const res = await request(app).get('/evolution/learnings').set(hdr());
    expect(res.status).toBe(200);
    expect(res.body.learnings.some((l: { title: string }) => l.title === 'integration lesson')).toBe(true);
  });
});
