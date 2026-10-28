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
    expect(triage.body.supervision).toMatchObject({ denominator: 0, decisionCoverage: 0, coverageIncomplete: false,
      rollout: { auditReady: false, cohort: 'off', active: false } });
    const pool = await request(app).get('/jobs/triage?scope=pool').set('Authorization', `Bearer ${token}`);
    expect(pool.status).toBe(200);
    expect(pool.body.supervision.coverageIncomplete).toBe(false);
    expect(pool.body.machines).toHaveLength(1);
  });

  it('retains a prior mesh peer when the coordinator is disabled', async () => {
    const peer = 'm_bbbbbbbbbbbbbbbb';
    const roster = scheduler.getJobSupervisionStore();
    roster.observeMachineMembership([{ machineId: peer, status: 'active' }]);
    try {
      const pool = await request(server.getApp()).get('/jobs/triage?scope=pool')
        .set('Authorization', `Bearer ${token}`);
      expect(pool.status).toBe(200);
      expect(pool.body.supervision).toMatchObject({ coverageIncomplete: true, accuracy: null });
      expect(pool.body.pool.failed).toEqual([]);
    } finally {
      roster.observeMachineMembership([{ machineId: peer, status: 'revoked' }]);
    }
  });

  it('keeps later conversions on sessions while an audited first-wave script runs with zero sessions', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-script-e2e-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const endpoint = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url !== '/decision-quality/grade-pass' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ graded: 0, byRule: {}, cursors: {} }));
    });
    let scriptScheduler: JobScheduler | undefined;
    try {
      await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
      const address = endpoint.address();
      if (!address || typeof address === 'string') throw new Error('endpoint fixture has no port');
      const installed = installBuiltinJobs({ agentStateDir: stateDir, packageRoot: process.cwd(), port: address.port });
      expect(installed.errors).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, 'jobs', 'instar', 'scripts', 'llm-decision-grading.mjs'))).toBe(true);
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
      expect(scriptScheduler.scriptRunnersActiveFor('health-check')).toBe(false);
      expect(scriptScheduler.scriptRunnersActiveFor('correction-class-review-backstop')).toBe(false);
      expect(scriptScheduler.scriptRunnersActiveFor('script-job-supervisor')).toBe(false);
      expect(scriptScheduler.scriptRunnersActiveFor('llm-decision-grading')).toBe(true);
      expect(await scriptScheduler.triggerJob('script-job-supervisor', 'dev-e2e')).toBe('skipped');
      expect(await scriptScheduler.triggerJob('health-check', 'e2e')).toBe('triggered');
      expect(sessions._spawnCount).toBe(1);
      expect(await scriptScheduler.triggerJob('llm-decision-grading', 'e2e')).toBe('triggered');
      const deadline = Date.now() + 10_000;
      while (state.getJobState('llm-decision-grading')?.lastResult === 'pending' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const gradingState = state.getJobState('llm-decision-grading');
      expect(gradingState?.lastResult, gradingState?.lastError).toBe('success');
      expect(sessions._spawnCount).toBe(1);
      expect(scriptScheduler.getRunHistory().query({ slug: 'llm-decision-grading', limit: 1 }).runs[0])
        .toMatchObject({ runner: 'script', result: 'success', tokens: 0 });
      expect(scriptScheduler.getJobSupervisionStore().findByRunId(
        scriptScheduler.getRunHistory().query({ slug: 'llm-decision-grading', limit: 1 }).runs[0].runId,
      )).toMatchObject({ status: 'unchecked', reason: 'triage-dark' });
    } finally {
      scriptScheduler?.stop();
      if (endpoint.listening) await new Promise<void>(resolve => endpoint.close(() => resolve()));
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/e2e/job-cost-lifecycle.test.ts' });
    }
  });
});
