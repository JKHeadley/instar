/**
 * threadline_send newThread — the MCP HTTP client forwards the new-thread
 * request to /threadline/relay-send, and omits it when not asked for
 * (Echo Bugs topic 10000000781).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendMessageViaHttp } from '../../src/threadline/mcp-http-client.js';

function captureBody(): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, threadId: 't', messageId: 'm' }) };
  }));
  return { bodies };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('sendMessageViaHttp newThread', () => {
  it('sends newThread: true when asked for a new thread', async () => {
    const { bodies } = captureBody();
    await sendMessageViaHttp({ targetAgent: 'PP', message: 'hi', waitForReply: false, timeoutSeconds: 5, newThread: true }, 4042, 'tok');
    expect(bodies[0].newThread).toBe(true);
  });

  it('omits newThread for an ordinary send', async () => {
    const { bodies } = captureBody();
    await sendMessageViaHttp({ targetAgent: 'PP', message: 'hi', waitForReply: false, timeoutSeconds: 5 }, 4042, 'tok');
    expect('newThread' in bodies[0]).toBe(false);
  });
});
