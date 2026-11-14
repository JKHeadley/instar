/**
 * Tier-3 "feature is alive" E2E for resource-aware placement
 * (docs/specs/resource-aware-placement.md §6): the preview and the placed-helper route
 * are reachable through the REAL AgentServer stack (auth middleware, error handling)
 * with a real MachinePoolRegistry, and answer 200 / a real decision — not 503 because a
 * dependency was not wired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';

const GIB = 1024 ** 3;
function report(cores: number, memGiB: number, loadPerCore: number, verdict: MachineLoadReport['verdict'] = 'ok'): MachineLoadReport {
  return {
    bootId: 'boot', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: memGiB * GIB, loadPerCore,
    cpuIdlePct: 40, memAvailablePct: 40, memPressureNative: 'normal', eventLoopLagP99Ms: 5, sessionsActive: 1, sessionsMax: 10,
    spawnCapSaturated: false, testRunnerSaturated: false, verdict, uptimeS: 1000,
  };
}

describe('E2E: resource-aware placement routes are ALIVE through the real AgentServer', () => {
  const TOKEN = 'e2e-token';
  let dir: string;
  let server: AgentServer;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-alive-e2e-'));
    const registry = new MachinePoolRegistry({
      listMachines: () => [
        { machineId: 'm_studio', nickname: 'Mac Studio' },
        { machineId: 'm_m5', nickname: 'Mac M5 Pro' },
        { machineId: 'm_mini', nickname: 'Mac Mini' },
      ],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    const beat = (machineId: string, r: MachineLoadReport, loadAvg: number) =>
      registry.recordHeartbeat({ machineId, selfReportedLastSeen: new Date().toISOString(), loadAvg, loadReport: r } as never);
    beat('m_studio', report(16, 64, 1.5, 'saturated'), 24);
    beat('m_m5', report(18, 48, 1.3), 23.4); // big but busy
    beat('m_mini', report(10, 16, 0.1), 1); // idle but small

    const config = { projectName: 'rap-alive-e2e', projectDir: dir, stateDir: dir, port: 0, authToken: TOKEN } as unknown as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: 0 }),
      state: new StateManager(dir),
      machinePoolRegistry: registry,
      meshSelfId: 'm_studio',
      resolvePeerUrls: () => [],
    } as never);
    await server.start();
    base = boundAgentServerBase(server);
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/resource-aware-placement-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('GET /pool/placement/preview is ALIVE (200, not 503) with a real decision and rows', async () => {
    const res = await fetch(`${base}/pool/placement/preview?workWeight=heavy`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toMatchObject({ outcome: 'queued', reason: 'heavy-capable-machines-busy' });
    expect(body.machines.map((m: { why: string }) => m.why).sort()).toEqual(['machine-busy', 'machine-busy', 'machine-too-small']);
    const light = await (await fetch(`${base}/pool/placement/preview?workWeight=light`, { headers: auth })).json();
    expect(light.decision.chosenMachine).toBe('m_mini');
  });

  it('POST /pool/heavy-work/spawn is ALIVE: it decides and refuses to pile on (409), sending nothing', async () => {
    const res = await fetch(`${base}/pool/heavy-work/spawn`, {
      method: 'POST', headers: { ...auth, 'X-Instar-Request': '1' }, body: JSON.stringify({ name: 'heavy-helper', prompt: 'build' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('heavy-work-no-machine');
  });

  it('the routes sit behind auth', async () => {
    const res = await fetch(`${base}/pool/placement/preview?workWeight=heavy`);
    expect([401, 403]).toContain(res.status);
  });
});
