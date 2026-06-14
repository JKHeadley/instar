/**
 * BlobInboxClient.ts — minimal Vercel Blob REST client for the feedback inbox.
 *
 * Why hand-rolled instead of `@vercel/blob`: the canonical front (feedback-front/)
 * deploys with NO install step (`installCommand: "true"` in vercel.json) and bundles
 * its function from ../../src at dev time — a runtime dependency would break that
 * zero-install contract. The drainer (server side) shares this same client so the
 * two ends of the inbox speak one protocol with zero drift.
 *
 * Protocol pinned against @vercel/blob 0.27.3 source (dist/chunk-*.js):
 *   - base `https://blob.vercel-storage.com`, headers `authorization: Bearer <token>`
 *     + `x-api-version: 7` (this client speaks the v7-era request shape — pathname in
 *       the URL path, simple PUT body. The live Blob API rejects that shape with
 *       `400 bad_request "Invalid pathname"` once `x-api-version` is declared as 9+
 *       (newer protocol versions expect a different request format). `7` is the
 *       declared version whose wire contract matches the request this client builds;
 *       verified live against PUT/LIST/DELETE. Adopting the @vercel/blob 2.x v12
 *       protocol would be a larger rewrite, tracked as receiver hardening.)
 *   - PUT  /<pathname>            (body = content; `x-content-type`; `x-add-random-suffix: 1`)
 *   - GET  /?prefix=&limit=&cursor=  → { blobs: [{url, pathname, size, uploadedAt}], cursor, hasMore }
 *   - POST /delete                (JSON { urls: [...] })
 *   - blob CONTENT is read by GETting the blob's own `url` (random-suffixed → unguessable).
 *
 * `addRandomSuffix` is deliberately ON for inbox writes: blob URLs are public-but-
 * unguessable, and a predictable `inbox/<feedbackId>.json` pathname would make report
 * bodies enumerable by anyone who learns the store's host. The drainer never needs to
 * predict a pathname — it lists by prefix and reads the returned URLs.
 *
 * Everything is injected (token, base URL, fetch) so unit tests stub the wire and the
 * integration tier runs against a local fake Blob server.
 */

export interface BlobEntry {
  url: string;
  pathname: string;
  size: number;
  uploadedAt: string;
}

export interface BlobListResult {
  blobs: BlobEntry[];
  cursor?: string;
  hasMore: boolean;
}

export interface BlobInboxClientOptions {
  token: string;
  /** Override the API base (tests / fake server). Default: the real Blob API. */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_BASE = 'https://blob.vercel-storage.com';
const API_VERSION = '7';

export class BlobApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    detail: string,
  ) {
    super(`blob ${operation} failed: HTTP ${status} — ${detail}`);
    this.name = 'BlobApiError';
  }
}

export class BlobInboxClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BlobInboxClientOptions) {
    if (!opts.token) throw new Error('BlobInboxClient requires a token');
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'x-api-version': API_VERSION,
      ...extra,
    };
  }

  /** Durably store one inbox object. Returns the blob's (random-suffixed) URL + pathname. */
  async put(pathname: string, content: string): Promise<{ url: string; pathname: string }> {
    const res = await this.fetchImpl(`${this.apiBase}/${pathname}`, {
      method: 'PUT',
      headers: this.headers({
        'x-content-type': 'application/json',
        'x-add-random-suffix': '1',
      }),
      body: content,
    });
    if (!res.ok) throw new BlobApiError(res.status, 'put', await safeText(res));
    const json = (await res.json()) as { url: string; pathname: string };
    return { url: json.url, pathname: json.pathname };
  }

  /** List one page of blobs under a prefix (oldest pagination order is the API's). */
  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<BlobListResult> {
    const params = new URLSearchParams({ prefix });
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const res = await this.fetchImpl(`${this.apiBase}/?${params.toString()}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) throw new BlobApiError(res.status, 'list', await safeText(res));
    const json = (await res.json()) as Partial<BlobListResult>;
    return { blobs: json.blobs ?? [], cursor: json.cursor, hasMore: Boolean(json.hasMore) };
  }

  /** Read a blob's content by its URL (the URL came from put/list — never predicted). */
  async fetchContent(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { method: 'GET' });
    if (!res.ok) throw new BlobApiError(res.status, 'fetchContent', await safeText(res));
    return res.text();
  }

  /** Delete blobs by URL. Idempotent server-side (deleting a gone blob is not an error). */
  async del(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    const res = await this.fetchImpl(`${this.apiBase}/delete`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ urls }),
    });
    if (!res.ok) throw new BlobApiError(res.status, 'del', await safeText(res));
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<unreadable body>';
  }
}
