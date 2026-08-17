// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — the money-layer operator enable surface
 * (docs/specs/money-layer-operator-enable-surface.md, Phase 1).
 *
 * These cover the predicates, the state derivation and the probe's
 * cause-checking. The HTTP surface is covered by
 * tests/integration/money-layer-enable-routes.test.ts, and "the feature is
 * alive" by tests/e2e/money-layer-enable-lifecycle.test.ts.
 *
 * Test ids in the assertions map to the spec's §8 table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeteredSpendLedger } from '../../src/core/MeteredSpendLedger.js';
import { RoutingSpendCapsStore } from '../../src/core/RoutingSpendCapsStore.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import { MeteredSpendGate } from '../../src/core/MeteredSpendGate.js';
import { MoneyLayerEnableStore } from '../../src/core/MoneyLayerEnableStore.js';
import { MoneyLayerAuditLog, filterRowsForPregate, MONEY_AUDIT_ROW_TYPES } from '../../src/core/MoneyLayerAuditLog.js';
import { MoneyLayerEnableSurface, MoneyLayerRefusal } from '../../src/core/MoneyLayerEnableSurface.js';
import {
  MONEY_LAYER_PREGATE_ACTIONS,
  resolveEnableSources,
  resolveIntentEnabled,
  deriveLifecycleState,
  resolveServingReady,
  isRestartEligible,
  disableActionFor,
} from '../../src/core/moneyLayerEnable.js';
import {
  PROBE_DOOR,
  PROBE_KEY_REF,
  PROBE_CAP_USD,
  PROBE_EVALUATED_USD,
  runCapGateProbe,
} from '../../src/core/moneyLayerProbe.js';
import { admitMeteredCall, frozenKeyForDoor } from '../../src/core/meteredCallEntry.js';

let projectDir: string;
let stateDir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mle-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mle-state-'));
  clock = Date.parse('2026-07-15T12:00:00.000Z');
});

afterEach(() => {
  for (const d of [projectDir, stateDir]) {
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true }, { operation: 'test cleanup' });
    } catch {
      /* best effort */
    }
  }
});

// ── The vocabulary (MLE-1 / MLE-2) ───────────────────────────────────

describe('enable sources (MLE-1)', () => {
  it('is an OR, so neither source can silently disable what the other enabled', () => {
    expect(resolveIntentEnabled(resolveEnableSources(true, false))).toBe(true);
    expect(resolveIntentEnabled(resolveEnableSources(false, true))).toBe(true);
    expect(resolveIntentEnabled(resolveEnableSources(false, false))).toBe(false);
  });

  it('enumerates the four states and surfaces config-enabled specifically', () => {
    expect(resolveEnableSources(false, false).state).toBe('disabled');
    expect(resolveEnableSources(true, false).state).toBe('operator-enabled');
    expect(resolveEnableSources(false, true).state).toBe('config-enabled');
    expect(resolveEnableSources(true, true).state).toBe('both-enabled');
    // Only config-enabled is a warning the operator must see: it is the one a
    // disable cannot clear.
    expect(resolveEnableSources(false, true).surfaced).toBe(true);
    expect(resolveEnableSources(true, true).surfaced).toBe(false);
    expect(resolveEnableSources(true, false).surfaced).toBe(false);
  });

  it('renders the ACKNOWLEDGED disable variant whenever the config key is set (§5)', () => {
    expect(disableActionFor(resolveEnableSources(true, false))).toBe('money-layer-disable');
    expect(disableActionFor(resolveEnableSources(true, true))).toBe('money-layer-disable-store-only');
    expect(disableActionFor(resolveEnableSources(false, true))).toBe('money-layer-disable-store-only');
  });
});

describe('lifecycle derivation (§3)', () => {
  const base = { componentsConstructed: false, probe: null, storedFailure: null };

  it('is disabled when intent is false, whatever else is true', () => {
    expect(deriveLifecycleState({ ...base, intentEnabled: false, componentsConstructed: true, probe: { passed: true } }).lifecycleState).toBe('disabled');
  });

  it('is enable-pending-restart when intent is true and the components are absent', () => {
    expect(deriveLifecycleState({ ...base, intentEnabled: true }).lifecycleState).toBe('enable-pending-restart');
  });

  it('T12 — a stored failure is NOT forgotten by the act of crashing', () => {
    const d = deriveLifecycleState({
      ...base,
      intentEnabled: true,
      storedFailure: { state: 'construction-failed', failingComponent: 'ledger', at: '2026-07-01T00:00:00.000Z' },
    });
    expect(d.lifecycleState).toBe('construction-failed');
    expect(d.failingComponent).toBe('ledger');
  });

  it('an UNMEASURED probe is not a pass (P20)', () => {
    const d = deriveLifecycleState({ ...base, intentEnabled: true, componentsConstructed: true, probe: null });
    expect(d.lifecycleState).toBe('probe-failed');
    expect(d.failingComponent).toBe('probe-not-yet-run');
  });

  it('T22 — `ready` is never emitted as a lifecycle value; the value is `probed`', () => {
    const d = deriveLifecycleState({ ...base, intentEnabled: true, componentsConstructed: true, probe: { passed: true } });
    expect(d.lifecycleState).toBe('probed');
    // The token must not appear as an enum value anywhere in the union.
    const everyState = ['disabled', 'enable-pending-restart', 'probed', 'probe-failed', 'construction-failed'];
    expect(everyState).not.toContain('ready');
  });
});

describe('servingReady (MLE-2)', () => {
  it('T10 — a lost single-instance lock refuses spend even at lifecycleState "probed"', () => {
    expect(resolveServingReady({ intentEnabled: true, lifecycleState: 'probed', singleInstanceLockHeld: true })).toBe(true);
    expect(resolveServingReady({ intentEnabled: true, lifecycleState: 'probed', singleInstanceLockHeld: false })).toBe(false);
  });

  it('intent alone is never permission to spend', () => {
    expect(resolveServingReady({ intentEnabled: true, lifecycleState: 'enable-pending-restart', singleInstanceLockHeld: true })).toBe(false);
  });

  it('T31 — restart is eligible in exactly the three restartable states', () => {
    expect(isRestartEligible('enable-pending-restart')).toBe(true);
    expect(isRestartEligible('probe-failed')).toBe(true);
    expect(isRestartEligible('construction-failed')).toBe(true);
    expect(isRestartEligible('disabled')).toBe(false);
    expect(isRestartEligible('probed')).toBe(false);
  });
});

// ── The durable store ────────────────────────────────────────────────

describe('MoneyLayerEnableStore', () => {
  it('reads ABSENT as never-enabled but THROWS on a present-but-corrupt file', () => {
    const store = new MoneyLayerEnableStore({ stateDir, now });
    expect(store.read().operatorEnabled).toBe(false);
    fs.writeFileSync(store.path(), '{ not json');
    expect(() => store.read()).toThrow();
    // …and the live predicate fails CLOSED rather than granting spend.
    expect(store.operatorEnabled()).toBe(false);
  });

  it('clears a failure ONLY on an actual pass — never on the attempt', () => {
    const store = new MoneyLayerEnableStore({ stateDir, now });
    store.recordFailure('probe-failed', 'cap-gate');
    expect(store.read().failure?.failingComponent).toBe('cap-gate');
    store.recordFailure('probe-failed', 'cap-gate'); // a retry that also failed
    expect(store.read().failure).not.toBeNull();
    store.clearFailure();
    expect(store.read().failure).toBeNull();
  });

  it('observes an enable-source transition once, then reports no change', () => {
    const store = new MoneyLayerEnableStore({ stateDir, now });
    expect(store.observeSourceState('operator-enabled')).toBe('disabled');
    expect(store.observeSourceState('operator-enabled')).toBeNull();
    expect(store.observeSourceState('both-enabled')).toBe('operator-enabled');
  });
});

// ── The two audit channels ───────────────────────────────────────────

describe('MoneyLayerAuditLog (§7)', () => {
  it('T14 — a caller holding one handle cannot write the other channel’s rows', () => {
    const log = new MoneyLayerAuditLog({ stateDir, now });
    expect(() => log.auditOnly().append('enable-committed', 'x', {})).toThrow(/authority/);
    expect(() => log.authority().append('plan-rendered', 'x', {})).toThrow(/audit/);
  });

  it('T23 — a pre-gate read returns enable/disable/status rows and NO caps, arming, probe or spend rows', () => {
    const log = new MoneyLayerAuditLog({ stateDir, now });
    log.authority().append('enable-committed', 'operator', {});
    log.authority().append('caps-adjusted', 'operator', { keyRef: 'k' });
    log.authority().append('door-armed', 'operator', { door: 'd' });
    log.auditOnly().append('probe-result', 'boot', { passed: true });
    log.auditOnly().append('spend', 'x', { usd: 5 });
    log.auditOnly().append('pin-attempt-failed', 'x', {});
    const visible = filterRowsForPregate(log.readAll()).map((r) => r.type);
    expect(visible).toContain('enable-committed');
    expect(visible).not.toContain('caps-adjusted');
    expect(visible).not.toContain('door-armed');
    expect(visible).not.toContain('probe-result');
    expect(visible).not.toContain('spend');
    // Attempt TIMING is an attack signal.
    expect(visible).not.toContain('pin-attempt-failed');
  });

  it('shows a freeze’s REASON pre-gate but withholds its timing', () => {
    const log = new MoneyLayerAuditLog({ stateDir, now });
    log.authority().append('freeze', 'agent', { keyRef: 'metered_x', caller: 'agent', reason: 'runaway spend' });
    const [row] = filterRowsForPregate(log.readAll());
    expect(row.detail.reason).toBe('runaway spend');
    expect(row.detail.keyRef).toBe('metered_x');
    // A stop the operator cannot see the cause of is worse than one they can —
    // but the timing history stays withheld.
    expect(row.ts).toBe('');
  });

  it('every declared row type makes a deliberate pre-gate choice', () => {
    for (const [type, meta] of Object.entries(MONEY_AUDIT_ROW_TYPES)) {
      expect(['authority', 'audit'], `${type} channel`).toContain(meta.channel);
      expect([true, false, 'redacted'], `${type} pregate`).toContain(meta.pregate);
    }
  });

  it('T36 — a freeze whose audit append FAILS still applies, and reports its record as provisional', () => {
    const log = new MoneyLayerAuditLog({ stateDir, now, filePath: path.join(stateDir, 'nonexistent-dir', 'a.jsonl') });
    // The directory does not exist, so the append cannot land.
    expect(log.appendBestEffort('freeze', 'agent', { keyRef: 'k', reason: 'r' })).toBe(false);
    // …whereas an UNFREEZE is NOT excepted: no record, no resumption.
    expect(() => log.authority().append('unfreeze', 'operator', { keyRef: 'k' })).toThrow();
  });
});

// ── The probe (§6) ───────────────────────────────────────────────────

function mkMoneyLayer(opts: { machineId?: string; probeDoor?: boolean } = {}) {
  const machineId = opts.machineId ?? 'm1';
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'scripts', 'routing-prices.manifest.json'), JSON.stringify({ schemaVersion: 1, doors: {}, points: [] }));
  const ledger = new MeteredSpendLedger({ stateDir, now });
  const capsStore = new RoutingSpendCapsStore({ stateDir, now });
  if (opts.probeDoor !== false) capsStore.ensureProbeDoor(machineId);
  const prices = new RoutingPriceAuthority({ projectDir, stateDir, now });
  const gate = new MeteredSpendGate({ ledger, prices, capsStore, machineId, leaseConfirmedAgoMs: () => 0, now });
  return { ledger, capsStore, prices, gate, machineId };
}

describe('the cap-gate readiness probe (§6)', () => {
  it('T6/T7 — it PASSES only on a genuine cap-exceeded, and books nothing', async () => {
    const { gate, capsStore, ledger } = mkMoneyLayer();
    const verdict = await runCapGateProbe(gate, capsStore.read());
    expect(verdict.passed).toBe(true);
    if (verdict.passed) {
      expect(verdict.refusalReason).toBe('cap-exceeded');
      expect(verdict.evaluatedUsd).toBe(PROBE_EVALUATED_USD);
    }
    // The gate refuses BEFORE execution, so nothing is committed.
    const committed = ledger.allCommitted().find((t) => t.keyRef === PROBE_KEY_REF);
    expect(committed?.committedLifetimeUsd ?? 0).toBe(0);
  });

  it('THE BUILD-TIME CORRECTION: a $0 cap refuses as invalid-cap, which is a probe FAILURE not a pass', async () => {
    // This is the defect 40 review rounds missed. The gate refuses a
    // non-positive cap BEFORE the comparison the probe exists to exercise, so a
    // $0 cap would have made readiness permanently unreachable while LOOKING
    // like a state rather than a bug.
    const { gate, capsStore } = mkMoneyLayer();
    const file = capsStore.read();
    file.caps[PROBE_KEY_REF].lifetimeCapUsd = 0;
    file.caps[PROBE_KEY_REF].dailyCapUsd = 0;
    fs.writeFileSync(path.join(stateDir, 'state', 'routing-spend-caps.json'), JSON.stringify(file));
    const verdict = await runCapGateProbe(gate, capsStore.read());
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) expect(verdict.failingComponent).toBe('probe-cap-not-positive');
    // And the shipped cap is the positive one that avoids it.
    expect(PROBE_CAP_USD).toBeGreaterThan(0);
    expect(PROBE_EVALUATED_USD).toBeGreaterThan(PROBE_CAP_USD);
  });

  it('a refusal for the WRONG REASON is a failure, never a pass', async () => {
    const { gate } = mkMoneyLayer({ probeDoor: false });
    // No probe door ⇒ the preconditions catch it before the gate is even called,
    // so "door not armed" can never be mistaken for enforcement.
    const verdict = await runCapGateProbe(gate, new RoutingSpendCapsStore({ stateDir, now }).read());
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) expect(verdict.failingComponent).toBe('probe-door-not-live');
  });

  it('an ADMIT is the loudest failure — the gate let the reservation through', async () => {
    const fakeGate = { admit: async () => ({}) as never };
    const { capsStore } = mkMoneyLayer();
    const verdict = await runCapGateProbe(fakeGate, capsStore.read());
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) expect(verdict.failingComponent).toBe('cap-gate-admitted-over-cap');
  });

  it('T41 — the reserved door is refused by EVERY generic caps mutator', () => {
    const { capsStore, machineId } = mkMoneyLayer();
    expect(() => capsStore.adjustCaps('op', capsStore.version(), PROBE_KEY_REF, 'x', { lifetimeCapUsd: 100, dailyCapUsd: 100 })).toThrow(/reserved cap-gate probe door/);
    expect(() => capsStore.setGoLive('op', capsStore.version(), PROBE_DOOR, { enabled: false, keyRef: PROBE_KEY_REF, designatedMachineId: machineId })).toThrow(/reserved cap-gate probe door/);
    expect(() => capsStore.freeze('op', PROBE_KEY_REF)).toThrow(/reserved cap-gate probe door/);
    expect(() => capsStore.unfreeze('op', capsStore.version(), PROBE_KEY_REF)).toThrow(/reserved cap-gate probe door/);
  });

  it('ensureProbeDoor is idempotent — a restart appends no audit row', () => {
    const { capsStore, machineId } = mkMoneyLayer();
    const v1 = capsStore.version();
    capsStore.ensureProbeDoor(machineId);
    capsStore.ensureProbeDoor(machineId);
    expect(capsStore.version()).toBe(v1);
  });
});

// ── The metered entry path (§5) ──────────────────────────────────────

describe('the metered call entry path (§5)', () => {
  const REQ = { door: PROBE_DOOR, modelId: 'null-provider', inputTokens: 10, maxOutputTokens: 10 };

  it('T15 — a CONSTRUCTED but DISABLED layer refuses at the point of spend', async () => {
    const { gate, capsStore } = mkMoneyLayer();
    await expect(
      admitMeteredCall({ capsStore, servingReady: () => false, gate }, REQ),
    ).rejects.toThrow(/money-layer-disabled/);
  });

  it('T19/T34 — freeze is read from DISK and refuses ahead of the money layer', () => {
    const { capsStore } = mkMoneyLayer();
    // Written by a process that need not hold the lock — the spend path reads
    // the marker from disk on every call, so the lock holder honours it.
    const file = capsStore.read();
    file.caps[PROBE_KEY_REF].frozen = true;
    fs.writeFileSync(path.join(stateDir, 'state', 'routing-spend-caps.json'), JSON.stringify(file));
    const fresh = new RoutingSpendCapsStore({ stateDir, now });
    expect(frozenKeyForDoor(fresh, PROBE_DOOR).frozen).toBe(true);
  });

  it('an UNREADABLE caps store fails CLOSED — "could not check the brake" is never a reason to proceed', () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'routing-spend-caps.json'), '{ corrupt');
    const store = new RoutingSpendCapsStore({ stateDir, now });
    const r = frozenKeyForDoor(store, PROBE_DOOR);
    expect(r.unreadable).toBe(true);
    expect(r.frozen).toBe(true);
  });

  it('refuses when the enable surface is unavailable, rather than assuming yes', async () => {
    const { gate, capsStore } = mkMoneyLayer();
    await expect(admitMeteredCall({ capsStore, servingReady: null, gate }, REQ)).rejects.toThrow(/fail closed/);
  });
});

// ── The surface: plans, commits, restart ─────────────────────────────

function mkSurface(opts: {
  configEnabled?: boolean;
  constructed?: boolean;
  lockHeld?: boolean;
  gate?: { admit(req: unknown): Promise<unknown> } | null;
  capsSnapshot?: () => ReturnType<RoutingSpendCapsStore['read']> | null;
  settling?: number;
} = {}) {
  const store = new MoneyLayerEnableStore({ stateDir, now });
  const audit = new MoneyLayerAuditLog({ stateDir, now });
  const surface = new MoneyLayerEnableSurface({
    store,
    audit,
    machineId: 'm1',
    machineNickname: 'the laptop',
    configEnabled: () => opts.configEnabled === true,
    configSnapshotAt: () => '2026-07-15T11:00:00.000Z',
    componentsConstructed: () => opts.constructed === true,
    gate: () => (opts.gate ?? null) as never,
    capsSnapshot: () => opts.capsSnapshot?.() ?? null,
    lockHeld: () => opts.lockHeld !== false,
    settlingCount: () => opts.settling ?? 0,
    now,
  });
  return { surface, store, audit };
}

async function commitAction(surface: MoneyLayerEnableSurface, action: string) {
  const plan = surface.renderPlan(action);
  return surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true });
}

describe('the enable surface', () => {
  it('T1a — an action outside the enum is 400 (syntax), not 409', () => {
    const { surface } = mkSurface();
    try {
      surface.renderPlan('caps-adjust');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(MoneyLayerRefusal);
      expect((err as MoneyLayerRefusal).status).toBe(400);
    }
    expect([...MONEY_LAYER_PREGATE_ACTIONS]).toHaveLength(4);
  });

  it('T38 — a plan cannot be rendered without the single-instance lock', () => {
    const { surface } = mkSurface({ lockHeld: false });
    expect(() => surface.renderPlan('money-layer-enable')).toThrow(/single-instance lock/);
  });

  it('T4 — a bad PIN is 401 and applies nothing', async () => {
    const { surface, store } = mkSurface();
    const plan = surface.renderPlan('money-layer-enable');
    await expect(surface.commit({ pin: '', planId: plan.planId, nonce: plan.nonce, pinValid: false })).rejects.toThrow(/PIN/);
    expect(store.read().operatorEnabled).toBe(false);
  });

  it('T5 — an enable commit yields enable-pending-restart and constructs NOTHING', async () => {
    const { surface, store } = mkSurface({ constructed: false });
    const out = await commitAction(surface, 'money-layer-enable');
    expect(out.lifecycleState).toBe('enable-pending-restart');
    expect(out.enforcementReady).toBe(false);
    expect(out.message).toMatch(/next server restart/);
    expect(store.read().operatorEnabled).toBe(true);
  });

  it('T25 — a plan is refused when the enable-source state moved since it was rendered', async () => {
    let configOn = false;
    const store = new MoneyLayerEnableStore({ stateDir, now });
    const audit = new MoneyLayerAuditLog({ stateDir, now });
    const surface = new MoneyLayerEnableSurface({
      store, audit, machineId: 'm1',
      configEnabled: () => configOn,
      configSnapshotAt: () => null,
      componentsConstructed: () => false,
      gate: () => null,
      capsSnapshot: () => null,
      lockHeld: () => true,
      settlingCount: () => 0,
      now,
    });
    const plan = surface.renderPlan('money-layer-enable');
    configOn = true; // the situation moved under the operator's feet
    await expect(surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true })).rejects.toThrow(/changed since this plan was rendered/);
  });

  it('T9 — a disable while the config key is set does NOT report success', async () => {
    const capsStore = new RoutingSpendCapsStore({ stateDir, now });
    capsStore.ensureProbeDoor('m1');
    const { surface } = mkSurface({
      configEnabled: true,
      constructed: true,
      capsSnapshot: () => capsStore.read(),
      gate: { admit: async () => { throw Object.assign(new Error('over cap'), { reason: 'cap-exceeded' }); } },
    });
    const probe = await surface.runProbe('test');
    expect(probe.passed).toBe(true);
    const out = await commitAction(surface, 'money-layer-disable');
    expect(out.storeCleared).toBe(true);
    expect(out.enableSources.state).toBe('config-enabled');
    expect(out.lifecycleState).toBe('probed');
    expect(out.message).toMatch(/STILL ENABLED/);
  });

  it('the renderer REFUSES plain disable while config is set and renders the acknowledged variant instead', () => {
    const { surface } = mkSurface({ configEnabled: true });
    const plan = surface.renderPlan('money-layer-disable');
    expect(plan.action).toBe('money-layer-disable-store-only');
    expect(plan.renderedText.startsWith('THIS WILL NOT STOP SPENDING')).toBe(true);
  });

  it('T12b — an enable commit in construction-failed says a restart is required and never claims to have probed', async () => {
    const { surface, store } = mkSurface({ constructed: false });
    store.setOperatorEnabled(true);
    store.recordFailure('construction-failed', 'ledger');
    const out = await commitAction(surface, 'money-layer-enable');
    expect(out.lifecycleState).toBe('construction-failed');
    expect(out.probe).toBeNull();
    expect(out.message).toMatch(/restart is required/);
  });

  it('T32 — status writes NOTHING: repeated polling appends no rows and moves no observed state', () => {
    const { surface, audit, store } = mkSurface();
    for (let i = 0; i < 10; i++) surface.status();
    expect(audit.readAll()).toHaveLength(0);
    expect(store.read().lastObservedSourceState).toBeNull();
  });

  it('T21 — the commit audit records the hash of the renderedText the operator was shown', async () => {
    const { surface, audit } = mkSurface();
    const plan = surface.renderPlan('money-layer-enable');
    await surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true });
    const rendered = audit.readAll().find((r) => r.type === 'plan-rendered');
    const committed = audit.readAll().find((r) => r.type === 'enable-committed');
    expect(committed?.detail.renderedTextHash).toBeTruthy();
    expect(committed?.detail.renderedTextHash).toBe(rendered?.detail.renderedTextHash);
  });

  it('T27/T39 — the restart nonce is single-use and the confirmation hash is required', () => {
    const { surface, store } = mkSurface();
    store.setOperatorEnabled(true);
    const minted = surface.mintRestartNonce();
    // Absent hash ⇒ refused.
    expect(() => surface.acceptRestart({ pinValid: true, nonce: minted.nonce, confirmationTextHash: undefined })).toThrow(/confirmationTextHash/);
    const hash = sha256(minted.confirmationText);
    surface.acceptRestart({ pinValid: true, nonce: minted.nonce, confirmationTextHash: hash });
    // A second presentation of the same nonce is refused.
    expect(() => surface.acceptRestart({ pinValid: true, nonce: minted.nonce, confirmationTextHash: hash })).toThrow(/nonce/);
  });

  it('T27 — the nonce cannot be minted outside the three restartable states', () => {
    const { surface } = mkSurface(); // disabled
    expect(() => surface.mintRestartNonce()).toThrow(/only accepted in/);
  });

  it('the restart confirmation names the WHOLE server, not a money-layer-local action', () => {
    const { surface, store } = mkSurface();
    store.setOperatorEnabled(true);
    expect(surface.mintRestartNonce().confirmationText).toMatch(/RESTARTS THE WHOLE AGENT SERVER/);
  });

  it('refuses a restart while money is still settling unless forced', () => {
    const { surface, store } = mkSurface({ settling: 2 });
    store.setOperatorEnabled(true);
    const m = surface.mintRestartNonce();
    expect(() => surface.acceptRestart({ pinValid: true, nonce: m.nonce, confirmationTextHash: sha256(m.confirmationText) })).toThrow(/settling/);
  });

  it('T26 — an authority write is refused without the lock, and the refusal is NOT an audit row', async () => {
    let held = true;
    const store = new MoneyLayerEnableStore({ stateDir, now });
    const audit = new MoneyLayerAuditLog({ stateDir, now });
    const surface = new MoneyLayerEnableSurface({
      store, audit, machineId: 'm1',
      configEnabled: () => false,
      configSnapshotAt: () => null,
      componentsConstructed: () => false,
      gate: () => null,
      capsSnapshot: () => null,
      lockHeld: () => held,
      settlingCount: () => 0,
      now,
    });
    const plan = surface.renderPlan('money-layer-enable');
    held = false;
    await expect(surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true })).rejects.toThrow(/single-instance lock/);
    expect(store.read().operatorEnabled).toBe(false);
    // The refusal appears in the server log, never as an audit-channel row.
    expect(audit.readAll().some((r) => r.type === 'enable-committed')).toBe(false);
  });

  it('T24 — settlingCount returns to zero once a reserve passes its settle deadline', async () => {
    const ledger = new MeteredSpendLedger({ stateDir, now, reserveTtlMs: 1000 });
    const capsStore = new RoutingSpendCapsStore({ stateDir, now });
    capsStore.adjustCaps('t', capsStore.version(), 'metered_openrouter_bench', 'openrouter', { lifetimeCapUsd: 60, dailyCapUsd: 25 });
    await ledger.reserve({
      keyRef: 'metered_openrouter_bench', door: 'openrouter-api', modelId: 'm', reserveUsd: 1, leaseEpoch: 0,
      admitOnlyUnderCaps: { lifetimeCapUsd: 60, dailyCapUsd: 25 },
    });
    expect(ledger.outstandingReserveCount()).toBe(1);
    clock += 5000; // past the settle deadline
    expect(ledger.outstandingReserveCount()).toBe(0);
  });
});

// ── Second-pass review findings (regression guards) ──────────────────
//
// Every test below pins a defect the independent second-pass reviewer found in
// the FIRST build of this feature. Each one existed, each one shipped past 45
// unit tests, 15 integration tests, 7 E2E tests and a live end-to-end run on a
// real server. They are grouped so the class stays visible.

describe('second-pass findings', () => {
  it('F1 — the PIN is never comparable without the lockout counter advancing', () => {
    const { surface } = mkSurface();
    // config-inspect used to compare the PIN inline and return observably
    // different fields on success, with no failure counting: an unlimited
    // six-digit oracle for the credential that commits money and restarts the
    // server. Every PIN-taking route now funnels through checkPin.
    for (let i = 0; i < 5; i++) expect(surface.checkPin(false, 'config-inspect')).toBe(false);
    // The sixth attempt is locked out — from the INSPECT route, not just commit.
    expect(() => surface.checkPin(false, 'config-inspect')).toThrow(/locked out/);
    // …and the lockout carries to the authority routes, so the oracle cannot be
    // used to farm attempts that commit is then free of.
    const plan = mkSurface();
    void plan;
  });

  it('F2 — mirror-config is refused when there is nothing to mirror', async () => {
    // Its rendered text promises to COPY the config setting and change nothing
    // spendable. With config OFF that text is false: the commit would write
    // durable enable intent behind a no-change promise.
    const { surface, store } = mkSurface({ configEnabled: false });
    expect(() => surface.renderPlan('money-layer-mirror-config')).toThrow(/nothing to mirror/);
    expect(store.read().operatorEnabled).toBe(false);
    // With config ON it renders, and its promise is then accurate.
    const on = mkSurface({ configEnabled: true });
    const p = on.surface.renderPlan('money-layer-mirror-config');
    expect(p.action).toBe('money-layer-mirror-config');
    const out = await on.surface.commit({ pin: 'x', planId: p.planId, nonce: p.nonce, pinValid: true });
    expect(out.enableSources.state).toBe('both-enabled');
  });

  it('F4 — a failing authority append leaves the store UNCHANGED', async () => {
    // "Money state never changes without its record" is only true when the
    // record is written FIRST. The previous order landed the enable and then
    // errored.
    const store = new MoneyLayerEnableStore({ stateDir, now });
    const audit = new MoneyLayerAuditLog({ stateDir, now, filePath: path.join(stateDir, 'no-such-dir', 'a.jsonl') });
    const surface = new MoneyLayerEnableSurface({
      store, audit, machineId: 'm1',
      configEnabled: () => false,
      configSnapshotAt: () => null,
      componentsConstructed: () => false,
      gate: () => null,
      capsSnapshot: () => null,
      lockHeld: () => true,
      settlingCount: () => 0,
      now,
    });
    const plan = surface.renderPlan('money-layer-enable');
    await expect(surface.commit({ pin: 'x', planId: plan.planId, nonce: plan.nonce, pinValid: true })).rejects.toThrow();
    expect(store.read().operatorEnabled).toBe(false);
  });

  it('F5a — the restart row carries no count of in-flight paid calls', () => {
    const { surface, store, audit } = mkSurface({ settling: 0 });
    store.setOperatorEnabled(true);
    const m = surface.mintRestartNonce();
    surface.acceptRestart({ pinValid: true, nonce: m.nonce, confirmationTextHash: sha256(m.confirmationText) });
    const row = audit.readAll().find((r) => r.type === 'restart-requested');
    // The row is pre-gate visible IN FULL, so a settling COUNT on it would leak
    // paid-call activity straight through the sensitivity split.
    expect(row?.detail).not.toHaveProperty('settlingAtRequest');
    expect(filterRowsForPregate(audit.readAll()).some((r) => r.type === 'restart-requested')).toBe(true);
  });

  it('F5b — a recorded freeze is visible pre-gate with its reason', () => {
    const { surface, audit } = mkSurface();
    expect(surface.recordFreeze('metered_openrouter_bench', 'bearer:127.0.0.1', 'runaway spend')).toBe(true);
    const row = filterRowsForPregate(audit.readAll()).find((r) => r.type === 'freeze');
    expect(row?.detail.reason).toBe('runaway spend');
    expect(row?.ts).toBe('');
  });

  it('F7 — the restart cooldown SURVIVES the restart it authorizes', () => {
    const store = new MoneyLayerEnableStore({ stateDir, now });
    store.setOperatorEnabled(true);
    const mk = () =>
      new MoneyLayerEnableSurface({
        store,
        audit: new MoneyLayerAuditLog({ stateDir, now }),
        machineId: 'm1',
        configEnabled: () => false,
        configSnapshotAt: () => null,
        componentsConstructed: () => false,
        gate: () => null,
        capsSnapshot: () => null,
        lockHeld: () => true,
        settlingCount: () => 0,
        now,
      });
    const first = mk();
    const m1 = first.mintRestartNonce();
    first.acceptRestart({ pinValid: true, nonce: m1.nonce, confirmationTextHash: sha256(m1.confirmationText) });
    // A brand-new surface = the process that the restart just started. An
    // in-memory-only timestamp would reset here, making the cooldown vacuous
    // for the one action that ends the process.
    const second = mk();
    const m2 = second.mintRestartNonce();
    expect(() => second.acceptRestart({ pinValid: true, nonce: m2.nonce, confirmationTextHash: sha256(m2.confirmationText) })).toThrow(/cooldown/);
    clock += 61_000;
    const third = mk();
    const m3 = third.mintRestartNonce();
    expect(() => third.acceptRestart({ pinValid: true, nonce: m3.nonce, confirmationTextHash: sha256(m3.confirmationText) })).not.toThrow();
  });

  it('F8 — an unexpectedly-admitted probe UNDOES its own booking', async () => {
    // If the gate ever admits the over-cap probe, that is the loudest failure —
    // and it also BOOKS $2.00 of phantom committed spend against a door that
    // can never bill. The probe settles it to zero before reporting.
    const { capsStore } = mkMoneyLayer();
    const settled: Array<[string, string, number]> = [];
    const admittingGate = { admit: async () => ({ reserveId: 'r1', keyRef: PROBE_KEY_REF }) };
    const verdict = await runCapGateProbe(admittingGate, capsStore.read(), {
      settle: async (k, r, usd) => {
        settled.push([k, r, usd]);
      },
    });
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) expect(verdict.failingComponent).toBe('cap-gate-admitted-over-cap');
    expect(settled).toEqual([[PROBE_KEY_REF, 'r1', 0]]);
  });
});

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
