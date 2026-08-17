// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * E2E "the feature is alive" + wiring integrity — the money-layer operator
 * enable surface (docs/specs/money-layer-operator-enable-surface.md, Phase 1).
 *
 * This is the Phase-1 alive test the Testing Integrity Standard calls the single
 * most important one for a feature with API routes, and here it carries an
 * unusual burden: EVERY other money route 503s while
 * `routingSpend.money.enabled` is false, so a surface that 503'd in that state
 * would reproduce the exact defect this feature exists to fix — a switch locked
 * inside the room it unlocks. The first assertion below is therefore literally
 * "200, not 503, with the money layer OFF".
 *
 * It then walks the WHOLE lifecycle with REAL collaborators — real durable
 * store, real two-channel audit log, real caps store, real ledger, real price
 * authority, real gate — across a SIMULATED PROCESS RESTART, because the
 * restart is where Phase 1's honesty lives: the commit persists intent and the
 * layer converges on the next boot, and the poll observes the NEW process
 * rather than a record of intent.
 *
 * Wiring integrity: no dep here is a null or a no-op. The probe drives the real
 * MeteredSpendGate against the real ledger, and the enforcement verdict comes
 * from the gate's own refusal reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { MeteredSpendLedger } from '../../src/core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import { MeteredSpendGate } from '../../src/core/MeteredSpendGate.js';
import { MoneyLayerEnableStore } from '../../src/core/MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog } from '../../src/core/MoneyLayerAuditLog.js';
import { MoneyLayerEnableSurface } from '../../src/core/MoneyLayerEnableSurface.js';
import { DEFAULT_METERED_CAPS } from '../../src/core/routingSpendView.js';
import { METERED_ROUTING_DOORS } from '../../src/data/llmBenchCoverage.js';
import { PROBE_DOOR, PROBE_KEY_REF } from '../../src/core/moneyLayerProbe.js';
import { admitMeteredCall } from '../../src/core/meteredCallEntry.js';
import { RenderedPlanStore } from '../../src/core/RenderedPlanStore.js';
import { moneyLayerShouldConstruct } from '../../src/core/moneyLayerEnable.js';

const PIN = '246813';
const MACHINE = 'm1';

let projectDir: string;
let stateDir: string;
let restarts: string[];

/**
 * Mirror the PRODUCTION initialization path in AgentServer: the money layer is
 * constructed ONLY when the flag is on, while the enable surface is constructed
 * ALWAYS. `lockHeld` is a real predicate, not `true`.
 */
function boot(opts: { configEnabled?: boolean; lockHeld?: () => boolean; operatorEnabled?: boolean } = {}) {
  const enableStore = new MoneyLayerEnableStore({ stateDir });
  // Seed the OPERATOR half of MLE-1 when the scenario is "the operator enabled
  // it, then the machine restarted" — the ordinary path to a constructed layer.
  if (opts.operatorEnabled) enableStore.setOperatorEnabled(true);
  const audit = new MoneyLayerAuditLog({ stateDir });

  let ledger: MeteredSpendLedger | null = null;
  let capsStore: RoutingSpendCapsStore | null = null;
  let gate: MeteredSpendGate | null = null;
  let planStore: RenderedPlanStore | null = null;

  // MLE-1 — the construction condition is the OR over BOTH sources, exactly as
  // AgentServer computes it. Deriving it here rather than passing it in is what
  // makes the restart test below a real regression guard: the config key is
  // never set in it, so if construction ever keys on the config key alone, the
  // operator's enable silently never takes effect and the test goes red.
  const constructs = moneyLayerShouldConstruct({
    configEnabled: opts.configEnabled === true,
    operatorEnabled: enableStore.operatorEnabled(),
  });

  if (constructs) {
    ledger = new MeteredSpendLedger({ stateDir });
    capsStore = new RoutingSpendCapsStore({
      stateDir,
      knownKeyRefs: new Set([...Object.keys(DEFAULT_METERED_CAPS), PROBE_KEY_REF]),
      knownDoors: new Set([...METERED_ROUTING_DOORS, PROBE_DOOR] as string[]),
    });
    capsStore.ensureProbeDoor(MACHINE);
    const prices = new RoutingPriceAuthority({ projectDir, stateDir });
    gate = new MeteredSpendGate({ ledger, prices, capsStore, machineId: MACHINE, leaseConfirmedAgoMs: () => 0 });
    planStore = new RenderedPlanStore();
  }

  const surface = new MoneyLayerEnableSurface({
    store: enableStore,
    audit,
    machineId: MACHINE,
    machineNickname: 'the laptop',
    configEnabled: () => opts.configEnabled === true,
    configSnapshotAt: () => new Date().toISOString(),
    componentsConstructed: () => gate !== null && ledger !== null,
    gate: () => gate,
    capsSnapshot: () => {
      try {
        return capsStore?.read() ?? null;
      } catch {
        return null;
      }
    },
    lockHeld: opts.lockHeld ?? (() => true),
    settlingCount: () => ledger?.outstandingReserveCount() ?? 0,
  });

  const ctx = {
    config: {
      projectName: 'test',
      projectDir,
      stateDir,
      port: 0,
      dashboardPin: PIN,
      developmentAgent: true,
      routingSpend: { money: { enabled: opts.configEnabled === true } },
      sessions: {} as unknown,
      scheduler: {} as unknown,
    } as unknown,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    tokenLedger: null,
    featureMetricsLedger: null,
    routingPriceAuthority: null,
    meteredSpendLedger: ledger,
    routingSpendCapsStore: capsStore,
    meteredSpendGate: gate,
    spendPlanStore: planStore,
    moneyLayerEnableSurface: surface,
    moneyLayerAudit: audit,
    requestSupervisedRestart: (reason: string) => {
      restarts.push(reason);
      return true;
    },
    intelligence: null,
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, surface, audit, enableStore, ledger, capsStore, gate };
}

function seedManifest(): void {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({ schemaVersion: 1, version: 1, doors: {}, points: [] }),
  );
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mle-e2e-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mle-e2e-state-'));
  restarts = [];
  seedManifest();
});
afterEach(() => {
  for (const d of [projectDir, stateDir]) {
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/money-layer-enable-lifecycle.test.ts' });
    } catch {
      /* ignore */
    }
  }
});

describe('the money-layer enable surface is ALIVE', () => {
  it('answers 200 — not 503 — with the money layer OFF', async () => {
    const { app } = boot();
    const res = await request(app).get('/routing-spend/enable-status');
    expect(res.status).toBe(200);
    expect(res.body.lifecycleState).toBe('disabled');
    expect(res.body.enforcementReady).toBe(false);

    // …while the ordinary money routes correctly 503 in the same state. That
    // contrast IS the feature.
    const gated = await request(app).post('/routing-spend/plan').send({ action: 'caps-adjust' });
    expect(gated.status).toBe(503);
  });

  it('drives the WHOLE lifecycle across a simulated process restart', async () => {
    // ── Boot 1: money layer OFF. The operator turns it on.
    const first = boot();
    const plan = await request(first.app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-enable' });
    expect(plan.status).toBe(200);

    const commit = await request(first.app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    // Phase 1 does NOT construct hot — and says so rather than reading ready.
    expect(commit.body.lifecycleState).toBe('enable-pending-restart');
    expect(commit.body.enforcementReady).toBe(false);

    const minted = await request(first.app).post('/routing-spend/money-layer/restart-nonce').send({});
    const restart = await request(first.app)
      .post('/routing-spend/money-layer/restart')
      .send({
        pin: PIN,
        nonce: minted.body.nonce,
        confirmationTextHash: createHash('sha256').update(minted.body.confirmationText).digest('hex'),
      });
    expect(restart.status).toBe(200);
    expect(restarts).toHaveLength(1);

    // The `restart requested` row is on disk BEFORE the handoff, so a process
    // that exits mid-restart still records that the operator asked (§4).
    expect(first.audit.readAll().some((r) => r.type === 'restart-requested')).toBe(true);

    // ── Boot 2: the SAME state dir, no config key anywhere — construction must
    // follow from the OPERATOR's persisted flag alone. This is the regression
    // guard for a defect found by driving the flow against a real server: the
    // layer used to construct on the config key only, so the operator's enable
    // promised "it comes up on the next restart" and then never did.
    const second = boot();
    // The operator's decision survived the process boundary.
    expect(second.enableStore.read().operatorEnabled).toBe(true);

    await second.surface.onBoot();

    const status = await request(second.app).get('/routing-spend/enable-status');
    expect(status.status).toBe(200);
    expect(status.body.lifecycleState).toBe('probed');
    // THE assertion: enforcement is ready because the REAL gate refused a REAL
    // over-cap reservation for the REAL reason.
    expect(status.body.enforcementReady).toBe(true);
    expect(status.body.restartEligible).toBe(false);

    // `observed-ready` is written by the NEW process — the only durable proof
    // the restart achieved anything.
    expect(second.audit.readAll().some((r) => r.type === 'restart-observed-ready')).toBe(true);

    // The probe booked nothing.
    const probeTotals = second.ledger?.allCommitted().find((t) => t.keyRef === PROBE_KEY_REF);
    expect(probeTotals?.committedLifetimeUsd ?? 0).toBe(0);
  });

  it('enforcementReady is the SAME predicate the spend path consults, not a proxy', async () => {
    let held = true;
    const { app, surface, capsStore, gate } = boot({ operatorEnabled: true, lockHeld: () => held });
    await surface.onBoot();
    expect((await request(app).get('/routing-spend/enable-status')).body.enforcementReady).toBe(true);

    // Lose the lock. The SURFACE and the SPEND PATH must move together — a
    // surface that could report enforcement-ready while the spend path
    // disagreed is the symbol-not-state failure this feature exists to avoid.
    held = false;
    expect((await request(app).get('/routing-spend/enable-status')).body.enforcementReady).toBe(false);
    await expect(
      admitMeteredCall({ capsStore, servingReady: () => surface.servingReady(), gate }, { door: PROBE_DOOR, modelId: 'null-provider', inputTokens: 1, maxOutputTokens: 1 }),
    ).rejects.toThrow(/money-layer-disabled/);
  });

  it('a DISABLE takes effect on the very next call — disable is real, not cosmetic', async () => {
    const { app, surface, capsStore, gate } = boot({ operatorEnabled: true });
    await surface.onBoot();
    expect(surface.servingReady()).toBe(true);

    const plan = await request(app).post('/routing-spend/plan-money-layer').send({ action: 'money-layer-disable' });
    expect(plan.body.action).toBe('money-layer-disable');
    const commit = await request(app)
      .post('/routing-spend/money-layer/commit')
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.body.storeCleared).toBe(true);

    // The components are STILL constructed — that is the whole hazard — and the
    // call is refused anyway, because the check reads current state.
    expect(gate).not.toBeNull();
    await expect(
      admitMeteredCall({ capsStore, servingReady: () => surface.servingReady(), gate }, { door: PROBE_DOOR, modelId: 'null-provider', inputTokens: 1, maxOutputTokens: 1 }),
    ).rejects.toThrow(/money-layer-disabled/);
  });

  it('T13/T18 — freeze visibility and the audit log survive every state', async () => {
    for (const state of [{}, { operatorEnabled: true }, { configEnabled: true }]) {
      const { app } = boot(state);
      const log = await request(app).get('/routing-spend/caps/log');
      expect(log.status, JSON.stringify(state)).toBe(200);
    }
  });

  it('an IMPOSSIBLE construction reports construction-failed, never "just restart"', async () => {
    // The gate is only built when the price authority exists. When it does not,
    // a restart cannot help — so the surface must NOT report
    // `enable-pending-restart`, which would send the operator round a loop that
    // can never terminate. It names the missing component instead.
    const enableStore = new MoneyLayerEnableStore({ stateDir });
    enableStore.setOperatorEnabled(true);
    const audit = new MoneyLayerAuditLog({ stateDir });
    enableStore.recordFailure('construction-failed', 'routing-price-authority-absent');
    const surface = new MoneyLayerEnableSurface({
      store: enableStore,
      audit,
      machineId: MACHINE,
      configEnabled: () => false,
      configSnapshotAt: () => new Date().toISOString(),
      componentsConstructed: () => false,
      gate: () => null,
      capsSnapshot: () => null,
      lockHeld: () => true,
      settlingCount: () => 0,
    });
    const s = surface.status();
    expect(s.lifecycleState).toBe('construction-failed');
    expect(s.failingComponent).toMatch(/price-authority/);
    // …and the restart route stays OPEN in that state, because a restart is the
    // documented remedy once the dependency is present.
    expect(s.restartEligible).toBe(true);
  });

  it('F3 — an operator-only enable OPENS the money controls, including the emergency freeze', async () => {
    // The second-pass reviewer's highest-impact finding. Construction moved to
    // the MLE-1 OR, but the route gate `moneyOn()` still read the config key
    // alone — so an operator who enabled the layer through the new surface got
    // a machine reporting `enforcementReady: true` while `/routing-spend/plan`,
    // caps adjustment, arming, unfreeze AND THE ADVERTISED EMERGENCY FREEZE all
    // still answered 503. The operator's own switch did not open the controls
    // it exists to open, and the emergency stop was unreachable in exactly the
    // state they had just armed.
    //
    // NOTE the config key is absent throughout: intent comes only from the
    // operator's persisted flag.
    const { app, surface } = boot({ operatorEnabled: true });
    await surface.onBoot();
    expect((await request(app).get('/routing-spend/enable-status')).body.enforcementReady).toBe(true);

    // The emergency stop is reachable — this is the one that must never 503.
    const frozen = await request(app)
      .post('/routing-spend/freeze')
      .send({ keyRef: 'metered_openrouter_bench', reason: 'e2e check' });
    expect(frozen.status).toBe(200);
    expect(frozen.body.frozen).toBe('metered_openrouter_bench');

    // …and the ordinary PIN plan flow is reachable too.
    const plan = await request(app)
      .post('/routing-spend/plan')
      .send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 10, dailyCapUsd: 5 });
    expect(plan.status).toBe(200);

    // F5b — that freeze produced a pre-gate-visible record naming its cause.
    const log = await request(app).get('/routing-spend/caps/log');
    expect(log.status).toBe(200);
    const freezeRow = log.body.moneyLayerEntries.find((r: { type: string }) => r.type === 'freeze');
    expect(freezeRow?.detail?.reason).toBe('e2e check');
  });

  it('WIRING INTEGRITY — no dep is a null or a no-op', async () => {
    const { surface, audit, enableStore, ledger, capsStore, gate } = boot({ operatorEnabled: true });
    expect(ledger).toBeInstanceOf(MeteredSpendLedger);
    expect(capsStore).toBeInstanceOf(RoutingSpendCapsStore);
    expect(gate).toBeInstanceOf(MeteredSpendGate);
    // The probe drives the REAL gate: its verdict carries the gate's own reason.
    const verdict = await surface.runProbe('wiring-test');
    expect(verdict.passed).toBe(true);
    if (verdict.passed) expect(verdict.refusalReason).toBe('cap-exceeded');
    // The audit log is a real file with real rows, not an in-memory stub.
    expect(fs.existsSync(audit.path())).toBe(true);
    expect(audit.readAll().length).toBeGreaterThan(0);
    // The durable store is a real file.
    enableStore.setOperatorEnabled(true);
    expect(fs.existsSync(enableStore.path())).toBe(true);
    expect(JSON.parse(fs.readFileSync(enableStore.path(), 'utf-8')).operatorEnabled).toBe(true);
  });
});
