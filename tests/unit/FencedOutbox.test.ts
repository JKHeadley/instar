/**
 * Tier-1 tests for FencedOutbox — structural no-duplicate-reply (§8 G3a).
 * Covers: normal send, already-replied suppression, fenced-no-lease, fenced
 * stale-epoch, and that a suppressed reply never invokes the platform send.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MessageProcessingLedger } from '../../src/messaging/MessageProcessingLedger.js';
import { FencedOutbox } from '../../src/messaging/FencedOutbox.js';

let ledger: MessageProcessingLedger;
afterEach(() => ledger?.close());

function setup(opts: { holdsLease?: boolean; epoch?: number } = {}) {
  ledger = MessageProcessingLedger.openMemory();
  const outbox = new FencedOutbox({
    ledger,
    currentEpoch: () => opts.epoch ?? 1,
    holdsLease: () => opts.holdsLease ?? true,
  });
  return { ledger, outbox };
}

describe('FencedOutbox', () => {
  it('sends when holding the lease at the stamped epoch, then commits the marker', async () => {
    const { ledger, outbox } = setup({ holdsLease: true, epoch: 1 });
    ledger.record('m1', { platform: 'telegram' });
    ledger.beginProcessing('m1', 1);
    const sendFn = vi.fn(async () => {});
    const r = await outbox.send('m1', 0, 1, sendFn);
    expect(r.sent).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(ledger.isActedOn('m1')).toBe(true);
  });

  it('suppresses a reply when already replied (idempotent, no platform send)', async () => {
    const { ledger, outbox } = setup({ holdsLease: true, epoch: 1 });
    ledger.record('m2', { platform: 'telegram' });
    ledger.beginProcessing('m2', 1);
    await outbox.send('m2', 0, 1, async () => {});
    // Second attempt (e.g. a replay) must not re-send.
    const sendFn = vi.fn(async () => {});
    const r = await outbox.send('m2', 0, 1, sendFn);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('already-replied');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('suppresses (fences) when this machine does not hold the lease', async () => {
    const { ledger, outbox } = setup({ holdsLease: false, epoch: 1 });
    ledger.record('m3', { platform: 'telegram' });
    const sendFn = vi.fn(async () => {});
    const r = await outbox.send('m3', 0, 1, sendFn);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('fenced-no-lease');
    expect(sendFn).not.toHaveBeenCalled();
    expect(ledger.isActedOn('m3')).toBe(false);
  });

  it('suppresses when the lease epoch has moved past the stamped epoch', async () => {
    // Turn began under epoch 1, but the lease has since advanced to epoch 2 —
    // this machine is a fenced old-awake; its late reply must be dropped.
    const { ledger, outbox } = setup({ holdsLease: true, epoch: 2 });
    ledger.record('m4', { platform: 'telegram' });
    ledger.beginProcessing('m4', 1);
    const sendFn = vi.fn(async () => {});
    const r = await outbox.send('m4', 0, 1, sendFn);
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('fenced-stale-epoch');
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('reports send-failed without committing the marker', async () => {
    const { ledger, outbox } = setup({ holdsLease: true, epoch: 1 });
    ledger.record('m5', { platform: 'telegram' });
    ledger.beginProcessing('m5', 1);
    const r = await outbox.send('m5', 0, 1, async () => { throw new Error('telegram 500'); });
    expect(r.sent).toBe(false);
    expect(r.reason).toBe('send-failed');
    expect(ledger.isActedOn('m5')).toBe(false); // not committed → safe to retry
  });
});
