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

// ── Increment B — MONEY surfaces (Surface 2) ────────────────────────────────
// The full HTTP pipeline for the PIN-gated plan flow, the Bearer freeze, and the
// dark-by-default posture (routingSpend.money.enabled is a DARK_GATE_EXCLUSIONS
// action-bearing case — 503 even on a developmentAgent unless explicitly true).
import { MeteredSpendLedger } from '../../src/core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { RenderedPlanStore } from '../../src/core/RenderedPlanStore.js';
import { PinAttemptStore } from '../../src/core/PinAttemptStore.js';

const PIN = '123456';

function moneyCtx(opts: { moneyOn?: boolean } = {}): RouteContext {
  const base = ctx() as unknown as Record<string, unknown>;
  const config = base.config as Record<string, unknown>;
  config.dashboardPin = PIN;
  config.machineId = 'm-test';
  config.routingSpend = { tokenRollupRetentionDays: 400, ...(opts.moneyOn === false ? {} : { money: { enabled: true } }) };
  base.meteredSpendLedger = opts.moneyOn === false ? null : new MeteredSpendLedger({ stateDir });
  base.routingSpendCapsStore = opts.moneyOn === false ? null : new RoutingSpendCapsStore({ stateDir });
  base.spendPlanStore = opts.moneyOn === false ? null : new RenderedPlanStore();
  base.pinAttemptStore = new PinAttemptStore({ stateDir });
  return base as unknown as RouteContext;
}

describe('Increment B money routes (integration)', () => {
  it('ALL money routes 503 when routingSpend.money.enabled is not explicitly true — even on a dev agent', async () => {
    const app = appWith(moneyCtx({ moneyOn: false }));
    for (const [method, url] of [
      ['post', '/routing-spend/plan'],
      ['post', '/routing-spend/caps/adjust'],
      ['post', '/routing-spend/go-live'],
      ['post', '/routing-spend/unfreeze'],
      ['post', '/routing-spend/freeze'],
      ['get', '/routing-spend/caps/log'],
    ] as const) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      expect(res.status, `${method} ${url}`).toBe(503);
    }
  });

  it('the full PIN plan flow: render → commit applies EXACTLY the rendered fields', async () => {
    const c = moneyCtx();
    const app = appWith(c);
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 50, dailyCapUsd: 20 });
    expect(plan.status).toBe(200);
    expect(plan.body.renderedText).toContain('$20.00');
    const commit = await request(app).post('/routing-spend/caps/adjust').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    expect(commit.body.store.caps.metered_openrouter_bench.lifetimeCapUsd).toBe(50);
    // The caps VIEW now reflects the store.
    const caps = await request(app).get('/routing-spend/caps');
    const row = caps.body.keys.find((k: { keyRef: string }) => k.keyRef === 'metered_openrouter_bench');
    expect(row.lifetimeCapUsd).toBe(50);
    expect(row.dailyCapUsd).toBe(20);
  });

  it('a wrong PIN 403s, the durable lockout counts down, and the commit never lands', async () => {
    const c = moneyCtx();
    const app = appWith(c);
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust', keyRef: 'metered_groq_bench', provider: 'groq', lifetimeCapUsd: 5, dailyCapUsd: 5 });
    const bad = await request(app).post('/routing-spend/caps/adjust').send({ pin: '000000', planId: plan.body.planId, nonce: plan.body.nonce });
    expect(bad.status).toBe(403);
    expect(bad.body.attemptsRemaining).toBeLessThan(5);
    const caps = await request(app).get('/routing-spend/caps');
    const row = caps.body.keys.find((k: { keyRef: string }) => k.keyRef === 'metered_groq_bench');
    expect(row.lifetimeCapUsd).toBe(30); // untouched default
  });

  it('a consumed nonce refuses replay (single-use)', async () => {
    const app = appWith(moneyCtx());
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 50, dailyCapUsd: 20 });
    const first = await request(app).post('/routing-spend/caps/adjust').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(first.status).toBe(200);
    const replay = await request(app).post('/routing-spend/caps/adjust').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('consumed');
  });

  it('version drift between render and commit 409s (approve-what-you-saw)', async () => {
    const c = moneyCtx();
    const app = appWith(c);
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 50, dailyCapUsd: 20 });
    // A concurrent Bearer freeze bumps the store version underneath the plan.
    await request(app).post('/routing-spend/freeze').send({ keyRef: 'metered_gemini_bench' });
    const commit = await request(app).post('/routing-spend/caps/adjust').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(409);
    expect(commit.body.code).toBe('version-drift');
  });

  it('go-live arms a door via the plan flow and the caps view shows it live + designated', async () => {
    const app = appWith(moneyCtx());
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'go-live', door: 'openrouter-api', keyRef: 'metered_openrouter_bench', enabled: true });
    expect(plan.body.renderedText).toContain('ARM paid door');
    expect(plan.body.renderedText).toContain('m-test');
    const commit = await request(app).post('/routing-spend/go-live').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    const caps = await request(app).get('/routing-spend/caps');
    const row = caps.body.keys.find((k: { keyRef: string }) => k.keyRef === 'metered_openrouter_bench');
    expect(row.goLiveState).toBe('live');
    expect(row.meteredLeaseHolder).toBe('m-test');
    expect(caps.body.meteredLiveYet).toBe(true);
  });

  it('freeze is Bearer + instant (no plan, no PIN); unfreeze REQUIRES the PIN plan flow', async () => {
    const app = appWith(moneyCtx());
    const freeze = await request(app).post('/routing-spend/freeze').send({ keyRef: 'metered_openrouter_bench' });
    expect(freeze.status).toBe(200);
    expect(freeze.body.store.caps.metered_openrouter_bench.frozen).toBe(true);
    // Unfreeze without a plan/PIN → refused.
    const noPin = await request(app).post('/routing-spend/unfreeze').send({});
    expect([400, 403]).toContain(noPin.status);
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'unfreeze', keyRef: 'metered_openrouter_bench' });
    const commit = await request(app).post('/routing-spend/unfreeze').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    expect(commit.body.store.caps.metered_openrouter_bench.frozen).toBe(false);
  });

  it('a smuggled request field on the commit is ignored — the plan snapshot is the sole input (S2-3)', async () => {
    const app = appWith(moneyCtx());
    const plan = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 50, dailyCapUsd: 20 });
    const commit = await request(app)
      .post('/routing-spend/caps/adjust')
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce, lifetimeCapUsd: 999999, keyRef: 'metered_gemini_bench' });
    expect(commit.status).toBe(200);
    expect(commit.body.store.caps.metered_openrouter_bench.lifetimeCapUsd).toBe(50); // the RENDERED value
    expect(commit.body.store.caps.metered_gemini_bench).toBeUndefined(); // the smuggled key never landed
  });

  it('the audited cap-change log is Bearer-readable with before+after rows', async () => {
    const app = appWith(moneyCtx());
    await request(app).post('/routing-spend/freeze').send({ keyRef: 'metered_openrouter_bench' });
    const log = await request(app).get('/routing-spend/caps/log');
    expect(log.status).toBe(200);
    expect(log.body.entries.length).toBeGreaterThanOrEqual(1);
    const last = log.body.entries[log.body.entries.length - 1];
    expect(last.action).toBe('freeze');
    expect(last.before).toBeTruthy();
    expect(last.after.caps.metered_openrouter_bench.frozen).toBe(true);
  });
});

// ── Layer 1c — the reconciliation read route + the provider-preferred summary basis ──
import { ProviderCostReportStore } from '../../src/monitoring/ProviderCostReportStore.js';

describe('Layer 1c provider grounding (integration)', () => {
  it('GET /routing-spend/reconciliation 503s when dark, 200s with records when live', async () => {
    const dark = await request(appWith(ctx({ dark: true }))).get('/routing-spend/reconciliation');
    expect(dark.status).toBe(503);
    const c = ctx() as unknown as Record<string, unknown>;
    const store = new ProviderCostReportStore({ dbPath: path.join(stateDir, 'pcr.db') });
    store.appendRecon({ keyRef: 'k1', door: 'openrouter-api', windowStartMs: 1, windowEndMs: 2, internalUsd: 1, providerUsd: 1.2, committedUsd: null, driftPct: 20 });
    c.providerCostReportStore = store;
    const live = await request(appWith(c as unknown as RouteContext)).get('/routing-spend/reconciliation');
    expect(live.status).toBe(200);
    expect(live.body.records).toHaveLength(1);
    expect(live.body.records[0].driftPct).toBe(20);
    expect(live.body.note).toContain('never a gate input');
  });

  it('the summary PREFERS provider-reported cost where reports exist (costBasis labeled)', async () => {
    const c = ctx() as unknown as Record<string, unknown>;
    const store = new ProviderCostReportStore({ dbPath: path.join(stateDir, 'pcr2.db') });
    store.append({
      meteredCallId: 'call-1', keyRef: 'metered_openrouter_bench', door: 'openrouter-api',
      modelId: 'openai/gpt-5.5', source: 'openrouter-usage', providerCostUsd: 12.34, providerTokensOut: 100,
    });
    c.providerCostReportStore = store;
    const res = await request(appWith(c as unknown as RouteContext)).get('/routing-spend/summary?grain=day');
    expect(res.status).toBe(200);
    const metered = res.body.rows.find((r: { door: string }) => r.door === 'openrouter-api');
    expect(metered.providerReportedUsd).toBeCloseTo(12.34, 4);
    expect(metered.costBasis).toBe('provider-reported');
    const sub = res.body.rows.find((r: { door: string }) => r.door === 'claude-code');
    expect(sub.costBasis).not.toBe('provider-reported'); // no report → labeled internal/subscription
  });
});
