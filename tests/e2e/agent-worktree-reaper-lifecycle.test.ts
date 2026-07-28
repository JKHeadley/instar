/**
 * E2E — AgentWorktreeReaper on the PRODUCTION path.
 *
 * Phase 1 (the most important test): GET /worktrees/agent-reaper returns 200
 * (not 503) through the REAL AgentServer → RouteContext plumbing — the
 * "dead on arrival" / "wired-but-dropped (?? null)" guard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { AgentWorktreeReaper, type AgentWorktreeReaperDeps } from '../../src/monitoring/AgentWorktreeReaper.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('AgentWorktreeReaper E2E lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-agent-worktree-reaper';

  const deps: AgentWorktreeReaperDeps = {
    listWorktrees: () => [{ path: '/wt/stale', branch: 'echo/merged', headSha: 'abc' }],
    isClean: () => true,
    isMerged: () => true,
    isInUse: () => false,
    removeWorktree: () => {},
    now: () => 1_000_000_000_000,
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-test', agentName: 'E2E Test' }));

    const reaper = new AgentWorktreeReaper(deps, { enabled: true, dryRun: true });
    const config: InstarConfig = {
      projectName: 'e2e-test', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000, version: '0.10.3',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    };
    const state = new StateManager(stateDir);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state, agentWorktreeReaper: reaper });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/agent-worktree-reaper-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

  it('GET /worktrees/agent-reaper returns 200 with a snapshot through the real AgentServer plumbing', async () => {
    const res = await request(app).get('/worktrees/agent-reaper').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(true);
    expect(Array.isArray(res.body.worktrees)).toBe(true);
    expect(res.body.reclaimable).toBe(1);
  });
});
