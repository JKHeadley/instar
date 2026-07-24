// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" (TESTING-INTEGRITY-SPEC — the single most important test for a
 * feature with API routes): is the single-machine failover-gap route WIRED on the real
 * AgentServer, does a REAL detector tick harmlessly and report an honest status, and does the
 * dark ship deliver a strict 503 no-op? (increment 2.)
 *
 * Proves:
 *   (a) ENABLED (a real detector wired via getSingleMachineFailoverGap): GET /pool/failover-gap
 *       → 200 with a live status(); a harmless tick advances lastTickAt.
 *   (b) DARK (getter omitted): GET /pool/failover-gap → 503 (strict no-op).
 *   (c) Bearer auth is required.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { makeSingleMachineFailoverGapDetector } from '../../src/monitoring/singleMachineFailoverGapWiring.js';
import type { SingleMachineFailoverGapDetector } from '../../src/monitoring/SingleMachineFailoverGapDetector.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-failover-gap';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}
function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

function buildDetector(): SingleMachineFailoverGapDetector {
  return makeSingleMachineFailoverGapDetector({
    enabled: () => true,
    dryRun: () => true, // dry-run first — a harmless tick raises nothing
    getCapacities: () => [{ machineId: 'self', online: true }], // single-machine
    selfMachineId: () => 'self',
    multiMachineEnabled: () => false,
    getActiveAutonomousRunCount: () => 0, // no active work → no gap → benign tick
    createAttentionItem: () => { throw new Error('e2e: must not raise on a benign tick'); },
  });
}

describe('single-machine failover-gap route E2E (feature is alive)', () => {
  let tmpDir: string;
  let enabledServer: AgentServer; let enabledApp: express.Express;
  let darkServer: AgentServer; let darkApp: express.Express;
  let detector: SingleMachineFailoverGapDetector;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smfg-e2e-'));
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    detector = buildDetector();
    detector.tick(); // one harmless tick (no active work → no gap, no raise)
    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      getSingleMachineFailoverGap: () => detector,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
      // getSingleMachineFailoverGap omitted → dark
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/single-machine-failover-gap-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: GET /pool/failover-gap → 200 with a live status(); the tick advanced lastTickAt', async () => {
    const r = await request(enabledApp).get('/pool/failover-gap').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.lastTickAt).not.toBeNull();
    expect(r.body.singleMachine).toBe(true);
    expect(r.body.openGapMode).toBeNull(); // no active work → no open gap
    expect(typeof r.body.counters.ticks).toBe('number');
  });

  it('(b) DARK: GET /pool/failover-gap → 503 (strict no-op)', async () => {
    expect((await request(darkApp).get('/pool/failover-gap').set(auth())).status).toBe(503);
  });

  it('(c) Bearer auth is required', async () => {
    expect((await request(enabledApp).get('/pool/failover-gap')).status).toBe(401); // no Bearer
  });
});
