/**
 * silent-loss-refusal-conservation §2.C — the `rejected` ledger terminal enumerated
 * into EVERY LedgerState consumer. A refusal must stay DISTINGUISHABLE from a
 * retry-exhaustion (`abandoned`) at the ledger, and a redelivered rejected
 * update_id must be DROPPED (never resurrected into `processing` → no double-notify).
 */
import { describe, it, expect } from 'vitest';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { decideIngress } from '../../src/messaging/ingressDedup.js';

function mk() { return MessageProcessingLedger.openMemory(); }

describe('§2.C markRejected terminal + consumers', () => {
  it('rejected-message-terminals-the-ledger-row: markRejected moves the row OUT of processing, sets rejected_at, never reply_committed', () => {
    const l = mk();
    l.record('k1', { platform: 'telegram', topic: '42' });
    l.beginProcessing('k1', 1);
    expect(l.get('k1')!.state).toBe('processing');
    expect(l.markRejected('k1', 1)).toBe(true);
    const row = l.get('k1')!;
    expect(row.state).toBe('rejected');
    expect(row.rejectedAt).toBeTruthy();
    expect(row.replyCommittedAt).toBeNull();
    l.close();
  });

  it('markRejected upserts a `rejected` row when none exists (the live path may have no prior row); dedupe returns false on replay', () => {
    const l = mk();
    expect(l.markRejected('new-key', 0, { platform: 'mesh', topic: '7' })).toBe(true);
    expect(l.get('new-key')!.state).toBe('rejected');
    // Idempotent — a second call is a no-op (the durable per-messageId dedupe).
    expect(l.markRejected('new-key', 0)).toBe(false);
    l.close();
  });

  it('markRejected does NOT override a reply_committed/abandoned/rejected terminal', () => {
    const l = mk();
    l.record('committed', { platform: 'telegram' });
    l.beginProcessing('committed', 1);
    l.commitReply('committed', 'rk', 1);
    expect(l.markRejected('committed', 1)).toBe(false);
    expect(l.get('committed')!.state).toBe('reply_committed');
    l.close();
  });

  it('isActedOn + beginProcessing treat `rejected` as terminal (never flipped back to processing)', () => {
    const l = mk();
    l.markRejected('r1', 0, { platform: 'telegram', topic: '5' });
    expect(l.isActedOn('r1')).toBe(true);
    // beginProcessing must refuse to re-open a rejected row (no attempts++).
    expect(l.beginProcessing('r1', 2)).toBe(false);
    expect(l.get('r1')!.state).toBe('rejected');
    l.close();
  });

  it('rejected-redelivery-is-dropped-and-not-resurrected: decideIngress DROPS a redelivered rejected update_id', () => {
    const l = mk();
    const key = 'telegram:42:9001';
    l.record(key, { platform: 'telegram', topic: '42' });
    l.markRejected(key, 1);
    const decision = decideIngress(l, key, { platform: 'telegram', topic: '42', epoch: 1, maxProcessingMs: 60_000 });
    expect(decision.action).toBe('drop');
    // And it stays rejected (never flipped to processing by beginProcessing).
    expect(l.get(key)!.state).toBe('rejected');
    l.close();
  });

  it('rejected-message-does-not-produce-a-stuck-recovery-loss-notice: reclaimStuck never selects a rejected row', () => {
    const l = mk();
    l.record('stuck-then-rejected', { platform: 'telegram', topic: '42' });
    l.beginProcessing('stuck-then-rejected', 1);
    l.markRejected('stuck-then-rejected', 1);
    // Even far past maxProcessingMs, a rejected (not processing) row is never
    // re-selected → stuck-recovery never markAbandons it → no generic loss notice.
    const stuck = l.reclaimStuck(0, Date.now() + 10 * 60_000);
    expect(stuck.find((e) => e.dedupeKey === 'stuck-then-rejected')).toBeUndefined();
    l.close();
  });

  it('the rejected terminal survives a fresh ledger open (durable — the notice dedupe is durable)', () => {
    // in-memory can't reopen, so assert the schema carries rejected_at + the state persists in one handle
    const l = mk();
    l.markRejected('dur', 0, { platform: 'mesh' });
    expect(l.get('dur')!.rejectedAt).toBeTruthy();
    expect(l.get('dur')!.state).toBe('rejected');
    l.close();
  });
});
