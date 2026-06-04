/**
 * Integration ("feature-alive") tests for the topic placement-observability +
 * deterministic-transfer routes (Multi-Machine Session Pool robustness, 2026-06-04):
 *   GET  /pool/placement?topic=N   — which machine + WHY (pinned vs placed) + holder
 *   POST /pool/transfer {topic,to}  — deterministic move via the validated planner
 *
 * Stands up the real router with a minimal RouteContext (machinePoolRegistry +
 * sessionOwnershipRegistry + topicPinStore + a coordinator stub) and drives it over
 * HTTP. resolveRouterUrl returns null here, so the routes answer locally (this node
 * is the holder) — the proxy branch is exercised separately at the unit level.
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
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function identity(machineId: string, name: string, platform = 'darwin-arm64'): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform, createdAt: new Date().toISOString(), capabilities: ['sessions'] };
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

describe('Pool placement + transfer routes (multi-machine robustness)', () => {
  let dir: string;
  let idMgr: MachineIdentityManager;
  let registry: MachinePoolRegistry;
  let ownReg: SessionOwnershipRegistry;
  let pinStore: TopicPlacementPinStore;
  let server: Server;
  const SELF = 'm_a'; // "Mac Mini" — the holder answering these requests
  const PEER = 'm_b'; // "Laptop"

  /** Make a session owned (active) by `machineId`. */
  function own(sessionKey: string, machineId: string): void {
    ownReg.cas({ type: 'place', machineId }, { sessionKey, sender: 'ROUTER', nonce: `p:${sessionKey}:${machineId}` });
    ownReg.cas({ type: 'claim', machineId }, { sessionKey, sender: machineId, nonce: `c:${sessionKey}:${machineId}` });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-pt-'));
    idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(SELF, 'mac-mini'), 'awake'); // → "Mac Mini"
    idMgr.registerMachine(identity(PEER, 'laptop'), 'standby'); // → "Laptop"
    idMgr.recordSelfHardware(SELF, captureHardware('1.3.75'));

    registry = new MachinePoolRegistry({
      listMachines: () =>
        idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    // Both online (so a transfer to a peer is not gated on confirm).
    registry.recordHeartbeat({ machineId: SELF, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });
    registry.recordHeartbeat({ machineId: PEER, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });

    const seen = new Set<string>();
    ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });
    pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });

    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: SELF, leaseEpoch: 3, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1 }),
      managers: { identityManager: idMgr },
    };
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator,
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: pinStore,
      meshSelfId: SELF,
      resolveRouterUrl: () => null, // we are the holder → answer locally
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/pool-placement-transfer-routes.test.ts' });
  });

  async function api(p: string, init?: RequestInit) {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // ── GET /pool/placement ──────────────────────────────────────────────
  it('GET /pool/placement requires a topic (400)', async () => {
    const r = await api('/pool/placement');
    expect(r.status).toBe(400);
  });

  it('reports reason "placed" for an owned-but-unpinned topic (load-balanced, NOT a move)', async () => {
    own('100', PEER);
    const r = await api('/pool/placement?topic=100');
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('placed');
    expect(r.body.owner).toBe(PEER);
    expect(r.body.ownerNickname).toBe('Laptop');
    expect(r.body.pinnedTo).toBeNull();
    expect(r.body.leaseHolder).toBe(SELF);
    expect(r.body.answeredBy).toBe('local');
  });

  it('reports reason "pinned" with target when the topic is hard-pinned (deliberate move)', async () => {
    own('101', PEER);
    pinStore.set('101', PEER, true);
    const r = await api('/pool/placement?topic=101');
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('pinned');
    expect(r.body.pinnedTo).toBe(PEER);
    expect(r.body.pinnedToNickname).toBe('Laptop');
  });

  it('reports reason "unowned" for a topic no machine owns', async () => {
    const r = await api('/pool/placement?topic=999');
    expect(r.status).toBe(200);
    expect(r.body.reason).toBe('unowned');
    expect(r.body.owner).toBeNull();
  });

  it('sets isThisMachine when the answering (holder) machine owns the topic', async () => {
    own('102', SELF);
    const r = await api('/pool/placement?topic=102');
    expect(r.body.isThisMachine).toBe(true);
    expect(r.body.thisMachine).toBe(SELF);
  });

  // ── POST /pool/transfer ──────────────────────────────────────────────
  it('POST /pool/transfer requires topic and to (400)', async () => {
    const r = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 13481 }) });
    expect(r.status).toBe(400);
  });

  it('transfers a topic to a machine by nickname: 200, sets the pin, GET reflects "pinned"', async () => {
    own('200', SELF); // owned by the holder → should be released on transfer
    const t = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 200, to: 'Laptop' }) });
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(true);
    expect(t.body.targetMachine).toBe(PEER);
    expect(t.body.targetNickname).toBe('Laptop');
    expect(t.body.pinned).toBe(true);
    expect(t.body.releasedLocalOwnership).toBe(true);
    // The pin now drives placement — observable via GET /pool/placement.
    const g = await api('/pool/placement?topic=200');
    expect(g.body.reason).toBe('pinned');
    expect(g.body.pinnedTo).toBe(PEER);
  });

  it('transfers by raw machineId too (not only nickname)', async () => {
    const t = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 201, to: PEER }) });
    expect(t.status).toBe(200);
    expect(t.body.targetMachine).toBe(PEER);
  });

  it('rejects an unknown machine with 404', async () => {
    const r = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 202, to: 'Nonexistent' }) });
    expect(r.status).toBe(404);
    expect(r.body.rejectReason).toBe('unknown-machine-nickname');
  });

  it('rate-limits rapid repeat transfers of the same topic (409)', async () => {
    const first = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 203, to: 'Laptop' }) });
    expect(first.status).toBe(200);
    const second = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 203, to: 'Mac Mini' }) });
    expect(second.status).toBe(409);
    expect(second.body.rejectReason).toBe('rate-limited');
  });

  it('requires confirmation for an OFFLINE target, then proceeds with confirm:true', async () => {
    idMgr.registerMachine(identity('m_c', 'studio'), 'standby'); // registered but NEVER heartbeats → offline
    const noConfirm = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 204, to: 'Studio' }) });
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.body.needsConfirmation).toBe(true);
    const withConfirm = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 205, to: 'Studio', confirm: true }) });
    expect(withConfirm.status).toBe(200);
    expect(withConfirm.body.targetMachine).toBe('m_c');
  });
});
