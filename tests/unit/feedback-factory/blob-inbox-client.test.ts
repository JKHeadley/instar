/**
 * Unit tests (Tier 1) — BlobInboxClient: the hand-rolled Vercel Blob REST client
 * shared by the canonical front and the operated machine's drainer.
 *
 * Stubs fetch and pins the WIRE protocol (pinned against @vercel/blob 0.27.3):
 * auth header, x-api-version, PUT pathname + random-suffix header, list query
 * params + pagination fields, delete body shape, and error surfacing.
 */

import { describe, it, expect } from 'vitest';
import { BlobInboxClient, BlobApiError } from '../../../src/feedback-factory/inbox/BlobInboxClient.js';

type Call = { url: string; init: RequestInit };

function stubFetch(responder: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const out = responder(u, init ?? {});
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => out.body,
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe('BlobInboxClient — wire protocol', () => {
  it('put: PUT <base>/<pathname> with bearer auth, api version, random-suffix, content-type', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: { url: 'https://store.example/inbox/fb-1-abc123.json', pathname: 'inbox/fb-1-abc123.json' } }));
    const client = new BlobInboxClient({ token: 'tok', apiBase: 'https://blob.example', fetchImpl: impl });

    const out = await client.put('inbox/fb-1.json', '{"feedbackId":"fb-1"}');
    expect(out.pathname).toBe('inbox/fb-1-abc123.json');

    const call = calls[0];
    expect(call.url).toBe('https://blob.example/inbox/fb-1.json');
    expect(call.init.method).toBe('PUT');
    const h = call.init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['x-api-version']).toBe('7');
    expect(h['x-add-random-suffix']).toBe('1');
    expect(h['x-content-type']).toBe('application/json');
    expect(call.init.body).toBe('{"feedbackId":"fb-1"}');
  });

  it('list: GET /?prefix=&limit=&cursor= and maps blobs/cursor/hasMore', async () => {
    const { impl, calls } = stubFetch(() => ({
      status: 200,
      body: { blobs: [{ url: 'u1', pathname: 'inbox/a.json', size: 10, uploadedAt: 'x' }], cursor: 'c2', hasMore: true },
    }));
    const client = new BlobInboxClient({ token: 'tok', apiBase: 'https://blob.example', fetchImpl: impl });

    const page = await client.list('inbox/', { limit: 50, cursor: 'c1' });
    expect(page.blobs).toHaveLength(1);
    expect(page.cursor).toBe('c2');
    expect(page.hasMore).toBe(true);

    const u = new URL(calls[0].url);
    expect(u.searchParams.get('prefix')).toBe('inbox/');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('cursor')).toBe('c1');
  });

  it('list: tolerates a missing blobs array (empty page)', async () => {
    const { impl } = stubFetch(() => ({ status: 200, body: {} }));
    const client = new BlobInboxClient({ token: 'tok', fetchImpl: impl });
    const page = await client.list('inbox/');
    expect(page.blobs).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('del: POST /delete with { urls } JSON body; no-op on empty input', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: {} }));
    const client = new BlobInboxClient({ token: 'tok', apiBase: 'https://blob.example', fetchImpl: impl });

    await client.del([]); // must not hit the wire
    expect(calls).toHaveLength(0);

    await client.del(['https://store.example/a', 'https://store.example/b']);
    expect(calls[0].url).toBe('https://blob.example/delete');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ urls: ['https://store.example/a', 'https://store.example/b'] });
  });

  it('fetchContent: GETs the blob URL directly (never a predicted pathname)', async () => {
    const { impl, calls } = stubFetch(() => ({ status: 200, body: '{"feedbackId":"fb-1"}' }));
    const client = new BlobInboxClient({ token: 'tok', fetchImpl: impl });
    const content = await client.fetchContent('https://store.example/inbox/fb-1-abc.json');
    expect(content).toBe('{"feedbackId":"fb-1"}');
    expect(calls[0].url).toBe('https://store.example/inbox/fb-1-abc.json');
  });

  it('surfaces HTTP failures as BlobApiError with status + operation', async () => {
    const { impl } = stubFetch(() => ({ status: 403, body: 'forbidden' }));
    const client = new BlobInboxClient({ token: 'bad', fetchImpl: impl });
    await expect(client.list('inbox/')).rejects.toMatchObject({ name: 'BlobApiError', status: 403, operation: 'list' });
    await expect(client.put('inbox/x.json', '{}')).rejects.toBeInstanceOf(BlobApiError);
  });

  it('refuses construction without a token (fail-fast, never an unauthenticated call)', () => {
    expect(() => new BlobInboxClient({ token: '' })).toThrow(/token/);
  });
});
