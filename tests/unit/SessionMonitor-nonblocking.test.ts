/**
 * SessionMonitor — the per-poll check of every session through the
 * non-blocking tmux reads.
 *
 * The poll asks, for every session, "is it alive?" and "what is on its
 * screen?". With the synchronous dependencies each of those is a tmux
 * subprocess the server's main thread waits on. When the asynchronous pair is
 * provided the poll must use it and must reach the same conclusions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { SessionMonitor, type SessionMonitorDeps } from '../../src/monitoring/SessionMonitor.js';

function deps(overrides: Partial<SessionMonitorDeps> = {}): SessionMonitorDeps {
  return {
    getActiveTopicSessions: vi.fn(() => new Map<number, string>()),
    captureSessionOutput: vi.fn(() => 'sync output'),
    isSessionAlive: vi.fn(() => true),
    getTopicHistory: vi.fn(() => []),
    sendToTopic: vi.fn(async () => ({ messageId: 1, topicId: 1 })),
    triggerTriage: vi.fn(async () => ({ resolved: false })),
    ...overrides,
  };
}

describe('SessionMonitor with non-blocking session reads', () => {
  let monitor: SessionMonitor;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { monitor?.stop(); vi.useRealTimers(); });

  it('a poll over several healthy sessions makes no synchronous liveness or screen read', async () => {
    const d = deps({
      getActiveTopicSessions: () => new Map([[1, 'a'], [2, 'b'], [3, 'c']]),
      isSessionAliveAsync: vi.fn(async () => true as const),
      captureSessionOutputAsync: vi.fn(async (name: string) => `screen of ${name}`),
    });
    monitor = new SessionMonitor(d);
    await monitor.poll();
    await monitor.poll();
    expect(d.isSessionAlive).not.toHaveBeenCalled();
    expect(d.captureSessionOutput).not.toHaveBeenCalled();
    expect(d.isSessionAliveAsync).toHaveBeenCalledTimes(6);
    expect(d.captureSessionOutputAsync).toHaveBeenCalledTimes(6);
    expect(d.captureSessionOutputAsync).toHaveBeenCalledWith('a', 30);
    expect(monitor.getStatus().sessionHealth.map((row) => row.status)).toEqual(['healthy', 'healthy', 'healthy']);
  });

  it('uses the synchronous pair when only one of the two asynchronous reads is provided', async () => {
    const d = deps({
      getActiveTopicSessions: () => new Map([[1, 'a']]),
      isSessionAliveAsync: vi.fn(async () => true as const),
    });
    monitor = new SessionMonitor(d);
    await monitor.poll();
    expect(d.isSessionAliveAsync).not.toHaveBeenCalled();
    expect(d.isSessionAlive).toHaveBeenCalledTimes(1);
    expect(d.captureSessionOutput).toHaveBeenCalledTimes(1);
  });

  it('a session the asynchronous read reports dead is restarted, exactly as with the synchronous read', async () => {
    const now = Date.now();
    for (const mode of ['sync', 'async'] as const) {
      let current = 'dead';
      const restartStoppedConversation = vi.fn(async () => { current = 'fresh'; return true; });
      const alive = (name: string): boolean => name === 'fresh';
      const d = deps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: vi.fn(alive),
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as never,
        ...(mode === 'async' ? {
          isSessionAliveAsync: vi.fn(async (name: string) => alive(name)),
          captureSessionOutputAsync: vi.fn(async () => 'screen'),
        } : {}),
      });
      monitor = new SessionMonitor(d);
      await monitor.poll();
      expect(restartStoppedConversation, mode).toHaveBeenCalledWith(100, 'dead');
      expect(d.sendToTopic, mode).not.toHaveBeenCalled();
      // A dead session's screen is not read, in either mode.
      if (mode === 'async') expect(d.captureSessionOutputAsync).not.toHaveBeenCalled();
      else expect(d.captureSessionOutput).not.toHaveBeenCalled();
      monitor.stop();
    }
  });

  it('an indeterminate answer (tmux too slow) is not a dead session: nothing is restarted and nobody is told', async () => {
    const now = Date.now();
    const restartStoppedConversation = vi.fn(async () => true);
    const d = deps({
      getActiveTopicSessions: () => new Map([[100, 'slow']]),
      isSessionAlive: vi.fn(() => false), // what a timed-out synchronous check would say
      getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
      sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as never,
      isSessionAliveAsync: vi.fn(async () => 'indeterminate' as const),
      captureSessionOutputAsync: vi.fn(async () => null), // the screen read timed out too
    });
    monitor = new SessionMonitor(d);
    await monitor.poll();
    await monitor.poll();
    expect(restartStoppedConversation).not.toHaveBeenCalled();
    expect(d.sendToTopic).not.toHaveBeenCalled();
    // The screen is not read when tmux just failed to answer: that would wait out a second timeout.
    expect(d.captureSessionOutputAsync).not.toHaveBeenCalled();
    expect(d.isSessionAlive).not.toHaveBeenCalled();
    expect(monitor.getStatus().sessionHealth[0]?.status).not.toBe('dead');
  });

  it('a run of indeterminate answers is reported once, at the fifth poll, and the count starts over after a definite answer', async () => {
    let answer: boolean | 'indeterminate' = 'indeterminate';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps({
        getActiveTopicSessions: () => new Map([[7, 'wedged']]),
        isSessionAliveAsync: vi.fn(async () => answer),
        captureSessionOutputAsync: vi.fn(async () => 'screen'),
      });
      monitor = new SessionMonitor(d);
      const reports: Array<{ topicId: number; sessionName: string; polls: number }> = [];
      monitor.on('monitor:liveness-indeterminate', (event) => reports.push(event));
      for (let poll = 0; poll < 12; poll++) await monitor.poll();
      expect(reports).toEqual([{ topicId: 7, sessionName: 'wedged', polls: 5 }]);
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('could not be determined'))).toHaveLength(1);
      answer = true;
      await monitor.poll();
      answer = 'indeterminate';
      for (let poll = 0; poll < 5; poll++) await monitor.poll();
      expect(reports).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('an asynchronous read that rejects does not stop the poll: the other sessions are still checked', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const d = deps({
        getActiveTopicSessions: () => new Map([[1, 'broken'], [2, 'fine']]),
        isSessionAliveAsync: vi.fn(async (name: string) => { if (name === 'broken') throw new Error('tmux exploded'); return true; }),
        captureSessionOutputAsync: vi.fn(async () => 'screen'),
      });
      monitor = new SessionMonitor(d);
      await expect(monitor.poll()).resolves.toBeUndefined();
      expect(d.captureSessionOutputAsync).toHaveBeenCalledWith('fine', 30);
      expect(monitor.getStatus().sessionHealth.map((row) => row.sessionName)).toEqual(['fine']);
      expect(d.sendToTopic).not.toHaveBeenCalled();
      // The monitor is not left marked as running.
      await monitor.poll();
      expect(d.isSessionAliveAsync).toHaveBeenCalledTimes(4);
    } finally {
      error.mockRestore();
    }
  });

  it('a tick that arrives while a poll is still waiting on tmux is skipped and said out loud', async () => {
    let release!: (value: boolean) => void;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps({
        getActiveTopicSessions: () => new Map([[1, 'slow']]),
        // Only the first read hangs; later ones answer at once.
        isSessionAliveAsync: vi.fn(() => (release ? Promise.resolve(true) : new Promise<boolean>((resolve) => { release = resolve; }))),
        captureSessionOutputAsync: vi.fn(async () => 'screen'),
      });
      monitor = new SessionMonitor(d);
      const first = monitor.poll();
      vi.advanceTimersByTime(60_000);
      await monitor.poll();
      vi.advanceTimersByTime(60_000);
      await monitor.poll();
      expect(d.isSessionAliveAsync).toHaveBeenCalledTimes(1);
      const skipped = warn.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('previous poll still running'));
      expect(skipped).toHaveLength(2);
      expect(skipped[0]).toContain('after 60 s');
      expect(skipped[1]).toContain('2 skipped in a row');
      release(true);
      await first;
      await monitor.poll();
      expect(d.isSessionAliveAsync).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('an unanswered message on a live but silent session is still escalated, the same as with the synchronous reads', async () => {
    const now = Date.now();
    const run = async (mode: 'sync' | 'async'): Promise<{ events: number; triaged: number }> => {
      const d = deps({
        getActiveTopicSessions: () => new Map([[200, 'session-b']]),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'same output'),
        getTopicHistory: () => [{ text: 'hey are you there?', fromUser: true, timestamp: new Date(now - 15 * 60_000).toISOString() }],
        ...(mode === 'async' ? {
          isSessionAliveAsync: vi.fn(async () => true as const),
          captureSessionOutputAsync: vi.fn(async () => 'same output'),
        } : {}),
      });
      monitor = new SessionMonitor(d, { pollIntervalSec: 60 });
      let events = 0;
      monitor.on('monitor:unresponsive', () => { events++; });
      await monitor.poll();
      await monitor.poll();
      monitor.stop();
      return { events, triaged: (d.triggerTriage as ReturnType<typeof vi.fn>).mock.calls.length };
    };
    const sync = await run('sync');
    const nonBlocking = await run('async');
    expect(sync.events).toBeGreaterThanOrEqual(1);
    expect(nonBlocking).toEqual(sync);
  });

  it('new screen content counts as activity, the same in both modes', async () => {
    for (const mode of ['sync', 'async'] as const) {
      vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
      let screen = 'first';
      const d = deps({
        getActiveTopicSessions: () => new Map([[1, 'a']]),
        captureSessionOutput: vi.fn(() => screen),
        ...(mode === 'async' ? {
          isSessionAliveAsync: vi.fn(async () => true as const),
          captureSessionOutputAsync: vi.fn(async () => screen),
        } : {}),
      });
      monitor = new SessionMonitor(d);
      await monitor.poll();
      vi.advanceTimersByTime(20 * 60_000);
      screen = 'second';
      await monitor.poll();
      expect(monitor.getStatus().sessionHealth[0]?.idleMinutes, mode).toBe(0);
      vi.advanceTimersByTime(20 * 60_000);
      await monitor.poll(); // same screen: no new activity
      expect(monitor.getStatus().sessionHealth[0]?.idleMinutes, mode).toBe(20);
      monitor.stop();
    }
  });

  it('the indeterminate count belongs to one session: a replacement on the same topic starts from one', async () => {
    let name = 'old';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps({
        getActiveTopicSessions: () => new Map([[7, name]]),
        isSessionAliveAsync: vi.fn(async () => 'indeterminate' as const),
        captureSessionOutputAsync: vi.fn(async () => 'screen'),
      });
      monitor = new SessionMonitor(d);
      const reports: Array<{ sessionName: string; polls: number }> = [];
      monitor.on('monitor:liveness-indeterminate', (event) => reports.push({ sessionName: event.sessionName, polls: event.polls }));
      for (let poll = 0; poll < 4; poll++) await monitor.poll();
      name = 'replacement';
      for (let poll = 0; poll < 4; poll++) await monitor.poll();
      expect(reports).toEqual([]); // 4 + 4 is not a run of 5 for either session
      await monitor.poll();
      expect(reports).toEqual([{ sessionName: 'replacement', polls: 5 }]);
    } finally {
      warn.mockRestore();
    }
  });

  it('a topic handed to a peer loses its indeterminate count: on its return the run starts from one', async () => {
    let peerOwned = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = deps({
        getActiveTopicSessions: () => new Map([[7, 'moving']]),
        isSessionAliveAsync: vi.fn(async () => 'indeterminate' as const),
        captureSessionOutputAsync: vi.fn(async () => 'screen'),
        isTopicOwnedByPeer: () => peerOwned,
      });
      monitor = new SessionMonitor(d);
      const reports: number[] = [];
      monitor.on('monitor:liveness-indeterminate', (event) => reports.push(event.polls));
      for (let poll = 0; poll < 4; poll++) await monitor.poll();
      peerOwned = true;
      await monitor.poll();
      peerOwned = false;
      for (let poll = 0; poll < 4; poll++) await monitor.poll();
      expect(reports).toEqual([]);
      await monitor.poll();
      expect(reports).toEqual([5]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the server gives the session monitor the non-blocking reads', () => {
  it('wires both asynchronous reads behind the async hot-path gate, to the session manager twins', () => {
    const server = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    const at = server.indexOf('sessionMonitor = new SessionMonitor(');
    const block = server.slice(at, at + 4000);
    expect(block).toContain('...(_tmuxAsyncEnabled ? {');
    expect(block).toContain('isSessionAliveAsync: (name: string) => sessionManager.isSessionAliveNonBlocking(name),');
    expect(block).toContain('captureSessionOutputAsync: (name: string, lines: number) => sessionManager.captureOutputAsync(name, lines),');
    const manager = fs.readFileSync(new URL('../../src/core/SessionManager.ts', import.meta.url), 'utf8');
    expect(manager).toMatch(/isSessionAliveNonBlocking\(tmuxSession: string\): Promise<boolean \| 'indeterminate'> \{\s+return this\.isSessionAliveAsync\(tmuxSession\);/);
  });
});
