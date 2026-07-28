/**
 * Tests for the death spiral fixes (v0.24.11):
 *
 * 1. Non-blocking health endpoint via cached session count
 * 2. Startup session purge (purgeDeadSessions)
 * 3. CoherenceMonitor suppression of known-pending updates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SessionLivenessOracle, type SessionLivenessOracleDeps } from '../../src/core/SessionLivenessOracle.js';
import { CoherenceMonitor } from '../../src/monitoring/CoherenceMonitor.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'death-spiral-test-'));
}

function createMockState(sessions: Session[] = []): StateManager {
  const sessionsMap = new Map(sessions.map(s => [s.id, { ...s }]));

  return {
    listSessions: vi.fn((filter?: { status?: string }) => {
      const all = Array.from(sessionsMap.values());
      if (filter?.status) return all.filter(s => s.status === filter.status);
      return all;
    }),
    getSession: vi.fn((id: string) => sessionsMap.get(id) ?? null),
    saveSession: vi.fn((s: Session) => { sessionsMap.set(s.id, { ...s }); }),
    removeSession: vi.fn((id: string) => sessionsMap.delete(id)),
    getJobState: vi.fn().mockReturnValue(null),
    saveJobState: vi.fn(),
    getValue: vi.fn().mockReturnValue(undefined),
    setValue: vi.fn(),
  } as unknown as StateManager;
}

function createSessionManagerConfig(overrides?: Partial<SessionManagerConfig>): SessionManagerConfig {
  return {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/bin/claude',
    projectDir: '/tmp/test-project',
    maxSessions: 5,
    protectedSessions: [],
    completionPatterns: [],
    ...overrides,
  } as SessionManagerConfig;
}

function makeSession(id: string, tmuxSession: string, status = 'running'): Session {
  return {
    id,
    name: tmuxSession,
    tmuxSession,
    status: status as Session['status'],
    startedAt: new Date().toISOString(),
  };
}

// ── Test Suite 1: Cached Session Count ─────────────────────────────

describe('Non-blocking health endpoint (cached sessions)', () => {
  it('getCachedRunningSessions returns { count: 0 } initially', () => {
    const state = createMockState();
    const sm = new SessionManager(createSessionManagerConfig(), state);
    const cached = sm.getCachedRunningSessions();
    expect(cached.count).toBe(0);
    expect(cached.sessions).toEqual([]);
  });

  it('listRunningSessions updates the cache as a side effect', () => {
    const sessions = [
      makeSession('s1', 'echo-test-1'),
      makeSession('s2', 'echo-test-2'),
    ];
    const state = createMockState(sessions);
    const config = createSessionManagerConfig({ tmuxPath: '/nonexistent/tmux' });
    const sm = new SessionManager(config, state);

    // Mock isSessionAlive to return true for all sessions
    vi.spyOn(sm as any, 'isSessionAlive').mockReturnValue(true);

    const result = sm.listRunningSessions();
    expect(result).toHaveLength(2);

    // Cache should be updated
    const cached = sm.getCachedRunningSessions();
    expect(cached.count).toBe(2);
    expect(cached.sessions).toHaveLength(2);
  });

  it('getCachedRunningSessions does not call tmux (non-blocking)', () => {
    const state = createMockState();
    const sm = new SessionManager(createSessionManagerConfig(), state);

    // Spy on isSessionAlive to verify it's NOT called
    const spy = vi.spyOn(sm as any, 'isSessionAlive');

    sm.getCachedRunningSessions();
    expect(spy).not.toHaveBeenCalled();
  });

  it('listRunningSessions with dead sessions updates cache to reflect only alive sessions', () => {
    const sessions = [
      makeSession('s1', 'alive-session'),
      makeSession('s2', 'dead-session'),
    ];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);

    // First session alive, second dead
    vi.spyOn(sm as any, 'isSessionAlive')
      .mockImplementation((name: string) => name === 'alive-session');

    sm.listRunningSessions();
    const cached = sm.getCachedRunningSessions();
    expect(cached.count).toBe(1);
    expect(cached.sessions[0].tmuxSession).toBe('alive-session');
  });
});

// ── Test Suite 2: Startup Session Purge ────────────────────────────

describe('Startup session purge (purgeDeadSessions) — oracle-backed, UNIFIED-SESSION-LIFECYCLE §P1', () => {
  /** Inject a liveness oracle whose `tmux list-sessions` returns `liveNames`, or
   *  fails (timeout/unreachable → indeterminate) when `fail` is set. */
  function injectOracle(sm: SessionManager, opts: { liveNames?: string[]; fail?: 'timeout' | 'error' }) {
    const exec = vi.fn(async () => {
      if (opts.fail === 'timeout') {
        const e = new Error('timed out') as Error & { killed: boolean; signal: string };
        e.killed = true; e.signal = 'SIGTERM';
        throw e;
      }
      if (opts.fail === 'error') throw new Error('EPIPE');
      return { stdout: (opts.liveNames ?? []).join('\n') + '\n', stderr: '' };
    });
    const deps: SessionLivenessOracleDeps = {
      tmuxPath: '/usr/bin/tmux',
      exec: exec as unknown as SessionLivenessOracleDeps['exec'],
    };
    sm.setLivenessOracle(new SessionLivenessOracle(deps, { probeBackoffMs: 0, probeRetries: 1 }));
    return exec;
  }

  it('returns 0 when no running sessions exist', async () => {
    const state = createMockState();
    const sm = new SessionManager(createSessionManagerConfig(), state);
    expect(await sm.purgeDeadSessions()).toBe(0);
  });

  it('purges sessions that are DEFINITIVELY dead (server reachable, exact id absent)', async () => {
    const sessions = [makeSession('s1', 'dead-1'), makeSession('s2', 'dead-2')];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);
    injectOracle(sm, { liveNames: ['some-other-live-session'] }); // neither dead-1/2 present

    const purged = await sm.purgeDeadSessions();
    expect(purged).toBe(2);
    const savedCalls = (state.saveSession as any).mock.calls;
    expect(savedCalls[0][0].status).toBe('completed');
    expect(savedCalls[0][0].endedReason).toBe('boot-purge-dead');
  });

  it('does NOT purge sessions that are alive (present in list-sessions)', async () => {
    const sessions = [makeSession('s1', 'alive-session')];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);
    injectOracle(sm, { liveNames: ['alive-session', 'another'] });

    expect(await sm.purgeDeadSessions()).toBe(0);
    expect(state.saveSession).not.toHaveBeenCalled();
  });

  it('[2026-05-27 INCIDENT FIX] does NOT purge sessions on a slow/timing-out tmux — keeps them', async () => {
    // The original bug: a 1s has-session timeout was treated as "dead", so a busy
    // tmux at boot mass-purged LIVE sessions ("9 of 9"). Now a timeout is
    // `indeterminate` → KEPT, never purged.
    const sessions = [
      makeSession('s1', 'codey-collaboration'),
      makeSession('s2', 'instar-exo'),
      makeSession('s3', 'instar-evolution'),
    ];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);
    injectOracle(sm, { fail: 'timeout' });

    const purged = await sm.purgeDeadSessions();
    expect(purged).toBe(0); // ← the fix: zero false purges under a slow boot
    expect(state.saveSession).not.toHaveBeenCalled();
  });

  it('does NOT purge on an unreachable/erroring tmux (indeterminate, not dead)', async () => {
    const sessions = [makeSession('s1', 'some-session')];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);
    injectOracle(sm, { fail: 'error' });

    expect(await sm.purgeDeadSessions()).toBe(0);
    expect(state.saveSession).not.toHaveBeenCalled();
  });

  it('only processes sessions with status "running"', async () => {
    const sessions = [
      makeSession('s1', 'completed-session', 'completed'),
      makeSession('s2', 'killed-session', 'killed'),
    ];
    const state = createMockState(sessions);
    const sm = new SessionManager(createSessionManagerConfig(), state);
    expect(await sm.purgeDeadSessions()).toBe(0);
  });
});

// ── Test Suite 3: CoherenceMonitor Update Suppression ──────────────

describe('CoherenceMonitor suppresses known-pending updates', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/death-spiral-fixes.test.ts:202' });
    vi.restoreAllMocks();
  });

  function writeAutoUpdaterState(stateDir: string, lastAppliedVersion: string) {
    fs.writeFileSync(
      path.join(stateDir, 'state', 'auto-updater.json'),
      JSON.stringify({ lastAppliedVersion }),
    );
  }

  it('passes when AutoUpdater has applied the mismatched version (restart pending)', () => {
    // Simulate: running v0.24.9, disk has v0.24.10, AutoUpdater applied v0.24.10
    writeAutoUpdaterState(dir, '0.24.10');

    const mockIntegrity = {
      runningVersion: '0.24.9',
      diskVersion: '0.24.10',
      versionMismatch: true,
      bootedAt: new Date().toISOString(),
    };
    vi.spyOn(ProcessIntegrity, 'getInstance').mockReturnValue(mockIntegrity as any);

    const monitor = new CoherenceMonitor({
      stateDir: dir,
      liveConfig: { get: vi.fn(), subscribe: vi.fn() } as any,
    });

    // Access the private method via bracket notation
    const results = (monitor as any).checkProcessIntegrity();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].message).toContain('restart pending');
  });

  it('fails when version mismatch is NOT from AutoUpdater', () => {
    // No auto-updater state file — mismatch is unexpected
    const mockIntegrity = {
      runningVersion: '0.24.9',
      diskVersion: '0.24.10',
      versionMismatch: true,
      bootedAt: new Date().toISOString(),
    };
    vi.spyOn(ProcessIntegrity, 'getInstance').mockReturnValue(mockIntegrity as any);

    const monitor = new CoherenceMonitor({
      stateDir: dir,
      liveConfig: { get: vi.fn(), subscribe: vi.fn() } as any,
    });

    const results = (monitor as any).checkProcessIntegrity();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].message).toContain('restart needed');
  });

  it('fails when AutoUpdater applied a DIFFERENT version than disk', () => {
    // AutoUpdater applied v0.24.8 but disk has v0.24.10 — something else changed it
    writeAutoUpdaterState(dir, '0.24.8');

    const mockIntegrity = {
      runningVersion: '0.24.9',
      diskVersion: '0.24.10',
      versionMismatch: true,
      bootedAt: new Date().toISOString(),
    };
    vi.spyOn(ProcessIntegrity, 'getInstance').mockReturnValue(mockIntegrity as any);

    const monitor = new CoherenceMonitor({
      stateDir: dir,
      liveConfig: { get: vi.fn(), subscribe: vi.fn() } as any,
    });

    const results = (monitor as any).checkProcessIntegrity();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].message).toContain('restart needed');
  });

  it('passes when no version mismatch exists', () => {
    const mockIntegrity = {
      runningVersion: '0.24.10',
      diskVersion: '0.24.10',
      versionMismatch: false,
      bootedAt: new Date().toISOString(),
    };
    vi.spyOn(ProcessIntegrity, 'getInstance').mockReturnValue(mockIntegrity as any);

    const monitor = new CoherenceMonitor({
      stateDir: dir,
      liveConfig: { get: vi.fn(), subscribe: vi.fn() } as any,
    });

    const results = (monitor as any).checkProcessIntegrity();
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].message).toContain('matches disk');
  });
});
