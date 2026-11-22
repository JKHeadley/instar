/**
 * job-mode-instructions (docs/specs/job-mode-instructions.md, Change 6): GET /jobs/:slug/job-mode
 * and DELETE /jobs/:slug/job-mode-check through the real AgentServer, auth middleware and scheduler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobModeCheckStore } from '../../src/scheduler/jobModeCheckStore.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('job-mode routes', () => {
  let dir: string;
  let stateDir: string;
  let server: AgentServer;
  let scheduler: JobScheduler;
  const token = 'job-mode-routes-int';
  const auth = { Authorization: `Bearer ${token}` };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobmode-routes-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([{
      slug: 'commitment-detection', name: 'C', description: 'C', schedule: '*/15 * * * *', priority: 'low',
      expectedDurationMinutes: 1, model: 'haiku', enabled: true, execute: { type: 'prompt', value: 'check' },
    }]));
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      developmentAgent: true, scheduler: { instructionsOverrides: { 'user:commitment-detection': 'job-mode' } },
    }));
    const state = new StateManager(stateDir);
    const sessionManager = createMockSessionManager();
    scheduler = new JobScheduler({
      jobsFile, enabled: false, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessionManager as any, state, stateDir);
    scheduler.start();
    const config: InstarConfig = { projectName: 'job-mode-routes', projectDir: dir, stateDir, port: 0, authToken: token };
    server = new AgentServer({ config, sessionManager: sessionManager as any, state, scheduler });
  });

  afterAll(async () => {
    await server?.stop();
    scheduler?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/job-mode-routes.test.ts' });
  });

  it('requires auth, validates the slug, and 404s an unknown job', async () => {
    const app = server.getApp();
    expect((await request(app).get('/jobs/commitment-detection/job-mode')).status).toBe(401);
    expect((await request(app).delete('/jobs/commitment-detection/job-mode-check')).status).toBe(401);
    expect((await request(app).get('/jobs/bad.slug/job-mode').set(auth)).status).toBe(400);
    expect((await request(app).get('/jobs/no-such-job/job-mode').set(auth)).status).toBe(404);
    expect((await request(app).delete('/jobs/no-such-job/job-mode-check').set(auth)).status).toBe(404);
  });

  it('reports the configured mode, and a clear lifts a local suppression', async () => {
    const app = server.getApp();
    const status = await request(app).get('/jobs/commitment-detection/job-mode').set(auth);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: 'job-mode', source: 'override' });

    // Simulate a failed check on this machine.
    const store = new JobModeCheckStore(stateDir);
    const d = await store.decideLaunch('user:commitment-detection', 'v|c');
    await store.recordResult('user:commitment-detection', d.generation, 'v|c', 'fail');
    expect((await request(app).get('/jobs/commitment-detection/job-mode').set(auth)).body.check).toMatchObject({ suppressed: true });

    const cleared = await request(app).delete('/jobs/commitment-detection/job-mode-check').set(auth);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ ok: true, key: 'user:commitment-detection', generation: d.generation + 1 });
    expect((await request(app).get('/jobs/commitment-detection/job-mode').set(auth)).body.check).toMatchObject({ suppressed: false, generation: d.generation + 1 });
  });
});
