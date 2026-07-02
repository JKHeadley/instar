/**
 * Tier-3 "feature is alive" E2E for U4.1 Pin Persistence
 * (docs/specs/u4-1-pin-persistence.md §4 E2E tier).
 *
 * Proves through the REAL AgentServer stack (auth middleware, route wiring):
 *  1. The new surfaces are ALIVE — GET /pool/pin-quarantine, POST /pool/unpin,
 *     and the pinState/pinHeldSince block on GET /pool/placement return 200,
 *     not 503-because-the-dep-wasn't-wired (the boot-ordering defect class).
 *  2. THE SPEC'S FULL LOOP against real stores: pin on A → the lease moves to
 *     B → B's acquisition tick converges (one immediate reconciler tick, epoch-
 *     fenced) → A claims → the placement read shows `actuated` on A. The
 *     headline evaporation bug, proven end-to-end: the pin SURVIVED the lease
 *     handover and the read reflects the VERIFIED owner, not intent.
 *  3. Auth: the new routes sit behind the Bearer middleware.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MachinePoolRegistry, captureHardware } from '../../src/core/MachinePoolRegistry.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { TopicPinSkewQuarantine } from '../../src/core/TopicPinSkewQuarantine.js';
import { TopicPinFoldView, type PinFoldReader } from '../../src/core/TopicPinFoldView.js';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import { LeaseAcquisitionTrigger } from '../../src/core/LeaseAcquisitionTrigger.js';
import type { InstarConfig, MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

describe('E2E: U4.1 pin persistence is ALIVE + the pin survives the lease handover', () => {
  const PORT = 47317;
  const A = 'm_a'; // the PINNED machine ("run this on the mini")
  const B = 'm_b'; // THIS machine — becomes the placement router
  const TOKEN = 'e2e-u41-token';
  let dir: string;
  let server: AgentServer;
  let ownReg: SessionOwnershipRegistry;
  let pinStore: TopicPlacementPinStore;
  let quarantine: TopicPinSkewQuarantine;
  let reconciler: OwnershipReconciler;
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u41-alive-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(A, 'mac-mini'), 'awake');
    idMgr.registerMachine(identity(B, 'laptop'), 'standby');
    idMgr.recordSelfHardware(B, captureHardware('1.3.99'));
    const registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    registry.recordHeartbeat({ machineId: A, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });
    registry.recordHeartbeat({ machineId: B, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });

    const seen = new Set<string>();
    ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
    // Topic 900: B currently runs it; the operator pinned it to A ("on the mini").
    ownReg.cas({ type: 'place', machineId: B }, { sessionKey: '900', sender: 'ROUTER', nonce: 'p900' });
    ownReg.cas({ type: 'claim', machineId: B }, { sessionKey: '900', sender: B, nonce: 'c900' });
    pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });
    pinStore.set('900', A, true, { physical: Date.now() - 120_000, logical: 0, node: A });

    quarantine = new TopicPinSkewQuarantine({ filePath: path.join(dir, 'quarantine.json') });
    const emptyReader: PinFoldReader = { foldPinRecords: () => ({ entries: [], offsets: {}, scannedBytes: 0, skippedCorrupt: 0, truncated: false, unfolded: [] }) };
    const foldView = new TopicPinFoldView({ reader: emptyReader, quarantine, selfNode: () => B });

    reconciler = new OwnershipReconciler({
      enabled: () => true,
      dryRun: () => false,
      selfMachineId: () => B,
      pinStore: () => pinStore,
      ownership: ownReg,
      machines: () => [
        { machineId: A, online: true, lastSeenMs: Date.now() },
        { machineId: B, online: true, lastSeenMs: Date.now() },
      ],
      isTopicBusy: () => false,
      emitPlacement: () => {},
      debounceMs: 0,
    });

    const config = {
      projectName: 'u41-alive-e2e',
      projectDir: dir,
      stateDir: dir,
      port: PORT,
      authToken: TOKEN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: PORT }),
      state: new StateManager(dir),
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: pinStore,
      topicPinSkewQuarantine: quarantine,
      topicPinFoldView: foldView,
      ownershipReconciler: reconciler,
      meshSelfId: B,
      resolveRouterUrl: () => null, // this node answers as the holder
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/u41-pin-persistence-alive.test.ts' });
  });

  it('GET /pool/pin-quarantine is ALIVE (200, not 503) through the real stack', async () => {
    const res = await fetch(`${base}/pool/pin-quarantine`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json() as { quarantined: unknown[]; fold?: Record<string, unknown> };
    expect(Array.isArray(body.quarantined)).toBe(true);
    expect(body.fold).toBeTruthy(); // the fold view is wired, not null
  });

  it('THE LOOP: pin on A survives the lease handover — B acquires, converges, A claims, the read shows actuated', async () => {
    // Before the handover: B owns 900, pin names A → the read is honest `pending`-family, never actuated.
    const before = await fetch(`${base}/pool/placement?topic=900`, { headers: auth }).then((r) => r.json()) as Record<string, unknown>;
    expect(before.pinState).not.toBe('actuated');
    expect(before.pinnedTo).toBe(A);

    // The lease moves to B (boot-as-holder counts): ONE immediate reconciler tick.
    let holder = false;
    const trigger = new LeaseAcquisitionTrigger({ holdsLease: () => holder, onAcquired: () => reconciler.tick() });
    expect(trigger.poll()).toBe(false); // not holding yet — the epoch fence
    holder = true;
    expect(trigger.poll()).toBe(true); // acquisition → the convergence tick fired

    // B initiated the cooperative transfer toward the pin target.
    const mid = ownReg.read('900');
    expect(mid?.status).toBe('transferring');
    expect(mid?.transferTo).toBe(A);

    // A completes the handoff (its claim — normally its own reconciler's Case B).
    const claimed = ownReg.cas({ type: 'claim', machineId: A }, { sessionKey: '900', sender: A, nonce: 'claim900' });
    expect(claimed.ok).toBe(true);

    // The placement read now reflects the VERIFIED actual owner vs the pin.
    const after = await fetch(`${base}/pool/placement?topic=900`, { headers: auth }).then((r) => r.json()) as Record<string, unknown>;
    expect(after.owner).toBe(A);
    expect(after.pinState).toBe('actuated'); // the pin SURVIVED the handover — the headline fix
    expect(typeof after.pinHeldSince).toBe('number');
  });

  it('POST /pool/unpin is ALIVE and clears the pin through the real stack', async () => {
    const res = await fetch(`${base}/pool/unpin`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 900 }) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.unpinned).toBe(true);
    expect(body.hadPin).toBe(true);
    expect(pinStore.get('900')).toBeNull();
    const read = await fetch(`${base}/pool/placement?topic=900`, { headers: auth }).then((r) => r.json()) as Record<string, unknown>;
    expect(read.pinnedTo ?? null).toBeNull(); // the unpin is visible on the read immediately
  });

  it('the new routes sit behind auth (401/403 without a Bearer token)', async () => {
    for (const [method, p] of [['GET', '/pool/pin-quarantine'], ['POST', '/pool/unpin'], ['POST', '/pool/pin-quarantine/readmit']] as const) {
      const res = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect([401, 403]).toContain(res.status);
    }
  });
});
