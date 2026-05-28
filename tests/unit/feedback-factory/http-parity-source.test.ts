/**
 * Unit tests (Tier 1) — HttpParitySource (live Portal /api/instar/read adapter).
 *
 * Stubs `fetch`. Covers: snapshot capture in prepare(), Bearer auth, pagination
 * + dedupe by clusterId across pages, the "returned_count < pageSize" stop
 * signal, status filter pass-through, error mapping, snake_case vs camelCase
 * tolerance, and the prepare-before-read invariant. Live verification waits on
 * Justin/Dawn's read-scope token; the adapter is fully buildable + provable now.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  HttpParitySource,
  HttpParitySourceError,
  type FetchLike,
} from '../../../src/feedback-factory/dryrun/HttpParitySource.js';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const errResponse = (status: number, body = '') => ({
  ok: false,
  status,
  statusText: status === 401 ? 'Unauthorized' : 'Error',
  json: async () => ({ error: body }),
  text: async () => body,
});

const sampleCluster = (i: number, fp = `fp-${i}`) => ({
  clusterId: `c${i}`,
  type: 'bug',
  title: `title ${i}`,
  fingerprint: fp,
  status: 'investigating',
  recurrenceCount: i,
});

describe('HttpParitySource — single-page snapshot', () => {
  it('captures clusters, sends Bearer auth, and maps fields verbatim', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchStub: FetchLike = vi.fn(async (url, init) => {
      calls.push({ url, headers: init?.headers });
      // returned_count < pageSize → no more pages
      return okResponse({
        data: { clusters: [sampleCluster(1), sampleCluster(2)], feedback: [], dispatches: [] },
        meta: { returned_count: 0, total_feedback_rows: 0 },
      });
    });

    const source = new HttpParitySource({
      baseUrl: 'https://portal.bot-me.ai',
      token: 'TEST_TOKEN',
      pageSize: 1000,
      fetchImpl: fetchStub,
    });
    await source.prepare();
    const clusters = source.readPortalClusters();

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ clusterId: 'c1', type: 'bug', title: 'title 1', fingerprint: 'fp-1', status: 'investigating', recurrenceCount: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://portal.bot-me.ai/api/instar/read?limit=1000&offset=0');
    expect(calls[0].headers?.Authorization).toBe('Bearer TEST_TOKEN');
  });

  it('strips trailing slash on baseUrl and respects custom readPath', async () => {
    const fetchStub: FetchLike = vi.fn(async (url) => {
      expect(url).toBe('https://portal.bot-me.ai/custom/read?limit=10&offset=0');
      return okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } });
    });
    const source = new HttpParitySource({
      baseUrl: 'https://portal.bot-me.ai/',
      token: 't',
      pageSize: 10,
      fetchImpl: fetchStub,
      readPath: '/custom/read',
    });
    await source.prepare();
    expect(source.readPortalClusters()).toEqual([]);
  });

  it('passes through the status filter when configured', async () => {
    const fetchStub: FetchLike = vi.fn(async (url) => {
      expect(url).toContain('status=resolved');
      return okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } });
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 50, fetchImpl: fetchStub, status: 'resolved' });
    await source.prepare();
    expect(source.readPortalClusters()).toEqual([]);
  });
});

describe('HttpParitySource — pagination', () => {
  it('walks pages until returned_count < pageSize and dedupes clusters by clusterId', async () => {
    const offsets: number[] = [];
    const fetchStub: FetchLike = vi.fn(async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      if (offset === 0) {
        // full page → keep going
        return okResponse({
          data: { clusters: [sampleCluster(1), sampleCluster(2)], feedback: new Array(100).fill({}), dispatches: [] },
          meta: { returned_count: 100 },
        });
      }
      if (offset === 100) {
        // full page again, cluster c2 repeats (dedup must keep one), c3 is new
        return okResponse({
          data: { clusters: [sampleCluster(2), sampleCluster(3)], feedback: new Array(100).fill({}), dispatches: [] },
          meta: { returned_count: 100 },
        });
      }
      // partial page → stop
      return okResponse({
        data: { clusters: [sampleCluster(4)], feedback: new Array(50).fill({}), dispatches: [] },
        meta: { returned_count: 50 },
      });
    });

    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 100, fetchImpl: fetchStub });
    await source.prepare();
    const ids = source.readPortalClusters().map((c) => c.clusterId).sort();
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it('honours maxPages safety cap', async () => {
    let calls = 0;
    const fetchStub: FetchLike = vi.fn(async () => {
      calls++;
      // always a full page → would loop forever without the cap
      return okResponse({
        data: { clusters: [sampleCluster(calls)], feedback: new Array(10).fill({}), dispatches: [] },
        meta: { returned_count: 10 },
      });
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 10, fetchImpl: fetchStub, maxPages: 3 });
    await source.prepare();
    expect(calls).toBe(3);
  });
});

describe('HttpParitySource — field-name tolerance', () => {
  it('accepts snake_case cluster keys (cluster_id, recurrence_count)', async () => {
    const fetchStub: FetchLike = vi.fn(async () =>
      okResponse({
        data: {
          clusters: [{ cluster_id: 'sc1', type: 'bug', title: 't', fingerprint: 'fp', status: 'new', recurrence_count: 7 }],
        },
        meta: { returned_count: 0 },
      }),
    );
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 10, fetchImpl: fetchStub });
    await source.prepare();
    expect(source.readPortalClusters()[0]).toMatchObject({ clusterId: 'sc1', recurrenceCount: 7 });
  });

  it('throws on a cluster row missing required fields (contract violation, not silent skip)', async () => {
    const fetchStub: FetchLike = vi.fn(async () =>
      okResponse({ data: { clusters: [{ clusterId: 'x', type: 'bug' /* no title */ }] }, meta: { returned_count: 0 } }),
    );
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 10, fetchImpl: fetchStub });
    await expect(source.prepare()).rejects.toBeInstanceOf(HttpParitySourceError);
  });
});

describe('HttpParitySource — error mapping', () => {
  it('maps non-OK Portal responses to HttpParitySourceError with preserved status', async () => {
    const fetchStub: FetchLike = vi.fn(async () => errResponse(401, 'bad token'));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 'wrong', pageSize: 10, fetchImpl: fetchStub });
    try {
      await source.prepare();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpParitySourceError);
      expect((e as HttpParitySourceError).status).toBe(401);
      expect((e as Error).message).toContain('401');
    }
  });
});

describe('HttpParitySource — prepare-before-read invariant', () => {
  it('readPortalClusters() before prepare() throws (no silent empty)', () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    expect(() => source.readPortalClusters()).toThrow(HttpParitySourceError);
  });

  it('snapshot is a defensive copy (mutating the returned array does not change the snapshot)', async () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse({ data: { clusters: [sampleCluster(1)] }, meta: { returned_count: 0 } }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    await source.prepare();
    const first = source.readPortalClusters();
    first[0].status = 'mutated';
    const second = source.readPortalClusters();
    expect(second[0].status).toBe('investigating');
  });
});
