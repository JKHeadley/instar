/**
 * E2E lifecycle (Tier 3): WorktreeMonitor announce-on-change, composed the way
 * server.ts composes it (same constructor options, alertCallback → notify,
 * post-session scan wired onto a sessionComplete emitter), across a restart.
 *
 * Before this fix one unmerged branch produced ~550 notices a day, one per job
 * session (docs/research/jev/field-notes/2026-09-30-idea4-notification-tiering.md).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorktreeMonitor } from '../../src/monitoring/WorktreeMonitor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-monitor-announce-e2e-'));
const repoDir = path.join(tmpDir, 'repo');
const stateDir = path.join(tmpDir, 'state');

function git(cmd: string): void {
  spawnSync('/bin/sh', ['-c', `git ${cmd}`], { cwd: repoDir, encoding: 'utf-8', env: sanitizedGitEnv() });
}

function session(n: number): Session {
  return {
    id: `s-${n}`,
    name: `job-run-${n}`,
    status: 'completed',
    tmuxSession: `job-run-${n}`,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  } as Session;
}

/** Boot the monitor exactly as server.ts does and wire it to a session emitter. */
function boot(notified: string[]): { sessionManager: EventEmitter; monitor: WorktreeMonitor; scans: Promise<unknown>[] } {
  const notify = (_tier: string, _category: string, msg: string) => { notified.push(msg); };
  const monitor = new WorktreeMonitor({
    projectDir: repoDir,
    stateDir,
    pollIntervalMs: 300_000,
    alertCallback: async (msg: string) => {
      notify('IMMEDIATE', 'system', msg);
    },
  });
  monitor.start();
  const sessionManager = new EventEmitter();
  const scans: Promise<unknown>[] = [];
  sessionManager.on('sessionComplete', (s: Session) => { scans.push(monitor.onSessionComplete(s)); });
  return { sessionManager, monitor, scans };
}

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/e2e/worktree-monitor-announce-lifecycle.test.ts',
  });
});

describe('E2E: WorktreeMonitor announces a finding once, not once per session', () => {
  fs.mkdirSync(repoDir, { recursive: true });
  git('init --initial-branch main');
  git('config user.email test@test.com');
  git('config user.name Test');
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# t\n');
  git('add README.md');
  git('commit -m init');
  git('branch worktree-unmerged-forever');

  const notified: string[] = [];

  it('ten job sessions over one unchanged branch produce one notice', async () => {
    const { sessionManager, monitor, scans } = boot(notified);
    for (let i = 0; i < 10; i++) sessionManager.emit('sessionComplete', session(i));
    await Promise.all(scans);
    monitor.stop();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('worktree-unmerged-forever');
  });

  it('a server restart does not re-announce the same finding', async () => {
    const { sessionManager, monitor, scans } = boot(notified);
    sessionManager.emit('sessionComplete', session(100));
    await Promise.all(scans);
    monitor.stop();
    expect(notified).toHaveLength(1);
  });

  it('after a restart, a changed set is announced', async () => {
    git('branch -D worktree-unmerged-forever');
    git('branch worktree-fresh');
    const { sessionManager, monitor, scans } = boot(notified);
    sessionManager.emit('sessionComplete', session(200));
    await Promise.all(scans);
    monitor.stop();
    expect(notified).toHaveLength(2);
    expect(notified[1]).toContain('worktree-fresh');
    expect(notified[1]).not.toContain('worktree-unmerged-forever');
  });

  it('server.ts wires the monitor without disabling the reminder interval', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, '../../src/commands/server.ts'), 'utf-8');
    const block = serverSrc.slice(serverSrc.indexOf('new WorktreeMonitor({'), serverSrc.indexOf('worktreeMonitor.start();'));
    expect(block).toContain('alertCallback');
    expect(block).not.toMatch(/reminderIntervalMs:\s*0\b/);
    expect(serverSrc).toContain('await worktreeMonitor.onSessionComplete(session);');
  });
});
