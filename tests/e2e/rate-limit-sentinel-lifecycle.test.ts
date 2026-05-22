/**
 * E2E test — RateLimitSentinel full lifecycle on the PRODUCTION path.
 *
 * Tests the complete production path:
 *   1. Server starts with RateLimitSentinel passed to AgentServer the SAME way
 *      server.ts wires it.
 *   2. GET /rate-limit/status returns 200 (not 503 — the "dead on arrival" check)
 *      AND enabled:true (proving the sentinel survived AgentServer → RouteContext).
 *   3. A reported throttle surfaces in /rate-limit/status with the documented shape.
 *   4. The zombie-veto recovery-checker composition is honored through the same
 *      isRecoveryActive() the production setActiveRecoveryChecker call reads.
 *
 * WHY THIS TEST EXISTS:
 * The integration test (tests/integration/rate-limit-status-routes.test.ts)
 * hand-builds a RouteContext and injects the sentinel directly into createRoutes.
 * That proves the route works IF the sentinel reaches the RouteContext — but it
 * cannot catch the case where AgentServer's `rateLimitSentinel: options.x ?? null`
 * plumbing drops it, leaving /rate-limit/status reporting enabled:false in
 * production. This test passes the sentinel through the real AgentServer
 * constructor (exactly as server.ts does) and asserts enabled:true on the wire.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('RateLimitSentinel E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let jsonlRoot: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let rateLimitSentinel: RateLimitSentinel;
  const AUTH_TOKEN = 'test-e2e-rate-limit-sentinel';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-sentinel-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    jsonlRoot = path.join(tmpDir, 'jsonl');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(jsonlRoot, { recursive: true });
    fs.writeFileSync(path.join(jsonlRoot, 'session.jsonl'), 'x'.repeat(100));

    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }),
    );

    const mockSM = createMockSessionManager();

    // ━━━ CRITICAL: Initialize the same way server.ts will ━━━
    //
    // server.ts builds the sentinel with resumeFn/notifyFn/projectDir/
    // getClaudeSessionId and passes it to AgentServer. We use no-op fns +
    // an overridden jsonlRoot (no real Claude session here) so the lifecycle
    // is observable without a live tmux pane.
    rateLimitSentinel = new RateLimitSentinel(
      {
        resumeFn: async () => true,
        notifyFn: async () => {},
        projectDir: tmpDir,
        jsonlRoot,
      },
      { enabled: true },
    );

    const config: InstarConfig = {
      projectName: 'e2e-test',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.10.3',
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
    };

    const state = new StateManager(stateDir);

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state,
      rateLimitSentinel,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    rateLimitSentinel?.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/rate-limit-sentinel-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  // ══════════════════════════════════════════════════════════════════
  // Phase 1: Feature is ALIVE (not dead on arrival)
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 1: Feature is alive (not 503, enabled:true)', () => {
    it('GET /rate-limit/status returns 200 with enabled:true', async () => {
      const res = await request(app).get('/rate-limit/status').set(auth());

      // THE test that catches "dead on arrival" / "wired-but-dropped" bugs.
      // 503 → route guard missing. enabled:false → AgentServer never delivered
      // the sentinel to the RouteContext (the `?? null` swallowed it).
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(Array.isArray(res.body.active)).toBe(true);
      expect(res.body.active).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Phase 2: A reported throttle surfaces through the production route
  // ══════════════════════════════════════════════════════════════════

  describe('Phase 2: Active recovery is observable on the wire', () => {
    it('a reported throttle appears in /rate-limit/status with the documented shape', async () => {
      rateLimitSentinel.report('e2e-sess', 'watchdog-poll');

      const res = await request(app).get('/rate-limit/status').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.active).toHaveLength(1);

      const entry = res.body.active[0];
      expect(entry.sessionName).toBe('e2e-sess');
      expect(entry.trigger).toBe('watchdog-poll');
      expect(['detected', 'backing-off', 'resuming']).toContain(entry.status);
      expect(entry.attempts).toBeGreaterThanOrEqual(0);
      expect(entry.nextBackoffMs).toBeGreaterThan(0);
      expect(typeof entry.detectedAt).toBe('number');
    });

    it('isRecoveryActive (the zombie-veto predicate server.ts composes) is true mid-recovery', () => {
      // server.ts ORs this into setActiveRecoveryChecker; the reaper reads it
      // to refuse killing a session while a throttle recovery is in flight.
      expect(rateLimitSentinel.isRecoveryActive('e2e-sess')).toBe(true);
      expect(rateLimitSentinel.isRecoveryActive('no-such-session')).toBe(false);
    });

    it('clearing the recovery removes it from the status surface', async () => {
      rateLimitSentinel.clear('e2e-sess');

      const res = await request(app).get('/rate-limit/status').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.active).toHaveLength(0);
      expect(rateLimitSentinel.isRecoveryActive('e2e-sess')).toBe(false);
    });
  });
});
