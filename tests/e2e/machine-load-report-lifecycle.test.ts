/**
 * E2E lifecycle — trustworthy-machine-load-and-mesh-floor P1 (Tier 3).
 *
 * Mirrors the production init in commands/server.ts: a REAL MachineLoadSampler
 * over the REAL OS readers (vm_stat / sysctl / proc) is started and awaited, the
 * self heartbeat carries its report (the same O(1) `read()`), and a REAL
 * AgentServer answers GET /pool with the report present. Proves the feature is
 * ALIVE after production-shaped init on this platform: a report exists, carries
 * identity + a sample age, and the verdict is a table output — not a 503, not a
 * blank, not `ok` by default.
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
import { MachineLoadSampler, LOAD_REPORT_MAX_AGE_MS } from '../../src/core/machineLoadReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';

const AUTH = 'test-load-report-e2e';
const auth = { Authorization: `Bearer ${AUTH}` };

function identity(machineId: string, name: string): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform: 'darwin-arm64', createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

describe('machine load report — alive after production-shaped init', () => {
  let dir: string;
  let sampler: MachineLoadSampler;
  let server: AgentServer;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-report-e2e-'));
    const idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity('m_self', 'this-box'), 'awake');
    idMgr.registerMachine(identity('m_peer', 'other-box'), 'standby');
    idMgr.recordSelfHardware('m_self', captureHardware('1.3.1436'));

    const registry = new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 15 * 60_000,
      evidenceStore: new MachineEvidenceStore(dir),
      selfMachineId: () => 'm_self',
    });

    // Production init shape (commands/server.ts): real readers, awaited first sample,
    // then the self beat reads the cache — exactly what refreshPool does.
    sampler = new MachineLoadSampler({
      sessions: () => ({ active: 1, max: 10 }),
      spawnCapSaturated: () => false,
      testRunnerSaturated: () => false,
    });
    await sampler.start();
    const refreshPool = (): void => {
      const lr = sampler.read();
      const obs: HeartbeatObservation = {
        machineId: 'm_self',
        selfReportedLastSeen: new Date().toISOString(),
        loadAvg: os.loadavg()[0],
        ...(lr ? { loadReport: lr, ...(lr.sessionsActive !== null ? { activeSessionCount: lr.sessionsActive } : {}), ...(lr.sessionsMax !== null ? { maxSessions: lr.sessionsMax } : {}) } : {}),
      };
      registry.recordHeartbeat(obs);
    };
    refreshPool();

    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: 'm_self', leaseEpoch: 1, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1, awakeMachineCountSource: 'lease-live' }),
      managers: { identityManager: idMgr },
    };
    server = new AgentServer({
      config: { authToken: AUTH, stateDir: dir, port: 0 } as any,
      stateDir: dir,
      coordinator,
      machinePoolRegistry: registry,
      meshSelfId: 'm_self',
    } as any);
  });

  afterEach(() => {
    sampler.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/machine-load-report-lifecycle.test.ts' });
  });

  it('GET /pool shows the self machine LIVE with a real load report; the peer reads unknown, never ok', async () => {
    const res = await request(server.getApp()).get('/pool').set(auth);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.machines.map((m: any) => [m.machineId, m]));
    const self = byId.m_self;
    expect(self.liveness).toMatchObject({ state: 'live', source: 'self' });
    expect(self.livenessLine).toBe('live (this machine)');
    expect(self.loadReport).toBeTruthy();
    expect(typeof self.loadReport.bootId).toBe('string');
    expect(self.loadReport.seq).toBe(0);
    expect(self.loadReport.cores).toBe(os.cpus().length);
    expect(self.loadReport.totalMemBytes).toBe(os.totalmem());
    expect(self.loadReport.sessionsActive).toBe(1);
    expect(self.activeSessionCount).toBe(1); // the never-populated field is now filled
    expect(self.maxSessions).toBe(10);
    expect(self.loadReportAgeMs).toBeLessThan(LOAD_REPORT_MAX_AGE_MS);
    expect(['ok', 'elevated', 'saturated', 'impaired', 'unknown']).toContain(self.loadVerdict);
    // On darwin/linux the real readers answer, so memory is present (a real number, not a substitute).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(typeof self.loadReport.memAvailablePct).toBe('number');
      expect(self.loadReport.memAvailablePct).toBeGreaterThan(0);
      expect(self.loadReport.loadPerCore).toBeGreaterThanOrEqual(0);
    }
    expect(byId.m_peer.loadVerdict).toBe('unknown');
    expect(byId.m_peer.liveness.state).toBe('unknown');
    expect(byId.m_peer.livenessLine).not.toMatch(/offline/i);
  });

  it('the sampler keeps sampling on its cadence and the report identity advances (seq) while bootId holds', async () => {
    const first = sampler.read()!;
    await sampler.sampleOnce();
    const second = sampler.read()!;
    expect(second.bootId).toBe(first.bootId);
    expect(second.seq).toBe(first.seq + 1);
    // The second sample has a CPU delta, so idle% is a real measurement.
    if (os.cpus().length > 0) expect(typeof second.cpuIdlePct).toBe('number');
  });
});
