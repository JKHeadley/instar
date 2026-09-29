/**
 * Finished job sessions must not leave dead tmux sessions behind.
 *
 * Job panes keep `remain-on-exit failed` so the monitor can read the exit
 * status. Before this fix, a job that exited non-zero (the groky agent's grok
 * jobs, ~1,000 a day) was marked completed but its dead pane stayed forever:
 * job names are unique per run, so no later spawn reclaimed it.
 *
 * Runs against a REAL tmux on a private socket (`-L`), so it never sees the
 * host's sessions. Skips if tmux is unavailable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

const which = spawnSync('which', ['tmux'], { encoding: 'utf-8' });
const realTmux = which.status === 0 ? which.stdout.trim() : '';

describe.skipIf(!realTmux)('dead job pane cleanup (real tmux, private socket)', () => {
  let root: string;
  let dir: string;
  let socket: string;
  let tmuxPath: string;
  let state: StateManager;
  let manager: SessionManager;
  let tick: () => Promise<void>;

  const tmux = (...args: string[]) => spawnSync(realTmux, ['-L', socket, ...args], { encoding: 'utf-8' });
  const exists = (name: string) => tmux('has-session', '-t', `=${name}`).status === 0;
  const paneDead = (name: string) => tmux('display-message', '-t', `=${name}:`, '-p', '#{pane_dead}').stdout.trim() === '1';
  const base = () => path.basename(dir);

  /** Start a session the way a spawn does: env flags, then `remain-on-exit failed`. */
  function start(name: string, cmd: string, env: Record<string, string>): void {
    const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const r = tmux('new-session', '-d', '-s', name, ...flags, `sleep 0.4; ${cmd}`);
    if (r.status !== 0) throw new Error(`new-session failed: ${r.stderr}`);
    tmux('set-option', '-t', `=${name}:`, 'remain-on-exit', 'failed');
  }

  async function waitDead(names: string[]): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (names.every(paneDead)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`panes never died: ${names.filter((n) => !paneDead(n)).join(', ')}`);
  }

  function record(id: string, tmuxSession: string, jobSlug?: string): void {
    const s: Session = {
      id, name: tmuxSession, status: 'running', tmuxSession, jobSlug,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    state.saveSession(s);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deadjob-'));
    dir = path.join(root, 'agentx');
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    socket = `deadjob-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    tmuxPath = path.join(root, 'tmux.sh');
    fs.writeFileSync(tmuxPath, `#!/bin/sh\nexec "${realTmux}" -L "${socket}" "$@"\n`, { mode: 0o755 });
    state = new StateManager(path.join(dir, 'state'));
    manager = new SessionManager({
      tmuxPath, claudePath: '/usr/local/bin/claude', projectDir: dir, maxSessions: 5,
      protectedSessions: [], completionPatterns: [], framework: 'claude-code',
    }, state, { bindMaintenanceTickForTesting: (t) => { tick = t; } });
  });

  afterEach(() => {
    manager.stopMonitoring();
    tmux('kill-server');
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/dead-job-pane-cleanup.test.ts:cleanup' });
  });

  it('a job that exits non-zero is marked completed and its dead tmux session removed; an interactive one keeps its pane', async () => {
    const job = `${base()}-job-health-check-aaa`;
    const chat = `${base()}-topic-chat`;
    const own = { INSTAR_AGENT_HOME: dir };
    start(job, 'exit 3', { ...own, INSTAR_JOB_SLUG: 'health-check' });
    start(chat, 'exit 3', own);
    await waitDead([job, chat]);
    record('j1', job, 'health-check');
    record('c1', chat);

    await tick();

    expect(state.getSession('j1')?.status).toBe('completed');
    expect(state.getSession('c1')?.status).toBe('completed');
    expect(exists(job)).toBe(false);
    // Interactive sessions are out of scope: their next spawn reclaims the name.
    expect(exists(chat)).toBe(true);
  });

  it('a live job session is left running', async () => {
    const job = `${base()}-job-long-bbb`;
    start(job, 'sleep 60', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'long' });
    record('j2', job, 'long');

    await tick();

    expect(state.getSession('j2')?.status).toBe('running');
    expect(exists(job)).toBe(true);
    expect(paneDead(job)).toBe(false);
  });

  it('the sweep removes only this agent\'s dead, unowned job panes', async () => {
    const mine = `${base()}-job-commitment-detection-c1`;
    const mine2 = `${base()}-job-commitment-detection-c2`;
    const live = `${base()}-job-live-c3`;
    const stillRecorded = `${base()}-job-recorded-c4`;
    const noSlug = `${base()}-job-lookalike-c5`;
    const otherAgent = `${base()}-job-other-c6`;
    const otherPrefix = `other-job-x-c7`;
    start(mine, 'exit 1', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'commitment-detection' });
    start(mine2, 'exit 2', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'commitment-detection' });
    start(live, 'sleep 60', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'live' });
    start(stillRecorded, 'exit 1', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'recorded' });
    start(noSlug, 'exit 1', { INSTAR_AGENT_HOME: dir });
    start(otherAgent, 'exit 1', { INSTAR_AGENT_HOME: '/elsewhere/agentx', INSTAR_JOB_SLUG: 'other' });
    start(otherPrefix, 'exit 1', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'x' });
    await waitDead([mine, mine2, stillRecorded, noSlug, otherAgent, otherPrefix]);
    record('r1', stillRecorded, 'recorded');

    expect(await manager.sweepDeadJobPanes(1)).toBe(1); // bounded
    expect(await manager.sweepDeadJobPanes()).toBe(1);
    expect(await manager.sweepDeadJobPanes()).toBe(0);

    expect(exists(mine)).toBe(false);
    expect(exists(mine2)).toBe(false);
    for (const kept of [live, stillRecorded, noSlug, otherAgent, otherPrefix]) {
      expect(exists(kept), kept).toBe(true);
    }
  });
});
