// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E (fb-6a8328a1): the production AgentServer path. A machine whose own
 * store holds its OWN commitment while a peer replica carries a copy of the
 * same record (same origin) must close it locally — the route is alive and
 * answers 200, never "ambiguous across machines".
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
import type { InstarConfig } from '../../src/core/types.js';

const SELF = 'm_laptop';
const AUTH = 'test-commitments-same-origin-e2e';

describe('commitments deliver same-origin lifecycle (AgentServer)', () => {
  let tmpDir: string;
  let stateDir: string;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let id: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdso-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = {
      projectName: 'cdso-e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;
    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir), originMachineId: SELF });
    const c = tracker.record({ userRequest: 'await the peer reply', type: 'one-time-action', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    id = c.id;
    const copy = { ...tracker.getAll().find((x) => x.id === id)! };
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as any,
      state: new StateManager(stateDir),
      commitmentTracker: tracker,
      meshSelfId: SELF,
      // The rebuilt peer re-published a restored copy of OUR record.
      commitmentReplicaStore: { allReplicas: () => [{ ownerMachineId: 'm_studio_new', receivedAt: new Date().toISOString(), records: [copy] }] } as any,
    } as any);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    tracker.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/commitments-deliver-same-origin-lifecycle.test.ts' });
  });

  it('POST /commitments/:id/deliver?origin=<self> closes our own record (200, delivered) despite the peer copy', async () => {
    const res = await request(app)
      .post(`/commitments/${id}/deliver?origin=${SELF}`)
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'cdso-e2e' })
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    expect(tracker.getAll().find((c) => c.id === id)?.status).toBe('delivered');
  });
});
