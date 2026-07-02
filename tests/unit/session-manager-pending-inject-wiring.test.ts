/**
 * Wiring-integrity tests — SessionManager × PendingInjectStore (finding
 * 8d300555). Verifies the durable inject ledger is REALLY wired into the
 * spawn path (not a no-op): a record exists on disk during the
 * spawn→ready→inject window, is cleared after the inject runs, and
 * recoverPendingInjects() re-delivers through the real readiness machinery.
 *
 * Mirrors the child_process mock pattern of session-manager-behavioral.test.ts
 * (no real tmux).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockTmuxSessions = new Set<string>();

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
      if (!args) return '';
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '');
        if (!mockTmuxSessions.has(target)) throw new Error(`session not found: ${target}`);
        return '';
      }
      if (args[0] === 'new-session') {
        const sIdx = args.indexOf('-s');
        if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
        return '';
      }
      if (args[0] === 'kill-session') {
        mockTmuxSessions.delete(args[2]?.replace(/^=/, ''));
        return '';
      }
      return '';
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as typeof cb;
        if (args[0] === 'has-session') {
          const target = args[2]?.replace(/^=/, '');
          if (!mockTmuxSessions.has(target)) cb?.(new Error(`session not found: ${target}`), { stdout: '' });
          else cb?.(null, { stdout: '' });
        } else {
          cb?.(null, { stdout: '' });
        }
      },
    ),
  };
});

// Import after mock
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager pending-inject wiring (finding 8d300555)', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    mockTmuxSessions.clear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-inject-wiring-'));
    stateDir = path.join(tmpDir, 'state-root');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
      framework: 'claude-code',
    };
    manager = new SessionManager(config, state);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-pending-inject-wiring.test.ts:afterEach' });
  });

  function pendingDir(): string {
    return path.join(stateDir, 'state', 'pending-injects');
  }
  function pendingFiles(): string[] {
    try { return fs.readdirSync(pendingDir()).filter((f) => f.endsWith('.json')); } catch { return []; }
  }

  it('records the pending inject at spawn and clears it after the inject runs', async () => {
    // Deterministic readiness: resolve true immediately so the inject runs on
    // the next microtask instead of polling capture-pane for 90s.
    let resolveReady!: (v: boolean) => void;
    const readyGate = new Promise<boolean>((r) => { resolveReady = r; });
    vi.spyOn(manager as unknown as { waitForClaudeReadyWithRetry(s: string, t: number): Promise<boolean> }, 'waitForClaudeReadyWithRetry')
      .mockImplementation(() => readyGate);
    const injectSpy = vi.spyOn(manager as unknown as { injectMessage(s: string, m: string): void }, 'injectMessage')
      .mockImplementation(() => undefined);

    const tmux = await manager.spawnInteractiveSession('[telegram:2271] How is this looking?', 'wiring-test', { telegramTopicId: 2271 });

    // THE WINDOW: spawn returned, inject not yet run — the record must be durable NOW.
    const during = pendingFiles();
    expect(during).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(pendingDir(), during[0]), 'utf8'));
    expect(record.tmuxSession).toBe(tmux);
    expect(record.telegramTopicId).toBe(2271);
    expect(record.initialMessage).toContain('How is this looking?');

    // Session becomes ready → inject runs → record cleared.
    resolveReady(true);
    await vi.waitFor(() => {
      expect(injectSpy).toHaveBeenCalled();
      expect(pendingFiles()).toHaveLength(0);
    }, { timeout: 5000 });
  });

  it('recoverPendingInjects re-delivers into a still-alive session through the readiness path', async () => {
    // Simulate the incident: a record left by the PREVIOUS server process,
    // whose tmux session is still alive.
    const tmux = `${path.basename(tmpDir)}-survivor`;
    mockTmuxSessions.add(tmux);
    (manager as unknown as { pendingInjects: { record(e: { tmuxSession: string; initialMessage: string; telegramTopicId?: number }): void } })
      .pendingInjects.record({ tmuxSession: tmux, initialMessage: 'orphaned message', telegramTopicId: 2271 });

    vi.spyOn(manager as unknown as { waitForClaudeReadyWithRetry(s: string, t: number): Promise<boolean> }, 'waitForClaudeReadyWithRetry')
      .mockResolvedValue(true);
    const injectSpy = vi.spyOn(manager as unknown as { injectMessage(s: string, m: string): void }, 'injectMessage')
      .mockImplementation(() => undefined);

    const result = await manager.recoverPendingInjects();

    expect(result.redelivered).toEqual([tmux]);
    // F7 (roadmap 0.6): the redelivered initial message is instar's OWN
    // bootstrap — it must carry the in-process first-party provenance so the
    // InputGuard never flags the system's own startup instructions.
    expect(injectSpy).toHaveBeenCalledWith(tmux, 'orphaned message', { firstParty: { source: 'session-bootstrap' } });
    expect(pendingFiles()).toHaveLength(0);
  });

  it('recoverPendingInjects expires a dead-session record without ever calling inject', async () => {
    (manager as unknown as { pendingInjects: { record(e: { tmuxSession: string; initialMessage: string }): void } })
      .pendingInjects.record({ tmuxSession: 'gone-with-the-restart', initialMessage: 'lost message' });
    const injectSpy = vi.spyOn(manager as unknown as { injectMessage(s: string, m: string): void }, 'injectMessage')
      .mockImplementation(() => undefined);

    const result = await manager.recoverPendingInjects();

    expect(result.deadSession).toEqual(['gone-with-the-restart']);
    expect(injectSpy).not.toHaveBeenCalled();
    expect(pendingFiles()).toHaveLength(0); // expired — but the loss was REPORTED, not silent
  });
});
