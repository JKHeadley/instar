/**
 * Unit tests — Threadline MCP send path (sendMessageViaHttp).
 *
 * REGRESSION: the MCP `threadline_send` tool routes through
 * `sendMessageViaHttp`, which POSTs to `/threadline/relay-send`. Previously,
 * when relay-send returned 503 ("Relay not connected and local delivery
 * unavailable"), the helper fell through to a SECOND POST to `/messages/send`
 * with a threadline-shaped body. `/messages/send` expects an inter-agent
 * envelope, so it rejected with HTTP 400 "Missing required fields: from, to,
 * type, priority, subject, body" — a misleading error that masked the real
 * reason. These tests pin the fix: the honest relay-send error is surfaced,
 * and `/messages/send` is NEVER called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMessageViaHttp } from '../../src/threadline/mcp-http-client.js';
import { DEFAULT_RELAY_URL, DEFAULT_RELAY_HOST } from '../../src/threadline/constants.js';
import type { SendMessageParams } from '../../src/threadline/ThreadlineMCPServer.js';

const PORT = 4042;
const TOKEN = 'test-token';

function baseParams(overrides: Partial<SendMessageParams> = {}): SendMessageParams {
  return {
    targetAgent: 'dawn',
    message: 'hello',
    waitForReply: false,
    timeoutSeconds: 120,
    ...overrides,
  };
}

/** Build a minimal fetch Response stand-in exposing only what the helper uses. */
function fakeResponse(status: number, body: unknown) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => raw,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

describe('sendMessageViaHttp — honest error surfacing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('surfaces the real 503 error and NEVER calls /messages/send', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(503, { success: false, error: 'Relay not connected and local delivery unavailable' }),
    );

    const result = await sendMessageViaHttp(baseParams(), PORT, TOKEN);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Relay not connected and local delivery unavailable');
    expect(result.error).not.toContain('Missing required fields');

    // Exactly one HTTP call, to relay-send — never the envelope endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls[0]).toContain('/threadline/relay-send');
    expect(calledUrls.some((u) => u.includes('/messages/send'))).toBe(false);
  });

  it('maps a successful relay-send response through', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, {
        success: true,
        messageId: 'msg-1',
        threadId: 'thread-1',
        deliveryPath: 'relay',
        deliveryOutcome: 'spawned new session',
        reply: 'hi back',
        replyFrom: 'dawn',
      }),
    );

    const result = await sendMessageViaHttp(baseParams({ waitForReply: true }), PORT, TOKEN);

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-1');
    expect(result.threadId).toBe('thread-1');
    expect(result.deliveryPath).toBe('relay');
    expect(result.deliveryOutcome).toBe('spawned new session');
    expect(result.reply).toBe('hi back');
    expect(result.replyFrom).toBe('dawn');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 agent-not-found error without an envelope fallback', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(404, { success: false, error: 'Agent not found: "ghost". Try discovering agents first.' }),
    );

    const result = await sendMessageViaHttp(baseParams({ targetAgent: 'ghost' }), PORT, TOKEN);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent not found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/threadline/relay-send');
  });

  it('treats HTTP 200 with success:false as a failure and surfaces its error', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { success: false, error: 'ambiguous target' }),
    );

    const result = await sendMessageViaHttp(baseParams(), PORT, TOKEN);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ambiguous target');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an unreachable agent server when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await sendMessageViaHttp(baseParams(), PORT, TOKEN);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to reach agent server');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('forwards originTopicId and purpose to relay-send (THREAD-TOPIC-LINKAGE)', async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(200, { success: true, messageId: 'm', threadId: 't', deliveryPath: 'local' }),
    );

    await sendMessageViaHttp(
      baseParams({ originTopicId: 12304, purpose: 'ask dawn for the Q3 numbers' }),
      PORT,
      TOKEN,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.originTopicId).toBe(12304);
    expect(body.purpose).toBe('ask dawn for the Q3 numbers');
    expect(body.targetAgent).toBe('dawn');
  });

  it('falls back to raw body text when relay-send returns a non-JSON error', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(502, 'Bad Gateway'));

    const result = await sendMessageViaHttp(baseParams(), PORT, TOKEN);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Bad Gateway');
  });
});

describe('relay URL single source of truth', () => {
  it('defaults to the deployed relay, not the dead host', () => {
    expect(DEFAULT_RELAY_URL).toBe('wss://threadline-relay.fly.dev/v1/connect');
    expect(DEFAULT_RELAY_HOST).toBe('threadline-relay.fly.dev');
    expect(DEFAULT_RELAY_URL).not.toContain('relay.threadline.dev');
  });
});
