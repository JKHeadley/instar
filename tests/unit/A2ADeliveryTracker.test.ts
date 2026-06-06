/**
 * Tier-1 tests for A2ADeliveryTracker — the "communications never just die out"
 * durable spine. Real SQLite (in-memory). Both sides of every boundary:
 * lifecycle transitions, idempotency, the stale/overdue gates, peer-health
 * composition, and the thread-fallback ack.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  A2ADeliveryTracker,
  DEFAULT_STALE_AFTER_MS,
} from '../../src/threadline/A2ADeliveryTracker.js';

let t: A2ADeliveryTracker;
afterEach(() => t?.close());

const FP = '8c7928aa9f04fbda947172a2f9b2d81a';

describe('A2ADeliveryTracker — outbound lifecycle', () => {
  it('records a sent message as awaiting-ack', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP, peerName: 'dawn', threadId: 'th1' });
    const e = t.get('m1');
    expect(e).not.toBeNull();
    expect(e!.state).toBe('awaiting-ack');
    expect(e!.peerFp).toBe(FP);
    expect(e!.attempts).toBe(1);
  });

  it('recordSent is idempotent on messageId (no double-insert, no resurrect)', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP });
    t.recordAck('m1');
    // A duplicate send of the same id must NOT flip an acked row back to awaiting.
    t.recordSent({ messageId: 'm1', peerFp: FP });
    expect(t.get('m1')!.state).toBe('acked');
    expect(t.pending(FP)).toHaveLength(0);
  });

  it('recordAck flips awaiting-ack → acked and is the delivered signal', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP });
    expect(t.recordAck('m1')).toBe(true);
    expect(t.get('m1')!.state).toBe('acked');
    expect(t.get('m1')!.ackedAt).not.toBeNull();
  });

  it('recordAck is idempotent and never downgrades', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP });
    expect(t.recordAck('m1')).toBe(true);
    expect(t.recordAck('m1')).toBe(false); // already acked → no change
  });

  it('recordAck on an unknown messageId is a no-op false', () => {
    t = A2ADeliveryTracker.openMemory();
    expect(t.recordAck('nope')).toBe(false);
  });

  it('recordAckByThread acks the oldest awaiting message on the thread', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP, threadId: 'th1', sentAt: '2026-06-06T10:00:00Z' });
    t.recordSent({ messageId: 'm2', peerFp: FP, threadId: 'th1', sentAt: '2026-06-06T11:00:00Z' });
    const acked = t.recordAckByThread('th1');
    expect(acked).toBe('m1'); // oldest first
    expect(t.get('m1')!.state).toBe('acked');
    expect(t.get('m2')!.state).toBe('awaiting-ack');
  });

  it('recordAckByThread returns null when nothing awaits on that thread', () => {
    t = A2ADeliveryTracker.openMemory();
    expect(t.recordAckByThread('ghost')).toBeNull();
  });

  // Regression for the production wiring bug cross-perspective review caught:
  // outbound is keyed by FINGERPRINT, but the inbound reply's sender identity is
  // a NAME on the local transport (and a fingerprint on the relay transport).
  // recordAckByThread must key on the THREAD alone so the ack fires regardless of
  // how the replying peer identified themselves.
  it('acks by thread even when the sender identity format differs from the send-time peerFp', () => {
    t = A2ADeliveryTracker.openMemory();
    // Sent keyed by the peer's full fingerprint…
    t.recordSent({ messageId: 'm1', peerFp: '8c7928aa9f04fbda947172a2f9b2d81a', threadId: 'th-xyz' });
    // …reply arrives identified by display NAME, but we ack purely by thread:
    const acked = t.recordAckByThread('th-xyz');
    expect(acked).toBe('m1');
    expect(t.get('m1')!.state).toBe('acked');
  });
});

describe('A2ADeliveryTracker — overdue / escalation work-list', () => {
  it('findOverdue returns only awaiting-ack rows past the TTL', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'old', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' });   // 12h old
    t.recordSent({ messageId: 'fresh', peerFp: FP, sentAt: '2026-06-06T11:59:00Z' });  // 1m old
    const overdue = t.findOverdue(6 * 60 * 60 * 1000, now); // 6h TTL
    expect(overdue.map((e) => e.messageId)).toEqual(['old']);
  });

  it('acked messages never appear as overdue', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'old', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' });
    t.recordAck('old');
    expect(t.findOverdue(6 * 60 * 60 * 1000, now)).toHaveLength(0);
  });

  it('markAttempt bumps attempts and pushes the overdue clock forward', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'm1', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' });
    t.markAttempt('m1', undefined, '2026-06-06T11:59:00Z'); // just retried
    expect(t.get('m1')!.attempts).toBe(2);
    // lastAttemptAt is now recent → no longer overdue against a 6h TTL.
    expect(t.findOverdue(6 * 60 * 60 * 1000, now)).toHaveLength(0);
  });

  it('markEscalated moves awaiting-ack → escalated and out of the overdue list', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'm1', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' });
    t.markEscalated('m1');
    expect(t.get('m1')!.state).toBe('escalated');
    expect(t.findOverdue(6 * 60 * 60 * 1000, now)).toHaveLength(0);
  });

  it('a late ack still rescues an escalated message', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP });
    t.markEscalated('m1');
    expect(t.recordAck('m1')).toBe(true);
    expect(t.get('m1')!.state).toBe('acked');
  });
});

describe('A2ADeliveryTracker — peer health (is the channel alive?)', () => {
  it('composes last-sent / last-acked / last-inbound / pending', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: FP, peerName: 'dawn', sentAt: '2026-06-06T10:00:00Z' });
    t.recordSent({ messageId: 'm2', peerFp: FP, sentAt: '2026-06-06T10:05:00Z' });
    t.recordAck('m1', '2026-06-06T10:01:00Z');
    t.recordInboundFrom(FP, 'dawn', '2026-06-06T10:02:00Z');

    const h = t.peerHealth(FP, { nowMs: Date.parse('2026-06-06T10:06:00Z') });
    expect(h.peerName).toBe('dawn');
    expect(h.lastSentAt).toBe('2026-06-06T10:05:00Z');
    expect(h.lastAckedAt).toBe('2026-06-06T10:01:00Z');
    expect(h.lastInboundAt).toBe('2026-06-06T10:02:00Z');
    expect(h.pendingCount).toBe(1); // m2 still awaiting
    expect(h.stale).toBe(false);
  });

  it('flags stale when the oldest pending message is older than staleAfterMs', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'm1', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' }); // 12h
    const h = t.peerHealth(FP, { nowMs: now }); // default 6h stale window
    expect(h.stale).toBe(true);
    expect(h.oldestPendingAgeMs).toBeGreaterThan(DEFAULT_STALE_AFTER_MS);
  });

  it('a fully-acked peer is never stale and reports zero pending', () => {
    t = A2ADeliveryTracker.openMemory();
    const now = Date.parse('2026-06-06T12:00:00Z');
    t.recordSent({ messageId: 'm1', peerFp: FP, sentAt: '2026-06-06T00:00:00Z' });
    t.recordAck('m1');
    const h = t.peerHealth(FP, { nowMs: now });
    expect(h.stale).toBe(false);
    expect(h.pendingCount).toBe(0);
    expect(h.oldestPendingAgeMs).toBeNull();
  });

  it('recordInboundFrom bumps the liveness clock and accept count', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordInboundFrom(FP, 'dawn', '2026-06-06T10:00:00Z');
    t.recordInboundFrom(FP, 'dawn', '2026-06-06T10:05:00Z');
    const h = t.peerHealth(FP, { nowMs: Date.parse('2026-06-06T10:06:00Z') });
    expect(h.lastInboundAt).toBe('2026-06-06T10:05:00Z');
  });

  it('allPeerHealth lists every peer seen on either inbound or outbound', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: 'm1', peerFp: 'fpA' });
    t.recordInboundFrom('fpB', 'b');
    const all = t.allPeerHealth();
    expect(all.map((h) => h.peerFp).sort()).toEqual(['fpA', 'fpB']);
  });

  it('peerHealth for an unknown peer is all-null and not stale', () => {
    t = A2ADeliveryTracker.openMemory();
    const h = t.peerHealth('unknown');
    expect(h.lastSentAt).toBeNull();
    expect(h.lastInboundAt).toBeNull();
    expect(h.pendingCount).toBe(0);
    expect(h.stale).toBe(false);
  });

  it('ignores empty messageId / peerFp defensively', () => {
    t = A2ADeliveryTracker.openMemory();
    t.recordSent({ messageId: '', peerFp: FP });
    t.recordSent({ messageId: 'm1', peerFp: '' });
    t.recordInboundFrom('', 'x');
    expect(t.allPeerHealth()).toHaveLength(0);
  });
});
