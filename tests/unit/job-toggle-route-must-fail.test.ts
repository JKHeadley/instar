import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Router } from 'express';
import { Readable, Writable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';

async function invoke(router: Router, method: string, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new Readable({
      read() {
        this.push(null);
      },
    }), {
      method,
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

async function invokePatch(router: Router, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return invoke(router, 'PATCH', url, body);
}

async function invokePost(router: Router, url: string, body: unknown): Promise<{ status: number; body: any }> {
  return invoke(router, 'POST', url, body);
}

describe('job toggle route must-fail control', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let router: Router;

  function routeContext(scheduler: RouteContext['scheduler']): RouteContext {
    return {
      config: {
        projectName: 'job-toggle-route-test',
        projectDir: project.dir,
        stateDir: project.stateDir,
        port: 0,
        sessions: {} as never,
        scheduler: {
          jobsFile: path.join(project.stateDir, 'jobs.json'),
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

    const jobsFile = path.join(project.stateDir, 'jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify([
      {
        slug: 'route-job',
        name: 'Route Job',
        description: 'Must-fail control for live scheduler refresh',
        schedule: '0 * * * *',
        priority: 'medium',
        expectedDurationMinutes: 5,
        model: 'haiku',
        enabled: true,
        execute: { type: 'prompt', value: 'body' },
      },
    ], null, 2));

    const scheduler = {
      getJobs: () => [{ slug: 'route-job', enabled: true }],
      refreshJobs: () => { /* live scheduler failed to adopt the change */ },
      getQueue: () => [],
      getNextRunTimes: () => ({}),
      isJobLocal: () => true,
    } as never;

    router = createRoutes(routeContext(scheduler));
  });

  afterEach(async () => {
    project.cleanup();
  });

  it('returns 500 when the live scheduler still reports the old enabled flag', async () => {
    const res = await invokePatch(router, '/jobs/route-job', { enabled: false });

    expect(res.status).toBe(500);
    expect(String(res.body.error)).toContain('live scheduler still reports enabled=true');
  });

  it('returns 409 when direct trigger admission is refused by the live scheduler', async () => {
    router = createRoutes(routeContext({
      getJobs: () => [{ slug: 'route-job', enabled: true }],
      refreshJobs: () => {},
      triggerJob: async () => 'skipped',
      getQueue: () => [],
      getNextRunTimes: () => ({}),
      isJobLocal: () => true,
    } as never));

    const res = await invokePost(router, '/jobs/route-job/trigger', { reason: 'test' });

    expect(res.status).toBe(409);
    expect(res.body.result).toBe('skipped');
    expect(res.body.error).toContain('admission refused');
  });

  it('returns 409 when dashboard manual run admission is refused by the live scheduler', async () => {
    router = createRoutes(routeContext({
      getJobs: () => [{ slug: 'route-job', enabled: true, expectedDurationMinutes: 5 }],
      refreshJobs: () => {},
      triggerJob: async () => 'skipped',
      getQueue: () => [],
      getNextRunTimes: () => ({}),
      isJobLocal: () => true,
    } as never));

    const res = await invokePost(router, '/jobs/route-job/run', {});

    expect(res.status).toBe(409);
    expect(res.body.result).toBe('skipped');
    expect(res.body.error).toContain('admission refused');
  });
});
