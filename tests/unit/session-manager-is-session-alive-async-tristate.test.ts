/**
 * tmux-event-loop-resilience §A — `SessionManager.isSessionAliveAsync` tri-state.
 *
 * THE critical conversion: a slow/timed-out `has-session` must read as
 * 'indeterminate' (the caller must NOT reap), NEVER as `false` ("dead") — the
 * latent spurious-reap bug (the line-2576 regression guard). And the monitorTick
 * mark-completed branch must fire ONLY on a definitive `false`.
 *
 * Drives the REAL method through a mocked `node:child_process` (the same seam
 * every SessionManager unit test uses); the per-op handler decides whether
 * `has-session` and `display-message` succeed, answer-absent, or time out.
 *
 * Boundaries covered (both sides):
 *  - definitely-absent has-session → false (genuinely dead)
 *  - timed-out has-session → 'indeterminate' (NEVER false) — the regression guard
 *  - alive pane (claude / node) → true
 *  - indeterminate display-message (session exists, pane unprobeable) → true (assume alive)
 *  - bare-shell pane → false  (classifyPaneCommand parity)
 *  - monitorTick: alive===false → marks completed; 'indeterminate' → does NOT
 *  - off-path (tmuxAsyncEnabled:false) → legacy false-on-timeout preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Per-op programmable tmux driver (shared by mock + tests) ──
type OpResult = { ok: string } | { reject: Error };
// keyed by the tmux subcommand (args[0]); a function lets a test branch on args.
let opHandlers: Record<string, (args: string[]) => OpResult> = {};

vi.mock('node:child_process', () => {
  const dispatch = (args: string[]): OpResult => {
    const op = args[0];
    const h = opHandlers[op];
    return h ? h(args) : { ok: '' };
  };
  const execFile = (
    _cmd: string,
    args: string[],
    opts: unknown,
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = (typeof opts === 'function' ? opts : cb) as
      | ((e: Error | null, r: { stdout: string; stderr: string }) => void)
      | undefined;
    const r = dispatch(args);
    setImmediate(() => {
      if ('reject' in r) callback?.(r.reject, { stdout: '', stderr: '' });
      else callback?.(null, { stdout: r.ok, stderr: '' });
    });
  };
  const execFileSync = vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
    if (!args) return '';
    const r = dispatch(args);
    if ('reject' in r) throw r.reject;
    return r.ok;
  });
  return { execFile, execFileSync };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig } from '../../src/core/types.js';

function timeoutErr(): Error {
  const e = new Error('Command failed (timeout)') as Error & { killed?: boolean; signal?: string };
  e.killed = true;
  e.signal = 'SIGKILL';
  return e;
}
function absentErr(): Error {
  const e = new Error("can't find session") as Error & { stderr?: string };
  e.stderr = "can't find session";
  return e;
}

type Probe = { isSessionAliveAsync(s: string): Promise<boolean | 'indeterminate'> };
const probe = (m: SessionManager): Probe => m as unknown as Probe;
const maintenanceTicks = new WeakMap<SessionManager, () => Promise<void>>();

function makeManager(tmpDir: string, state: StateManager, asyncEnabled: boolean): SessionManager {
  const config = {
    projectName: 'test-agent',
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/local/bin/claude',
    projectDir: tmpDir,
    maxSessions: 5,
    protectedSessions: [],
    completionPatterns: [],
  } as unknown as SessionManagerConfig;
  let maintenanceTick!: () => Promise<void>;
  const manager = new SessionManager(config, state, {
    tmuxAsyncEnabled: asyncEnabled,
    tmuxCallTimeoutMs: 9000,
    bindMaintenanceTickForTesting: (tick) => { maintenanceTick = tick; },
  });
  maintenanceTicks.set(manager, maintenanceTick);
  return manager;
}

describe('SessionManager.isSessionAliveAsync — tri-state (§A)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-alive-async-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    manager = makeManager(tmpDir, state, /* asyncEnabled */ true);
    opHandlers = {};
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-is-session-alive-async-tristate.test.ts' });
  });

  it('returns false ONLY on a definitely-absent has-session (genuinely dead)', async () => {
    opHandlers = { 'has-session': () => ({ reject: absentErr() }) };
    expect(await probe(manager).isSessionAliveAsync('dead')).toBe(false);
  });

  it('returns INDETERMINATE on a timed-out has-session — the line-2576 regression guard (NOT false)', async () => {
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }) };
    const v = await probe(manager).isSessionAliveAsync('slow');
    expect(v).toBe('indeterminate');
    // The bug this guards: a timeout used to map to false → mark-completed → spurious reap.
    expect(v).not.toBe(false);
  });

  it('returns false when there is no tmux socket at all (no server, so no session)', async () => {
    // What tmux 3.7c prints when the socket file is gone (after a reboot, or a cleaned temp directory).
    const noSocket = (): Error => {
      const e = new Error('Command failed') as Error & { stderr?: string };
      e.stderr = 'error connecting to /private/tmp/tmux-501/default (No such file or directory)';
      return e;
    };
    opHandlers = { 'has-session': () => ({ reject: noSocket() }) };
    expect(await probe(manager).isSessionAliveAsync('gone-with-the-server')).toBe(false);
    expect(await manager.isSessionAliveNonBlocking('gone-with-the-server')).toBe(false);
  });

  it('stays INDETERMINATE when the socket exists but cannot be reached', async () => {
    for (const stderr of [
      'error connecting to /private/tmp/tmux-501/default (Permission denied)',
      'error connecting to /private/tmp/tmux-501/default (Connection refused)',
    ]) {
      const e = new Error('Command failed') as Error & { stderr?: string };
      e.stderr = stderr;
      opHandlers = { 'has-session': () => ({ reject: e }) };
      expect(await probe(manager).isSessionAliveAsync('unreachable'), stderr).toBe('indeterminate');
    }
  });

  it('isSessionAliveNonBlocking is the same tri-state read under a public name', async () => {
    opHandlers = { 'has-session': () => ({ reject: absentErr() }) };
    expect(await manager.isSessionAliveNonBlocking('dead')).toBe(false);
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }) };
    expect(await manager.isSessionAliveNonBlocking('slow')).toBe('indeterminate');
    opHandlers = { 'has-session': () => ({ ok: '' }), 'display-message': () => ({ ok: 'claude||claude' }) };
    expect(await manager.isSessionAliveNonBlocking('live')).toBe(true);
  });

  it('two captures of the same pane at different depths are separate reads; the same depth is shared', async () => {
    const depths: string[] = [];
    opHandlers = { 'capture-pane': (args) => { const depth = args[args.indexOf('-S') + 1]; depths.push(depth); return { ok: `screen at ${depth}` }; } };
    const [twelve, thirty, thirtyAgain] = await Promise.all([
      manager.captureOutputAsync('pane', 12),
      manager.captureOutputAsync('pane', 30),
      manager.captureOutputAsync('pane', 30),
    ]);
    expect(twelve).toBe('screen at -12');
    expect(thirty).toBe('screen at -30');
    expect(thirtyAgain).toBe('screen at -30');
    expect(depths.sort()).toEqual(['-12', '-30']); // three callers, two subprocesses
  });

  it('returns true when the pane is a live claude process', async () => {
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      'display-message': () => ({ ok: 'claude||claude' }),
    };
    expect(await probe(manager).isSessionAliveAsync('live')).toBe(true);
  });

  it('returns true when the pane is a node process', async () => {
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      'display-message': () => ({ ok: 'node||node' }),
    };
    expect(await probe(manager).isSessionAliveAsync('live-node')).toBe(true);
  });

  it('assume-alive when display-message is INDETERMINATE (session exists, pane unprobeable)', async () => {
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      'display-message': () => ({ reject: timeoutErr() }),
    };
    expect(await probe(manager).isSessionAliveAsync('exists-but-blind')).toBe(true);
  });

  it('returns false for a bare-shell pane (classifyPaneCommand parity)', async () => {
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      // pane is bash and start_command equals the pane → bare leftover shell → dead
      'display-message': () => ({ ok: 'bash||bash' }),
    };
    expect(await probe(manager).isSessionAliveAsync('zombie')).toBe(false);
  });

  it('returns true for a bare-shell pane launched with a direct command (start_command differs)', async () => {
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      'display-message': () => ({ ok: 'bash||/some/script.sh' }),
    };
    expect(await probe(manager).isSessionAliveAsync('cmd-shell')).toBe(true);
  });

  // ── monitorTick integration: the decision actually drives mark-completed ──
  function runningSession(id: string, tmux: string): Session {
    const s: Session = {
      id,
      name: id,
      status: 'running',
      tmuxSession: tmux,
      // older than the 15s grace so monitorTick actually probes it
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      prompt: 'p',
    } as Session;
    state.saveSession(s);
    return s;
  }

  it('monitorTick marks a session completed when isSessionAliveAsync returns false', async () => {
    runningSession('reap-me', 'reap-me');
    opHandlers = { 'has-session': () => ({ reject: absentErr() }) };
    let completed = 0;
    manager.on('sessionComplete', () => { completed++; });

    await maintenanceTicks.get(manager)!();

    expect(state.getSession('reap-me')!.status).toBe('completed');
    expect(completed).toBe(1);
  });

  it('monitorTick does NOT mark completed when isSessionAliveAsync is INDETERMINATE (slow tmux ≠ dead)', async () => {
    runningSession('keep-me', 'keep-me');
    // has-session times out → indeterminate → no reap; display-message never reached
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }) };
    let completed = 0;
    manager.on('sessionComplete', () => { completed++; });

    await maintenanceTicks.get(manager)!();

    expect(state.getSession('keep-me')!.status).toBe('running'); // still alive — NOT reaped
    expect(completed).toBe(0);
  });

  it.each([false, true])('waits for a dead pane exit status before classifying a Codex 429 (async=%s)', async (enabled) => {
    const subject = makeManager(tmpDir, state, enabled);
    state.saveSession({ ...runningSession('pending-exit', 'pending-exit'), framework: 'codex-cli' });
    let exitStatus = '';
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      // tmux can close the pane fd before waitpid supplies its exit status.
      'display-message': () => ({ ok: `codex||codex||1||${exitStatus}||` }),
      'capture-pane': () => ({ ok: 'exceeded retry limit, last status: 429 Too Many Requests' }),
    };
    const notices: Session[] = [];
    subject.on('codexRateLimitExit', (s) => notices.push(s));
    try {
      expect(subject.isSessionAlive('pending-exit')).toBe(true);
      expect(await probe(subject).isSessionAliveAsync('pending-exit')).toBe('indeterminate');
      await maintenanceTicks.get(subject)!();
      expect(state.getSession('pending-exit')!.status).toBe('running');
      expect(notices).toHaveLength(0);

      exitStatus = '1';
      await maintenanceTicks.get(subject)!();
      expect(state.getSession('pending-exit')).toMatchObject({ status: 'failed', endedReason: 'codex-rate-limited' });
      expect(subject.listRunningSessions()).toHaveLength(0);
      await maintenanceTicks.get(subject)!();
      expect(notices).toHaveLength(1);
    } finally { subject.stopMonitoring(); }
  });

  it.each([false, true])('recognizes a signal-terminated pane without an exit status (async=%s)', async (enabled) => {
    const subject = makeManager(tmpDir, state, enabled);
    opHandlers = { 'display-message': () => ({ ok: 'codex||codex||1||||TERM' }) };
    try {
      expect(subject.isSessionAlive('signaled')).toBe(false);
      expect(await probe(subject).isSessionAliveAsync('signaled')).toBe(false);
    } finally { subject.stopMonitoring(); }
  });

  it('off-path (tmuxAsyncEnabled:false) retains the legacy false-on-timeout behavior', async () => {
    const off = makeManager(tmpDir, state, /* asyncEnabled */ false);
    // legacy body: a has-session timeout is caught → returns false ("dead"), byte-for-byte.
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }) };
    const v = await probe(off).isSessionAliveAsync('legacy-slow');
    expect(v).toBe(false);
    off.stopMonitoring();
  });
});

describe('monitorTick — a session that ended on its own leaves a reason and an evidence event', () => {
  // 2026-08-22: interactive codex sessions died ~18s after spawn and every
  // death was `status:'completed'`, reason null, no event anyone could log.
  // These tests pin the evidence trail the vanish branch now leaves.
  let dir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-exited-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    manager = makeManager(dir, state, true);
    opHandlers = {};
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/session-manager-is-session-alive-async-tristate.test.ts' });
  });

  function startupSession(id: string, ageMs: number): Session {
    const s: Session = {
      id, name: id, status: 'running', tmuxSession: id, framework: 'codex-cli',
      startedAt: new Date(Date.now() - ageMs).toISOString(), prompt: 'p',
    } as Session;
    state.saveSession(s);
    return s;
  }

  it("stamps endedReason 'process-exited-during-startup' and emits sessionExited carrying the LAST SAMPLED TAIL when a young session vanishes", async () => {
    startupSession('codex-young', 20_000); // past the 15s grace, inside the 120s startup window
    const MENU = '  Update available! 0.147.0 -> 0.149.0\n› 1. Update now\n  2. Skip\n  Press enter to continue';
    // Tick 1: pane alive, capture returns the menu → sampled.
    opHandlers = {
      'has-session': () => ({ ok: '' }),
      'display-message': () => ({ ok: 'codex||codex' }),
      'capture-pane': () => ({ ok: MENU }),
    };
    const exited: Array<{ session: Session; reason: string; uptimeSeconds?: number; lastTail?: string }> = [];
    manager.on('sessionExited', (e) => exited.push(e));
    await maintenanceTicks.get(manager)!();
    expect(exited).toHaveLength(0);
    expect(state.getSession('codex-young')!.status).toBe('running');

    // Tick 2: the pane is GONE (the process exited on its own). Capture is
    // empty — exactly the situation where the prior sample is the only evidence.
    opHandlers = {
      'has-session': () => ({ reject: absentErr() }),
      'capture-pane': () => ({ ok: '' }),
    };
    await maintenanceTicks.get(manager)!();

    const rec = state.getSession('codex-young')!;
    expect(rec.status).toBe('completed');
    expect(rec.endedReason).toBe('process-exited-during-startup');
    expect(exited).toHaveLength(1);
    expect(exited[0].reason).toBe('process-exited-during-startup');
    expect(exited[0].uptimeSeconds).toBeGreaterThanOrEqual(20);
    expect(exited[0].lastTail).toContain('Update now'); // the evidence the dead pane took with it
  });

  it("a vanish past the startup window is 'process-exited' (not during-startup), still emits, and carries no tail sample", async () => {
    startupSession('old-one', 10 * 60_000);
    opHandlers = { 'has-session': () => ({ reject: absentErr() }), 'capture-pane': () => ({ ok: '' }) };
    const exited: Array<{ reason: string; lastTail?: string }> = [];
    manager.on('sessionExited', (e) => exited.push(e));
    await maintenanceTicks.get(manager)!();
    expect(state.getSession('old-one')!.endedReason).toBe('process-exited');
    expect(exited).toHaveLength(1);
    expect(exited[0].lastTail).toBeUndefined();
  });

  it('distinguishes a clean finished worker from a non-zero process exit while work was in flight', async () => {
    startupSession('finished-worker', 10 * 60_000);
    startupSession('interrupted-worker', 10 * 60_000);
    const exited: Array<{ session: Session; exitCode: number; midWork: boolean; outcome: string }> = [];
    manager.on('sessionExited', (e) => exited.push(e));

    opHandlers = {
      'has-session': (args) => args.includes('=finished-worker')
        ? { reject: absentErr() }
        : { ok: '' },
      'display-message': () => ({ ok: 'codex||codex||1||-1' }),
      'capture-pane': () => ({ ok: '' }),
    };
    await maintenanceTicks.get(manager)!();

    expect(exited).toHaveLength(2);
    const finished = exited.find((e) => e.session.tmuxSession === 'finished-worker');
    const interrupted = exited.find((e) => e.session.tmuxSession === 'interrupted-worker');
    expect(finished).toMatchObject({ exitCode: 0, midWork: false, outcome: 'completed' });
    expect(interrupted).toMatchObject({ exitCode: -1, midWork: true, outcome: 'stopped-mid-work' });
    expect(finished!.outcome).not.toBe(interrupted!.outcome);
  });

  it('an INDETERMINATE probe stamps nothing and emits nothing — the slow-tmux guard still holds', async () => {
    startupSession('slow', 20_000);
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }), 'capture-pane': () => ({ ok: 'something' }) };
    let n = 0;
    manager.on('sessionExited', () => { n++; });
    await maintenanceTicks.get(manager)!();
    expect(state.getSession('slow')!.status).toBe('running');
    expect(state.getSession('slow')!.endedReason).toBeUndefined();
    expect(n).toBe(0);
  });

  describe('a headless one-shot that finished inside the startup window (instar-proof-1, 2026-11-03)', () => {
    function headless(id: string, ageMs: number, retained: boolean): void {
      state.saveSession({
        id, name: id, status: 'running', tmuxSession: id, framework: 'claude-code',
        launchLane: 'headless', completionMode: 'exit',
        startedAt: new Date(Date.now() - ageMs).toISOString(), prompt: 'p',
      } as Session);
      if (retained) {
        opHandlers = { 'set-option': () => ({ ok: '' }) };
        (manager as unknown as { retainFailedExitStatus(t: string): void }).retainFailedExitStatus(id);
      }
    }

    it("a clean exit (pane gone under remain-on-exit failed) is 'process-exited' with outcome completed", async () => {
      headless('job-done', 20_000, true);
      const exited: Array<{ reason: string; outcome: string; exitCode: number }> = [];
      manager.on('sessionExited', (e) => exited.push(e));
      opHandlers = { 'has-session': () => ({ reject: absentErr() }), 'capture-pane': () => ({ ok: '' }) };
      await maintenanceTicks.get(manager)!();
      expect(state.getSession('job-done')!.endedReason).toBe('process-exited');
      expect(exited[0]).toMatchObject({ reason: 'process-exited', outcome: 'completed', exitCode: 0 });
    });

    it('a failed exit (pane kept with a non-zero status) is still a startup death', async () => {
      headless('job-failed', 20_000, true);
      const exited: Array<{ reason: string; exitCode: number }> = [];
      manager.on('sessionExited', (e) => exited.push(e));
      opHandlers = { 'has-session': () => ({ ok: '' }), 'display-message': () => ({ ok: 'bash||claude -p||1||1' }), 'capture-pane': () => ({ ok: 'Not logged in' }) };
      await maintenanceTicks.get(manager)!();
      expect(exited[0]).toMatchObject({ reason: 'process-exited-during-startup', exitCode: 1 });
    });

    it('when remain-on-exit could not be set, a vanish stays a startup death (no evidence it exited cleanly)', async () => {
      headless('job-unretained', 20_000, false);
      opHandlers = { 'has-session': () => ({ reject: absentErr() }), 'capture-pane': () => ({ ok: '' }) };
      await maintenanceTicks.get(manager)!();
      expect(state.getSession('job-unretained')!.endedReason).toBe('process-exited-during-startup');
    });

    it('an INTERACTIVE session that vanished cleanly at a prompt is still a startup death', async () => {
      startupSession('codex-menu', 20_000);
      opHandlers = { 'set-option': () => ({ ok: '' }) };
      (manager as unknown as { retainFailedExitStatus(t: string): void }).retainFailedExitStatus('codex-menu');
      opHandlers = { 'has-session': () => ({ reject: absentErr() }), 'capture-pane': () => ({ ok: '' }) };
      await maintenanceTicks.get(manager)!();
      expect(state.getSession('codex-menu')!.endedReason).toBe('process-exited-during-startup');
    });
  });

  it('sessionComplete STILL fires on a vanish — existing listeners are unchanged', async () => {
    startupSession('compat', 20_000);
    opHandlers = { 'has-session': () => ({ reject: absentErr() }), 'capture-pane': () => ({ ok: '' }) };
    let completes = 0;
    manager.on('sessionComplete', () => { completes++; });
    await maintenanceTicks.get(manager)!();
    expect(completes).toBe(1);
  });
});
