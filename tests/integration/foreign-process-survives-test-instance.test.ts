/**
 * Regression: a test instance never signals a process it did not start.
 *
 * 2026-09-29/30 (Mac Studio): six `claude -p` builders died with exit 137 while
 * integration tests were starting real SessionManagers in throwaway agent homes,
 * and `instar-test-*-job-fast-test-*` tmux sessions leaked from those runs. This
 * pins the host-safety contract against the real tmux server:
 *   - a foreign `claude`-shaped process in its own tmux session (named like an
 *     instar job session) survives a real SessionManager's spawn, its maintenance
 *     tick (dead-job-pane + zombie pass), and `createTempProject().cleanup()`;
 *   - that cleanup DOES remove the sessions the instance itself spawned;
 *   - PipeSessionSpawner's kill path never group-kills a pid whose pane is gone
 *     (a stale, possibly reused pid).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { PipeSessionSpawner } from '../../src/threadline/PipeSessionSpawner.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockClaude, waitFor } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

function tmux(...args: string[]): string {
  return execFileSync(tmuxPath!, args, { encoding: 'utf-8' });
}

/** Running and not a zombie — a killed child of this worker stays a zombie
 *  (and answers kill(pid, 0)) until reaped, so read the process state. */
function alive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf-8' }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch { return false; }
}

function sessionExists(name: string): boolean {
  try { tmux('has-session', '-t', `=${name}`); return true; } catch { return false; }
}

describeMaybe('a test instance never signals a foreign process', () => {
  let foreignDir: string;
  let foreignSession: string;
  let foreignPid: number;
  let detachedPid: number | undefined;

  beforeAll(() => {
    foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-claude-'));
    const fakeClaude = path.join(foreignDir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/bash\nexec -a claude sleep 600\n', { mode: 0o755 });
    // Named like another agent's job session, on the shared default tmux server.
    foreignSession = `${path.basename(foreignDir)}-job-build-${process.pid}`;
    tmux('new-session', '-d', '-s', foreignSession, `${fakeClaude} -p 'builder waiting on its test run'`);
    foreignPid = parseInt(tmux('list-panes', '-t', `=${foreignSession}:`, '-F', '#{pane_pid}').trim(), 10);
    expect(alive(foreignPid)).toBe(true);
  });

  afterAll(() => {
    try { tmux('kill-session', '-t', `=${foreignSession}`); } catch { /* @silent-fallback-ok — already gone */ }
    if (detachedPid && alive(detachedPid)) process.kill(detachedPid, 'SIGKILL');
    SafeFsExecutor.safeRmSync(foreignDir, { recursive: true, force: true, operation: 'tests/integration/foreign-process-survives-test-instance.test.ts' });
  });

  it('survives a real SessionManager run, its maintenance pass and the fixture cleanup, which removes only its own sessions', async () => {
    const project: TempProject = createTempProject();
    let tick: (() => Promise<void>) | undefined;
    const sm = new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath: createMockClaude(project.dir),
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      project.state,
      { bindMaintenanceTickForTesting: (t) => { tick = t; } },
    );
    const ownPrefix = `${path.basename(project.dir)}-`;
    const own = await sm.spawnSession({ name: 'job-fast-test', prompt: 'Quick test', jobSlug: 'fast-test' });
    expect(own.tmuxSession.startsWith(ownPrefix)).toBe(true);
    await waitFor(() => sessionExists(own.tmuxSession), 5000);

    await tick!();
    await tick!();
    sm.stopMonitoring();
    project.cleanup();

    expect(alive(foreignPid)).toBe(true);
    expect(sessionExists(foreignSession)).toBe(true);
    const left = tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(s => s.startsWith(ownPrefix));
    expect(left).toEqual([]);
  }, 30_000);

  it('PipeSessionSpawner does not group-kill a recorded pid once its pane is gone', () => {
    // A detached process is its own group leader — exactly what a reused pid
    // looks like after a pipe session's pane exited.
    const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    child.unref();
    detachedPid = child.pid!;
    const stateDir = fs.mkdtempSync(path.join(foreignDir, 'pipe-'));
    const spawner = new PipeSessionSpawner({ stateDir });
    const sessionName = `pipe-gone-${process.pid}`;
    (spawner as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set(sessionName, {
      sessionName,
      threadId: 'gone',
      pid: detachedPid,
      startedAt: Date.now(),
      timeoutTimer: setTimeout(() => {}, 0),
    });

    spawner.killAll();

    expect(alive(detachedPid)).toBe(true);
    expect(alive(foreignPid)).toBe(true);
  });
});
