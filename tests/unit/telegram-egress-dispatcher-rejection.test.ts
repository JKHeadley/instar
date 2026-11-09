import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  telegramFetch,
  telegramDispatcherWasRejected,
  resetTelegramDispatcherRejection,
} from '../../src/messaging/telegram-egress.js';

// A URL with no Bot API method goes straight to the network path, so these tests see exactly what
// reaches fetch without the origin layer in between.
const FILE_URL = 'https://api.telegram.org/file/bot123:AAErandomtokenvalue/photo.jpg';

/** What Node 26's fetch throws when handed a dispatcher from the undici 6.x package. */
function dispatcherRejection(): TypeError {
  const cause = Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' });
  return new TypeError('fetch failed', { cause });
}

let calls: Array<Record<string, unknown>>;
beforeEach(() => {
  calls = [];
  resetTelegramDispatcherRejection();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTelegramDispatcherRejection();
});

function stubFetch(impl: (init: Record<string, unknown>) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: Record<string, unknown>) => { calls.push(init); return impl(init); }));
}

describe('telegram egress — a dispatcher Node\'s fetch refuses', () => {
  it('passes the package dispatcher while Node accepts it (Node 24 behaviour unchanged)', async () => {
    stubFetch(async () => new Response('ok', { status: 200 }));
    const res = await telegramFetch(FILE_URL);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeDefined();
    expect(telegramDispatcherWasRejected()).toBe(false);
  });

  it('resends once without the dispatcher when Node rejects it before the network, and remembers', async () => {
    stubFetch(async (init) => {
      if (init.dispatcher) throw dispatcherRejection();
      return new Response('ok', { status: 200 });
    });
    const res = await telegramFetch(FILE_URL);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].dispatcher).toBeDefined();
    expect(calls[1].dispatcher).toBeUndefined();
    expect(telegramDispatcherWasRejected()).toBe(true);

    // The next call in this process goes straight to Node's default dispatcher.
    calls = [];
    await telegramFetch(FILE_URL);
    expect(calls).toHaveLength(1);
    expect(calls[0].dispatcher).toBeUndefined();
  });

  it('does not resend on any other network error (a send that may have left is never repeated)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    stubFetch(async () => { throw new TypeError('fetch failed', { cause: refused }); });
    await expect(telegramFetch(FILE_URL)).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(1);
    expect(telegramDispatcherWasRejected()).toBe(false);
  });

  it('does not resend a stream body, which the first attempt may have consumed', async () => {
    stubFetch(async (init) => {
      if (init.dispatcher) throw dispatcherRejection();
      return new Response('ok', { status: 200 });
    });
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close(); } });
    await expect(telegramFetch(FILE_URL, { method: 'POST', body, duplex: 'half' } as RequestInit)).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(1);
    expect(telegramDispatcherWasRejected()).toBe(false);
  });
});
