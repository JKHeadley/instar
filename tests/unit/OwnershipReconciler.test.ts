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
import { OwnershipApplier } from '../../src/core/OwnershipApplier.js';
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

// ROOT-CAUSE FIX (Finding LA2): the OLD harness shared ONE in-memory ownership store
// across BOTH simulated machines, so a CAS by m_b was instantly visible to m_a with zero
// replication — masking the entire cross-machine stuck-move bug for months (green tests,
// broken in production). This harness gives each machine a SEPARATE store/registry, joined
// ONLY by a shared in-memory journal + a per-machine OwnershipApplier the test PUMPS
// explicitly — the real production topology. A convergence test must `pump()` to replicate.
interface Sim {
  /** Per-machine ownership registry (SEPARATE store each — the real topology). */
  registryFor: (machineId: string) => SessionOwnershipRegistry;
  /** Convenience read of one machine's materialized record. */
  read: (key: string, machineId: string) => ReturnType<SessionOwnershipRegistry['read']>;
  pinStoreFor: (machineId: string) => TopicPlacementPinStore;
  reconcilerFor: (machineId: string, opts?: Partial<{
    machines: ReconcilerMachineView[];
    busy: boolean;
    dryRun: boolean;
    enabled: boolean;
    debounceMs: number;
    now: () => number;
    advisoryPins: Map<number, { preferredMachine: string; hlc: { physical: number; logical: number; node: string } }>;
  }>) => OwnershipReconciler;
  /** Replicate the shared journal → run EVERY machine's applier (the cross-machine sync). */
  pump: () => void;
  /** The shared placement journal (entries carry the emitting machine for the tie-break). */
  journal: Array<{ topic: number; machine: string; data: Record<string, unknown> }>;
  placements: Array<{ key: string; reason: string; owner: string }>;
  cleanup: () => void;
}

function makeSim(machines: ReconcilerMachineView[]): Sim {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws13-sim-'));
  const pinStores = new Map<string, TopicPlacementPinStore>();
  const regs = new Map<string, { reg: SessionOwnershipRegistry; store: InMemorySessionOwnershipStore }>();
  const journal: Sim['journal'] = [];
  const placements: Sim['placements'] = [];
  const knownIds = new Set(machines.map((m) => m.machineId));

  const regFor = (m: string) => {
    if (!regs.has(m)) {
      const store = new InMemorySessionOwnershipStore();
      const nonces = new Set<string>();
      const reg = new SessionOwnershipRegistry({ store, seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
      regs.set(m, { reg, store });
    }
    return regs.get(m)!;
  };
  // A PlacementReader over the shared journal (mirrors CoherenceJournalReader's shape).
  const reader = { query: () => ({ entries: journal.map((e) => ({ topic: e.topic, machine: e.machine, data: e.data })) }) };

  return {
    registryFor: (m) => regFor(m).reg,
    read: (key, m) => regFor(m).reg.read(key),
    journal,
    placements,
    pinStoreFor: (machineId) => {
      if (!pinStores.has(machineId)) {
        pinStores.set(machineId, new TopicPlacementPinStore({ filePath: path.join(tmp, `${machineId}-pins.json`) }));
      }
      return pinStores.get(machineId)!;
    },
    reconcilerFor(machineId, opts = {}) {
      return new OwnershipReconciler({
        enabled: () => opts.enabled ?? true,
        dryRun: () => opts.dryRun ?? false,
        selfMachineId: machineId,
        pinStore: this.pinStoreFor(machineId),
        ...(opts.advisoryPins ? { advisoryPins: () => opts.advisoryPins! } : {}),
        ownership: regFor(machineId).reg, // PER-MACHINE registry (separate store)
        machines: () => opts.machines ?? machines,
        isTopicBusy: () => opts.busy ?? false,
        emitPlacement: (key, r, reason) => {
          placements.push({ key, reason, owner: r.record.ownerMachineId });
          // Model the real emitPlacement → CoherenceJournal → replication: append to the
          // shared journal carrying the handoff fields so a peer's applier can materialize them.
          const rec = r.record as typeof r.record & { status?: string; transferTo?: string; timestamp?: number; drainInFlight?: boolean };
          journal.push({
            topic: Number(key), machine: machineId,
            data: {
              owner: rec.ownerMachineId, epoch: rec.ownershipEpoch, reason: 'reconcile',
              ...(rec.status === 'transferring'
                ? { status: 'transferring', ...(rec.transferTo ? { transferTo: rec.transferTo } : {}), ...(typeof rec.timestamp === 'number' ? { timestamp: rec.timestamp } : {}), ...(rec.drainInFlight ? { drainInFlight: true } : {}) }
                : {}),
            },
          });
        },
        debounceMs: opts.debounceMs ?? 0,
        safePointDeadlineMs: 1000,
        deathEvidenceMs: 1000,
        now: opts.now,
      });
    },
    pump() {
      // Replicate to EVERY known machine (creating its store if untouched) — not just
      // registries already materialized, so a seed reaches a machine before its first tick.
      for (const m of knownIds) {
        new OwnershipApplier({ reader, store: regFor(m).store, selfMachineId: m, knownMachines: () => knownIds }).tick();
      }
    },
    cleanup: () => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/OwnershipReconciler.test.ts cleanup' }),
  };
}

/** Seed an active record on the OWNER's registry, then replicate it to every machine
 *  (emit to the journal + pump) — models a stable, already-replicated active state. */
function seedActive(sim: Sim, key: string, owner: string) {
  const reg = sim.registryFor(owner);
  expect(reg.cas({ type: 'place', machineId: owner }, { sessionKey: key, sender: owner, nonce: `seed-p-${key}` }).ok).toBe(true);
  const claimed = reg.cas({ type: 'claim', machineId: owner }, { sessionKey: key, sender: owner, nonce: `seed-c-${key}` });
  expect(claimed.ok).toBe(true);
  sim.journal.push({ topic: Number(key), machine: owner, data: { owner, epoch: (claimed as { record: { ownershipEpoch: number } }).record.ownershipEpoch, reason: 'placed' } });
  sim.pump();
}

const TWO: ReconcilerMachineView[] = [
  { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
  { machineId: 'm_b', online: true, lastSeenMs: Date.now() },
];

describe('OwnershipReconciler — cooperative convergence', () => {
  it('owner transfers to the pin target; the target claims; record converges (the 13481 fix)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '13481', 'm_b'); // owner = Mini
    sim.pinStoreFor('m_b').set('13481', 'm_a'); // pin = Laptop (owner machine's pin store — pins replicate via the transfer route writing locally; both machines' stores carry the user's pin)
    sim.pinStoreFor('m_a').set('13481', 'm_a');

    // Owner's tick: cooperative transfer (in m_b's OWN store; emits to the journal).
    const ownerReport = sim.reconcilerFor('m_b').tick();
    expect(ownerReport.transfers).toBe(1);
    expect(sim.read('13481', 'm_b')!.status).toBe('transferring');
    // Before replication, m_a has NOT seen the transferring intent (the real topology —
    // the OLD shared-store harness would already show it here, masking the bug).
    expect(sim.read('13481', 'm_a')!.status).toBe('active');

    // Replicate: the transferring placement crosses the journal → m_a's applier materializes it.
    sim.pump();
    expect(sim.read('13481', 'm_a')!.status).toBe('transferring');
    expect(sim.read('13481', 'm_a')!.transferTo).toBe('m_a');

    // Target's tick: claim completes the handoff (in m_a's store), then replicate back.
    const targetReport = sim.reconcilerFor('m_a').tick();
    expect(targetReport.claims).toBe(1);
    sim.pump();

    // BOTH machines converged to active(m_a) — proven across SEPARATE stores joined only
    // by the journal (the production reality the shared-store harness masked).
    for (const m of ['m_a', 'm_b']) {
      const rec = sim.read('13481', m)!;
      expect(rec.status).toBe('active');
      expect(rec.ownerMachineId).toBe('m_a');
    }
    expect(sim.placements.map(p => p.reason)).toEqual(['reconcile-transfer', 'reconcile-claim']);
    sim.cleanup();
  });

  it('flap debounce: a fresh pin does NOT trigger the owner-side transfer', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a'); // just set — updatedAt = now
    const rec = new OwnershipReconciler({
      enabled: () => true, dryRun: () => false, selfMachineId: 'm_b',
      pinStore: sim.pinStoreFor('m_b'), ownership: sim.registryFor('m_b'),
      machines: () => TWO, isTopicBusy: () => false,
      emitPlacement: () => {}, debounceMs: 60_000, safePointDeadlineMs: 1000, deathEvidenceMs: 1000,
    });
    const report = rec.tick();
    expect(report.transfers).toBe(0);
    expect(report.deferredDebounce).toBe(1);
    expect(sim.read('700', 'm_b')!.status).toBe('active'); // untouched
    sim.cleanup();
  });

  it('bounded safe point: a busy session defers, but never past the deadline', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
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
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.adoptions).toBeGreaterThanOrEqual(1);
    const rec = sim.read('700', 'm_a')!;
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
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(0);
    expect(report.deferredNoEvidence).toBe(1);
    expect(sim.read('700', 'm_a')!.ownerMachineId).toBe('m_b'); // untouched
    sim.cleanup();
  });

  it('a provably dead owner (offline + last-seen past the bound) IS force-claimed by the pin target', () => {
    const machines: ReconcilerMachineView[] = [
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: false, lastSeenMs: Date.now() - 10_000 }, // dark past bound (1000ms in sim)
    ];
    const sim = makeSim(machines);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(1);
    const rec = sim.read('700', 'm_a')!;
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
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const report = sim.reconcilerFor('m_a').tick();
    expect(report.forceClaims).toBe(0);
    expect(report.deferredNoEvidence).toBe(1);
    sim.cleanup();
  });
});

describe('OwnershipReconciler — exactly-one-owner invariant (spec invariant 3)', () => {
  it('every machine ticking + replicating (the real topology) converges to ONE active owner', () => {
    const machines: ReconcilerMachineView[] = [
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_c', online: true, lastSeenMs: Date.now() },
    ];
    const sim = makeSim(machines);
    seedActive(sim, '700', 'm_c');
    for (const m of machines) sim.pinStoreFor(m.machineId).set('700', 'm_a'); // user pinned to m_a everywhere
    const recs = machines.map((m) => sim.reconcilerFor(m.machineId));
    // Several interleaved rounds over SEPARATE stores — every machine acts on its own
    // view, then `pump()` replicates the journal so the next round sees peer progress.
    for (let round = 0; round < 5; round++) { for (const r of recs) r.tick(); sim.pump(); }
    // Exactly-one-owner: ALL machines converge to active(m_a), never a no-owner state.
    for (const m of machines) {
      const rec = sim.read('700', m.machineId)!;
      expect(rec.status).toBe('active');
      expect(rec.ownerMachineId).toBe('m_a');
    }
    sim.cleanup();
  });
});

describe('OwnershipReconciler — no-op guards (spec invariant 6) and dry-run', () => {
  it('single-machine pool: strict no-op, nothing examined', () => {
    const sim = makeSim([{ machineId: 'm_a', online: true, lastSeenMs: Date.now() }]);
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const report = sim.reconcilerFor('m_a', { machines: [{ machineId: 'm_a', online: true, lastSeenMs: Date.now() }] }).tick();
    expect(report.skipped).toBe('single-machine');
    expect(report.examined).toBe(0);
    sim.cleanup();
  });

  it('disabled flag: strict no-op', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
    const report = sim.reconcilerFor('m_b', { enabled: false }).tick();
    expect(report.skipped).toBe('disabled');
    sim.cleanup();
  });

  it('dry-run: intended actions are reported, the registry is NEVER touched', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
    const epochBefore = sim.read('700', 'm_b')!.ownershipEpoch;
    const report = sim.reconcilerFor('m_b', { dryRun: true }).tick();
    expect(report.dryRun).toBe(true);
    expect(report.transfers).toBe(1); // intended
    expect(sim.read('700', 'm_b')!.ownershipEpoch).toBe(epochBefore); // untouched
    expect(sim.placements.length).toBe(0);
    sim.cleanup();
  });
});

describe('OwnershipReconciler — WS1.2 drain-grace (transferring-to-me claims)', () => {
  it('holds the claim on a FRESH drain-flow record (the owner is still draining), then claims past the grace', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    // The owner's drain runner set transferring with drain provenance just now.
    const t = sim.registryFor('m_a').cas({ type: 'transfer', to: 'm_a', drain: true }, { sessionKey: '700', sender: 'm_b', nonce: 'd1' });
    expect(t.ok).toBe(true);
    expect(sim.read('700', 'm_a')!.drainInFlight).toBe(true);
    const recAt = sim.read('700', 'm_a')!.timestamp;

    // Fresh (within grace): the target reconciler DEFERS — no front-run of the live drain.
    let simNow = recAt + 1_000;
    const early = sim.reconcilerFor('m_a', { now: () => simNow }).tick();
    expect(early.claims).toBe(0);
    expect(sim.read('700', 'm_a')!.status).toBe('transferring');

    // Past the grace (owner died mid-drain): the backstop claim completes the handoff.
    simNow = recAt + 46_000;
    const late = sim.reconcilerFor('m_a', { now: () => simNow }).tick();
    expect(late.claims).toBe(1);
    expect(sim.read('700', 'm_a')!).toMatchObject({ status: 'active', ownerMachineId: 'm_a' });
    sim.cleanup();
  });

  it('a reconciler-cooperative transferring record (no drain provenance) is claimed promptly — WS1.3 unchanged', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    const t = sim.registryFor('m_a').cas({ type: 'transfer', to: 'm_a' }, { sessionKey: '700', sender: 'm_b', nonce: 'c1' });
    expect(t.ok).toBe(true);
    const recAt = sim.read('700', 'm_a')!.timestamp;
    // Immediately (well inside what would be the drain grace): claims anyway.
    const rep = sim.reconcilerFor('m_a', { now: () => recAt + 1_000 }).tick();
    expect(rep.claims).toBe(1);
    expect(sim.read('700', 'm_a')!).toMatchObject({ status: 'active', ownerMachineId: 'm_a' });
    sim.cleanup();
  });
});

describe('OwnershipReconciler — advisory replicated pin (Fix #2 / N3)', () => {
  const hlc = (physical: number, node = 'm_a') => ({ physical, logical: 0, node });

  it('the OWNER transfers on an ADVISORY replicated pin even with NO local pin (the core #2 fix)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b'); // m_b owns it
    // No LOCAL pin on m_b (the real bug: the pin was set on the lease-holder, not the owner).
    // The replicated advisory pin (700 → m_a) is how m_b learns it is pinned away.
    const advisory = new Map([[700, { preferredMachine: 'm_a', hlc: hlc(1000) }]]);
    const rep = sim.reconcilerFor('m_b', { advisoryPins: advisory }).tick();
    expect(rep.transfers).toBe(1);
    expect(sim.read('700', 'm_b')!.status).toBe('transferring');
    expect(sim.read('700', 'm_b')!.transferTo).toBe('m_a');
    sim.cleanup();
  });

  it('N3: a FRESHER advisory pin masks a STALE local self-pin (no stuck-move recurrence)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    const T = Date.now();
    // m_b has a STALE local self-pin (700 → m_b) with an OLD HLC (a prior, abandoned move).
    sim.pinStoreFor('m_b').set('700', 'm_b', true, { physical: T - 100_000, logical: 0, node: 'm_b' });
    // The CURRENT move-intent (700 → m_a) arrives via replication with a newer HLC (~now).
    const advisory = new Map([[700, { preferredMachine: 'm_a', hlc: hlc(T - 1_000, 'm_a') }]]);
    const rep = sim.reconcilerFor('m_b', { advisoryPins: advisory, now: () => T }).tick();
    expect(rep.transfers).toBe(1); // the fresher replicated intent wins → m_b transfers to m_a
    expect(sim.read('700', 'm_b')!.transferTo).toBe('m_a');
    sim.cleanup();
  });

  it('an advisory pin toward an OFFLINE target is IGNORED (no transfer to a dead machine)', () => {
    const sim = makeSim([
      { machineId: 'm_a', online: false, lastSeenMs: Date.now() - 10_000 }, // target OFFLINE
      { machineId: 'm_b', online: true, lastSeenMs: Date.now() },
    ]);
    seedActive(sim, '700', 'm_b');
    const advisory = new Map([[700, { preferredMachine: 'm_a', hlc: hlc(1000) }]]);
    const rep = sim.reconcilerFor('m_b', { advisoryPins: advisory }).tick();
    expect(rep.transfers).toBe(0); // m_a offline → the advisory move-intent is not acted on
    expect(sim.read('700', 'm_b')!.status).toBe('active');
    sim.cleanup();
  });

  it('a STALE advisory pin does NOT override a FRESHER local pin (local wins when newer)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_b'); // fresh local self-pin (already converged: owner==pin)
    const localHlcPhysical = Date.parse(sim.pinStoreFor('m_b').get('700')!.updatedAt);
    const advisory = new Map([[700, { preferredMachine: 'm_a', hlc: hlc(localHlcPhysical - 60_000) }]]); // OLDER
    const rep = sim.reconcilerFor('m_b', { advisoryPins: advisory }).tick();
    expect(rep.transfers).toBe(0); // local pin (700 → m_b) is newer → converged, no transfer
    expect(sim.read('700', 'm_b')!.status).toBe('active');
    sim.cleanup();
  });
});

describe('OwnershipReconciler — stuck-transferring recovery (Fix #3 / N4)', () => {
  it('aborts a transfer whose target went OFFLINE past the deadline → back to active(source)', () => {
    const sim = makeSim([
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: false, lastSeenMs: Date.now() - 10_000 }, // target is dark
    ]);
    seedActive(sim, '700', 'm_a');                 // m_a owns it
    sim.pinStoreFor('m_a').set('700', 'm_b');       // pinned to (now-dead) m_b
    // m_a started the cooperative transfer toward m_b, then m_b went offline.
    const t = sim.registryFor('m_a').cas({ type: 'transfer', to: 'm_b' }, { sessionKey: '700', sender: 'm_a', nonce: 'tr1' });
    expect(t.ok).toBe(true);
    expect(sim.read('700', 'm_a')!.status).toBe('transferring');
    const recAt = sim.read('700', 'm_a')!.timestamp;

    // Within the deadline: still in flight, no abort (don't yank a transfer prematurely).
    const early = sim.reconcilerFor('m_a', { now: () => recAt + 1_000 }).tick();
    expect(early.aborts).toBe(0);
    expect(sim.read('700', 'm_a')!.status).toBe('transferring');

    // Past the deadline with the target still unreachable → abort back to active(m_a).
    const late = sim.reconcilerFor('m_a', { now: () => recAt + 130_000 }).tick();
    expect(late.aborts).toBe(1);
    expect(sim.read('700', 'm_a')!).toMatchObject({ status: 'active', ownerMachineId: 'm_a' });
    sim.cleanup();
  });

  it('does NOT abort while the target is still ONLINE (let the cooperative handoff complete)', () => {
    const sim = makeSim([
      { machineId: 'm_a', online: true, lastSeenMs: Date.now() },
      { machineId: 'm_b', online: true, lastSeenMs: Date.now() }, // target alive
    ]);
    seedActive(sim, '700', 'm_a');
    sim.pinStoreFor('m_a').set('700', 'm_b');
    const t = sim.registryFor('m_a').cas({ type: 'transfer', to: 'm_b' }, { sessionKey: '700', sender: 'm_a', nonce: 'tr2' });
    const recAt = sim.read('700', 'm_a')!.timestamp;
    const rep = sim.reconcilerFor('m_a', { now: () => recAt + 130_000 }).tick(); // well past deadline
    expect(rep.aborts).toBe(0); // target online → never abort; wait for it to claim
    expect(sim.read('700', 'm_a')!.status).toBe('transferring');
    sim.cleanup();
  });
});

describe('OwnershipReconciler — observability (explainTopic / status)', () => {
  it('explainTopic: "transfer" — I am the owner, pin names the other machine (the 28730 case)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '28730', 'm_b');      // Mini owns it
    sim.pinStoreFor('m_b').set('28730', 'm_a');    // pinned to Laptop, on the OWNER's store
    const ex = sim.reconcilerFor('m_b').explainTopic('28730');
    expect(ex.decision).toBe('transfer');
    expect(ex.owner).toBe('m_b');
    expect(ex.preferredMachine).toBe('m_a');
    expect(ex.machinesCount).toBe(2);
    sim.cleanup();
  });

  it('explainTopic: "no-pin" when this machine has no local pin (the real Laptop↔Mini gap)', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '28730', 'm_b');      // Mini owns it
    // NO pin in m_b's store (pin only lives on the Laptop) → the owner can't see "move me away".
    const ex = sim.reconcilerFor('m_b').explainTopic('28730');
    expect(ex.decision).toBe('no-pin');
    sim.cleanup();
  });

  it('explainTopic: "deferred-no-evidence" — pin names me but the live owner is elsewhere', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');           // m_b owns
    sim.pinStoreFor('m_a').set('700', 'm_a');         // pin names m_a, evaluated on m_a
    const ex = sim.reconcilerFor('m_a').explainTopic('700');
    expect(ex.decision).toBe('deferred-no-evidence'); // m_b is online → never steal
    sim.cleanup();
  });

  it('explainTopic: "converged" when owner == pin target active', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_a');
    sim.pinStoreFor('m_a').set('700', 'm_a');
    expect(sim.reconcilerFor('m_a').explainTopic('700').decision).toBe('converged');
    sim.cleanup();
  });

  it('explainTopic: "skipped" single-machine when machines() < 2', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
    const ex = sim.reconcilerFor('m_b', { machines: [{ machineId: 'm_b', online: true, lastSeenMs: Date.now() }] }).explainTopic('700');
    expect(ex.decision).toBe('skipped');
    sim.cleanup();
  });

  it('explainTopic parity with tick(): a "transfer" decision means tick() actually transfers', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
    const rec = sim.reconcilerFor('m_b');
    expect(rec.explainTopic('700').decision).toBe('transfer');
    expect(rec.tick().transfers).toBe(1); // the explanation matched the action
    sim.cleanup();
  });

  it('status(): reflects the last tick report + machine count', () => {
    const sim = makeSim(TWO);
    seedActive(sim, '700', 'm_b');
    sim.pinStoreFor('m_b').set('700', 'm_a');
    const rec = sim.reconcilerFor('m_b');
    expect(rec.status().lastReport).toBeNull(); // no tick yet
    rec.tick();
    const st = rec.status();
    expect(st.enabled).toBe(true);
    expect(st.dryRun).toBe(false);
    expect(st.machinesCount).toBe(2);
    expect(st.lastReport?.transfers).toBe(1);
    expect(st.lastTickAt).not.toBeNull();
    sim.cleanup();
  });
});
