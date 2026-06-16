import { describe, it, expect } from 'vitest';
import { LiveTestSlackCaller, type FetchLike } from '../../src/core/LiveTestSlackCaller.js';

const BASE = {
  workspaceHost: 'sagemindlivetest.slack.com',
  xoxcToken: 'xoxc-test-member-token',
  dCookie: 'xoxd-the-d-cookie-value',
  botToken: 'xoxb-echo-bot-token',
};

type Captured = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake fetch that records the request and returns a canned JSON body. */
function fakeFetch(response: unknown): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { json: async () => response };
  };
  return { fetchImpl, calls };
}

describe('LiveTestSlackCaller', () => {
  it('chat.postMessage posts AS THE MEMBER: xoxc token in the form body + d cookie header, NOT Bearer, at the workspace host', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, ts: '171.222' });
    const caller = new LiveTestSlackCaller({ ...BASE, fetchImpl });

    const res = await caller.call('chat.postMessage', { channel: 'C123', text: 'hi from member' });

    expect(res.ok).toBe(true);
    expect(res.ts).toBe('171.222');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    // Web-client host, not slack.com.
    expect(c.url).toBe('https://sagemindlivetest.slack.com/api/chat.postMessage');
    // The xoxc token rides the x-www-form-urlencoded BODY, never a header.
    expect(c.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(c.body);
    expect(form.get('token')).toBe('xoxc-test-member-token');
    expect(form.get('channel')).toBe('C123');
    expect(form.get('text')).toBe('hi from member');
    expect(form.get('_x_reason')).toBe('webapp_message_send');
    expect(form.get('_x_mode')).toBe('online');
    // The `d` session cookie is in the Cookie header.
    expect(c.headers['Cookie']).toBe('d=xoxd-the-d-cookie-value');
    // And it is NOT a Bearer call.
    expect(c.headers['Authorization']).toBeUndefined();
    expect(c.body).not.toContain('Bearer');
  });

  it('conversations.history uses the Bearer bot token at slack.com, JSON body, NOT xoxc / cookie', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: true, messages: [{ ts: '9.9', user: 'UECHOBOT', text: 'reply' }] });
    const caller = new LiveTestSlackCaller({ ...BASE, fetchImpl });

    const res = await caller.call('conversations.history', { channel: 'C123', limit: 100 });

    expect(res.ok).toBe(true);
    expect(res.messages?.[0]?.user).toBe('UECHOBOT');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://slack.com/api/conversations.history');
    // Bearer bot token, JSON body — the clean read path.
    expect(c.headers['Authorization']).toBe('Bearer xoxb-echo-bot-token');
    expect(c.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(c.headers['Cookie']).toBeUndefined();
    const parsed = JSON.parse(c.body) as Record<string, unknown>;
    expect(parsed.channel).toBe('C123');
    expect(parsed.limit).toBe(100);
    // The xoxc token must never leak into a bot-path body.
    expect(c.body).not.toContain('xoxc-');
  });

  it('skips undefined params on both transports (never serializes "undefined")', async () => {
    const post = fakeFetch({ ok: true, ts: '1.1' });
    const caller1 = new LiveTestSlackCaller({ ...BASE, fetchImpl: post.fetchImpl });
    await caller1.call('chat.postMessage', { channel: 'C1', text: 't', thread_ts: undefined });
    const form = new URLSearchParams(post.calls[0].body);
    expect(form.has('thread_ts')).toBe(false);
    expect(post.calls[0].body).not.toContain('undefined');

    const hist = fakeFetch({ ok: true, messages: [] });
    const caller2 = new LiveTestSlackCaller({ ...BASE, fetchImpl: hist.fetchImpl });
    await caller2.call('conversations.history', { channel: 'C1', oldest: undefined, limit: 50 });
    const parsed = JSON.parse(hist.calls[0].body) as Record<string, unknown>;
    expect('oldest' in parsed).toBe(false);
    expect(parsed.limit).toBe(50);
  });

  it('throws loudly (no silent fallback) when a required credential is missing', () => {
    expect(() => new LiveTestSlackCaller({ ...BASE, workspaceHost: '' })).toThrow(/workspaceHost/);
    expect(() => new LiveTestSlackCaller({ ...BASE, xoxcToken: '' })).toThrow(/xoxcToken/);
    expect(() => new LiveTestSlackCaller({ ...BASE, dCookie: '' })).toThrow(/dCookie/);
    expect(() => new LiveTestSlackCaller({ ...BASE, botToken: '' })).toThrow(/botToken/);
  });
});
