/**
 * Tier-1 tests for A2ARedeliverySentinel — the active-recovery layer
 * (A2A-DURABLE-DELIVERY-SPEC.md §4). Real in-memory A2ADeliveryTracker + injected
 * redeliver/raiseAttention spies. Both sides of every boundary: disabled no-op,
 * redelivery under the attempt cap, escalate-once at the cap, per-peer aggregation
 * (P17), the per-tick redelivery cap, swallowed transport errors, and escalate-only
 * mode.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { A2ADeliveryTracker } from '../../src/threadline/A2ADeliveryTracker.js';
import { A2ARedeliverySentinel } from '../../src/monitoring/A2ARedeliverySentinel.js';

let tracker: A2ADeliveryTracker;
afterEach(() => tracker?.close());

const FP = '8c7928aa9f04fbda947172a2f9b2d81a';
const OLD = '2026-06-06T00:00:00Z';        // 12h before NOW
const NOW = Date.parse('2026-06-06T12:00:00Z');
const cfg = { enabled: true, ttlMs: 6 * 60 * 60 * 1000, maxAttempts: 3, backoffBaseMs: 60_000, maxRedrivesPerTick: 10, sweepIntervalMs: 60_000 };

describe('A2ARedeliverySentinel', () => {
  it('disabled → no-op (no redeliver, no escalation)', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: FP, sentAt: OLD });
    let redeliverCalls = 0;
    const s = new A2ARedeliverySentinel({ tracker, redeliver: () => { redeliverCalls++; return true; }, now: () => NOW }, { ...cfg, enabled: false });
    const r = await s.tick();
    expect(r.disabled).toBe(true);
    expect(redeliverCalls).toBe(0);
    expect(tracker.get('m1')!.state).toBe('awaiting-ack');
  });

  it('redelivers an overdue message under the attempt cap + bumps attempts/backoff', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: FP, threadId: 't1', sentAt: OLD }); // attempts=1
    const seen: string[] = [];
    const s = new A2ARedeliverySentinel({ tracker, redeliver: (e) => { seen.push(e.messageId); return true; }, now: () => NOW }, cfg);
    const r = await s.tick();
    expect(seen).toEqual(['m1']);
    expect(r.redelivered).toBe(1);
    expect(r.escalated).toBe(0);
    const e = tracker.get('m1')!;
    expect(e.attempts).toBe(2);            // 1 → 2
    expect(e.state).toBe('awaiting-ack');  // still awaiting (an accepted send isn't an ack)
    expect(e.nextRetryAt).not.toBeNull();
  });

  it('escalates at the attempt cap and raises ONE aggregated attention item per peer', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    // Two messages to the same peer, both already at maxAttempts (3).
    for (const id of ['m1', 'm2']) {
      tracker.recordSent({ messageId: id, peerFp: FP, peerName: 'dawn', threadId: 't-' + id, sentAt: OLD });
      tracker.markAttempt(id, undefined, OLD); // →2
      tracker.markAttempt(id, undefined, OLD); // →3 (== maxAttempts)
    }
    const attentions: Array<{ title: string; source?: string }> = [];
    const s = new A2ARedeliverySentinel({ tracker, raiseAttention: (i) => { attentions.push(i); }, now: () => NOW }, cfg);
    const r = await s.tick();
    expect(r.escalated).toBe(2);
    expect(r.escalatedPeers).toEqual([FP]);
    expect(attentions).toHaveLength(1);                     // ONE item, not two
    expect(attentions[0].title).toContain('dawn');
    expect(attentions[0].source).toBe(`a2a-redelivery:${FP}`);
    expect(tracker.get('m1')!.state).toBe('escalated');
    expect(tracker.get('m2')!.state).toBe('escalated');
  });

  it('escalate-once: an escalated message is not re-escalated on the next sweep', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: FP, sentAt: OLD });
    tracker.markAttempt('m1', undefined, OLD); tracker.markAttempt('m1', undefined, OLD); // →3
    let raises = 0;
    const s = new A2ARedeliverySentinel({ tracker, raiseAttention: () => { raises++; }, now: () => NOW }, cfg);
    await s.tick();
    const second = await s.tick(); // m1 is now 'escalated' → not in findOverdue
    expect(raises).toBe(1);
    expect(second.escalated).toBe(0);
  });

  it('honors maxRedrivesPerTick', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    for (let i = 0; i < 5; i++) tracker.recordSent({ messageId: 'm' + i, peerFp: FP, sentAt: OLD });
    let calls = 0;
    const s = new A2ARedeliverySentinel({ tracker, redeliver: () => { calls++; return true; }, now: () => NOW }, { ...cfg, maxRedrivesPerTick: 2 });
    const r = await s.tick();
    expect(r.redelivered).toBe(2);
    expect(calls).toBe(2);
  });

  it('a redelivery transport error is swallowed; the message stays awaiting-ack and the attempt is counted', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'm1', peerFp: FP, sentAt: OLD });
    const s = new A2ARedeliverySentinel({ tracker, redeliver: () => { throw new Error('relay down'); }, now: () => NOW }, cfg);
    const r = await s.tick();
    expect(r.redelivered).toBe(0);                  // not "accepted"
    expect(tracker.get('m1')!.state).toBe('awaiting-ack');
    expect(tracker.get('m1')!.attempts).toBe(2);    // attempt still counted toward escalation
  });

  it('escalate-only mode (no redeliver dep): overdue-but-under-cap is left for next sweep, capped ones escalate', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'under', peerFp: FP, sentAt: OLD }); // attempts=1 < 3
    tracker.recordSent({ messageId: 'capped', peerFp: FP, peerName: 'dawn', sentAt: OLD });
    tracker.markAttempt('capped', undefined, OLD); tracker.markAttempt('capped', undefined, OLD); // →3
    const attentions: unknown[] = [];
    const s = new A2ARedeliverySentinel({ tracker, raiseAttention: (i) => { attentions.push(i); }, now: () => NOW }, cfg);
    const r = await s.tick();
    expect(r.escalated).toBe(1);
    expect(attentions).toHaveLength(1);
    expect(tracker.get('capped')!.state).toBe('escalated');
    // 'under' had no redeliver fn, but its attempt clock still advances toward escalation.
    expect(tracker.get('under')!.attempts).toBe(2);
    expect(tracker.get('under')!.state).toBe('awaiting-ack');
  });

  it('nothing overdue → empty sweep', async () => {
    tracker = A2ADeliveryTracker.openMemory();
    tracker.recordSent({ messageId: 'fresh', peerFp: FP, sentAt: '2026-06-06T11:59:00Z' }); // 1m old
    const s = new A2ARedeliverySentinel({ tracker, now: () => NOW }, cfg);
    const r = await s.tick();
    expect(r.overdue).toBe(0);
    expect(r.redelivered).toBe(0);
    expect(r.escalated).toBe(0);
  });
});
