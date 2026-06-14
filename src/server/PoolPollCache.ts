/**
 * PoolPollCache — WS4.4(f) global pool-cache unification
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4, normative clause (f)).
 *
 * THE PROBLEM this closes
 * -----------------------
 * Every pool-scope dashboard surface — `GET /sessions?scope=pool`,
 * `/jobs?scope=pool`, `/attention?scope=pool`, `/guards?scope=pool`,
 * `/parallel-work/activities?scope=pool`, `/subscription-pool?scope=pool` —
 * independently fans out to EVERY peer machine and fetches that peer's plain
 * route. With a dashboard polling several of these tabs at once, the SAME peer
 * is hit N times per poll interval (once per surface, per client). On the
 * fronting machine that is wasted egress + wasted peer CPU, and it scales with
 * the number of open dashboard tabs — exactly the "fronting-edge load posture"
 * the spec calls out.
 *
 * THE FIX (spec §WS4.4(f), verbatim intent)
 * -----------------------------------------
 *   "merged pool views (attention/jobs/sessions/guards) are served from ONE
 *    shared per-peer poll cache (one fan-out per interval feeds all pool-scope
 *    surfaces — never per-route, per-client re-fan-out), and when the fronting
 *    machine is over a CPU threshold, dashboard poll responses serve
 *    last-cached data with an explicit staleness tag instead of re-fanning
 *    (load-shed, honestly labeled)."
 *
 * This class is that shared cache. Every pool-scope surface routes its per-peer
 * fetch through `fetchPeer(peerMachineId, routePath, fetcher)`:
 *   - within the poll interval (`ttlMs`), the cached body is returned WITHOUT a
 *     network call — so two surfaces asking the same peer in the same window
 *     share ONE fan-out;
 *   - concurrent callers for the same (peer, route) in flight share ONE
 *     in-flight promise (single-flight) — a burst of tab-loads collapses to one
 *     request;
 *   - when the fronting machine is over the CPU load-shed threshold, a STALE
 *     cached body is returned (tagged `stale: true`) instead of re-fanning —
 *     honest load-shedding; if nothing is cached yet the fetch still runs (a
 *     first read can never be served from an empty cache).
 *
 * SAFETY / SCOPE
 * --------------
 * - Ships DARK behind `multiMachine.seamlessness.ws44PoolCache` (dev-agent
 *   gated, like ws44PoolLinks). When OFF, surfaces never construct/consult this
 *   and keep their existing direct per-peer fetch — byte-identical behavior.
 * - Caches ONLY peer route bodies the surfaces already fetch over the mesh.
 *   It introduces NO new authority, NEVER mutates anything, and NEVER caches
 *   private end-user content (the pool-scope surfaces are operator-Bearer reads
 *   of mesh metadata, not `/view/:id` bodies — those are handled by WS4.4
 *   pool-links, which explicitly never caches private bodies).
 * - A failed fetch is NEVER cached — a transient peer error must not stick for
 *   the whole TTL. The error propagates to the caller, which already classifies
 *   it into its per-peer `failed` list.
 */

import os from 'node:os';

/** A cached per-peer route body plus the freshness it was captured at. */
interface CacheEntry {
  /** epoch ms the body was fetched at. */
  at: number;
  /** the parsed peer body (whatever the surface's fetcher resolved to). */
  body: unknown;
}

export interface PoolPollCacheOptions {
  /** Shared poll interval — within this window a (peer, route) is served from
   *  cache without a network call. Default 3s, matching the per-route caches
   *  the surfaces use today (JOBS_POOL_CACHE_TTL_MS / ATTENTION_POOL_CACHE_TTL_MS). */
  ttlMs?: number;
  /** 1-min load-average-per-core at/above which the fronting machine serves
   *  last-cached (stale) instead of re-fanning. Default 1.5 (the SessionReaper
   *  cpuCriticalLoadPerCore default). */
  loadShedPerCore?: number;
  /** Injectable load reader (testability) — returns 1-min load avg per core. */
  loadReader?: () => number;
  /** Injectable clock (testability). */
  now?: () => number;
}

/** The outcome of a `fetchPeer` call — the body plus how it was served. */
export interface PeerFetchResult<T = unknown> {
  body: T;
  /** `true` when the body is a last-cached value served under load-shed (the
   *  caller surfaces this as an honest staleness tag); `false` when fresh or
   *  served from a within-TTL cache hit. */
  stale: boolean;
  /** how this body was produced: a live network fetch, a within-TTL cache hit,
   *  or a load-shed stale serve. Drives the observability counters. */
  source: 'fetch' | 'cache-hit' | 'load-shed';
}

interface CacheStats {
  /** live network fetches performed. */
  fetches: number;
  /** within-TTL cache hits (a fan-out avoided because the body was fresh). */
  cacheHits: number;
  /** load-shed stale serves (a fan-out avoided under CPU pressure). */
  loadSheds: number;
  /** concurrent callers that joined an in-flight fetch (single-flight). */
  coalesced: number;
  /** fetches that threw (never cached). */
  errors: number;
}

/**
 * One shared cache instance per server. Construct it ONLY when the WS4.4(f)
 * flag resolves on; pass it to RouteContext and let every pool-scope surface
 * route its per-peer fetch through it.
 */
export class PoolPollCache {
  private readonly ttlMs: number;
  private readonly loadShedPerCore: number;
  private readonly loadReader: () => number;
  private readonly now: () => number;
  private readonly cpuCount: number;

  /** keyed by `${peerMachineId}::${routePath}` */
  private readonly entries = new Map<string, CacheEntry>();
  /** in-flight single-flight promises, same key. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  private readonly stats: CacheStats = {
    fetches: 0,
    cacheHits: 0,
    loadSheds: 0,
    coalesced: 0,
    errors: 0,
  };

  constructor(opts: PoolPollCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 3_000;
    this.loadShedPerCore = opts.loadShedPerCore ?? 1.5;
    this.now = opts.now ?? (() => Date.now());
    // Default load reader: 1-min loadavg per core. os.loadavg() is [1,5,15]m.
    this.cpuCount = Math.max(1, os.cpus()?.length ?? 1);
    this.loadReader =
      opts.loadReader ?? (() => (os.loadavg()[0] ?? 0) / this.cpuCount);
  }

  /** `true` when the fronting machine is over the load-shed threshold. */
  isLoadShedding(): boolean {
    return this.loadReader() >= this.loadShedPerCore;
  }

  /**
   * Fetch a peer's route body through the shared cache.
   *
   * @param peerMachineId  the peer being polled
   * @param routePath      the plain peer route (e.g. '/jobs') — part of the key
   *                       so two surfaces hitting the SAME peer for DIFFERENT
   *                       routes never collide
   * @param fetcher        performs the actual network fetch + parse; called at
   *                       most once per (peer, route) per TTL window (and shared
   *                       across concurrent callers)
   */
  async fetchPeer<T = unknown>(
    peerMachineId: string,
    routePath: string,
    fetcher: () => Promise<T>,
  ): Promise<PeerFetchResult<T>> {
    const key = `${peerMachineId}::${routePath}`;
    const cached = this.entries.get(key);
    const fresh = cached != null && this.now() - cached.at < this.ttlMs;

    // 1) Fresh within-TTL hit — one fan-out feeds every surface in the window.
    if (fresh) {
      this.stats.cacheHits++;
      return { body: cached!.body as T, stale: false, source: 'cache-hit' };
    }

    // 2) Load-shed: over CPU threshold AND we have *something* cached — serve
    //    last-cached, honestly tagged, rather than re-fanning. A first-ever read
    //    (no cached entry) must still fetch — you can't load-shed from empty.
    if (cached != null && this.isLoadShedding()) {
      this.stats.loadSheds++;
      return { body: cached.body as T, stale: true, source: 'load-shed' };
    }

    // 3) Single-flight: a concurrent caller for the same key joins the in-flight
    //    fetch instead of starting its own.
    const existing = this.inflight.get(key);
    if (existing != null) {
      this.stats.coalesced++;
      const body = (await existing) as T;
      return { body, stale: false, source: 'cache-hit' };
    }

    // 4) Live fetch. Record in-flight so concurrent callers coalesce.
    const p = (async () => {
      const body = await fetcher();
      // Cache only a SUCCESSFUL fetch (a thrown fetch never reaches here).
      this.entries.set(key, { at: this.now(), body });
      return body;
    })();
    this.inflight.set(key, p);
    try {
      const body = (await p) as T;
      this.stats.fetches++;
      return { body, stale: false, source: 'fetch' };
    } catch (err) {
      this.stats.errors++;
      throw err;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Drop the cached entry for a (peer, route) — e.g. when a peer goes offline. */
  invalidate(peerMachineId: string, routePath: string): void {
    this.entries.delete(`${peerMachineId}::${routePath}`);
  }

  /** Read-only observability snapshot for the `/pool/poll-cache` route. */
  snapshot(): {
    enabled: true;
    ttlMs: number;
    loadShedPerCore: number;
    loadPerCore: number;
    loadShedding: boolean;
    cachedKeys: number;
    inflight: number;
    stats: CacheStats;
  } {
    return {
      enabled: true,
      ttlMs: this.ttlMs,
      loadShedPerCore: this.loadShedPerCore,
      loadPerCore: Number(this.loadReader().toFixed(3)),
      loadShedding: this.isLoadShedding(),
      cachedKeys: this.entries.size,
      inflight: this.inflight.size,
      stats: { ...this.stats },
    };
  }
}
