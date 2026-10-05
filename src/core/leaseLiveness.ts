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

import type { MachinePoolRegistry } from './MachinePoolRegistry.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

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

export interface LeaseLivenessMachineEntry {
  lastSeen: string;
  revokedAt?: string;
  status?: string;
  lastKnownUrl?: string;
  endpoints?: unknown[];
}

export interface LeaseFlapFixConfig {
  liveness?: boolean;
  unconfirmedWriteAlert?: boolean;
}

export function createLeaseFlapSwitchGetter(
  liveGet: (path: string, fallback: boolean) => boolean,
  log: (message: string) => void = () => {},
): (name: 'liveness' | 'unconfirmedWriteAlert') => boolean {
  const states = new Map<string, boolean>();
  return (name) => {
    const enabled = liveGet(`multiMachine.leaseFlapFix.${name}`, true);
    const previous = states.get(name);
    if (previous !== undefined && previous !== enabled) {
      log(`multiMachine.leaseFlapFix.${name} → ${enabled} (actor: config-file)`);
    }
    states.set(name, enabled);
    return enabled;
  };
}

export interface LeaseDegradationSink {
  report: (event: { feature: string; primary: string; fallback: string; reason: string; impact: string; internalOnly?: boolean }) => void;
}

export function reportLeaseOrderingDegradation(
  failoverThresholdMs: number,
  leaseTtlMs: number,
  enabled: boolean,
  reporter: LeaseDegradationSink = DegradationReporter.getInstance(),
): boolean {
  if (!enabled || failoverThresholdMs > leaseTtlMs) return false;
  reporter.report({
    feature: 'lease.liveness-window-ordering',
    primary: 'Failover threshold longer than the lease TTL',
    fallback: 'Lease expiry remains the acquisition floor',
    reason: `failoverThresholdMs (${failoverThresholdMs}) <= leaseTtlMs (${leaseTtlMs})`,
    impact: 'Live-evidence freshness can close before a visible lease expires.',
    internalOnly: true,
  });
  return true;
}

export function isDialableLeasePeer(entry: LeaseLivenessMachineEntry): boolean {
  return !entry.revokedAt && (!!entry.lastKnownUrl || (entry.endpoints?.length ?? 0) > 0);
}

export function buildLeaseLivenessCallbacks(deps: {
  selfMachineId?: string;
  loadDiskRegistry: () => { machines?: Record<string, LeaseLivenessMachineEntry> };
  getRouter: () => MachinePoolRegistry | undefined;
  getFreshness: () => {
    freshRenewalWithin: (id: string, ms: number) => boolean;
    lastRenewalObservedMono: (id: string) => number | undefined;
  } | undefined;
  getLeaseFlapFixConfig: () => LeaseFlapFixConfig | undefined;
  getSkewImmune: () => boolean;
  failoverThresholdMs: number;
  bootMonoMs: number;
  monoNow: () => number;
  wallNow: () => number;
}) {
  const firstRegisteredMonoMs = new Map<string, number>();
  const firstDialableMonoMs = new Map<string, number>();
  const reportedWindows = new Set<string>();

  const livenessEnabled = (override?: boolean): boolean =>
    override ?? deps.getLeaseFlapFixConfig()?.liveness ?? true;

  const peerDead = (id: string, entry: LeaseLivenessMachineEntry, enabled: boolean): boolean => {
    const router = deps.getRouter();
    if (!enabled) {
      const cap = router?.getCapacity(id);
      return isPeerPresumedDead({
        lastSeenMs: Date.parse(entry.lastSeen),
        routerObserved: !!cap?.routerReceivedAt,
        routerOnline: !!cap?.online,
        nowMs: deps.wallNow(),
        failoverThresholdMs: deps.failoverThresholdMs,
        skewImmune: deps.getSkewImmune(),
      });
    }
    const receipt = router?.lastLiveReceiptMono(id);
    const receiptFresh = receipt !== undefined && deps.monoNow() - receipt <= deps.failoverThresholdMs;
    const renewalFresh = deps.getFreshness()?.freshRenewalWithin(id, deps.failoverThresholdMs) ?? false;
    if (receiptFresh || renewalFresh) return false;
    return receipt !== undefined;
  };

  const presumedDeadHolders = (opts?: { liveness?: boolean }): ReadonlySet<string> => {
    const registry = deps.loadDiskRegistry();
    const enabled = livenessEnabled(opts?.liveness);
    const dead = new Set<string>();
    for (const [id, entry] of Object.entries(registry.machines ?? {})) {
      if (id === deps.selfMachineId) continue;
      if (peerDead(id, entry, enabled)) dead.add(id);
    }
    return dead;
  };

  const allPeersPresumedGone = (): boolean => {
    const registry = deps.loadDiskRegistry();
    const peers = Object.entries(registry.machines ?? {})
      .filter(([id, entry]) => id !== deps.selfMachineId && !entry.revokedAt);
    if (peers.length === 0) return false;
    const enabled = livenessEnabled();
    return peers.every(([id, entry]) => peerDead(id, entry, enabled));
  };

  const sample = (): void => {
    if (!livenessEnabled()) return;
    const now = deps.monoNow();
    const registry = deps.loadDiskRegistry();
    const unobserved: string[] = [];
    for (const [id, entry] of Object.entries(registry.machines ?? {})) {
      if (id === deps.selfMachineId || entry.revokedAt) continue;
      if (!firstRegisteredMonoMs.has(id)) firstRegisteredMonoMs.set(id, now);
      const dialable = isDialableLeasePeer(entry);
      if (dialable && !firstDialableMonoMs.has(id)) firstDialableMonoMs.set(id, now);
      const receipt = deps.getRouter()?.lastLiveReceiptMono(id);
      const renewal = deps.getFreshness()?.lastRenewalObservedMono(id);
      if (receipt !== undefined || renewal !== undefined) continue;
      const tag = dialable
        ? 'currently-dialable'
        : firstDialableMonoMs.has(id) ? 'previously-dialable' : 'never-dialable';
      const start = dialable
        ? Math.max(deps.bootMonoMs, firstDialableMonoMs.get(id) ?? now)
        : (tag === 'never-dialable' ? firstRegisteredMonoMs.get(id)! : firstDialableMonoMs.get(id)!);
      if (now - start < 2 * deps.failoverThresholdMs) continue;
      const window = `${id}:${tag === 'never-dialable' ? 'never-dialable' : 'dialable'}`;
      if (reportedWindows.has(window)) continue;
      reportedWindows.add(window);
      const qualifier = entry.status !== 'active' ? `, not-pulled (status: ${entry.status ?? 'unknown'})` : '';
      unobserved.push(`${id} [${tag}${qualifier}]`);
    }
    if (unobserved.length > 0) {
      DegradationReporter.getInstance().report({
        feature: 'lease.liveness-feeder',
        primary: 'Registered peers observed through live pulls or verified renewals',
        fallback: 'Conservative unknown-peer lease handling',
        reason: `registered peers remain unobserved: ${unobserved.join(', ')}`,
        impact: 'Peer liveness cannot be corroborated from live evidence.',
        internalOnly: true,
      });
    }
  };

  return { presumedDeadHolders, allPeersPresumedGone, sample };
}
