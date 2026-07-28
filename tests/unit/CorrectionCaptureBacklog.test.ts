/**
 * Unit — CorrectionCaptureBacklog (durable capture-backlog with retry).
 *
 * Pins the bounded-retention + privacy invariants of the store in isolation:
 *   - enqueue + count, max-entries eviction (oldest first), near-identical dedupe
 *   - claimBatch oldest-first ordering + min-retry-gap + exhausted-skip
 *   - markDistilled deletes; bumpAttempt drops at maxRetries
 *   - pruneExpired discards stale rows by TTL
 *   - ONLY pre-scrubbed text is persisted (secrets are scrubbed on enqueue)
 *   - fail-open: methods never throw
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';
import type { CaptureTurn } from '../../src/monitoring/CorrectionCaptureLoop.js';

function turns(...texts: { u: boolean; t: string }[]): CaptureTurn[] {
  return texts.map((x) => ({ fromUser: x.u, text: x.t, at: 0 }));
}

describe('CorrectionCaptureBacklog', () => {
  let store: CorrectionCaptureBacklog | null = null;
  afterEach(() => { store?.close(); store = null; });

  it('enqueue persists a capture and count() reflects it', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    expect(store.count()).toBe(0);
    const id = store.enqueue({ topicId: 1, turns: turns({ u: true, t: 'lead with the action' }), deterministicWeight: 3 });
    expect(id).toBeTruthy();
    expect(store.count()).toBe(1);
  });

  it('evicts the OLDEST entry when at the max-entries cap', () => {
    let clock = 1_000;
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', maxEntries: 3, now: () => clock });
    for (let i = 0; i < 3; i++) {
      clock += 10;
      store.enqueue({ topicId: i + 1, turns: turns({ u: true, t: `pref ${i}` }), deterministicWeight: 2 });
    }
    expect(store.count()).toBe(3);
    // A 4th enqueue evicts the oldest (topic 1, the earliest captured_at).
    clock += 10;
    store.enqueue({ topicId: 99, turns: turns({ u: true, t: 'newest pref' }), deterministicWeight: 2 });
    expect(store.count()).toBe(3);
    const claimed = store.claimBatch(10);
    const topics = claimed.map((e) => e.topicId).sort((a, b) => a - b);
    expect(topics).toEqual([2, 3, 99]); // topic 1 was evicted
  });

  it('dedupes a near-identical capture (same topic + same scrubbed turns) — no duplicate row', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const t = turns({ u: false, t: 'sorry' }, { u: true, t: 'stop apologizing so much' });
    const id1 = store.enqueue({ topicId: 5, turns: t, deterministicWeight: 3 });
    const id2 = store.enqueue({ topicId: 5, turns: t, deterministicWeight: 3 });
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1); // same row refreshed, not a new one
    expect(store.count()).toBe(1);
  });

  it('claimBatch returns oldest-first and respects the min-retry-gap + exhausted-skip', () => {
    let clock = 0;
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', maxRetries: 2, minRetryGapMs: 1000, now: () => clock });
    clock = 100; const a = store.enqueue({ topicId: 1, turns: turns({ u: true, t: 'a' }), deterministicWeight: 1 })!;
    clock = 200; const b = store.enqueue({ topicId: 2, turns: turns({ u: true, t: 'b' }), deterministicWeight: 1 })!;
    // Oldest-first.
    const batch1 = store.claimBatch(10);
    expect(batch1.map((e) => e.id)).toEqual([a, b]);
    // Attempt `a` → it must not re-appear within the gap.
    clock = 300; store.bumpAttempt(a);
    const batch2 = store.claimBatch(10);
    expect(batch2.map((e) => e.id)).toEqual([b]); // a is within the retry gap
    // Past the gap, a is claimable again.
    clock = 1500;
    const batch3 = store.claimBatch(10);
    expect(batch3.map((e) => e.id)).toEqual([a, b]);
  });

  it('markDistilled deletes the entry', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const id = store.enqueue({ topicId: 1, turns: turns({ u: true, t: 'x' }), deterministicWeight: 1 })!;
    expect(store.count()).toBe(1);
    store.markDistilled(id);
    expect(store.count()).toBe(0);
  });

  it('bumpAttempt DROPS the entry once attempts exceed maxRetries', () => {
    let clock = 0;
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', maxRetries: 2, minRetryGapMs: 0, now: () => clock });
    const id = store.enqueue({ topicId: 1, turns: turns({ u: true, t: 'x' }), deterministicWeight: 1 })!;
    clock = 1; expect(store.bumpAttempt(id)).toBe(false); // attempts=1
    clock = 2; expect(store.bumpAttempt(id)).toBe(false); // attempts=2 (== maxRetries, still kept)
    expect(store.count()).toBe(1);
    clock = 3; expect(store.bumpAttempt(id)).toBe(true);  // attempts=3 (> maxRetries → dropped)
    expect(store.count()).toBe(0);
  });

  it('pruneExpired discards rows older than the TTL', () => {
    let clock = 10_000;
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', now: () => clock });
    store.enqueue({ topicId: 1, turns: turns({ u: true, t: 'old' }), deterministicWeight: 1, capturedAt: 1_000 });
    store.enqueue({ topicId: 2, turns: turns({ u: true, t: 'fresh' }), deterministicWeight: 1, capturedAt: 9_900 });
    // TTL = 5_000ms → cutoff = clock - 5000 = 5000; row at 1000 is stale, 9900 is fresh.
    const pruned = store.pruneExpired(5_000);
    expect(pruned).toBe(1);
    expect(store.count()).toBe(1);
    const remaining = store.claimBatch(10);
    expect(remaining[0].topicId).toBe(2);
  });

  it('persists ONLY pre-scrubbed text — a secret in the turn is scrubbed before it lands on disk', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    store.enqueue({
      topicId: 1,
      turns: turns({ u: true, t: `my token is ${secret} please use it` }),
      deterministicWeight: 3,
    });
    const [entry] = store.claimBatch(10);
    const persistedText = entry.turns.map((t) => t.text).join(' ');
    expect(persistedText).not.toContain(secret);
    expect(persistedText).toContain('gh***_REDACTED'); // scrubSecrets placeholder
  });

  it('claimBatch returns the deterministicWeight + sessionId for the drainer', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    store.enqueue({ topicId: 7, turns: turns({ u: true, t: 'x' }), deterministicWeight: 5, sessionId: 'sess-A' });
    const [entry] = store.claimBatch(10);
    expect(entry.topicId).toBe(7);
    expect(entry.deterministicWeight).toBe(5);
    expect(entry.sessionId).toBe('sess-A');
  });

  it('is fail-open after close() — methods return safe defaults, never throw', () => {
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', onError: () => { /* swallow */ } });
    store.close();
    expect(() => store!.enqueue({ topicId: 1, turns: turns({ u: true, t: 'x' }), deterministicWeight: 1 })).not.toThrow();
    expect(store.count()).toBe(0);
    expect(store.claimBatch(5)).toEqual([]);
    expect(() => store!.markDistilled('nope')).not.toThrow();
    expect(store.bumpAttempt('nope')).toBe(false);
    expect(store.pruneExpired(1000)).toBe(0);
    store = null; // already closed
  });

  it('maxEntries:0 in opts falls back to the default (the disable path is enforced by the caller, not constructed)', () => {
    // The store treats 0/negative as "use default" so a mis-config can never make
    // it unbounded; the server-side wiring is what skips construction when 0.
    store = new CorrectionCaptureBacklog({ dbPath: ':memory:', maxEntries: 0 });
    for (let i = 0; i < 5; i++) store.enqueue({ topicId: i, turns: turns({ u: true, t: `p${i}` }), deterministicWeight: 1 });
    expect(store.count()).toBe(5); // bounded by default 200, not 0
  });
});
