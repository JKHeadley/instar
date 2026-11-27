/**
 * CMT-1610 full HTTP path for script-route supervision holds:
 * GET /jobs/:slug/supervision-hold and POST /jobs/:slug/supervision-hold/release
 * through the real AgentServer, auth middleware and scheduler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('supervision hold routes', () => {
  let dir: string;
  let server: AgentServer;
  let scheduler: JobScheduler;
  const token = 'hold-routes-int';
  const auth = { Authorization: `Bearer ${token}` };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hold-routes-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const state = new StateManager(stateDir);
    const sessionManager = createMockSessionManager();
    scheduler = new JobScheduler({
      jobsFile, enabled: false, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessionManager as any, state, stateDir);
    const config: InstarConfig = { projectName: 'hold-routes', projectDir: dir, stateDir, port: 0, authToken: token };
    server = new AgentServer({ config, sessionManager: sessionManager as any, state, scheduler });
  });

  afterAll(async () => {
    await server?.stop();
    scheduler?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-supervision-hold-routes.test.ts' });
  });

  it('requires auth and a reason, answers not-held, and refuses while a run is unsettled', async () => {
    const app = server.getApp();
    expect((await request(app).get('/jobs/probe/supervision-hold')).status).toBe(401);
    expect((await request(app).post('/jobs/probe/supervision-hold/release').send({ reason: 'x' })).status).toBe(401);
    expect((await request(app).post('/jobs/Bad_Slug/supervision-hold/release').set(auth).send({ reason: 'x' })).status).toBe(400);
    expect((await request(app).post('/jobs/probe/supervision-hold/release').set(auth).send({})).status).toBe(400);
    expect((await request(app).post('/jobs/probe/supervision-hold/release').set(auth).send({ reason: 'y'.repeat(501) })).status).toBe(400);
    expect((await request(app).post('/jobs/probe/supervision-hold/release').set(auth).send({ reason: 'ok' })).status).toBe(404);

    // A real mismatch: the two ledgers disagree on a completed result.
    const store = scheduler.getJobSupervisionStore();
    const runId = scheduler.getRunHistory().recordStart({ slug: 'probe', sessionId: 's', trigger: 't', origin: 'instar', runner: 'script', tokens: 0 });
    const attemptId = store.register({ runId, fireId: 'f', slug: 'probe', evidencePolicy: 'p' });
    store.recordResult(attemptId, { result: 'success' });
    scheduler.getRunHistory().recordCompletion({ runId, result: 'failure', error: 'boom' });
    store.holdSlug('probe', 'independent-history-mismatch');

    const refused = await request(app).post('/jobs/probe/supervision-hold/release').set(auth).send({ reason: 'looks fine' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'cause-unsettled', runIds: [runId] });
    const still = await request(app).get('/jobs/probe/supervision-hold').set(auth);
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ slug: 'probe', hold: { reason: 'independent-history-mismatch' }, releases: [] });
  });

  it('releases a hold whose cause is settled and records who and why', async () => {
    const app = server.getApp();
    scheduler.getJobSupervisionStore().holdSlug('other-job', 'contract-violation:missing-result-line');
    const res = await request(app).post('/jobs/other-job/supervision-hold/release').set(auth)
      .send({ reason: 'script fixed in 1.3.1727', by: 'operator' });
    // A self-declared label is ignored: the bearer is the agent's token.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ released: true, slug: 'other-job', releasedBy: 'agent',
      hold: { reason: 'contract-violation:missing-result-line' } });
    const read = await request(app).get('/jobs/other-job/supervision-hold').set(auth);
    expect(read.body.hold).toBeNull();
    expect(read.body.releases).toEqual([expect.objectContaining({
      releasedBy: 'agent', releaseReason: 'script fixed in 1.3.1727', holdReason: 'contract-violation:missing-result-line',
    })]);
  });
});
