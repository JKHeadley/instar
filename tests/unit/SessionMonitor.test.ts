import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionMonitor, isForeignTopicOwner, deadRecoveryDue, DEAD_RECOVERY_MAX_AGE_MS, type SessionMonitorDeps } from '../../src/monitoring/SessionMonitor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * SessionMonitor tests — proactive session health monitoring.
 *
 * Validates detection of dead, unresponsive, and idle sessions,
 * notification cooldowns, triage integration, and status reporting.
 */

function createMockDeps(overrides: Partial<SessionMonitorDeps> = {}): SessionMonitorDeps {
  return {
    getActiveTopicSessions: vi.fn(() => new Map<number, string>()),
    captureSessionOutput: vi.fn(() => 'some output'),
    isSessionAlive: vi.fn(() => true),
    getTopicHistory: vi.fn(() => []),
    sendToTopic: vi.fn(async () => ({ messageId: 1, topicId: 1 })),
    triggerTriage: vi.fn(async () => ({ resolved: false })),
    ...overrides,
  };
}

describe('SessionMonitor', () => {
  it('treats an offline or transferring foreign owner as foreign until released', () => {
    expect(isForeignTopicOwner({ ownerMachineId: 'peer', status: 'active' }, 'self')).toBe(true);
    expect(isForeignTopicOwner({ ownerMachineId: 'peer', status: 'transferring' }, 'self')).toBe(true);
    expect(isForeignTopicOwner({ ownerMachineId: 'peer', status: 'released' }, 'self')).toBe(false);
    expect(isForeignTopicOwner({ ownerMachineId: 'self', status: 'active' }, 'self')).toBe(false);
  });
  let monitor: SessionMonitor;
  let deps: SessionMonitorDeps;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  describe('constructor and config defaults', () => {
    it('uses default config when none provided', () => {
      deps = createMockDeps();
      monitor = new SessionMonitor(deps);
      const status = monitor.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.trackedSessions).toBe(0);
      expect(status.sessionHealth).toEqual([]);
    });

    it('merges provided config with defaults', () => {
      deps = createMockDeps();
      monitor = new SessionMonitor(deps, { pollIntervalSec: 120, idleThresholdMinutes: 30 });
      const status = monitor.getStatus();
      expect(status.enabled).toBe(true);
    });

    it('respects enabled=false', () => {
      deps = createMockDeps();
      monitor = new SessionMonitor(deps, { enabled: false });
      const status = monitor.getStatus();
      expect(status.enabled).toBe(false);
    });
  });

  describe('start/stop lifecycle', () => {
    it('start begins polling and stop clears interval', () => {
      deps = createMockDeps();
      monitor = new SessionMonitor(deps, { pollIntervalSec: 10 });
      monitor.start();
      // Calling start again should be a no-op
      monitor.start();
      monitor.stop();
      // Calling stop again should be safe
      monitor.stop();
    });

    it('does not start if disabled', () => {
      deps = createMockDeps();
      monitor = new SessionMonitor(deps, { enabled: false });
      monitor.start();
      // Advance time — poll should not fire
      vi.advanceTimersByTime(20_000);
      expect(deps.getActiveTopicSessions).not.toHaveBeenCalled();
    });
  });

  describe('dead session detection', () => {
    it('does not report an old dead registration while a replacement is starting or alive', async () => {
      const now = Date.now();
      let current = 'old';
      let starting = true;
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: (name) => name === 'replacement',
        isSessionStarting: () => starting,
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      current = 'replacement'; starting = false;
      await monitor.poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
    });

    it('restarts a genuinely dead unanswered conversation before notifying anyone', async () => {
      const now = Date.now();
      let current = 'dead';
      const restartStoppedConversation = vi.fn(async () => { current = 'fresh'; return true; });
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: (name) => name === 'fresh',
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(restartStoppedConversation).toHaveBeenCalledWith(100, 'dead');
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      // If the fresh session dies on the same unanswered turn, the monitor
      // reports failure once instead of respawning forever.
      current = 'dead-again';
      await monitor.poll();
      expect(restartStoppedConversation).toHaveBeenCalledTimes(1);
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1);
      expect(deps.sendToTopic).toHaveBeenCalledWith(100, expect.stringContaining("couldn't restore"));
    });

    it('retries recovery after an older failure notice without repeating that notice', async () => {
      const now = Date.now();
      let current = 'dead';
      const restartStoppedConversation = vi.fn(async () => { current = 'fresh'; return true; });
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: (name) => name === 'fresh',
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      (monitor as any).deadNotified.set(100, { sessionName: 'dead', userMessageAt: now - 1000, at: now });
      await monitor.poll();
      expect(restartStoppedConversation).toHaveBeenCalledOnce();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('allows one restart per message, and none once the message is old', () => {
      expect(deadRecoveryDue(undefined, 1_000, 2_000)).toBe(true);
      expect(deadRecoveryDue(1_000, 1_000, 2_000)).toBe(false);
      expect(deadRecoveryDue(1_000, 5_000, 6_000)).toBe(true);
      expect(deadRecoveryDue(undefined, 1_000, 1_000 + DEAD_RECOVERY_MAX_AGE_MS)).toBe(false);
    });

    it('recovers a dead turn whose only later rows are server standby chrome', async () => {
      const now = Date.now();
      let current = 'dead';
      const restartStoppedConversation = vi.fn(async () => { current = 'fresh'; return true; });
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: (name) => name === 'fresh',
        getTopicHistory: () => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5000).toISOString() },
          { text: 'Session starting up — reading your message now. One moment.', fromUser: false, timestamp: new Date(now - 4000).toISOString() },
          { text: '🔭 Standby: the session is working on it.', fromUser: false, timestamp: new Date(now - 3000).toISOString() },
        ],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(restartStoppedConversation).toHaveBeenCalledWith(100, 'dead');
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('a server alert with automation provenance does not count as an answer', async () => {
      const now = Date.now();
      let current = 'dead';
      const restartStoppedConversation = vi.fn(async () => { current = 'fresh'; return true; });
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, current]]),
        isSessionAlive: (name) => name === 'fresh',
        getTopicHistory: () => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5000).toISOString() },
          { text: "It's been 12 minutes since the session said it would check.", fromUser: false, provenance: 'automation', timestamp: new Date(now - 3000).toISOString() },
        ],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(restartStoppedConversation).toHaveBeenCalledOnce();
    });

    it('an agent row is an answer even when its text looks like a standby', async () => {
      const now = Date.now();
      const restartStoppedConversation = vi.fn(async () => true);
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, 'dead']]),
        isSessionAlive: () => false,
        getTopicHistory: () => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5000).toISOString() },
          { text: '🔭 here is what I found', fromUser: false, provenance: 'agent', timestamp: new Date(now - 3000).toISOString() },
        ],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(restartStoppedConversation).not.toHaveBeenCalled();
    });

    it('stays quiet when a real agent answer follows the standby rows', async () => {
      const now = Date.now();
      const restartStoppedConversation = vi.fn(async () => true);
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, 'dead']]),
        isSessionAlive: () => false,
        getTopicHistory: () => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5000).toISOString() },
          { text: '🔭 Standby: the session is working on it.', fromUser: false, timestamp: new Date(now - 3000).toISOString() },
          { text: 'Here is the answer.', fromUser: false, timestamp: new Date(now - 2000).toISOString() },
        ],
        sessionRecovery: { checkAndRecover: async () => ({ recovered: false }), restartStoppedConversation } as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(restartStoppedConversation).not.toHaveBeenCalled();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('does not declare death after a Slack reply omitted from the channel ring', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: () => new Map([[100, 'dead']]),
        isSessionAlive: () => false,
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(now - 1000).toISOString() }],
        hasAgentRepliedSince: () => true,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
    });

    it('does not emit a user-notified event or delivered ledger for a quiet notice', async () => {
      deps = createMockDeps({ getActiveTopicSessions: () => new Map([[100, 'session-a']]), isSessionAlive: () => false,
        getTopicHistory: () => [{ text: 'hello', fromUser: true, timestamp: new Date(Date.now() - 300000).toISOString(), messageId: 7 }],
        sendToTopic: vi.fn().mockResolvedValue({ delivered: false, recorded: true, quietId: 'monitor-q' }) });
      monitor = new SessionMonitor(deps); const notices = vi.fn(); monitor.on('monitor:user-notified', notices);
      await monitor.poll(); await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalledOnce(); expect(notices).not.toHaveBeenCalled();
      expect((monitor as any).deadNotified.size).toBe(0);
    });

    it('detects dead session and reports only failed recovery', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[100, 'session-a']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
      });

      monitor = new SessionMonitor(deps, { pollIntervalSec: 60 });

      const events: string[] = [];
      monitor.on('monitor:recovery-triggered', () => events.push('recovery'));
      monitor.on('monitor:user-notified', () => events.push('notified'));

      // First poll: creates snapshot with healthy status
      await monitor.poll();

      // Second poll: session is dead with user waiting
      await monitor.poll();

      expect(events).toContain('recovery');
      expect(events).toContain('notified');
      expect(deps.triggerTriage).not.toHaveBeenCalled();
      expect(deps.sendToTopic).toHaveBeenCalledWith(100, expect.stringContaining("couldn't restore this conversation"));
    });

    it('does not notify if a fresh restart resolves the issue', async () => {
      const now = Date.now();
      let alive = false;
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[100, 'session-a']])),
        isSessionAlive: vi.fn(() => alive),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        sessionRecovery: { restartStoppedConversation: vi.fn(async () => { alive = true; }) } as any,
      });

      monitor = new SessionMonitor(deps);
      const events: string[] = [];
      monitor.on('monitor:user-notified', () => events.push('notified'));

      await monitor.poll();
      await monitor.poll();

      // Recovery resolved it, so no user notification.
      expect(events).not.toContain('notified');
      expect(deps.triggerTriage).not.toHaveBeenCalled();
    });
  });

  describe('topic owned by another pool machine', () => {
    function deadTopicDeps(isTopicOwnedByPeer?: (topicId: number) => boolean) {
      const now = Date.now();
      return createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[128732, 'echo-feature-maturation']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'Please give me the tldr', fromUser: true, timestamp: new Date(now - 11_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
        ...(isTopicOwnedByPeer ? { isTopicOwnedByPeer } : {}),
      });
    }

    it('posts no notice and runs no triage for a topic a peer owns (stale local mapping)', async () => {
      const recovery = { checkAndRecover: vi.fn(async () => ({ recovered: false, failureType: null, message: '' })) };
      deps = { ...deadTopicDeps(vi.fn(() => true)), sessionRecovery: recovery as any };
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      await monitor.poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
      expect(recovery.checkAndRecover).not.toHaveBeenCalled();
      expect(monitor.getStatus().trackedSessions).toBe(0);
    });

    it('still notifies for a topic this machine owns', async () => {
      deps = deadTopicDeps(vi.fn(() => false));
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalledWith(128732, expect.stringContaining("couldn't restore this conversation"));
    });

    it('treats an ownership lookup that throws as owned here (monitors as before)', async () => {
      deps = deadTopicDeps(vi.fn(() => { throw new Error('registry unreadable'); }));
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalled();
    });

    it('starts monitoring again once ownership returns to this machine', async () => {
      let peerOwns = true;
      deps = deadTopicDeps(vi.fn(() => peerOwns));
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
      peerOwns = false;
      await monitor.poll();
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalled();
    });
  });

  describe('unresponsive session detection', () => {
    it('detects unresponsive session when user message unanswered for 10+ min', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[200, 'session-b']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'same output'),
        getTopicHistory: vi.fn(() => [
          // User sent message 15 min ago, agent hasn't replied
          { text: 'hey are you there?', fromUser: true, timestamp: new Date(now - 15 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
      });

      monitor = new SessionMonitor(deps, { pollIntervalSec: 60 });
      const events: Array<{ topicId: number; sessionName: string; waitMinutes: number }> = [];
      monitor.on('monitor:unresponsive', (e) => events.push(e));

      // First poll creates snapshot
      await monitor.poll();
      // Second poll detects unresponsive
      await monitor.poll();

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.topicId).toBe(200);
      expect(deps.triggerTriage).toHaveBeenCalled();
    });
  });

  describe('idle session detection', () => {
    it('notifies user when session idle and user is waiting', async () => {
      // Use a dynamic getTopicHistory that returns timestamps relative to
      // the current fake time, so the user's message stays "recent" even
      // after we advance the clock.
      let pollCount = 0;
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[300, 'session-c']])),
        isSessionAlive: vi.fn(() => true),
        // Output never changes after first poll
        captureSessionOutput: vi.fn(() => 'stale output'),
        getTopicHistory: vi.fn(() => {
          const current = Date.now();
          // Agent responded 20 min ago, user asked again 5 min ago
          // (5 min < 10 min, so it hits "idle" not "unresponsive")
          return [
            { text: 'on it', fromUser: false, timestamp: new Date(current - 20 * 60_000).toISOString() },
            { text: 'any update?', fromUser: true, timestamp: new Date(current - 5 * 60_000).toISOString() },
          ];
        }),
      });

      monitor = new SessionMonitor(deps, { idleThresholdMinutes: 15 });

      const events: string[] = [];
      monitor.on('monitor:idle-detected', () => events.push('idle'));
      monitor.on('monitor:user-notified', () => events.push('notified'));

      // First poll: snapshot created, output = 'stale output', lastOutputAt = now
      await monitor.poll();

      // After the first poll, lastOutputAt is `now`, so it won't be idle yet.
      // We need the output to remain the same and time to pass beyond idleThreshold.
      // Advance time by 16 minutes so idle threshold is exceeded.
      vi.advanceTimersByTime(16 * 60_000);

      // Second poll: output hasn't changed, 16 minutes passed
      await monitor.poll();

      expect(events).toContain('idle');
      expect(events).toContain('notified');
      expect(deps.sendToTopic).toHaveBeenCalledWith(300, expect.stringContaining('idle'));
    });

    it('does NOT notify when session idle but no user waiting', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[400, 'session-d']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'stale output'),
        // Agent's last message is more recent than user's — no one waiting
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 60 * 60_000).toISOString() },
          { text: 'done!', fromUser: false, timestamp: new Date(now - 55 * 60_000).toISOString() },
        ]),
      });

      monitor = new SessionMonitor(deps, { idleThresholdMinutes: 15 });

      const events: string[] = [];
      monitor.on('monitor:user-notified', () => events.push('notified'));

      await monitor.poll();
      vi.advanceTimersByTime(20 * 60_000);
      await monitor.poll();

      // No notification — user isn't waiting and session isn't recently active
      expect(events).not.toContain('notified');
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });
  });

  describe('notification cooldown', () => {
    it('only sends one notification per cooldown period', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[500, 'session-e']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'help', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
      });

      monitor = new SessionMonitor(deps, { notificationCooldownMinutes: 30 });

      // First poll: snapshot created
      await monitor.poll();
      // Second poll: dead session detected, user notified
      await monitor.poll();

      const sendCount1 = (deps.sendToTopic as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(sendCount1).toBeGreaterThan(0);

      // Third poll within cooldown — should NOT re-notify
      await monitor.poll();

      const sendCount2 = (deps.sendToTopic as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(sendCount2).toBe(sendCount1);
    });
  });

  describe('healthy session', () => {
    it('takes no action for healthy sessions', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[600, 'session-f']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'active output ' + Date.now()),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 1 * 60_000).toISOString() },
          { text: 'hi there!', fromUser: false, timestamp: new Date(now - 30_000).toISOString() },
        ]),
      });

      monitor = new SessionMonitor(deps, { idleThresholdMinutes: 15 });

      await monitor.poll();

      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns correct session health data', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[700, 'session-g']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'output'),
        getTopicHistory: vi.fn(() => []),
      });

      monitor = new SessionMonitor(deps);
      await monitor.poll();

      const status = monitor.getStatus();
      expect(status.enabled).toBe(true);
      expect(status.trackedSessions).toBe(1);
      expect(status.sessionHealth).toHaveLength(1);
      expect(status.sessionHealth[0].topicId).toBe(700);
      expect(status.sessionHealth[0].sessionName).toBe('session-g');
      expect(status.sessionHealth[0].status).toBe('healthy');
    });

    it('cleans up snapshots for removed topics', async () => {
      const topicSessions = new Map<number, string>([[800, 'session-h']]);
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map(topicSessions)),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'output'),
        getTopicHistory: vi.fn(() => []),
      });

      monitor = new SessionMonitor(deps);
      await monitor.poll();
      expect(monitor.getStatus().trackedSessions).toBe(1);

      // Remove the topic
      topicSessions.clear();
      await monitor.poll();
      expect(monitor.getStatus().trackedSessions).toBe(0);
    });
  });

  describe('context-exhaustion: deferred recovery is SILENT + per-episode notify dedup', () => {
    // A REAL exhaustion error renders with its CLI recovery framing (post-#907
    // detector requirement) — the fixture must carry it to trigger the path.
    const exhaustedOutput = 'Error: Conversation too long. Press esc twice to go up a few messages and try again.';

    it('does NOT notify the user when recovery defers (session alive + producing work)', async () => {
      const mockRecovery = {
        checkAndRecover: vi.fn(async () => ({
          recovered: false, deferred: true, failureType: 'context_exhaustion' as const,
          message: 'Context-exhaustion recovery deferred - work-check found active children',
        })),
      };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[200, 'session-ctx']])),
        captureSessionOutput: vi.fn(() => exhaustedOutput),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps, { pollIntervalSec: 60 });
      const deferredEvents: unknown[] = [];
      monitor.on('monitor:recovery-deferred', (e) => deferredEvents.push(e));

      await monitor.poll();

      expect(mockRecovery.checkAndRecover).toHaveBeenCalled();
      // The session is ALIVE — a "conversation too long, start fresh" message
      // here is a false death report (the 2026-06-06 flood). Nothing is sent.
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(deferredEvents).toHaveLength(1);
    });

    it('a live context exhaustion failure stays silent across cooldowns', async () => {
      const mockRecovery = {
        checkAndRecover: vi.fn(async () => ({
          recovered: false, failureType: 'context_exhaustion' as const, message: 'recovery failed',
        })),
      };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[201, 'session-dead']])),
        captureSessionOutput: vi.fn(() => exhaustedOutput),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps, { pollIntervalSec: 60, notificationCooldownMinutes: 5 });

      await monitor.poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();

      // Past the cooldown the SAME dead session must not re-announce its death.
      vi.advanceTimersByTime(6 * 60_000);
      await monitor.poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('a live recovered context episode remains silent if the error reappears', async () => {
      let mode: 'fail' | 'recover' = 'fail';
      const mockRecovery = {
        checkAndRecover: vi.fn(async () => (mode === 'recover'
          ? { recovered: true, failureType: 'context_exhaustion' as const, message: 'recovered' }
          : { recovered: false, failureType: 'context_exhaustion' as const, message: 'failed' })),
      };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[202, 'session-cycle']])),
        captureSessionOutput: vi.fn(() => exhaustedOutput),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps, { pollIntervalSec: 60, notificationCooldownMinutes: 5 });

      await monitor.poll(); // failed recovery, session still alive
      expect(deps.sendToTopic).not.toHaveBeenCalled();

      mode = 'recover';
      vi.advanceTimersByTime(6 * 60_000);
      await monitor.poll(); // recovery succeeds -> episode cleared

      mode = 'fail';
      vi.advanceTimersByTime(6 * 60_000);
      await monitor.poll(); // same live session remains silent
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('presents a previously seen boolean to the same recovery after the banner scrolls away', async () => {
      const mockRecovery = {
        markContextWedgedSeen: vi.fn(),
        hasContextWedgedSeen: vi.fn(() => true),
        checkAndRecover: vi.fn(async () => ({
          recovered: false, deferred: true, failureType: 'context_exhaustion' as const,
          message: 'existing recovery deferred',
        })),
      };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[203, 'session-latched']])),
        captureSessionOutput: vi.fn(() => ''),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps, { pollIntervalSec: 60 });

      await monitor.poll();

      expect(mockRecovery.markContextWedgedSeen).not.toHaveBeenCalled();
      expect(mockRecovery.hasContextWedgedSeen).toHaveBeenCalledWith(203);
      expect(mockRecovery.checkAndRecover).toHaveBeenCalledWith(203, 'session-latched');
    });
  });

  describe('mechanical recovery integration', () => {
    it('skips triage when mechanical recovery succeeds', async () => {
      const now = Date.now();
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: true, failureType: 'stall' as const, message: 'Recovered from stall' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[901, 'session-mr']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      await monitor.poll();
      expect(mockRecovery.checkAndRecover).toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
    });

    it('tries a fresh restart when mechanical recovery fails', async () => {
      const now = Date.now();
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: false, failureType: null, message: 'No failure detected' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[902, 'session-mr2']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: false })),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps);
      await monitor.poll();
      await monitor.poll();
      expect(mockRecovery.checkAndRecover).toHaveBeenCalled();
      expect(deps.triggerTriage).not.toHaveBeenCalled();
      expect(deps.sendToTopic).toHaveBeenCalledWith(902, expect.stringContaining("couldn't restore"));
    });

    it('detects context exhaustion in healthy-looking alive session and triggers recovery', async () => {
      const now = Date.now();
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: true, failureType: 'context_exhaustion' as const, message: 'Respawned fresh' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[904, 'session-ctx']])),
        isSessionAlive: vi.fn(() => true),
        // Tmux output contains the context exhaustion error
        captureSessionOutput: vi.fn(() => 'Error during compaction: Error: Conversation too long. Press esc twice to go up a few messages and try again.\n> '),
        getTopicHistory: vi.fn(() => [
          { text: 'do the thing', fromUser: true, timestamp: new Date(now - 2 * 60_000).toISOString() },
          { text: 'working on it', fromUser: false, timestamp: new Date(now - 1 * 60_000).toISOString() },
        ]),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps);
      const events: string[] = [];
      monitor.on('monitor:mechanical-recovery', () => events.push('recovery'));

      // Even on the FIRST poll, context exhaustion should be detected
      // because it checks tmux output before health classification
      await monitor.poll();

      expect(mockRecovery.checkAndRecover).toHaveBeenCalled();
      expect(events).toContain('recovery');
    });

    it('does not report a live context-exhausted session as stopped after recovery fails', async () => {
      const now = Date.now();
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: false, failureType: null, message: 'No recovery' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[905, 'session-ctx2']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'Conversation too long. Press esc twice to go up a few messages and try again.'),
        getTopicHistory: vi.fn(() => []),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps);
      const events: string[] = [];
      monitor.on('monitor:user-notified', () => events.push('notified'));

      await monitor.poll();

      expect(events).not.toContain('notified');
      expect(deps.sendToTopic).not.toHaveBeenCalled();
    });

    it('calls recovery for idle sessions when user expects response (context exhaustion check)', async () => {
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: false, failureType: null, message: '' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[903, 'session-mr3']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'stale output'),
        getTopicHistory: vi.fn(() => {
          const current = Date.now();
          return [
            { text: 'on it', fromUser: false, timestamp: new Date(current - 20 * 60_000).toISOString() },
            { text: 'update?', fromUser: true, timestamp: new Date(current - 5 * 60_000).toISOString() },
          ];
        }),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps, { idleThresholdMinutes: 15 });
      await monitor.poll();
      vi.advanceTimersByTime(16 * 60_000);
      await monitor.poll();
      // Recovery is now called for all statuses (including idle) when user expects
      // a response — context exhaustion can manifest in alive/idle sessions
      expect(mockRecovery.checkAndRecover).toHaveBeenCalled();
    });

    it('does not spam context exhaustion notifications after snapshot cleanup between polls', async () => {
      // Regression test: snapshot gets deleted when session dies between polls,
      // new snapshot has no cooldown state, causing repeated detection + notification.
      // The topic-level cooldown map must survive snapshot cleanup.
      const mockRecovery = {
        checkAndRecover: vi.fn(async () => ({
          recovered: false,
          failureType: 'context_exhaustion' as const,
          message: 'In cooldown',
        })),
      };

      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[906, 'echo-topic-906']]))
          // First poll: session is active
          .mockReturnValueOnce(new Map([[906, 'echo-topic-906']]))
          // Second poll: session was killed (snapshot cleanup happens)
          .mockReturnValueOnce(new Map())
          // Third poll: new session spawned, also context-exhausted
          .mockReturnValueOnce(new Map([[906, 'echo-topic-906']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'Error: conversation is too long. Press Escape twice'),
        sessionRecovery: mockRecovery as any,
      });

      monitor = new SessionMonitor(deps, {
        pollIntervalSec: 10,
        notificationCooldownMinutes: 30,
      });

      // First poll: detects context exhaustion but the session is still alive.
      await (monitor as any).poll();
      expect(mockRecovery.checkAndRecover).toHaveBeenCalledTimes(1);
      expect(deps.sendToTopic).not.toHaveBeenCalled();

      // Second poll: session is gone, snapshot gets cleaned up
      await (monitor as any).poll();

      // Third poll: new session active with same error — should NOT re-notify (topic cooldown)
      await (monitor as any).poll();
      expect(deps.sendToTopic).not.toHaveBeenCalled();
      expect(mockRecovery.checkAndRecover).toHaveBeenCalledTimes(1); // Still just 1
    });

    it('does not spam dead-session notifications after snapshot cleanup between polls', async () => {
      // Regression: when a session dies between polls, the snapshot is deleted.
      // A new session appears and also dies — fresh snapshot has notifiedAt: null.
      // Without persistent topic-level cooldown, the "session has stopped" message
      // fires every poll (60s), spamming the user.
      const callCount = { getActive: 0 };
      const userMsgTs = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min ago

      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => {
          callCount.getActive++;
          // Simulate: session exists on polls 1, 3, 5... (dies between)
          // On even polls, session is gone → snapshot cleanup
          if (callCount.getActive % 2 === 0) return new Map();
          return new Map([[907, `session-${callCount.getActive}`]]);
        }),
        isSessionAlive: vi.fn(() => false), // Session is dead
        captureSessionOutput: vi.fn(() => null),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: userMsgTs },
        ]),
      });

      monitor = new SessionMonitor(deps, {
        pollIntervalSec: 60,
        notificationCooldownMinutes: 30,
      });

      // Poll 1: session is dead, user waiting → sends notification
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1);
      expect(deps.sendToTopic).toHaveBeenCalledWith(907, expect.stringContaining("couldn't restore this conversation"));

      // Poll 2: session gone → snapshot deleted
      await monitor.poll();

      // Poll 3: new session appears, also dead → should NOT re-notify (persistent cooldown)
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1); // Still 1, not 2

      // Poll 4: gone again
      await monitor.poll();

      // Poll 5: back again, still dead — still in cooldown
      await monitor.poll();
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1); // Still 1
    });
  });
});
