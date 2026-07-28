/**
 * Fault-injection (spec §10) — exactly-once EFFECT across simulated crashes and
 * failovers, composing the real MessageProcessingLedger + FencedOutbox + a lease
 * epoch. Asserts the headline acceptance criteria (no lost message, no duplicate
 * reply) hold at the boundaries the feature exists to survive:
 *   - crash after channel-ack before reply (replay → exactly-once)
 *   - crash mid-processing (old holder fenced; new holder re-runs once)
 *   - duplicate provider delivery (recognized + dropped)
 *   - a fenced old-awake's late reply suppressed at the send path
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { FencedOutbox } from '../../src/messaging/FencedOutbox.js';

let ledger: MessageProcessingLedger;
afterEach(() => ledger?.close());

/** A controllable lease view shared by an outbox. */
function leaseView(initial: { holds: boolean; epoch: number }) {
  const state = { ...initial };
  return {
    state,
    holdsLease: () => state.holds,
    currentEpoch: () => state.epoch,
  };
}

describe('seamlessness fault-injection — exactly-once effect', () => {
  it('crash AFTER reply-commit, then a redelivery: never replies twice', async () => {
    ledger = MessageProcessingLedger.openMemory();
    const lv = leaseView({ holds: true, epoch: 1 });
    const outbox = new FencedOutbox({ ledger, currentEpoch: lv.currentEpoch, holdsLease: lv.holdsLease });
    const send = vi.fn(async () => {});

    // Turn 1: process + reply.
    ledger.record('u1', { platform: 'telegram' });
    ledger.beginProcessing('u1', 1);
    expect((await outbox.send('u1', 0, 1, send)).sent).toBe(true);

    // CRASH before cursor_advanced (reply committed, cursor not advanced).
    // The channel redelivers u1 on restart.
    const redeliver = ledger.record('u1', { platform: 'telegram' });
    expect(redeliver.firstSeen).toBe(false);
    expect(ledger.isActedOn('u1')).toBe(true);
    const second = await outbox.send('u1', 0, 1, send);
    expect(second.sent).toBe(false); // recognized, dropped
    expect(send).toHaveBeenCalledTimes(1); // exactly once
  });

  it('crash MID-processing: old holder fenced, new holder re-runs exactly once', async () => {
    ledger = MessageProcessingLedger.openMemory();
    // Old holder begins processing under epoch 1, then dies (no reply).
    ledger.record('u2', { platform: 'telegram', input: '{"text":"do the thing"}' });
    ledger.beginProcessing('u2', 1);

    // Lease moves to a new holder at epoch 2 (failover). The stuck entry is
    // reclaimable past maxProcessingMs.
    const started = Date.parse(ledger.get('u2')!.processingStartedAt!);
    const stuck = ledger.reclaimStuck(60_000, started + 61_000);
    expect(stuck.map((e) => e.dedupeKey)).toContain('u2');
    expect(stuck[0].inputSnapshot).toBe('{"text":"do the thing"}'); // re-run from stored input

    // New holder re-claims + replies under epoch 2.
    const lv = leaseView({ holds: true, epoch: 2 });
    const outbox = new FencedOutbox({ ledger, currentEpoch: lv.currentEpoch, holdsLease: lv.holdsLease });
    expect(ledger.beginProcessing('u2', 2)).toBe(true);
    const send = vi.fn(async () => {});
    expect((await outbox.send('u2', 0, 2, send)).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    // The OLD holder (epoch 1) wakes up wedged and tries to send its abandoned
    // reply — it is fenced (stale epoch) and suppressed.
    const oldView = leaseView({ holds: true, epoch: 2 }); // current epoch is 2
    const oldOutbox = new FencedOutbox({ ledger, currentEpoch: oldView.currentEpoch, holdsLease: oldView.holdsLease });
    const oldSend = vi.fn(async () => {});
    const oldResult = await oldOutbox.send('u2', 0, 1, oldSend); // stamped under stale epoch 1
    expect(oldResult.sent).toBe(false);
    expect(oldResult.reason).toBe('already-replied'); // new holder already committed
    expect(oldSend).not.toHaveBeenCalled();
  });

  it('duplicate provider delivery during a transfer window is dropped', async () => {
    ledger = MessageProcessingLedger.openMemory();
    const r1 = ledger.record('u3', { platform: 'telegram' });
    const r2 = ledger.record('u3', { platform: 'telegram' }); // overlap redelivery
    expect(r1.firstSeen).toBe(true);
    expect(r2.firstSeen).toBe(false);
  });

  it('a partitioned old-awake (no lease) cannot send at all', async () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('u4', { platform: 'telegram' });
    ledger.beginProcessing('u4', 1);
    const lv = leaseView({ holds: false, epoch: 1 }); // lost the lease
    const outbox = new FencedOutbox({ ledger, currentEpoch: lv.currentEpoch, holdsLease: lv.holdsLease });
    const send = vi.fn(async () => {});
    const r = await outbox.send('u4', 0, 1, send);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('fenced-no-lease');
    expect(send).not.toHaveBeenCalled();
  });

  it('dual-medium remote marker (from the other machine) prevents a re-send after failover', async () => {
    ledger = MessageProcessingLedger.openMemory();
    ledger.record('u5', { platform: 'telegram' });
    // The other machine replied + propagated the marker over the surviving medium.
    ledger.applyRemoteReplyMarker('u5', { platform: 'telegram', replyIdempotencyKey: 'k', epoch: 2 });
    const lv = leaseView({ holds: true, epoch: 2 });
    const outbox = new FencedOutbox({ ledger, currentEpoch: lv.currentEpoch, holdsLease: lv.holdsLease });
    const send = vi.fn(async () => {});
    const r = await outbox.send('u5', 0, 2, send);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('already-replied');
    expect(send).not.toHaveBeenCalled();
  });
});
