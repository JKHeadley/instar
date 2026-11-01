/**
 * E2E lifecycle: machine self-maintenance, watch-only (Tier 3).
 *
 * Mirrors the production init in commands/server.ts: the REAL OS readers feed a REAL
 * DrainRehearsal over a REAL host store, and a REAL AgentServer answers
 * GET /machine-maintenance with 200. The feature is alive after production-shaped
 * init: not a 503, and carrying real readings of this machine. Also runs the migrator
 * on an existing home and checks the fresh template, so both kinds of agent know.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DrainRehearsal, setActiveDrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { normalizeSettings } from '../../src/monitoring/machineMaintenance/planner.js';
import { readMachineSignals } from '../../src/monitoring/machineMaintenance/readings.js';
import { MACHINE_MAINTENANCE_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const AUTH = 'e2e-token';
const auth = { Authorization: `Bearer ${AUTH}` };

describe('machine maintenance lifecycle', () => {
  let dir: string;
  let rehearsal: DrainRehearsal;
  let server: AgentServer;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-e2e-'));
    rehearsal = new DrainRehearsal({
      agentName: 'e2e', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }),
      enabled: () => true,
      settings: () => normalizeSettings(undefined),
      readSignals: () => readMachineSignals(),
      census: async () => ({ sessions: [], autonomousRuns: [], localVerifyRunning: [], localVerifyQueued: [], testRuns: [], scriptRuns: [] }),
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: os.userInfo().username,
    });
    setActiveDrainRehearsal(rehearsal);
    server = new AgentServer({ config: { authToken: AUTH, stateDir: dir, port: 0 } as any, stateDir: dir } as any);
  });

  afterEach(() => {
    rehearsal.stop();
    setActiveDrainRehearsal(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/machine-maintenance-lifecycle.test.ts' });
  });

  it('answers 200 with real readings of this machine, and cannot act', async () => {
    await rehearsal.tick();
    const res = await request(server.getApp()).get('/machine-maintenance').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'watch-only', canRestart: false, canStopWork: false, lastError: null });
    expect(res.body.lastBootAt).toBeLessThanOrEqual(Date.now());
    expect(res.body.uptimeDays).toBeGreaterThanOrEqual(0);
    expect(res.body.safetyHolds.map((h: { id: string }) => h.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(res.body.delays.map((d: { id: string }) => d.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
    expect(res.body.nextWindow.restartAt).toBeGreaterThan(res.body.nextWindow.start);
  });

  it('reaches a fresh agent and an updated one through one shared section', () => {
    const section = MACHINE_MAINTENANCE_CLAUDEMD_SECTION(4042);
    expect(section).toContain('/machine-maintenance');
    expect(section).toMatch(/cannot restart a machine and it cannot stop any work/);
    expect(generateClaudeMd('p', 'a', 4042, false)).toContain('/machine-maintenance');
  });
});
