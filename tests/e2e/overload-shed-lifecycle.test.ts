/**
 * E2E lifecycle — trustworthy-machine-load-and-mesh-floor P3 (Tier 3).
 *
 * Mirrors the production init in commands/server.ts: a REAL WorkAdmission (closed,
 * enforcing) advertises through the REAL MachinePoolRegistry, a REAL
 * OverloadShedPlanner reads that registry's capacities and the REAL ownership
 * registry, and a REAL OwnershipReconciler consumes the planner's overloadMoves()
 * — the move actually becomes a `transferring` record — while a REAL AgentServer
 * answers GET /overload-shed with 200 (alive, not 503).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MachinePoolRegistry, captureHardware } from '../../src/core/MachinePoolRegistry.js';
import { MachineEvidenceStore } from '../../src/core/MachineEvidenceStore.js';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import { WorkAdmission, DEFAULT_WORK_ADMISSION } from '../../src/core/workAdmission.js';
import { OverloadShedPlanner, DEFAULT_OVERLOAD_SHED, setActiveOverloadShedPlanner } from '../../src/core/OverloadShedPlanner.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import { SessionDrainRunner } from '../../src/core/SessionDrainRunner.js';
import { RebalanceProofRunner, setActiveRebalanceProof } from '../../src/core/rebalanceProof.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';

const AUTH = 'test-overload-shed-e2e';
const auth = { Authorization: `Bearer ${AUTH}` };

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}
function loadReport(over: Partial<MachineLoadReport>): MachineLoadReport {
  return {
    bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: 8, totalMemBytes: 1, loadPerCore: 0.5,
    cpuIdlePct: 60, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 10,
    sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false,
    verdict: 'ok', uptimeS: 1000, ...over,
  };
}

describe('overload shed — alive after production-shaped init', () => {
  let dir: string;
  let server: AgentServer;
  let planner: OverloadShedPlanner;
  let reconciler: OwnershipReconciler;
  let ownReg: SessionOwnershipRegistry;
  let now: number;
  let registry: MachinePoolRegistry;
  let admission: WorkAdmission;
  const dryRun = { value: DEFAULT_OVERLOAD_SHED.dryRun };
  const stage = { value: 'rebalance' };
  const sessionIdle = { value: true };
  const closed: string[] = [];
  let drainDone: Promise<void> = Promise.resolve();

  const beat = () => {
    const self = admission.advert();
    registry.recordHeartbeat({ machineId: 'm_self', selfReportedLastSeen: new Date().toISOString(), activeSessionCount: 10, maxSessions: 10,
      loadReport: loadReport({ verdict: 'saturated', ...(self ? { acceptingWork: self.acceptingWork, admissionEnforced: self.enforced } : {}) }) });
    // Exactly what PeerPresencePuller records: the load report, not the session fields.
    // Feeding those by hand is what hid the peers' missing capacity for months.
    registry.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date().toISOString(), loadReport: loadReport({ sessionsActive: 1, sessionsMax: 10 }) });
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overload-shed-e2e-'));
    now = Date.now();
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity('m_self', 'this-box'), 'awake');
    idMgr.registerMachine(identity('m_peer', 'other-box'), 'standby');
    idMgr.recordSelfHardware('m_self', captureHardware('1.3.1440'));
    registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 15 * 60_000,
      evidenceStore: new MachineEvidenceStore(dir),
      selfMachineId: () => 'm_self',
    });
    admission = new WorkAdmission({
      config: () => ({ enabled: true, ...DEFAULT_WORK_ADMISSION, dryRun: false }),
      recoverySlot: new HostSpawnSemaphore({ holdersPath: path.join(dir, 'host-recovery-slot.json'), cap: 1, isPathHostLocal: () => true }),
      agentName: 'e2e',
    });
    admission.observe('saturated'); // closed and enforcing
    beat();

    const nonces = new Set<string>();
    ownReg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
    ownReg.cas({ type: 'place', machineId: 'm_self' }, { sessionKey: '601', sender: 'm_self', nonce: 'p' });
    ownReg.cas({ type: 'claim', machineId: 'm_self' }, { sessionKey: '601', sender: 'm_self', nonce: 'c' });
    const pins = new TopicPlacementPinStore({ filePath: path.join(dir, 'pins.json') });

    // Production shape (commands/server.ts): the planner reads the pool registry and
    // ownership registry; the reconciler reads planner.overloadMoves().
    planner = new OverloadShedPlanner({
      config: () => ({ ...DEFAULT_OVERLOAD_SHED, enabled: true, dryRun: dryRun.value }),
      selfMachineId: () => 'm_self',
      admission: () => admission.advert(),
      capacities: () => registry.getCapacities(),
      ownedTopics: () => ownReg.all().filter((r) => r.status === 'active' && r.ownerMachineId === 'm_self').map((r) => ({ sessionKey: r.sessionKey, pinned: !!pins.get(r.sessionKey) })),
      ownerOf: (k) => ownReg.read(k)?.ownerMachineId,
      placement: new PlacementExecutor(),
      poolStage: () => stage.value,
      proofFresh: () => true,
      quietTopics: () => new Set(['601']),
      statePath: path.join(dir, 'state', 'overload-shed.json'),
      auditPath: path.join(dir, 'logs', 'overload-shed.jsonl'),
      now: () => now,
    });
    setActiveOverloadShedPlanner(planner);
    reconciler = new OwnershipReconciler({
      enabled: () => true,
      dryRun: () => false,
      selfMachineId: () => 'm_self',
      pinStore: () => pins,
      ownership: ownReg,
      machines: () => registry.getCapacities().map((c) => ({ machineId: c.machineId, online: !!c.online, lastSeenMs: c.routerReceivedAt ? Date.parse(c.routerReceivedAt) : 0 })),
      isTopicBusy: () => false,
      emitPlacement: () => {},
      debounceMs: 0,
      overloadMoves: () => planner.overloadMoves(),
      driveUnpinnedTransfers: () => true,
      // Production shape: the real owner-side drain closes the session and lands the claim.
      drainMove: (mv, epoch) => {
        drainDone = drainRunner.run({ sessionKey: mv.sessionKey, target: mv.target, senderObservedEpoch: epoch, onNotQuiet: 'abort' })
          .then((o) => planner.noteMoveOutcome(mv.sessionKey, { status: o.status, claimLanded: o.claimLanded }));
      },
    });
    let n = 0;
    const drainRunner = new SessionDrainRunner({
      selfMachineId: 'm_self',
      readOwnership: (k) => ownReg.read(k),
      cas: (action, c) => ownReg.cas(action, c),
      suspendAutonomousRun: () => ({ suspended: false }),
      sessionQuiet: () => true,
      sessionIdleNow: async () => sessionIdle.value,
      emergencyStopActive: () => false,
      terminateSession: async (k) => { closed.push(k); return { terminated: true }; },
      markInterrupted: () => {},
      notifyInterrupted: () => {},
      now: () => now,
      sleep: async () => {},
      nonce: () => `drain-${++n}`,
    });

    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: 'm_self', leaseEpoch: 1, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 2, awakeMachineCountSource: 'lease-live' }),
      managers: { identityManager: idMgr },
    };
    server = new AgentServer({ config: { authToken: AUTH, stateDir: dir, port: 0 } as any, stateDir: dir, coordinator, machinePoolRegistry: registry, meshSelfId: 'm_self' } as any);
  });

  afterEach(() => {
    setActiveOverloadShedPlanner(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/overload-shed-lifecycle.test.ts' });
  });

  it('GET /overload-shed answers 200 with the shipped dry-run posture; dry-run moves nothing', async () => {
    planner.tick();
    now += 4 * 60_000;
    beat();
    planner.tick();
    const st = await request(server.getApp()).get('/overload-shed').set(auth);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, dryRun: true, isSource: true, liveMove: null });
    expect(reconciler.tick().transfers).toBe(0);
    expect(ownReg.read('601')?.status).toBe('active');
  });

  const reachLiveMove = async () => {
    planner.tick();
    now += 4 * 60_000;
    beat();
    planner.tick();
  };

  it('live: planner → reconciler → drain closes the session here and the peer owns the conversation', async () => {
    dryRun.value = false;
    closed.length = 0;
    try {
      await reachLiveMove();
      const st = await request(server.getApp()).get('/overload-shed').set(auth);
      expect(st.body.liveMove).toMatchObject({ sessionKey: '601', target: 'm_peer' });
      expect(reconciler.tick().overloadTransfers).toBe(1);
      await drainDone;
      expect(closed).toEqual(['601']);
      expect(ownReg.read('601')).toMatchObject({ status: 'active', ownerMachineId: 'm_peer' });
      const log = fs.readFileSync(path.join(dir, 'logs', 'overload-shed.jsonl'), 'utf-8');
      expect(log).toContain('"event":"proposed"');
      expect(log).toContain('"event":"move-outcome"');
      expect((await request(server.getApp()).get('/overload-shed').set(auth)).body.liveMove).toBeNull();
    } finally { dryRun.value = DEFAULT_OVERLOAD_SHED.dryRun; }
  });

  it('live: a session that is not idle stays running here and the conversation does not move', async () => {
    dryRun.value = false;
    sessionIdle.value = false;
    closed.length = 0;
    try {
      await reachLiveMove();
      reconciler.tick();
      await drainDone;
      expect(closed).toEqual([]);
      expect(ownReg.read('601')).toMatchObject({ status: 'active', ownerMachineId: 'm_self' });
    } finally { dryRun.value = DEFAULT_OVERLOAD_SHED.dryRun; sessionIdle.value = true; }
  });

  it('below stage rebalance nothing moves even with dry-run off', async () => {
    dryRun.value = false;
    stage.value = 'live-transfer';
    try {
      await reachLiveMove();
      expect(reconciler.tick().overloadTransfers ?? 0).toBe(0);
      expect(ownReg.read('601')?.status).toBe('active');
    } finally { dryRun.value = DEFAULT_OVERLOAD_SHED.dryRun; stage.value = 'rebalance'; }
  });

  it('the rebalance-proof route is alive and refuses a topic it was not given', async () => {
    const runner = new RebalanceProofRunner({
      selfMachineId: () => 'm_self', isProofTopic: () => false, stageAllowsProof: () => true, stage: () => 'live-transfer',
      readRecord: () => null, hasLocalSession: () => false, ensureIdleSession: async () => true,
      move: () => ({ refused: 'x' }), sendProbe: async () => 'forwarded', readHistory: async () => ({ rows: [], failed: [] }),
      record: () => {}, writeEvidence: () => 'e', newNonce: () => 'n',
    });
    setActiveRebalanceProof(runner);
    try {
      const r = await request(server.getApp()).post('/session-pool/rebalance-proof').set(auth).send({ topic: 601, to: 'm_peer' });
      expect(r.status).toBe(409);
      expect(r.body.refused).toBe('not-a-proof-topic');
      const bad = await request(server.getApp()).post('/session-pool/rebalance-proof').set(auth).send({ topic: 'x' });
      expect(bad.status).toBe(400);
      const none = await request(server.getApp()).post('/session-pool/rebalance-proof').send({ topic: 601, to: 'm_peer' });
      expect(none.status).toBe(401);
    } finally { setActiveRebalanceProof(null); }
    const off = await request(server.getApp()).post('/session-pool/rebalance-proof').set(auth).send({ topic: 601, to: 'm_peer' });
    expect(off.status).toBe(503);
  });
});
