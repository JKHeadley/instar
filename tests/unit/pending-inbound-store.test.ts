/**
 * PendingInboundStore unit tests — Durable Inbound Message Queue spec §1.
 * The spec's named cases: PK collision tri-state, bounds incl. hardMaxTotal
 * carve-out boundary, AUTOINCREMENT across prunes, claim CAS,
 * eviction-skips-claimed, payload nulling at terminal, conditional receipt
 * commit, tenure derivation, cumulative pause accounting across restart,
 * handle encapsulation, 0600 mode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PendingInboundStore,
  resolvePendingInboundPath,
  type EnqueueInput,
  type InboundQueueBounds,
} from '../../src/core/PendingInboundStore.js';

const BOUNDS: InboundQueueBounds = {
  maxPerSession: 3,
  maxTotal: 6,
  hardMaxTotal: 8,
  maxPayloadBytes: 1024,
};

let dir: string;
let store: PendingInboundStore;
let seqCounter = 0;

function input(over: Partial<EnqueueInput> = {}): EnqueueInput {
  seqCounter += 1;
  return {
    sessionKey: 'topic-1',
    messageId: `m-${seqCounter}`,
    payload: 'hello world',
    senderEnvelope: { userId: 42, username: 'justin', firstName: 'Justin' },
    topicMetadata: { topicName: 'general' },
    reason: 'ownership-contention',
    tenure: 'mac-a#1',
    nowIso: new Date('2026-06-12T20:00:00Z').toISOString(),
    monoMs: 1000,
    bootSessionId: 'boot-1',
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-test-'));
  store = PendingInboundStore.open('echo', dir);
  seqCounter = 0;
});

afterEach(() => {
  store.close();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'pending-inbound-store.test.ts' });
});

describe('open / encapsulation / file mode', () => {
  it('creates the store file 0600 under <stateDir>/state/', () => {
    const p = resolvePendingInboundPath(dir, 'echo');
    expect(fs.existsSync(p)).toBe(true);
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does NOT expose the DB handle (round-8 encapsulation contract)', () => {
    expect('db' in (store as unknown as Record<string, unknown>)).toBe(false);
    expect((store as unknown as Record<string, unknown>).db).toBeUndefined();
    // No method returns the handle: every own property is a function or string.
    for (const key of Object.getOwnPropertyNames(store)) {
      const v = (store as unknown as Record<string, unknown>)[key];
      expect(typeof v === 'function' || v === undefined).toBe(true);
    }
  });

  it('sanitizes agentId in the path (no traversal)', () => {
    const p = resolvePendingInboundPath('/tmp/x', '../evil/agent');
    expect(p).toContain('pending-inbound..._evil_agent.sqlite');
    expect(path.basename(p)).not.toContain('/');
  });
});

describe('enqueue tri-state', () => {
  it('queues a fresh message and returns its seq', () => {
    const out = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    expect(out).toMatchObject({ result: 'queued', evicted: null });
  });

  it('already-queued for an existing non-terminal row (custody re-affirmed)', () => {
    store.enqueue(input({ messageId: 'a' }), BOUNDS);
    const out = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    expect(out).toMatchObject({ result: 'already-queued', existingState: 'queued' });
  });

  it('already-queued for a delivered row (correct dedupe)', () => {
    const q = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    const seq = (q as { seq: number }).seq;
    store.claim(seq, isoNow());
    store.transition(seq, 'claimed', 'delivered', { nowIso: isoNow() });
    const out = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    expect(out).toMatchObject({ result: 'already-queued', existingState: 'delivered' });
  });

  it('REFUSES against an expired/dropped-overflow prior instance (round-2 security)', () => {
    const q = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    const seq = (q as { seq: number }).seq;
    store.transition(seq, 'queued', 'expired', { nowIso: isoNow(), terminalReason: 'ttl' });
    const out = store.enqueue(input({ messageId: 'a' }), BOUNDS);
    expect(out).toMatchObject({ result: 'refused', reason: 'prior-instance-terminal:expired' });
  });

  it('refuses an oversize payload', () => {
    const out = store.enqueue(input({ payload: 'x'.repeat(2048) }), BOUNDS);
    expect(out).toMatchObject({ result: 'refused', reason: 'payload-oversize' });
  });
});

describe('bounds (P19) — maxPerSession eviction, maxTotal carve-out, hardMaxTotal', () => {
  it('evicts the session oldest QUEUED row at maxPerSession (never claimed)', () => {
    const first = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.enqueue(input({ messageId: 'b' }), BOUNDS);
    store.enqueue(input({ messageId: 'c' }), BOUNDS);
    const out = store.enqueue(input({ messageId: 'd' }), BOUNDS);
    expect(out).toMatchObject({ result: 'queued' });
    const evicted = (out as { evicted: { messageId: string } }).evicted;
    expect(evicted.messageId).toBe('a');
    expect(store.getRow(first.seq)?.state).toBe('dropped-overflow');
  });

  it('eviction skips a claimed head — evicts the oldest QUEUED instead', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.enqueue(input({ messageId: 'b' }), BOUNDS);
    store.enqueue(input({ messageId: 'c' }), BOUNDS);
    store.claim(a.seq, isoNow());
    const out = store.enqueue(input({ messageId: 'd' }), BOUNDS);
    const evicted = (out as { evicted: { messageId: string } }).evicted;
    expect(evicted.messageId).toBe('b'); // a is claimed, skipped
    expect(store.getRow(a.seq)?.state).toBe('claimed');
  });

  it('refuses when ALL session rows are claimed (nothing evictable)', () => {
    const seqs: number[] = [];
    for (const m of ['a', 'b', 'c']) {
      const r = store.enqueue(input({ messageId: m }), BOUNDS) as { seq: number };
      seqs.push(r.seq);
    }
    for (const s of seqs) store.claim(s, isoNow());
    const out = store.enqueue(input({ messageId: 'd' }), BOUNDS);
    expect(out).toMatchObject({ result: 'refused', reason: 'max-per-session-all-claimed' });
  });

  it('maxTotal refuses FIRST entries but lets queued sessions append (carve-out)', () => {
    // Fill maxTotal=6 with 2 rows in each of 3 sessions.
    for (const sk of ['s1', 's2', 's3']) {
      store.enqueue(input({ sessionKey: sk, messageId: `${sk}-1` }), BOUNDS);
      store.enqueue(input({ sessionKey: sk, messageId: `${sk}-2` }), BOUNDS);
    }
    // New session at the total cap → refused.
    const fresh = store.enqueue(input({ sessionKey: 's-new', messageId: 'n1' }), BOUNDS);
    expect(fresh).toMatchObject({ result: 'refused', reason: 'max-total-first-entry' });
    // Already-queued session may append (FIFO carve-out).
    const append = store.enqueue(input({ sessionKey: 's1', messageId: 's1-3' }), BOUNDS);
    expect(append).toMatchObject({ result: 'queued' });
  });

  it('hardMaxTotal refuses even carve-out appends (the carve-out boundary)', () => {
    const wide: InboundQueueBounds = { ...BOUNDS, maxPerSession: 10, maxTotal: 2, hardMaxTotal: 4 };
    store.enqueue(input({ sessionKey: 's1', messageId: 'a' }), wide);
    store.enqueue(input({ sessionKey: 's1', messageId: 'b' }), wide);
    // Carve-out appends past maxTotal…
    store.enqueue(input({ sessionKey: 's1', messageId: 'c' }), wide);
    store.enqueue(input({ sessionKey: 's1', messageId: 'd' }), wide);
    // …until hardMaxTotal.
    const out = store.enqueue(input({ sessionKey: 's1', messageId: 'e' }), wide);
    expect(out).toMatchObject({ result: 'refused', reason: 'hard-max-total' });
  });
});

describe('AUTOINCREMENT — seqs never reused across prunes (round-3 schema legality)', () => {
  it('a pruned terminal row does not free its seq', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.claim(a.seq, isoNow());
    store.transition(a.seq, 'claimed', 'delivered', { nowIso: isoNow() });
    // Prune with a future cutoff (row's enqueued_at is in the past).
    const pruned = store.pruneTerminal(new Date(Date.now() + 60_000).toISOString());
    expect(pruned).toBe(1);
    const b = store.enqueue(input({ messageId: 'b' }), BOUNDS) as { seq: number };
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

describe('claim CAS + expected-prior-state transitions', () => {
  it('claim succeeds once; a second claim is a no-op null', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    expect(store.claim(a.seq, isoNow())).not.toBeNull();
    expect(store.claim(a.seq, isoNow())).toBeNull();
  });

  it('a transition with a wrong expected prior state is a logged no-op (false)', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    expect(store.transition(a.seq, 'claimed', 'delivered', { nowIso: isoNow() })).toBe(false);
    expect(store.getRow(a.seq)?.state).toBe('queued');
  });

  it('release returns a claimed row to queued with attempts + backoff', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.claim(a.seq, isoNow());
    const next = new Date(Date.now() + 5000).toISOString();
    expect(store.release(a.seq, { nowIso: isoNow(), attempts: 1, nextAttemptAt: next, lastError: new Error('tmux send failed') as unknown as string })).toBe(true);
    const row = store.getRow(a.seq);
    expect(row?.state).toBe('queued');
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at).toBe(next);
  });
});

describe('payload hygiene at terminal (round-2 security)', () => {
  it('nulls payload/envelope/metadata, retains the locator, caps history', () => {
    const a = store.enqueue(input({ messageId: 'a', payload: 'SECRET-PAYLOAD-BYTES' }), BOUNDS) as { seq: number };
    store.claim(a.seq, isoNow());
    store.transition(a.seq, 'claimed', 'expired', { nowIso: isoNow(), terminalReason: 'poisoned', lastError: 'SyntaxError: bad parse' });
    const row = store.getRow(a.seq)!;
    expect(row.payload).toBeNull();
    expect(row.sender_envelope).toBeNull();
    expect(row.topic_metadata).toBeNull();
    // Locator survives (MUST 11): timestamp, ids, sender display, byte length.
    expect(row.enqueued_at).toBeTruthy();
    expect(row.message_id).toBe('a');
    expect(row.sender_display).toBe('Justin');
    expect(row.payload_bytes).toBe(Buffer.byteLength('SECRET-PAYLOAD-BYTES'));
    // No payload bytes anywhere in the row.
    expect(JSON.stringify(row)).not.toContain('SECRET-PAYLOAD-BYTES');
  });
});

describe('head-only selection (§3.2)', () => {
  it('returns only each session due head; claimed head skips the session; frozen excluded', () => {
    const a1 = store.enqueue(input({ sessionKey: 's1', messageId: 'a1' }), BOUNDS) as { seq: number };
    store.enqueue(input({ sessionKey: 's1', messageId: 'a2' }), BOUNDS);
    const b1 = store.enqueue(input({ sessionKey: 's2', messageId: 'b1' }), BOUNDS) as { seq: number };
    const c1 = store.enqueue(input({ sessionKey: 's3', messageId: 'c1' }), BOUNDS) as { seq: number };

    let heads = store.selectEligibleHeads(isoNow(), 10);
    expect(heads.map((h) => h.enqueue_seq).sort()).toEqual([a1.seq, b1.seq, c1.seq].sort());

    // Claimed head → session in flight → skipped (successor NOT selected).
    store.claim(a1.seq, isoNow());
    heads = store.selectEligibleHeads(isoNow(), 10);
    expect(heads.find((h) => h.session_key === 's1')).toBeUndefined();

    // A backed-off head hides its due successor (successors inherit schedule).
    store.release(a1.seq, { nowIso: isoNow(), attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
    heads = store.selectEligibleHeads(isoNow(), 10);
    expect(heads.find((h) => h.session_key === 's1')).toBeUndefined();

    // Frozen head excluded.
    store.freezeQueuedRows(isoNow());
    heads = store.selectEligibleHeads(isoNow(), 10);
    expect(heads).toHaveLength(0);
  });
});

describe('receipts (§3.4)', () => {
  it('conditional receipt commits iff the row is still claimed (§3.6 fence)', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.claim(a.seq, isoNow());
    expect(store.writeReceiptIfClaimed(a.seq, 'topic-1', 'a', isoNow())).toBe(true);
    expect(store.hasReceipt('topic-1', 'a')).toBe(true);
  });

  it('the fence REFUSES after a stop transitioned the row (claimed→expired)', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    store.claim(a.seq, isoNow());
    store.transition(a.seq, 'claimed', 'expired', { nowIso: isoNow(), terminalReason: 'operator-stop' });
    expect(store.writeReceiptIfClaimed(a.seq, 'topic-1', 'a', isoNow())).toBe(false);
    expect(store.hasReceipt('topic-1', 'a')).toBe(false);
  });

  it('remote receipts: record, injected marker, unflipped detection', () => {
    expect(store.recordRemoteReceipt('topic-1', 'm1', isoNow())).toBe(true);
    expect(store.recordRemoteReceipt('topic-1', 'm1', isoNow())).toBe(false); // dedupe
    expect(store.findUnflippedUnreportedReceipts()).toHaveLength(1);
    store.markReceiptInjected('topic-1', 'm1', 'remote');
    expect(store.findUnflippedUnreportedReceipts()).toHaveLength(0);
  });

  it('prune never silently drops an unflipped unreported receipt (round-10)', () => {
    store.recordRemoteReceipt('topic-1', 'old', '2020-01-01T00:00:00Z');
    store.recordRemoteReceipt('topic-1', 'old-injected', '2020-01-01T00:00:00Z');
    store.markReceiptInjected('topic-1', 'old-injected', 'remote');
    const { silent, needsReport } = store.listPrunableReceipts('2021-01-01T00:00:00Z');
    expect(silent).toBe(1);
    expect(needsReport).toHaveLength(1);
    expect(needsReport[0].message_id).toBe('old');
    // Report-once-then-prune: caller reports, then confirms.
    store.markReceiptReported('topic-1', 'old', 'remote');
    expect(store.confirmPruneReceipts('2021-01-01T00:00:00Z')).toBe(2);
  });
});

describe('tenure (§3.5 — acquisition generation, never the renewal epoch)', () => {
  it('first claim mints generation 1; renewals/same-holder re-acquire do NOT bump', () => {
    const t1 = store.observeLeaseClaim('mac-a', null);
    expect(t1).toBe('mac-a#1');
    // Same-holder re-acquire (tip names self) — same tenure.
    expect(store.observeLeaseClaim('mac-a', 'mac-a')).toBe('mac-a#1');
    expect(store.observeLeaseClaim('mac-a', 'mac-a')).toBe('mac-a#1');
  });

  it('an intervening holder at the tip bumps the generation (A→B→A)', () => {
    store.observeLeaseClaim('mac-a', null);
    const t2 = store.observeLeaseClaim('mac-a', 'mac-b');
    expect(t2).toBe('mac-a#2');
    expect(store.acquisitionGeneration()).toBe(2);
  });

  it('tenure survives a store reopen (persisted in meta)', () => {
    store.observeLeaseClaim('mac-a', null);
    store.observeLeaseClaim('mac-a', 'mac-b');
    store.close();
    store = PendingInboundStore.open('echo', dir);
    expect(store.currentTenure('mac-a')).toBe('mac-a#2');
  });
});

describe('pause / cumulative freeze accounting (§3.6)', () => {
  it('freeze marks queued rows only; resume folds the span and shifts deadlines', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    const b = store.enqueue(input({ messageId: 'b' }), BOUNDS) as { seq: number };
    store.claim(b.seq, isoNow());

    const t0 = Date.parse('2026-06-12T20:00:00Z');
    // Give the queued row a deadline so the shift is observable.
    store.release(a.seq, { nowIso: new Date(t0).toISOString(), attempts: 0, nextAttemptAt: new Date(t0 + 10_000).toISOString() });
    // Wait: release requires claimed. Claim first.
    store.claim(a.seq, new Date(t0).toISOString());
    store.release(a.seq, { nowIso: new Date(t0).toISOString(), attempts: 1, nextAttemptAt: new Date(t0 + 10_000).toISOString() });

    const frozen = store.freezeQueuedRows(new Date(t0).toISOString());
    expect(frozen).toBe(1); // only the queued row; the claimed row is untouched
    expect(store.getRow(b.seq)?.frozen_since).toBeNull();

    const { resumed, overCap } = store.resumeFrozenRows(new Date(t0 + 60_000).toISOString(), 3_600_000);
    expect(resumed).toBe(1);
    expect(overCap).toHaveLength(0);
    const row = store.getRow(a.seq)!;
    expect(row.total_frozen_ms).toBe(60_000);
    expect(row.frozen_since).toBeNull();
    expect(row.next_attempt_at).toBe(new Date(t0 + 10_000 + 60_000).toISOString());
  });

  it('N pause/resume cycles accumulate past pauseMaxMs → overCap, regardless of episode size', () => {
    const a = store.enqueue(input({ messageId: 'a' }), BOUNDS) as { seq: number };
    const cap = 100_000;
    let t = Date.parse('2026-06-12T20:00:00Z');
    // 3 episodes of 40s each — each under the cap, cumulative 120s > cap.
    for (let i = 0; i < 3; i++) {
      store.freezeQueuedRows(new Date(t).toISOString());
      t += 40_000;
      const { overCap } = store.resumeFrozenRows(new Date(t).toISOString(), cap);
      if (i < 2) expect(overCap).toHaveLength(0);
      else {
        expect(overCap).toHaveLength(1);
        expect(overCap[0].enqueue_seq).toBe(a.seq);
        expect(overCap[0].total_frozen_ms).toBe(120_000);
      }
      t += 10_000;
    }
  });

  it('restart mid-episode keeps the accounting exact (durable frozen_since, round-8)', () => {
    store.enqueue(input({ messageId: 'a' }), BOUNDS);
    const t0 = Date.parse('2026-06-12T20:00:00Z');
    store.freezeQueuedRows(new Date(t0).toISOString());
    store.setPaused(true, new Date(t0).toISOString());
    // "Restart": close + reopen.
    store.close();
    store = PendingInboundStore.open('echo', dir);
    expect(store.isPaused()).toBe(true);
    const rows = store.listNonTerminal();
    expect(rows[0].frozen_since).toBe(new Date(t0).toISOString());
    // Live span computable across the restart.
    expect(store.liveFrozenMs(rows[0], new Date(t0 + 50_000).toISOString())).toBe(50_000);
    const { overCap } = store.resumeFrozenRows(new Date(t0 + 50_000).toISOString(), 40_000);
    expect(overCap).toHaveLength(1); // 50s > 40s cap, exact across the restart
  });

  it('rows enqueued while paused are frozen at enqueue (round-10)', () => {
    store.setPaused(true, isoNow());
    const a = store.enqueue(input({ messageId: 'a', frozenAtEnqueue: true }), BOUNDS) as { seq: number };
    const row = store.getRow(a.seq)!;
    expect(row.frozen_since).not.toBeNull();
    expect(store.selectEligibleHeads(isoNow(), 10)).toHaveLength(0);
  });
});

describe('TTL + counters', () => {
  it('frozen rows are excluded from TTL expiry (TTL accounting pauses)', () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    store.enqueue(input({ messageId: 'a', nowIso: past }), BOUNDS);
    store.enqueue(input({ messageId: 'b', nowIso: past }), BOUNDS);
    store.freezeQueuedRows(isoNow());
    expect(store.listTtlExpired(isoNow(), 30 * 60_000)).toHaveLength(0);
    store.resumeFrozenRows(isoNow(), 14_400_000);
    expect(store.listTtlExpired(isoNow(), 30 * 60_000).length).toBeGreaterThanOrEqual(1);
  });

  it('durable counters increment and survive reopen', () => {
    store.incrementCounter('orderingViolations');
    store.incrementCounter('orderingViolations');
    store.incrementCounter('possiblyNotInjected');
    store.close();
    store = PendingInboundStore.open('echo', dir);
    expect(store.getCounter('orderingViolations')).toBe(2);
    expect(store.getCounter('possiblyNotInjected')).toBe(1);
    expect(store.getCounter('mirrorDrift')).toBe(0);
  });
});

function isoNow(): string {
  return new Date().toISOString();
}
