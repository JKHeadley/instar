/**
 * GET /worktrees/agent-reaper through the real createRoutes pipeline.
 *  - 503 when the reaper is not wired.
 *  - 200 with the snapshot (per-worktree verdicts + reclaimable count) when present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { AgentWorktreeReaper, type AgentWorktreeReaperDeps, type WorktreeInfo } from '../../src/monitoring/AgentWorktreeReaper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function ctxWith(stateDir: string, reaper: AgentWorktreeReaper | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: path.dirname(stateDir), stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as any,
    tokenLedger: null,
    agentWorktreeReaper: reaper,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function reaperDeps(worktrees: WorktreeInfo[]): AgentWorktreeReaperDeps {
  return {
    listWorktrees: () => worktrees,
    isClean: () => true,
    isMerged: () => true,
    isInUse: () => false,
    removeWorktree: () => {},
    now: () => 1_000_000_000_000,
  };
}

describe('GET /worktrees/agent-reaper (integration)', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/agent-worktree-reaper-routes.test.ts' });
  });

  function appWith(reaper: AgentWorktreeReaper | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWith(stateDir, reaper)));
    return app;
  }

  it('returns 503 when the reaper is not wired', async () => {
    const res = await request(appWith(null)).get('/worktrees/agent-reaper');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/);
  });

  it('returns 200 with a snapshot when the reaper is present', async () => {
    const reaper = new AgentWorktreeReaper(
      reaperDeps([{ path: '/wt/old', branch: 'echo/done', headSha: 'abc' }]),
      { enabled: true, dryRun: true },
    );
    const res = await request(appWith(reaper)).get('/worktrees/agent-reaper');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(Array.isArray(res.body.worktrees)).toBe(true);
    expect(res.body.worktrees[0].path).toBe('/wt/old');
    expect(res.body.worktrees[0].verdict).toBe('reap-eligible');
    expect(res.body.reclaimable).toBe(1);
  });
});
