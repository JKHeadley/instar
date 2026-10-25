/**
 * Integration (Tier 2): WorktreeMonitor announce-on-change through the real
 * createRoutes pipeline. A repeated post-session scan of an unchanged finding
 * sends one alert, and GET /hooks/worktrees/last-report shows the suppression.
 */

import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { WorktreeMonitor } from '../../src/monitoring/WorktreeMonitor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-monitor-announce-routes-'));
const repoDir = path.join(tmpDir, 'repo');
const stateDir = path.join(tmpDir, 'state');

function git(cmd: string): void {
  spawnSync('/bin/sh', ['-c', `git ${cmd}`], { cwd: repoDir, encoding: 'utf-8', env: sanitizedGitEnv() });
}

function session(name: string): Session {
  return {
    id: `s-${name}`,
    name,
    status: 'completed',
    tmuxSession: name,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  } as Session;
}

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/worktree-monitor-announce-routes.test.ts',
  });
});

describe('GET /hooks/worktrees/last-report — announce on change only', () => {
  fs.mkdirSync(repoDir, { recursive: true });
  git('init --initial-branch main');
  git('config user.email test@test.com');
  git('config user.name Test');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# t\n');
  git('add README.md');
  git('commit -m init');
  git('branch worktree-left-behind');

  const alerts: string[] = [];
  const monitor = new WorktreeMonitor({
    projectDir: repoDir,
    stateDir,
    pollIntervalMs: 0,
    alertCallback: async (msg) => { alerts.push(msg); },
  });

  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: 'test', stateDir, port: 0, projectName: 'worktree-announce-test' },
    worktreeMonitor: monitor,
  } as never));

  it('first scan announces and the report records the alert', async () => {
    await monitor.onSessionComplete(session('job-one'));
    const res = await request(app).get('/hooks/worktrees/last-report');
    expect(res.status).toBe(200);
    expect(res.body.orphanBranches).toEqual(['worktree-left-behind']);
    expect(res.body.actions).toEqual(['Alert generated for session job-one']);
    expect(alerts).toHaveLength(1);
  });

  it('a repeat scan of the same finding is suppressed and says so on the route', async () => {
    await monitor.onSessionComplete(session('job-two'));
    const res = await request(app).get('/hooks/worktrees/last-report');
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(['Alert suppressed: findings unchanged since last announcement']);
    expect(alerts).toHaveLength(1);
  });

  it('a new branch is announced again', async () => {
    git('branch worktree-another');
    await monitor.onSessionComplete(session('job-three'));
    const res = await request(app).get('/hooks/worktrees/last-report');
    expect(res.body.actions).toEqual(['Alert generated for session job-three']);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('worktree-another');
  });
});
