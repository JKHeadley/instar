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

describe('HttpParitySource — clustersOnly fast path (#948 fix)', () => {
  it('stops after page 0 even when the page is FULL (Portal returns all clusters every page)', async () => {
    // Portal returns the COMPLETE cluster set on every page, so paginating the
    // whole feedback table to collect clusters is wasted work that blows the
    // single-flight budget. clustersOnly must stop after page 0 — proven here by
    // a FULL page-0 (returned_count == pageSize) that would otherwise continue.
    const offsets: number[] = [];
    const fetchStub: FetchLike = vi.fn(async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      // Always a full page (returned_count == pageSize) → normal pagination would
      // keep walking. The 2nd page returns a DIFFERENT cluster so, if the fast
      // path failed to stop, the snapshot would wrongly include c99.
      if (offset === 0) {
        return okResponse({
          data: { clusters: [sampleCluster(1), sampleCluster(2)], feedback: new Array(100).fill({}), dispatches: [] },
          meta: { returned_count: 100 },
        });
      }
      return okResponse({
        data: { clusters: [sampleCluster(99)], feedback: new Array(100).fill({}), dispatches: [] },
        meta: { returned_count: 100 },
      });
    });

    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 100, fetchImpl: fetchStub, clustersOnly: true });
    await source.prepare();
    const ids = source.readPortalClusters().map((c) => c.clusterId).sort();
    expect(ids).toEqual(['c1', 'c2']); // page-0 clusters only; c99 from page 1 NOT fetched
    expect(offsets).toEqual([0]); // exactly ONE fetch
  });

  it('captureRaw overrides clustersOnly — the import rehearsal still paginates the full feedback table', async () => {
    const offsets: number[] = [];
    const fetchStub: FetchLike = vi.fn(async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      if (offset === 0) {
        return okResponse({
          data: { clusters: [sampleCluster(1)], feedback: new Array(100).fill({ feedbackId: `f${offset}` }), dispatches: [] },
          meta: { returned_count: 100 },
        });
      }
      return okResponse({
        data: { clusters: [sampleCluster(2)], feedback: new Array(20).fill({ feedbackId: `f${offset}` }), dispatches: [] },
        meta: { returned_count: 20 },
      });
    });
    // Both flags set: captureRaw must win (import needs every feedback row).
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 100, fetchImpl: fetchStub, clustersOnly: true, captureRaw: true });
    await source.prepare();
    expect(offsets).toEqual([0, 100]); // full pagination, NOT short-circuited
    expect(source.readRawClusters().map((c) => c.clusterId).sort()).toEqual(['c1', 'c2']);
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

describe('HttpParitySource — fetch timeouts (the 2026-06-05 hang fix)', () => {
  it('a stalled page fetch aborts at pageTimeoutMs and maps to HttpParitySourceError 504', async () => {
    // Stub mirrors real fetch abort semantics: never resolves, rejects with the
    // signal's reason (a DOMException named TimeoutError for AbortSignal.timeout).
    const fetchStub: FetchLike = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub, pageTimeoutMs: 30 });
    try {
      await source.prepare();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpParitySourceError);
      expect((e as HttpParitySourceError).status).toBe(504);
      expect((e as Error).message).toContain('timed out after');
      expect((e as Error).message).toContain('page 0');
    }
  });

  it('every page fetch carries an AbortSignal (no unbounded request can be issued)', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchStub: FetchLike = vi.fn(async (_url, init) => {
      signals.push(init?.signal);
      return okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } });
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    await source.prepare();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('enforces the total budget between pages (504 before issuing the next page)', async () => {
    let calls = 0;
    // Robust timing margins (deflake): page 0's fetch (300ms) far exceeds the
    // 100ms total budget, so page 1 is always refused after it; and the 100ms
    // budget comfortably exceeds any pre-page-0 setup jitter, so page 0 always
    // issues (calls === 1). The previous 1ms budget vs 15ms fetch raced setup
    // jitter on a loaded CI runner — when jitter exceeded 1ms, page 0 itself was
    // refused and calls === 0.
    const fetchStub: FetchLike = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 300));
      // always a full page → wants to keep paginating
      return okResponse({
        data: { clusters: [sampleCluster(calls)], feedback: new Array(10).fill({}), dispatches: [] },
        meta: { returned_count: 10 },
      });
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 10, fetchImpl: fetchStub, totalTimeoutMs: 100 });
    try {
      await source.prepare();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpParitySourceError);
      expect((e as HttpParitySourceError).status).toBe(504);
      expect((e as Error).message).toContain('exceeded the total budget');
    }
    expect(calls).toBe(1); // page 0 ran; page 1 was refused before issue
  });

  it('non-abort fetch failures propagate unchanged (not masked as 504)', async () => {
    const fetchStub: FetchLike = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    await expect(source.prepare()).rejects.toThrow(TypeError);
  });

  it('a BODY read that aborts maps to the classified 504 naming the page (the 2026-06-05 11:01Z live finding)', async () => {
    // Headers arrive in time; the body stream aborts (slow body > remaining budget).
    const abortErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchStub: FetchLike = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => { throw abortErr; },
      text: async () => '',
    }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub, pageTimeoutMs: 30 });
    try {
      await source.prepare();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpParitySourceError);
      expect((e as HttpParitySourceError).status).toBe(504);
      expect((e as Error).message).toContain('body read timed out');
      expect((e as Error).message).toContain('page 0');
    }
  });

  it('a non-abort BODY parse failure propagates unchanged (not masked as 504)', async () => {
    const fetchStub: FetchLike = vi.fn(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => { throw new SyntaxError('bad json'); },
      text: async () => '',
    }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    await expect(source.prepare()).rejects.toThrow(SyntaxError);
  });
});

describe('HttpParitySource — raw capture (captureRaw, the AS-IS import read)', () => {
  it('keeps cluster + feedback rows VERBATIM, including fields the coercer never reads', async () => {
    const fetchStub: FetchLike = vi.fn(async () =>
      okResponse({
        data: {
          clusters: [{ ...sampleCluster(1), governanceNotes: 'curated judgment', unknownField: { deep: [1, 2] } }],
          feedback: [{ feedbackId: 'f1', title: 'r1', someRawThing: 'kept' }],
          dispatches: [],
        },
        meta: { returned_count: 0 },
      }),
    );
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 10, fetchImpl: fetchStub, captureRaw: true });
    await source.prepare();

    const rawClusters = source.readRawClusters();
    expect(rawClusters).toHaveLength(1);
    expect(rawClusters[0].governanceNotes).toBe('curated judgment');
    expect(rawClusters[0].unknownField).toEqual({ deep: [1, 2] });

    const rawFeedback = source.readRawFeedback();
    expect(rawFeedback).toHaveLength(1);
    expect(rawFeedback[0].someRawThing).toBe('kept');
  });

  it('accumulates feedback across pages and dedupes repeats by id (clusters too)', async () => {
    const fetchStub: FetchLike = vi.fn(async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      if (offset === 0) {
        return okResponse({
          data: {
            clusters: [sampleCluster(1)],
            feedback: [{ feedbackId: 'f1' }, { feedbackId: 'f2' }],
          },
          meta: { returned_count: 2 },
        });
      }
      return okResponse({
        data: {
          clusters: [sampleCluster(1)], // repeats — must dedupe
          feedback: [{ feedbackId: 'f2' }, { feedback_id: 'f3' }], // f2 repeats; f3 arrives snake_case
        },
        meta: { returned_count: 1 },
      });
    });
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', pageSize: 2, fetchImpl: fetchStub, captureRaw: true });
    await source.prepare();
    expect(source.readRawClusters()).toHaveLength(1);
    const ids = source.readRawFeedback().map((f) => f.feedbackId ?? f.feedback_id).sort();
    expect(ids).toEqual(['f1', 'f2', 'f3']);
  });

  it('throws on raw reads without captureRaw (parity mode never silently returns empty)', async () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub });
    await source.prepare();
    expect(() => source.readRawClusters()).toThrow(HttpParitySourceError);
    expect(() => source.readRawFeedback()).toThrow(HttpParitySourceError);
  });

  it('throws on raw reads before prepare() even with captureRaw set', () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse({ data: { clusters: [] }, meta: { returned_count: 0 } }));
    const source = new HttpParitySource({ baseUrl: 'https://p', token: 't', fetchImpl: fetchStub, captureRaw: true });
    expect(() => source.readRawClusters()).toThrow(HttpParitySourceError);
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
