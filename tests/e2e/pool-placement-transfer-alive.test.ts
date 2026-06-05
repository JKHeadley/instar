/**
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

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

describe('E2E: pool placement + transfer routes are ALIVE through the real AgentServer', () => {
  const PORT = 47213;
  const SELF = 'm_a';
  const PEER = 'm_b';
  const TOKEN = 'e2e-token';
  let dir: string;
  let server: AgentServer;
  let pinStore: TopicPlacementPinStore;
  let ownReg: SessionOwnershipRegistry;
  const base = `http://127.0.0.1:${PORT}`;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-alive-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(SELF, 'mac-mini'), 'awake');
    idMgr.registerMachine(identity(PEER, 'laptop'), 'standby');
    idMgr.recordSelfHardware(SELF, captureHardware('1.3.75'));

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
    // Own topic 500 on the peer so placement has a concrete answer.
    ownReg.cas({ type: 'place', machineId: PEER }, { sessionKey: '500', sender: 'ROUTER', nonce: 'p500' });
    ownReg.cas({ type: 'claim', machineId: PEER }, { sessionKey: '500', sender: PEER, nonce: 'c500' });
    pinStore = new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') });

    const config = {
      projectName: 'pool-alive-e2e',
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
      meshSelfId: SELF,
      resolveRouterUrl: () => null, // single node acting as holder
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/pool-placement-transfer-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('GET /pool/placement is ALIVE (200, not 503) through the real stack', async () => {
    const res = await fetch(`${base}/pool/placement?topic=500`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe('placed');
    expect(body.owner).toBe(PEER);
    expect(body.ownerNickname).toBe('Laptop');
  });

  it('POST /pool/transfer is ALIVE (200, not 503) and pins the topic', async () => {
    const res = await fetch(`${base}/pool/transfer`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 501, to: 'Laptop' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.targetMachine).toBe(PEER);
    // Observable: the pin the transfer set is now reported by the placement route.
    const after = await fetch(`${base}/pool/placement?topic=501`, { headers: auth });
    expect((await after.json()).reason).toBe('pinned');
  });

  // The live-caught self-nickname bug: a machine must resolve its OWN nickname.
  // SELF here is "Mac Mini" — transferring to "Mac Mini" exercises self-resolution
  // through the real stack (this 404'd as "unknown machine" before the fix).
  it('POST /pool/transfer resolves THIS machine\'s OWN nickname (self-nickname fix)', async () => {
    const res = await fetch(`${base}/pool/transfer`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 502, to: 'Mac Mini' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.targetMachine).toBe(SELF);
    expect(body.targetNickname).toBe('Mac Mini');
  });

  it('routes sit behind auth (401/403 without a Bearer token) — proves the real middleware stack', async () => {
    const res = await fetch(`${base}/pool/placement?topic=500`);
    expect([401, 403]).toContain(res.status);
  });
});
