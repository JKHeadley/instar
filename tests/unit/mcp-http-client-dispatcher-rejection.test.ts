/**
 * relay-send under a Node whose bundled undici rejects the `undici` package's Agent
 * (Node 26 + undici 6.x: TypeError, cause UND_ERR_INVALID_ARG "invalid onError method").
 * Before the fallback every threadline_send on such a machine reported
 * "Failed to reach agent server" while the server was up.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendMessageViaHttp, resetRelaySendDispatcherRejection } from '../../src/threadline/mcp-http-client.js';

function dispatcherRejection(): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' });
  return err;
}

const ok = { ok: true, status: 200, text: async () => '{"success":true,"messageId":"m1","threadId":"t1"}' };
const params = { targetAgent: 'peer', message: 'hello', waitForReply: false, timeoutSeconds: 5 };

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelaySendDispatcherRejection();
});

describe('relay-send dispatcher rejection fallback', () => {
  it('resends once without the package dispatcher, and stops passing it for the process', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(dispatcherRejection())
      .mockResolvedValue(ok);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await sendMessageViaHttp(params, 4040, 'tok');
    expect(first).toMatchObject({ success: true, messageId: 'm1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].dispatcher).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);

    // Remembered: the next send goes straight to the default dispatcher, one call.
    await sendMessageViaHttp(params, 4040, 'tok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].dispatcher).toBeUndefined();
  });

  it('a real connection failure is not retried and still reads as unreachable', async () => {
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const fetchMock = vi.fn().mockRejectedValue(refused);
    vi.stubGlobal('fetch', fetchMock);

    const res = await sendMessageViaHttp(params, 4040, 'tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Failed to reach agent server on port 4040');
  });
});
