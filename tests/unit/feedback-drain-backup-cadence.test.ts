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

describe('FeedbackDrainBackupCadence.maybeHourlyOffThread', () => {
  const at = (iso: string): number => Date.parse(iso);
  function deferred(): { promise: Promise<BackupSnapshot>; resolve: (row: BackupSnapshot) => void; reject: (error: Error) => void } {
    let resolve!: (row: BackupSnapshot) => void; let reject!: (error: Error) => void;
    const promise = new Promise<BackupSnapshot>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('starts one snapshot when due, checkpointing first, and starts no second one while it runs', async () => {
    let now = at('2026-07-20T12:00:00Z');
    const order: string[] = [];
    const job = deferred();
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => [snapshot('2026-07-20T10:00:00Z')],
      createSnapshot: () => { throw new Error('the synchronous path must not run'); },
    }, () => now);
    const create = (trigger: BackupSnapshot['trigger']) => { order.push(`create:${trigger}`); return job.promise; };
    const first = cadence.maybeHourlyOffThread(create, () => order.push('checkpoint'));
    expect(first.started).toBe(true);
    expect(order).toEqual(['checkpoint', 'create:feedback-hourly']);

    now += 15 * 60 * 1000;
    const second = cadence.maybeHourlyOffThread(create, () => order.push('checkpoint'));
    expect(second).toEqual({ started: false, reason: 'in-flight', runningMs: 15 * 60 * 1000 });
    expect(order).toHaveLength(2);

    job.resolve(snapshot(new Date(now).toISOString(), 'feedback-hourly'));
    if (first.started) expect((await first.done).trigger).toBe('feedback-hourly');
  });

  it('after a snapshot it made, a tick inside the hour reads nothing from disk; after the hour it starts again', async () => {
    let now = at('2026-07-20T12:00:00Z');
    let listed = 0;
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => { listed++; return []; },
      createSnapshot: () => { throw new Error('unused'); },
    }, () => now);
    const create = async (trigger: BackupSnapshot['trigger']) => snapshot(new Date(now).toISOString(), trigger);
    const first = cadence.maybeHourlyOffThread(create);
    if (!first.started) throw new Error('expected a start');
    await first.done;
    const listedAfterFirst = listed;
    now += 30 * 60 * 1000;
    expect(cadence.maybeHourlyOffThread(create)).toEqual({ started: false, reason: 'fresh' });
    expect(listed).toBe(listedAfterFirst);
    now += 31 * 60 * 1000;
    expect(cadence.maybeHourlyOffThread(create).started).toBe(true);
  });

  it('a snapshot newer than the hour on disk means nothing starts and no checkpoint runs', () => {
    const now = at('2026-07-20T12:00:00Z');
    let checkpoints = 0;
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => [snapshot('2026-07-20T11:30:00Z')],
      createSnapshot: () => { throw new Error('unused'); },
    }, () => now);
    expect(cadence.maybeHourlyOffThread(async () => snapshot('x'), () => { checkpoints++; })).toEqual({ started: false, reason: 'fresh' });
    expect(checkpoints).toBe(0);
  });

  it('a failed snapshot frees the slot, whether it rejects or throws before starting', async () => {
    const now = at('2026-07-20T12:00:00Z');
    const cadence = new FeedbackDrainBackupCadence({
      listSnapshots: () => [],
      createSnapshot: () => { throw new Error('unused'); },
    }, () => now);
    const rejected = cadence.maybeHourlyOffThread(() => Promise.reject(new Error('disk full')));
    if (!rejected.started) throw new Error('expected a start');
    await expect(rejected.done).rejects.toThrow('disk full');
    expect(() => cadence.maybeHourlyOffThread(() => { throw new Error('staging failed'); })).toThrow('staging failed');
    expect(cadence.maybeHourlyOffThread(async () => snapshot(new Date(now).toISOString())).started).toBe(true);
  });

  it('a failed checkpoint starts nothing and holds no slot', () => {
    const cadence = new FeedbackDrainBackupCadence({ listSnapshots: () => [], createSnapshot: () => { throw new Error('unused'); } });
    let created = 0;
    const create = async () => { created++; return snapshot(new Date().toISOString()); };
    expect(() => cadence.maybeHourlyOffThread(create, () => { throw new Error('WAL busy'); })).toThrow('WAL busy');
    expect(created).toBe(0);
    expect(cadence.maybeHourlyOffThread(create).started).toBe(true);
  });
});

describe('the server runs the hourly checkpoint off its main thread', () => {
  it('the hourly tick uses the worker path; promotion and failover stay synchronous', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../../src/server/AgentServer.ts', import.meta.url), 'utf8');
    expect(source).toContain('backupCadence.maybeHourlyOffThread(');
    expect(source).toContain('createBackupSnapshotInWorker({ stateDir: options.config.stateDir, config: options.config.backup, trigger })');
    expect(source).not.toMatch(/backupCadence\.maybeHourly\(/);
    expect(source).toContain('backupCadence.afterPromotion()');
    expect(source).toContain('backupCadence.afterFailover()');
  });
});
