// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * CMT-1610 — store half: an interrupted script run is closed as a failed,
 * `interrupted` attempt (never a silent success), and a slug hold is released
 * only with an audit row that keeps who, why and the original hold.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';

describe('JobSupervisionStore interrupted runs and hold releases', () => {
  let dir: string;
  let store: JobSupervisionStore;
  const t0 = Date.parse('2026-11-11T06:01:56Z');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-supervision-int-'));
    store = new JobSupervisionStore(dir);
  });
  afterEach(() => {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-supervision-store-interrupted-and-release.test.ts' });
  });

  const register = (runId: string) => store.register({
    runId, fireId: `fire-${runId}`, slug: 'health-check', machineId: 'm1',
    evidencePolicy: 'structured-v1', now: t0,
  });

  it('closes a pending attempt as an interrupted failure with a transition', () => {
    const id = register('run-1');
    expect(store.settleInterruptedRun({ runId: 'run-1', slug: 'health-check', startedAt: new Date(t0).toISOString(), now: t0 + 60_000 })).toBe(true);
    const row = store.get(id)!;
    expect(row).toMatchObject({ status: 'unchecked', reason: 'interrupted', result: 'failure' });
    expect(row.completedAt).toBe(new Date(t0 + 60_000).toISOString());
    const db = new Database(path.join(dir, 'ledger', 'job-supervision.db'), { readonly: true });
    try {
      const events = db.prepare('SELECT event FROM transitions WHERE attempt_id=? ORDER BY id').all(id) as Array<{ event: string }>;
      expect(events.map(e => e.event)).toEqual(['attempt-registered', 'interrupted-settled']);
    } finally { db.close(); }
  });

  it('closes an outcome-unknown and an expired-unchecked attempt without changing an expired status', () => {
    const a = register('run-a');
    store.markUnchecked(a, 'outcome-unknown', t0);
    expect(store.settleInterruptedRun({ runId: 'run-a', slug: 'health-check', startedAt: new Date(t0).toISOString() })).toBe(true);
    expect(store.get(a)).toMatchObject({ status: 'unchecked', reason: 'interrupted', result: 'failure' });

    const b = register('run-b');
    const db = new Database(path.join(dir, 'ledger', 'job-supervision.db'));
    try { db.prepare(`UPDATE attempts SET status='expired-unchecked', reason='outcome-unknown' WHERE attempt_id=?`).run(b); }
    finally { db.close(); }
    expect(store.settleInterruptedRun({ runId: 'run-b', slug: 'health-check', startedAt: new Date(t0).toISOString() })).toBe(true);
    expect(store.get(b)).toMatchObject({ status: 'expired-unchecked', reason: 'interrupted', result: 'failure' });
    expect(store.get(b)!.completedAt).not.toBeNull();
  });

  it('inserts a recovered interrupted row when the process died before registration', () => {
    expect(store.findByRunId('run-x')).toBeNull();
    expect(store.settleInterruptedRun({ runId: 'run-x', slug: 'health-check', machineId: 'm1', startedAt: new Date(t0).toISOString() })).toBe(true);
    expect(store.findByRunId('run-x')).toMatchObject({ slug: 'health-check', status: 'unchecked', reason: 'interrupted', result: 'failure', evidencePolicy: 'recovered-unknown' });
  });

  it('reports a prior interrupted settlement as closed so its history write can be retried', () => {
    const id = register('run-half');
    expect(store.settleInterruptedRun({ runId: 'run-half', slug: 'health-check', startedAt: new Date(t0).toISOString(), now: t0 + 1000 })).toBe(true);
    expect(store.settleInterruptedRun({ runId: 'run-half', slug: 'health-check', startedAt: new Date(t0).toISOString(), now: t0 + 9000 })).toBe(true);
    expect(store.get(id)!.completedAt).toBe(new Date(t0 + 1000).toISOString());
  });

  it('never rewrites an attempt that already has a completion, or one for another slug', () => {
    const id = register('run-done');
    store.recordResult(id, { result: 'success', completedAt: new Date(t0 + 1000).toISOString() });
    expect(store.settleInterruptedRun({ runId: 'run-done', slug: 'health-check', startedAt: new Date(t0).toISOString() })).toBe(false);
    expect(store.get(id)).toMatchObject({ result: 'success', status: 'pending' });

    const other = register('run-other');
    expect(store.settleInterruptedRun({ runId: 'run-other', slug: 'different-job', startedAt: new Date(t0).toISOString() })).toBe(false);
    expect(store.get(other)).toMatchObject({ result: null, status: 'pending' });
  });

  it('releases a hold with an audit row and never silently', () => {
    store.holdSlug('health-check', 'independent-history-mismatch', t0);
    expect(() => store.releaseHold('health-check', { by: 'agent', reason: '   ' })).toThrow(/why/);
    expect(store.isSlugHeld('health-check')).toBe(true);

    const released = store.releaseHold('health-check', { by: 'agent', reason: 'interrupted run settled', now: t0 + 5000 });
    expect(released).toEqual({ slug: 'health-check', reason: 'independent-history-mismatch', heldAt: new Date(t0).toISOString() });
    expect(store.isSlugHeld('health-check')).toBe(false);
    expect(store.holdReleases('health-check')).toEqual([{
      slug: 'health-check', holdReason: 'independent-history-mismatch', heldAt: new Date(t0).toISOString(),
      releasedAt: new Date(t0 + 5000).toISOString(), releasedBy: 'agent', releaseReason: 'interrupted run settled',
    }]);
    expect(store.releaseHold('health-check', { by: 'agent', reason: 'again' })).toBeNull();
    expect(store.holdReleases()).toHaveLength(1);
  });

  it('adds the release table to an existing ledger on open', () => {
    store.holdSlug('health-check', 'write-failed:disk', t0);
    store.close();
    const db = new Database(path.join(dir, 'ledger', 'job-supervision.db'));
    try { db.exec('DROP TABLE held_slug_releases'); } finally { db.close(); }
    store = new JobSupervisionStore(dir);
    expect(store.heldSlugs()).toEqual([expect.objectContaining({ slug: 'health-check', reason: 'write-failed:disk' })]);
    expect(store.releaseHold('health-check', { by: 'operator', reason: 'disk repaired' })).not.toBeNull();
    expect(store.holdReleases('health-check')[0]).toMatchObject({ releasedBy: 'operator', holdReason: 'write-failed:disk' });
  });
});
