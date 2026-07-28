/**
 * Integration tests (full HTTP pipeline) for Promise-Beacon Escalation
 * (PROMISE-BEACON-ESCALATION-SPEC §3.0/§6, I11/I13).
 *
 *  - GET  /commitments/escalation-metrics → aggregate counters (§6)
 *  - POST /commitments/:id/revalidate → server-recorded revalidation (§3.0),
 *    with validation (missing summary 400, not-in-revivalMode 409)
 *  - GET  /commitments/:id surfaces the escalation fields
 *  - I13: a revivalMode session is BLOCKED at /operations/evaluate until it
 *    revalidates, then allowed
 *  - I11: escalation fields are server-written-only — never accepted on
 *    POST/PATCH /commitments
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-escalation-auth';

describe('Promise-Beacon Escalation routes (integration)', () => {
  let project: TempProject;
  let tracker: CommitmentTracker;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

  beforeAll(() => {
    project = createTempProject();
    const liveConfig = new LiveConfig(project.stateDir);
    tracker = new CommitmentTracker({ stateDir: project.stateDir, liveConfig });

    const operationGate = new ExternalOperationGate({
      stateDir: project.stateDir,
      autonomyDefaults: AUTONOMY_PROFILES.collaborative,
      services: { gmail: { permissions: ['read', 'write', 'modify'] } },
    });

    // Minimal telegram stub: only getTopicForSession is exercised by the I13 gate.
    const telegramStub = {
      getTopicForSession: (s: string) => (s === 'sess-7' ? 7 : undefined),
    };

    const config: InstarConfig = {
      projectName: 'test-escalation', projectDir: project.dir, stateDir: project.stateDir,
      port: 0, authToken: AUTH, sessions: { maxSessions: 3 }, scheduler: { enabled: false },
      users: [], messaging: [],
      monitoring: { promiseBeacon: { escalation: { revalidationTtlMs: 1_800_000 } } },
    } as unknown as InstarConfig;

    const mockSM = createMockSessionManager();
    server = new AgentServer({
      config,
      sessionManager: mockSM.manager,
      state: mockSM.state,
      commitmentTracker: tracker,
      operationGate,
      telegram: telegramStub as never,
    });
    app = server.getApp();
  });

  afterAll(() => { tracker.stop(); project.cleanup(); });

  it('GET /commitments/escalation-metrics returns aggregate counters', async () => {
    const res = await auth(request(app).get('/commitments/escalation-metrics'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('doubleSpawnCount');
    expect(res.body).toHaveProperty('refusalsByReason');
    expect(res.body).toHaveProperty('totalAttempts');
  });

  it('POST /commitments/:id/revalidate rejects a missing summary (400)', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'a', agentResponse: 'b', topicId: 1 });
    await tracker.mutate(c.id, prev => ({ ...prev, revivalMode: 'status-only-until-revalidated', escalationAttemptId: 'k1' }));
    const res = await auth(request(app).post(`/commitments/${c.id}/revalidate`).send({ escalationAttemptId: 'k1', sessionName: 's' }));
    expect(res.status).toBe(400);
  });

  it('POST /commitments/:id/revalidate is 409 when the commitment is not in revivalMode', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'a', agentResponse: 'b', topicId: 1 });
    const res = await auth(request(app).post(`/commitments/${c.id}/revalidate`)
      .send({ summary: 'restated intent', escalationAttemptId: 'k', sessionName: 's' }));
    expect(res.status).toBe(409);
  });

  it('POST /commitments/:id/revalidate records revalidatedAt/By; GET /:id surfaces escalation fields', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'a', agentResponse: 'b', topicId: 1 });
    await tracker.mutate(c.id, prev => ({ ...prev, revivalMode: 'status-only-until-revalidated', escalationAttemptId: 'kk', escalationAttempts: 1, currentRung: '1' }));
    const res = await auth(request(app).post(`/commitments/${c.id}/revalidate`)
      .send({ summary: 'I am re-checking prerequisites before acting', escalationAttemptId: 'kk', sessionName: 'sess-x' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revalidatedBy).toBe('sess-x');

    const got = await auth(request(app).get(`/commitments/${c.id}`));
    expect(got.body.revalidatedAt).toBeTruthy();
    expect(got.body.escalationAttempts).toBe(1);
    expect(got.body.currentRung).toBe('1');
  });

  it('I13: a revivalMode session is blocked at /operations/evaluate until it revalidates', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'a', agentResponse: 'b', topicId: 7 });
    await tracker.mutate(c.id, prev => ({ ...prev, revivalMode: 'status-only-until-revalidated', escalationAttemptId: 'g7' }));

    // sess-7 → topic 7 → blocking revivalMode commitment → write op BLOCKED.
    const blocked = await auth(request(app).post('/operations/evaluate').send({
      service: 'gmail', mutability: 'write', reversibility: 'reversible',
      description: 'send email', sessionName: 'sess-7',
    }));
    expect(blocked.status).toBe(200);
    expect(blocked.body.action).toBe('block');
    expect(blocked.body.revivalModeBlocked).toBe(true);

    // A read is never gated by I13 (reads fast-path; here the gate proceeds).
    const readOk = await auth(request(app).post('/operations/evaluate').send({
      service: 'gmail', mutability: 'read', reversibility: 'reversible',
      description: 'list email', sessionName: 'sess-7',
    }));
    expect(readOk.body.action).not.toBe('block');

    // Revalidate as sess-7, then the same write is no longer I13-blocked.
    const reval = await auth(request(app).post(`/commitments/${c.id}/revalidate`)
      .send({ summary: 'rechecked; proceeding', escalationAttemptId: 'g7', sessionName: 'sess-7' }));
    expect(reval.status).toBe(200);

    const afterReval = await auth(request(app).post('/operations/evaluate').send({
      service: 'gmail', mutability: 'write', reversibility: 'reversible',
      description: 'send email', sessionName: 'sess-7',
    }));
    expect(afterReval.body.revivalModeBlocked).toBeFalsy();
  });

  it('I11: escalation fields are not accepted on POST /commitments', async () => {
    const res = await auth(request(app).post('/commitments').send({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y', topicId: 1,
      escalationAttempts: 999, revivalMode: 'status-only-until-revalidated', revalidatedAt: '2020-01-01T00:00:00Z',
    }));
    expect(res.status).toBe(201);
    const created = res.body.commitment ?? res.body;
    expect(created.escalationAttempts ?? 0).toBe(0);
    expect(created.revivalMode).toBeFalsy();
    expect(created.revalidatedAt).toBeFalsy();
  });

  it('I11: escalation fields are rejected on PATCH /commitments/:id', async () => {
    const c = tracker.record({ type: 'one-time-action', userRequest: 'a', agentResponse: 'b', topicId: 1, beaconEnabled: true, nextUpdateDueAt: '2099-01-01T00:00:00Z' });
    const res = await auth(request(app).patch(`/commitments/${c.id}`).send({ escalationAttempts: 999 }));
    expect(res.status).toBe(400);
  });
});
