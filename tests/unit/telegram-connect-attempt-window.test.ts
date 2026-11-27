import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, telegramFetch } from '../../src/messaging/telegram-egress.js';
import { provedUnsentCode } from '../../src/messaging/telegram-origin/OriginTransportCancellation.js';

const server = net.createServer(socket => socket.destroy());
const listening = new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
afterAll(() => { server.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Both addresses are loopback. The first has a real IPv4 listener. The IPv6
 * fallback is blocked on Node versions that support outbound BlockList.
 * Older Node versions try the IPv6 loopback, where this fixture has no listener.
 * No attempt depends on an external IPv6 route.
 * Both immediates run in the same check phase: the connect starts in the first and the pause runs in
 * the second, so timers are due before the event loop next polls and could see the finished connect.
 * That is what a pause in the middle of a round trip does on a real network.
 */
function connectThroughPause(port: number, attemptTimeoutMs: number, pauseMs: number): Promise<{ ok: boolean; error?: unknown }> {
  const blockList = new net.BlockList();
  blockList.addAddress('::1', 'ipv6');
  return new Promise(resolve => {
    setImmediate(() => {
      const socket = net.connect({ host: 'dual.test', port, blockList, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: attemptTimeoutMs,
        lookup: (_host, _options, callback) => (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]) });
      socket.once('connect', () => { socket.destroy(); resolve({ ok: true }); });
      socket.once('error', error => resolve({ ok: false, error }));
    });
    setImmediate(() => { const until = Date.now() + pauseMs; while (Date.now() < until); });
  });
}

describe('Telegram connect attempt window', () => {
  it('reaches the network through a dedicated dispatcher and leaves the process default alone', async () => {
    const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
    const network = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', network);
    await telegramFetch('https://example.test/not-bot-api', { method: 'POST', body: '{}' });
    expect((network.mock.calls[0][1] as { dispatcher?: { dispatch?: unknown } }).dispatcher?.dispatch).toBeTypeOf('function');
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(before);
    expect(TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
  it('finishes the old-window failure with a local IPv6 fallback', async () => {
    const port = await listening;
    const old = await connectThroughPause(port, 250, 400);
    expect(old.ok).toBe(false);
    expect((old.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    const codes = (old.error as AggregateError).errors.map((error: NodeJS.ErrnoException) => error.code);
    expect(codes).toHaveLength(2);
    expect(codes[0]).toBe('ETIMEDOUT');
    expect(['ERR_IP_BLOCKED', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL']).toContain(codes[1]);
    expect(provedUnsentCode((old.error as AggregateError).errors[0])).toBe('ETIMEDOUT');
    expect(provedUnsentCode(old.error)).toBe(codes[1] === 'ERR_IP_BLOCKED' ? null : 'ETIMEDOUT');
  }, 30_000);
  it('requires connect-phase proof for every address in an aggregate', () => {
    const first = Object.assign(new Error('first connect timed out'), { code: 'ETIMEDOUT', syscall: 'connect' });
    const refused = Object.assign(new Error('fallback refused'), { code: 'ECONNREFUSED', syscall: 'connect' });
    const blocked = Object.assign(new Error('fallback blocked'), { code: 'ERR_IP_BLOCKED' });
    expect(provedUnsentCode(Object.assign(new AggregateError([first, refused]), { code: 'ETIMEDOUT' }))).toBe('ETIMEDOUT');
    expect(provedUnsentCode(Object.assign(new AggregateError([first, blocked]), { code: 'ETIMEDOUT' }))).toBeNull();
  });
  it('connects through the same pause with the production attempt window', async () => {
    const port = await listening;
    expect(await connectThroughPause(port, TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, 400)).toEqual({ ok: true });
  }, 30_000);
});
