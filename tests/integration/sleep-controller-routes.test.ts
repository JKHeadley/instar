/**
 * GET /sleep through the real createRoutes pipeline.
 *  - 503 when the SleepController is not wired.
 *  - 200 with the live verdict (decision + reason + thresholds) when present.
 * This is the "feature is alive" check: the route returns 200, not 503.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SleepController, type SleepInput } from '../../src/monitoring/SleepController.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function ctxWith(stateDir: string, sleepController: SleepController | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    sleepController,
    startTime: new Date(),
  } as unknown as RouteContext;
}

const deepIdle: SleepInput = {
  now: 1_000_000_000_000,
  runningSessions: 0,
  lastInboundAt: 1_000_000_000_000 - 30 * 60_000,
  lastActivityAt: 1_000_000_000_000 - 30 * 60_000,
  holdsLease: false,
  leaseActive: false,
  inflightWork: false,
  nextScheduledJobAt: null,
};

describe('GET /sleep (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/sleep-controller-routes.test.ts' });
  });

  function appWith(sleepController: SleepController | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, sleepController)));
    return app;
  }

  it('returns 503 when the SleepController is not wired', async () => {
    const res = await request(appWith(null)).get('/sleep');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with the live verdict + thresholds when present (feature is alive)', async () => {
    const controller = new SleepController(
      { sample: () => deepIdle },
      { enabled: true, dryRun: true },
    );
    const res = await request(appWith(controller)).get('/sleep');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.verdict.decision).toBe('would-sleep');
    expect(res.body.thresholds.deepIdleMs).toBe(900_000);
    expect(res.body.sleepRequested).toBe(false); // dry-run never arms
  });

  it('surfaces the blocking guard reason when a guard holds the agent awake', async () => {
    const controller = new SleepController(
      { sample: () => ({ ...deepIdle, leaseActive: true, holdsLease: true }) },
      { enabled: true, dryRun: true },
    );
    const res = await request(appWith(controller)).get('/sleep');
    expect(res.status).toBe(200);
    expect(res.body.verdict.decision).toBe('keep-awake');
    expect(res.body.verdict.reason).toMatch(/lease/i);
  });
});
