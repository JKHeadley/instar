import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { OriginEgressCapacity, ORIGIN_CAPACITY_WINDOW_MS } from '../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { originCapacityClient, listenOriginNotices } from '../../src/messaging/telegram-origin/OriginNoticeIpc.js';
import { TelegramOriginOutageNotifier } from '../../src/messaging/telegram-origin/TelegramOriginOutageNotifier.js';
import { temporaryState } from '../helpers/telegramOriginStore.js';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
describe('credential owner capacity over bounded notice IPC', () => {
  it('shares one cap across main-process IPC clients and local lifeline notice reservations', async () => {
    let now = 10_000, live = true;
    const owner = new OriginEgressCapacity({ ownerBootId: 'lifeline-boot', accountIds: () => ['123'], ownsLease: () => live, now: () => now });
    now += ORIGIN_CAPACITY_WINDOW_MS;
    const socketPath = path.join(temporaryState(), 'capacity.sock');
    const notifier = new TelegramOriginOutageNotifier({ ownerBootId: 'lifeline-boot', capacity: owner,
      getPolicy: () => null, onState: () => undefined, prepareFixedNotice: async () => { throw new Error('not used'); },
      reserveNotice: async () => { throw new Error('not used'); }, persistOutcome: async () => undefined,
      sendOnce: async () => { throw new Error('not used'); } });
    stops.push(await listenOriginNotices(socketPath, notifier, () => [], owner));
    const main = originCapacityClient(socketPath), second = originCapacityClient(socketPath);
    const grants = await Promise.all([...Array.from({ length: 9 }, (_, i) => (i % 2 ? main : second).reserve('123')), owner.reserve('123')]);
    expect(grants.filter(Boolean)).toHaveLength(10); expect(await main.reserve('123')).toBeNull();
    expect(await main.reserve('unregistered')).toBeNull();
    expect(await Promise.all(grants.map((grant, index) => index === 9 ? owner.consume(grant!) : main.consume(grant!))))
      .toEqual(Array(10).fill(true));
    expect(await second.consume(grants[0]!)).toBe(false);
    now += ORIGIN_CAPACITY_WINDOW_MS;
    const old = (await main.reserve('123'))!; live = false;
    expect(await second.consume(old)).toBe(false); expect(await main.reserve('123')).toBeNull();
  });
  it('never falls back to a process-local bucket when the owner socket disappears', async () => {
    const client = originCapacityClient(path.join(temporaryState(), 'missing.sock'));
    expect(await client.reserve('123')).toBeNull();
    expect(await client.consume({ ownerBootId: 'old', accountId: '123', nonce: 'old', expiresAt: Date.now() + 1000 })).toBe(false);
  });
});
