/**
 * Tier-2 integration tests for the mentor routes (§19.4):
 *   GET  /mentor/status — mode + mentee framework
 *   POST /mentor/tick   — run one heartbeat (disabled by default)
 *
 * Uses supertest + a real MentorOnboardingRunner with fake services, so the
 * route↔runner contract is exercised over the full HTTP pipeline.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import {
  MentorOnboardingRunner,
  DEFAULT_MENTOR_CONFIG,
  type MentorConfig,
  type MentorRunnerServices,
} from '../../src/scheduler/MentorOnboardingRunner.js';

function fakeServices(): MentorRunnerServices {
  return {
    capture: () => ({ runId: 'r', framework: 'codex-cli', findingsCount: 0, observationsWritten: 0, newIssues: 0, regressionCandidates: [] }),
    spawnStageA: async () => 'clean reply',
    runStageBForensics: async () => [],
    isMenteeBusy: () => false,
    minIntervalElapsed: () => true,
    budgetOk: () => true,
    getSurface: (framework) => ({ framework, threadlineHistory: 'hi' }),
  };
}

function appWith(runner: MentorOnboardingRunner | null): express.Express {
  const ctx = {
    config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: runner,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('Mentor routes (integration)', () => {
  it('GET /mentor/status → 503 when runner unavailable', async () => {
    const res = await request(appWith(null)).get('/mentor/status');
    expect(res.status).toBe(503);
  });

  it('GET /mentor/status reflects the (default-off) config', async () => {
    const runner = new MentorOnboardingRunner(fakeServices(), () => ({ ...DEFAULT_MENTOR_CONFIG }));
    const res = await request(appWith(runner)).get('/mentor/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, mode: 'off', menteeFramework: 'codex-cli', inFlight: false });
  });

  it('GET /mentor/status asks the runner for fresh config on each request', async () => {
    let cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG };
    const runner = new MentorOnboardingRunner(fakeServices(), () => cfg);
    const app = appWith(runner);

    expect((await request(app).get('/mentor/status')).body).toMatchObject({ enabled: false, mode: 'off' });

    cfg = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run', menteeFramework: 'cursor' };
    const res = await request(app).get('/mentor/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'dry-run', menteeFramework: 'cursor' });
  });

  it('POST /mentor/tick returns {ran:false, reason:"disabled"} by default (dormant)', async () => {
    const runner = new MentorOnboardingRunner(fakeServices(), () => ({ ...DEFAULT_MENTOR_CONFIG }));
    const res = await request(appWith(runner)).post('/mentor/tick');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: false, reason: 'disabled' });
  });

  it('POST /mentor/tick is fire-and-forget (202) when enabled; result lands in status', async () => {
    const cfg: MentorConfig = { ...DEFAULT_MENTOR_CONFIG, enabled: true, mode: 'dry-run' };
    const runner = new MentorOnboardingRunner(fakeServices(), () => cfg);
    const app = appWith(runner);
    const res = await request(app).post('/mentor/tick');
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // let the async tick settle
    const status = await request(app).get('/mentor/status');
    expect(status.body.lastResult?.ran).toBe(true);
    expect(status.body.lastResult?.mode).toBe('dry-run');
  });
});
