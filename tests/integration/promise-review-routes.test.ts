/**
 * Promise review + priority over the full HTTP pipeline
 * (docs/specs/promise-review-and-priority.md): priority on POST/PATCH, the
 * ?priority filter, deliver evidence, the review queue/apply floor, reopen,
 * the mobile counts/filter, and the start-up context ordering.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-promise-review-auth';

function makeServer(project: TempProject, tracker: CommitmentTracker, extra: Record<string, unknown>) {
  const config = {
    projectName: 'test-promise-review', projectDir: project.dir, stateDir: project.stateDir,
    port: 0, authToken: AUTH, sessions: { maxSessions: 3 }, scheduler: { enabled: false },
    users: [], messaging: [], ...extra,
  } as unknown as InstarConfig;
  const mockSM = createMockSessionManager();
  return new AgentServer({ config, sessionManager: mockSM.manager, state: mockSM.state, commitmentTracker: tracker }).getApp();
}

describe('promise review + priority (integration)', () => {
  let project: TempProject;
  let tracker: CommitmentTracker;
  let app: ReturnType<typeof makeServer>;
  let fleetApp: ReturnType<typeof makeServer>;
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);
  const open = async (extra: Record<string, unknown> = {}) => {
    const res = await auth(request(app).post('/commitments').send({
      type: 'one-time-action', userRequest: 'please do it', agentResponse: `I will do it ${Math.random()}`,
      followThroughOptOutReason: 'test row, no follow-through needed', ...extra,
    }));
    expect(res.status).toBe(201);
    return res.body.commitment ?? res.body;
  };

  beforeAll(() => {
    project = createTempProject();
    tracker = new CommitmentTracker({ stateDir: project.stateDir, liveConfig: new LiveConfig(project.stateDir) });
    // A development agent with closures live, so apply can be exercised end to end.
    app = makeServer(project, tracker, { developmentAgent: true, commitments: { promiseReview: { closureDryRun: false } } });
    fleetApp = makeServer(project, tracker, {});
  });
  afterAll(() => { tracker.stop(); project.cleanup(); });

  it('POST accepts a priority and refuses an invalid one with 400', async () => {
    const c = await open({ priority: 'high', priorityReason: 'Justin is waiting' });
    expect(c).toMatchObject({ priority: 'high', prioritySetBy: 'agent' });
    const bad = await auth(request(app).post('/commitments').send({
      type: 'one-time-action', userRequest: 'x', agentResponse: 'y', priority: 'urgent',
      followThroughOptOutReason: 'test row, no follow-through needed',
    }));
    expect(bad.status).toBe(400);
  });

  it('PATCH sets a priority (and validates it); GET filters by priority', async () => {
    const c = await open();
    const res = await auth(request(app).patch(`/commitments/${c.id}`).send({ priority: 'low', priorityReason: 'nice to have' }));
    expect(res.status).toBe(200);
    expect(tracker.get(c.id)).toMatchObject({ priority: 'low', priorityReason: 'nice to have' });
    expect((await auth(request(app).patch(`/commitments/${c.id}`).send({ priority: 'meh' }))).status).toBe(400);
    const lows = await auth(request(app).get('/commitments?status=active&priority=low'));
    expect(lows.body.commitments.every((x: { priority?: string }) => x.priority === 'low')).toBe(true);
    expect(lows.body.commitments.some((x: { id: string }) => x.id === c.id)).toBe(true);
    const unset = await auth(request(app).get('/commitments?priority=unset'));
    expect(unset.body.commitments.every((x: { priority?: string }) => !x.priority)).toBe(true);
    expect((await auth(request(app).get('/commitments?priority=urgent'))).status).toBe(400);
  });

  it('deliver stores evidence as the resolution', async () => {
    const c = await open();
    const res = await auth(request(app).post(`/commitments/${c.id}/deliver`).send({ evidence: 'merged as PR 12' }));
    expect(res.status).toBe(200);
    expect(tracker.get(c.id)!.resolution).toBe('merged as PR 12');
  });

  it('the review queue + apply + reopen round trip, with an audit line', async () => {
    const c = await open({ priority: 'low' });
    // a priority must have settled (an hour) before the review may close on it
    await tracker.mutate(c.id, (x) => ({ ...x, prioritySetAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
    const q = await auth(request(app).get('/commitments/review/queue?limit=50'));
    expect(q.status).toBe(200);
    expect(q.body.enabled).toBe(true);
    expect(q.body.items.some((r: { id: string }) => r.id === c.id)).toBe(true);
    const peek = await auth(request(app).get('/commitments/review/queue?peek=1'));
    expect(peek.body).toMatchObject({ enabled: true });
    const applied = await auth(request(app).post('/commitments/review/apply').send({
      runId: 'it-run-1', decisions: [{ id: c.id, action: 'archive', kind: 'obsolete', reason: 'the moment for this has passed' }],
    }));
    expect(applied.status).toBe(200);
    expect(applied.body.results[0].outcome).toBe('applied');
    expect(tracker.get(c.id)).toMatchObject({ status: 'withdrawn', closedBy: 'promise-review' });
    const reopened = await auth(request(app).post(`/commitments/${c.id}/reopen`).send({ reason: 'the user still wants this' }));
    expect(reopened.status).toBe(200);
    expect(tracker.get(c.id)!.status).toBe('pending');
    const again = await auth(request(app).post(`/commitments/${c.id}/reopen`).send({ reason: 'twice' }));
    expect(again.status).toBe(409);
    expect((await auth(request(app).post('/commitments/review/apply').send({ runId: 'bad id', decisions: [] }))).status).toBe(400);
  });

  it('on the fleet (no developmentAgent) the review is dark: queue says disabled, apply is 409', async () => {
    const q = await auth(request(fleetApp).get('/commitments/review/queue?peek=1'));
    expect(q.body).toEqual({ enabled: false, due: 0, runnable: false });
    const a = await auth(request(fleetApp).post('/commitments/review/apply').send({ runId: 'r', decisions: [{ id: 'CMT-001', action: 'keep' }] }));
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('promise-review-disabled');
  });

  it('the start-up context leads with high-priority rows, under their own sub-cap', async () => {
    const h = await open({ priority: 'high', priorityReason: 'a person waits' });
    const res = await auth(request(app).get('/commitments/active-context'));
    expect(res.status).toBe(200);
    const shown = JSON.parse(String(res.body.snippet).split('\n')[1]);
    expect(shown[0].priority).toBe('high');
    expect(shown.some((r: { id: string }) => r.id === h.id)).toBe(true);
    expect(shown.filter((r: { priority?: string }) => r.priority === 'high').length).toBeLessThanOrEqual(8);
  });
});
