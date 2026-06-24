/**
 * closeoutLivenessSnapshot.ts — the machine-local liveness snapshot that backs
 * the post-transfer closeout's liveness gate (Part C of
 * docs/specs/post-transfer-closeout-correctness.md).
 *
 * THE problem it solves: SessionReaper's post-transfer closeout could terminate
 * the LIVE local session for a topic when the local ownership record was STALE —
 * because nothing verified the remote owner ACTUALLY has a live session for the
 * topic. This module is the verification: a periodically-refreshed local snapshot
 * of "which topics have a live session on each peer", built FROM the SAME per-peer
 * `GET /sessions` fan-out the pool route already performs (no new endpoint), fed
 * to the reaper as a synchronous `remoteOwnerHasLiveSession(topicId, machineId)`
 * dep that returns `true | false | 'unknown'`.
 *
 * Fail-closed everywhere: a missing/stale snapshot, an unreachable peer, or any
 * error → `'unknown'` → the reaper WITHHOLDS the closeout (never kills the live
 * worker). An EMPTY topics-set on a FRESH, successfully-reached peer is a
 * definitive `false` (the stale-owner signal), NOT `'unknown'` — freshness means
 * "reached at reachableAt ≤ bound", never "non-empty".
 *
 * Machine-local by design: every machine runs its OWN closeout against its OWN
 * locally-built snapshot. It is NOT replicated and NOT proxied (the closeout
 * decision is inherently local: "should *I* shed *my* leftover?").
 *
 * No Unbounded Loops: the refresher is LEVEL-triggered on a fixed (jittered)
 * cadence with a per-attempt 5s timeout, per-pass eviction of departed peers, and
 * an OBSERVABILITY breaker (a consecutive-all-failed counter that SURFACES the
 * degraded condition rather than STOPPING the loop — stopping would freeze the
 * snapshot at `'unknown'` forever, the wrong direction for a safe-failure loop).
 */

/** A session object as returned by a peer's `GET /sessions` (the plain array). */
export interface PeerSessionLike {
  /** Bound Telegram topic id, when the session is telegram-bound. The pool
   *  `/sessions` route surfaces it as `platformId` with `platform === 'telegram'`. */
  platform?: string;
  platformId?: number | string;
  /** Session lifecycle status — used to exclude clearly-terminal entries. */
  status?: string;
}

/** One peer's snapshot entry: the set of topic ids that have a live session on
 *  that peer, and the local wall-clock at which the peer was last REACHED. */
export interface PeerLivenessEntry {
  topics: Set<number>;
  /** Local-clock ms when the fan-out fetch for this peer last RESOLVED OK.
   *  A failed/timed-out fetch does NOT update it, so the entry ages into stale. */
  reachableAt: number;
}

/** The result of a single `remoteOwnerHasLiveSession` lookup — the structured
 *  return the dwell-advancement logic needs (state + the snapshot freshness
 *  timestamp, atomic from ONE read). `reachableAt` present on true/false, absent
 *  on 'unknown'. */
export interface LivenessResult {
  state: boolean | 'unknown';
  reachableAt?: number;
}

/** A registered peer to fetch `/sessions` from. */
export interface PeerRef {
  machineId: string;
  url: string;
}

export interface SnapshotConfig {
  /** Reaper tick cadence (seconds) — the refresh cadence. */
  tickIntervalSec: number;
  /** Consecutive all-peers-failed passes before the observability breaker
   *  raises ONE deduped attention item. Default 5 (~10 min at 120s cadence). */
  snapshotBreakerThreshold: number;
}

export const DEFAULT_SNAPSHOT_CONFIG: SnapshotConfig = {
  tickIntervalSec: 120,
  snapshotBreakerThreshold: 5,
};

export interface SnapshotDeps {
  /** All registered ONLINE peers (machineId + url) — `resolvePeerUrls()`.
   *  The refresher INTERSECTS the owner set with this so only registered online
   *  owners are fetched, and EVICTS snapshot entries for departed peers. */
  resolvePeerUrls: () => PeerRef[];
  /** Fetch a SINGLE peer's plain `GET /sessions` list. Bounded by a 5s timeout
   *  inside the impl. Resolves to the session array, or REJECTS/throws on any
   *  failure (timeout, non-2xx, network) so the refresher records NO fresh entry
   *  for that peer (it ages to stale → 'unknown'). */
  fetchPeerSessions: (peer: PeerRef) => Promise<PeerSessionLike[]>;
  /** The owner machineIds this machine could act on THIS pass — the distinct
   *  `.machineId` of every owned-elsewhere topic that has a live local leftover.
   *  Empty ⇒ the refresher does NO http that pass (cost tracks leftovers, not
   *  pool size). */
  ownerSet: () => string[];
  /** Local wall-clock ms. */
  now: () => number;
  /** ONE deduped attention item when the observability breaker trips. */
  raiseAttention?: (item: { id: string; title: string; summary: string; description?: string }) => void;
  /** Structured audit sink (best-effort). */
  audit?: (event: Record<string, unknown>) => void;
}

/**
 * Extract the bound topic id from a peer session object, or null. Mirrors the
 * pool `/sessions` route: a telegram-bound session carries `platform:'telegram'`
 * + `platformId:<topic>`.
 */
export function topicOfPeerSession(s: PeerSessionLike): number | null {
  if (s.platform !== 'telegram') return null;
  const raw = s.platformId;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

/**
 * THE ONE NORMATIVE liveness predicate (spec "Peer `/sessions` liveness
 * contract"): a topic counts as live-on-a-peer when that peer's `/sessions` lists
 * a session bound to the topic that is NOT explicitly terminal/shutting-down. An
 * entry whose state cannot be classified counts as LISTED (opaque is NOT dead) —
 * so we EXCLUDE only the clearly-terminal states.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed']);

export function isTerminalPeerSession(s: PeerSessionLike): boolean {
  return typeof s.status === 'string' && TERMINAL_STATUSES.has(s.status);
}

/**
 * The machine-local liveness snapshot + its bounded refresher.
 *
 * Construct/start ONLY when `closeoutLivenessGate` resolves true — when the gate
 * is off this is never built and the reaper's `remoteOwnerHasLiveSession` dep is
 * left absent (the closeout keeps today's behavior).
 */
export class CloseoutLivenessSnapshot {
  private readonly cfg: SnapshotConfig;
  private readonly deps: SnapshotDeps;
  /** machineId → { topics, reachableAt }. Bounded O(pool machines): evicted of
   *  departed peers each pass; the topics set is bounded by a peer's session count. */
  private readonly snapshot = new Map<string, PeerLivenessEntry>();
  /** Owners discovered mid-tick (closeout saw an owner not yet covered) — fed to
   *  the NEXT refresh, never the current read. */
  private readonly pendingOwners = new Set<string>();
  /** Consecutive refresh passes where EVERY attempted peer fetch failed. */
  private consecutiveAllFailed = 0;
  /** Whether the breaker attention item has already been raised this episode. */
  private breakerRaised = false;

  constructor(deps: SnapshotDeps, cfg?: Partial<SnapshotConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_SNAPSHOT_CONFIG, ...(cfg ?? {}) };
  }

  /** The staleness bound: 2× the refresh cadence (ms). */
  private get stalenessBoundMs(): number {
    return 2 * this.cfg.tickIntervalSec * 1000;
  }

  /**
   * The reaper's synchronous liveness dep. Reads ONLY the already-populated
   * snapshot (never a fetch it triggers). On the FIRST tick a topic's owner is
   * not yet covered, this returns `'unknown'` (→ WITHHOLD) AND enqueues the owner
   * for the next refresh pass.
   */
  remoteOwnerHasLiveSession = (topicId: number, ownerMachineId: string): LivenessResult => {
    try {
      const entry = this.snapshot.get(ownerMachineId);
      if (!entry) {
        // Owner not yet covered — discover it for the NEXT pass, withhold now.
        this.pendingOwners.add(ownerMachineId);
        return { state: 'unknown' };
      }
      const age = this.deps.now() - entry.reachableAt;
      if (!(age <= this.stalenessBoundMs)) {
        // Stale — the peer was unreachable / timed out at the last refresh.
        return { state: 'unknown' };
      }
      // FRESH: an empty topics set is a definitive `false` (reached, zero
      // sessions = the stale-owner signal), never 'unknown'.
      return { state: entry.topics.has(topicId), reachableAt: entry.reachableAt };
    } catch {
      return { state: 'unknown' };
    }
  };

  /**
   * One refresh pass — owner-scoped, bounded fan-out. Called on the reaper
   * cadence. Returns the count of peers fetched (for observability/tests).
   */
  async refresh(): Promise<void> {
    let owners: Set<string>;
    try {
      owners = new Set([...this.deps.ownerSet(), ...this.pendingOwners]);
    } catch {
      owners = new Set(this.pendingOwners);
    }
    this.pendingOwners.clear();

    // Intersect with registered online peers (only fetch owners we can reach),
    // and evict snapshot entries for peers no longer in the pool.
    let registered: PeerRef[] = [];
    try { registered = this.deps.resolvePeerUrls(); } catch { registered = []; }
    const registeredById = new Map(registered.map(p => [p.machineId, p]));

    // Eviction (bounded map growth): drop entries for departed peers.
    for (const mid of [...this.snapshot.keys()]) {
      if (!registeredById.has(mid)) this.snapshot.delete(mid);
    }

    const toFetch: PeerRef[] = [];
    for (const mid of owners) {
      const peer = registeredById.get(mid);
      if (peer) toFetch.push(peer);
    }

    if (toFetch.length === 0) {
      // No owned-elsewhere leftovers reachable this pass → no HTTP, no breaker move.
      return;
    }

    let anyOk = false;
    await Promise.all(toFetch.map(async (peer) => {
      try {
        const list = await this.deps.fetchPeerSessions(peer);
        const topics = new Set<number>();
        for (const s of list) {
          if (isTerminalPeerSession(s)) continue; // exclude only clearly-terminal
          const t = topicOfPeerSession(s);
          if (t != null) topics.add(t);
        }
        // A FRESH reached peer with an EMPTY set is recorded (empty ≠ unknown).
        this.snapshot.set(peer.machineId, { topics, reachableAt: this.deps.now() });
        anyOk = true;
      } catch {
        // Failed fetch: do NOT update reachableAt — the entry ages into stale →
        // 'unknown' → WITHHOLD (the safe direction). @silent-fallback-ok
      }
    }));

    // Observability breaker — SURFACE the degraded condition, never STOP the loop.
    if (anyOk) {
      this.consecutiveAllFailed = 0;
      this.breakerRaised = false;
    } else {
      this.consecutiveAllFailed += 1;
      if (this.consecutiveAllFailed >= this.cfg.snapshotBreakerThreshold && !this.breakerRaised) {
        this.breakerRaised = true;
        this.deps.audit?.({
          kind: 'session-reaper',
          event: 'closeout-snapshot-breaker',
          consecutiveFailures: this.consecutiveAllFailed,
        });
        this.deps.raiseAttention?.({
          id: 'closeout-snapshot-breaker',
          title: 'Post-transfer liveness snapshot cannot reach any peer',
          summary: `The liveness snapshot has failed to reach any peer for ${this.consecutiveAllFailed} passes — closeout is safely withholding all leftovers.`,
          description: `The post-transfer closeout liveness snapshot could not reach ANY peer for ${this.consecutiveAllFailed} consecutive refresh passes. Closeout is safely WITHHOLDING every owned-elsewhere leftover (the fail-closed direction — no live worker is killed), but stale duplicate sessions will not be reclaimed until mesh connectivity recovers. Check mesh/peer connectivity.`,
        });
      }
    }
  }

  /** Test/observability accessor — the current snapshot entry for a peer. */
  peek(machineId: string): PeerLivenessEntry | undefined {
    return this.snapshot.get(machineId);
  }

  /** Test/observability — whether the breaker has fired this episode. */
  get breakerFired(): boolean {
    return this.breakerRaised;
  }
}
