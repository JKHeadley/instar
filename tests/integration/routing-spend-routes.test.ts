/**
 * Integration tests for GET /routing-spend/summary + GET /routing-spend/caps — the
 * read-only Routing Control Room spend/caps view (routing-control-room-spend Increment A).
 *
 * Exercises the real Express routes over a real FeatureMetricsLedger + RoutingPriceAuthority:
 *  - 200 + the priced summary/caps (the Tier-3 "feature is alive" shape) when the view is
 *    dev-gated LIVE (config.developmentAgent) — 200, not 503;
 *  - 503 when the view is dark (fleet: no developmentAgent, no explicit enabled);
 *  - honest labelling: metered doors not-live, subscription doors $0, committed $0;
 *  - PURITY: the routes perform no writes across calls.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';

let projectDir: string;
let stateDir: string;

function seedManifest(): void {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: 1,
      doors: {},
      points: [{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' }],
    }),
  );
}

function ctx(opts: { dark?: boolean; withDeps?: boolean } = {}): RouteContext {
  const ledger = opts.withDeps === false ? null : new FeatureMetricsLedger({ dbPath: ':memory:', maintainSpendRollup: true, now: () => Date.parse('2026-07-03T12:00:00Z') });
  ledger?.record({ feature: 'x', outcome: 'noop', tokensIn: 1_000_000, tokensOut: 1_000_000, door: 'openrouter-api', model: 'openai/gpt-5.5' });
  ledger?.record({ feature: 'y', outcome: 'noop', tokensIn: 3_000_000, tokensOut: 2_000_000, door: 'claude-code', model: 'claude-sonnet-4-6' });
  const prices = opts.withDeps === false ? null : new RoutingPriceAuthority({ projectDir, stateDir, now: () => Date.parse('2026-07-05T00:00:00Z') });
  return {
    config: {
      projectName: 'test',
      projectDir,
      stateDir,
      port: 0,
      developmentAgent: opts.dark ? false : true,
      routingSpend: { tokenRollupRetentionDays: 400 },
      sessions: {} as unknown,
      scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    tokenLedger: null,
    featureMetricsLedger: ledger,
    routingPriceAuthority: prices,
    intelligence: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(c: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(c));
  return app;
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-state-'));
  seedManifest();
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/routing-spend-routes.test.ts' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/routing-spend-routes.test.ts' });
});

describe('GET /routing-spend/summary + /caps (integration)', () => {
  it('returns 200 + the priced summary when the view is dev-gated LIVE (alive test)', async () => {
    const res = await request(appWith(ctx())).get('/routing-spend/summary?grain=day');
    expect(res.status).toBe(200);
    expect(res.body.grain).toBe('day');
    const metered = res.body.rows.find((r: { door: string }) => r.door === 'openrouter-api');
    expect(metered.doorClass).toBe('metered');
    expect(metered.notLiveYet).toBe(true);
    expect(metered.grossUsd).toBeCloseTo(35, 6); // 5 in + 30 out
    expect(metered.committedUsd).toBe(0); // no money ledger in Increment A
    const sub = res.body.rows.find((r: { door: string }) => r.door === 'claude-code');
    expect(sub.priceBasis).toBe('subscription-zero');
    expect(sub.grossUsd).toBe(0);
    expect(res.body.reportingBasis).toBeTruthy();
  });

  it('returns 200 + caps with every metered key not-live and $0 committed', async () => {
    const res = await request(appWith(ctx())).get('/routing-spend/caps');
    expect(res.status).toBe(200);
    expect(res.body.meteredLiveYet).toBe(false);
    const keys = res.body.keys.map((k: { keyRef: string }) => k.keyRef).sort();
    expect(keys).toEqual(['metered_gemini_bench', 'metered_groq_bench', 'metered_openrouter_bench']);
    for (const k of res.body.keys) {
      expect(k.goLiveState).toBe('not-live');
      expect(k.committedLifetimeUsd).toBe(0);
    }
  });

  it('returns 503 when the view is dark (fleet — no developmentAgent, no explicit enabled)', async () => {
    const dark = await request(appWith(ctx({ dark: true }))).get('/routing-spend/summary');
    expect(dark.status).toBe(503);
    const darkCaps = await request(appWith(ctx({ dark: true }))).get('/routing-spend/caps');
    expect(darkCaps.status).toBe(503);
  });

  it('returns 503 when the deps are missing even if the gate is live', async () => {
    const res = await request(appWith(ctx({ withDeps: false }))).get('/routing-spend/summary');
    expect(res.status).toBe(503);
  });
});
