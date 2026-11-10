// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §9.3 "Held inbound" at the store level:
 * a fold holds a session's queued rows (and every row that arrives while it
 * holds), the drain never sees them, their TTL does not run, an operator
 * pause/resume never releases them, and only the fold's release does — with
 * the held time credited to the TTL and never to the pause cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PendingInboundStore, resolvePendingInboundPath, type EnqueueInput, type InboundQueueBounds } from '../../src/core/PendingInboundStore.js';

const OP = 'tests/unit/pending-inbound-fold-hold.test.ts';
const BOUNDS: InboundQueueBounds = { maxPerSession: 10, maxTotal: 20, hardMaxTotal: 30, maxPayloadBytes: 4096 };
const T0 = Date.parse('2026-11-10T09:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

let dir: string;
let store: PendingInboundStore;
let n = 0;
const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => {
  n += 1;
  return { sessionKey: '141133', messageId: `m${n}`, payload: 'hello', reason: 'test', tenure: 't', nowIso: iso(T0), monoMs: 1, bootSessionId: 'b', ...over };
};
const enqueue = (over: Partial<EnqueueInput> = {}) => {
  const r = store.enqueue(input(over), BOUNDS);
  if (r.result !== 'queued') throw new Error(r.result);
  return r.seq;
};
const heads = (at = T0) => store.selectEligibleHeads(iso(at), 50).map((r) => r.session_key);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-fold-'));
  store = PendingInboundStore.open('echo', dir);
  n = 0;
});
afterEach(() => {
  store.close();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
});

describe('fold hold on the inbound queue', () => {
  it('a held session is invisible to the drain; other sessions are not', () => {
    enqueue();
    enqueue({ sessionKey: '999' });
    expect(store.holdForFold('141133', 'fold1', iso(T0))).toBe(1);
    expect(heads()).toEqual(['999']);
    expect(store.foldHeldSessions()).toEqual([{ sessionKey: '141133', foldId: 'fold1' }]);
  });

  it('a message arriving while the fold holds its session is held from enqueue', () => {
    const seq = enqueue({ foldHeldBy: 'fold1' });
    const row = store.getRow(seq)!;
    expect(row).toMatchObject({ fold_id: 'fold1', fold_since: iso(T0) });
    expect(row.frozen_since).not.toBeNull();
    expect(heads()).toEqual([]);
  });

  it('the TTL does not run while held, and the held span is credited after release', () => {
    const seq = enqueue();
    store.holdForFold('141133', 'fold1', iso(T0));
    // 5h later, TTL 4h: still held ⇒ never expired.
    expect(store.listTtlExpired(iso(T0 + 5 * HOUR), 4 * HOUR)).toEqual([]);
    expect(store.releaseFold('fold1', iso(T0 + 5 * HOUR))).toBe(1);
    // 30 min after release: queued 5.5h ago but held 5h ⇒ effective age 0.5h < 4h.
    expect(store.listTtlExpired(iso(T0 + 5.5 * HOUR), 4 * HOUR)).toEqual([]);
    // 4h after release: effective age 4h + ε ⇒ expired.
    expect(store.listTtlExpired(iso(T0 + 9.1 * HOUR), 4 * HOUR).map((r) => r.enqueue_seq)).toEqual([seq]);
    expect(heads(T0 + 5 * HOUR + 1)).toEqual(['141133']);
  });

  it('an operator pause/resume never releases a fold-held row, and fold time never counts toward the pause cap', () => {
    const seq = enqueue();
    store.holdForFold('141133', 'fold1', iso(T0));
    store.setPaused(true, iso(T0));
    store.freezeQueuedRows(iso(T0));
    store.setPaused(false, iso(T0 + 2 * HOUR));
    const { overCap } = store.resumeFrozenRows(iso(T0 + 2 * HOUR), HOUR);
    expect(overCap).toEqual([]); // held 2h > 1h pause cap, but it is the fold's time
    expect(store.getRow(seq)!.fold_id).toBe('fold1');
    expect(heads(T0 + 2 * HOUR)).toEqual([]);
    store.releaseFold('fold1', iso(T0 + 3 * HOUR));
    const row = store.getRow(seq)!;
    expect(row.total_frozen_ms).toBe(0);
    expect(row.fold_frozen_ms).toBe(3 * HOUR);
    expect(heads(T0 + 3 * HOUR)).toEqual(['141133']);
  });

  it('released during an operator pause, the row stays frozen for the pause (its pause span starts at release)', () => {
    const seq = enqueue();
    store.holdForFold('141133', 'fold1', iso(T0));
    store.setPaused(true, iso(T0 + HOUR));
    store.releaseFold('fold1', iso(T0 + 2 * HOUR));
    const row = store.getRow(seq)!;
    expect(row.fold_id).toBeNull();
    expect(row.frozen_since).toBe(iso(T0 + 2 * HOUR));
    expect(heads(T0 + 2 * HOUR)).toEqual([]);
  });

  it('release is scoped to the named fold', () => {
    enqueue();
    enqueue({ sessionKey: '999' });
    store.holdForFold('141133', 'fold1', iso(T0));
    store.holdForFold('999', 'fold2', iso(T0));
    expect(store.releaseFold('fold1', iso(T0 + 1000))).toBe(1);
    expect(store.foldHeldSessions()).toEqual([{ sessionKey: '999', foldId: 'fold2' }]);
  });

  it('an existing queue database gains the fold columns on open (additive, idempotent)', () => {
    store.close();
    const p = resolvePendingInboundPath(dir, 'echo');
    const db = new Database(p);
    // Simulate a pre-change database: drop the new columns by rebuilding the table without them.
    const cols = (db.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>).map((c) => c.name).filter((c) => !c.startsWith('fold_'));
    db.exec(`CREATE TABLE entries_old AS SELECT ${cols.join(',')} FROM entries; DROP TABLE entries; ALTER TABLE entries_old RENAME TO entries;`);
    db.close();
    store = PendingInboundStore.open('echo', dir);
    store.close();
    store = PendingInboundStore.open('echo', dir); // second open: no duplicate-column error
    const after = new Database(p);
    const names = (after.prepare(`PRAGMA table_info(entries)`).all() as Array<{ name: string }>).map((c) => c.name);
    after.close();
    expect(names).toEqual(expect.arrayContaining(['fold_id', 'fold_since', 'fold_frozen_ms']));
  });
});

describe('session-level fold hold and the carrier (foldInboundHold)', () => {
  it('a message arriving at an EMPTY held session is held (the hold is per session, not per row)', () => {
    expect(store.holdForFold('141133', 'fold1', iso(T0))).toBe(0); // nothing queued yet
    const seq = enqueue();
    expect(store.getRow(seq)!.fold_id).toBe('fold1');
    expect(heads()).toEqual([]);
    store.releaseFold('fold1', iso(T0 + 1000));
    expect(enqueue() > seq).toBe(true);
    expect(heads(T0 + 2000)).toEqual(['141133']); // the hold is gone for new arrivals too
  });

  it('maps inbound session keys to fold keys and releases only through the record', async () => {
    const { foldKeyForInboundSession, inboundHoldCarrier, releaseSettledInboundHolds } = await import('../../src/monitoring/foldInboundHold.js');
    const { foldKeyForConversation } = await import('../../src/monitoring/FoldHoldStore.js');
    expect(foldKeyForInboundSession('141133')).toBe('141133');
    expect(foldKeyForInboundSession('app:conv-1')).toBe(foldKeyForConversation('app', 'conv-1'));
    expect(foldKeyForInboundSession('slack-x')).toBeNull();

    enqueue();
    enqueue({ sessionKey: '999' });
    enqueue({ sessionKey: '777' });
    store.holdForFold('141133', 'fOpen', iso(T0));
    store.holdForFold('999', 'fDone', iso(T0));
    store.holdForFold('777', 'fGone', iso(T0));
    const carrier = inboundHoldCarrier(() => store);
    expect(carrier.list().map((x) => x.foldId).sort()).toEqual(['fDone', 'fGone', 'fOpen']);

    const released = releaseSettledInboundHolds(store, (_t, f) => (f === 'fOpen' ? true : f === 'fDone' ? false : null), iso(T0 + 1000));
    expect(released.sort()).toEqual(['fDone', 'fGone']);
    expect(heads(T0 + 1000).sort()).toEqual(['777', '999']);

    carrier.release('141133', 'fOpen'); // the terminal transition
    expect(heads(T0 + 2000).sort()).toEqual(['141133', '777', '999']);
    expect(inboundHoldCarrier(() => null).list()).toEqual([]);
  });
});

describe('second-pass review fixes', () => {
  it('a claimed row released back while its session is held becomes fold-held (not deliverable)', () => {
    const seq = enqueue();
    expect(store.claim(seq, iso(T0))).toBeTruthy();
    store.holdForFold('141133', 'fold1', iso(T0 + 1000));
    expect(store.release(seq, { nowIso: iso(T0 + 2000), attempts: 1, nextAttemptAt: null })).toBe(true);
    expect(store.getRow(seq)).toMatchObject({ fold_id: 'fold1' });
    expect(heads(T0 + 3000)).toEqual([]);
    store.releaseFold('fold1', iso(T0 + 4000));
    expect(heads(T0 + 5000)).toEqual(['141133']);
  });

  it('fold-held rows are never evicted at the per-session cap; the arrival is refused instead', () => {
    const small: InboundQueueBounds = { maxPerSession: 2, maxTotal: 20, hardMaxTotal: 30, maxPayloadBytes: 4096 };
    store.enqueue(input(), small);
    store.enqueue(input(), small);
    store.holdForFold('141133', 'fold1', iso(T0));
    const r = store.enqueue(input(), small);
    expect(r).toEqual({ result: 'refused', reason: 'max-per-session-fold-held' });
    expect(store.listNonTerminal().filter((x) => x.fold_id === 'fold1')).toHaveLength(2);
  });
});
