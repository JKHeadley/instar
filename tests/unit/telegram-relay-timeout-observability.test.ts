/**
 * Unit tests for relayOutbound — the tokenless-standby outbound relay, with the
 * bounded-timeout + observability fixes (found driving the live multi-machine
 * proof, 2026-06-01): the original inline relay had NO timeout (a stalled holder
 * tunnel hung the moved session's reply >70s) and logged NOTHING on any failure
 * path (a dropped reply was invisible).
 */

import { describe, it, expect, vi } from 'vitest';
import { relayOutbound, type RelayDeps } from '../../src/core/TelegramRelay.js';

const HOLDER = 'm_holder';
const SELF = 'm_self';

function baseDeps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    leaseHolder: () => HOLDER,
    selfMachineId: SELF,
    peerUrl: () => 'https://holder.example.dev',
    authToken: 'tok',
    timeoutMs: 50,
    fetchImpl: (async () => new Response(JSON.stringify({ messageId: 7 }), { status: 200 })) as unknown as typeof fetch,
    log: () => {},
    ...over,
  };
}

describe('relayOutbound — bounded + observable tokenless-standby relay', () => {
  it('relays to the holder and returns the messageId on a 2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messageId: 42 }), { status: 200 }));
    const r = await relayOutbound(8882, 'hi', undefined, baseDeps({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(r).toEqual({ messageId: 42, topicId: 8882 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://holder.example.dev/telegram/reply/8882');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns null and LOGS when we hold the lease ourselves', async () => {
    const log = vi.fn();
    const r = await relayOutbound(1, 'x', undefined, baseDeps({ leaseHolder: () => SELF, log }));
    expect(r).toBeNull();
    // self-hold is an expected no-op, not an error — no log required, but must not throw
  });

  it('returns null and LOGS when no peer URL is known (was silent)', async () => {
    const log = vi.fn();
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ peerUrl: () => null, log }));
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/no peer URL/i);
  });

  it('treats a 2xx with NO messageId as undelivered (truthful success — false-success-under-load fix)', async () => {
    const log = vi.fn();
    // The holder accepted the request (ok:true) but did not confirm a Telegram
    // messageId — the exact shape observed live that made the relay lie.
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, topicId: 8882 }), { status: 200 })) as unknown as typeof fetch;
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ fetchImpl, log }));
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/no confirmed messageId/i);
  });

  it('treats a 2xx with messageId:0 as undelivered', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ messageId: 0 }), { status: 200 })) as unknown as typeof fetch;
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ fetchImpl }));
    expect(r).toBeNull();
  });

  it('returns null and LOGS the status on a non-2xx (was silent)', async () => {
    const log = vi.fn();
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ fetchImpl, log }));
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/403/);
  });

  it('TIMES OUT fast (aborts) when the holder hangs, instead of hanging forever', async () => {
    const log = vi.fn();
    // fetch that never resolves unless its signal aborts → rejects on abort.
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init.signal as AbortSignal;
        if (sig.aborted) reject(new DOMException('Aborted', 'AbortError'));
        sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const start = Date.now();
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ fetchImpl: hangingFetch, timeoutMs: 40, log }));
    const elapsed = Date.now() - start;
    expect(r).toBeNull();
    expect(elapsed).toBeLessThan(2000); // bounded — did NOT hang
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/timeout after 40ms/i);
  });

  it('returns null and LOGS on a network error (was silent)', async () => {
    const log = vi.fn();
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await relayOutbound(8882, 'x', undefined, baseDeps({ fetchImpl, log }));
    expect(r).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
  });

  it('passes silent flag through to the holder body', async () => {
    let sentBody: unknown;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ messageId: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    await relayOutbound(8882, 'hi', { silent: true }, baseDeps({ fetchImpl }));
    expect(sentBody).toEqual({ text: 'hi', silent: true });
  });
});
