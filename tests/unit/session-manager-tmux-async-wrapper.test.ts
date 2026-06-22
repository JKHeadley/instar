/**
 * tmux-event-loop-resilience §A — the async tmux wrapper + tri-state classifier.
 *
 * Exercises the REAL `SessionManager.tmuxExecAsync` / `tmuxExecCoalesced` funnel
 * through the production code path. The tmux subprocess is driven deterministically
 * by mocking `node:child_process` (the same seam every SessionManager unit test
 * uses) — NEVER a real tmux. A controllable per-op script lets a single test pick
 * success / definitely-absent / timeout(SIGKILL) / unknown-error and inspect how
 * the tri-state maps it.
 *
 * Decision boundaries covered (both sides):
 *  - success → { state:'success' }
 *  - server-answered-absent → { state:'definitely-absent' }   (the ONLY negative)
 *  - timeout (SIGKILL/killed) → 'indeterminate', NEVER 'definitely-absent'
 *  - unknown error → 'indeterminate'
 *  - SIGKILL killSignal + the configured 9000ms timeout are actually passed
 *  - single-flight: two concurrent calls with the SAME (op,session) → ONE subprocess
 *  - single-flight keys on the OP: a kill never coalesces with a read of the session
 *  - max-in-flight: the (N+1)th concurrent call resolves 'indeterminate' (max-inflight)
 *    WITHOUT spawning — fail CLOSED toward KEEP.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Programmable tmux subprocess driver (module scope so the mock + tests share it) ──
type ExecCall = { cmd: string; args: string[]; opts: Record<string, unknown> };

interface ExecScript {
  // Per-test behavior for the async path (execFile). Resolve with stdout, or
  // reject with an Error carrying { killed, signal, stderr } to simulate a
  // timeout/absent/unknown failure.
  handler: (call: ExecCall) => Promise<string> | { rejectWith: Error };
}

const recordedCalls: ExecCall[] = [];
let script: ExecScript = { handler: async () => '' };

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    opts: Record<string, unknown> | ((e: Error | null, r: { stdout: string; stderr: string }) => void),
    cb?: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    let options: Record<string, unknown> = {};
    let callback = cb;
    if (typeof opts === 'function') {
      callback = opts;
    } else {
      options = opts;
    }
    const call: ExecCall = { cmd, args, opts: options };
    recordedCalls.push(call);
    const result = script.handler(call);
    if (result && typeof (result as { rejectWith?: Error }).rejectWith !== 'undefined') {
      const err = (result as { rejectWith: Error }).rejectWith;
      setImmediate(() => callback?.(err, { stdout: '', stderr: '' }));
      return;
    }
    (result as Promise<string>)
      .then((stdout) => setImmediate(() => callback?.(null, { stdout, stderr: '' })))
      .catch((err: Error) => setImmediate(() => callback?.(err, { stdout: '', stderr: '' })));
  };
  return {
    execFile,
    // Sync path is unused by these wrapper tests but SessionManager imports it.
    execFileSync: vi.fn().mockReturnValue(''),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

// Build an Error shaped like a child_process timeout (promisify rejects with it).
function timeoutErr(): Error {
  const e = new Error('Command failed: tmux ... ') as Error & { killed?: boolean; signal?: string };
  e.killed = true;
  e.signal = 'SIGKILL';
  return e;
}
function absentErr(): Error {
  const e = new Error("can't find session: foo") as Error & { stderr?: string };
  e.stderr = "can't find session: foo";
  return e;
}
function unknownErr(): Error {
  return new Error('some other tmux failure');
}

// Helper to reach the private async funnel without `any`-ing the whole suite.
type Funnel = {
  tmuxExecAsync(args: string[], opts?: { timeoutMs?: number }): Promise<unknown>;
  tmuxExecCoalesced(op: string, session: string, args: string[], opts?: { timeoutMs?: number }): Promise<unknown>;
  tmuxInflightCount: number;
};
const asFunnel = (m: SessionManager): Funnel => m as unknown as Funnel;

describe('SessionManager tmux async wrapper — tri-state (§A)', () => {
  let tmpDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tmux-async-'));
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
      completionPatterns: [],
    } as unknown as SessionManagerConfig;
    // tmuxAsyncEnabled true so the async funnel is the live path; small max-inflight
    // so the ceiling is easy to hit; explicit 9000 timeout to assert it is passed.
    manager = new SessionManager(config, state, { tmuxAsyncEnabled: true, tmuxMaxInFlight: 2, tmuxCallTimeoutMs: 9000 });
    recordedCalls.length = 0;
    script = { handler: async () => '' };
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-tmux-async-wrapper.test.ts' });
  });

  it('maps a successful call to { state:"success", stdout }', async () => {
    script = { handler: async () => 'pane-output\n' };
    const out = (await asFunnel(manager).tmuxExecAsync(['capture-pane'])) as { state: string; stdout?: string };
    expect(out.state).toBe('success');
    expect(out.stdout).toBe('pane-output\n');
  });

  it('maps a server-answered "no such session" to definitely-absent (the only negative)', async () => {
    script = { handler: () => ({ rejectWith: absentErr() }) };
    const out = (await asFunnel(manager).tmuxExecAsync(['has-session'])) as { state: string };
    expect(out.state).toBe('definitely-absent');
  });

  it('maps a TIMEOUT (SIGKILL/killed) to indeterminate — NEVER definitely-absent', async () => {
    script = { handler: () => ({ rejectWith: timeoutErr() }) };
    const out = (await asFunnel(manager).tmuxExecAsync(['has-session'])) as { state: string };
    expect(out.state).toBe('indeterminate');
    expect(out.state).not.toBe('definitely-absent');
  });

  it('maps an unknown error (server unreachable / other) to indeterminate', async () => {
    script = { handler: () => ({ rejectWith: unknownErr() }) };
    const out = (await asFunnel(manager).tmuxExecAsync(['list-panes'])) as { state: string };
    expect(out.state).toBe('indeterminate');
  });

  it('passes killSignal:"SIGKILL" and the configured 9000ms timeout to the subprocess', async () => {
    script = { handler: async () => 'ok' };
    await asFunnel(manager).tmuxExecAsync(['has-session']);
    const call = recordedCalls.at(-1)!;
    expect(call.cmd).toBe('/usr/bin/tmux');
    expect(call.opts.killSignal).toBe('SIGKILL');
    expect(call.opts.timeout).toBe(9000);
  });

  it('an explicit per-call timeoutMs overrides the configured default', async () => {
    script = { handler: async () => 'ok' };
    await asFunnel(manager).tmuxExecAsync(['display-message'], { timeoutMs: 2000 });
    expect(recordedCalls.at(-1)!.opts.timeout).toBe(2000);
  });

  it('single-flight: two concurrent calls with the SAME (op,session) issue ONE subprocess', async () => {
    let resolveIt!: (s: string) => void;
    const gate = new Promise<string>((res) => { resolveIt = res; });
    script = { handler: () => gate };

    const f = asFunnel(manager);
    const p1 = f.tmuxExecCoalesced('has-session', 'sess-A', ['has-session']);
    const p2 = f.tmuxExecCoalesced('has-session', 'sess-A', ['has-session']);
    // both share the same in-flight promise → exactly one subprocess spawned
    expect(recordedCalls.length).toBe(1);
    resolveIt('ok');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1 as { state: string }).state).toBe('success');
    expect((r2 as { state: string }).state).toBe('success');
    expect(recordedCalls.length).toBe(1);
  });

  it('single-flight keys on the OP — a kill does NOT coalesce with a read of the same session', async () => {
    let resolveIt!: (s: string) => void;
    const gate = new Promise<string>((res) => { resolveIt = res; });
    script = { handler: () => gate };

    const f = asFunnel(manager);
    const p1 = f.tmuxExecCoalesced('has-session', 'sess-B', ['has-session']);
    const p2 = f.tmuxExecCoalesced('kill-session', 'sess-B', ['kill-session']);
    // different op keys → two distinct subprocesses (no silent coalesce hole)
    expect(recordedCalls.length).toBe(2);
    resolveIt('ok');
    await Promise.all([p1, p2]);
  });

  it('max-in-flight: the (N+1)th concurrent call resolves indeterminate(max-inflight) WITHOUT spawning', async () => {
    let release!: (s: string) => void;
    const gate = new Promise<string>((res) => { release = res; });
    script = { handler: () => gate };

    const f = asFunnel(manager);
    // tmuxMaxInFlight is 2 → the first two occupy the ceiling (distinct op keys).
    const p1 = f.tmuxExecCoalesced('op1', 'sA', ['x']);
    const p2 = f.tmuxExecCoalesced('op2', 'sB', ['y']);
    expect(recordedCalls.length).toBe(2);
    expect(f.tmuxInflightCount).toBe(2);

    // The 3rd is over the ceiling → fail CLOSED to KEEP, no new subprocess.
    const r3 = (await f.tmuxExecCoalesced('op3', 'sC', ['z'])) as { state: string; reason?: string };
    expect(r3.state).toBe('indeterminate');
    expect(r3.reason).toBe('max-inflight');
    expect(recordedCalls.length).toBe(2); // still only the two in-flight

    release('ok');
    await Promise.all([p1, p2]);
    // ceiling drains → a subsequent call spawns normally
    const r4 = (await f.tmuxExecCoalesced('op4', 'sD', ['w'])) as { state: string };
    expect(r4.state).toBe('success');
    expect(recordedCalls.length).toBe(3);
  });
});
