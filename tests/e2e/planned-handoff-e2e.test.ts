/**
 * E2E: planned handoff over two real booted servers (spec §8 G3e — increment C3).
 *
 * The increment-A e2e (multi-machine-http.test.ts) proved the ack/yield/begin
 * routes are individually ALIVE by driving the receive side by hand. This test
 * proves the WHOLE conductor end-to-end across two real AgentServers wired with
 * REAL peer resolvers, exercising the SAME factories server.ts boots:
 *
 *   A (outgoing/awake)  createHandoffSentinelWiring → HandoffSentinel.initiate
 *   B (incoming/standby) createHandoffReceiverWiring → HandoffReceiver
 *
 * The full loop, all over signed HTTP between the two servers:
 *   A.flush() → POST /api/handoff/begin → B.onBegin → B.buildAck (hashes B's OWN
 *   history) → POST /api/handoff/ack → A.recordAck resolves awaitAck → A verifies
 *   the echo matches what it flushed → A.sendYield → POST /api/handoff/yield →
 *   B.onYield → acquireLeaseOnConsent(A) → A.demoteSelf.
 *
 * Both sides of the decision boundary:
 *   1. Standby caught up (identical history) → handed-off, B acquires, A demotes.
 *   2. Standby NOT caught up (divergent history → hash mismatch) → A aborts and
 *      stays awake, NO yield is sent, B never acquires. The no-two-holders
 *      invariant, proven over the wire.
 *
 * Plus the operator trigger is alive: POST /handoff/initiate returns the outcome
 * through the booted server, and 503s honestly on a server with no wiring.
 *
 * Per TESTING-INTEGRITY-SPEC Tier-3: the production initialization path
 * (the real AgentServer routes + machineAuth + HandoffWireTransport), not mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager, generateMachineId, generateSigningKeyPair, generateEncryptionKeyPair } from '../../src/core/MachineIdentity.js';
import { HandoffWireTransport } from '../../src/core/HandoffWireTransport.js';
import { createHandoffSentinelWiring } from '../../src/core/handoffSentinelWiring.js';
import { createHandoffReceiverWiring, type ThreadEntry } from '../../src/core/handoffReceiverWiring.js';
import type { HandoffOutcome } from '../../src/core/HandoffSentinel.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-handoff-e2e-'));
}
function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/planned-handoff-e2e.test.ts' });
}

/** Poll until `cond` is true or the deadline passes (for fire-and-forget receiver work). */
async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

function createMachineEnv(name: string, port: number, role: 'awake' | 'standby') {
  const stateDir = createTempDir();
  const projectDir = stateDir;
  const mgr = new MachineIdentityManager(stateDir);
  const machineId = generateMachineId();
  const signingKeys = generateSigningKeyPair();
  const encryptionKeys = generateEncryptionKeyPair();
  const signingPubBase64 = signingKeys.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const encryptionPubBase64 = encryptionKeys.publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const identity = {
    machineId,
    signingPublicKey: signingPubBase64,
    encryptionPublicKey: encryptionPubBase64,
    name,
    platform: `${os.platform()}-${os.arch()}`,
    createdAt: new Date().toISOString(),
    capabilities: ['sessions'] as string[],
  };
  const machineDir = path.join(stateDir, 'machine');
  fs.mkdirSync(machineDir, { recursive: true });
  fs.writeFileSync(path.join(machineDir, 'identity.json'), JSON.stringify(identity, null, 2));
  fs.writeFileSync(path.join(machineDir, 'signing-private.pem'), signingKeys.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(machineDir, 'encryption-private.pem'), encryptionKeys.privateKey, { mode: 0o600 });
  mgr.registerMachine(identity as any, role);
  const config: InstarConfig = {
    projectName: `test-${name}`,
    projectDir,
    stateDir,
    port,
    host: '127.0.0.1',
    authToken: `test-auth-${name}`,
    claudePath: 'claude',
    tmuxPath: 'tmux',
    scheduler: { enabled: false, timezone: 'UTC' },
    messaging: [],
    monitoring: {},
    requestTimeoutMs: 30000,
  } as InstarConfig;
  return { stateDir, projectDir, mgr, identity, machineId, signingKeys, encryptionKeys, config };
}

function crossRegister(envA: ReturnType<typeof createMachineEnv>, envB: ReturnType<typeof createMachineEnv>) {
  envA.mgr.registerMachine(envB.identity as any, 'standby');
  envA.mgr.storeRemoteIdentity(envB.identity as any);
  envB.mgr.registerMachine(envA.identity as any, 'awake');
  envB.mgr.storeRemoteIdentity(envA.identity as any);
}

// Canonical "caught up" history both machines hash identically on the happy path.
const HISTORY: ThreadEntry[] = [
  { timestamp: '2026-05-27T10:00:00Z', text: 'hey, can you check the deploy?' },
  { timestamp: '2026-05-27T10:01:00Z', text: 'on it — looking now' },
];

describe('Planned handoff E2E (two real servers, full conductor)', () => {
  const PORT_A = 19300 + Math.floor(Math.random() * 80);
  const PORT_B = PORT_A + 1;

  let envA: ReturnType<typeof createMachineEnv>;
  let envB: ReturnType<typeof createMachineEnv>;
  let serverA: AgentServer;
  let serverB: AgentServer;
  let coordA: MultiMachineCoordinator;
  let coordB: MultiMachineCoordinator;
  let handoffWireA: HandoffWireTransport; // outgoing side, peer → B
  let handoffWireB: HandoffWireTransport; // incoming side, peer → A

  // Per-test mutable fixtures.
  let bHistory: ThreadEntry[] = HISTORY;     // B's view of the thread (caught up by default)
  let acquireCalls: string[] = [];           // machineIds passed to acquireLeaseOnConsent
  let currentInitiate: () => Promise<HandoffOutcome> = async () => 'aborted-stay-awake';

  /** A fresh outgoing sentinel bound to A's real wire transport + B's running routes. */
  function makeSentinelA() {
    return createHandoffSentinelWiring({
      pushTick: async () => { /* no live-tail content needed; the hash is the caught-up gate */ },
      getIngressPosition: () => ({ platform: 'telegram', cursor: 1234, capturedAt: new Date().toISOString() }),
      getTopicHistory: () => HISTORY,
      activeTopic: () => 42,
      postBegin: (m) => handoffWireA.sendBegin(m),
      awaitAck: (ms) => handoffWireA.awaitAck(ms),
      sendYield: () => handoffWireA.sendYield(),
      demoteSelf: () => coordA.demoteToStandby('planned handoff test'),
      handoffAckTimeoutMs: 3000,
      minHandoffIntervalMs: 0,
      logger: () => {},
    });
  }

  beforeAll(async () => {
    envA = createMachineEnv('machine-a', PORT_A, 'awake');
    envB = createMachineEnv('machine-b', PORT_B, 'standby');
    crossRegister(envA, envB);

    const stateA = new StateManager(envA.stateDir);
    coordA = new MultiMachineCoordinator(stateA, { stateDir: envA.stateDir });
    coordA.start();
    const heartbeatSrc = path.join(envA.stateDir, 'state', 'heartbeat.json');
    const heartbeatDst = path.join(envB.stateDir, 'state', 'heartbeat.json');
    fs.mkdirSync(path.dirname(heartbeatDst), { recursive: true });
    if (fs.existsSync(heartbeatSrc)) fs.copyFileSync(heartbeatSrc, heartbeatDst);
    const stateB = new StateManager(envB.stateDir);
    coordB = new MultiMachineCoordinator(stateB, { stateDir: envB.stateDir });
    coordB.start();

    const sessA = new SessionManager({ stateDir: envA.stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: envA.projectDir, port: PORT_A });
    const sessB = new SessionManager({ stateDir: envB.stateDir, claudePath: 'claude', tmuxPath: 'tmux', projectDir: envB.projectDir, port: PORT_B });

    let seqA = 1;
    let seqB = 1;
    handoffWireA = new HandoffWireTransport({
      selfMachineId: envA.machineId,
      signingKeyPem: envA.signingKeys.privateKey,
      peer: () => ({ machineId: envB.machineId, url: `http://127.0.0.1:${PORT_B}` }),
      nextSequence: () => ++seqA,
    });
    handoffWireB = new HandoffWireTransport({
      selfMachineId: envB.machineId,
      signingKeyPem: envB.signingKeys.privateKey,
      peer: () => ({ machineId: envA.machineId, url: `http://127.0.0.1:${PORT_A}` }),
      nextSequence: () => ++seqB,
    });

    // Incoming-side receiver on B — the SAME factory server.ts boots. Lease
    // acquisition is spied (the lease CAS itself is covered by the FencedLease
    // tests in PR #419); here we prove the yield TRIGGERS it with A's id.
    const receiverWiringB = createHandoffReceiverWiring({
      sendAck: (ack) => handoffWireB.sendAck(ack),
      acquireLeaseOnConsent: async (from) => { acquireCalls.push(from); return true; },
      getTopicHistory: () => bHistory,
      logger: () => {},
    });
    handoffWireB.onYield(receiverWiringB.yieldHandler);

    serverA = new AgentServer({
      config: envA.config,
      sessionManager: sessA,
      state: stateA,
      coordinator: coordA,
      localSigningKeyPem: envA.signingKeys.privateKey,
      handoffWireTransport: handoffWireA, // B's ack POSTs here → recordAck
      onHandoffInitiate: () => currentInitiate(),
      handoffInProgress: () => false,
    });
    serverB = new AgentServer({
      config: envB.config,
      sessionManager: sessB,
      state: stateB,
      coordinator: coordB,
      localSigningKeyPem: envB.signingKeys.privateKey,
      handoffWireTransport: handoffWireB, // A's yield POSTs here → recordYield → yieldHandler
      onHandoffBegin: receiverWiringB.onBegin, // A's begin POSTs here
    });

    await serverA.start();
    await serverB.start();
  }, 20000);

  afterAll(async () => {
    await serverA?.stop();
    await serverB?.stop();
    coordA?.stop();
    coordB?.stop();
    cleanup(envA.stateDir);
    cleanup(envB.stateDir);
  }, 10000);

  it('caught-up standby: A flushes → B acks → A verifies → yields → B acquires (handed-off)', async () => {
    coordA.promoteToAwake('test reset');
    acquireCalls = [];
    bHistory = HISTORY; // B is caught up → its recomputed hash matches A's manifest

    const sentinelA = makeSentinelA();
    const outcome = await sentinelA.initiate();
    expect(outcome).toBe('handed-off');

    // The yield reached B and fired its lease-CAS trigger with A's machine id.
    await waitFor(() => acquireCalls.length === 1);
    expect(acquireCalls).toEqual([envA.machineId]);

    // A yielded → it demoted itself and is no longer awake.
    expect(coordA.isAwake).toBe(false);
  }, 15000);

  it('stale standby: divergent history → hash mismatch → A aborts, stays awake, NO yield/acquire', async () => {
    coordA.promoteToAwake('test reset');
    acquireCalls = [];
    bHistory = [{ timestamp: '2026-05-27T09:00:00Z', text: 'STALE — B missed the live tail' }];

    const sentinelA = makeSentinelA();
    const outcome = await sentinelA.initiate();
    expect(outcome).toBe('aborted-stay-awake');

    // Give any (incorrect) fire-and-forget yield a chance to land — it must not.
    await new Promise((r) => setTimeout(r, 250));
    expect(acquireCalls).toEqual([]); // no yield was sent → B never acquired
    expect(coordA.isAwake).toBe(true); // A kept the lease
  }, 15000);

  it('operator trigger is alive: POST /handoff/initiate returns the sentinel outcome', async () => {
    currentInitiate = async () => 'handed-off';
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/handoff/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${envA.config.authToken}` },
      body: '{}',
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { outcome: string; inProgress: boolean };
    expect(body.outcome).toBe('handed-off');
    expect(body.inProgress).toBe(false);
  });

  it('operator trigger 503s honestly when not wired (server B has no onHandoffInitiate)', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_B}/handoff/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${envB.config.authToken}` },
      body: '{}',
    });
    expect(resp.status).toBe(503);
  });
});
