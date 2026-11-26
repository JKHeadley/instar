import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, telegramFetch } from '../../src/messaging/telegram-egress.js';
import { provedUnsentCode } from '../../src/messaging/telegram-origin/OriginTransportCancellation.js';

const server = net.createServer(socket => socket.destroy());
const listening = new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
afterAll(() => { server.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

/**
 * A host with two addresses, the second deliberately blocked inside Node. A supposedly unroutable
 * IPv6 address can instead be silently dropped by the host's current route. Node does not set an
 * attempt timer on the LAST address, so that fixture hung until the OS timed it out. BlockList
 * makes fallback failure independent of host routing while keeping the real first TCP connect.
 * Both immediates run in the same check phase: the connect starts in the first and the pause runs in
 * the second, so timers are due before the event loop next polls and could see the finished connect.
 * That is what a pause in the middle of a round trip does on a real network.
 */
function connectThroughPause(port: number, attemptTimeoutMs: number, pauseMs: number): Promise<{ ok: boolean; error?: unknown }> {
  const blockList = new net.BlockList();
  blockList.addAddress('100::1', 'ipv6');
  return new Promise(resolve => {
    setImmediate(() => {
      const socket = net.connect({ host: 'dual.test', port, blockList, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: attemptTimeoutMs,
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
  it('finishes the old-window failure without waiting for the host IPv6 route', async () => {
    const port = await listening;
    const old = await connectThroughPause(port, 250, 400);
    expect(old.ok).toBe(false);
    expect((old.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    // The first address timed out. The last fails fast either way: refused by Node's BlockList, or,
    // on a host with no IPv6 route at all (the GitHub runner), by the OS before the BlockList is
    // consulted. Which of those happens is a property of the host, not of the code under test.
    const codes = (old.error as AggregateError).errors.map((error: NodeJS.ErrnoException) => error.code);
    expect(codes).toHaveLength(2);
    expect(codes[0]).toBe('ETIMEDOUT');
    expect(['ERR_IP_BLOCKED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL']).toContain(codes[1]);
    // The actual timeout remains proven unsent. Our synthetic blocked fallback is deliberately
    // not in the transport retry allowlist; do not broaden production authority for a fixture.
    expect(provedUnsentCode((old.error as AggregateError).errors[0])).toBe('ETIMEDOUT');
    // The aggregate is proven unsent only when EVERY attempt is. A BlockList refusal is not in the
    // allowlist, so there the aggregate stays unproven. A real OS route failure (ENETUNREACH on a
    // runner with no IPv6 route) IS a proven-unsent connect error, so there the whole attempt is
    // correctly proven unsent and carries the first code. Production behaviour is unchanged.
    if (codes[1] === 'ERR_IP_BLOCKED') expect(provedUnsentCode(old.error)).toBeNull();
    else expect(provedUnsentCode(old.error)).toBe('ETIMEDOUT');
  }, 30_000);
  it('connects through the same pause with the production attempt window', async () => {
    const port = await listening;
    expect(await connectThroughPause(port, TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS, 400)).toEqual({ ok: true });
  }, 30_000);
});
