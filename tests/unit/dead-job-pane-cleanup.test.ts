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

describe.skipIf(!realTmux).each([false, true])('dead job pane cleanup (real tmux, private socket, async=%s)', (asyncEnabled) => {
  let root: string;
  let dir: string;
  let socket: string;
  let tmuxPath: string;
  let state: StateManager;
  let manager: SessionManager;
  let tick: () => Promise<void>;
  let launchSequence = 0;

  const tmux = (...args: string[]) => spawnSync(realTmux, ['-f', '/dev/null', '-L', socket, ...args], { encoding: 'utf-8' });
  const exists = (name: string) => tmux('has-session', '-t', `=${name}`).status === 0;
  const paneDead = (name: string) => tmux('display-message', '-t', `=${name}:`, '-p', '#{pane_dead}').stdout.trim() === '1';
  const base = () => path.basename(dir);

  /** Install retention before allowing the process to exit or close its PTY. */
  function start(name: string, cmd: string, env: Record<string, string>, retention: 'failed' | 'on' = 'failed'): void {
    const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const release = path.join(root, `start-${++launchSequence}`);
    // mkdtemp's path is quoted for the shell, including any apostrophe in TMPDIR.
    const quotedRelease = "'" + release.replaceAll("'", "'\\''") + "'";
    const r = tmux('new-session', '-d', '-s', name, ...flags,
      `while [ ! -f ${quotedRelease} ]; do sleep 0.01; done; ${cmd}`);
    if (r.status !== 0) throw new Error(`new-session failed: ${r.stderr}`);
    const retained = tmux('set-option', '-t', `=${name}:`, 'remain-on-exit', retention);
    if (retained.status !== 0) throw new Error(`remain-on-exit failed: ${retained.stderr}`);
    fs.writeFileSync(release, 'start');
  }

  async function waitDead(names: string[]): Promise<void> {
    for (let i = 0; i < 50; i++) {
      // pane_dead can precede waitpid's status; these fixtures need the final
      // process result. The tri-state suite drives that intermediate race.
      if (names.every((name) => {
        const [dead, status, signal] = tmux('display-message', '-t', `=${name}:`, '-p',
          '#{pane_dead}||#{pane_dead_status}||#{pane_dead_signal}').stdout.trim().split('||');
        return dead === '1' && Boolean(status || signal);
      })) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`panes lack a terminal result: ${JSON.stringify(names.map((name) => ({ name, result: tmux('display-message', '-t', `=${name}:`, '-p', '#{pane_dead}||#{pane_dead_status}||#{pane_dead_signal}||#{pane_pid}').stdout.trim() })))}`);
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
    fs.writeFileSync(tmuxPath, `#!/bin/sh\nexec "${realTmux}" -f /dev/null -L "${socket}" "$@"\n`, { mode: 0o755 });
    state = new StateManager(path.join(dir, 'state'));
    manager = new SessionManager({
      tmuxPath, claudePath: '/usr/local/bin/claude', projectDir: dir, maxSessions: 5,
      protectedSessions: [], completionPatterns: [], framework: 'claude-code',
    }, state, { tmuxAsyncEnabled: asyncEnabled, bindMaintenanceTickForTesting: (t) => { tick = t; } });
  });

  afterEach(() => {
    manager.stopMonitoring();
    tmux('kill-server');
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/dead-job-pane-cleanup.test.ts:cleanup' });
  });

  it('classifies a retained Codex 429 as failed, emits an alert signal, and removes it from running capacity', async () => {
    const job = `${base()}-job-bug-fixer-429`;
    start(job, 'echo "exceeded retry limit, last status: 429 Too Many Requests"; exit 1',
      { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'bug-fixer' });
    await waitDead([job]);
    record('codex429', job, 'bug-fixer');
    state.saveSession({ ...state.getSession('codex429')!, framework: 'codex-cli',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const exits: Session[] = [];
    manager.on('codexRateLimitExit', (session: Session) => exits.push(session));

    await tick();

    expect(state.getSession('codex429')?.status).toBe('failed');
    await tick();
    expect(exits).toHaveLength(1);
    expect(state.getSession('codex429')?.endedReason).toBe('codex-rate-limited');
    expect(manager.listRunningSessions()).toHaveLength(0);
    expect(exits).toHaveLength(1);
    expect(exits[0].id).toBe('codex429');
    expect(exists(job)).toBe(false);
  });

  it('waits when tmux closes the pane before the process supplies its nonzero exit', async () => {
    const job = `${base()}-job-pending-status`;
    const release = path.join(root, 'release-exit');
    const ready = path.join(root, 'descriptors-closed');
    start(job, `exec /bin/sh -c 'trap "" HUP; echo "429 Too Many Requests"; exec 0<&- 1>&- 2>&-; : >"${ready}"; while [ ! -f "${release}" ]; do sleep 0.1; done; exit 1'`,
      { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'bug-fixer' });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 100));
      expect(fs.existsSync(ready)).toBe(true);
      // 3.4 reports pane_dead=1 on fd closure; 3.7 waits for process exit.
      // Both must preserve the running session while its exit status is unknown.
      const [dead, status, signal] = tmux('display-message', '-t', `=${job}:`, '-p', '#{pane_dead}||#{pane_dead_status}||#{pane_dead_signal}').stdout.trim().split('||');
      expect(['0', '1']).toContain(dead);
      expect(status).toBe('');
      expect(signal).toBe('');
      record('pending-status', job, 'bug-fixer');
      state.saveSession({ ...state.getSession('pending-status')!, framework: 'codex-cli' });
      const notices: Session[] = [];
      manager.on('codexRateLimitExit', (s) => notices.push(s));
      await tick();
      expect(state.getSession('pending-status')?.status).toBe('running');
      expect(notices).toHaveLength(0);
      fs.writeFileSync(release, 'exit');
      await waitDead([job]);
      await tick();
      await tick();
      expect(state.getSession('pending-status')).toMatchObject({ status: 'failed', endedReason: 'codex-rate-limited' });
      expect(notices).toHaveLength(1);
      expect(exists(job)).toBe(false);
    } finally { fs.writeFileSync(release, 'exit'); }
  });

  it.each([
    ['clean-codex', 'codex-cli', 0, '429 Too Many Requests'],
    ['other-error', 'codex-cli', 1, 'connection refused'],
    ['other-framework', 'claude-code', 1, '429 Too Many Requests'],
  ] as const)('does not emit a Codex rate-limit notice for %s', async (id, framework, exitCode, text) => {
    const job = `${base()}-job-${id}`;
    // Keep the clean exit too, so its stale error text is actually captured.
    start(job, `echo "${text}"; exit ${exitCode}`, { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'test' }, 'on');
    await waitDead([job]);
    record(id, job, 'test');
    state.saveSession({ ...state.getSession(id)!, framework });
    const exits: Session[] = [];
    manager.on('codexRateLimitExit', (session) => exits.push(session));
    await tick();
    expect(state.getSession(id)?.status).toBe('completed');
    expect(exits).toHaveLength(0);
    expect(exists(job)).toBe(false);
  });

  it('keeps an operator kill that races with the Codex terminal capture', async () => {
    const job = `${base()}-job-racing-codex`;
    start(job, 'echo "429 Too Many Requests"; exit 1',
      { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'bug-fixer' });
    await waitDead([job]);
    record('racing', job, 'bug-fixer');
    state.saveSession({ ...state.getSession('racing')!, framework: 'codex-cli',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const originalCapture = (manager as any).captureOutputMaybeAsync.bind(manager);
    let terminalCaptures = 0;
    (manager as any).captureOutputMaybeAsync = async (...args: unknown[]) => {
      terminalCaptures++;
      const tail = await originalCapture(...args);
      const current = state.getSession('racing')!;
      state.saveSession({ ...current, status: 'killed', endedReason: 'operator-kill' });
      return tail;
    };
    const completed: Session[] = [];
    manager.on('sessionComplete', (session: Session) => completed.push(session));

    await tick();

    expect(terminalCaptures).toBe(1);
    expect(state.getSession('racing')?.status).toBe('killed');
    expect(state.getSession('racing')?.endedReason).toBe('operator-kill');
    expect(completed).toHaveLength(0);
  });

  it('completes cleanup even when a Codex alert listener throws', async () => {
    const job = `${base()}-job-alert-fault`;
    start(job, 'echo "429 Too Many Requests"; exit 1',
      { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'bug-fixer' });
    await waitDead([job]);
    record('alert-fault', job, 'bug-fixer');
    state.saveSession({ ...state.getSession('alert-fault')!, framework: 'codex-cli' });
    manager.on('codexRateLimitExit', () => { throw new Error('notification backend unavailable'); });
    const completed: Session[] = [];
    manager.on('sessionComplete', (session: Session) => completed.push(session));

    await tick();

    expect(state.getSession('alert-fault')?.status).toBe('failed');
    expect(completed).toHaveLength(1);
    expect(exists(job)).toBe(false);
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

  it('a job session whose active pane is dead but which holds a live split pane is kept (completion path and sweep)', async () => {
    const job = `${base()}-job-inspected-d1`;
    start(job, 'exit 3', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'inspected' });
    await waitDead([job]);
    // An operator splits a live pane into the failed job's session; the active pane stays dead.
    expect(tmux('split-window', '-d', '-t', `=${job}:`, 'sleep 60').status).toBe(0);
    expect(tmux('list-panes', '-s', '-t', `=${job}:`, '-F', '#{pane_dead}').stdout.trim().split('\n').sort()).toEqual(['0', '1']);
    record('j3', job, 'inspected');

    await tick();
    expect(state.getSession('j3')?.status).toBe('completed');
    expect(exists(job)).toBe(true);

    expect(await manager.sweepDeadJobPanes()).toBe(0);
    expect(exists(job)).toBe(true);

    // Once every pane is dead the session is reclaimed.
    tmux('kill-pane', '-a', '-t', `=${job}:.0`);
    await waitDead([job]);
    expect(await manager.sweepDeadJobPanes()).toBe(1);
    expect(exists(job)).toBe(false);
  });

  it('rejected sweep candidates use up the per-pass attempt budget', async () => {
    // tmux lists sessions by name, so the three rejected lookalikes come first.
    const rejected = ['e1', 'e2', 'e3'].map((n) => `${base()}-job-a-lookalike-${n}`);
    const killable = `${base()}-job-z-real-e4`;
    for (const r of rejected) start(r, 'exit 1', { INSTAR_AGENT_HOME: dir }); // no job slug ⇒ rejected
    start(killable, 'exit 1', { INSTAR_AGENT_HOME: dir, INSTAR_JOB_SLUG: 'real' });
    await waitDead([...rejected, killable]);

    expect(await manager.sweepDeadJobPanes(3)).toBe(0); // budget spent on rejections
    expect(exists(killable)).toBe(true);
    expect(await manager.sweepDeadJobPanes(4)).toBe(1);
    expect(exists(killable)).toBe(false);
    for (const r of rejected) expect(exists(r), r).toBe(true);
  });
});
