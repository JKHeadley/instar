/**
 * relay-send under a Node whose bundled undici rejects the `undici` package's Agent
 * (Node 26 + undici 6.x: TypeError, cause UND_ERR_INVALID_ARG "invalid onError method").
 * Before the fallback every threadline_send on such a machine reported
 * "Failed to reach agent server" while the server was up.
 *
 * The fallback must keep deadline 3 (325 s inner fetch > 320 s route answer,
 * docs/specs/threadline-mcp-local-http.md "Bounds"), so it goes through the
 * package's own fetch WITH the 325 s Agent, never Node's 300 s default.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const pkgFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: pkgFetch };
});

import { sendMessageViaHttp, resetRelaySendDispatcherRejection } from '../../src/threadline/mcp-http-client.js';

function dispatcherRejection(): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' });
  return err;
}

function agentTimeouts(dispatcher: unknown): { headersTimeout: number; bodyTimeout: number } | undefined {
  const d = dispatcher as { [k: symbol]: unknown };
  return Object.getOwnPropertySymbols(d).map((s) => d[s])
    .find((v) => v && typeof v === 'object' && 'headersTimeout' in (v as object)) as { headersTimeout: number; bodyTimeout: number } | undefined;
}

const ok = () => ({ ok: true, status: 200, text: async () => '{"success":true,"messageId":"m1","threadId":"t1"}' });
const params = { targetAgent: 'peer', message: 'hello', waitForReply: false, timeoutSeconds: 5 };

afterEach(() => {
  vi.unstubAllGlobals();
  pkgFetch.mockReset();
  resetRelaySendDispatcherRejection();
});

describe('relay-send dispatcher rejection fallback', () => {
  it('resends once through the package fetch with the 325 s Agent, and goes there directly afterwards', async () => {
    const globalFetch = vi.fn().mockRejectedValue(dispatcherRejection());
    vi.stubGlobal('fetch', globalFetch);
    pkgFetch.mockImplementation(async () => ok());
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await sendMessageViaHttp(params, 4040, 'tok');
    expect(first).toMatchObject({ success: true, messageId: 'm1' });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(pkgFetch).toHaveBeenCalledTimes(1);
    expect(pkgFetch.mock.calls[0][1].body).toBe(globalFetch.mock.calls[0][1].body);
    expect(agentTimeouts(pkgFetch.mock.calls[0][1].dispatcher)).toMatchObject({ headersTimeout: 325_000, bodyTimeout: 325_000 });

    // Remembered: the next send skips Node's fetch entirely.
    await sendMessageViaHttp(params, 4040, 'tok');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(pkgFetch).toHaveBeenCalledTimes(2);
  });

  it('a real connection failure is not retried and still reads as unreachable', async () => {
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const globalFetch = vi.fn().mockRejectedValue(refused);
    vi.stubGlobal('fetch', globalFetch);

    const res = await sendMessageViaHttp(params, 4040, 'tok');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(pkgFetch).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to reach agent server on port 4040');
  });
});
