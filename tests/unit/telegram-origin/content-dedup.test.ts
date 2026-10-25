import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import path from 'node:path';
import { OutboundContentDedup } from '../../../src/messaging/OutboundContentDedup.js';
import { SqliteOutboundDedupStore } from '../../../src/messaging/OutboundDedupStore.js';
import { originContentDedup } from '../../../src/messaging/telegram-origin/OriginContentDedup.js';
import type { TelegramOriginRecord } from '../../../src/messaging/telegram-origin/types.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../../src/monitoring/DegradationReporter.js';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-content-dedup:cleanup' }); });
const text = 'A complete conversational update that is long enough for exact content deduplication.';
describe('origin content reservation authority', () => {
  it('reports closed-database faults without exposing inputs or changing durable reservations and accepted fingerprints', () => {
    const root = temporaryState(); roots.push(root);
    const file = path.join(root, 'dedup.db'), now = Date.now();
    const store = new SqliteOutboundDedupStore(file);
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const held = { topicId: 'private-destination', fingerprint: 'private-content-fingerprint',
      operationId: 'private-operation', ownerToken: 'claim-1', now, expiresAt: now + 60_000, sentSince: now - 1000 };
    const accepted = { ...held, fingerprint: 'accepted-fingerprint', operationId: 'accepted-operation' };
    const db = (store as unknown as { db: Database }).db;
    let reopened: SqliteOutboundDedupStore | undefined;
    try {
      // Healthy misses, duplicate suppression and a wrong owner are ordinary
      // outcomes, not storage degradation. Successful completion is silent too.
      expect(store.hasOriginReservation(held.topicId, held.fingerprint, now)).toBe(false);
      expect(store.reserveOrigin(held)).toBe('reserved');
      expect(store.hasOriginReservation(held.topicId, held.fingerprint, now)).toBe(true);
      // Another operation's live reservation is in flight, not delivered.
      expect(store.reserveOrigin({ ...held, operationId: 'other-operation' })).toBe('pending');
      expect(store.completeOrigin({ ...held, operationId: 'other-operation' })).toBe(false);
      expect(store.reserveOrigin(accepted)).toBe('reserved');
      expect(store.completeOrigin(accepted)).toBe(true);
      expect(report).not.toHaveBeenCalled();

      db.close(); // Real better-sqlite3 prepare/transaction failures, not mocked methods.
      expect(store.hasOriginReservation(held.topicId, held.fingerprint, now)).toBeNull();
      expect(store.reserveOrigin(held)).toBe('unavailable');
      expect(store.completeOrigin(held)).toBe(false);
      expect(report).toHaveBeenCalledTimes(3);
      expect(report.mock.calls.map(([event]) => event.feature)).toEqual([
        'OutboundDedupStore.origin-reservation-read',
        'OutboundDedupStore.origin-reservation-write',
        'OutboundDedupStore.origin-reservation-completion',
      ]);
      const diagnostics = JSON.stringify(report.mock.calls);
      for (const privateValue of [root, held.topicId, held.fingerprint, held.operationId, 'not open']) {
        expect(diagnostics).not.toContain(privateValue);
      }

      reopened = new SqliteOutboundDedupStore(file);
      expect(reopened.hasOriginReservation(held.topicId, held.fingerprint, now)).toBe(true);
      expect(reopened.reserveOrigin({ ...held, operationId: 'other-operation' })).toBe('pending');
      expect(reopened.reserveOrigin({ ...accepted, operationId: 'other-operation' })).toBe('duplicate');
      expect(reopened.reserveOrigin(held)).toBe('reserved');
      expect(reopened.wasSentSince(accepted.topicId, accepted.fingerprint, now)).toBe(true);
      expect(reopened.wasSentSince(held.topicId, held.fingerprint, now)).toBe(false);
      expect(report).toHaveBeenCalledTimes(3);
    } finally {
      if (db.open) db.close();
      (reopened as unknown as { db?: Database } | undefined)?.db?.close();
    }
  });
  it('prunes obsolete accepted fingerprints during origin-only traffic and retains recent sends', () => {
    const store = new SqliteOutboundDedupStore(':memory:'), start = Date.now(), hour = 3_600_000;
    const accept = (fingerprint: string, now: number) => {
      expect(store.reserveOrigin({ topicId: 42, fingerprint, operationId: fingerprint, ownerToken: fingerprint, now, expiresAt: now + 60_000, sentSince: now - 1000 })).toBe('reserved');
      expect(store.completeOrigin({ topicId: 42, fingerprint, operationId: fingerprint, ownerToken: fingerprint, now, expiresAt: now + 60_000 })).toBe(true);
    };
    accept('obsolete', start);
    accept('recent', start + 23.5 * hour);
    expect(store.wasSentSince(42, 'obsolete', 0)).toBe(true);
    const now = start + 25 * hour;
    expect(store.completeOrigin({ topicId: 42, fingerprint: 'recent', operationId: 'counterfeit', now, expiresAt: now + 1000 })).toBe(false);
    expect(store.wasSentSince(42, 'obsolete', 0)).toBe(true);
    accept('current', now);
    expect(store.wasSentSince(42, 'obsolete', 0)).toBe(false);
    expect(store.wasSentSince(42, 'recent', start + 23.5 * hour)).toBe(true);
    expect(store.wasSentSince(42, 'current', now)).toBe(true);
  });
  it('survives process replacement and retains ambiguous operations beyond legacy reservation expiry', () => {
    const root = temporaryState(); roots.push(root);
    const file = path.join(root, 'dedup.db'); let now = Date.now();
    const make = () => new OutboundContentDedup({}, () => now, new SqliteOutboundDedupStore(file));
    const first = make(), deadline = now + 780_000;
    expect(first.reserveOrigin(42, text, 'original', 'claim-1', deadline)).toBe('reserved');
    first.releaseReservation(42, text); // A generic error cannot release origin-owned state.
    now += 4 * 60_000;
    const restarted = make();
    expect(restarted.tryReserve(42, text)).toBe(false);
    expect(restarted.reserveOrigin(42, text, 'duplicate', 'claim-2', deadline)).toBe('pending');
    expect(restarted.reserveOrigin(42, text, 'original', 'claim-3', deadline)).toBe('reserved');
    restarted.completeOrigin(42, text, 'not-the-owner');
    expect(restarted.reserveOrigin(42, text, 'duplicate', 'claim-2', deadline)).toBe('pending');
    restarted.completeOrigin(42, text, 'original');
    expect(make().isDuplicate(42, text)).toBe(true);
    expect(make().reserveOrigin(42, text, 'duplicate', 'claim-2', deadline)).toBe('duplicate');
    now += 15 * 60_000 + 1;
    expect(make().reserveOrigin(42, text, 'later-legitimate-repeat', 'claim-4', now + 1000)).toBe('reserved');
  });
  it('releases only its own unaccepted reservation and never un-suppresses an accepted send', () => {
    const store = new SqliteOutboundDedupStore(':memory:'), now = Date.now();
    const held = { topicId: 42, fingerprint: 'held', operationId: 'held-op', ownerToken: 'claim-1', now, expiresAt: now + 60_000, sentSince: now - 1000 };
    expect(store.reserveOrigin(held)).toBe('reserved');
    expect(store.releaseOrigin({ ...held, operationId: 'not-the-owner' })).toBe(false);
    expect(store.reserveOrigin({ ...held, operationId: 'fresh-op' })).toBe('pending');
    // A later claim of the same operation adopts ownership; the earlier
    // execution's release is then fenced out.
    expect(store.reserveOrigin({ ...held, ownerToken: 'claim-2' })).toBe('reserved');
    expect(store.releaseOrigin(held)).toBe(false);
    expect(store.reserveOrigin({ ...held, operationId: 'fresh-op' })).toBe('pending');
    expect(store.releaseOrigin({ ...held, ownerToken: 'claim-2' })).toBe(true);
    expect(store.reserveOrigin({ ...held, operationId: 'fresh-op' })).toBe('reserved');
    const accepted = { ...held, fingerprint: 'accepted', operationId: 'accepted-op' };
    expect(store.reserveOrigin(accepted)).toBe('reserved');
    expect(store.completeOrigin(accepted)).toBe(true);
    store.releaseOrigin(accepted);
    expect(store.reserveOrigin({ ...accepted, operationId: 'fresh-op' })).toBe('duplicate');
    // Ownership lives beside the reservation table, so a rolled-back build's
    // positional five-column insert still works on this file.
    const db = (store as unknown as { db: Database }).db;
    expect(() => db.prepare('INSERT INTO outbound_origin_reservations VALUES (?,?,?,?,?)').run(100, '42', 'older-build', 'older-op', now + 1000)).not.toThrow();
  });
  it('a released held operation retried after the window still finds a fresh send delivered since it was prepared', async () => {
    let now = Date.now();
    const dedup = new OutboundContentDedup({}, () => now, new SqliteOutboundDedupStore(':memory:'));
    const policy = originContentDedup(dedup, '-100123');
    const record = (operationId: string, createdAt: number): TelegramOriginRecord => ({ operationId, originId: operationId, createdAt,
      destination: { accountId: 'operator', chatId: 'channel:123', topicId: '42', messageId: null } } as TelegramOriginRecord);
    const held = record('held', now), deadline = now + 6 * 60 * 60_000;
    expect(await policy.reserveContent!(held, { text }, deadline, 'held-claim')).toEqual({ ok: true });
    await policy.releaseContent!(held, { text }, 'held-claim');
    now += 60_000;
    const fresh = record('fresh', now);
    expect(await policy.reserveContent!(fresh, { text }, deadline, 'fresh-claim')).toEqual({ ok: true });
    // While the fresh send is in flight the held retry is only held, never suppressed.
    expect(await policy.reserveContent!(held, { text }, deadline, 'held-claim-2')).toMatchObject({ ok: false, status: 409, reason: 'content-reservation-pending' });
    expect(await policy.reserveContent!(held, { text }, deadline, 'held-claim-2')).not.toHaveProperty('body.suppressedDuplicate');
    await policy.completeContent!(fresh, { text });
    now += 20 * 60_000; // Past the ordinary 15-minute window (the browser retry floor is 15 minutes).
    expect(await policy.reserveContent!(held, { text }, deadline, 'held-claim-3')).toMatchObject({ ok: false, reason: 'duplicate-content' });
    // A new operation prepared now is an ordinary repeat after the window.
    expect(await policy.reserveContent!(record('later', now), { text }, deadline, 'later-claim')).toEqual({ ok: true });
  });
  it('uses the reply authority for the configured forum and isolates other accounts, chats and edit targets', async () => {
    const dedup = new OutboundContentDedup({}, Date.now, new SqliteOutboundDedupStore(':memory:'));
    const policy = originContentDedup(dedup, '-100123'), deadline = Date.now() + 60_000;
    const record = (chatId: string, messageId: string | null = null): TelegramOriginRecord => ({ operationId: chatId + (messageId ?? ''), originId: 'origin',
      destination: { accountId: 'operator', chatId, topicId: '42', messageId } } as TelegramOriginRecord);
    dedup.record(42, text);
    expect(await policy.reserveContent!(record('channel:123'), { text }, deadline, 'claim')).toMatchObject({ ok: false, reason: 'duplicate-content' });
    expect(await policy.reserveContent!(record('channel:456'), { text }, deadline, 'claim')).toEqual({ ok: true });
    expect(await policy.reserveContent!(record('channel:123', '77'), { text }, deadline, 'claim')).toEqual({ ok: true });
    expect(await policy.reserveContent!(record('channel:123', '78'), { text }, deadline, 'claim')).toEqual({ ok: true });
  });
  it('fails closed on durable-store loss and live capacity, then reuses expired slots without evicting live owners', () => {
    expect(new OutboundContentDedup().reserveOrigin(42, text, 'owner', 'claim', Date.now() + 1000)).toBe('unavailable');
    const store = new SqliteOutboundDedupStore(':memory:'), now = Date.now();
    for (let i = 0; i < 4096; i++) expect(store.reserveOrigin({ topicId: 42, fingerprint: String(i), operationId: String(i), ownerToken: String(i), now, expiresAt: now + 1000, sentSince: now - 1000 })).toBe('reserved');
    expect(store.reserveOrigin({ topicId: 42, fingerprint: 'overflow', operationId: 'overflow', ownerToken: 'overflow', now, expiresAt: now + 1000, sentSince: now - 1000 })).toBe('unavailable');
    expect(store.reserveOrigin({ topicId: 42, fingerprint: 'new', operationId: 'new', ownerToken: 'new', now: now + 1001, expiresAt: now + 2000, sentSince: now })).toBe('reserved');
    expect(store.completeOrigin({ topicId: 42, fingerprint: '0', operationId: '0', now: now + 1002, expiresAt: now + 3000 })).toBe(false);
  });
});
