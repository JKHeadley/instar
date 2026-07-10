/**
 * Integration tests for the Dashboard Live-LLM-Insights routes
 * (docs/specs/dashboard-live-insights.md). Tier-2: the routes over the real HTTP
 * pipeline. Proves the dark→live gate (503 when the engine is null, 200 with an
 * insight payload when wired) and the per-page + status surfaces.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { DashboardInsightEngine, type PageDataSnapshot } from '../../src/monitoring/DashboardInsightEngine.js';
import type { RouteContext } from '../../src/server/routes.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-int-'));

function baseCtx(engine: DashboardInsightEngine | null): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(STATE_DIR), stateDir: STATE_DIR, port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    dashboardInsightEngine: engine,
    startTime: new Date(),
  } as any;
}

function appWith(engine: DashboardInsightEngine | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(baseCtx(engine)));
  return app;
}

const SNAP: PageDataSnapshot = {
  facts: ['Routing is healthy — 12 checks ran.'],
  metrics: [{ label: 'LLM calls (24h)', value: '120' }],
  anomalies: [{ text: 'One check is failing 28%.', severity: 'watch' }],
  updatedAt: Date.now(),
};

function liveEngine(over: { dryRun?: boolean; llm?: string } = {}): DashboardInsightEngine {
  return new DashboardInsightEngine({
    pages: [{ id: 'llm-activity', title: 'LLM Activity', tab: 'llm-activity', collect: () => SNAP }],
    intelligence: over.llm != null ? { evaluate: async () => over.llm! } : null,
    enabled: true,
    dryRun: over.dryRun ?? true,
  });
}

describe('Dashboard Live-Insights routes (integration)', () => {
  it('503s on every route when the engine is dark (null)', async () => {
    const app = appWith(null);
    for (const url of ['/insights', '/insights/status', '/insights/llm-activity']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(503);
      expect(res.body.error).toMatch(/disabled/);
    }
  });

  it('GET /insights returns the per-page strip payload when live', async () => {
    const res = await request(appWith(liveEngine())).get('/insights');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pages)).toBe(true);
    expect(res.body.pages).toHaveLength(1);
    const p = res.body.pages[0];
    expect(p.page).toBe('llm-activity');
    expect(p.headline).toMatch(/failing 28%/);
    expect(p.source).toBe('deterministic'); // dryRun default → the floor renders
    expect(typeof res.body.asOf).toBe('string');
  });

  it('GET /insights/:page returns one page (200) and 404s an unknown page', async () => {
    const app = appWith(liveEngine());
    const ok = await request(app).get('/insights/llm-activity');
    expect(ok.status).toBe(200);
    expect(ok.body.page).toBe('llm-activity');

    const missing = await request(app).get('/insights/nope');
    expect(missing.status).toBe(404);
  });

  it('GET /insights/status reports the posture', async () => {
    const res = await request(appWith(liveEngine())).get('/insights/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, dryRun: true, pageCount: 1 });
  });

  it('with dryRun:false + a provider, the LLM source is rendered', async () => {
    const llm = JSON.stringify({ headline: 'AI headline', insights: [{ text: 'a', severity: 'info' }] });
    const res = await request(appWith(liveEngine({ dryRun: false, llm }))).get('/insights/llm-activity');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('llm');
    expect(res.body.headline).toBe('AI headline');
  });
});
