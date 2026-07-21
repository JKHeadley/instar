import { describe, expect, it } from 'vitest';
import type { BackupSnapshot } from '../../src/core/types.js';
import { FeedbackDrainBackupCadence } from '../../src/feedback-factory/drain/FeedbackDrainBackupCadence.js';

const snapshot = (createdAt: string, trigger: BackupSnapshot['trigger'] = 'manual'): BackupSnapshot => ({
  id: createdAt, createdAt, trigger, files: [], totalBytes: 0,
});

describe('FeedbackDrainBackupCadence', () => {
  it('enforces the one-hour RPO without snapshot churn', () => {
    const made: BackupSnapshot[] = [];
    const now = Date.parse('2026-07-20T12:00:00Z');
    const existing = [snapshot('2026-07-20T11:30:01Z')];
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => [...existing, ...made],
      createSnapshot: (trigger) => { const row = snapshot(new Date(now).toISOString(), trigger); made.push(row); return row; },
    }, () => now);
    expect(cadence.maybeHourly()).toBeNull();
    existing[0] = snapshot('2026-07-20T10:59:59Z');
    expect(cadence.maybeHourly()?.trigger).toBe('feedback-hourly');
    expect(cadence.maybeHourly()).toBeNull();
  });

  it('checkpoints every promotion and failover even inside the hourly window', () => {
    const triggers: BackupSnapshot['trigger'][] = [];
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => [snapshot(new Date().toISOString())],
      createSnapshot: (trigger) => { triggers.push(trigger); return snapshot(new Date().toISOString(), trigger); },
    });
    cadence.afterPromotion(); cadence.afterFailover();
    expect(triggers).toEqual(['feedback-promotion', 'feedback-failover']);
  });
});
