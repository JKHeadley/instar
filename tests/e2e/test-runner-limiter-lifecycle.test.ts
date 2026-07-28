// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E "feature is alive" lifecycle — GET /test-runner-limiter through REAL
 * AgentServer plumbing (docs/specs/test-runner-concurrency-bound.md §5 E2E,
 * docs/E2E-TESTING-STANDARD.md Tier 3).
 *
 * WHY THIS TEST EXISTS: integration tests build the express app by hand around
 * createRoutes — that proves the route works IF it's mounted. This tier boots
 * a REAL AgentServer the way production does (real config resolution, real
 * auth middleware, real error handling, server.start()) and proves the route
 * answers 200 — not 503/404-because-unwired. The route is an always-on
 * observability surface (the chokepoint ships ON in dry-run), so there is no
 * dark-gate 503 case: 200 IS the shipped posture.
 *
 * Isolation: the semaphore singleton resolves its rendezvous base dir from the
 * INSTAR_HOST_TEST_BASE_DIR env seam (resolveTestRunnerPaths) — pointed at a
 * mkdtemp universe here so the test never reads/writes the real ~/.instar.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import {
  _resetHostTestRunnerSemaphoreForTest,
  HOST_TEST_SUITE_CAP_DEFAULT,
  HOST_TEST_TARGETED_CAP_DEFAULT,
} from '../../src/core/hostTestRunnerSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-runner-limiter-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

/** Lever env vars cleared for the test so a host shell export can't skew the
 *  resolved posture/caps the alive-assertions pin. */
const LEVER_ENV_KEYS = [
  'INSTAR_HOST_TEST_BASE_DIR',
  'INSTAR_HOST_TEST_MAX',
  'INSTAR_HOST_TEST_TARGETED_MAX',
  'INSTAR_HOST_TEST_ENFORCE',
  'INSTAR_HOST_TEST_TTL_SIGNAL',
  'INSTAR_HOST_TEST_SEMAPHORE',
  'INSTAR_HOST_TEST_TTL_MS',
] as const;

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('E2E: /test-runner-limiter is ALIVE through the real AgentServer', () => {
  let tmpDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of LEVER_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trl-e2e-'));
    // Point the semaphore's rendezvous universe at the temp dir BEFORE the
    // singleton is first constructed (the route constructs it lazily).
    process.env.INSTAR_HOST_TEST_BASE_DIR = path.join(tmpDir, 'instar-base');
    _resetHostTestRunnerSemaphoreForTest();

    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const config: InstarConfig = {
      projectName: 'test-runner-limiter-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir),
    });
    await server.start();
    app = server.getApp();
  }, 30000);

  afterAll(async () => {
    await server?.stop();
    _resetHostTestRunnerSemaphoreForTest();
    for (const k of LEVER_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    try {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/test-runner-limiter-lifecycle.test.ts:afterAll',
      });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('FEATURE IS ALIVE: GET /test-runner-limiter returns 200 (not 503/404) with the frozen top-level shape', async () => {
    const res = await request(app).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200); // never 503-because-unwired, never 404
    // The frozen top-level shape (§2.7).
    for (const field of [
      'cap',
      'targetedCap',
      'posture',
      'ttlSignalArmed',
      'suite',
      'targeted',
      'liveHolders',
      'admittedOpen',
      'recentEvents',
      'skipHistogram',
    ]) {
      expect(res.body, `frozen shape field ${field}`).toHaveProperty(field);
    }
    // Shipped posture on a fresh universe: code-default caps, dry-run, arm off.
    expect(res.body.cap).toBe(HOST_TEST_SUITE_CAP_DEFAULT);
    expect(res.body.targetedCap).toBe(HOST_TEST_TARGETED_CAP_DEFAULT);
    expect(res.body.posture).toBe('dry-run');
    expect(res.body.ttlSignalArmed).toBe(false);
    expect(Array.isArray(res.body.liveHolders)).toBe(true);
    expect(Array.isArray(res.body.admittedOpen)).toBe(true);
    expect(Array.isArray(res.body.recentEvents)).toBe(true);
    expect(res.body.suite).toMatchObject({ available: HOST_TEST_SUITE_CAP_DEFAULT, saturated: false });
    expect(res.body.targeted).toMatchObject({
      available: HOST_TEST_TARGETED_CAP_DEFAULT,
      saturated: false,
    });
    expect(typeof res.body.skipHistogram).toBe('object');
  });

  it('the route sits behind the REAL auth middleware: no Bearer → 401', async () => {
    const res = await request(app).get('/test-runner-limiter');
    expect(res.status).toBe(401);
  });

  it('POST /test-runner-limiter/prune is ALIVE: 200 with the prune-report shape on a fresh universe', async () => {
    const res = await request(app).post('/test-runner-limiter/prune').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toEqual([]);
    expect(res.body.wouldBeReclaimed).toEqual([]);
    expect(res.body.tombstonesCompleted).toBe(0);
    expect(res.body.liveSuite).toBe(0);
    expect(res.body.liveTargeted).toBe(0);
  });
});
