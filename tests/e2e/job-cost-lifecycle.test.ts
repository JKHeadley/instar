/** Production-shaped scheduler → AgentServer wiring for the job-cost read surfaces. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { installBuiltinJobs } from '../../src/scheduler/InstallBuiltinJobs.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('job-cost production lifecycle', () => {
  let dir: string;
  let server: AgentServer;
  let scheduler: JobScheduler;
  const token = 'e2e-job-cost';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-cost-e2e-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const jobsFile = path.join(stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, '[]');
    const state = new StateManager(stateDir);
    const sessionManager = createMockSessionManager();
    scheduler = new JobScheduler({
      jobsFile, enabled: false, maxParallelJobs: 1,
      quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    }, sessionManager as any, state, stateDir);
    const config: InstarConfig = {
      projectName: 'job-cost-e2e', projectDir: dir, stateDir, port: 0, authToken: token,
    };
    server = new AgentServer({ config, sessionManager: sessionManager as any, state, scheduler });
  });

  afterAll(async () => {
    await server?.stop();
    scheduler?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/job-cost-lifecycle.test.ts' });
  });

  it('serves the real cost report and triage state through authenticated routes', async () => {
    const app = server.getApp();
    expect((await request(app).get('/jobs/cost')).status).toBe(401);
    const cost = await request(app).get('/jobs/cost').set('Authorization', `Bearer ${token}`);
    expect(cost.status).toBe(200);
    expect(cost.body.schemaVersion).toBe(1);
    expect(cost.body.slugs).toEqual([]);
    const triage = await request(app).get('/jobs/triage').set('Authorization', `Bearer ${token}`);
    expect(triage.status).toBe(200);
    expect(triage.body.counts.sessionsSpawned).toBe(0);
  });

  it('installs the shipped health-check script and executes it with zero sessions', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-script-e2e-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const health = http.createServer((req, res) => {
      if (req.url !== '/health' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: { current: 0, max: 4 }, llmReliability: { status: 'ok' }, degradationFeatures: [] }));
    });
    let scriptScheduler: JobScheduler | undefined;
    try {
      await new Promise<void>(resolve => health.listen(0, '127.0.0.1', resolve));
      const address = health.address();
      if (!address || typeof address === 'string') throw new Error('health fixture has no port');
      const installed = installBuiltinJobs({ agentStateDir: stateDir, packageRoot: process.cwd(), port: address.port });
      expect(installed.errors).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, 'jobs', 'instar', 'scripts', 'health-check.mjs'))).toBe(true);
      const jobsFile = path.join(stateDir, 'jobs.json');
      fs.writeFileSync(jobsFile, '[]');
      const state = new StateManager(stateDir);
      const sessions = createMockSessionManager();
      scriptScheduler = new JobScheduler({
        jobsFile, enabled: true, maxParallelJobs: 2, authToken: token,
        projectName: 'job-cost-e2e', port: address.port,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      }, sessions as any, state, stateDir);
      scriptScheduler.setScriptStartOffsetEnabled(false);
      scriptScheduler.setConfigReader(() => ({}));
      scriptScheduler.start();
      expect(await scriptScheduler.triggerJob('script-job-supervisor', 'fleet-e2e')).toBe('skipped');
      expect(sessions._spawnCount).toBe(0);
      expect(scriptScheduler.getRunHistory().query({ slug: 'script-job-supervisor', limit: 1 }).runs).toEqual([]);
      scriptScheduler.setConfigReader(() => ({ developmentAgent: true, jobs: { scriptRunners: { enabled: true, disabledSlugs: [] } } }));
      expect(await scriptScheduler.triggerJob('health-check', 'e2e')).toBe('triggered');
      const deadline = Date.now() + 10_000;
      while (state.getJobState('health-check')?.lastResult === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(state.getJobState('health-check')?.lastResult).toBe('success');
      expect(sessions._spawnCount).toBe(0);
      expect(scriptScheduler.getRunHistory().query({ slug: 'health-check', limit: 1 }).runs[0])
        .toMatchObject({ runner: 'script', result: 'success', tokens: 0 });
    } finally {
      scriptScheduler?.stop();
      if (health.listening) await new Promise<void>(resolve => health.close(() => resolve()));
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/job-cost-lifecycle.test.ts' });
    }
  });
});
