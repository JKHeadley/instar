/**
 * Bounded Attention-Notification Surface — Migration Parity + production-wiring tests.
 *
 * Migration Parity Standard: existing agents update in place, so a config
 * default that only reaches NEW agents is a broken feature. These tests assert
 * the migration reaches an existing config, is idempotent, and never overwrites
 * an operator's value.
 *
 * Every assertion is paired with a CONTROL.
 */

import { describe, it, expect } from 'vitest';
import { migrateConfigBoundedNotificationSurface } from '../../src/core/PostUpdateMigrator.js';
import { NotificationBatcher } from '../../src/messaging/NotificationBatcher.js';

describe('Migration Parity — existing agents receive the levers', () => {
  it('adds the levers to a config that has never seen them', () => {
    const config: Record<string, unknown> = { projectName: 'x' };
    const changed = migrateConfigBoundedNotificationSurface(config);

    expect(changed).toBe(true);
    const nb = config.notificationBatcher as Record<string, unknown>;
    expect(nb.maxMessagesPerTopicPerHour).toBe(4);
    expect(nb.maxHeldItemsPerTopic).toBe(200);
    const mon = config.monitoring as Record<string, unknown>;
    const deg = mon.degradationReporter as Record<string, unknown>;
    // Operator-approved default: housekeeping is SILENT (topic 7848, 2026-08-04).
    expect(deg.notifyUser).toBe(false);
  });

  it('CONTROL: is idempotent — a second run changes nothing', () => {
    const config: Record<string, unknown> = { projectName: 'x' };
    expect(migrateConfigBoundedNotificationSurface(config)).toBe(true);
    // If this returned true again the migration would be rewriting on every
    // update, which is how an operator's edit gets silently reverted.
    expect(migrateConfigBoundedNotificationSurface(config)).toBe(false);
  });

  it('never overwrites an operator value', () => {
    const config: Record<string, unknown> = {
      notificationBatcher: { maxMessagesPerTopicPerHour: 99 },
      monitoring: { degradationReporter: { notifyUser: true } },
    };
    migrateConfigBoundedNotificationSurface(config);

    const nb = config.notificationBatcher as Record<string, unknown>;
    expect(nb.maxMessagesPerTopicPerHour).toBe(99);
    // The operator asked to keep receiving degradation reports — respected.
    expect((config.monitoring as Record<string, Record<string, unknown>>).degradationReporter.notifyUser).toBe(true);
    // CONTROL: the fields they did NOT set are still filled in, so this is a
    // merge rather than a no-op.
    expect(nb.maxHeldItemsPerTopic).toBe(200);
  });

  it('places notificationBatcher at the TOP LEVEL, never under `messaging`', () => {
    // `messaging` is an ARRAY of adapters: a key nested there is unreachable at
    // runtime (the documented outboundAdvisory trap). Getting this wrong ships a
    // lever that silently does nothing — the exact defect this change fixes.
    const config: Record<string, unknown> = { messaging: [{ platform: 'telegram' }] };
    migrateConfigBoundedNotificationSurface(config);

    expect(config.notificationBatcher).toBeDefined();
    expect(Array.isArray(config.messaging)).toBe(true);
    const messaging = config.messaging as Array<Record<string, unknown>>;
    for (const adapter of messaging) {
      expect(adapter.notificationBatcher).toBeUndefined();
    }
  });
});

describe('Production wiring — config actually reaches the batcher', () => {
  /**
   * Mirrors the construction in src/commands/server.ts. The Testing Integrity
   * Standard's "is the feature alive" check: a limiter that is built but never
   * fed its config is indistinguishable from one that works, until it matters.
   */
  function buildFromConfig(config: Record<string, unknown>) {
    const nbCfg = (config.notificationBatcher ?? {}) as Record<string, unknown>;
    return new NotificationBatcher({
      enabled: (nbCfg.enabled as boolean | undefined) ?? true,
      summaryIntervalMinutes: (nbCfg.summaryIntervalMinutes as number | undefined) ?? 30,
      digestIntervalMinutes: (nbCfg.digestIntervalMinutes as number | undefined) ?? 120,
      maxMessagesPerTopicPerHour: (nbCfg.maxMessagesPerTopicPerHour as number | undefined) ?? 4,
      suppressionTtlHours: (nbCfg.suppressionTtlHours as number | undefined) ?? 24,
      maxHoldHours: (nbCfg.maxHoldHours as number | undefined) ?? 6,
      maxHeldItemsPerTopic: (nbCfg.maxHeldItemsPerTopic as number | undefined) ?? 200,
    });
  }

  it('an operator limit of 1 is honoured end-to-end from a config object', async () => {
    const config: Record<string, unknown> = { notificationBatcher: { maxMessagesPerTopicPerHour: 1 } };
    const batcher = buildFromConfig(config);
    const sent: number[] = [];
    batcher.setSendFunction(async (topicId) => { sent.push(topicId); return { messageId: sent.length }; });

    for (const m of ['alpha', 'bravo', 'charlie']) {
      await batcher.enqueue({ tier: 'SUMMARY', category: 'system', message: m, timestamp: new Date(), topicId: 5 });
      await batcher.flush('SUMMARY');
    }
    expect(sent).toHaveLength(1);
  });

  it('CONTROL: an EMPTY config reproduces the shipped default of 4, not the operator value', async () => {
    const batcher = buildFromConfig({});
    const sent: number[] = [];
    batcher.setSendFunction(async (topicId) => { sent.push(topicId); return { messageId: sent.length }; });

    for (const m of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) {
      await batcher.enqueue({ tier: 'SUMMARY', category: 'system', message: m, timestamp: new Date(), topicId: 5 });
      await batcher.flush('SUMMARY');
    }
    // 4, not 1 and not 6 — proves the config path is READ rather than ignored
    // in one direction or hardcoded in the other.
    expect(sent).toHaveLength(4);
  });

  it('absent config preserves the pre-change interval defaults', () => {
    const batcher = buildFromConfig({});
    // 30-minute SUMMARY cadence is the pre-change behaviour; an install with no
    // notificationBatcher block must be byte-for-byte unchanged.
    const now = Date.parse('2026-08-04T12:00:00Z');
    expect(batcher.nextSummaryReleaseAt(now)).toBe(now + 30 * 60_000);
  });

  it('CONTROL: an explicit interval overrides it', () => {
    const batcher = buildFromConfig({ notificationBatcher: { summaryIntervalMinutes: 5 } });
    const now = Date.parse('2026-08-04T12:00:00Z');
    expect(batcher.nextSummaryReleaseAt(now)).toBe(now + 5 * 60_000);
  });
});
