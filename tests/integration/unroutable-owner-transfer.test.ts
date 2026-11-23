/**
 * Unroutable-owner release §4 (docs/specs/unroutable-owner-release.md) — Tier 2.
 * POST /pool/transfer over a topic owned by a REVOKED machine (the rebuilt-Studio
 * case) now force-claims it to the target; without the dep it keeps today's
 * honest seatMoved:false. Harness copied from pool-placement-transfer-routes.
 *
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
import { createUnroutableOwnerAssessor } from '../../src/core/unroutableOwner.js';

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

describe('POST /pool/transfer — unroutable owner', () => {
  let dir: string;
  let idMgr: MachineIdentityManager;
  let registry: MachinePoolRegistry;
  let ownReg: SessionOwnershipRegistry;
  let pinStore: TopicPlacementPinStore;
  let server: Server;
  let placements: Array<Record<string, unknown>>;
  let sendDrainCalls: Array<{ owner: string; sk: string; target: string; epoch: number }>;
  let sendDrainImpl: (owner: string, sk: string, target: string, epoch: number) => { ok: boolean; status?: string; reason?: string; runSuspended?: boolean; claimLanded?: boolean };
  let remoteAutonomousRun: { goal: string | null; remainingMinutes: number | null } | null;
  let remoteProbeImpl: (() => Promise<{ goal: string | null; remainingMinutes: number | null } | null>) | null;
  let remoteProbeCapabilityPresent: boolean;
  let workingSetKicks: Array<{ machineId: string; topic: number }>;
  let routeCtx: any;
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
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: SELF, leaseEpoch: 3, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1, awakeMachineCountSource: 'lease-live' }),
      managers: { identityManager: idMgr },
    };
    placements = [];
    sendDrainCalls = [];
    sendDrainImpl = () => ({ ok: true, status: 'drained' });
    remoteAutonomousRun = null;
    remoteProbeImpl = null;
    remoteProbeCapabilityPresent = true;
    workingSetKicks = [];
    routeCtx = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator,
      // WS1.2 drain seam: records every order; per-test impl shapes the outcome.
      sendDrain: (owner: string, sk: string, target: string, epoch: number) => {
        sendDrainCalls.push({ owner, sk, target, epoch });
        return Promise.resolve(sendDrainImpl(owner, sk, target, epoch));
      },
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: pinStore,
      meshSelfId: SELF,
      kickWorkingSetOnMachine: (machineId: string, topic: number) => workingSetKicks.push({ machineId, topic }),
      resolveRouterUrl: () => null, // we are the holder → answer locally
      // Coherence journal seam (finding #5): capture every placement entry the
      // transfer handler emits, exactly as the live journal would receive it.
      state: { getCoherenceJournal: () => ({ emitPlacement: (topic: number, data: Record<string, unknown>) => placements.push({ topic, ...data }) }) },
    };
    Object.defineProperty(routeCtx, 'autonomousRunOnMachine', {
      get: () => remoteProbeCapabilityPresent
        ? async () => remoteProbeImpl ? remoteProbeImpl() : remoteAutonomousRun
        : null,
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes(routeCtx));
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

  const DEAD = 'm_dead_old_studio';

  function wireAssessor(): void {
    const assess = createUnroutableOwnerAssessor({
      selfMachineId: () => SELF,
      registryMachines: () => idMgr.loadRegistry().machines,
      inPoolView: (m) => !!registry.getCapacity(m),
      lastSideEffectMs: () => null,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: Date.now() - 3_600_000,
    });
    routeCtx.isOwnerUnroutable = (m: string) => assess(m).unroutable;
  }

  it('a topic owned by a REVOKED machine moves to the target (force-claim, journaled)', async () => {
    idMgr.registerMachine(identity(DEAD, 'old-studio'), 'standby');
    idMgr.revokeMachine(DEAD, SELF, 'machine rebuilt with a new id');
    expect(idMgr.loadRegistry().machines[DEAD]?.status).toBe('revoked');
    own('141385', DEAD);
    wireAssessor();
    const r = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 141385, to: 'Mac Mini', confirm: true }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, seatMoved: true, targetMachine: SELF });
    const rec = ownReg.read('141385');
    expect(rec).toMatchObject({ ownerMachineId: SELF, status: 'active' });
    expect(placements.some((p) => p.topic === 141385 && p.owner === SELF && p.prevOwner === DEAD)).toBe(true);
  });

  it('can also move a revoked owner\'s topic to a live PEER', async () => {
    idMgr.registerMachine(identity(DEAD, 'old-studio'), 'standby');
    idMgr.revokeMachine(DEAD, SELF, 'rebuilt');
    own('29723', DEAD);
    wireAssessor();
    const r = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 29723, to: 'Laptop', confirm: true }) });
    expect(r.body.seatMoved).toBe(true);
    expect(ownReg.read('29723')?.ownerMachineId).toBe(PEER);
  });

  it('without the dep the transfer keeps today\'s honest seatMoved:false (no silent steal)', async () => {
    idMgr.registerMachine(identity(DEAD, 'old-studio'), 'standby');
    idMgr.revokeMachine(DEAD, SELF, 'rebuilt');
    own('141386', DEAD);
    const r = await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 141386, to: 'Mac Mini', confirm: true }) });
    expect(r.body.seatMoved).toBe(false);
    expect(ownReg.read('141386')?.ownerMachineId).toBe(DEAD);
  });

  it('a REGISTERED (merely offline) owner is never force-claimed by transfer', async () => {
    own('141387', PEER);
    wireAssessor();
    sendDrainImpl = () => ({ ok: false, status: 'no-handler' });
    await api('/pool/transfer', { method: 'POST', body: JSON.stringify({ topic: 141387, to: 'Mac Mini', confirm: true }) });
    // The live peer keeps its record unless its own drain/claim moved it — never a force-claim.
    const rec = ownReg.read('141387');
    expect(rec?.nonce ?? '').not.toContain('tforce');
  });
});
