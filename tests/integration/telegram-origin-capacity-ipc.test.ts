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

import net from 'node:net';
async function replyServer(reply: (request: Record<string, unknown>, socket: net.Socket) => void) {
  const socketPath = path.join(temporaryState(), 'reply.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket));
    socket.once('data', bytes => reply(JSON.parse(bytes.toString()), socket));
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  stops.push(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return socketPath;
}
const fixtureGrant = () => ({ accountId: '123', ownerBootId: 'owner', nonce: 'one', expiresAt: Date.now() + 250 });
describe('mixed-version explanations never add a capacity mutation', () => {
  it('accepts a legacy owner and records known refusals without inventing their cause', async () => {
    const ops: unknown[] = [];
    const socket = await replyServer((r, s) => { ops.push(r.op); s.end(JSON.stringify(r.op === 'capacity-reserve' ? { grant: null } : { consumed: false }) + '\n'); });
    const client = originCapacityClient(socket);
    expect(await client.reserveExplained!('123')).toMatchObject({ grant: null, refusal: { cause: 'legacy-unexplained' }, explanation: 'legacy-unexplained' });
    expect(await client.consumeExplained!(fixtureGrant())).toMatchObject({ consumed: false, refusal: { cause: 'legacy-unexplained' } });
    expect(ops).toEqual(['capacity-reserve', 'capacity-consume']);
  });
  it('retains valid decisions with malformed or phase-impossible optional explanations', async () => {
    let calls = 0;
    const socket = await replyServer((_r, s) => { calls++; s.end(JSON.stringify({ consumed: calls === 1, refusal: { cause: 'rate-window-full', leaseFreshness: null } }) + '\n'); });
    const client = originCapacityClient(socket);
    expect(await client.consumeExplained!(fixtureGrant())).toMatchObject({ consumed: true, refusal: null, explanation: 'invalid' });
    expect(await client.consumeExplained!(fixtureGrant())).toMatchObject({ consumed: false, refusal: { cause: 'legacy-unexplained' }, explanation: 'invalid' });
    expect(calls).toBe(2);
  });
  it('keeps an owner-consumed lost reply unknown and never retries that mutation', async () => {
    let consumed = 0;
    const socket = await replyServer((_r, _s) => { consumed++; });
    expect(await originCapacityClient(socket).consumeExplained!(fixtureGrant()))
      .toMatchObject({ consumed: false, refusal: { cause: 'ipc-timeout' } });
    expect(consumed).toBe(1);
  });
  it('retains fallback lease refusal with no freshness snapshot over actual owner IPC', async () => {
    let now = 10000;
    const owner = new OriginEgressCapacity({ ownerBootId: 'owner', accountIds: () => ['123'], ownsLease: () => false, now: () => now });
    now += ORIGIN_CAPACITY_WINDOW_MS;
    const socket = path.join(temporaryState(), 'lease.sock');
    stops.push(await listenOriginNotices(socket, {} as TelegramOriginOutageNotifier, () => [], owner));
    expect(await originCapacityClient(socket).reserveExplained!('123')).toMatchObject({ grant: null, refusal: { cause: 'lease-not-held', leaseFreshness: null } });
  });
});

it.each(['wrong-owner', 'grant-expired', 'ipc-timeout'] as const)('does not treat impossible reserve metadata %s as an owner cause', async cause => {
  const socket = await replyServer((_r, s) => s.end(JSON.stringify({ grant: null, refusal: { cause, leaseFreshness: null } }) + '\n'));
  expect(await originCapacityClient(socket).reserveExplained!('123')).toMatchObject({ grant: null, refusal: { cause: 'legacy-unexplained' }, explanation: 'invalid' });
});

it('keeps valid positive grant and consume decisions from a legacy owner', async () => {
  const ops: unknown[] = [];
  const socket = await replyServer((r, s) => { ops.push(r.op); s.end(JSON.stringify(r.op === 'capacity-reserve' ? { grant: fixtureGrant() } : { consumed: true }) + '\n'); });
  const client = originCapacityClient(socket), decision = await client.reserveExplained!('123');
  expect(decision.grant).not.toBeNull(); expect(decision.explanation).toBe('legacy-unexplained');
  expect(await client.consumeExplained!(decision.grant!)).toMatchObject({ consumed: true, refusal: null, explanation: 'legacy-unexplained' });
  expect(ops).toEqual(['capacity-reserve', 'capacity-consume']);
});
it('lets a legacy-shaped client consume an upgraded owner grant exactly once', async () => {
  let now = 10000;
  const owner = new OriginEgressCapacity({ ownerBootId: 'owner', accountIds: () => ['123'], ownsLease: () => true, now: () => now });
  now += ORIGIN_CAPACITY_WINDOW_MS;
  const socket = path.join(temporaryState(), 'upgraded.sock');
  stops.push(await listenOriginNotices(socket, {} as TelegramOriginOutageNotifier, () => [], owner));
  const legacyCall = (input: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const s = net.createConnection(socket); let body = '';
    s.once('error', reject); s.once('connect', () => s.write(JSON.stringify(input) + '\n'));
    s.on('data', chunk => { body += chunk.toString(); }); s.once('end', () => { s.destroy(); resolve(JSON.parse(body)); });
  });
  const grant = (await legacyCall({ op: 'capacity-reserve', accountId: '123' })).grant;
  expect(grant).toBeTruthy();
  expect((await legacyCall({ op: 'capacity-consume', grant })).consumed).toBe(true);
  expect((await legacyCall({ op: 'capacity-consume', grant })).consumed).toBe(false);
});
