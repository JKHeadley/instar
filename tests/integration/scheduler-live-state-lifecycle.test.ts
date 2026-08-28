import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Router } from 'express';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

async function invokePatch(router: Router, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new Readable({
      read() {
        this.push(null);
      },
    }), {
      method: 'PATCH',
      url,
      originalUrl: url,
      headers: {},
      body,
      ip: '127.0.0.1',
    });

    const res = Object.assign(new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }), {
      statusCode: 200,
      locals: {},
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: unknown) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      getHeader() {
        return undefined;
      },
      end() {
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    });

    router.handle(req as never, res as never, err => {
      if (err) reject(err);
    });
  });
}

describe('scheduler live state lifecycle', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let scheduler: JobScheduler;
  let router: Router;
  let jobsFile: string;

  function routeContext(): RouteContext {
    return {
      config: {
        projectName: 'scheduler-live-state-test',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        sessions: {} as never,
        scheduler: {
          jobsFile,
          enabled: true,
          maxParallelJobs: 2,
          quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
        },
      } as never,
      sessionManager: mockSM as never,
      state: project.state,
      scheduler,
      telegram: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      discoveryEvaluator: null,
      tokenLedger: null,
      startTime: new Date(),
    } as unknown as RouteContext;
  }

  beforeEach(() => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([
      {
        slug: 'live-job',
        name: 'Live Job',
        description: 'Proves live scheduler refresh and disable handling',
        schedule: '0 * * * *',
        priority: 'medium',
        expectedDurationMinutes: 5,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'original body' },
      },
    ], null, 2));

    scheduler = new JobScheduler(
      {
        jobsFile,
        enabled: true,
        maxParallelJobs: 2,
        quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      },
      mockSM as any,
      project.state,
      project.stateDir,
    );
    scheduler.start();

    router = createRoutes(routeContext());
  });

  afterEach(async () => {
    scheduler?.stop();
    project.cleanup();
  });

  async function sleep(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  it('PATCH /jobs/:slug updates the live scheduler and blocks the next tick', async () => {
    const res = await invokePatch(router, '/jobs/live-job', { enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(scheduler.getJobs().find(j => j.slug === 'live-job')?.enabled).toBe(false);

    const result = await scheduler.triggerJob('live-job', 'manual');
    expect(result).toBe('skipped');
    expect(mockSM._spawnCount).toBe(0);
  });

  it('PATCH /jobs/:slug disables live scheduled admission before the next tick', async () => {
    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as Array<Record<string, unknown>>;
    jobs[0].schedule = '* * * * * *';
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
    scheduler.refreshJobs();

    const res = await invokePatch(router, '/jobs/live-job', { enabled: false });

    expect(res.status).toBe(200);
    mockSM._spawnCount = 0;
    mockSM._sessions.length = 0;
    mockSM._aliveSet.clear();

    await sleep(1300);
    expect(mockSM._spawnCount).toBe(0);
    expect(scheduler.getJobs().find(j => j.slug === 'live-job')?.enabled).toBe(false);
  });

  it('re-reads a changed job body on the next live trigger without restart', async () => {
    await scheduler.triggerJob('live-job', 'manual');
    await new Promise(r => setTimeout(r, 50));
    expect(mockSM._lastSpawnArgs?.prompt).toContain('original body');

    const firstSession = mockSM._sessions[mockSM._sessions.length - 1];
    firstSession.status = 'completed';
    mockSM._aliveSet.delete(firstSession.tmuxSession);
    project.state.saveSession(firstSession);
    await scheduler.notifyJobComplete(firstSession.id, firstSession.tmuxSession);

    const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8')) as Array<Record<string, unknown>>;
    (jobs[0].execute as { value: string }).value = 'updated body';
    fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));

    const result = await scheduler.triggerJob('live-job', 'manual');
    expect(result).toBe('triggered');
    await new Promise(r => setTimeout(r, 50));
    expect(mockSM._lastSpawnArgs?.prompt).toContain('updated body');
  });
});
