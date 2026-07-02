// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration (Tier 2) — U4.1 pin-persistence routes over the REAL router
 * (docs/specs/u4-1-pin-persistence.md §2B/§2C/§2D).
 *
 * Spec-named tests:
 *  - placement-read-reports-actuated-vs-pending-vs-diverged (§2D) — and the
 *    read TOLERATES the U4.2 joint value `suspended-pending-owner-return`
 *    from day one (R-r2 / renamed R-r3-4). `pinHeldSince` is the winning
 *    record's HLC physical; `pinnedBy` is serve-time length-clamped (§2F).
 *  - POST /pool/unpin — the deliberate unpin surface: clears through the
 *    one-HLC tombstone funnel so the clear REPLICATES (defect 2's fix at the
 *    route grain); 400 without a topic; 503 when the pool is dark.
 *  - GET /pool/pin-quarantine + POST /pool/pin-quarantine/readmit — the sticky
 *    skew-quarantine read + the DELIBERATE per-record re-admission (R-r4-1:
 *    dismissing the attention NOTIFICATION is a different, weaker act that
 *    touches none of this).
 *  - lease-acquisition-triggers-one-reconciler-tick (§2D) — the trigger fires
 *    the REAL reconciler exactly once per acquisition; a stale router
 *    (lease lost before the poll) initiates nothing (epoch fence).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MachinePoolRegistry, captureHardware } from '../../src/core/MachinePoolRegistry.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { TopicPinSkewQuarantine } from '../../src/core/TopicPinSkewQuarantine.js';
import { TopicPinFoldView, type PinFoldReader } from '../../src/core/TopicPinFoldView.js';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import { LeaseAcquisitionTrigger } from '../../src/core/LeaseAcquisitionTrigger.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SELF = 'm_a';
const PEER = 'm_b';
const NOW = Date.now();

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('U4.1 pin-persistence routes', () => {
  let dir: string;
  let ownReg: SessionOwnershipRegistry;
  let pinStore: TopicPlacementPinStore;
  let quarantine: TopicPinSkewQuarantine;
  let foldView: TopicPinFoldView;
  let reconciler: OwnershipReconciler;
  let server: Server;
  let emitted: Array<{ store: string; recordKey: string; data: Record<string, unknown> }>;
  let claimSuspension: { suspended: boolean; hlc: HlcTimestamp } | null;
  let simNow: number;

  function own(sessionKey: string, machineId: string): void {
    ownReg.cas({ type: 'place', machineId }, { sessionKey, sender: 'ROUTER', nonce: `p:${sessionKey}` });
    ownReg.cas({ type: 'claim', machineId }, { sessionKey, sender: machineId, nonce: `c:${sessionKey}` });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u41-routes-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(SELF, 'mac-mini'), 'awake');
    idMgr.registerMachine(identity(PEER, 'laptop'), 'standby');
    idMgr.recordSelfHardware(SELF, captureHardware('1.3.99'));
    const registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    registry.recordHeartbeat({ machineId: SELF, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });
    registry.recordHeartbeat({ machineId: PEER, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });

    const seen = new Set<string>();
    ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
    pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });
    quarantine = new TopicPinSkewQuarantine({ filePath: path.join(dir, 'quarantine.json') });
    const emptyReader: PinFoldReader = { foldPinRecords: () => ({ entries: [], offsets: {}, scannedBytes: 0, skippedCorrupt: 0, truncated: false, unfolded: [] }) };
    foldView = new TopicPinFoldView({ reader: emptyReader, quarantine, selfNode: () => SELF });
    claimSuspension = null;
    simNow = NOW;
    reconciler = new OwnershipReconciler({
      enabled: () => true,
      dryRun: () => true, // the route read must never actuate — dry-run isolates it
      selfMachineId: () => SELF,
      pinStore: () => pinStore,
      ownership: ownReg,
      machines: () => [
        { machineId: SELF, online: true, lastSeenMs: NOW },
        { machineId: PEER, online: false, lastSeenMs: NOW - 600_000 }, // the offline pinned machine
      ],
      isTopicBusy: () => false,
      emitPlacement: () => {},
      debounceMs: 0,
      divergedWindowMs: 60_000,
      claimSuspensions: () => (claimSuspension ? new Map([[13481, claimSuspension]]) : new Map()),
      now: () => simNow,
    });

    emitted = [];
    let logical = 0;
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator: {
        getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: SELF, leaseEpoch: 3, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1 }),
        managers: { identityManager: idMgr },
      },
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: pinStore,
      topicPinSkewQuarantine: quarantine,
      topicPinFoldView: foldView,
      ownershipReconciler: reconciler,
      meshSelfId: SELF,
      resolveRouterUrl: () => null, // we are the holder → answer locally
      // The one-HLC funnel's emitter seam (mirrors ReplicatedRecordEmitter.emit).
      replicatedRecordEmitter: {
        emit(store: string, recordKey: string, build: (h: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null) {
          const h: HlcTimestamp = { physical: NOW, logical: logical++, node: SELF };
          const data = build(h, SELF, undefined);
          if (data) emitted.push({ store, recordKey, data });
        },
      },
      state: { getCoherenceJournal: () => ({ emitPlacement: () => {} }) },
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/u41-pin-persistence-routes.test.ts' });
  });

  async function api(p: string, init?: RequestInit) {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  }

  // ── placement-read-reports-actuated-vs-pending-vs-diverged (§2D) ─────────

  it('actuated: verified owner IS the pin target — pinState + pinHeldSince (the HLC physical)', async () => {
    own('200', PEER);
    pinStore.set('200', PEER, true, { physical: NOW - 9000, logical: 0, node: SELF });
    const r = await api('/pool/placement?topic=200');
    expect(r.status).toBe(200);
    expect(r.body.pinState).toBe('actuated');
    expect(r.body.pinHeldSince).toBe(NOW - 9000);
  });

  it('pending: pinned to the OFFLINE machine — honest state with the named reason', async () => {
    own('201', SELF);
    pinStore.set('201', PEER, true, { physical: NOW - 9000, logical: 0, node: SELF });
    const r = await api('/pool/placement?topic=201');
    expect(r.status).toBe(200);
    expect(r.body.pinState).toBe('pending');
    expect(String(r.body.pendingReason ?? '')).toContain('offline');
  });

  it('diverged: desired≠actual persisting past ws13DivergedWindowMs flips the HTTP read pending → diverged', async () => {
    own('202', SELF);
    pinStore.set('202', PEER, true, { physical: NOW - 3_600_000, logical: 0, node: SELF });
    reconciler.tick(); // dry-run: records the conflict clock, actuates nothing
    // Younger than the 60s window → the read is honestly `pending` first…
    expect((await api('/pool/placement?topic=202')).body.pinState).toBe('pending');
    // …and once the SAME conflict has persisted past the window, `diverged`.
    simNow = NOW + 61_000;
    reconciler.tick();
    const r = await api('/pool/placement?topic=202');
    expect(r.status).toBe(200);
    expect(r.body.pinState).toBe('diverged');
  });

  it('tolerates + reports the U4.2 joint value suspended-pending-owner-return through the route (R-r3-4)', async () => {
    own('13481', SELF);
    pinStore.set('13481', PEER, true, { physical: NOW - 10_000, logical: 0, node: SELF });
    claimSuspension = { suspended: true, hlc: { physical: NOW, logical: 0, node: PEER } };
    const r = await api('/pool/placement?topic=13481');
    expect(r.status).toBe(200);
    expect(r.body.pinState).toBe('suspended-pending-owner-return');
  });

  it('pinnedBy (§2F) surfaces serve-time LENGTH-CLAMPED provenance, never oversize content', async () => {
    own('203', PEER);
    pinStore.set('203', PEER, true, { physical: NOW, logical: 0, node: SELF }, { kind: 'operator', platform: 'telegram', uid: 'u'.repeat(500) });
    const r = await api('/pool/placement?topic=203');
    const pb = r.body.pinnedBy as { kind: string; platform: string; uid: string };
    expect(pb.kind).toBe('operator');
    expect(pb.platform).toBe('telegram');
    expect(pb.uid.length).toBe(64); // clamped
  });

  // ── POST /pool/unpin (§2B — the deliberate unpin surface) ────────────────

  it('unpin clears the pin THROUGH the tombstone funnel: local clear + replicated delete with ONE HLC', async () => {
    pinStore.set('700', PEER, true);
    const r = await api('/pool/unpin', { method: 'POST', body: JSON.stringify({ topic: 700 }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ topic: '700', unpinned: true, hadPin: true, tombstoneReplicated: true });
    expect(pinStore.get('700')).toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.op).toBe('delete'); // the tombstone RODE the wire — defect 2 closed at the route
    expect(emitted[0].recordKey).toBe('700');
    // The placement read reflects the unpin immediately.
    const read = await api('/pool/placement?topic=700');
    expect(read.body.pinState).toBeUndefined();
    expect(read.body.pinnedTo ?? null).toBeNull();
  });

  it('unpin of a topic with NO pin still answers honestly (hadPin: false)', async () => {
    const r = await api('/pool/unpin', { method: 'POST', body: JSON.stringify({ topic: 999 }) });
    expect(r.status).toBe(200);
    expect(r.body.hadPin).toBe(false);
  });

  it('unpin without a topic → 400; a dark pool (no pin store) → 503', async () => {
    expect((await api('/pool/unpin', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
    const darkApp = express();
    darkApp.use(express.json());
    darkApp.use(createRoutes({ config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir } as any));
    const dark = await listen(darkApp);
    try {
      const r = await fetch(`${dark.url}/pool/unpin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 1 }) });
      expect(r.status).toBe(503);
    } finally { await dark.close(); }
  });

  // ── GET /pool/pin-quarantine + the explicit re-admit (§2C, R-r4-1) ───────

  it('the quarantine read surfaces entries + fold status; 503 when the pin fold is dark', async () => {
    quarantine.add({ key: '42', hlc: { physical: NOW + 600_000, logical: 0, node: 'm_fast' }, origin: 'm_fast' });
    const r = await api('/pool/pin-quarantine');
    expect(r.status).toBe(200);
    const q = r.body.quarantined as Array<Record<string, unknown>>;
    expect(q).toHaveLength(1);
    expect(q[0].origin).toBe('m_fast');
    expect(r.body.fold).toBeTruthy(); // the fold view's status block
    // fb-1d51e996-0a3 — the skew-gate floor is exposed and NOT frozen at a
    // construction seed: it tracks the live wall clock (§3.4 moving reference).
    const skewReference = (r.body.fold as { skewReference: number }).skewReference;
    expect(Number.isFinite(skewReference)).toBe(true);
    expect(Math.abs(skewReference - Date.now())).toBeLessThan(60_000);

    const darkApp = express();
    darkApp.use(express.json());
    darkApp.use(createRoutes({ config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir } as any));
    const dark = await listen(darkApp);
    try {
      expect((await fetch(`${dark.url}/pool/pin-quarantine`)).status).toBe(503);
    } finally { await dark.close(); }
  });

  it('re-admit is the DELIBERATE, exact-(key,hlc) action: bad body 400, no match 404, match removes + forces a full re-fold', async () => {
    const poison: HlcTimestamp = { physical: NOW + 600_000, logical: 0, node: 'm_fast' };
    quarantine.add({ key: '42', hlc: poison, origin: 'm_fast' });
    expect((await api('/pool/pin-quarantine/readmit', { method: 'POST', body: JSON.stringify({ key: '42' }) })).status).toBe(400);
    expect((await api('/pool/pin-quarantine/readmit', { method: 'POST', body: JSON.stringify({ key: '42', hlc: { physical: 1, logical: 0, node: 'x' } }) })).status).toBe(404);
    expect(quarantine.all()).toHaveLength(1); // wrong pair removed nothing
    const ok = await api('/pool/pin-quarantine/readmit', { method: 'POST', body: JSON.stringify({ key: '42', hlc: poison }) });
    expect(ok.status).toBe(200);
    expect(ok.body.readmitted).toBe(true);
    expect(quarantine.all()).toHaveLength(0);
    // resetFold() forces the NEXT refresh to re-fold from byte 0 (the re-admitted
    // record's bytes were already consumed by the incremental tail).
    expect(foldView.status().recordKeys).toBe(0);
  });

  // ── lease-acquisition-triggers-one-reconciler-tick (§2D) ─────────────────

  it('acquisition fires the REAL reconciler exactly once; a stale router (lease lost pre-poll) fires nothing', () => {
    let holder = false;
    let ticks = 0;
    const trigger = new LeaseAcquisitionTrigger({
      holdsLease: () => holder,
      onAcquired: () => { ticks++; reconciler.tick(); },
    });
    expect(trigger.poll()).toBe(false); // not the holder → the epoch fence holds
    expect(ticks).toBe(0);
    holder = true;
    expect(trigger.poll()).toBe(true); // became the router → ONE immediate tick
    expect(trigger.poll()).toBe(false); // steady holding never re-fires
    expect(ticks).toBe(1);
    holder = false; // lease lost between polls (the stale-router shape)
    expect(trigger.poll()).toBe(false);
    expect(ticks).toBe(1); // a stale router's tick initiates nothing
  });
});
