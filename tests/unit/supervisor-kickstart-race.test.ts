import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

/**
 * Regression tests for the P1 lifeline-kickstart race (observed 2026-05-23 during
 * a codex-live-test deploy):
 *
 *   `launchctl kickstart -k` of the lifeline SIGKILLs the old server tmux session.
 *   On the fresh lifeline boot, ServerSupervisor.start() called isServerSessionAlive()
 *   (a bare `tmux has-session`) and observed the *dying* session as alive → took the
 *   "already running" no-op branch, set isRunning=true, and NEVER respawned. The
 *   server then fully exited, leaving the supervisor falsely believing it was up —
 *   ~3min outage until a second kickstart spawned cleanly.
 *
 * The fix has two halves:
 *   1. start() gates the "already running" branch on verifyServerResponding() — a
 *      real /health probe with retries — so a dying session falls through to spawn.
 *   2. spawnServer() kills any lingering session before `tmux new-session` (which
 *      fails on a duplicate name), so the fall-through respawn actually succeeds.
 *
 * These tests exercise the REAL methods with their dependencies stubbed.
 */

function makeSupervisor(): any {
  const s: any = new ServerSupervisor({
    projectDir: '/tmp/p1-test-project',
    projectName: 'p1-test',
    port: 59999,
  });
  // Pretend tmux exists so start() does not early-return.
  s.tmuxPath = 'tmux';
  // Never set up real intervals / SleepWakeDetector during these tests.
  s.startHealthChecks = vi.fn();
  return s;
}

describe('ServerSupervisor — P1 kickstart race', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('verifyServerResponding()', () => {
    it('returns true on the first healthy probe (no retries needed)', async () => {
      const s = makeSupervisor();
      const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
      globalThis.fetch = fetchMock as any;

      const ok = await s.verifyServerResponding(3, 0);
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1); // short-circuits on first success
    });

    it('returns false when the server never responds (all attempts fail)', async () => {
      const s = makeSupervisor();
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      globalThis.fetch = fetchMock as any;

      const ok = await s.verifyServerResponding(3, 0);
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(3); // exhausts all attempts
    });

    it('recovers if the server responds on a later attempt (transient stall)', async () => {
      const s = makeSupervisor();
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('stall'))
        .mockResolvedValueOnce({ ok: true } as Response);
      globalThis.fetch = fetchMock as any;

      const ok = await s.verifyServerResponding(3, 0);
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('start() decision boundary', () => {
    it('respawns when a tmux session exists but the server is NOT responding (the race)', async () => {
      const s = makeSupervisor();
      s.isServerSessionAlive = vi.fn().mockReturnValue(true);      // dying session lingers
      s.verifyServerResponding = vi.fn().mockResolvedValue(false); // but server is dead
      s.spawnServer = vi.fn().mockReturnValue(true);

      const result = await s.start();

      expect(s.spawnServer).toHaveBeenCalledTimes(1); // MUST respawn, not no-op
      expect(result).toBe(true);
    });

    it('does NOT respawn when the session exists and the server IS responding', async () => {
      const s = makeSupervisor();
      s.isServerSessionAlive = vi.fn().mockReturnValue(true);
      s.verifyServerResponding = vi.fn().mockResolvedValue(true); // genuinely up
      s.spawnServer = vi.fn().mockReturnValue(true);

      const result = await s.start();

      expect(s.spawnServer).not.toHaveBeenCalled(); // no-op branch is correct here
      expect(s.isRunning).toBe(true);
      expect(result).toBe(true);
    });

    it('spawns when no session exists at all', async () => {
      const s = makeSupervisor();
      s.isServerSessionAlive = vi.fn().mockReturnValue(false);
      s.verifyServerResponding = vi.fn(); // should not be consulted
      s.spawnServer = vi.fn().mockReturnValue(true);

      const result = await s.start();

      expect(s.spawnServer).toHaveBeenCalledTimes(1);
      expect(s.verifyServerResponding).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});
