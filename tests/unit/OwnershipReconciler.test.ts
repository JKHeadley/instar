/**
 * WS1.3 — ownership reconcile (MULTI-MACHINE-SEAMLESSNESS-SPEC).
 *
 * The 2026-06-12 live incident: a transfer-back left owner=Mini / pin=Laptop
 * stuck for HOURS (re-placement only fired on an inbound message that delivery
 * never routed), while the closeout reaper attacked the working session every
 * 2 minutes. This suite locks the bounded convergence design:
 *
 *  - cooperative handoff when the owner is alive (transfer → claim; never steal)
 *  - flap debounce + bounded safe point on the owner side
 *  - force-claim ONLY with owner-death evidence + quorum — a timer alone never
 *    steals from a reachable-but-slow owner (round-2 adversarial finding)
 *  - exactly-one-owner across ALL machines' reconcilers (the invariant test)
 *  - dry-run and single-machine strict no-op (spec invariant 6)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOwnershipAction } from '../../src/core/SessionOwnership.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { OwnershipReconciler, type ReconcilerMachineView } from '../../src/core/OwnershipReconciler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── FSM: force-claim transitions ────────────────────────────────────────────

describe('SessionOwnership FSM — force-claim', () => {
  const ctx = (key = 'T1') => ({ sessionKey: key, nonce: 'n', now: 1000 });

  it('takes over an active record at epoch+1 (the fenced takeover)', () => {
    const cur = applyOwnershipAction(null, { type: 'place', machineId: 'm_dead' }, ctx());
    const active = applyOwnershipAction((cur as any).next, { type: 'claim', machineId: 'm_dead' }, ctx());
    const forced = applyOwnershipAction((active as any).next, { type: 'force-claim', machineId: 'm_live' }, ctx());
    expect(forced.ok).toBe(true);
    expect((forced as any).next.ownerMachineId).toBe('m_live');
    expect((forced as any).next.status).toBe('active');
    expect((forced as any).next.ownershipEpoch).toBe((active as any).next.ownershipEpoch + 1);
  });

  it('the fenced-out stale owner cannot advance from its old epoch (clock-proof)', () => {
    const placed = (applyOwnershipAction(null, { type: 'place', machineId: 'm_dead' }, ctx()) as any).next;
    const active = (applyOwnershipAction(placed, { type: 'claim', machineId: 'm_dead' }, ctx()) as any).next;
    const forced = (applyOwnershipAction(active, { type: 'force-claim', machineId: 'm_live' }, ctx()) as any).next;
    // The stale owner attempts a transfer based on its OLD view: the FSM is fed
    // the CURRENT record (forced), where m_dead is no longer the active owner —
    // its release/claim shapes all reject.
    const staleRelease = applyOwnershipAction(forced, { type: 'release', machineId: 'm_dead' }, ctx());
    expect(staleRelease.ok).toBe(false);
    expect((staleRelease as any).reason).toBe('release-not-owner');
  });

  it('rejects force-claiming what you already actively own (masks reconciler bugs)', () => {
    const placed = (applyOwnershipAction(null, { type: 'place', machineId: 'm_a' }, ctx()) as any).next;
    const active = (applyOwnershipAction(placed, { type: 'claim', machineId: 'm_a' }, ctx()) as any).next;
    const self = applyOwnershipAction(active, { type: 'force-claim', machineId: 'm_a' }, ctx());
    expect(self.ok).toBe(false);
    expect((self as any).reason).toBe('force-claim-self');
  });

  it('rejects force-claim on a missing record (use place→claim instead)', () => {
    const r = applyOwnershipAction(null, { type: 'force-claim', machineId: 'm_a' }, ctx());
    expect(r.ok).toBe(false);
    expect((r as any).reason).toBe('no-record');
  });
});

// ── Reconciler harness ───────────────────────────────────────────────────────

interface Sim {
  registry: SessionOwnershipRegistry;
  pinStoreFor: (machineId: string) => TopicPlacementPinStore;
  reconcilerFor: (machineId: string, opts?: Partial<{
    machines: ReconcilerMachineView[];
    busy: boolean;
    dryRun: boolean;
    enabled: boolean;
    now: () => number;
  }>) => OwnershipReconciler;
  placements: Array<{ key: string; reason: string; owner: string }>;
  cleanup: () => void;
}

function makeSim(machines: ReconcilerMachineView[]): Sim {
  const nonces = new Set<string>();
  const registry = new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => nonces.has(k),
    recordNonce: (k) => nonces.add(k),
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws13-sim-'));
  const stores = new Map<string, TopicPlacementPinStore>();
  const placements: Sim['placements'] = [];
  return {
    registry,
    placements,
    pinStoreFor: (machineId) => {
      if (!stores.has(machineId)) {
        stores.set(machineId, new TopicPlacementPinStore({ filePath: path.join(tmp, `${machineId}-pins.json`) }));
      }
      return stores.get(machineId)!;
    },
    reconcilerFor(machineId, opts = {}) {
      return new OwnershipReconciler({
        enabled: () => opts.enabled ?? true,
        dryRun: () => opts.dryRun ?? false,
        selfMachineId: machineId,
        pinStore: this.pinStoreFor(machineId),
        ownership: registry,
        machines: () => opts.machines ?? machines,
        isTopicBusy: () => opts.busy ?? false,
        emitPlacement: (key, r, reason) => placements.push({ key, reason, owner: r.record.ownerMachineId }),
        debounceMs: 0,
        safePointDeadlineMs: 1000,
        deathEvidenceMs: 1000,
        now: opts.now,
      });
    },
    cleanup: () => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/OwnershipReconciler.test.ts cleanup' }),
  };
}

function seedActive(registry: SessionOwnershipRegistry, key: string, owner: string) {
  expect(registry.cas({ type: 'place', machineId: owner }, { sessionKey: key, sender: owner, nonce: `seed-p-${key}` }).ok).toBe(true);
  expect(registry.cas({ type: 'claim', machineId: owner }, { sessionKey: key, sender: owner, nonce: `seed-c-${key}` }).ok).toBe(true);
}

const TWO: ReconcilerMachineView[] = [
  { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
  { machineId: 'm_b', online: true, lastSeenMs: Date.now() },
];

describe('OwnershipReconciler — cooperative convergence', () => {
  it('owner transfers to the pin target; the target claims; record converges (the 13481 fix)', () => {
    const sim = makeSim(TWO);
    seedActive(sim.registry, '13481', 'm_b'); // owner = Mini
    sim.pinStoreFor('m_b').set('13481', 'm_a'); // pin = Laptop (owner machine's pin store — pins replicate via the transfer route writing locally; both machines' stores carry the user's pin)
    sim.pinStoreFor('m_a').set('13481', 'm_a');

    // Owner's tick: cooperative transfer.
    const ownerReport = sim.reconcilerFor('m_b').tick();
    expect(ownerReport.transfers).toBe(1);
    expect(sim.registry.read('13481')!.status).toBe('transferring');

    // Target's tick: claim completes the handoff.
    const targetReport = sim.reconcilerFor('m_a').tick();
    expect(targetReport.claims).toBe(1);
    const rec = sim.registry.read('13481')!;
    expect(rec.status).toBe('active');
    expect(rec.ownerMachineId).toBe('m_a');
    expect(sim.placements.map(p => p.reason)).toEqual(['reconcile-transfer', 'reconcile-claim']);
    sim.cleanup();
  });

  it('flap debounce: a fresh pin does NOT trigger the owner-side transfer', () => {
    const sim = makeSim(TWO);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_b').set('T', 'm_a'); // just set — updatedAt = now
    const rec = new OwnershipReconciler({
      enabled: () => true, dryRun: () => false, selfMachineId: 'm_b',
      pinStore: sim.pinStoreFor('m_b'), ownership: sim.registry,
      machines: () => TWO, isTopicBusy: () => false,
      emitPlacement: () => {}, debounceMs: 60_000, safePointDeadlineMs: 1000, deathEvidenceMs: 1000,
    });
    const report = rec.tick();
    expect(report.transfers).toBe(0);
    expect(report.deferredDebounce).toBe(1);
    expect(sim.registry.read('T')!.status).toBe('active'); // untouched
    sim.cleanup();
  });

  it('bounded safe point: a busy session defers, but never past the deadline', () => {
    const sim = makeSim(TWO);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_b').set('T', 'm_a');
    // Clock base AFTER the pin is stamped (+50ms) so pinAge is deterministically
    // non-negative — the earlier Date.now()-before-set ordering made the debounce
    // branch race the busy branch by a few milliseconds.
    let t = Date.now() + 50;
    const rec = sim.reconcilerFor('m_b', { busy: true, now: () => t });
    // First tick observes the conflict; busy → defer.
    expect(rec.tick().deferredBusy).toBe(1);
    // Still busy past the deadline → transfer anyway (no infinite drain).
    t += 1500;
    expect(rec.tick().transfers).toBe(1);
    sim.cleanup();
  });

  it('adoption: a pin naming me with NO live record → place→claim', () => {
    const sim = makeSim(TWO);
    sim.pinStoreFor('m_a').set('T', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.adoptions).toBeGreaterThanOrEqual(1);
    const rec = sim.registry.read('T')!;
    expect(rec.status).toBe('active');
    expect(rec.ownerMachineId).toBe('m_a');
    sim.cleanup();
  });
});

describe('OwnershipReconciler — force path requires DEATH EVIDENCE, never timers', () => {
  it('a reachable-but-slow owner is never force-claimed (deferredNoEvidence)', () => {
    const sim = makeSim([
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: true, lastSeenMs: Date.now() }, // alive!
    ]);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_a').set('T', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(0);
    expect(report.deferredNoEvidence).toBe(1);
    expect(sim.registry.read('T')!.ownerMachineId).toBe('m_b'); // untouched
    sim.cleanup();
  });

  it('a provably dead owner (offline + last-seen past the bound) IS force-claimed by the pin target', () => {
    const machines: ReconcilerMachineView[] = [
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: false, lastSeenMs: Date.now() - 10_000 }, // dark past bound (1000ms in sim)
    ];
    const sim = makeSim(machines);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_a').set('T', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(1);
    const rec = sim.registry.read('T')!;
    expect(rec.ownerMachineId).toBe('m_a');
    expect(rec.status).toBe('active');
    sim.cleanup();
  });

  it('Phase C — outside the majority partition, NO force-claim even against a dark owner', () => {
    // 5 machines, only 2 online (self + one) → not a quorum (2*2 ≤ 5).
    const machines: ReconcilerMachineView[] = [
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: false, lastSeenMs: Date.now() - 10_000 },
      { machineId: 'm_c', online: false, lastSeenMs: Date.now() - 10_000 },
      { machineId: 'm_d', online: false, lastSeenMs: Date.now() - 10_000 },
      { machineId: 'm_e', online: true, lastSeenMs: Date.now() },
    ];
    const sim = makeSim(machines);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_a').set('T', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(0);
    expect(report.deferredNoEvidence).toBe(1);
    sim.cleanup();
  });
});

describe('OwnershipReconciler — exactly-one-owner invariant (spec invariant 3)', () => {
  it('every machine ticking concurrently over the same shared registry converges to ONE active owner', () => {
    const machines: ReconcilerMachineView[] = [
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_c', online: true, lastSeenMs: Date.now() },
    ];
    const sim = makeSim(machines);
    seedActive(sim.registry, 'T', 'm_c');
    for (const m of machines) sim.pinStoreFor(m.machineId).set('T', 'm_a'); // user pinned to m_a everywhere
    const recs = machines.map((m) => sim.reconcilerFor(m.machineId));
    // Several interleaved rounds — every machine acts on its own view each round.
    for (let round = 0; round < 4; round++) for (const r of recs) r.tick();
    const rec = sim.registry.read('T')!;
    expect(rec.status).toBe('active');
    expect(rec.ownerMachineId).toBe('m_a');
    // Exactly one owner at every step is guaranteed by the CAS epoch fence; the
    // terminal assertion here is convergence to the pinned machine with the
    // record never left in a no-owner state.
    sim.cleanup();
  });
});

describe('OwnershipReconciler — no-op guards (spec invariant 6) and dry-run', () => {
  it('single-machine pool: strict no-op, nothing examined', () => {
    const sim = makeSim([{ machineId: 'm_a', online: true, lastSeenMs: Date.now() }]);
    sim.pinStoreFor('m_a').set('T', 'm_a');
    const report = sim.reconcilerFor('m_a', { machines: [{ machineId: 'm_a', online: true, lastSeenMs: Date.now() }] }).tick();
    expect(report.skipped).toBe('single-machine');
    expect(report.examined).toBe(0);
    sim.cleanup();
  });

  it('disabled flag: strict no-op', () => {
    const sim = makeSim(TWO);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_b').set('T', 'm_a');
    const report = sim.reconcilerFor('m_b', { enabled: false }).tick();
    expect(report.skipped).toBe('disabled');
    sim.cleanup();
  });

  it('dry-run: intended actions are reported, the registry is NEVER touched', () => {
    const sim = makeSim(TWO);
    seedActive(sim.registry, 'T', 'm_b');
    sim.pinStoreFor('m_b').set('T', 'm_a');
    const epochBefore = sim.registry.read('T')!.ownershipEpoch;
    const report = sim.reconcilerFor('m_b', { dryRun: true }).tick();
    expect(report.dryRun).toBe(true);
    expect(report.transfers).toBe(1); // intended
    expect(sim.registry.read('T')!.ownershipEpoch).toBe(epochBefore); // untouched
    expect(sim.placements.length).toBe(0);
    sim.cleanup();
  });
});
