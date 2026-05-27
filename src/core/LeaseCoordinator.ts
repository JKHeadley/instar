/**
 * LeaseCoordinator — drives the FencedLease over the durable (git) and fast
 * (tunnel) media, and owns the lifecycle of acquisition / renewal / fencing /
 * escalation. Spec §6 + §8 G1.
 *
 * Correctness substrate is GIT: acquisition is a compare-and-swap implemented
 * as write-then-push-or-reject-reread plus epoch monotonicity (git has no
 * native CAS). The TUNNEL is an optional low-latency accelerator: it can raise
 * the observed epoch (speeding acquisition) but can NEVER lower it below the
 * git-committed floor, and a replayed/below-floor tunnel message is dropped by
 * FencedLease.acceptTunnelLease. If the tunnel is unavailable the system
 * degrades to git-only — correct, just bounded by git cadence — which is why
 * Phase-0 pairing worked over git alone.
 *
 * Renewal requires the tunnel medium when one is configured: a holder that
 * cannot renew for > leaseTtlMs MUST self-suspend ingress regardless of its
 * local clock (closes the tunnel-down / git-up split-authority window).
 *
 * The store/transport are injected so the dangerous CAS-contention and
 * self-suspend logic are unit-testable with in-memory fakes.
 */

import { FencedLease } from './FencedLease.js';
import type { LeaseRecord } from './types.js';

/** Durable (git-backed) view + CAS write of the lease. */
export interface LeaseStore {
  /** Read the current committed lease + its epoch (0 if none). */
  read(): { lease: LeaseRecord | null; epoch: number };
  /**
   * Attempt to commit `candidate` as the new lease. Implements the CAS:
   * returns ok:true if the candidate landed (fast-forward push accepted), or
   * ok:false + the freshly-observed lease/epoch after a reject+reread so the
   * caller can re-evaluate. MUST NOT force-push.
   */
  casWrite(candidate: LeaseRecord): { ok: boolean; observed: { lease: LeaseRecord | null; epoch: number } };
  /**
   * Refresh the SAME-epoch lease's expiry durably (renewal, not acquisition).
   * Returns true if the refresh was confirmed over the durable medium (push
   * succeeded). A holder that cannot refresh (partitioned) must self-suspend —
   * this is the git-medium equivalent of the tunnel-renewal requirement, and
   * it is what prevents a partitioned old-awake from extending its lease
   * locally forever (the split-brain). Optional: a tunnel-backed deployment
   * confirms over the tunnel instead and may no-op this.
   */
  refresh(lease: LeaseRecord): boolean;
}

/** Optional low-latency tunnel transport for the lease. */
export interface LeaseTransport {
  /** Broadcast our lease to peers. Resolves false if unreachable. */
  broadcast(lease: LeaseRecord): Promise<boolean>;
  /** The most-recent lease observed over the tunnel (and its source nonce map). */
  observed(): { lease: LeaseRecord | null; lastNonceByHolder: Record<string, number> };
  /** Whether the tunnel medium is currently reachable. */
  isReachable(): boolean;
}

export interface LeaseCoordinatorDeps {
  lease: FencedLease;
  store: LeaseStore;
  tunnel?: LeaseTransport;
  /** Machines presumed dead (lastSeen older than failoverThresholdMs). */
  presumedDeadHolders: () => ReadonlySet<string>;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Escalate an unresolvable split-brain (deduped per partitionEpisodeId by the caller's sink). */
  onEscalate?: (info: { partitionEpisodeId: string; holder: string; reason: string }) => void;
  /** Fired when the holder must self-suspend ingress (tunnel-renewal lapse). */
  onSelfSuspend?: (reason: string) => void;
  /** Fired whenever our effective epoch advances (drives leaseEpochChange → registry push). */
  onEpochAdvance?: (epoch: number) => void;
  logger?: (msg: string) => void;
}

export class LeaseCoordinator {
  private readonly d: LeaseCoordinatorDeps;
  private readonly fl: FencedLease;
  private nonceCounter = 0;
  private lastRenewOkAt: number;
  private lastObservedEpoch = 0;
  private suspended = false;
  /**
   * The freshest lease THIS machine has signed (acquisition or renewal). It is
   * the authoritative low-latency copy of our own holding — we broadcast it
   * over the tunnel, but git is only updated coarsely (on epoch change), so a
   * renewal's new expiry lives here, not in git. Folded into effectiveView only
   * while it is not superseded by a higher epoch.
   */
  private selfIssued: LeaseRecord | null = null;

  constructor(deps: LeaseCoordinatorDeps) {
    this.d = deps;
    this.fl = deps.lease;
    this.lastRenewOkAt = this.now();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private log(m: string): void {
    this.d.logger?.(`[lease] ${m}`);
  }
  private nextNonce(): number {
    return ++this.nonceCounter;
  }

  get selfMachineId(): string {
    return this.fl.selfMachineId;
  }
  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Compute the current effective epoch = max(tunnel-observed accepted, git).
   * A tunnel lease is folded in only if acceptTunnelLease passes (valid sig,
   * ≥ git floor, fresh nonce).
   */
  private effectiveView(): { lease: LeaseRecord | null; epoch: number; gitEpoch: number } {
    const git = this.d.store.read();
    let bestLease = git.lease;
    let epoch = git.epoch;
    if (this.d.tunnel) {
      const obs = this.d.tunnel.observed();
      if (obs.lease) {
        const decision = this.fl.acceptTunnelLease(obs.lease, git.epoch, obs.lastNonceByHolder);
        if (decision.accept && obs.lease.epoch > epoch) {
          bestLease = obs.lease;
          epoch = obs.lease.epoch;
        }
      }
    }
    // Fold in our own freshest self-issued lease (a renewal's new expiry lives
    // here, not in coarse git). Only while not superseded by a higher epoch.
    if (this.selfIssued && this.selfIssued.holder === this.selfMachineId && this.selfIssued.epoch >= epoch) {
      bestLease = this.selfIssued;
      epoch = this.selfIssued.epoch;
    }
    return { lease: bestLease, epoch, gitEpoch: git.epoch };
  }

  /** Does THIS machine currently hold a valid lease at the effective epoch? */
  holdsLease(): boolean {
    if (this.suspended) return false;
    const view = this.effectiveView();
    return this.fl.holdsValidLease(view.lease, view.epoch, this.now());
  }

  /** The current effective epoch (for stamping writes/sends). */
  currentEpoch(): number {
    return this.effectiveView().epoch;
  }

  currentHolder(): string | null {
    return this.effectiveView().lease?.holder ?? null;
  }

  /**
   * Attempt to acquire (or self-renew) the lease if eligible. Returns true if
   * THIS machine holds the lease afterward. Implements the bounded-retry CAS
   * with livelock backoff.
   */
  async acquireIfEligible(): Promise<boolean> {
    if (this.suspended) {
      // A suspended holder may resume only by re-acquiring cleanly below.
      this.suspended = false;
    }
    const dead = this.d.presumedDeadHolders();
    let retries = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const view = this.effectiveView();
      // Already hold it at the current epoch → just renew.
      if (view.lease && view.lease.holder === this.selfMachineId && !this.fl.isExpired(view.lease, this.now())) {
        return this.renew();
      }
      const decision = this.fl.canAcquire(view.lease, dead, this.now());
      if (!decision.can) {
        this.log(`acquire skipped: ${decision.reason}`);
        return false;
      }
      const candidate = this.fl.buildAcquisition(view.lease, this.now(), this.nextNonce());
      const res = this.d.store.casWrite(candidate);
      if (res.ok) {
        this.selfIssued = candidate;
        await this.broadcast(candidate);
        this.lastRenewOkAt = this.now();
        this.emitEpoch(candidate.epoch);
        this.log(`acquired lease at epoch ${candidate.epoch}`);
        return true;
      }
      // CAS lost — someone advanced. Re-evaluate against the observed state.
      const observedEpoch = res.observed.epoch;
      if (observedEpoch >= candidate.epoch) {
        this.log(`CAS lost to epoch ${observedEpoch} (our candidate ${candidate.epoch}) — yielding`);
        this.emitEpoch(observedEpoch);
        // If the winner is a presumed-dead/expired holder we'll retry; else stop.
        if (!this.fl.canAcquire(res.observed.lease, dead, this.now()).can) return false;
      }
      retries++;
      if (this.fl.shouldBackoffAfterContention(retries, res.observed.lease?.holder ?? '')) {
        this.log(`livelock backoff after ${retries} retries — yielding for ${this.fl.backoffMs}ms`);
        return false;
      }
    }
  }

  /**
   * Renew the held lease: re-sign with a fresh expiry, broadcast over the
   * tunnel, and (coarsely, via the store on epoch change) keep git current.
   * Returns false (and self-suspends) if the tunnel medium is configured but
   * has been unreachable for longer than the lease TTL.
   */
  async renew(): Promise<boolean> {
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId) return false;

    // Re-sign with a fresh expiry (same epoch — renewal never advances it).
    const renewed = this.fl.signLease(
      view.epoch,
      view.lease.acquiredAt,
      new Date(this.now() + this.fl.ttlMs).toISOString(),
      this.nextNonce(),
    );

    // Medium-agnostic renewal requirement: the renewal must be CONFIRMED over a
    // shared medium — the tunnel (reachable broadcast) when configured, else a
    // durable git refresh. A holder that cannot confirm over ANY medium for
    // > leaseTtlMs MUST self-suspend, rather than extend its lease locally
    // forever (which is exactly the partitioned-old-awake split-brain).
    let confirmed: boolean;
    if (this.d.tunnel) {
      confirmed = await this.d.tunnel.broadcast(renewed).catch(() => false);
    } else {
      confirmed = this.d.store.refresh(renewed);
    }

    if (confirmed) {
      this.selfIssued = renewed;
      this.lastRenewOkAt = this.now();
      return true;
    }

    if (this.now() - this.lastRenewOkAt > this.fl.ttlMs) {
      this.suspended = true;
      this.d.onSelfSuspend?.(
        `could not confirm lease over ${this.d.tunnel ? 'tunnel' : 'git'} for > leaseTtlMs (${this.fl.ttlMs}ms) — lease lapsed`,
      );
      this.log('self-suspended: renewal-confirmation lapse');
      return false;
    }
    // Within grace: keep serving on the EXISTING (soon-to-expire) lease — do
    // NOT extend selfIssued's expiry, so it lapses if we never reconfirm.
    return true;
  }

  private async broadcast(lease: LeaseRecord): Promise<void> {
    if (!this.d.tunnel) return;
    try {
      const ok = await this.d.tunnel.broadcast(lease);
      if (ok) this.lastRenewOkAt = this.now();
    } catch (err) {
      this.log(`broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private emitEpoch(epoch: number): void {
    if (epoch !== this.lastObservedEpoch) {
      this.lastObservedEpoch = epoch;
      this.d.onEpochAdvance?.(epoch);
    }
  }

  /**
   * Detection (signal only): does the synced state show contention the lease
   * cannot resolve (e.g. a presumed-dead holder we cannot demote because no
   * shared medium can advance the epoch)? Escalates ONCE per partition episode.
   */
  checkForUnresolvableSplit(partitionEpisodeId: string): void {
    const view = this.effectiveView();
    if (!view.lease) return;
    const dead = this.d.presumedDeadHolders();
    const holderDead = dead.has(view.lease.holder);
    const cannotAdvance = this.d.tunnel ? !this.d.tunnel.isReachable() : false;
    if (holderDead && cannotAdvance && view.lease.holder !== this.selfMachineId) {
      this.d.onEscalate?.({
        partitionEpisodeId,
        holder: view.lease.holder,
        reason: 'presumed-dead holder cannot be demoted — no shared medium to advance the epoch',
      });
    }
  }
}
