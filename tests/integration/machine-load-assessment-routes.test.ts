/**
 * Machine load assessment (trustworthy-machine-load B4) — integration tier.
 * The full HTTP pipeline through the real createRoutes: an installed assessor
 * labels a disagreement and GET /load-assessment/summary reports it; 503 when
 * the assessor is not constructed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { MachineLoadAssessor, installMachineLoadAssessor, getMachineLoadAssessor } from '../../src/core/MachineLoadAssessor.js';
import type { MachineCapacity } from '../../src/core/types.js';

function app(stateDir: string) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'it' },
    hookEventReceiver: new HookEventReceiver({ stateDir }),
  } as never));
  return a;
}

afterEach(() => installMachineLoadAssessor(null));

describe('machine load assessment — HTTP pipeline', () => {
  it('summary is 503 when the assessor is not constructed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-it-'));
    const res = await request(app(path.join(root, '.instar'))).get('/load-assessment/summary');
    expect(res.status).toBe(503);
  });

  it('a labelled disagreement is reported by the summary route', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-it-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const peer = {
      machineId: 'm-peer', nickname: 'Mama PC', online: true, clockSkewStatus: 'ok',
      liveness: { state: 'unreachable', shape: 'struggling', evidenceAgeMs: 300_000, evidenceAt: null, source: 'direct' },
      loadReportAgeMs: 30_000, loadVerdict: 'ok',
      loadReport: { bootId: 'b', seq: 3, sampleAgeMs: 1000, platform: 'wsl', cores: 16, totalMemBytes: null, loadPerCore: 0.4, cpuIdlePct: 70, memAvailablePct: 55, memPressureNative: 'normal', eventLoopLagP99Ms: 30, sessionsActive: 1, sessionsMax: 6, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'ok', uptimeS: 900 },
    } as unknown as MachineCapacity;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).state).toContain('requests to it are failing');
      return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: { state: { choice: 'network_problem', probabilities: { network_problem: 0.88 } } } }) } as unknown as Response;
    });
    installMachineLoadAssessor(new MachineLoadAssessor({
      getConfig: () => ({ enabled: true }), readKey: () => 'k', capacities: () => [peer], isAssessor: () => true,
      logPath: path.join(root, 'logs', 'machine-load-assessment.jsonl'), fetchImpl: fetchImpl as never,
    }));
    await getMachineLoadAssessor()!.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const res = await request(app(stateDir)).get('/load-assessment/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true, checks: 1, labels: { network_problem: 1 }, decidedBy: { jev: 1 },
      conflicts: { 'own-ok-but-unreachable': 1 }, pendingOutcomes: 1, accuracy: null,
    });
  });
});
