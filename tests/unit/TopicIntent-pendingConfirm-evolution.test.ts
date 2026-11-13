// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — TopicIntentPendingConfirm extended for evolutions
 * (context-budget-layered-summaries §6.1, decision 15: "extended, not forked"):
 * the `kind`, the per-kind TTL counted from SURFACING and needing a user turn
 * since, evolution priority over ref confirmations with the displaced ref
 * REQUEUED (never dropped), overflow DEFERRED with telemetry, deferred items
 * moving back up as the queue drains, and `settle`. A ref-only queue keeps
 * its v14 behaviour except overflow (deferred, not dropped).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicIntentStore, buildEvent } from '../../src/core/TopicIntent.js';
import { PendingConfirmationManager, PENDING_TTL_BY_KIND } from '../../src/core/TopicIntentPendingConfirm.js';

let tempDir: string;
let store: TopicIntentStore;
let mgr: PendingConfirmationManager;
const T = 700;
const H = 3600_000;
const iso = (ms: number) => new Date(Date.UTC(2026, 10, 10) + ms).toISOString();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-evolution-'));
  store = new TopicIntentStore(tempDir);
  mgr = new PendingConfirmationManager(store);
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tempDir, { recursive: true, force: true, operation: 'tests/unit/TopicIntent-pendingConfirm-evolution.test.ts' });
});

const seed = (refId: string, kind: 'goal' | 'decision' = 'decision') =>
  store.appendEvidence(T, refId, buildEvent(refId, 'extract-user', `seed-${refId}`), { text: refId, kind });
const create = (refId: string, kind?: 'ref' | 'evolution', turn = 1, now = iso(0)) =>
  mgr.create({ topicId: T, arcId: 'arc', refId, propositionText: refId, questionText: 'q', currentUserTurn: turn, now, ...(kind ? { kind } : {}) });

describe('kind and per-kind TTL', () => {
  it('a ref record carries no kind (byte-compatible); an evolution is stamped and gets its own TTL', () => {
    seed('ref-a'); seed('ev-1', 'goal');
    create('ref-a');
    expect(store.load(T).pending.outstanding).not.toHaveProperty('kind');
    expect(store.load(T).pending.outstanding?.ttl).toEqual(PENDING_TTL_BY_KIND.ref);
    mgr.cancelOutstanding(T);
    create('ev-1', 'evolution');
    expect(store.load(T).pending.outstanding).toMatchObject({ kind: 'evolution', ttl: PENDING_TTL_BY_KIND.evolution });
    expect(PENDING_TTL_BY_KIND.evolution).toEqual({ turns: 1, hours: 168 });
  });

  it('an evolution never expires before it is surfaced', () => {
    seed('ev-1', 'goal');
    create('ev-1', 'evolution', 1, iso(0));
    expect(mgr.sweepTtl(T, 50, iso(60 * 24 * H))).toBeNull();
    expect(store.load(T).pending.outstanding?.refId).toBe('ev-1');
  });

  it('from surfacing: 7 days AND a user turn since — either alone does not expire it', () => {
    seed('ev-1', 'goal');
    create('ev-1', 'evolution', 1, iso(0));
    expect(mgr.markSurfaced(T, { currentUserTurn: 3, afterMessageId: '90', now: iso(H) })).toMatchObject({ surfacedAtTurn: 3, surfacedAfterMessageId: '90' });
    expect(mgr.markSurfaced(T, { currentUserTurn: 9, afterMessageId: '91', now: iso(2 * H) })).toBeNull(); // once
    expect(mgr.sweepTtl(T, 3, iso(H + 30 * 24 * H))).toBeNull();      // 30 days, no user turn since
    expect(mgr.sweepTtl(T, 9, iso(H + 6 * 24 * H))).toBeNull();       // user turns, 6 days
    const swept = mgr.sweepTtl(T, 4, iso(H + 7 * 24 * H));            // both
    expect(swept).toMatchObject({ refId: 'ev-1', status: 'expired' });
    expect(store.load(T).pending.outstanding).toBeNull();
  });

  it('a ref is never marked surfaced and keeps its 5-turn / 24h clock from dequeue', () => {
    seed('ref-a');
    create('ref-a', undefined, 1, iso(0));
    expect(mgr.markSurfaced(T, { currentUserTurn: 1, afterMessageId: '5', now: iso(1) })).toBeNull();
    expect(mgr.sweepTtl(T, 2, iso(23 * H))).toBeNull();
    expect(mgr.sweepTtl(T, 2, iso(24 * H))).toMatchObject({ refId: 'ref-a', status: 'expired' });
  });
});

describe('priority, requeue and deferred', () => {
  it('an evolution displaces an outstanding ref, which is requeued at the head (never dropped)', () => {
    seed('ref-a'); seed('ref-b'); seed('ev-1', 'goal');
    create('ref-a'); create('ref-b');
    const r = create('ev-1', 'evolution');
    expect(r.status).toBe('outstanding');
    const f = store.load(T);
    expect(r.requeuedPendingId).toBe(f.pending.queue[0].pendingId);
    expect(f.pending.outstanding?.refId).toBe('ev-1');
    expect(f.pending.queue.map((p) => p.refId)).toEqual(['ref-a', 'ref-b']);
    expect(f.pending.queue[0].requeued).toBe(1);
    expect(f.pending.queue[0].dequeuedAtTime).toBeUndefined();
    expect(f.telemetry.pending_confirm_requeued_total).toBe(1);
  });

  it('queued evolutions sit ahead of queued refs; an evolution behind an evolution does not displace it', () => {
    seed('ev-1', 'goal'); seed('ref-a'); seed('ref-b'); seed('ev-2', 'goal');
    create('ev-1', 'evolution'); create('ref-a'); create('ref-b');
    expect(create('ev-2', 'evolution').status).toBe('queued');
    const f = store.load(T);
    expect(f.pending.outstanding?.refId).toBe('ev-1');
    expect(f.pending.queue.map((p) => p.refId)).toEqual(['ev-2', 'ref-a', 'ref-b']);
  });

  it('overflow defers the lowest priority (the newest ref), counts it, and it moves back up as the queue drains', () => {
    for (const id of ['ev-1', 'ev-2', 'ev-3', 'ev-4']) seed(id, 'goal');
    for (const id of ['ref-a', 'ref-b', 'ref-c']) seed(id);
    create('ref-a'); create('ref-b'); create('ref-c');      // a out, b c queued
    create('ev-1', 'evolution');                             // ev-1 out, queue a b c
    expect(store.load(T).pending.queue.map((p) => p.refId)).toEqual(['ref-a', 'ref-b', 'ref-c']);
    expect(create('ev-2', 'evolution').status).toBe('queued'); // queue ev-2 a b, c deferred
    let f = store.load(T);
    expect(f.pending.queue.map((p) => p.refId)).toEqual(['ev-2', 'ref-a', 'ref-b']);
    expect(f.pending.deferred?.map((p) => p.refId)).toEqual(['ref-c']);
    expect(f.telemetry.pending_confirm_deferred_total).toBe(1);
    create('ev-3', 'evolution'); create('ev-4', 'evolution');
    f = store.load(T);
    expect(f.pending.queue.map((p) => p.refId)).toEqual(['ev-2', 'ev-3', 'ev-4']);
    expect(f.pending.deferred?.map((p) => p.refId)).toEqual(['ref-c', 'ref-b', 'ref-a']);
    // Nothing was dropped: 1 outstanding + 3 queued + 3 deferred = all 7.
    expect(f.telemetry.pending_confirm_queue_dropped_total).toBe(0);
    // Draining: settle ev-1 (resolved by its ledger entry) → ev-2 out, a deferred ref moves up.
    expect(mgr.settle(T, 'ev-1', 'confirmed')).toMatchObject({ refId: 'ev-1', settledAs: 'confirmed' });
    f = store.load(T);
    expect(f.pending.outstanding?.refId).toBe('ev-2');
    expect(f.pending.queue).toHaveLength(3);
    expect(f.pending.deferred).toHaveLength(2);
    expect(f.telemetry.pending_confirm_settled_total).toBe(1);
  });

  it('settle removes a queued or deferred confirmation too, and is a no-op for an unknown ref', () => {
    seed('ref-a'); seed('ref-b');
    create('ref-a'); create('ref-b');
    expect(mgr.settle(T, 'ref-b', 'withdrawn')?.refId).toBe('ref-b');
    expect(store.load(T).pending.queue).toEqual([]);
    expect(mgr.settle(T, 'nope', 'withdrawn')).toBeNull();
  });

  it('a queued evolution whose ref became authoritative is still promoted (the ledger decides); a ref is dropped as before', () => {
    seed('ref-a'); seed('ev-1', 'goal'); seed('ev-2', 'goal'); seed('ref-b');
    create('ev-1', 'evolution'); create('ev-2', 'evolution'); create('ref-b');
    for (const id of ['ev-2', 'ref-b']) store.appendEvidence(T, id, buildEvent(id, 'pending-confirm-positive', `m-${id}`));
    mgr.settle(T, 'ev-1', 'confirmed');
    expect(store.load(T).pending.outstanding?.refId).toBe('ev-2');
    mgr.settle(T, 'ev-2', 'confirmed');
    // ref-b is authoritative: dropped at dequeue (v14 behaviour), counted.
    expect(store.load(T).pending.outstanding).toBeNull();
  });

  it('dedup spans outstanding, queue and deferred', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) seed(`ref-${id}`);
    for (const id of ['a', 'b', 'c', 'd', 'e']) create(`ref-${id}`);
    expect(store.load(T).pending.deferred?.map((p) => p.refId)).toEqual(['ref-e']);
    expect(create('ref-e').status).toBe('dropped-duplicate');
  });
});
