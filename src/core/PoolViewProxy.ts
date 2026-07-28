/**
 * PoolViewProxy — the fronting-machine side of WS4.4 "links that survive machine
 * boundaries" (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 a/c/d). SECURITY-SENSITIVE
 * adjacent (it carries the assertion from PoolLinkAssertion; it never substitutes
 * machine creds for user creds, never logs tokens, never caches private bodies).
 *
 * Responsibilities (pure logic; transport injected):
 *   (a) HOLDER RESOLUTION — view-id ownership ≠ topic ownership. There is NO
 *       replicated view-id→machine index in instar today (PrivateViewer stores
 *       each view on the local disk of the machine that created it). So the
 *       holder is resolved by a FAN-OUT PROBE: ask each online peer "do you hold
 *       view X?"; the holder answers present, all others answer absent. The
 *       resolution is memoized briefly so repeated requests for the same view
 *       within a window don't re-fan-out (DOCUMENTED LIMIT: a view moved between
 *       machines within the memo window resolves to the stale holder until the
 *       memo expires; the proxied request then 404s and the memo is invalidated).
 *   (c) CONCURRENCY CAP — a semaphore bounds in-flight proxied requests so a
 *       burst of remote-view fetches can't exhaust the fronting machine. Over the
 *       cap → an honest 503 (retry), never an unbounded queue.
 *   (d) OFFLINE HOLDER — when the resolved holder is offline/unreachable, the
 *       result is an explicit `holder-offline` so the caller serves the honest
 *       "content temporarily unavailable — its machine is offline" page, NEVER a
 *       bare 404 (which would imply the view doesn't exist) and NEVER stale
 *       content (private bodies are never cached at the edge).
 *
 * The HTTP transport (fetch, peer URL list, the machine-authed mesh send) is
 * injected so the resolution + cap + offline state machine is unit-testable with
 * in-memory fakes.
 */

export interface PoolPeer {
  machineId: string;
  url: string;
  /** Registry liveness; false = known-offline (skip the probe, fail fast). */
  online?: boolean;
}

export type HolderResolution =
  | { kind: 'local' }
  | { kind: 'remote'; machineId: string; url: string }
  | { kind: 'not-found' }
  | { kind: 'holder-offline'; machineId: string }
  | { kind: 'no-peers' }
  /**
   * §WS4.4 (f) load-shed: the fronting machine is over its CPU threshold AND has
   * no fresh memoized resolution to serve, so it declines to re-fan-out right now.
   * The caller surfaces an honest "busy, retry shortly" rather than spending a
   * CPU-bound box on a fresh fan-out. NEVER returned when a (possibly stale)
   * cached resolution exists — that path returns the cached resolution flagged
   * `stale: true` instead (load-shed, honestly labeled).
   */
  | { kind: 'load-shed' };

/**
 * A resolution plus its load-posture metadata. `stale: true` means the fronting
 * machine was over its CPU threshold and served the LAST-CACHED resolution
 * instead of re-fanning-out (§WS4.4 f). `cachedAtMs` is when that cached
 * resolution was computed (so the caller can label "as of N ago"). On a fresh
 * fan-out (or local/no-peers), `stale` is false and `cachedAtMs` is the
 * just-computed time.
 */
export interface TaggedHolderResolution {
  resolution: HolderResolution;
  stale: boolean;
  cachedAtMs: number;
}

export interface PoolViewProxyDeps {
  /** This fronting machine's id. */
  selfMachineId: string;
  /** Does THIS machine hold the view locally? (PrivateViewer.get != null) */
  heldLocally: (viewId: string) => boolean;
  /** Every registered peer (machineId + url + liveness). */
  listPeers: () => PoolPeer[];
  /**
   * Probe one peer: does it hold `viewId`? Resolves to `'present'` (holder),
   * `'absent'` (not this peer), or `'unreachable'` (probe failed/timed out).
   * Machine-authed under the hood (the production probe is a mesh verb), so a
   * peer's answer is from a registered same-operator machine.
   */
  probePeer: (peer: PoolPeer, viewId: string) => Promise<'present' | 'absent' | 'unreachable'>;
  now: () => number;
  /** Holder-resolution memo TTL (ms). Default 30_000. */
  resolveMemoTtlMs?: number;
  /** Max in-flight proxied requests. Default 16. */
  maxConcurrent?: number;
  /**
   * §WS4.4 (f) load-shed posture: the fronting machine's CURRENT 1-min CPU load
   * normalized per core (loadavg[0] / numCpus). Injected (os.loadavg in prod) so
   * the load-shed branch is unit-testable. Optional — absent ⇒ never load-sheds.
   */
  cpuLoadPerCore?: () => number;
  /**
   * §WS4.4 (f): the load-per-core threshold at/above which holder resolution
   * load-sheds (serves last-cached with a staleness tag instead of re-fanning).
   * Default 1.5 (mirrors SessionReaper cpuCriticalLoadPerCore). 0 disables.
   */
  loadShedLoadPerCore?: number;
  logger?: (line: string) => void;
}

const DEFAULT_MEMO_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_LOAD_SHED_LOAD_PER_CORE = 1.5;

interface MemoEntry {
  resolution: HolderResolution;
  at: number;
}

export class PoolViewProxy {
  private readonly memo = new Map<string, MemoEntry>();
  private inFlight = 0;

  constructor(private readonly d: PoolViewProxyDeps) {}

  private memoTtl(): number {
    return this.d.resolveMemoTtlMs ?? DEFAULT_MEMO_TTL_MS;
  }
  private maxConcurrent(): number {
    return this.d.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /** Current in-flight proxied request count (observability/tests). */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /** True if a new proxied request would exceed the concurrency cap. */
  atCapacity(): boolean {
    return this.inFlight >= this.maxConcurrent();
  }

  /**
   * Invalidate a memoized resolution (e.g. after a proxied request 404s — the
   * holder moved). Next resolve() re-fans-out.
   */
  invalidate(viewId: string): void {
    this.memo.delete(viewId);
  }

  /**
   * Resolve which machine HOLDS `viewId`. Local-first (no probe needed), then a
   * fan-out probe of online peers. Memoized briefly. Resolution outcomes:
   *   - local         → this machine has it (serve normally, no proxy)
   *   - remote        → a reachable peer holds it (proxy to it)
   *   - holder-offline→ exactly one peer is the holder but it's offline/unreachable
   *   - not-found     → no peer (and not local) holds it
   *   - no-peers      → there are no peers to probe (single-machine)
   */
  async resolveHolder(viewId: string): Promise<HolderResolution> {
    // Local-first: a locally-held view never needs a probe.
    if (this.d.heldLocally(viewId)) return { kind: 'local' };

    const cached = this.memo.get(viewId);
    if (cached && this.d.now() - cached.at < this.memoTtl()) {
      return cached.resolution;
    }

    const peers = this.d.listPeers().filter((p) => p.machineId !== this.d.selfMachineId);
    if (peers.length === 0) {
      const r: HolderResolution = { kind: 'no-peers' };
      this.memo.set(viewId, { resolution: r, at: this.d.now() });
      return r;
    }

    // Probe online peers; a known-offline peer is skipped at the probe (it
    // cannot answer). We track whether any peer was unreachable so we can
    // distinguish "nobody holds it" (not-found) from "the holder may be the one
    // we couldn't reach" — but only an UNREACHABLE peer that we cannot rule out
    // produces holder-offline, and only when no online peer answered present.
    let holder: PoolPeer | null = null;
    let sawUnreachable: PoolPeer | null = null;

    const results = await Promise.all(
      peers.map(async (p) => {
        if (p.online === false) return { peer: p, ans: 'unreachable' as const };
        try {
          const ans = await this.d.probePeer(p, viewId);
          return { peer: p, ans };
        } catch {
          return { peer: p, ans: 'unreachable' as const };
        }
      }),
    );
    for (const { peer, ans } of results) {
      if (ans === 'present') {
        holder = peer;
        break;
      }
      if (ans === 'unreachable') sawUnreachable = peer;
    }

    let resolution: HolderResolution;
    if (holder) {
      // The present holder might itself be marked offline in the registry yet
      // answered — answering proves reachability, so it's `remote`.
      resolution = { kind: 'remote', machineId: holder.machineId, url: holder.url };
    } else if (sawUnreachable) {
      // No online peer claims it, but a peer was unreachable — it may be the
      // offline holder. Honest "temporarily unavailable", never a bare 404.
      resolution = { kind: 'holder-offline', machineId: sawUnreachable.machineId };
    } else {
      resolution = { kind: 'not-found' };
    }
    this.memo.set(viewId, { resolution, at: this.d.now() });
    return resolution;
  }

  /** §WS4.4 (f): is the fronting machine currently over its CPU threshold? */
  private overCpuThreshold(): boolean {
    const sampler = this.d.cpuLoadPerCore;
    if (!sampler) return false;
    const threshold = this.d.loadShedLoadPerCore ?? DEFAULT_LOAD_SHED_LOAD_PER_CORE;
    if (!(threshold > 0)) return false; // 0/negative disables load-shed.
    let load: number;
    try {
      load = sampler();
    } catch {
      // @silent-fallback-ok: a CPU-sampler failure never load-sheds — it fails
      // toward serving FRESH (the safe direction); load-shed is an optimization,
      // not a correctness gate, so there is nothing to report as a degradation.
      return false;
    }
    return Number.isFinite(load) && load >= threshold;
  }

  /**
   * §WS4.4 (f) load-shed-aware holder resolution. The route should call THIS
   * (not the raw resolveHolder) so it can honestly label staleness:
   *   - Local-held views ALWAYS resolve fresh (no fan-out, no CPU cost) — they
   *     are never load-shed.
   *   - Under the CPU threshold: behaves exactly like resolveHolder (fresh fan-out,
   *     memoized), returned with stale:false.
   *   - At/over the threshold WITH a cached resolution (fresh OR expired): serve
   *     that cached resolution flagged stale:true + its cachedAtMs (load-shed,
   *     honestly labeled — NO re-fan-out).
   *   - At/over the threshold WITHOUT any cached resolution: { kind: 'load-shed' },
   *     so the caller surfaces an honest "busy, retry shortly" rather than spending
   *     a CPU-bound box on a fresh fan-out. NEVER serves a fabricated/stale body.
   */
  async resolveHolderTagged(viewId: string): Promise<TaggedHolderResolution> {
    // Local-first: a locally-held view is free to resolve — never load-shed.
    if (this.d.heldLocally(viewId)) {
      return { resolution: { kind: 'local' }, stale: false, cachedAtMs: this.d.now() };
    }

    const cached = this.memo.get(viewId);
    const memoFresh = cached && this.d.now() - cached.at < this.memoTtl();

    if (this.overCpuThreshold()) {
      // Load-shed: never re-fan-out. Serve any cached resolution (fresh OR
      // expired) with an explicit staleness tag; if none exists, decline honestly.
      if (cached) {
        this.d.logger?.(
          `[pool-view-proxy] load-shed: serving cached holder resolution for ${viewId} (age ${this.d.now() - cached.at}ms, stale=${!memoFresh})`,
        );
        return { resolution: cached.resolution, stale: !memoFresh, cachedAtMs: cached.at };
      }
      this.d.logger?.(`[pool-view-proxy] load-shed: no cached resolution for ${viewId} — declining fan-out`);
      return { resolution: { kind: 'load-shed' }, stale: false, cachedAtMs: this.d.now() };
    }

    // Below threshold: normal path (fresh fan-out when the memo is cold/expired).
    const resolution = await this.resolveHolder(viewId);
    const entry = this.memo.get(viewId);
    return { resolution, stale: false, cachedAtMs: entry?.at ?? this.d.now() };
  }

  /**
   * Run `fn` (the actual proxied fetch) under the concurrency cap. Returns
   * `{ ok: false, reason: 'at-capacity' }` immediately when over the cap (no
   * queue — the caller surfaces an honest 503). On accept, the in-flight count is
   * incremented for the duration of `fn` and decremented in a finally.
   *
   * `fn` MUST stream the holder's response straight through to the client
   * WITHOUT buffering the private body to disk/cache (spec §WS4.4 b/c) — that is
   * the caller's contract; this method only bounds concurrency.
   */
  async withSlot<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: 'at-capacity' }> {
    if (this.atCapacity()) {
      this.d.logger?.(`[pool-view-proxy] at capacity (${this.inFlight}/${this.maxConcurrent()}) — shedding`);
      return { ok: false, reason: 'at-capacity' };
    }
    this.inFlight++;
    try {
      const value = await fn();
      return { ok: true, value };
    } finally {
      this.inFlight--;
    }
  }
}
