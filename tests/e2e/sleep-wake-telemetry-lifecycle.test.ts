/**
 * Tier-3 E2E "feature is alive" lifecycle test for the SleepWakeDetector
 * CPU-starvation guard telemetry route (GET /monitoring/sleep-wake).
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for any feature with
 * API routes — is it actually alive on the production init path (200, not 503)?
 * This boots the REAL AgentServer (the same class server.ts uses) and verifies:
 *   1. With a SleepWakeDetector wired (as server.ts wires it), the route is alive.
 *   2. Wake + suppression telemetry surfaces end-to-end through the live route.
 *   3. Without a detector (standby / older boot path), the route 503s — never crashes.
 *   4. The route is Bearer-auth-gated like every non-/health route.
 *   5. Wiring integrity: server.ts actually passes sleepWakeDetector into AgentServer
 *      (the production call site — what makes #1 true in real boots, not just here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function makeConfig(tmpDir: string, stateDir: string, auth: string): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

describe('SleepWakeDetector telemetry E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let detector: SleepWakeDetector;
  const AUTH = 'test-e2e-sleep-wake-telemetry';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepwake-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // Mirror server.ts: construct the detector and hand it to AgentServer.
    detector = new SleepWakeDetector();
    // Seed one real wake + one suppressed starvation drift so telemetry has shape.
    const internals = detector as unknown as {
      wakeHistory: Array<{ sleepDurationSeconds: number; timestamp: string }>;
      suppressionHistory: Array<{ reason: string; driftSeconds: number; loadRatio: number; timestamp: string }>;
    };
    internals.wakeHistory.push({ sleepDurationSeconds: 600, timestamp: new Date(1000).toISOString() });
    internals.suppressionHistory.push({ reason: 'cpu-starvation', driftSeconds: 9, loadRatio: 2.5, timestamp: new Date(2000).toISOString() });

    server = new AgentServer({
      config: makeConfig(tmpDir, stateDir, AUTH),
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      sleepWakeDetector: detector,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    detector?.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/sleep-wake-telemetry-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /monitoring/sleep-wake is alive — returns 200, not 503', async () => {
    const res = await request(app).get('/monitoring/sleep-wake').set(auth());
    expect(res.status).toBe(200);
    expect(typeof res.body.wakeCount).toBe('number');
    expect(res.body.suppressedByReason).toBeDefined();
  });

  it('wake + suppression telemetry surfaces end-to-end through the live route', async () => {
    const res = await request(app).get('/monitoring/sleep-wake').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.wakeCount).toBe(1);
    expect(res.body.longestSleepSeconds).toBe(600);
    expect(res.body.suppressedCount).toBe(1);
    expect(res.body.suppressedByReason['cpu-starvation']).toBe(1);
    expect(res.body.lastSuppressedAt).toBe(new Date(2000).toISOString());
  });

  it('requires auth (Bearer token) like every non-/health route', async () => {
    const res = await request(app).get('/monitoring/sleep-wake'); // no auth header
    expect(res.status).toBe(401);
  });

  it('wiring integrity: server.ts passes sleepWakeDetector into AgentServer (production call site)', () => {
    // The e2e above boots AgentServer directly; this guards that the REAL boot
    // path (server.ts) actually wires the detector, so production isn't silently 503.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8');
    const agentServerCall = serverSrc.slice(serverSrc.indexOf('new AgentServer({'));
    expect(agentServerCall).toMatch(/sleepWakeDetector/);
  });

  it('standby / older boot path without a detector 503s rather than crashing', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepwake-e2e-nodet-'));
    const sd2 = path.join(tmp2, '.instar');
    fs.mkdirSync(path.join(sd2, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(sd2, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(sd2, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e2', agentName: 'E2E2' }));
    const server2 = new AgentServer({
      config: makeConfig(tmp2, sd2, AUTH),
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(sd2),
      // no sleepWakeDetector — mirrors a standby/older boot
    });
    await server2.start();
    try {
      const res = await request(server2.getApp()).get('/monitoring/sleep-wake').set(auth());
      expect(res.status).toBe(503);
    } finally {
      await server2.stop();
      SafeFsExecutor.safeRmSync(tmp2, { recursive: true, force: true, operation: 'tests/e2e/sleep-wake-telemetry-lifecycle.test.ts:nodet' });
    }
  });
});
