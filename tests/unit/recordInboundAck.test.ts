/**
 * Unit tests — recordInboundAck funnel (Robustness Phase 1, G3 / closes F4).
 *
 * The single helper every inbound-receive path calls. A reply on a thread is
 * proof the peer received our prior send, so it clears the matching awaiting-ack
 * entry. F4 was the verified relay inbound path not making this call.
 */

import { describe, it, expect } from 'vitest';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { recordInboundAck } from '../../src/threadline/recordInboundAck.js';

const PEER = '8c7928aa9f04fbda947172a2f9b2d81a';

describe('recordInboundAck', () => {
  it('clears the matching awaiting-ack entry by threadId (the F4 fix)', () => {
    const tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: PEER, threadId: 'thread-1' });
    expect(tracker.pending(PEER).length).toBe(1);

    recordInboundAck({ a2aDeliveryTracker: tracker }, { threadId: 'thread-1', senderFingerprint: PEER });

    expect(tracker.pending(PEER).length).toBe(0);
    tracker.close();
  });

  it('prefers the thread-owner fingerprint for liveness when threadResumeMap resolves it', () => {
    const tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: PEER, threadId: 'thread-1' });
    const threadResumeMap = { get: (id: string) => (id === 'thread-1' ? { remoteAgent: PEER } : null) };

    // The inbound `senderName` is a display NAME (the local-path asymmetry); the
    // owner fingerprint from the resume map is used for liveness instead.
    recordInboundAck({ a2aDeliveryTracker: tracker, threadResumeMap }, {
      threadId: 'thread-1', senderName: 'Dawn',
    });

    expect(tracker.pending(PEER).length).toBe(0);
    expect(tracker.peerHealth(PEER).lastInboundAt).toBeTruthy();
    tracker.close();
  });

  it('is a no-op (never throws) when no tracker is wired', () => {
    expect(() => recordInboundAck({}, { threadId: 'thread-1', senderFingerprint: PEER })).not.toThrow();
    expect(() => recordInboundAck({ a2aDeliveryTracker: null }, { threadId: 'x' })).not.toThrow();
  });

  it('is idempotent — a second inbound on the same thread does not error', () => {
    const tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: PEER, threadId: 'thread-1' });
    recordInboundAck({ a2aDeliveryTracker: tracker }, { threadId: 'thread-1', senderFingerprint: PEER });
    recordInboundAck({ a2aDeliveryTracker: tracker }, { threadId: 'thread-1', senderFingerprint: PEER });
    expect(tracker.pending(PEER).length).toBe(0);
    tracker.close();
  });
});
