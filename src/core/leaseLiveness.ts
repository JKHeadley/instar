/**
 * B4 (multimachine-lease-poll-robustness, Decision 10) — skew-immune peer
 * liveness for the lease layer.
 *
 * The lease's `presumedDeadHolders` / `allPeersPresumedGone` historically derive
 * liveness from the registry `lastSeen` — the PEER's OWN wall clock. Under clock
 * skew (the 2026-06-20 post-reboot incident) a +Ns-fast peer looks MORE alive
 * than it is (delaying a needed failover) and a −Ns-slow peer looks DEADER than
 * it is (triggering a false failover → the flap). The skew-immune source is the
 * router's OWN observation clock (`routerReceivedAt`), held by MachinePoolRegistry.
 *
 * This pure decision keeps the conservative direction throughout: when in doubt,
 * a peer is NOT presumed dead (a wrongful "dead" verdict causes a takeover →
 * split-brain, the worse failure). It is flag-gated; with `skewImmune:false` it is
 * byte-for-byte the legacy `lastSeen`-threshold behavior.
 */

export interface PeerLivenessInputs {
  /** Registry `lastSeen` parsed to ms (the peer's own wall clock). null/NaN ⇒ unknown. */
  lastSeenMs: number | null;
  /**
   * Does the in-process MachinePoolRegistry hold a `routerReceivedAt` for this
   * peer THIS incarnation? false ⇒ known-on-disk-but-not-yet-observed (a fresh
   * boot before the first heartbeat) → the skew-immune source has no opinion yet,
   * so we fall back to lastSeen rather than wrongly presume-dead a peer we simply
   * haven't heard from yet (the convergence-review edge).
   */
  routerObserved: boolean;
  /** The registry's skew-immune online verdict (now − routerReceivedAt < failoverThreshold). */
  routerOnline: boolean;
  /** Caller's now (ms). */
  nowMs: number;
  /** Liveness horizon (ms). */
  failoverThresholdMs: number;
  /** Flag: use the skew-immune router source when it has an opinion. */
  skewImmune: boolean;
}

/**
 * True iff the peer should be PRESUMED DEAD (eligible for the lease to act as if
 * it is gone). Conservative: only on positive evidence of staleness.
 */
export function isPeerPresumedDead(i: PeerLivenessInputs): boolean {
  // PRIMARY — skew-immune router liveness, but ONLY when the router actually has
  // an observation for this peer this incarnation. observed-but-stale ⇒ dead.
  if (i.skewImmune && i.routerObserved) {
    return !i.routerOnline;
  }
  // FALLBACK — legacy lastSeen threshold (flag off, OR peer not yet observed).
  // Unknown/unparseable lastSeen ⇒ NOT dead (conservative; a takeover on a peer
  // we can't measure is exactly the split-brain risk we refuse).
  if (i.lastSeenMs == null || Number.isNaN(i.lastSeenMs)) return false;
  return i.nowMs - i.lastSeenMs > i.failoverThresholdMs;
}
