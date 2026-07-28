// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * U4.1 — Pin Persistence: the RECONCILER-side actuation gates
 * (docs/specs/u4-1-pin-persistence.md §2D/§2E, Tier 1).
 *
 * Spec-named tests:
 *  - case-a-transfer-not-initiated-toward-offline-target (R-r2-2): a LOCAL pin
 *    to an offline machine produces ZERO transfer/abort churn cycles across
 *    many ticks — `pinState: pending`, never the silent every-2.5min N4 loop.
 *  - pending-pin-fulfilment-requires-sustained-online (§2E i, Case-D adopt
 *    half; the placement half lives in PlacementExecutor.test.ts).
 *  - pin-driven-move-defers-on-live-autonomous-run-no-deadline-override (§2E iii).
 *  - replay-is-bounded-and-paced (§2D): move-initiations per tick are bounded
 *    by ws13MaxMovesPerTick; EXTENDED per §2E with the offline-target arm.
 *  - aged-pending-pin-raises-one-deduped-attention-item (§2E ii — covers BOTH
 *    the placement-side and the owner-side Case-A pending; one item per
 *    EPISODE, re-raised only when a NEW episode opens).
 *  - placement-read state derivation (§2D): pinStateOf reports actuated |
 *    pending | diverged and tolerates the U4.2 joint value
 *    `suspended-pending-owner-return` from day one (R-r3-4).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { OwnershipReconciler, type ReconcilerMachineView, type ReconcileTickReport } from '../../src/core/OwnershipReconciler.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = 1_700_000_000_000;
const SELF = 'm_a';
const PEER = 'm_b';

interface Rig {
  reg: SessionOwnershipRegistry;
  pins: TopicPlacementPinStore;
  recon: OwnershipReconciler;
  tick: () => ReconcileTickReport;
  raised: Array<{ id: string; title: string }>;
  setNow: (t: number) => void;
  cleanup: () => void;
}

function mkRig(opts: {
  machines?: ReconcilerMachineView[];
  sustainedOnline?: (m: string) => boolean;
  hasLiveAutonomousRun?: (k: string) => boolean;
  maxMovesPerTick?: number;
  divergedWindowMs?: number;
  pendingPinMaxAgeMs?: number;
  claimSuspensions?: () => Map<number, { suspended: boolean; hlc: HlcTimestamp }>;
  busy?: boolean;
} = {}): Rig {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u41-gates-'));
  const nonces = new Set<string>();
  const reg = new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => nonces.has(k),
    recordNonce: (k) => nonces.add(k),
  });
  // The store stamps `updatedAt` (the Case-A flap-debounce input) — pin it to
  // the rig's frozen clock so a pin set in the test reads as 60s old, not as
  // future-dated against the rig's `now` (which would debounce-defer forever).
  const pins = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json'), now: () => new Date(NOW - 60_000) });
  const raised: Rig['raised'] = [];
  let now = NOW;
  const machines = opts.machines ?? [
    { machineId: SELF, online: true, lastSeenMs: NOW },
    { machineId: PEER, online: true, lastSeenMs: NOW },
  ];
  const recon = new OwnershipReconciler({
    enabled: () => true,
    dryRun: () => false,
    selfMachineId: () => SELF,
    pinStore: () => pins,
    ownership: reg,
    machines: () => machines,
    isTopicBusy: () => opts.busy ?? false,
    emitPlacement: () => {},
    debounceMs: 0,
    safePointDeadlineMs: 1000,
    transferDeadlineMs: 2000,
    ...(opts.sustainedOnline ? { sustainedOnline: opts.sustainedOnline } : {}),
    ...(opts.hasLiveAutonomousRun ? { hasLiveAutonomousRun: opts.hasLiveAutonomousRun } : {}),
    ...(opts.maxMovesPerTick !== undefined ? { maxMovesPerTick: opts.maxMovesPerTick } : {}),
    ...(opts.divergedWindowMs !== undefined ? { divergedWindowMs: opts.divergedWindowMs } : {}),
    ...(opts.pendingPinMaxAgeMs !== undefined ? { pendingPinMaxAgeMs: opts.pendingPinMaxAgeMs } : {}),
    ...(opts.claimSuspensions ? { claimSuspensions: opts.claimSuspensions } : {}),
    raiseAttention: (item) => raised.push({ id: item.id, title: item.title }),
    now: () => now,
  });
  return {
    reg, pins, recon, raised,
    tick: () => recon.tick(),
    setNow: (t) => { now = t; },
    cleanup: () => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/u41-reconciler-pin-gates.test.ts cleanup' }),
  };
}

/** Seed SELF as the active owner of `key` on the rig's registry. */
function ownActive(rig: Rig, key: string, owner = SELF) {
  expect(rig.reg.cas({ type: 'place', machineId: owner }, { sessionKey: key, sender: owner, nonce: `p-${key}` }).ok).toBe(true);
  expect(rig.reg.cas({ type: 'claim', machineId: owner }, { sessionKey: key, sender: owner, nonce: `c-${key}` }).ok).toBe(true);
}

describe('case-a-transfer-not-initiated-toward-offline-target (R-r2-2)', () => {
  it('a LOCAL pin to an OFFLINE machine: zero transfer/abort cycles across many ticks, pinState pending', () => {
    const rig = mkRig({
      machines: [
        { machineId: SELF, online: true, lastSeenMs: NOW },
        { machineId: PEER, online: false, lastSeenMs: NOW - 600_000 },
      ],
      divergedWindowMs: 10 ** 15, // hold the honest `pending` classification across the long horizon
    });
    try {
      ownActive(rig, '700');
      rig.pins.set('700', PEER); // the operator's pin toward the offline mini
      let transfers = 0; let aborts = 0; let deferred = 0;
      // Many ticks spanning FAR past transferDeadlineMs (2s) + safePointDeadlineMs —
      // the old churn loop would have produced a transfer→abort cycle every ~2.5min.
      for (let i = 0; i < 10; i++) {
        rig.setNow(NOW + i * 150_000);
        const rep = rig.tick();
        transfers += rep.transfers; aborts += rep.aborts; deferred += rep.deferredTargetOffline;
      }
      expect(transfers).toBe(0); // no transfer ever initiated toward the offline target
      expect(aborts).toBe(0); // and therefore no N4 abort cycles to unwind
      expect(deferred).toBeGreaterThan(0);
      const st = rig.recon.pinStateOf('700');
      expect(st.pinState).toBe('pending');
      expect(st.pendingReason).toContain('offline'); // the honest named reason
      // The record NEVER left active(SELF) — the churn loop is structurally impossible.
      expect(rig.reg.read('700')?.status).toBe('active');
    } finally { rig.cleanup(); }
  });

  it('an ONLINE-but-not-yet-SUSTAINED target defers identically (the §2E hysteresis on Case A)', () => {
    let sustained = false;
    const rig = mkRig({ sustainedOnline: (m) => (m === PEER ? sustained : true) });
    try {
      ownActive(rig, '701');
      rig.pins.set('701', PEER);
      const rep1 = rig.tick();
      expect(rep1.transfers).toBe(0);
      expect(rep1.deferredTargetOffline).toBe(1); // flapped-on ⇒ same pending posture
      expect(rig.recon.pinStateOf('701').pinState).toBe('pending');
      expect(rig.recon.pinStateOf('701').pendingReason).toContain('sustained');
      sustained = true; // the window elapses — the target is now sustained-online
      const rep2 = rig.tick();
      expect(rep2.transfers).toBe(1); // the cooperative transfer initiates exactly then
    } finally { rig.cleanup(); }
  });
});

describe('pending-pin-fulfilment-requires-sustained-online (§2E i — Case-D adopt half)', () => {
  it('a pin naming ME with no live record adopts ONLY once I am sustained-online (flap ⇒ no grab)', () => {
    let sustained = false;
    const rig = mkRig({ sustainedOnline: (m) => (m === SELF ? sustained : true) });
    try {
      rig.pins.set('800', SELF); // pinned to me; no ownership record exists
      const rep1 = rig.tick();
      expect(rep1.adoptions).toBe(0);
      expect(rep1.deferredTargetOffline).toBe(1); // just-blinked-on ⇒ no adoption grab
      expect(rig.reg.read('800')).toBeNull();
      sustained = true;
      const rep2 = rig.tick();
      expect(rep2.adoptions).toBeGreaterThan(0); // place→claim fulfils the pin
      expect(rig.reg.read('800')?.ownerMachineId).toBe(SELF);
      expect(rig.reg.read('800')?.status).toBe('active');
      expect(rig.recon.pinStateOf('800').pinState).toBe('actuated'); // verified, not intent
    } finally { rig.cleanup(); }
  });
});

describe('pin-driven-move-defers-on-live-autonomous-run-no-deadline-override (§2E iii)', () => {
  it('a LIVE autonomous run defers the pin-driven transfer INDEFINITELY — even far past the safe-point deadline', () => {
    let live = true;
    const rig = mkRig({ hasLiveAutonomousRun: (k) => k === '900' && live });
    try {
      ownActive(rig, '900');
      rig.pins.set('900', PEER);
      let transfers = 0; let deferredRun = 0;
      for (let i = 0; i < 8; i++) {
        rig.setNow(NOW + i * 600_000); // hours past safePointDeadlineMs (1s)
        const rep = rig.tick();
        transfers += rep.transfers; deferredRun += rep.deferredAutonomousRun;
      }
      expect(transfers).toBe(0); // the deadline override does NOT apply to pin-driven moves
      expect(deferredRun).toBe(8);
      expect(rig.recon.pinStateOf('900').pinned).toBe(true); // the pin stays queued, never dropped
      live = false; // the run finishes — the move proceeds at the next tick
      expect(rig.tick().transfers).toBe(1);
    } finally { rig.cleanup(); }
  });
});

describe('replay-is-bounded-and-paced (§2D, extended per §2E R-r2-2)', () => {
  it('move-initiations per tick are bounded by ws13MaxMovesPerTick — a lease-flap replay can never storm', () => {
    const rig = mkRig({ maxMovesPerTick: 2 });
    try {
      for (const t of ['1', '2', '3', '4', '5']) {
        ownActive(rig, t);
        rig.pins.set(t, PEER); // five topics all pinned away at once (the replay shape)
      }
      const rep1 = rig.tick();
      expect(rep1.transfers).toBe(2); // bounded
      expect(rep1.deferredPaced).toBe(3); // the rest withheld, not dropped
      const rep2 = rig.tick();
      expect(rep2.transfers).toBe(2);
      const rep3 = rig.tick();
      expect(rep3.transfers).toBe(1); // convergence completes over PACED ticks
      expect(rep1.transfers + rep2.transfers + rep3.transfers).toBe(5);
    } finally { rig.cleanup(); }
  });

  it('EXTENSION (R-r2-2): an offline pinned target across many ticks produces zero transfer/abort cycles and one pending state', () => {
    const rig = mkRig({
      machines: [
        { machineId: SELF, online: true, lastSeenMs: NOW },
        { machineId: PEER, online: false, lastSeenMs: NOW - 600_000 },
      ],
      maxMovesPerTick: 2,
      divergedWindowMs: 10 ** 15, // the long horizon must still read `pending`, not flip states
    });
    try {
      ownActive(rig, '55');
      rig.pins.set('55', PEER);
      let transfers = 0; let aborts = 0;
      for (let i = 0; i < 12; i++) {
        rig.setNow(NOW + i * 155_000); // each step > transferDeadlineMs — the old loop period
        const rep = rig.tick();
        transfers += rep.transfers; aborts += rep.aborts;
      }
      expect(transfers).toBe(0);
      expect(aborts).toBe(0);
      expect(rig.recon.pinStateOf('55').pinState).toBe('pending'); // ONE honest state, no churn
    } finally { rig.cleanup(); }
  });
});

describe('aged-pending-pin-raises-one-deduped-attention-item (§2E ii)', () => {
  it('the owner-side Case-A pending past ws13PendingPinMaxAgeMs raises EXACTLY one item across many ticks', () => {
    const rig = mkRig({
      machines: [
        { machineId: SELF, online: true, lastSeenMs: NOW },
        { machineId: PEER, online: false, lastSeenMs: 0 }, // decommissioned/never returns
      ],
      pendingPinMaxAgeMs: 60_000,
    });
    try {
      ownActive(rig, '700');
      // The pin's HLC physical is the age authority (R-r2) — an old pin, long unfulfilled.
      rig.pins.set('700', PEER, true, { physical: NOW - 3_600_000, logical: 0, node: SELF });
      for (let i = 0; i < 6; i++) {
        rig.setNow(NOW + i * 30_000);
        rig.tick();
      }
      const aged = rig.raised.filter((r) => r.id === 'u41:pin-pending-aged:700');
      expect(aged).toHaveLength(1); // once per EPISODE, never per tick
    } finally { rig.cleanup(); }
  });

  it('pin-diverged raises once per episode; clearing the pin closes the episode; a re-pin opens a NEW one', () => {
    const rig = mkRig({
      sustainedOnline: () => false, // hold the conflict open (target never actuates)
      divergedWindowMs: 50_000,
    });
    try {
      ownActive(rig, '710');
      rig.pins.set('710', PEER, true, { physical: NOW, logical: 0, node: SELF });
      for (let i = 0; i < 5; i++) {
        rig.setNow(NOW + i * 30_000); // crosses the 50s diverged window on tick 3
        rig.tick();
      }
      expect(rig.raised.filter((r) => r.id === 'u41:pin-diverged:710')).toHaveLength(1);
      expect(rig.recon.pinStateOf('710').pinState).toBe('diverged');
      // Unpin closes the episode…
      rig.pins.clear('710');
      rig.setNow(NOW + 200_000);
      rig.tick();
      // …and a re-pin later is a NEW episode → ONE more item (not zero, not many).
      rig.pins.set('710', PEER, true, { physical: NOW + 210_000, logical: 0, node: SELF });
      for (let i = 0; i < 4; i++) {
        rig.setNow(NOW + 210_000 + i * 30_000);
        rig.tick();
      }
      expect(rig.raised.filter((r) => r.id === 'u41:pin-diverged:710')).toHaveLength(2);
    } finally { rig.cleanup(); }
  });
});

describe('pinStateOf — the verified placement-read state (§2D)', () => {
  it('actuated when the verified owner IS the pin target; pinHeldSince is the HLC physical (R-r2)', () => {
    const rig = mkRig();
    try {
      ownActive(rig, '100');
      rig.pins.set('100', SELF, true, { physical: NOW - 5000, logical: 0, node: SELF });
      const st = rig.recon.pinStateOf('100');
      expect(st.pinState).toBe('actuated');
      expect(st.pinHeldSince).toBe(NOW - 5000); // never a separate wall-clock read
    } finally { rig.cleanup(); }
  });

  it('tolerates + reports the U4.2 joint value suspended-pending-owner-return (R-r3-4) — never acts on it', () => {
    const pinHlc: HlcTimestamp = { physical: NOW - 10_000, logical: 0, node: SELF };
    const rig = mkRig({
      claimSuspensions: () => new Map([[100, { suspended: true, hlc: { physical: NOW, logical: 0, node: PEER } }]]),
    });
    try {
      ownActive(rig, '100');
      rig.pins.set('100', PEER, true, pinHlc);
      expect(rig.recon.pinStateOf('100').pinState).toBe('suspended-pending-owner-return');
      // tick() must never ACT on the suspended pin (U4.2 §2.4 composition).
      const rep = rig.tick();
      expect(rep.transfers).toBe(0);
    } finally { rig.cleanup(); }
  });

  it('unpinned topic reports pinned:false (no fabricated state)', () => {
    const rig = mkRig();
    try {
      expect(rig.recon.pinStateOf('42')).toEqual({ pinned: false });
    } finally { rig.cleanup(); }
  });
});
