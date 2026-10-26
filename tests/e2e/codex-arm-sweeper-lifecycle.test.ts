/**
 * E2E — CodexArmSessionSweeper on the PRODUCTION path.
 *
 * Phase 1 (the most important test): GET /codex-arm-sweeper returns 200 (not 503)
 * through the REAL AgentServer → RouteContext plumbing — the "dead on arrival" /
 * "wired-but-dropped (?? null)" guard.
 *
 * Phase 2: the sweeper reached through that plumbing is the REAL object doing real
 * work, not a no-op — a pass driven through it kills the orphan and reports it on
 * the route.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { CodexArmSessionSweeper } from '../../src/monitoring/CodexArmSessionSweeper.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = 1_800_000_000_000;

describe('CodexArmSessionSweeper E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let sweeper: CodexArmSessionSweeper;
  const killed: string[] = [];
  const AUTH_TOKEN = 'test-e2e-codex-arm-sweeper';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cass-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }));

    sweeper = new CodexArmSessionSweeper(
      { enabled: true, dryRun: false, initialPassDelayMs: 0 },
      {
        listSessions: () => [
          { name: `instar-codex-arm-${(NOW - 43 * 3_600_000).toString(36)}`, createdEpochSec: Math.floor((NOW - 43 * 3_600_000) / 1000) },
          { name: 'echo-topic-61449', createdEpochSec: Math.floor((NOW - 86_400_000) / 1000) },
        ],
        killSession: (n) => { killed.push(n); },
        now: () => NOW,
      },
    );

    const config: InstarConfig = {
      projectName: 'e2e-test', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    const state = new StateManager(stateDir);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state, codexArmSessionSweeper: sweeper });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    sweeper.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/codex-arm-sweeper-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('GET /codex-arm-sweeper returns 200 with the posture through the real AgentServer plumbing', async () => {
    const res = await request(app).get('/codex-arm-sweeper').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.maxAgeMs).toBeGreaterThanOrEqual(120_000);
    expect(res.body.passes).toBe(0);
  });

  it('the wired sweeper is the real one — a pass kills the orphan and the route reports it', async () => {
    sweeper.sweep();
    const res = await request(app).get('/codex-arm-sweeper').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.passes).toBe(1);
    expect(res.body.killed).toBe(1);
    expect(res.body.lastKills[0].session).toBe(`instar-codex-arm-${(NOW - 43 * 3_600_000).toString(36)}`);
    // the unrelated topic session is never considered, let alone killed
    expect(killed).toEqual([`instar-codex-arm-${(NOW - 43 * 3_600_000).toString(36)}`]);
  });

  it('requires auth', async () => {
    const res = await request(app).get('/codex-arm-sweeper');
    expect(res.status).toBe(401);
  });
});
