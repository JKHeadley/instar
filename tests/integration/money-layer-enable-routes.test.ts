/**
 * Integration tests — the SIX PRE-GATE routes of the money-layer operator
 * enable surface, over the real Express stack
 * (docs/specs/money-layer-operator-enable-surface.md §2).
 *
 * The single most important property under test is that these routes answer
 * while the money layer is OFF. Every other money route 503s when
 * `routingSpend.money.enabled` is false; these six must not, because they are
 * the door to turning it on. A test suite that only exercised them with the
 * layer already enabled would pass over the entire defect this feature fixes.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { MoneyLayerEnableStore } from '../../src/core/MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog } from '../../src/core/MoneyLayerAuditLog.js';
import { MoneyLayerEnableSurface } from '../../src/core/MoneyLayerEnableSurface.js';
import { RenderedPlanStore } from '../../src/core/RenderedPlanStore.js';

const PIN = '135790';
let projectDir: string;
let stateDir: string;
let restartRequests: string[];

function ctx(opts: { configEnabled?: boolean; lockHeld?: boolean; noSurface?: boolean; restartFails?: boolean } = {}): RouteContext {
  const store = new MoneyLayerEnableStore({ stateDir });
  const audit = new MoneyLayerAuditLog({ stateDir });
  const surface = opts.noSurface
    ? null
    : new MoneyLayerEnableSurface({
        store,
        audit,
        machineId: 'm1',
        machineNickname: 'the laptop',
        configEnabled: () => opts.configEnabled === true,
        configSnapshotAt: () => '2026-07-15T11:00:00.000Z',
        componentsConstructed: () => false,
        gate: () => null,
        capsSnapshot: () => null,
        lockHeld: () => opts.lockHeld !== false,
        settlingCount: () => 0,
      });
  return {
    config: {
      projectName: 'test',
      projectDir,
      stateDir,
      port: 0,
      dashboardPin: PIN,
      developmentAgent: true,
      // The money layer itself is OFF — which is exactly the state these routes must serve.
      routingSpend: { money: { enabled: opts.configEnabled === true } },
      sessions: {} as unknown,
      scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    tokenLedger: null,
    featureMetricsLedger: null,
    routingPriceAuthority: null,
    moneyLayerEnableSurface: surface,
    moneyLayerAudit: audit,
    requestSupervisedRestart: (reason: string) => {
      restartRequests.push(reason);
      return opts.restartFails !== true;
    },
    spendPlanStore: new RenderedPlanStore(),
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
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mler-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mler-state-'));
  restartRequests = [];
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/money-layer-enable-routes.test.ts' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/money-layer-enable-routes.test.ts' });
});

describe('the six routes answer PRE-GATE (the whole point)', () => {
  it('GET /routing-spend/enable-status is 200 with the money layer OFF', async () => {
    const res = await request(appWith(ctx())).get('/routing-spend/enable-status');
    expect(res.status).toBe(200);
    expect(res.body.lifecycleState).toBe('disabled');
    expect(res.body.enforcementReady).toBe(false);
    expect(res.body.enableSources.state).toBe('disabled');
    // T28 — a config-derived claim is never shown without its age.
    expect(res.body.configSnapshotAt).toBe('2026-07-15T11:00:00.000Z');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the full enable → restart-nonce → restart flow works with the layer OFF', async () => {
    const app = appWith(ctx());
    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    expect(plan.status).toBe(200);
    expect(plan.body.action).toBe('money-layer-enable');
    expect(plan.body.machineNickname).toBe('the laptop');
    // The operator approves the SERVER's words — the copy is authored server-side.
    expect(plan.body.renderedText).toMatch(/next server restart/);
    expect(plan.body.renderedText).toMatch(/arms NO paid service/);

    const commit = await request(app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    expect(commit.body.lifecycleState).toBe('enable-pending-restart');
    expect(commit.body.enforcementReady).toBe(false);

    const status = await request(app).get('/routing-spend/enable-status');
    expect(status.body.restartEligible).toBe(true);

    const minted = await request(app).post('/routing-spend/money-layer/restart-nonce').send({});
    expect(minted.status).toBe(200);
    expect(minted.body.confirmationText).toMatch(/RESTARTS THE WHOLE AGENT SERVER/);

    const restart = await request(app)
      .post('/routing-spend/money-layer/restart')
      .send({
        pin: PIN,
        nonce: minted.body.nonce,
        confirmationTextHash: createHash('sha256').update(minted.body.confirmationText).digest('hex'),
      });
    expect(restart.status).toBe(200);
    expect(restart.body.accepted).toBe(true);
    expect(restartRequests).toHaveLength(1);
  });

  it('T18 — GET /routing-spend/caps/log is reachable with the layer disabled and nothing settling', async () => {
    const res = await request(appWith(ctx())).get('/routing-spend/caps/log');
    expect(res.status).toBe(200);
    expect(res.body.filtered).toBe(true);
    expect(res.body.note).toMatch(/restricted view/);
  });
});

describe('the pre-gate allowlist is keyed on the ACTION, not on shape', () => {
  it('T1a — an action outside the enum is 400 (syntax), naming the enum', async () => {
    const res = await request(appWith(ctx())).post('/routing-spend/plan-money-layer').send({ action: 'caps-adjust' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown-action');
    expect(res.body.message).toMatch(/money-layer-enable/);
  });

  it('T1b/T2 — a validly-signed NON-allowlisted plan is 409 at commit and applies nothing', async () => {
    const c = ctx();
    const app = appWith(c);
    // Render a real caps-adjust plan through the OTHER plan store, then present
    // it to the pre-gate commit route. Without the signed-action check this
    // would be accepted, because the action is not in the request body.
    const foreign = (c as unknown as { spendPlanStore: RenderedPlanStore }).spendPlanStore.render(
      'caps-adjust',
      'raise a cap',
      { keyRef: 'metered_openrouter_bench', lifetimeCapUsd: 9999 },
      {},
    );
    const res = await request(app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: PIN, planId: foreign.planId, nonce: foreign.nonce });
    expect(res.status).toBe(409);
    // It is refused before any effect — the plan is unknown to THIS surface.
    expect(res.body.error).toBe('unknown-plan');
    expect(new MoneyLayerEnableStore({ stateDir }).read().operatorEnabled).toBe(false);
  });

  it('T4 — a commit with the wrong PIN is 401 and changes nothing', async () => {
    const app = appWith(ctx());
    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    const res = await request(app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: '000000', planId: plan.body.planId, nonce: plan.body.nonce });
    expect(res.status).toBe(401);
    expect(new MoneyLayerEnableStore({ stateDir }).read().operatorEnabled).toBe(false);
  });

  it('T38 — a plan cannot be rendered without the single-instance lock', async () => {
    const res = await request(appWith(ctx({ lockHeld: false }))).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('lock-not-held');
  });
});

describe('config-inspect (§1)', () => {
  it('T29/T40 — Bearer alone sees ONLY the enable flag; the PIN adds the limits', async () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ routingSpend: { money: { enabled: true, limits: { planRenderPerHour: 3 } } } }));
    const app = appWith(ctx({ configEnabled: false }));

    const bearer = await request(app).post('/routing-spend/config-inspect').send({});
    expect(bearer.status).toBe(200);
    expect(bearer.body.fields.map((f: { path: string }) => f.path)).toEqual(['routingSpend.money.enabled']);
    expect(bearer.body.limitsWithheld).toBeTruthy();
    // The on-disk edit has NOT taken effect in this process, and it says so.
    expect(bearer.body.differs).toBe(true);
    expect(bearer.body.note).toMatch(/NOT an immediate control/);

    const withPin = await request(app).post('/routing-spend/config-inspect').send({ pin: PIN });
    const paths = withPin.body.fields.map((f: { path: string }) => f.path);
    expect(paths).toContain('routingSpend.money.limits.planRenderPerHour');
    expect(withPin.body.limitsWithheld).toBeUndefined();
  });

  it('T30/T35 — it adopts NOTHING: the process snapshot is unchanged after repeated calls', async () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ routingSpend: { money: { enabled: true } } }));
    const c = ctx({ configEnabled: false });
    const app = appWith(c);
    for (let i = 0; i < 3; i++) await request(app).post('/routing-spend/config-inspect').send({});
    // The running process still reads the layer as off — no adoption happened.
    const status = await request(app).get('/routing-spend/enable-status');
    expect(status.body.enableSources.config).toBe(false);
    expect(status.body.lifecycleState).toBe('disabled');
  });
});

describe('the config-enabled hazard (§5)', () => {
  it('T9 — a disable while the config key is set renders the acknowledged variant and does not report success', async () => {
    const app = appWith(ctx({ configEnabled: true }));
    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-disable' });
    expect(plan.body.action).toBe('money-layer-disable-store-only');
    expect(plan.body.renderedText.startsWith('THIS WILL NOT STOP SPENDING')).toBe(true);

    const commit = await request(app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    expect(commit.body.storeCleared).toBe(true);
    expect(commit.body.enableSources.state).toBe('config-enabled');
    expect(commit.body.message).toMatch(/STILL ENABLED/);
    expect(commit.body.message).toMatch(/freeze/i);
  });

  it('T33 — the surface reports config-enabled as a state a disable cannot clear', async () => {
    const res = await request(appWith(ctx({ configEnabled: true }))).get('/routing-spend/enable-status');
    expect(res.body.enableSources.state).toBe('config-enabled');
    expect(res.body.enableSources.surfaced).toBe(true);
  });
});

describe('restart refusals', () => {
  it('T31 — the nonce cannot be minted in `disabled`', async () => {
    const res = await request(appWith(ctx())).post('/routing-spend/money-layer/restart-nonce').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not-restartable');
  });

  it('T39 — a restart without the confirmation hash is refused', async () => {
    const app = appWith(ctx());
    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    await request(app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    const minted = await request(app).post('/routing-spend/money-layer/restart-nonce').send({});
    const res = await request(app).post('/routing-spend/money-layer/restart').send({ pin: PIN, nonce: minted.body.nonce });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('confirmation-hash-mismatch');
    expect(restartRequests).toHaveLength(0);
  });

  it('a restart that cannot be INITIATED is 503 and leaves the state unchanged', async () => {
    const app = appWith(ctx({ restartFails: true }));
    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    await request(app).post('/routing-spend/money-layer/commit').send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    const minted = await request(app).post('/routing-spend/money-layer/restart-nonce').send({});
    const res = await request(app).post('/routing-spend/money-layer/restart').send({
      pin: PIN,
      nonce: minted.body.nonce,
      confirmationTextHash: createHash('sha256').update(minted.body.confirmationText).digest('hex'),
    });
    expect(res.status).toBe(503);
    expect(res.body.accepted).toBe(false);
    const status = await request(app).get('/routing-spend/enable-status');
    expect(status.body.lifecycleState).toBe('enable-pending-restart');
  });
});

describe('honest degradation', () => {
  it('a surface that failed to construct 503s with a reason, never a silent null', async () => {
    const res = await request(appWith(ctx({ noSurface: true }))).get('/routing-spend/enable-status');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('money-layer-surface-unavailable');
  });
});
