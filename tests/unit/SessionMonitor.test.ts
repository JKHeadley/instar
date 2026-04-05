import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionMonitor, type SessionMonitorDeps } from '../../src/monitoring/SessionMonitor.js';

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
    it('detects dead session when user is waiting and triggers triage + notification', async () => {
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
      expect(deps.triggerTriage).toHaveBeenCalled();
      expect(deps.sendToTopic).toHaveBeenCalledWith(100, expect.stringContaining('session has stopped'));
    });

    it('does not notify if triage resolves the issue', async () => {
      const now = Date.now();
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[100, 'session-a']])),
        isSessionAlive: vi.fn(() => false),
        getTopicHistory: vi.fn(() => [
          { text: 'hello', fromUser: true, timestamp: new Date(now - 5 * 60_000).toISOString() },
        ]),
        triggerTriage: vi.fn(async () => ({ resolved: true })),
      });

      monitor = new SessionMonitor(deps);
      const events: string[] = [];
      monitor.on('monitor:user-notified', () => events.push('notified'));

      await monitor.poll();
      await monitor.poll();

      // Triage resolved it, so no user notification
      expect(events).not.toContain('notified');
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

    it('falls through to triage when mechanical recovery fails', async () => {
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
      expect(deps.triggerTriage).toHaveBeenCalled();
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

    it('notifies user when context exhaustion detected but recovery fails', async () => {
      const now = Date.now();
      const mockRecovery = { checkAndRecover: vi.fn(async () => ({ recovered: false, failureType: null, message: 'No recovery' })) };
      deps = createMockDeps({
        getActiveTopicSessions: vi.fn(() => new Map([[905, 'session-ctx2']])),
        isSessionAlive: vi.fn(() => true),
        captureSessionOutput: vi.fn(() => 'conversation too long'),
        getTopicHistory: vi.fn(() => []),
        sessionRecovery: mockRecovery as any,
      });
      monitor = new SessionMonitor(deps);
      const events: string[] = [];
      monitor.on('monitor:user-notified', () => events.push('notified'));

      await monitor.poll();

      expect(events).toContain('notified');
      expect(deps.sendToTopic).toHaveBeenCalledWith(905, expect.stringContaining('conversation too long'));
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
        getActiveTopicSessions: vi.fn()
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

      // First poll: detects context exhaustion, sends notification
      await (monitor as any).poll();
      expect(mockRecovery.checkAndRecover).toHaveBeenCalledTimes(1);
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1);

      // Second poll: session is gone, snapshot gets cleaned up
      await (monitor as any).poll();

      // Third poll: new session active with same error — should NOT re-notify (topic cooldown)
      await (monitor as any).poll();
      expect(deps.sendToTopic).toHaveBeenCalledTimes(1); // Still just 1, not 2
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
      expect(deps.sendToTopic).toHaveBeenCalledWith(907, expect.stringContaining('session has stopped'));

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
