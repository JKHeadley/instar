import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, telegramFetch } from '../../src/messaging/telegram-egress.js';
import { provedUnsentCode } from '../../src/messaging/telegram-origin/OriginTransportCancellation.js';

const server = net.createServer(socket => socket.destroy());
const listening = new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
afterAll(() => { server.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * A host with two addresses, the second one unroutable, as the Bot API host is on the Studio.
 * Both immediates run in the same check phase: the connect starts in the first and the pause runs in
 * the second, so timers are due before the event loop next polls and could see the finished connect.
 * That is what a pause in the middle of a round trip does on a real network.
 */
function connectThroughPause(port: number, attemptTimeoutMs: number, pauseMs: number): Promise<{ ok: boolean; error?: unknown }> {
  return new Promise(resolve => {
    setImmediate(() => {
      const socket = net.connect({ host: 'dual.test', port, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: attemptTimeoutMs,
        lookup: (_host, _options, callback) => (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
          { address: '127.0.0.1', family: 4 }, { address: '100::1', family: 6 }]) });
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
  it('turns an event-loop pause into a false connect timeout at the old value, and not at the new one', async () => {
    const port = await listening;
    const old = await connectThroughPause(port, 250, 400);
    expect(old.ok).toBe(false);
    expect((old.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    // That failure is proven unsent, so the outbox may retry it; the aim here is not to fail at all.
    expect(provedUnsentCode(old.error)).not.toBeNull();
    expect(await connectThroughPause(port, TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, 400)).toEqual({ ok: true });
  }, 30_000);
});
