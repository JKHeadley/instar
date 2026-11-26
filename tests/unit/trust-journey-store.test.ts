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


const pending = { ...req, recordKey: 'q0', cardMessageId: '', cardChatId: '', summary: ['Allow one exact change'] };
const deviceCarrier = { recordKey: 'tj:request-carrier:r1:device', recordType: 'request-carrier', at,
  requestId: req.requestId, principal: req.principal, proposalHash: req.proposalHash,
  expiresAt: req.expiresAt, adapter: 'device' };

/** The journal may replay the same independent records in any order. */
function permutations<T>(rows: T[]): T[][] {
  if (rows.length === 0) return [[]];
  return rows.flatMap((row, i) => permutations(rows.filter((_, j) => i !== j)).map((rest) => [row, ...rest]));
}

describe('TrustJourneyStore device request carrier', () => {
  it('exposes the same immutable request with a device carrier in either replay order', () => {
    for (const order of permutations([pending, deviceCarrier])) {
      const s = new TrustJourneyStore(fixed(order));
      const expected = { ...pending, adapter: 'device' };
      expect(s.request('r1')).toEqual(expected);
      expect(s.openRequests()).toEqual([expected]);
      expect(s.allRequests()).toEqual([expected]);
      expect(s.requestByCode(req.code)).toEqual(expected);
      expect(s.requestByCard('telegram', '50')).toBeNull();
    }
  });

  it('retains an orphan marker without publishing a request, then matches a later base', () => {
    const s = new TrustJourneyStore(fixed([deviceCarrier]));
    expect(s.request('r1')).toBeNull();
    expect(s.openRequests()).toEqual([]);
    expect(s.allRequests()).toEqual([]);
    expect(s.codeTaken(req.code)).toBe(false);
    s.applyCommitted([{ recordKey: pending.recordKey, data: pending }]);
    expect(s.request('r1')).toEqual({ ...pending, adapter: 'device' });
  });

  it.each([
    ['request id', { requestId: 'another-request' }],
    ['principal', { principal: 'another-person' }],
    ['proposal hash', { proposalHash: 'another-change' }],
    ['expiry', { expiresAt: '2099-02-01T00:00:00Z' }],
    ['carrier', { adapter: 'telegram' }],
    ['unknown field', { extraAuthority: true }],
    ['newer reader', { minReader: 9 }],
  ])('ignores a marker with a mismatching %s in either replay order', (_name, changed) => {
    for (const order of permutations([pending, { ...deviceCarrier, ...changed }])) {
      const s = new TrustJourneyStore(fixed(order));
      expect(s.request('r1')).toEqual(pending);
    }
  });

  it('a mismatched marker cannot shadow a matching marker in either replay order', () => {
    const mismatch = { ...deviceCarrier, recordKey: 'wrong-marker', proposalHash: 'wrong-hash' };
    for (const order of permutations([pending, mismatch, deviceCarrier])) {
      expect(new TrustJourneyStore(fixed(order)).request('r1')).toEqual({ ...pending, adapter: 'device' });
    }
  });

  it('confirmed chat delivery wins in every replay order and retains the raw receipt binding', () => {
    for (const order of permutations([pending, deviceCarrier, req])) {
      const s = new TrustJourneyStore(fixed(order));
      // The first request fixes its contents; a later delivery adds only the receipt binding.
      const first = order.find(r => r.recordType === 'request')!;
      const confirmed = { ...first, cardMessageId: req.cardMessageId, cardChatId: req.cardChatId };
      expect(s.request('r1')).toEqual(confirmed);
      expect(s.requestByCard('telegram', '50')).toEqual(confirmed);
      expect(s.requestByCard('slack', '50')).toBeNull();
    }
  });

  it.each(['withdrawn', 'expired', 'declined'])('migration cannot reopen a %s request', (status) => {
    const ended = { recordKey: `ended-${status}`, recordType: 'request-status', at, requestId: req.requestId, status };
    for (const order of permutations([pending, deviceCarrier, ended])) {
      const s = new TrustJourneyStore(fixed(order));
      expect(s.request('r1')).toEqual({ ...pending, adapter: 'device', status });
      expect(s.openRequests()).toEqual([]);
    }
  });

  it('migration never resets consumed state in any replay order', () => {
    for (const order of permutations([pending, deviceCarrier, cons])) {
      const s = new TrustJourneyStore(fixed(order));
      expect(s.request('r1')).toEqual({ ...pending, adapter: 'device', status: 'consumed' });
      expect(s.openRequests()).toEqual([]);
      expect(s.requestConsumedOrPending('r1')).toBe(true);
    }
  });

  it('does not expose a carrier until its write is durable, and reserves its immutable key', async () => {
    let finish!: (ok: boolean) => void;
    const s = new TrustJourneyStore({ ...fixed([pending]), append: () => new Promise<boolean>((resolve) => { finish = resolve; }) });
    const write = s.write('request-carrier', deviceCarrier, deviceCarrier.recordKey);
    expect(s.request('r1')).toEqual(pending);
    expect((await s.write('request-carrier', deviceCarrier, deviceCarrier.recordKey)).ok).toBe(false);
    finish(true);
    expect((await write).ok).toBe(true);
    expect(s.request('r1')?.adapter).toBe('device');
  });

  it('a failed durable write leaves the original pending chat carrier untouched', async () => {
    const s = new TrustJourneyStore({ ...fixed([pending]), append: async () => false });
    expect((await s.write('request-carrier', deviceCarrier, deviceCarrier.recordKey)).ok).toBe(false);
    expect(s.request('r1')).toEqual(pending);
  });

  it('reopens a durable carrier without rewriting the original request or extending expiry', async () => {
    const file = path.join(dir, 'carrier.jsonl');
    const s = new TrustJourneyStore(new LocalFileTrustSink(file));
    expect((await s.write('request', pending, pending.recordKey)).ok).toBe(true);
    expect((await s.write('request-carrier', deviceCarrier, deviceCarrier.recordKey)).ok).toBe(true);
    const reopened = new TrustJourneyStore(new LocalFileTrustSink(file));
    expect(reopened.request('r1')).toMatchObject({ requestId: pending.requestId, adapter: 'device',
      proposalHash: pending.proposalHash, principal: pending.principal, change: pending.change, expiresAt: pending.expiresAt });
    expect((await reopened.write('request-carrier', deviceCarrier, deviceCarrier.recordKey)).ok).toBe(false);
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].adapter).toBe('telegram');
    expect(records[0].expiresAt).toBe(pending.expiresAt);
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
