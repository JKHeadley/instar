/**
 * PendingInjectStore + boot sweep (finding 8d300555): a server restart in the
 * spawn→ready→inject window used to silently drop the queued user message.
 * The store makes the in-flight inject durable; the sweep re-delivers into
 * still-alive sessions and makes every other outcome LOUD.
 *
 * The live incident is the fixture shape: record written at spawn 00:35:02,
 * server died 00:36:01 before inject, tmux survived idle — on the next boot
 * the sweep must find the record, see the session alive, and re-deliver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PendingInjectStore,
  sweepPendingInjects,
  type PendingInjectRecord,
} from '../../src/core/PendingInjectStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PendingInjectStore', () => {
  let tmp: string;
  let store: PendingInjectStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-inject-'));
    store = new PendingInjectStore(tmp);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/pending-inject-store.test.ts:afterEach' });
  });

  it('round-trips a record through record/list/clear', () => {
    store.record({ tmuxSession: 'codey-git-management', initialMessage: '[IMPORTANT: Read /tmp/bootstrap-2271.txt ...]', telegramTopicId: 2271 });
    const { records } = store.list();
    expect(records).toHaveLength(1);
    expect(records[0].tmuxSession).toBe('codey-git-management');
    expect(records[0].telegramTopicId).toBe(2271);
    expect(Number.isFinite(Date.parse(records[0].createdAt))).toBe(true);

    store.clear('codey-git-management');
    expect(store.list().records).toHaveLength(0);
  });

  it('overwrites the record for the same session (fallback respawn re-records)', () => {
    store.record({ tmuxSession: 's1', initialMessage: 'first' });
    store.record({ tmuxSession: 's1', initialMessage: 'second (fresh-spawn fallback)' });
    const { records } = store.list();
    expect(records).toHaveLength(1);
    expect(records[0].initialMessage).toContain('second');
  });

  it('clear on a missing record is a no-op (double-clear after sweep+inject)', () => {
    expect(() => store.clear('never-recorded')).not.toThrow();
  });

  it('skips corrupt files without bricking the list', () => {
    store.record({ tmuxSession: 'good', initialMessage: 'msg' });
    fs.writeFileSync(path.join(tmp, 'pending-injects', 'bad.json'), '{not json');
    fs.writeFileSync(path.join(tmp, 'pending-injects', 'wrong-shape.json'), JSON.stringify({ nope: true }));
    const { records, corrupt } = store.list();
    expect(records).toHaveLength(1);
    expect(corrupt.sort()).toEqual(['bad.json', 'wrong-shape.json']);
  });

  it('lists nothing when the directory was never created', () => {
    const fresh = new PendingInjectStore(path.join(tmp, 'never-written'));
    expect(fresh.list().records).toEqual([]);
  });
});

describe('sweepPendingInjects (boot recovery decisions)', () => {
  let tmp: string;
  let store: PendingInjectStore;
  const NOW = Date.parse('2026-06-06T00:37:46.000Z'); // the incident's new-server boot time

  function rec(tmux: string, ageMinutes: number): void {
    store.record({
      tmuxSession: tmux,
      initialMessage: `msg for ${tmux}`,
      telegramTopicId: 2271,
      createdAt: new Date(NOW - ageMinutes * 60_000).toISOString(),
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-sweep-'));
    store = new PendingInjectStore(tmp);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/pending-inject-store.test.ts:afterEach' });
  });

  it('THE INCIDENT CASE: alive session gets the message re-delivered, record cleared', async () => {
    rec('codey-git-management', 2); // queued 2 minutes before this boot
    const redelivered: PendingInjectRecord[] = [];
    const result = await sweepPendingInjects(store, {
      sessionAlive: () => true,
      redeliver: async (r) => { redelivered.push(r); },
      reportLoss: vi.fn(),
      now: () => NOW,
    });
    expect(result.redelivered).toEqual(['codey-git-management']);
    expect(redelivered[0].initialMessage).toContain('codey-git-management');
    expect(store.list().records).toHaveLength(0);
  });

  it('dead session: loss reported LOUDLY, record expired — never silent', async () => {
    rec('died-with-server', 2);
    const losses: string[] = [];
    const result = await sweepPendingInjects(store, {
      sessionAlive: () => false,
      redeliver: vi.fn(async () => { throw new Error('must not be called'); }),
      reportLoss: (r, reason) => losses.push(`${r.tmuxSession}: ${reason}`),
      now: () => NOW,
    });
    expect(result.deadSession).toEqual(['died-with-server']);
    expect(losses[0]).toContain('no longer exists');
    expect(store.list().records).toHaveLength(0);
  });

  it('stale record: expired with a report instead of re-injecting into an hours-later conversation', async () => {
    rec('ancient', 8 * 60); // 8h > 6h default
    const losses: string[] = [];
    const result = await sweepPendingInjects(store, {
      sessionAlive: () => true,
      redeliver: vi.fn(async () => { throw new Error('must not be called'); }),
      reportLoss: (r, reason) => losses.push(reason),
      now: () => NOW,
    });
    expect(result.expired).toEqual(['ancient']);
    expect(losses[0]).toContain('expired');
    expect(store.list().records).toHaveLength(0);
  });

  it('redeliver failure: record KEPT for the next boot, reported as failed', async () => {
    rec('flaky', 2);
    const result = await sweepPendingInjects(store, {
      sessionAlive: () => true,
      redeliver: async () => { throw new Error('readiness probe timed out'); },
      reportLoss: vi.fn(),
      now: () => NOW,
    });
    expect(result.failed).toEqual(['flaky']);
    expect(store.list().records).toHaveLength(1); // survives for the next boot's retry
  });

  it('mixed population: each record gets its own verdict', async () => {
    rec('alive-fresh', 1);
    rec('dead-fresh', 1);
    rec('alive-stale', 10 * 60);
    const result = await sweepPendingInjects(store, {
      sessionAlive: (t) => t.startsWith('alive'),
      redeliver: async () => { /* delivered */ },
      reportLoss: vi.fn(),
      now: () => NOW,
    });
    expect(result.redelivered).toEqual(['alive-fresh']);
    expect(result.deadSession).toEqual(['dead-fresh']);
    expect(result.expired).toEqual(['alive-stale']);
    expect(store.list().records).toHaveLength(0);
  });
});
