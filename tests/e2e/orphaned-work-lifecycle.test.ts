/**
 * E2E lifecycle for the OrphanedWorkSentinel (the silent-uncommitted-death
 * backstop). Tier-3 of the Testing Integrity Standard — the Phase-1 "feature is
 * alive" guarantee: GET /orphaned-work is reachable from a BOOTED server (200,
 * not 503/404) and reflects the LIVE sentinel's classifier output (not a stub).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  OrphanedWorkSentinel,
  type OrphanedWorkSentinelDeps,
  type OrphanedWorktreeInfo,
} from '../../src/monitoring/OrphanedWorkSentinel.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-orphaned-work-e2e';

describe('OrphanedWorkSentinel lifecycle (e2e)', () => {
  let tmpDir: string; let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const auth = () => ({ Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'orphaned-work-e2e' });

  // A live sentinel over deterministic deps reporting ONE genuinely-orphaned
  // worktree (dirty + owner-dead + settled). Proves the route reflects the live
  // classifier, not a stub.
  function liveSentinel(): OrphanedWorkSentinel {
    const wt: OrphanedWorktreeInfo = { path: '/agents/echo/.worktrees/stranded', branch: 'echo/stranded', headSha: 'cafe123' };
    const deps: OrphanedWorkSentinelDeps = {
      listWorktrees: () => [wt],
      hasUncommittedWork: () => true,
      workSignature: () => 'sig-e2e',
      isInUse: () => false,
      lastActivityMs: () => 1,
      preserve: () => {},
      record: () => {},
      raiseAttention: () => {},
      now: () => 5_000_000,
    };
    return new OrphanedWorkSentinel(deps, { settleMs: 1000, enabled: true });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphaned-work-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');

    const config: InstarConfig = {
      projectName: 'orphaned-work-e2e', projectDir: tmpDir, stateDir, port: 0,
      authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], updates: {},
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
      state: new StateManager(stateDir),
      orphanedWorkSentinel: liveSentinel(),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/orphaned-work-lifecycle.test.ts' });
  });

  it('feature is alive: GET /orphaned-work is reachable from boot (200, not 503/404)', async () => {
    const res = await request(app).get('/orphaned-work').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('reflects the LIVE sentinel: the orphaned worktree is in the snapshot (deps not no-op)', async () => {
    const res = await request(app).get('/orphaned-work').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.orphanedCount).toBe(1);
    expect(res.body.evaluations).toEqual([
      expect.objectContaining({ path: '/agents/echo/.worktrees/stranded', verdict: 'orphaned' }),
    ]);
  });
});
