/**
 * PoolPollCache unit tests — WS4.4(f) global pool-cache unification
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 clause (f)).
 *
 * Covers BOTH sides of every decision boundary with realistic inputs:
 *  - within-TTL cache hit (one fan-out feeds two surfaces) vs. expired re-fetch
 *  - single-flight coalescing of concurrent callers
 *  - load-shed: over-threshold serves last-cached stale, under-threshold fetches
 *  - load-shed with an EMPTY cache still fetches (can't serve from nothing)
 *  - a failed fetch is NEVER cached (transient errors must not stick)
 *  - per-(peer, route) keying so two routes on the same peer don't collide
 */

import { describe, it, expect, vi } from 'vitest';
import { PoolPollCache } from '../../src/server/PoolPollCache.js';

describe('PoolPollCache (WS4.4(f))', () => {
  it('serves a within-TTL hit without a second network call (one fan-out feeds two surfaces)', async () => {
    const fetcher = vi.fn(async () => ({ jobs: [{ id: 'a' }] }));
    const cache = new PoolPollCache({ ttlMs: 1000, now: () => 1_000 });

    const first = await cache.fetchPeer('peer-1', '/jobs', fetcher);
    const second = await cache.fetchPeer('peer-1', '/jobs', fetcher);

    expect(first.source).toBe('fetch');
    expect(first.stale).toBe(false);
    expect(second.source).toBe('cache-hit');
    expect(second.stale).toBe(false);
    expect(second.body).toEqual({ jobs: [{ id: 'a' }] });
    // The KEY assertion: the second surface did NOT re-fan-out.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL window has elapsed', async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    let t = 1_000;
    const cache = new PoolPollCache({ ttlMs: 1000, now: () => t });

    await cache.fetchPeer('peer-1', '/jobs', fetcher);
    t = 2_500; // past the 1s TTL
    await cache.fetchPeer('peer-1', '/jobs', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent callers into ONE in-flight fetch (single-flight)', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = new PoolPollCache({ ttlMs: 1000, now: () => 1_000 });

    const p1 = cache.fetchPeer('peer-1', '/jobs', fetcher as () => Promise<unknown>);
    const p2 = cache.fetchPeer('peer-1', '/jobs', fetcher as () => Promise<unknown>);
    // Both started before the fetch resolved → only one network call.
    resolveFetch({ jobs: [] });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(r1.body).toEqual({ jobs: [] });
    expect(r2.body).toEqual({ jobs: [] });
    expect(cache.snapshot().stats.coalesced).toBe(1);
  });

  it('load-sheds: over the CPU threshold serves last-cached tagged stale (no re-fan)', async () => {
    const fetcher = vi.fn(async () => ({ v: 'cached' }));
    let load = 0.2; // under threshold to seed the cache
    let t = 0;
    const cache = new PoolPollCache({
      ttlMs: 100,
      loadShedPerCore: 1.5,
      loadReader: () => load,
      now: () => t,
    });

    // Seed: a fresh fetch while load is low.
    await cache.fetchPeer('peer-1', '/jobs', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Now the TTL has expired AND the box is over the load-shed threshold:
    // serve last-cached, honestly tagged stale, WITHOUT re-fanning.
    t = 1_000;
    load = 2.0;
    const res = await cache.fetchPeer('peer-1', '/jobs', fetcher);
    expect(res.source).toBe('load-shed');
    expect(res.stale).toBe(true);
    expect(res.body).toEqual({ v: 'cached' });
    expect(fetcher).toHaveBeenCalledTimes(1); // NOT re-fetched
    expect(cache.snapshot().stats.loadSheds).toBe(1);
  });

  it('load-shed with an EMPTY cache still fetches (cannot serve from nothing)', async () => {
    const fetcher = vi.fn(async () => ({ v: 'fresh' }));
    const cache = new PoolPollCache({
      ttlMs: 100,
      loadShedPerCore: 1.5,
      loadReader: () => 5.0, // way over threshold
      now: () => 0,
    });

    const res = await cache.fetchPeer('peer-1', '/jobs', fetcher);
    // No cached value to shed to → the first read MUST still fetch.
    expect(res.source).toBe('fetch');
    expect(res.stale).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('NEVER caches a failed fetch (a transient error must not stick the whole TTL)', async () => {
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('peer timeout');
      return { v: 'recovered' };
    });
    const cache = new PoolPollCache({ ttlMs: 10_000, now: () => 1_000 });

    await expect(cache.fetchPeer('peer-1', '/jobs', fetcher)).rejects.toThrow('peer timeout');
    // Same window, but the error was NOT cached → the next call fetches again.
    const res = await cache.fetchPeer('peer-1', '/jobs', fetcher);
    expect(res.body).toEqual({ v: 'recovered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.snapshot().stats.errors).toBe(1);
  });

  it('keys per (peer, route) so two routes on the same peer never collide', async () => {
    const jobsFetcher = vi.fn(async () => ({ kind: 'jobs' }));
    const attnFetcher = vi.fn(async () => ({ kind: 'attention' }));
    const cache = new PoolPollCache({ ttlMs: 1000, now: () => 1_000 });

    const jobs = await cache.fetchPeer('peer-1', '/jobs', jobsFetcher);
    const attn = await cache.fetchPeer('peer-1', '/attention', attnFetcher);

    expect(jobs.body).toEqual({ kind: 'jobs' });
    expect(attn.body).toEqual({ kind: 'attention' });
    expect(jobsFetcher).toHaveBeenCalledTimes(1);
    expect(attnFetcher).toHaveBeenCalledTimes(1);
    expect(cache.snapshot().cachedKeys).toBe(2);
  });

  it('snapshot reports wiring + live load + counters for the /pool/poll-cache route', async () => {
    const cache = new PoolPollCache({
      ttlMs: 3000,
      loadShedPerCore: 1.5,
      loadReader: () => 0.4,
      now: () => 0,
    });
    await cache.fetchPeer('peer-1', '/jobs', async () => ({}));
    const snap = cache.snapshot();
    expect(snap.enabled).toBe(true);
    expect(snap.ttlMs).toBe(3000);
    expect(snap.loadShedPerCore).toBe(1.5);
    expect(snap.loadPerCore).toBe(0.4);
    expect(snap.loadShedding).toBe(false);
    expect(snap.stats.fetches).toBe(1);
  });

  it('isLoadShedding flips at the threshold boundary (both sides)', () => {
    let load = 1.49;
    const cache = new PoolPollCache({ loadShedPerCore: 1.5, loadReader: () => load });
    expect(cache.isLoadShedding()).toBe(false);
    load = 1.5;
    expect(cache.isLoadShedding()).toBe(true);
  });
});
