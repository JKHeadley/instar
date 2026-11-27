/**
 * Unroutable-owner release (docs/specs/unroutable-owner-release.md) Tier-3 alive test:
 * the AgentServer option isOwnerUnroutable reaches POST /pool/transfer through the
 * real stack, and a topic owned by a REVOKED machine actually moves (seatMoved:true).
 * Harness mirrors pool-placement-transfer-alive.test.ts.
 *
 * Tier-3 "feature is alive" E2E for the placement-observability + deterministic-
 * transfer routes (multi-machine robustness, 2026-06-04). Per CLAUDE.md the Tier-3
 * test is "the single most important test for any feature with API routes": it
 * proves the routes are reachable through the REAL AgentServer stack (auth
 * middleware, error handling) and return 200 — not 503 because a dep wasn't wired.
 *
 * Spins up one real AgentServer with the pool deps wired (machinePoolRegistry,
 * sessionOwnershipRegistry, topicPinStore, meshSelfId, resolveRouterUrl) and drives
 * GET /pool/placement + POST /pool/transfer over HTTP with Bearer auth.
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
import type { InstarConfig, MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import { createUnroutableOwnerAssessor } from '../../src/core/unroutableOwner.js';

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

describe('E2E: unroutable-owner transfer is ALIVE through the real AgentServer', () => {
  const SELF = 'm_a';
  const PEER = 'm_b';
  const DEAD = 'm_dead';
  const TOKEN = 'e2e-token';
  let dir: string;
  let server: AgentServer;
  let pinStore: TopicPlacementPinStore;
  let ownReg: SessionOwnershipRegistry;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-alive-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(SELF, 'mac-mini'), 'awake');
    idMgr.registerMachine(identity(PEER, 'laptop'), 'standby');
    idMgr.recordSelfHardware(SELF, captureHardware('1.3.75'));
    idMgr.registerMachine(identity(DEAD, 'old-studio'), 'standby');
    idMgr.revokeMachine(DEAD, SELF, 'rebuilt with a new machine id');

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
    // Topic 600 is owned by the REVOKED old machine id (the rebuilt-Studio case).
    ownReg.cas({ type: 'place', machineId: DEAD }, { sessionKey: '600', sender: 'ROUTER', nonce: 'p600' });
    ownReg.cas({ type: 'claim', machineId: DEAD }, { sessionKey: '600', sender: DEAD, nonce: 'c600' });
    const assess = createUnroutableOwnerAssessor({
      selfMachineId: () => SELF,
      registryMachines: () => idMgr.loadRegistry().machines,
      inPoolView: (m) => !!registry.getCapacity(m),
      lastSideEffectMs: () => null,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: Date.now() - 3_600_000,
    });
    pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });

    const config = {
      projectName: 'pool-alive-e2e',
      projectDir: dir,
      stateDir: dir,
      port: 0,
      authToken: TOKEN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: 0 }),
      state: new StateManager(dir),
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: pinStore,
      meshSelfId: SELF,
      resolveRouterUrl: () => null, // single node acting as holder
      isOwnerUnroutable: (m: string) => assess(m).unroutable,
    });
    await server.start();
    base = boundAgentServerBase(server);
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/unroutable-owner-transfer-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('a topic owned by a REVOKED machine is reported, then moved for real (seatMoved:true)', async () => {
    const before = await fetch(`${base}/pool/placement?topic=600`, { headers: auth });
    expect(before.status).toBe(200);
    expect((await before.json()).owner).toBe(DEAD);
    // The dead owner's run state cannot be verified, so the operator confirms the challenge (kept by design).
    const first = await fetch(`${base}/pool/transfer`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 600, to: 'Mac Mini', confirm: true }) });
    const challenge = (await first.json()).confirmationChallenge;
    const res = await fetch(`${base}/pool/transfer`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 600, to: 'Mac Mini', confirm: true, ...(challenge ? { confirmationChallenge: challenge } : {}) }) });
    const body = await res.json();
    expect({ status: res.status, body }).toMatchObject({ status: 200 });
    expect(body).toMatchObject({ ok: true, seatMoved: true, targetMachine: SELF });
    const after = await fetch(`${base}/pool/placement?topic=600`, { headers: auth });
    expect((await after.json()).owner).toBe(SELF);
    expect(ownReg.read('600')?.status).toBe('active');
  });

  it('routes sit behind auth (401/403 without a Bearer token)', async () => {
    const res = await fetch(`${base}/pool/transfer`, { method: 'POST', body: JSON.stringify({ topic: 600, to: 'Mac Mini' }) });
    expect([401, 403]).toContain(res.status);
  });
});
