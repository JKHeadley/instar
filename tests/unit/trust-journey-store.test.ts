/**
 * Trust-journey store: immutable records, order-independent used state, and the reader rule's
 * "restricting records are never dropped".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFileTrustSink, TrustJourneyStore, type TrustRecord } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { summarizeChange } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-store-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-store.test.ts' }); });

/** A sink that hands records back in a given order. */
const fixed = (records: Array<Record<string, unknown>>) => ({ description: 'fixed', append: async () => true, loadAll: () => records as TrustRecord[] });
const at = '2026-11-16T08:00:00Z';
const req = { recordKey: 'q1', recordType: 'request', at, requestId: 'r1', code: 'AB12CD', proposalHash: 'h', principal: 'owner', adapter: 'telegram', approverPlatformId: '1', cardMessageId: '50', cardChatId: '1', expiresAt: '2099-01-01T00:00:00Z', status: 'open', change: { kind: 'trust-grant' }, summary: [] };
const rcpt = { recordKey: 'k1', recordType: 'receipt', at, receiptId: 'rc1', uniqueKey: 'tg-update:1', adapter: 'telegram', senderId: '1', chatId: '1', chatType: 'private', messageId: '51', text: 'approve AB12CD' };
const cons = { recordKey: 'c1', recordType: 'consumption', at, consumptionId: 'c:rc1', requestId: 'r1', receiptId: 'rc1', acceptanceId: 'a', proposalHash: 'h', principal: 'owner' };

describe('TrustJourneyStore', () => {
  it('a second write to an existing key fails instead of reporting success', async () => {
    const s = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'f.jsonl')));
    expect((await s.write('change', { key: 'x', to: 'log' }, 'same')).ok).toBe(true);
    expect((await s.write('change', { key: 'x', to: 'autonomous' }, 'same')).ok).toBe(false);
  });

  it('used state does not depend on load order', () => {
    for (const order of [[req, rcpt, cons], [cons, rcpt, req], [cons, req, rcpt], [rcpt, cons, req]]) {
      const s = new TrustJourneyStore(fixed(order));
      expect(s.request('r1')!.status).toBe('consumed');
      expect(s.receiptConsumed('tg-update:1')).toBe(true);
      expect(s.openRequests()).toHaveLength(0);
    }
  });

  it('the card record wins over the first write in any order', () => {
    const first = { ...req, recordKey: 'q0', cardMessageId: '' };
    for (const order of [[first, req], [req, first]]) expect(new TrustJourneyStore(fixed(order)).request('r1')!.cardMessageId).toBe('50');
  });

  it('an unreadable restricting record still restricts', () => {
    const acc = { recordKey: 'a1', recordType: 'acceptance', at, acceptanceId: 'acc1', principal: 'owner', adapter: 'telegram', accountId: '1', acceptedAt: at };
    const wd = { recordKey: 'w1', recordType: 'acceptance-withdrawn', at, acceptanceId: 'acc1', minReader: 9 };
    const cons2 = { ...cons, recordKey: 'c2', minReader: 9 };
    const s = new TrustJourneyStore(fixed([acc, wd, req, rcpt, cons2]));
    expect(s.acceptance('owner', 'telegram')).toBeNull();
    expect(s.request('r1')!.status).toBe('consumed');
    expect(s.unreadable).toBe(2);
  });
});

describe('the card text', () => {
  it('leads with every computed widening and shows the whole settings change', () => {
    const patch = { externalOperations: { sentinel: { enabled: true, note: 'x'.repeat(400) }, enabled: false } };
    const lines = summarizeChange({ kind: 'config-patch', patch }, ['turning off the external-operation gate']);
    expect(lines[0]).toBe('This would widen: turning off the external-operation gate');
    expect(lines.join('\n')).toContain('"enabled":false');
  });
  it('quotes agent-supplied names', () => {
    expect(summarizeChange({ kind: 'trust-grant', service: 'calendar', operation: 'write', level: 'log' })[0]).toContain('"calendar"');
  });
});
