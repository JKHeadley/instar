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

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Commitment auto-expiry API lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-commitment-auto-expiry-e2e';
  const now = new Date('2026-07-10T12:00:00.000Z');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-auto-expiry-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');

    const config: InstarConfig = {
      projectName: 'commitment-auto-expiry-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;

    tracker = new CommitmentTracker({
      stateDir,
      liveConfig: new LiveConfig(stateDir),
      autoExpiry: { enabled: true, maxAgeDays: 21, sweepIntervalMs: 21_600_000, dryRun: false },
    });
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      commitmentTracker: tracker,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    tracker.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/commitment-auto-expiry-api-lifecycle.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'commitment-auto-expiry-e2e' });

  it('removes an auto-expired commitment from the active API view while preserving the record', async () => {
    const created = await request(app)
      .post('/commitments')
      .set(auth())
      .send({
        type: 'one-time-action',
        userRequest: 'Merge old PR when CI goes green',
        agentResponse: 'I will merge when CI is green',
        topicId: 458,
      })
      .expect(201);

    const id = created.body.id;
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await tracker.mutate(id, c => ({ ...c, createdAt: old }));

    expect(tracker.sweepAutoExpiry(now).expired).toBe(1);

    const active = await request(app)
      .get('/commitments?status=active')
      .set(auth())
      .expect(200);
    expect(active.body.commitments.map((c: any) => c.id)).not.toContain(id);

    const lookup = await request(app)
      .get(`/commitments/${id}`)
      .set(auth())
      .expect(200);
    expect(lookup.body.status).toBe('expired');
    expect(lookup.body.resolution).toBe('auto-expired: aged out >21d, presumed completed-but-unclosed');
  });
});
