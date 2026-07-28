// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" (TESTING-INTEGRITY-SPEC — the single most important
 * test for a feature with API routes): is GET /session-pool/failover-runner WIRED on
 * the real AgentServer, does an ENABLED driver report an honest status through the
 * route, and does the dark ship deliver a strict 503 no-op with Bearer auth enforced?
 * (§Rollout, Track H — SessionPoolFailoverRunner boot-wiring.)
 *
 * Proves:
 *   (a) ENABLED (a real driver wired via getSessionPoolFailoverRunner): 200 with a
 *       live status; a harmless dry-run tick records a green to the SIDE store and
 *       surfaces through the route.
 *   (b) DARK (getter unwired): 503 (strict no-op).
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
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { buildSessionPoolFailoverRunnerDriver } from '../../src/core/sessionPoolFailoverRunnerConfig.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-failover-runner';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: AUTH, dashboardPin: '000000',
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
function makeStore(dir: string, name: string): SessionPoolE2EResultStore {
  return new SessionPoolE2EResultStore({ filePath: path.join(dir, name), sign: (c) => `s${c.length}`, verifySig: (c, s) => s === `s${c.length}` });
}

describe('SessionPoolFailoverRunner route E2E (feature is alive)', () => {
  let tmpDir: string;
  let enabledServer: AgentServer; let enabledApp: express.Express;
  let darkServer: AgentServer; let darkApp: express.Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-runner-e2e-'));
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 3_600_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(enabledStateDir, 'real.json'),
      dryRunResultStore: makeStore(enabledStateDir, 'dry.json'),
      // A deterministic fake — zero real subprocess: a genuine green verdict.
      runProcess: async () => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'e2e-green' }),
      currentCommitSha: () => 'e2e-commit',
      provenStage: () => 0,
    })!;
    await driver.maybeTick(); // one harmless dry-run tick

    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      getSessionPoolFailoverRunner: () => driver.status(),
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
      // getSessionPoolFailoverRunner omitted → dark
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/session-pool-failover-runner-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: GET /session-pool/failover-runner → 200 with a live status (the dry-run tick surfaced a green)', async () => {
    const r = await request(enabledApp).get('/session-pool/failover-runner').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.resultsSink).toBe('dry-run');
    expect(r.body.provenStage).toBe(0);
    expect(r.body.commitSha).toBe('e2e-commit');
    expect(r.body.lastOutcome).toBe('green');
    expect(r.body.lastRecorded).toBe(true);
    expect(r.body.counters.recordedGreen).toBe(1);
  });

  it('(b) DARK: GET /session-pool/failover-runner → 503 (strict no-op)', async () => {
    expect((await request(darkApp).get('/session-pool/failover-runner').set(auth())).status).toBe(503);
  });

  it('(c) Bearer auth is required', async () => {
    expect((await request(enabledApp).get('/session-pool/failover-runner')).status).toBe(401);
  });
});
