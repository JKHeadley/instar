/**
 * Tier-3 "feature is alive" E2E for the start-failure placement cause.
 *
 * The unit tests prove the counter and the gate in isolation. They cannot prove
 * the thing that actually failed on 2026-10-20: that the signal TRAVELS — from a
 * machine's capacity heartbeat, through the pool registry, into the placement
 * decision, and out of the routes an operator reads.
 *
 * That journey is the whole fix. A machine killing every session it started
 * looked like the healthiest candidate in the pool (no load, no sessions,
 * untouched quota) and kept being chosen for 35 minutes while the operator
 * watched an empty conversation. So this drives the REAL AgentServer stack and
 * asserts the honest answer comes back out of `GET /pool/placement` and `GET
 * /pool`.
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

function identity(machineId: string, name: string): MachineIdentity {
  return {
    machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name,
    platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
}

describe('E2E: a machine that cannot start a session is not chosen, through the real stack', () => {
  // SELF is the healthy machine; BROKEN is the one whose sessions die on arrival.
  const SELF = 'm_healthy';
  const BROKEN = 'm_cannot_start';
  const TOKEN = 'e2e-token';
  let dir: string;
  let server: AgentServer;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-failure-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity(SELF, 'mac-studio'), 'awake');
    idMgr.registerMachine(identity(BROKEN, 'mac-mini'), 'standby');
    idMgr.recordSelfHardware(SELF, captureHardware('1.3.75'));

    const registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({
        machineId, nickname: entry.nickname, hardware: entry.hardware,
      })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });

    // The broken machine looks BETTER than the healthy one on every signal
    // placement used to score on — lower load, no sessions. That is exactly how
    // it kept winning. Its one honest signal is the new start-failure cause,
    // carried on the same placement-eligibility field as quota and the circuit.
    registry.recordHeartbeat({
      machineId: SELF, selfReportedLastSeen: new Date().toISOString(), loadAvg: 4,
      activeSessionCount: 3, maxSessions: 5,
    });
    registry.recordHeartbeat({
      machineId: BROKEN, selfReportedLastSeen: new Date().toISOString(), loadAvg: 0,
      activeSessionCount: 0, maxSessions: 5,
      quotaState: { blocked: true, reason: 'session-start-failing' },
    });

    const seen = new Set<string>();
    const ownReg = new SessionOwnershipRegistry({
      store: new InMemorySessionOwnershipStore(),
      seenNonce: (k) => seen.has(k),
      recordNonce: (k) => seen.add(k),
    });

    const config = {
      projectName: 'start-failure-e2e', projectDir: dir, stateDir: dir, port: 0, authToken: TOKEN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: 0 }),
      state: new StateManager(dir),
      machinePoolRegistry: registry,
      sessionOwnershipRegistry: ownReg,
      topicPinStore: new TopicPlacementPinStore({ filePath: path.join(dir, 'topic-pins.json') }),
      meshSelfId: SELF,
      resolveRouterUrl: () => null,
    });
    await server.start();
    base = boundAgentServerBase(server);
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'tests/e2e/placement-start-failure-alive.test.ts',
    });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('GET /pool is ALIVE and reports the start-failure cause by name', async () => {
    const res = await fetch(`${base}/pool`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    const broken = (body.machines ?? []).find((m: { machineId: string }) => m.machineId === BROKEN);
    expect(broken).toBeTruthy();
    // Named, not just "blocked" — an operator told "quota" about a machine whose
    // logins cannot answer a trust dialog goes and looks at the wrong thing.
    expect(broken.quotaState?.blocked).toBe(true);
    expect(broken.quotaState?.reason).toBe('session-start-failing');
  });

  it('GET /pool/placement is ALIVE and does NOT answer with the broken machine', async () => {
    const res = await fetch(`${base}/pool/placement?topic=9001`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The whole point: the idle-looking machine that cannot start a session is
    // not the answer, even though it wins on load and session count.
    expect(body.owner).not.toBe(BROKEN);
  });

  it('the healthy machine is still reported as a normal candidate', async () => {
    const res = await fetch(`${base}/pool`, { headers: auth });
    const body = await res.json();
    const healthy = (body.machines ?? []).find((m: { machineId: string }) => m.machineId === SELF);
    expect(healthy).toBeTruthy();
    expect(healthy.quotaState?.blocked ?? false).toBe(false);
  });
});
