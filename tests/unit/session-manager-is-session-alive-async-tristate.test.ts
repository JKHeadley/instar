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
  return new SessionManager(config, state, { tmuxAsyncEnabled: asyncEnabled, tmuxCallTimeoutMs: 9000 });
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

    await (manager as unknown as { monitorTick(): Promise<void> }).monitorTick();

    expect(state.getSession('reap-me')!.status).toBe('completed');
    expect(completed).toBe(1);
  });

  it('monitorTick does NOT mark completed when isSessionAliveAsync is INDETERMINATE (slow tmux ≠ dead)', async () => {
    runningSession('keep-me', 'keep-me');
    // has-session times out → indeterminate → no reap; display-message never reached
    opHandlers = { 'has-session': () => ({ reject: timeoutErr() }) };
    let completed = 0;
    manager.on('sessionComplete', () => { completed++; });

    await (manager as unknown as { monitorTick(): Promise<void> }).monitorTick();

    expect(state.getSession('keep-me')!.status).toBe('running'); // still alive — NOT reaped
    expect(completed).toBe(0);
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
