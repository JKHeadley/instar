/**
 * tmux-event-loop-resilience §A — the async hot-path helper twins.
 *
 * Each `...Async` twin runs the bounded, SIGKILL-capped wrapper but preserves the
 * sync original's observable contract EXACTLY (the parsing/scan logic is shared so
 * it cannot drift). These tests exercise the REAL methods through a mocked
 * `node:child_process`; the per-op handler decides each tmux/ps outcome.
 *
 * Covered:
 *  - captureOutputAsync → null on a non-success (indeterminate) outcome
 *  - hasActiveProcessesAsync → TRUE fail-safe on an indeterminate list-panes
 *  - hasActiveProcessesAsync → identical verdict to the sync path on the same ps tree
 *  - detectCompletionAsync / detectSessionCompletionAsync → same .includes scan as sync
 *  - currentPaneCwdAsync → uses the lighter 2000ms budget (NOT 9000)
 *  - sendKeyAsync → converts a send-keys to the async wrapper (success → true)
 *  - sendKeyAsync → fails CLOSED (false) at the max-in-flight ceiling
 *  - the INJECTION send-keys sequence is NOT routed through the async wrapper
 *    (stays synchronous — its timing IS the correctness mechanism)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Per-op programmable driver, separate for the async (execFile) and sync
// (execFileSync) channels so a test can prove which channel a method used. ──
// `pending` lets a test hang a call on a shared gate (to occupy the in-flight
// ceiling) and resolve it later.
type SyncResult = { ok: string } | { reject: Error };
type OpResult = SyncResult | { pending: Promise<string> };
let asyncHandlers: Record<string, (args: string[], opts: Record<string, unknown>) => OpResult> = {};
let syncHandlers: Record<string, (args: string[]) => SyncResult> = {};
const asyncCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
const syncCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    opts: unknown,
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    let options: Record<string, unknown> = {};
    let callback = cb;
    if (typeof opts === 'function') callback = opts as typeof cb;
    else options = (opts as Record<string, unknown>) ?? {};
    asyncCalls.push({ cmd, args, opts: options });
    const key = cmd === 'ps' ? 'ps' : args[0];
    const h = asyncHandlers[key];
    const r: OpResult = h ? h(args, options) : { ok: '' };
    if ('pending' in r) {
      r.pending
        .then((stdout) => setImmediate(() => callback?.(null, { stdout, stderr: '' })))
        .catch((err: Error) => setImmediate(() => callback?.(err, { stdout: '', stderr: '' })));
      return;
    }
    setImmediate(() => {
      if ('reject' in r) callback?.(r.reject, { stdout: '', stderr: '' });
      else callback?.(null, { stdout: r.ok, stderr: '' });
    });
  };
  const execFileSync = vi.fn().mockImplementation((cmd: string, args?: string[]) => {
    syncCalls.push({ cmd, args: args ?? [] });
    if (!args) return '';
    const key = cmd === 'ps' ? 'ps' : args[0];
    const h = syncHandlers[key];
    const r: SyncResult = h ? h(args) : { ok: '' };
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

type Helpers = {
  captureOutputAsync(s: string, lines?: number): Promise<string | null>;
  hasActiveProcessesAsync(s: string): Promise<boolean>;
  hasActiveProcesses(s: string): boolean;
  detectCompletionAsync(s: string): Promise<boolean>;
  detectSessionCompletionAsync(s: Session): Promise<boolean>;
  currentPaneCwdAsync(s: string): Promise<string | null>;
  sendKeyAsync(s: string, key: string): Promise<boolean>;
  tmuxInflightCount: number;
};
const helpers = (m: SessionManager): Helpers => m as unknown as Helpers;

describe('SessionManager async hot-path helper twins (§A)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hotpath-'));
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    const config = {
      projectName: 'test-agent',
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
    } as unknown as SessionManagerConfig;
    manager = new SessionManager(config, state, { tmuxAsyncEnabled: true, tmuxMaxInFlight: 2, tmuxCallTimeoutMs: 9000 });
    asyncHandlers = {};
    syncHandlers = {};
    asyncCalls.length = 0;
    syncCalls.length = 0;
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-hotpath-helpers-async.test.ts' });
  });

  it('captureOutputAsync returns the pane text on success', async () => {
    asyncHandlers = { 'capture-pane': () => ({ ok: 'hello world\n' }) };
    expect(await helpers(manager).captureOutputAsync('s')).toBe('hello world\n');
  });

  it('captureOutputAsync returns NULL on an indeterminate (timed-out) capture', async () => {
    asyncHandlers = { 'capture-pane': () => ({ reject: timeoutErr() }) };
    expect(await helpers(manager).captureOutputAsync('s')).toBeNull();
  });

  it('hasActiveProcessesAsync returns TRUE (fail-safe — do not kill) on an indeterminate list-panes', async () => {
    asyncHandlers = { 'list-panes': () => ({ reject: timeoutErr() }) };
    expect(await helpers(manager).hasActiveProcessesAsync('s')).toBe(true);
  });

  it('hasActiveProcessesAsync returns FALSE on an absent / unparseable pane PID', async () => {
    asyncHandlers = { 'list-panes': () => ({ ok: 'not-a-pid\n' }) };
    expect(await helpers(manager).hasActiveProcessesAsync('s')).toBe(false);
  });

  it('hasActiveProcessesAsync gives the IDENTICAL verdict to the sync path on the same ps tree', async () => {
    // pane pid 1000; a non-baseline descendant (vim) under it ⇒ active=true.
    const psTree = 'PID PPID COMMAND\n1000 1 -bash\n2000 1000 vim file.txt\n';
    asyncHandlers = { 'list-panes': () => ({ ok: '1000\n' }), ps: () => ({ ok: psTree }) };
    syncHandlers = { 'list-panes': () => ({ ok: '1000\n' }), ps: () => ({ ok: psTree }) };
    const a = await helpers(manager).hasActiveProcessesAsync('s');
    const b = helpers(manager).hasActiveProcesses('s');
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(a).toBe(b);

    // And the IDLE tree (only baseline) ⇒ both false.
    const idleTree = 'PID PPID COMMAND\n1000 1 -bash\n';
    asyncHandlers = { 'list-panes': () => ({ ok: '1000\n' }), ps: () => ({ ok: idleTree }) };
    syncHandlers = { 'list-panes': () => ({ ok: '1000\n' }), ps: () => ({ ok: idleTree }) };
    expect(await helpers(manager).hasActiveProcessesAsync('s')).toBe(false);
    expect(helpers(manager).hasActiveProcesses('s')).toBe(false);
  });

  it('detectCompletionAsync matches the same completion pattern the sync scan would', async () => {
    asyncHandlers = { 'capture-pane': () => ({ ok: '...\nSession complete\n' }) };
    expect(await helpers(manager).detectCompletionAsync('s')).toBe(true);

    asyncHandlers = { 'capture-pane': () => ({ ok: 'still working\n' }) };
    expect(await helpers(manager).detectCompletionAsync('s')).toBe(false);
  });

  it('detectCompletionAsync returns false on an unreadable (null) capture', async () => {
    asyncHandlers = { 'capture-pane': () => ({ reject: timeoutErr() }) };
    expect(await helpers(manager).detectCompletionAsync('s')).toBe(false);
  });

  it('detectSessionCompletionAsync scans the session-specific patterns', async () => {
    const session = { id: 'x', tmuxSession: 's', completionPatterns: ['DONE-MARK'] } as unknown as Session;
    asyncHandlers = { 'capture-pane': () => ({ ok: 'foo DONE-MARK bar\n' }) };
    expect(await helpers(manager).detectSessionCompletionAsync(session)).toBe(true);

    asyncHandlers = { 'capture-pane': () => ({ ok: 'foo bar\n' }) };
    expect(await helpers(manager).detectSessionCompletionAsync(session)).toBe(false);
  });

  it('detectSessionCompletionAsync returns false when the session has no patterns', async () => {
    const session = { id: 'x', tmuxSession: 's', completionPatterns: [] } as unknown as Session;
    asyncHandlers = { 'capture-pane': () => ({ ok: 'anything\n' }) };
    expect(await helpers(manager).detectSessionCompletionAsync(session)).toBe(false);
  });

  it('currentPaneCwdAsync uses the lighter 2000ms budget (not the 9000ms default)', async () => {
    asyncHandlers = { 'display-message': () => ({ ok: '/home/agent/work\n' }) };
    const cwd = await helpers(manager).currentPaneCwdAsync('s');
    expect(cwd).toBe('/home/agent/work');
    const dispCall = asyncCalls.find((c) => c.args[0] === 'display-message')!;
    expect(dispCall.opts.timeout).toBe(2000);
  });

  it('currentPaneCwdAsync returns null on a non-success outcome', async () => {
    asyncHandlers = { 'display-message': () => ({ reject: timeoutErr() }) };
    expect(await helpers(manager).currentPaneCwdAsync('s')).toBeNull();
  });

  it('sendKeyAsync converts to the async wrapper — success ⇒ true', async () => {
    asyncHandlers = { 'send-keys': () => ({ ok: '' }) };
    expect(await helpers(manager).sendKeyAsync('s', 'Enter')).toBe(true);
    // it went through the async (execFile) channel, NOT the sync one
    expect(asyncCalls.some((c) => c.args[0] === 'send-keys')).toBe(true);
    expect(syncCalls.some((c) => c.args[0] === 'send-keys')).toBe(false);
  });

  it('sendKeyAsync fails CLOSED (false) at the max-in-flight ceiling', async () => {
    // Occupy the ceiling (tmuxMaxInFlight = 2) with two hung in-flight calls.
    let release!: (s: string) => void;
    const gate = new Promise<string>((res) => { release = res; });
    asyncHandlers = {
      gateA: () => ({ pending: gate }),
      gateB: () => ({ pending: gate }),
    };
    const f = manager as unknown as { tmuxExecCoalesced(op: string, s: string, a: string[]): Promise<unknown> };
    const p1 = f.tmuxExecCoalesced('op1', 'a', ['gateA']);
    const p2 = f.tmuxExecCoalesced('op2', 'b', ['gateB']);
    expect(helpers(manager).tmuxInflightCount).toBe(2);

    // sendKeyAsync sees the ceiling and returns false WITHOUT spawning.
    const before = asyncCalls.length;
    expect(await helpers(manager).sendKeyAsync('c', 'Enter')).toBe(false);
    expect(asyncCalls.length).toBe(before); // no new subprocess

    release('ok');
    await Promise.all([p1, p2]);
  });

  it('the INJECTION send-keys sequence is NOT routed through the async wrapper (stays synchronous)', () => {
    // No inputGuard → injectMessage → rawInject → all send-keys via execFileSync.
    syncHandlers = {}; // default ok for every sync op
    const ok = manager.injectMessage('s', 'hello there');
    expect(ok).toBe(true);
    // The injection used the SYNC channel for send-keys …
    expect(syncCalls.some((c) => c.args[0] === 'send-keys')).toBe(true);
    // … and NEVER the async wrapper (execFile) for the send-keys sequence.
    expect(asyncCalls.some((c) => c.args[0] === 'send-keys')).toBe(false);
  });
});
