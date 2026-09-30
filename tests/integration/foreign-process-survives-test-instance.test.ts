/**
 * Regression: an instance kills only what it can prove it started.
 *
 * 2026-09-29/30 (Mac Studio): six `claude -p` builders died with exit 137 while
 * integration tests were starting real SessionManagers in throwaway agent homes,
 * and `instar-test-*-job-fast-test-*` tmux sessions leaked from those runs. This
 * pins the ownership contract against the real tmux server, both sides of each
 * decision:
 *   - the orphan pass REAPS a session this instance spawned (proven by the
 *     INSTAR_SESSION_ID in its tmux env) while a foreign `claude`-shaped
 *     process survives — including one in a session that REUSES a name this
 *     instance once recorded;
 *   - `createTempProject().cleanup()` removes the instance's own sessions and
 *     nothing else;
 *   - a triage spawn replaces its own session under the name, never a foreign one;
 *   - PipeSessionSpawner kills its own recorded session, but not a replacement
 *     session under the same name, not a stale pid, and it refuses to spawn over
 *     a pre-existing foreign `pipe-<threadId>` session.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { OrphanProcessReaper } from '../../src/monitoring/OrphanProcessReaper.js';
import { PipeSessionSpawner } from '../../src/threadline/PipeSessionSpawner.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTempProject, waitFor } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;

function tmux(...args: string[]): string {
  return execFileSync(tmuxPath!, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Start a detached session; return its tmux session id and pane pid. */
function newSession(name: string, command: string): { tmuxId: string; pid: number } {
  const [tmuxId, pid] = tmux('new-session', '-d', '-P', '-F', '#{session_id} #{pane_pid}', '-s', name, command).trim().split(' ');
  return { tmuxId, pid: parseInt(pid, 10) };
}

describeMaybe('an instance kills only what it can prove it started', () => {
  let scratch: string;
  let fakeClaude: string;
  /** Exact names of every session this file creates by hand — killed in afterAll. */
  const handMade: string[] = [];
  const detachedPids: number[] = [];

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-claude-'));
    // A `claude`-shaped long-running process: the reaper's process scan matches it.
    fakeClaude = path.join(scratch, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/bash\nexec -a claude sleep 600\n', { mode: 0o755 });
  });

  afterAll(() => {
    for (const name of handMade) {
      try { tmux('kill-session', '-t', `=${name}`); } catch { /* @silent-fallback-ok — already gone */ }
    }
    for (const pid of detachedPids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'tests/integration/foreign-process-survives-test-instance.test.ts' });
  });

  function foreignSession(name: string): number {
    handMade.push(name);
    const { pid } = newSession(name, `${fakeClaude} -p 'builder waiting on its test run'`);
    expect(alive(pid)).toBe(true);
    return pid;
  }

  function manager(project: TempProject, claudePath: string): SessionManager {
    return new SessionManager(
      {
        tmuxPath: tmuxPath!,
        claudePath,
        projectDir: project.dir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: ['Session ended'],
      },
      project.state,
    );
  }

  it('the orphan pass reaps its own orphaned session; foreign processes survive, even under a reused name', async () => {
    const project = createTempProject();
    const sm = manager(project, fakeClaude);
    const base = path.basename(project.dir);
    try {
      // Foreign #1: another agent's job session, unrelated name.
      const foreignPid = foreignSession(`${path.basename(scratch)}-job-build-${process.pid}`);
      // Foreign #2: a session under a name THIS instance once recorded
      // (a terminal record), created by someone else — no INSTAR_SESSION_ID.
      const reusedName = `${base}-job-old`;
      const reusedPid = foreignSession(reusedName);
      project.state.saveSession({
        id: 'oldrecord1', name: 'job-old', status: 'completed', tmuxSession: reusedName,
        startedAt: new Date(Date.now() - 3_600_000).toISOString(), endedAt: new Date().toISOString(),
      } as Session);

      // Own: a real spawn whose record then goes terminal while its pane lives on
      // — exactly the orphan the pass exists for.
      const own = await sm.spawnSession({ name: 'job-orphan', prompt: 'x', jobSlug: 'orphan' });
      await waitFor(() => sessionExists(own.tmuxSession), 5000);
      const ownPid = parseInt(tmux('list-panes', '-t', `=${own.tmuxSession}:`, '-F', '#{pane_pid}').trim(), 10);
      await waitFor(() => {
        try { return execFileSync('ps', ['-p', String(ownPid), '-o', 'command='], { encoding: 'utf-8' }).startsWith('claude'); } catch { return false; }
      }, 5000);
      const record = project.state.getSession(own.id)!;
      project.state.saveSession({ ...record, status: 'completed', endedAt: new Date().toISOString() });

      expect(sm.ownsLiveTmuxSession(own.tmuxSession)).toBe(true);
      expect(sm.ownsLiveTmuxSession(reusedName)).toBe(false);

      const reaper = new OrphanProcessReaper(
        { projectName: base, sessions: { tmuxPath: tmuxPath! } } as unknown as InstarConfig,
        sm,
        // -1: any age qualifies (the pass requires elapsed > max age; a fresh
        // process reads elapsed 0).
        { orphanMaxAgeMs: -1, autoKillOrphans: true, reportExternalProcesses: false },
      );
      const report = await reaper.scan();

      expect(report.orphans.map((p) => p.tmuxSession)).toEqual([own.tmuxSession]);
      expect(report.external.find((p) => p.tmuxSession === reusedName)?.reason).toMatch(/ownership unproven/);
      await waitFor(() => !alive(ownPid) && !sessionExists(own.tmuxSession), 8000);
      expect(alive(foreignPid)).toBe(true);
      expect(alive(reusedPid)).toBe(true);
      expect(sessionExists(reusedName)).toBe(true);
    } finally {
      sm.stopMonitoring();
      project.cleanup();
    }
  }, 40_000);

  it('the fixture cleanup removes its own sessions and nothing else', async () => {
    const project = createTempProject();
    const sm = manager(project, fakeClaude);
    const ownPrefix = `${path.basename(project.dir)}-`;
    let foreignPid = 0;
    try {
      foreignPid = foreignSession(`${path.basename(scratch)}-job-fast-test-${process.pid}`);
      const own = await sm.spawnSession({ name: 'job-fast-test', prompt: 'Quick test', jobSlug: 'fast-test' });
      expect(own.tmuxSession.startsWith(ownPrefix)).toBe(true);
      await waitFor(() => sessionExists(own.tmuxSession), 5000);
    } finally {
      sm.stopMonitoring();
      project.cleanup();
    }
    expect(alive(foreignPid)).toBe(true);
    const left = tmux('list-sessions', '-F', '#{session_name}').split('\n').filter((s) => s.startsWith(ownPrefix));
    expect(left).toEqual([]);
  }, 30_000);

  it('a triage spawn replaces its own session under the name, never a foreign one', async () => {
    const project = createTempProject();
    // A claudePath that is not a genuine claude binary makes triage stop right
    // after the occupied-name decision, before it would wait for a real CLI.
    const sm = manager(project, path.join(scratch, 'no-such-claude'));
    const base = path.basename(project.dir);
    try {
      const foreignName = `${base}-triage-foreign`;
      const foreignPid = foreignSession(foreignName);
      await expect(sm.spawnTriageSession('triage-foreign', { allowedTools: [], permissionMode: 'dontAsk' }))
        .rejects.toThrow(/not started by this agent/);
      expect(alive(foreignPid)).toBe(true);
      expect(sessionExists(foreignName)).toBe(true);

      // Own session under the triage name (spawned by this instance) — replaced.
      const smOwn = manager(project, fakeClaude);
      const own = await smOwn.spawnSession({ name: 'triage-own', prompt: 'x' });
      await waitFor(() => sessionExists(own.tmuxSession), 5000);
      expect(own.tmuxSession).toBe(`${base}-triage-own`);
      const err = await sm.spawnTriageSession('triage-own', { allowedTools: [], permissionMode: 'dontAsk' }).catch((e: Error) => e);
      expect(String(err)).not.toMatch(/not started by this agent/);
      expect(sessionExists(own.tmuxSession)).toBe(false);
      smOwn.stopMonitoring();
    } finally {
      sm.stopMonitoring();
      project.cleanup();
    }
  }, 30_000);

  describe('PipeSessionSpawner', () => {
    type Active = Map<string, { sessionName: string; threadId: string; pid: number; tmuxId?: string; startedAt: number; timeoutTimer: ReturnType<typeof setTimeout> }>;
    const record = (spawner: PipeSessionSpawner, sessionName: string, pid: number, tmuxId?: string) => {
      (spawner as unknown as { activeSessions: Active }).activeSessions.set(sessionName, {
        sessionName, threadId: sessionName.slice('pipe-'.length), pid, tmuxId, startedAt: Date.now(),
        timeoutTimer: setTimeout(() => {}, 0),
      });
    };
    const spawnerIn = () => new PipeSessionSpawner({ stateDir: fs.mkdtempSync(path.join(scratch, 'pipe-')) });

    it('kills its own recorded session (process group and tmux session)', () => {
      const name = `pipe-own-${process.pid}`;
      handMade.push(name);
      const { tmuxId, pid } = newSession(name, 'sleep 600');
      const spawner = spawnerIn();
      record(spawner, name, pid, tmuxId);
      spawner.killAll();
      expect(sessionExists(name)).toBe(false);
    });

    it('does not kill a replacement session that reuses the name, nor its processes', () => {
      const name = `pipe-replaced-${process.pid}`;
      handMade.push(name);
      const original = newSession(name, 'sleep 600');
      tmux('kill-session', '-t', original.tmuxId);
      const replacement = newSession(name, 'sleep 600'); // someone else's, same name
      const spawner = spawnerIn();
      record(spawner, name, original.pid, original.tmuxId);
      spawner.killAll();
      expect(sessionExists(name)).toBe(true);
      expect(alive(replacement.pid)).toBe(true);
    });

    it('does not group-kill a recorded pid once its pane is gone', () => {
      // A detached process is its own group leader — exactly what a reused pid
      // looks like after a pipe session's pane exited.
      const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
      child.unref();
      detachedPids.push(child.pid!);
      const spawner = spawnerIn();
      record(spawner, `pipe-gone-${process.pid}`, child.pid!, '$999999');
      spawner.killAll();
      expect(alive(child.pid!)).toBe(true);
    });

    it('refuses to spawn over a pre-existing foreign pipe-<threadId> session', async () => {
      const threadId = `foreign-${process.pid}`;
      const foreignPid = foreignSession(`pipe-${threadId}`);
      const spawner = spawnerIn();
      const result = await spawner.spawn({
        threadId, messageText: 'hi', fromFingerprint: 'abc', fromName: 'peer', trustLevel: 'trusted', iqsBand: 90,
      });
      expect(result.spawned).toBe(false);
      expect(result.reason).toMatch(/not started by this spawner/);
      expect(alive(foreignPid)).toBe(true);
      expect(sessionExists(`pipe-${threadId}`)).toBe(true);
    });
  });
});
