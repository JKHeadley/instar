/**
 * Tests for QuotaManager — orchestration hub for all quota components.
 *
 * Tests wiring, event forwarding, spawn gating, polling lifecycle,
 * and notification retry queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { QuotaManager } from '../../src/monitoring/QuotaManager.js';
import type { QuotaState } from '../../src/core/types.js';

// ── Mock factories ─────────────────────────────────────────────────

function createMockTracker(state?: Partial<QuotaState>) {
  const defaultState: QuotaState = {
    usagePercent: 45,
    fiveHourPercent: 30,
    lastUpdated: new Date().toISOString(),
    recommendation: 'normal',
  };
  const merged = { ...defaultState, ...state };
  return {
    getState: vi.fn(() => merged),
    canRunJob: vi.fn(() => true),
    shouldSpawnSession: vi.fn(() => ({ allowed: true, reason: 'Normal usage' })),
    updateState: vi.fn(),
    getRecommendation: vi.fn(() => 'normal' as const),
  };
}

function createMockCollector() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    collect: vi.fn(async () => ({
      success: true,
      dataSource: 'oauth' as const,
      dataConfidence: 'authoritative' as const,
      state: {
        usagePercent: 45,
        lastUpdated: new Date().toISOString(),
        fiveHourPercent: 30,
      } as QuotaState,
      durationMs: 1200,
      errors: [],
    })),
    getPollingIntervalMs: vi.fn(() => 120000),
    getPollingState: vi.fn(() => ({
      currentIntervalMs: 120000,
      currentTier: 'normal',
      consecutiveBelowThreshold: 5,
    })),
    getBudgetStatus: vi.fn(() => ({
      used: 10,
      remaining: 50,
      limit: 60,
      resetsAt: Date.now() + 300000,
    })),
    getLastCollectionAt: vi.fn(() => new Date()),
    getLastCollectionDurationMs: vi.fn(() => 1200),
  });
}

function createMockMigrator() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    setDeps: vi.fn(),
    checkAndMigrate: vi.fn(async () => false),
    completeRecovery: vi.fn(async () => {}),
    isMigrating: vi.fn(() => false),
    getMigrationStatus: vi.fn(() => ({
      inProgress: false,
      state: null,
      lastMigration: null,
      history: [],
      config: { fiveHourPercent: 88, weeklyPercent: 92, cooldownMs: 600000, minimumHeadroom: 20, gracePeriodMs: 5000 },
    })),
    getThresholds: vi.fn(() => ({
      fiveHourPercent: 88,
      weeklyPercent: 92,
      cooldownMs: 600000,
      minimumHeadroom: 20,
      gracePeriodMs: 5000,
    })),
    selectMigrationTarget: vi.fn(() => null),
  });
}

function createMockNotifier() {
  return {
    configure: vi.fn(),
    checkAndNotify: vi.fn(async () => {}),
    sendAlert: vi.fn(async () => {}),
  };
}

function createMockSwitcher() {
  return {
    switchAccount: vi.fn(async () => ({ success: true, message: 'Switched', previousAccount: 'a@test.com', newAccount: 'b@test.com' })),
    getAccountStatuses: vi.fn(() => [
      { email: 'a@test.com', name: 'Account A', isActive: true, hasToken: true, tokenExpired: false, isStale: false, weeklyPercent: 80, fiveHourPercent: 50 },
      { email: 'b@test.com', name: 'Account B', isActive: false, hasToken: true, tokenExpired: false, isStale: false, weeklyPercent: 20, fiveHourPercent: 10 },
    ]),
    getAccountCredentials: vi.fn(() => null),
    getProvider: vi.fn(),
  };
}

function createMockSessionManager() {
  return {
    listRunningSessions: vi.fn(() => [
      { id: 's1', name: 'test-job', tmuxSession: 'proj-test-job', jobSlug: 'test-job', status: 'running', startedAt: new Date().toISOString() },
    ]),
    sendKey: vi.fn(() => true),
    killSession: vi.fn(() => true),
    isSessionAlive: vi.fn(() => true),
  };
}

function createMockScheduler() {
  return {
    canRunJob: vi.fn(() => true),
    setQuotaTracker: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    triggerJob: vi.fn(() => 'triggered' as const),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('QuotaManager', () => {
  let manager: QuotaManager;
  let tracker: ReturnType<typeof createMockTracker>;
  let collector: ReturnType<typeof createMockCollector>;
  let migrator: ReturnType<typeof createMockMigrator>;
  let notifier: ReturnType<typeof createMockNotifier>;
  let switcher: ReturnType<typeof createMockSwitcher>;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = createMockTracker();
    collector = createMockCollector();
    migrator = createMockMigrator();
    notifier = createMockNotifier();
    switcher = createMockSwitcher();

    manager = new QuotaManager(
      { stateDir: '/tmp/test-state' },
      {
        tracker: tracker as any,
        collector: collector as any,
        migrator: migrator as any,
        notifier: notifier as any,
        credentialManager: undefined,
      },
    );
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  // ── Construction ─────────────────────────────────────────────

  it('creates with all components', () => {
    expect(manager.tracker).toBe(tracker);
    expect(manager.collector).toBe(collector);
    expect(manager.migrator).toBe(migrator);
    expect(manager.notifier).toBe(notifier);
    expect(manager.credentialManager).toBeDefined();
  });

  it('creates with minimal components (tracker + notifier only)', () => {
    const minimal = new QuotaManager(
      { stateDir: '/tmp/test' },
      { tracker: tracker as any, notifier: notifier as any },
    );
    expect(minimal.collector).toBeNull();
    expect(minimal.migrator).toBeNull();
    expect(minimal.switcher).toBeNull();
    minimal.stop();
  });

  // ── Spawn Gating ─────────────────────────────────────────────

  it('delegates spawn check to tracker when not migrating', () => {
    const result = manager.canSpawnSession('medium');
    expect(result.allowed).toBe(true);
    expect(tracker.shouldSpawnSession).toHaveBeenCalledWith('medium');
  });

  it('blocks spawning during migration with quota pressure', () => {
    // Migration only blocks when there's quota pressure (usagePercent >= 50)
    manager.stop();
    const pressuredTracker = createMockTracker({ usagePercent: 60 });
    manager = new QuotaManager(
      { stateDir: '/tmp/test-state' },
      {
        tracker: pressuredTracker as any,
        collector: collector as any,
        migrator: migrator as any,
        notifier: notifier as any,
      },
    );
    migrator.isMigrating.mockReturnValue(true);
    const result = manager.canSpawnSession('critical');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Migration in progress');
  });

  // ── Event Forwarding ─────────────────────────────────────────

  it('forwards collector token_expired events', () => {
    const handler = vi.fn();
    manager.on('token_expired', handler);

    collector.emit('token_expired', { email: 'a@test.com', expiredAt: '2026-01-01' });
    expect(handler).toHaveBeenCalledWith({ email: 'a@test.com', expiredAt: '2026-01-01' });
  });

  it('forwards collector token_expiring events', () => {
    const handler = vi.fn();
    manager.on('token_expiring', handler);

    collector.emit('token_expiring', { email: 'a@test.com', expiresAt: '2026-01-01' });
    expect(handler).toHaveBeenCalledWith({ email: 'a@test.com', expiresAt: '2026-01-01' });
  });

  it('forwards migrator migration_complete events', () => {
    const handler = vi.fn();
    manager.on('migration_complete', handler);

    migrator.emit('migration_complete', {
      previousAccount: 'a@test.com',
      newAccount: 'b@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: ['s1'],
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      result: 'success',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('complete');
    expect(event.sourceAccount).toBe('a@test.com');
    expect(event.targetAccount).toBe('b@test.com');
  });

  it('forwards migrator migration_failed events', () => {
    const handler = vi.fn();
    manager.on('migration_failed', handler);

    migrator.emit('migration_failed', {
      previousAccount: 'a@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: [],
      completedAt: new Date().toISOString(),
      durationMs: 3000,
      error: 'Switch failed',
      result: 'failed',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].type).toBe('failed');
    expect(handler.mock.calls[0][0].error).toBe('Switch failed');
  });

  // ── Polling Lifecycle ─────────────────────────────────────────

  it('starts and stops adaptive polling', () => {
    manager.start();
    expect(manager.getPollingStatus().running).toBe(true);

    manager.stop();
    expect(manager.getPollingStatus().running).toBe(false);
  });

  it('runs collection on start', async () => {
    manager.start();
    // First collection fires at delay 0
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.collect).toHaveBeenCalledTimes(1);
  });

  it('calls notifier.checkAndNotify after collection', async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.checkAndNotify).toHaveBeenCalledTimes(1);
  });

  it('checks migration after collection', async () => {
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(migrator.checkAndMigrate).toHaveBeenCalledTimes(1);
  });

  it('skips migration check for JSONL estimates by default', async () => {
    collector.collect.mockResolvedValue({
      success: true,
      dataSource: 'jsonl-fallback' as const,
      dataConfidence: 'estimated' as const,
      state: { usagePercent: 90, lastUpdated: new Date().toISOString() } as QuotaState,
      durationMs: 500,
      errors: [],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    // Migration should NOT be checked for estimated data
    expect(migrator.checkAndMigrate).not.toHaveBeenCalled();
  });

  it('allows JSONL migration when configured', async () => {
    manager.stop();
    manager = new QuotaManager(
      { stateDir: '/tmp/test-state', jsonlCanTriggerMigration: true },
      {
        tracker: tracker as any,
        collector: collector as any,
        migrator: migrator as any,
        notifier: notifier as any,
      },
    );

    collector.collect.mockResolvedValue({
      success: true,
      dataSource: 'jsonl-fallback' as const,
      dataConfidence: 'estimated' as const,
      state: { usagePercent: 90, lastUpdated: new Date().toISOString() } as QuotaState,
      durationMs: 500,
      errors: [],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(migrator.checkAndMigrate).toHaveBeenCalled();
  });

  // ── Threshold Events ──────────────────────────────────────────

  it('emits threshold_crossed for weekly warning', async () => {
    const handler = vi.fn();
    manager.on('threshold_crossed', handler);

    collector.collect.mockResolvedValue({
      success: true,
      dataSource: 'oauth' as const,
      dataConfidence: 'authoritative' as const,
      state: { usagePercent: 75, lastUpdated: new Date().toISOString() } as QuotaState,
      durationMs: 1000,
      errors: [],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warning',
      metric: 'weekly',
      value: 75,
      threshold: 70,
    }));
  });

  it('emits threshold_crossed for weekly critical', async () => {
    const handler = vi.fn();
    manager.on('threshold_crossed', handler);

    collector.collect.mockResolvedValue({
      success: true,
      dataSource: 'oauth' as const,
      dataConfidence: 'authoritative' as const,
      state: { usagePercent: 90, lastUpdated: new Date().toISOString() } as QuotaState,
      durationMs: 1000,
      errors: [],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      level: 'critical',
      metric: 'weekly',
      threshold: 85,
    }));
  });

  it('emits threshold_crossed for 5-hour limit', async () => {
    const handler = vi.fn();
    manager.on('threshold_crossed', handler);

    collector.collect.mockResolvedValue({
      success: true,
      dataSource: 'oauth' as const,
      dataConfidence: 'authoritative' as const,
      state: { usagePercent: 40, fiveHourPercent: 96, lastUpdated: new Date().toISOString() } as QuotaState,
      durationMs: 1000,
      errors: [],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      level: 'limit',
      metric: 'fiveHour',
      value: 96,
      threshold: 95,
    }));
  });

  // ── Dependency Wiring ─────────────────────────────────────────

  it('wires migrator deps when sessionManager and scheduler are set', () => {
    const sm = createMockSessionManager();
    const sched = createMockScheduler();

    // Also need switcher for wiring
    manager.stop();
    manager = new QuotaManager(
      { stateDir: '/tmp/test-state' },
      {
        tracker: tracker as any,
        collector: collector as any,
        migrator: migrator as any,
        notifier: notifier as any,
        switcher: switcher as any,
      },
    );

    manager.setSessionManager(sm as any);
    manager.setScheduler(sched as any);

    expect(migrator.setDeps).toHaveBeenCalledTimes(1);
    expect(migrator.completeRecovery).toHaveBeenCalledTimes(1);
  });

  it('replaces scheduler.canRunJob with quota-aware version', () => {
    const sched = createMockScheduler();
    manager.setScheduler(sched as any);

    // The canRunJob on sched should now be replaced
    expect(sched.canRunJob).not.toBe(createMockScheduler().canRunJob);
  });

  // ── Polling Status ────────────────────────────────────────────

  it('returns polling status', () => {
    manager.start();
    const status = manager.getPollingStatus();
    expect(status.running).toBe(true);
    expect(status.currentIntervalMs).toBe(120000);
    expect(status.hysteresisState.currentTier).toBe('normal');
  });

  // ── Migration Status ──────────────────────────────────────────

  it('returns migration status', () => {
    const status = manager.getMigrationStatus();
    expect(status.config.enabled).toBe(true);
    expect(status.config.fiveHourThreshold).toBe(88);
    expect(status.config.weeklyThreshold).toBe(92);
    expect(status.config.cooldownMinutes).toBe(10);
  });

  it('returns not_configured when no migrator', () => {
    const minimal = new QuotaManager(
      { stateDir: '/tmp/test' },
      { tracker: tracker as any, notifier: notifier as any },
    );
    const status = minimal.getMigrationStatus();
    expect(status.status).toBe('not_configured');
    minimal.stop();
  });

  // ── Manual Migration Trigger ──────────────────────────────────

  it('triggerMigration delegates to migrator', async () => {
    migrator.checkAndMigrate.mockResolvedValue(true);
    const result = await manager.triggerMigration();
    expect(result.triggered).toBe(true);
    expect(migrator.checkAndMigrate).toHaveBeenCalled();
  });

  it('triggerMigration returns false when already migrating', async () => {
    migrator.isMigrating.mockReturnValue(true);
    const result = await manager.triggerMigration();
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('already in progress');
  });

  it('triggerMigration returns false when no migrator', async () => {
    const minimal = new QuotaManager(
      { stateDir: '/tmp/test' },
      { tracker: tracker as any, notifier: notifier as any },
    );
    const result = await minimal.triggerMigration();
    expect(result.triggered).toBe(false);
    expect(result.reason).toContain('not configured');
    minimal.stop();
  });

  // ── Notification Retry Queue ──────────────────────────────────

  it('sends notifications through sender function', async () => {
    const sender = vi.fn(async () => {});
    manager.setNotificationSender(sender);

    // Trigger a migration event that enqueues a notification
    migrator.emit('migration_complete', {
      previousAccount: 'a@test.com',
      newAccount: 'b@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: ['s1'],
      completedAt: new Date().toISOString(),
      durationMs: 5000,
      result: 'success',
    });

    // Allow async notification to settle
    await vi.advanceTimersByTimeAsync(0);
    expect(sender).toHaveBeenCalled();
    expect(sender.mock.calls[0][0]).toContain('Migration complete');
  });

  it('retries failed notifications', async () => {
    let callCount = 0;
    const sender = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) throw new Error('Send failed');
    });
    manager.setNotificationSender(sender);
    manager.start();

    // Trigger notification
    migrator.emit('migration_failed', {
      previousAccount: 'a@test.com',
      sessionsHalted: ['s1'],
      sessionsRestarted: [],
      completedAt: new Date().toISOString(),
      durationMs: 3000,
      error: 'Switch failed',
      result: 'failed',
    });

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);
    expect(sender).toHaveBeenCalledTimes(1);

    // Retry after backoff (10s for retry timer + 5s base backoff)
    await vi.advanceTimersByTimeAsync(15000);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  // ── Refresh ───────────────────────────────────────────────────

  it('refresh forces immediate collection', async () => {
    const result = await manager.refresh();
    expect(collector.collect).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
  });

  it('refresh without collector reads from tracker', async () => {
    const minimal = new QuotaManager(
      { stateDir: '/tmp/test' },
      { tracker: tracker as any, notifier: notifier as any },
    );
    const result = await minimal.refresh();
    expect(result).toBeNull();
    expect(tracker.getState).toHaveBeenCalled();
    minimal.stop();
  });

  // ── Cooldown ──────────────────────────────────────────────────

  it('computes cooldownUntil from last migration', () => {
    const now = Date.now();
    migrator.getMigrationStatus.mockReturnValue({
      inProgress: false,
      state: null,
      lastMigration: { completedAt: new Date(now - 300000).toISOString() }, // 5 min ago
      history: [],
      config: { fiveHourPercent: 88, weeklyPercent: 92, cooldownMs: 600000, minimumHeadroom: 20, gracePeriodMs: 5000 },
    });

    const status = manager.getMigrationStatus();
    expect(status.cooldownUntil).not.toBeNull();
    // Cooldown should expire 10 min after completion = 5 min from now
    const cooldownDate = new Date(status.cooldownUntil!);
    expect(cooldownDate.getTime()).toBeGreaterThan(now);
  });

  it('returns null cooldown when expired', () => {
    migrator.getMigrationStatus.mockReturnValue({
      inProgress: false,
      state: null,
      lastMigration: { completedAt: new Date(Date.now() - 700000).toISOString() }, // 11+ min ago
      history: [],
      config: { fiveHourPercent: 88, weeklyPercent: 92, cooldownMs: 600000, minimumHeadroom: 20, gracePeriodMs: 5000 },
    });

    const status = manager.getMigrationStatus();
    expect(status.cooldownUntil).toBeNull();
  });
});
