/**
 * Two-phase admission (blocker hand-off spec §1): with a delivery-receipt store
 * injected, a true-blocker settle needs a persisted, delivered ask for the same
 * entry, delivered after the failed attempt. Without the store, the existing
 * caller-supplied reference path is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  BlockerLedger,
  type DeliveryReceipt,
  type SettleAuthority,
} from '../../src/monitoring/BlockerLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let seen: string[];
const allowAuthority: SettleAuthority = async ({ proposed }) => {
  seen.push(proposed.accessRequestRef);
  return { allow: true, reason: 'ok', decisionHash: 'hash-allow' };
};

const ATTEMPT_AT = '2026-11-27T14:00:00.000Z';
const AFTER = '2026-11-27T14:05:00.000Z';
const BEFORE = '2026-11-27T13:55:00.000Z';

function storeOf(receipts: DeliveryReceipt[]) {
  return { loadReceipt: (ref: string) => receipts.find(r => r.ref === ref) ?? null };
}

function makeLedger(receipts?: DeliveryReceipt[]) {
  return new BlockerLedger({
    stateDir: tmpDir,
    settleAuthority: allowAuthority,
    confinedPlaybookRoots: [path.join(tmpDir, 'playbooks')],
    ...(receipts ? { deliveryReceiptStore: storeOf(receipts) } : {}),
  });
}

function settleSecret(ledger: BlockerLedger, id: string, ref: string, at?: string) {
  return ledger.settle(id, {
    origin: 'handoff',
    kind: 'true-blocker',
    reasonKind: 'operator-only-secret',
    rebuttal: 'only the owner holds this code',
    failedAttempt: { type: 'self-fetch', detail: 'vault had no entry', at: ATTEMPT_AT },
    accessRequest: { messageRef: ref, ...(at ? { at } : {}) },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-receipt-'));
  seen = [];
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true,
    operation: 'tests/unit/BlockerLedgerDeliveryReceipt.test.ts:afterEach' });
});

describe('BlockerLedger — delivery receipt for the hand-off ask', () => {
  it('settles on a delivered receipt for the same entry, and takes the time from the receipt', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = makeLedger([{ ref: 'tg:131439:150300', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: AFTER }]);
    // The caller claims an earlier time; the receipt time wins, so this still settles.
    const settled = await settleSecret(ledger, id, 'tg:131439:150300', BEFORE);
    expect(settled.state).toBe('true-blocker');
    expect(settled.terminal).toMatchObject({ kind: 'true-blocker', accessRequestRef: 'tg:131439:150300',
      deliveryReceiptVerified: true });
    expect(seen).toEqual(['tg:131439:150300']);
  });

  it('refuses a reference with no persisted receipt, or one for another blocker', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const { id: other } = await probe.open({ detectedText: 'another ask', origin: 's' });
    const ledger = makeLedger([
      { ref: 'tg:other', blockerId: other, state: 'delivered', platform: 'telegram', deliveredAt: AFTER },
    ]);
    await expect(settleSecret(ledger, id, 'tg:never-sent')).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
    await expect(settleSecret(ledger, id, 'tg:other')).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
    expect(seen).toEqual([]); // the authority is never reached
  });

  it('refuses a receipt whose own reference differs from the one asked for', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = new BlockerLedger({
      stateDir: tmpDir, settleAuthority: allowAuthority,
      deliveryReceiptStore: { loadReceipt: () => ({ ref: 'tg:something-else', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: AFTER }) },
    });
    await expect(settleSecret(ledger, id, 'tg:asked')).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
  });

  it('refuses an ask that is only intended, unknown or failed, and one with no valid time', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = makeLedger([
      { ref: 'intent', blockerId: id, state: 'send-intent', platform: 'telegram' },
      { ref: 'unknown', blockerId: id, state: 'delivery-unknown', platform: 'telegram', deliveredAt: AFTER },
      { ref: 'failed', blockerId: id, state: 'failed', platform: 'telegram' },
      { ref: 'no-time', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: 'not a time' },
    ]);
    for (const ref of ['intent', 'unknown', 'failed', 'no-time']) {
      await expect(settleSecret(ledger, id, ref)).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
    }
    expect(ledger.get(id)?.state).toBe('candidate');
  });

  it('refuses an ask delivered before the failed attempt, even if the caller claims a later time', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = makeLedger([{ ref: 'early', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: BEFORE }]);
    await expect(settleSecret(ledger, id, 'early', AFTER)).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
  });

  it('without a receipt store, the caller-supplied reference still settles (dark default unchanged)', async () => {
    const ledger = makeLedger();
    const { id } = await ledger.open({ detectedText: 'need the code', origin: 's' });
    const settled = await settleSecret(ledger, id, 'relay-1', AFTER);
    expect(settled.state).toBe('true-blocker');
    expect(seen).toEqual(['relay-1']);
    // The legacy path never marks the terminal as receipt-verified.
    expect(settled.terminal && 'deliveryReceiptVerified' in settled.terminal).toBe(false);
  });

  it('names a failed attempt with no time instead of blaming the receipt', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = makeLedger([{ ref: 'ok', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: AFTER }]);
    const settle = ledger.settle(id, {
      origin: 'handoff', kind: 'true-blocker', reasonKind: 'operator-only-secret', rebuttal: 'only the owner',
      failedAttempt: { type: 'self-fetch', detail: 'vault had no entry' }, accessRequest: { messageRef: 'ok' },
    });
    await expect(settle).rejects.toMatchObject({ code: 'missing_delivery_receipt' });
    await expect(settle).rejects.toThrow(/failed attempt carries no time/);
  });

  it('fails closed when the receipt store itself throws', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const ledger = new BlockerLedger({ stateDir: tmpDir, settleAuthority: allowAuthority,
      deliveryReceiptStore: { loadReceipt: () => { throw new Error('outbox unreadable'); } } });
    await expect(settleSecret(ledger, id, 'any')).rejects.toThrow('outbox unreadable');
    expect(ledger.get(id)?.state).toBe('candidate');
    expect(seen).toEqual([]);
  });

  it('still counts a no-new-evidence re-settle before the receipt check', async () => {
    const probe = makeLedger();
    const { id } = await probe.open({ detectedText: 'need the code', origin: 's' });
    const receipts: DeliveryReceipt[] = [{ ref: 'first', blockerId: id, state: 'delivered', platform: 'telegram', deliveredAt: AFTER }];
    const ledger = makeLedger(receipts);
    await settleSecret(ledger, id, 'first');
    await ledger.reopenForRecheck(id);
    receipts.length = 0; // the old ask's receipt is gone; the re-stamp must still be counted
    await expect(settleSecret(ledger, id, 'first')).rejects.toMatchObject({ code: 'resettle_no_new_evidence' });
    expect(ledger.get(id)?.noEvidenceResettleAttempts).toBe(1);
  });
});
