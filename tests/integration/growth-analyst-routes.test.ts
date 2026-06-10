/**
 * Integration tests for the /growth/* routes (Tier-2 of the Testing Integrity
 * Standard): the routes over the real HTTP pipeline via supertest + a minimal
 * RouteContext. Verifies BOTH sides of the gate — 503 when the analyst is absent
 * (ships dark), 200 + real data when it is wired.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { GrowthMilestoneAnalyst, resolveGrowthSettings } from '../../src/monitoring/GrowthMilestoneAnalyst.js';
import type { Initiative, RolloutStage } from '../../src/core/InitiativeTracker.js';

function feat(id: string, stage: RolloutStage): Initiative {
  return { id, title: id, rollout: { flagPath: `monitoring.${id}`, stage } } as unknown as Initiative;
}
function fakeTracker(initiatives: Initiative[]) {
  return { list: () => initiatives, digest: (now: Date) => ({ generatedAt: now.toISOString(), items: [] }) } as any;
}

function baseCtx(extra: Partial<RouteContext> = {}): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    startTime: new Date(),
    ...extra,
  } as any;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gma-routes-')); });

describe('/growth/* (integration)', () => {
  it('503s on every route when the analyst is not wired (ships dark)', async () => {
    const app = appWith(baseCtx({ growthMilestoneAnalyst: null }));
    for (const r of [
      await request(app).get('/growth/digest'),
      await request(app).get('/growth/findings'),
      await request(app).get('/growth/status'),
      await request(app).post('/growth/tick'),
    ]) {
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/GrowthMilestoneAnalyst/);
    }
  });

  it('GET /growth/digest returns 200 + a digest when wired', async () => {
    const analyst = new GrowthMilestoneAnalyst({
      stateDir: tmp,
      settings: resolveGrowthSettings({ enabled: true }),
      tracker: fakeTracker([feat('reaper', 'dark')]),
    });
    const app = appWith(baseCtx({ growthMilestoneAnalyst: analyst }));
    const res = await request(app).get('/growth/digest');
    expect(res.status).toBe(200);
    expect(typeof res.body.calm).toBe('boolean');
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.counts).toBeDefined();
  });

  it('GET /growth/findings + /growth/status return 200 with the expected shape', async () => {
    const analyst = new GrowthMilestoneAnalyst({
      stateDir: tmp,
      settings: resolveGrowthSettings({ enabled: true }),
      tracker: fakeTracker([feat('reaper', 'dry-run')]),
    });
    const app = appWith(baseCtx({ growthMilestoneAnalyst: analyst }));

    const findings = await request(app).get('/growth/findings');
    expect(findings.status).toBe(200);
    expect(Array.isArray(findings.body.findings)).toBe(true);

    const status = await request(app).get('/growth/status');
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.counts).toBeDefined();
  });

  it('POST /growth/tick runs the observe+compute pass and returns the digest', async () => {
    const analyst = new GrowthMilestoneAnalyst({
      stateDir: tmp,
      settings: resolveGrowthSettings({ enabled: true }),
      tracker: fakeTracker([feat('reaper', 'live')]),
    });
    const app = appWith(baseCtx({ growthMilestoneAnalyst: analyst }));
    const res = await request(app).post('/growth/tick');
    expect(res.status).toBe(200);
    expect(res.body.generatedAt).toBeDefined();
    // the tick persisted the stage journal
    expect(fs.existsSync(path.join(tmp, 'state', 'growth-milestone-analyst', 'stage-journal.json'))).toBe(true);
  });
});
