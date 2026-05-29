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

describe('Commitments API lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH = 'test-commitments-lifecycle-e2e';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitments-lifecycle-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');

    const config: InstarConfig = {
      projectName: 'commitments-lifecycle-e2e',
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

    tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
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
      operation: 'tests/e2e/commitments-api-lifecycle.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'commitments-lifecycle-e2e' });

  it('opens, inspects, delivers, and closes a one-time follow-up commitment', async () => {
    const created = await request(app)
      .post('/commitments')
      .set(auth())
      .send({
        type: 'one-time-action',
        userRequest: 'Follow up on the release gate',
        agentResponse: 'I will follow up once the release gate is clear',
        topicId: 458,
      })
      .expect(201);

    expect(created.body).toMatchObject({
      type: 'one-time-action',
      status: 'pending',
      userRequest: 'Follow up on the release gate',
      agentResponse: 'I will follow up once the release gate is clear',
      topicId: 458,
      source: 'agent',
      verificationCount: 0,
      violationCount: 0,
    });
    expect(created.body.id).toMatch(/^CMT-\d{3}$/);
    expect(created.body.createdAt).toBeTruthy();

    const id = created.body.id;
    const initialLookup = await request(app)
      .get(`/commitments/${id}`)
      .set(auth())
      .expect(200);
    expect(initialLookup.body.status).toBe('pending');
    expect(initialLookup.body.agentResponse).toBe(created.body.agentResponse);

    const activeBefore = await request(app)
      .get('/commitments?status=active')
      .set(auth())
      .expect(200);
    expect(activeBefore.body.commitments.map((c: any) => c.id)).toContain(id);

    const delivered = await request(app)
      .post(`/commitments/${id}/deliver`)
      .set(auth())
      .send({ deliveryMessageId: 'telegram-458-test' })
      .expect(200);

    expect(delivered.body.delivered).toBe(true);
    expect(delivered.body.id).toBe(id);
    expect(delivered.body.commitment.status).toBe('delivered');
    expect(delivered.body.commitment.resolvedAt).toBeTruthy();
    expect(delivered.body.commitment.deliveryMessageId).toBe('telegram-458-test');

    const finalLookup = await request(app)
      .get(`/commitments/${id}`)
      .set(auth())
      .expect(200);
    expect(finalLookup.body.status).toBe('delivered');
    expect(finalLookup.body.resolvedAt).toBe(delivered.body.commitment.resolvedAt);

    const activeAfter = await request(app)
      .get('/commitments?status=active')
      .set(auth())
      .expect(200);
    expect(activeAfter.body.commitments.map((c: any) => c.id)).not.toContain(id);
  });
});
