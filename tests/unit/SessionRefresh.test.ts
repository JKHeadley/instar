/**
 * Tests for SessionRefresh — the agent-initiated session respawn orchestrator.
 *
 * Mocks the SessionManager, StateManager, TelegramAdapter, and respawner
 * callback. Asserts the kill+respawn ORDER and call shape directly — these
 * are the contract points that were missed in the first cut (kill was
 * silently absent because respawnSessionForTopic doesn't kill, only spawns).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRefresh } from '../../src/core/SessionRefresh.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { TopicResumeMap } from '../../src/core/TopicResumeMap.js';

function makeDeps(overrides: {
  topicId?: number | null;
  uuid?: string | null;
  stateSession?: { id: string; tmuxSession: string } | null;
  respawnerImpl?: (sessionName: string, topicId: number, followUpPrompt: string | undefined) => Promise<string>;
  rateLimit?: { maxPerWindow: number; windowMs: number };
  clock?: () => number;
  noTelegram?: boolean;
} = {}) {
  const topicId = overrides.topicId === undefined ? 9235 : overrides.topicId;
  const stateSession = overrides.stateSession === undefined
    ? { id: 'state-id-1', tmuxSession: 'echo-qalatra' }
    : overrides.stateSession;
  const uuid = overrides.uuid === undefined ? 'uuid-abc-123' : overrides.uuid;

  const callOrder: string[] = [];

  const telegram: Partial<TelegramAdapter> = {
    getTopicForSession: vi.fn().mockReturnValue(topicId),
  };
  const topicResumeMap: Partial<TopicResumeMap> = {
    findUuidForSession: vi.fn().mockReturnValue(uuid),
    save: vi.fn(),
    remove: vi.fn((_topic: number) => {
      callOrder.push('removeResume');
    }) as unknown as TopicResumeMap['remove'],
  };
  const sessionManager: Partial<SessionManager> = {
    killSession: vi.fn((_id: string) => {
      callOrder.push('killSession');
      return true;
    }) as unknown as SessionManager['killSession'],
  };
  const state: Partial<StateManager> = {
    listSessions: vi.fn().mockReturnValue(stateSession ? [stateSession] : []) as unknown as StateManager['listSessions'],
  };

  const respawner = overrides.respawnerImpl
    ? vi.fn(overrides.respawnerImpl)
    : vi.fn(async (_name: string, _topic: number, _prompt: string | undefined) => {
        callOrder.push('respawner');
        return 'new-tmux-session';
      });

  const refresh = new SessionRefresh({
    sessionManager: sessionManager as SessionManager,
    state: state as StateManager,
    telegram: overrides.noTelegram ? null : (telegram as TelegramAdapter),
    topicResumeMap: topicResumeMap as TopicResumeMap,
    respawner,
    rateLimit: overrides.rateLimit,
    clock: overrides.clock,
  });

  return { refresh, telegram, topicResumeMap, sessionManager, state, respawner, callOrder };
}

describe('SessionRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fresh mode (ContextWedgeSentinel re-wedge defense)', () => {
    it('clears the topic resume UUID AFTER kill and BEFORE respawn', async () => {
      const { refresh, topicResumeMap, callOrder } = makeDeps();
      const result = await refresh.refreshSession({ sessionName: 'echo-qalatra', fresh: true });
      expect(result.ok).toBe(true);
      expect(topicResumeMap.remove).toHaveBeenCalledWith(9235);
      // Order is load-bearing: beforeSessionKill saves the UUID during
      // killSession, so the clear MUST come after the kill; and the respawner
      // reads the (now-cleared) map, so the clear MUST come before respawn.
      expect(callOrder).toEqual(['killSession', 'removeResume', 'respawner']);
    });

    it('default (no fresh) preserves resume — never clears the UUID', async () => {
      const { refresh, topicResumeMap, callOrder } = makeDeps();
      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect(topicResumeMap.remove).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['killSession', 'respawner']);
    });
  });

  describe('happy path', () => {
    it('returns ok with new session name and topicId', async () => {
      const { refresh, respawner } = makeDeps();

      const result = await refresh.refreshSession({ sessionName: 'echo-qalatra', followUpPrompt: 'continue' });

      expect(result).toEqual({ ok: true, newSessionName: 'new-tmux-session', topicId: 9235 });
      expect(respawner).toHaveBeenCalledWith('echo-qalatra', 9235, 'continue');
    });

    it('kills the old session via sessionManager BEFORE invoking the respawner', async () => {
      const { refresh, sessionManager, callOrder } = makeDeps();

      await refresh.refreshSession({ sessionName: 'echo-qalatra' });

      expect(sessionManager.killSession).toHaveBeenCalledWith('state-id-1');
      // Order matters: kill must precede respawn or the new tmux can collide
      // with the old one on the same topic mapping.
      expect(callOrder).toEqual(['killSession', 'respawner']);
    });

    it('forwards undefined followUpPrompt when omitted', async () => {
      const { refresh, respawner } = makeDeps();
      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect(respawner).toHaveBeenCalledWith('echo-qalatra', 9235, undefined);
    });

    it('does NOT call findUuidForSession on the SessionRefresh side', async () => {
      // The UUID is persisted by the beforeSessionKill listener (which runs
      // synchronously during killSession). SessionRefresh must not call
      // findUuidForSession directly without a claudeSessionId — the prior
      // version did and silently no-op'd because the method requires that
      // second arg to return non-null.
      const { refresh, topicResumeMap } = makeDeps();
      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect(topicResumeMap.findUuidForSession).not.toHaveBeenCalled();
      expect(topicResumeMap.save).not.toHaveBeenCalled();
    });
  });

  describe('rate guard', () => {
    it('allows up to maxPerWindow refreshes', async () => {
      const { refresh } = makeDeps({ rateLimit: { maxPerWindow: 3, windowMs: 60_000 } });

      for (let i = 0; i < 3; i++) {
        const r = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
        expect(r.ok).toBe(true);
      }
    });

    it('rejects the (maxPerWindow + 1)th refresh with rate_limited', async () => {
      const { refresh, respawner, sessionManager } = makeDeps({ rateLimit: { maxPerWindow: 3, windowMs: 60_000 } });

      for (let i = 0; i < 3; i++) {
        await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      }
      const blocked = await refresh.refreshSession({ sessionName: 'echo-qalatra' });

      expect(blocked).toEqual({
        ok: false,
        code: 'rate_limited',
        message: expect.stringContaining('Refresh rate limit exceeded'),
      });
      expect(respawner).toHaveBeenCalledTimes(3);
      expect(sessionManager.killSession).toHaveBeenCalledTimes(3);
    });

    it('prunes stale timestamps — the rolling window actually slides', async () => {
      // Walk the clock across the window boundary. After the boundary,
      // earlier timestamps must be pruned (otherwise the cap would never
      // un-stick once exceeded). We assert pruning behaviorally: do enough
      // refreshes at t=0 to consume the budget, jump past the window, and
      // verify we can do the FULL maxPerWindow again — not just one more.
      let now = 1_000_000;
      const { refresh, respawner } = makeDeps({
        rateLimit: { maxPerWindow: 2, windowMs: 10_000 },
        clock: () => now,
      });

      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect((await refresh.refreshSession({ sessionName: 'echo-qalatra' })).ok).toBe(false);

      now += 11_000; // past window

      // After pruning, the entire budget should be available again.
      const r1 = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      const r2 = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      const r3 = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(false); // budget consumed again — confirms pruning didn't drop ALL state
      expect(respawner).toHaveBeenCalledTimes(4);
    });

    it('tracks rate limit per session — distinct sessions have independent counters', async () => {
      const { refresh, state } = makeDeps({ rateLimit: { maxPerWindow: 1, windowMs: 60_000 } });
      // Override listSessions to resolve either name.
      (state.listSessions as ReturnType<typeof vi.fn>).mockImplementation(() => [
        { id: 'state-a', tmuxSession: 'session-a' },
        { id: 'state-b', tmuxSession: 'session-b' },
      ]);

      const a = await refresh.refreshSession({ sessionName: 'session-a' });
      const b = await refresh.refreshSession({ sessionName: 'session-b' });

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });

    it('does not call the respawner or killSession when rate-limited', async () => {
      const { refresh, respawner, sessionManager } = makeDeps({ rateLimit: { maxPerWindow: 1, windowMs: 60_000 } });

      await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      await refresh.refreshSession({ sessionName: 'echo-qalatra' });

      expect(respawner).toHaveBeenCalledTimes(1);
      expect(sessionManager.killSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('in-flight guard', () => {
    it('refuses a second concurrent call for the same session with refresh_in_progress', async () => {
      // Hold the respawner so the first call is in-flight while the
      // second fires.
      let releaseFirst!: (value: string) => void;
      const firstSettled = new Promise<string>(r => { releaseFirst = r; });

      const { refresh, sessionManager } = makeDeps({
        respawnerImpl: async () => firstSettled,
      });

      const p1 = refresh.refreshSession({ sessionName: 'echo-qalatra' });
      // Yield to let p1 start (await its lookups + killSession).
      await Promise.resolve();
      await Promise.resolve();
      const second = await refresh.refreshSession({ sessionName: 'echo-qalatra' });

      expect(second).toEqual({
        ok: false,
        code: 'refresh_in_progress',
        message: expect.stringContaining('already in progress'),
      });
      // Only one killSession should have fired.
      expect(sessionManager.killSession).toHaveBeenCalledTimes(1);

      releaseFirst('new-name');
      const first = await p1;
      expect(first.ok).toBe(true);
    });

    it('clears the in-flight flag after success, allowing a follow-up refresh', async () => {
      const { refresh, sessionManager } = makeDeps();
      const r1 = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      const r2 = await refresh.refreshSession({ sessionName: 'echo-qalatra' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(sessionManager.killSession).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight flag after respawner throws', async () => {
      const { refresh, sessionManager } = makeDeps({
        respawnerImpl: async () => { throw new Error('boom'); },
      });
      await expect(refresh.refreshSession({ sessionName: 'echo-qalatra' })).rejects.toThrow('boom');
      // Second call must not get blocked by a stuck in-flight flag — it
      // must reach killSession again (and then throw "boom" for the same
      // underlying reason). The point of THIS test is that the second
      // failure is the respawner's, NOT a refresh_in_progress refusal.
      await expect(refresh.refreshSession({ sessionName: 'echo-qalatra' })).rejects.toThrow('boom');
      expect(sessionManager.killSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure modes', () => {
    it('returns not_telegram_bound when session has no topic binding', async () => {
      const { refresh, respawner, sessionManager } = makeDeps({ topicId: null });
      const result = await refresh.refreshSession({ sessionName: 'orphan-session' });
      expect(result).toEqual({
        ok: false,
        code: 'not_telegram_bound',
        message: expect.stringContaining('not bound to a Telegram topic'),
      });
      expect(respawner).not.toHaveBeenCalled();
      expect(sessionManager.killSession).not.toHaveBeenCalled();
    });

    it('returns no_telegram_adapter when no Telegram adapter is wired', async () => {
      const { refresh, respawner, sessionManager } = makeDeps({ noTelegram: true });
      const result = await refresh.refreshSession({ sessionName: 'whoever' });
      expect(result).toEqual({
        ok: false,
        code: 'no_telegram_adapter',
        message: expect.stringContaining('No Telegram adapter wired'),
      });
      expect(respawner).not.toHaveBeenCalled();
      expect(sessionManager.killSession).not.toHaveBeenCalled();
    });

    it('returns session_not_found when no running state session matches the tmux name', async () => {
      const { refresh, respawner, sessionManager } = makeDeps({ stateSession: null });
      const result = await refresh.refreshSession({ sessionName: 'ghost-session' });
      expect(result).toEqual({
        ok: false,
        code: 'session_not_found',
        message: expect.stringContaining('No running session'),
      });
      expect(respawner).not.toHaveBeenCalled();
      expect(sessionManager.killSession).not.toHaveBeenCalled();
    });
  });
});
