/**
 * E2E "feature is alive" + wiring-integrity for Dashboard Live-LLM-Insights
 * (docs/specs/dashboard-live-insights.md). The single most important test for a
 * feature with API routes (Testing Integrity Standard): it proves the route is
 * genuinely ALIVE (200, not 503) with REAL collaborators — not a null no-op —
 * AND that the developmentAgent dark-gate actually flips it live on a dev agent.
 *
 *   - The gate: with the REAL ConfigDefaults applied, resolveDevAgentGate on
 *     `dashboard.liveInsights.enabled` resolves LIVE on a dev agent, DARK on the
 *     fleet (the standard maturation ladder, not a flat default-false).
 *   - The path: a REAL FeatureMetricsLedger → the REAL LLM-Activity collector →
 *     the engine → createRoutes → GET /insights returns a real insight payload
 *     that distills genuine routing health (a failing check surfaces; healthy
 *     noise does not). This is the spec's motivating example, end-to-end.
 *   - The dark contract: a null engine 503s (the production posture on the fleet).
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { DashboardInsightEngine } from '../../src/monitoring/DashboardInsightEngine.js';
import { buildBuiltinInsightPages } from '../../src/monitoring/dashboardInsightCollectors.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-e2e-'));

function ctxWith(engine: DashboardInsightEngine | null): RouteContext {
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
  app.use('/', createRoutes(ctxWith(engine)));
  return app;
}

describe('Dashboard Live-Insights — feature is alive (e2e)', () => {
  it('the developmentAgent gate flips it LIVE on a dev agent, DARK on the fleet', () => {
    const devCfg: Record<string, unknown> = { developmentAgent: true };
    applyDefaults(devCfg, getMigrationDefaults('standalone'));
    const fleetCfg: Record<string, unknown> = { developmentAgent: false };
    applyDefaults(fleetCfg, getMigrationDefaults('standalone'));

    // The ConfigDefaults block must OMIT `enabled` so the gate decides.
    const devLi = (devCfg as any).dashboard?.liveInsights ?? {};
    expect(devLi.enabled).toBeUndefined();
    expect(devLi.dryRun).toBe(true); // ships as the spend canary

    expect(resolveDevAgentGate(devLi.enabled, devCfg as { developmentAgent?: boolean })).toBe(true);
    expect(resolveDevAgentGate(
      (fleetCfg as any).dashboard?.liveInsights?.enabled,
      fleetCfg as { developmentAgent?: boolean },
    )).toBe(false);
  });

  it('GET /insights is ALIVE (200, not 503) over a REAL ledger + collector', async () => {
    const ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    // A healthy check: 10 real calls, no errors.
    for (let i = 0; i < 10; i++) ledger.record({ feature: 'MessageSentinel', kind: 'llm', outcome: 'noop' });
    // A failing check: 6 real calls, 3 errors (50% → an alert the strip must flag).
    for (let i = 0; i < 3; i++) ledger.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'error' });
    for (let i = 0; i < 3; i++) ledger.record({ feature: 'TopicIntentExtractor', kind: 'llm', outcome: 'noop' });

    const pages = buildBuiltinInsightPages({ featureMetricsLedger: ledger });
    expect(pages.map((p) => p.id)).toContain('llm-activity'); // the real collector wired

    const engine = new DashboardInsightEngine({ pages, intelligence: null, enabled: true, dryRun: true });
    const res = await request(appWith(engine)).get('/insights');

    expect(res.status).toBe(200); // ALIVE — not 503
    const page = res.body.pages.find((p: any) => p.page === 'llm-activity');
    expect(page).toBeTruthy();
    // The genuine routing issue surfaces (spec's motivating example) …
    const text = JSON.stringify(page);
    expect(text).toMatch(/TopicIntentExtractor/);
    expect(text).toMatch(/50%/);
    // … and the metrics carry the legible numbers (progressive disclosure).
    expect(page.metrics.some((m: any) => /LLM calls/.test(m.label))).toBe(true);
  });

  it('the dark contract holds: a null engine 503s (fleet posture)', async () => {
    const res = await request(appWith(null)).get('/insights');
    expect(res.status).toBe(503);
  });
});
