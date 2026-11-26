import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { requestSecretViaHttp } from '../../src/threadline/mcp-http-client.js';

// The agent's helper mints with the agent key so its receipt message can reach the
// conversation; without a usable key it falls back to the keyless route and passes on
// the server's plain notice.
describe('requestSecretViaHttp routing', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const params = { label: 'k', topicId: 5 };
  function stubFetch(answers: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers.Authorization });
      const a = Object.entries(answers).find(([p]) => url.endsWith(p))![1];
      return { status: a.status, ok: a.status < 300, text: async () => JSON.stringify(a.body) } as unknown as Response;
    }));
    return calls;
  }

  it('with the key: one call to the key-gated route, bearer attached', async () => {
    const calls = stubFetch({ '/secrets/request': { status: 201, body: { token: 't', localUrl: '/secrets/drop/t' } } });
    const r = await requestSecretViaHttp(params, 4040, 'KEY');
    expect(r.success).toBe(true);
    expect(calls).toEqual([{ url: 'http://localhost:4040/secrets/request', auth: 'Bearer KEY' }]);
  });

  it('a refused key (401) falls back to the keyless route, and its notice is passed on', async () => {
    const calls = stubFetch({
      '/threadline/secrets/request': { status: 201, body: { token: 't', receiptNotice: 'disabled', notice: 'No receipt message will come; restart.' } },
      '/secrets/request': { status: 401, body: { error: 'bad token' } },
    });
    const r = await requestSecretViaHttp(params, 4040, 'OLD');
    expect(calls.map((c) => c.url)).toEqual(['http://localhost:4040/secrets/request', 'http://localhost:4040/threadline/secrets/request']);
    expect(calls[1].auth).toBeUndefined();
    expect(r.notice).toContain('restart');
  });

  it('a stale key (403 after a key rotation) also falls back instead of failing', async () => {
    const calls = stubFetch({
      '/threadline/secrets/request': { status: 201, body: { token: 't' } },
      '/secrets/request': { status: 403, body: { error: 'Invalid auth token' } },
    });
    const r = await requestSecretViaHttp(params, 4040, 'STALE');
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('no key: straight to the keyless route', async () => {
    const calls = stubFetch({ '/threadline/secrets/request': { status: 201, body: { token: 't' } } });
    await requestSecretViaHttp(params, 4040, null);
    expect(calls.map((c) => c.url)).toEqual(['http://localhost:4040/threadline/secrets/request']);
  });

  it('a refusal other than 401 is reported, never retried keyless', async () => {
    const calls = stubFetch({ '/secrets/request': { status: 400, body: { error: 'bad name' } } });
    const r = await requestSecretViaHttp(params, 4040, 'KEY');
    expect(r).toEqual({ success: false, error: 'bad name' });
    expect(calls).toHaveLength(1);
  });

  it('wiring: both helpers pass the agent key', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf-8');
    expect(read('src/threadline/mcp-stdio-entry.ts')).toContain('requestSecretViaHttp(params, serverPort, agentToken)');
    expect(read('src/threadline/ThreadlineMcpHttpService.ts')).toContain('requestSecretViaHttp(params, port, token())');
  });
});
