/**
 * E2E lifecycle — trustworthy-machine-load-and-mesh-floor P2 (Tier 3).
 *
 * Mirrors the production init in commands/server.ts: a REAL MachineLoadSampler
 * over the REAL OS readers feeds a REAL WorkAdmission (onSample) and advertises
 * its state in the report (admission), the self heartbeat carries that report
 * into a REAL MachinePoolRegistry, and a REAL AgentServer answers GET /pool with
 * `loadReport.acceptingWork` / `admissionEnforced` and GET /work-admission with
 * 200 — proving the feature is ALIVE after production-shaped init: not a 503,
 * not a blank advert, and the dry-run posture visible to peers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MachinePoolRegistry, captureHardware, type HeartbeatObservation } from '../../src/core/MachinePoolRegistry.js';
import { MachineEvidenceStore } from '../../src/core/MachineEvidenceStore.js';
import { MachineLoadSampler } from '../../src/core/machineLoadReport.js';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import { WorkAdmission, setActiveWorkAdmission, DEFAULT_WORK_ADMISSION } from '../../src/core/workAdmission.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';

const AUTH = 'test-work-admission-e2e';
const auth = { Authorization: `Bearer ${AUTH}` };

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

describe('overload admission — alive after production-shaped init', () => {
  let dir: string;
  let sampler: MachineLoadSampler;
  let server: AgentServer;
  let admission: WorkAdmission;
  let registry: MachinePoolRegistry;
  let refreshPool: () => void;
  const dryRun = { value: DEFAULT_WORK_ADMISSION.dryRun };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-admission-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity('m_self', 'this-box'), 'awake');
    idMgr.recordSelfHardware('m_self', captureHardware('1.3.1440'));
    registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 15 * 60_000,
      evidenceStore: new MachineEvidenceStore(dir),
      selfMachineId: () => 'm_self',
    });

    // Production shape (commands/server.ts): admission is constructed with the
    // default (dry-run) posture, the sampler feeds it on every sample and reads
    // its advert at report time, and the process-wide handle serves the route.
    admission = new WorkAdmission({
      config: () => ({ enabled: true, ...DEFAULT_WORK_ADMISSION, dryRun: dryRun.value }),
      recoverySlot: new HostSpawnSemaphore({ holdersPath: path.join(dir, 'host-recovery-slot.json'), cap: 1, isPathHostLocal: () => true }),
      runningSessionNames: () => [],
      agentName: 'e2e',
      auditPath: path.join(dir, 'logs', 'work-admission.jsonl'),
    });
    setActiveWorkAdmission(admission);
    sampler = new MachineLoadSampler({
      sessions: () => ({ active: 1, max: 10 }),
      spawnCapSaturated: () => false,
      testRunnerSaturated: () => false,
      onSample: (v) => admission.observe(v),
      admission: () => admission.advert(),
    });
    await sampler.start();
    refreshPool = () => {
      const lr = sampler.read();
      const obs: HeartbeatObservation = { machineId: 'm_self', selfReportedLastSeen: new Date().toISOString(), loadAvg: os.loadavg()[0], ...(lr ? { loadReport: lr } : {}) };
      registry.recordHeartbeat(obs);
    };
    refreshPool();

    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: 'm_self', leaseEpoch: 1, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1, awakeMachineCountSource: 'lease-live' }),
      managers: { identityManager: idMgr },
    };
    server = new AgentServer({ config: { authToken: AUTH, stateDir: dir, port: 0 } as any, stateDir: dir, coordinator, machinePoolRegistry: registry, meshSelfId: 'm_self' } as any);
  });

  afterEach(() => {
    sampler.stop();
    setActiveWorkAdmission(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/work-admission-lifecycle.test.ts' });
  });

  it('GET /work-admission answers 200 with the dry-run posture and the real verdict feed; GET /pool advertises acceptingWork', async () => {
    const st = await request(server.getApp()).get('/work-admission').set(auth);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, dryRun: true, enforced: false, acceptingWork: true, recoverySlot: { cap: 1, inUse: 0 } });
    expect(['ok', 'elevated', 'saturated', 'impaired', 'unknown']).toContain(st.body.lastVerdict);
    expect(st.body.lastVerdict).toBe(sampler.verdict()); // the sampler really fed it

    const pool = await request(server.getApp()).get('/pool').set(auth);
    expect(pool.status).toBe(200);
    const self = pool.body.machines.find((m: any) => m.machineId === 'm_self');
    expect(self.loadReport.acceptingWork).toBe(true);
    expect(self.loadReport.admissionEnforced).toBe(false); // dry-run: peers keep placing here
  });

  it('a closed, enforcing machine advertises acceptingWork:false + admissionEnforced:true through the same report path', async () => {
    dryRun.value = false;
    admission.observe('saturated'); // the production feed is onSample; drive it directly once
    refreshPool();
    const pool = await request(server.getApp()).get('/pool').set(auth);
    const self = pool.body.machines.find((m: any) => m.machineId === 'm_self');
    expect(self.loadReport.acceptingWork).toBe(false);
    expect(self.loadReport.admissionEnforced).toBe(true);
    const st = await request(server.getApp()).get('/work-admission').set(auth);
    expect(st.body).toMatchObject({ enforced: true, acceptingWork: false, lastVerdict: 'saturated' });
    expect(fs.existsSync(path.join(dir, 'logs', 'work-admission.jsonl'))).toBe(true);
  });
});
