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
  /**
   * Force the local self-lease to read as expired (git-less relinquish, spec
   * §Problem A). Used by LeaseCoordinator.relinquish() to break a same-epoch
   * contested tie WITHOUT lowering the epoch floor. Optional: only the git-less
   * LocalLeaseStore implements it; a git-substrate store resolves contention via
   * CAS instead, so this is a no-op there.
   */
  forceLocalExpiry?(): void;
}

/** Optional low-latency tunnel transport for the lease. */
export interface LeaseTransport {
  /** Broadcast our lease to peers. Resolves false if unreachable. */
  broadcast(lease: LeaseRecord): Promise<boolean>;
  /** The most-recent lease observed over the tunnel (and its source nonce map). */
  observed(): { lease: LeaseRecord | null; lastNonceByHolder: Record<string, number> };
  /** Whether the tunnel medium is currently reachable. */
  isReachable(): boolean;
  /**
   * Cross-Machine Coherence — active PULL of a single peer's current lease over
   * the authenticated channel, folding the result into observed() via the same
   * receive path. Optional: a git-only mesh has no pull-capable transport.
   */
  pullPeer?(peer: { machineId: string; url: string }): Promise<LeaseRecord | null>;
  /** Best-effort fan-out pull of every peer's lease. Optional (see pullPeer). */
  pullAllPeers?(): Promise<void>;
}

export interface LeaseCoordinatorDeps {
  lease: FencedLease;
  store: LeaseStore;
  tunnel?: LeaseTransport;
  /** Machines presumed dead (lastSeen older than failoverThresholdMs). */
  presumedDeadHolders: () => ReadonlySet<string>;
  /**
   * Wall clock (injectable for tests). Used ONLY to stamp human-readable
   * `acquiredAt`/`expiresAt` ISO fields on lease records (display + the
   * liveness heuristic). It is NEVER the authority for whether THIS machine
   * still holds the lease — see `monotonicNow` (spec §L−1: a holder's own
   * expiry is judged on its monotonic-local clock, never wall-clock).
   */
  now?: () => number;
  /**
   * Monotonic clock (injectable for tests) — the AUTHORITY for the holder's
   * self-expiry / self-fence. Returns a strictly non-decreasing millisecond
   * reading (default `performance.now()`) that an NTP step, a VM pause/resume,
   * a sleep/wake, or a CPU-starvation clock jump CANNOT move backward. The
   * router-lease self-fence (spec §L−1 "TTL self-fence" + §L1) measures
   * "elapsed since my last confirmed renewal" on THIS clock, so a partitioned
   * or clock-chaotic holder goes quiet on its own reading before the TTL
   * elapses — independent of wall-clock. This is the LEASE-SUBSTRATE-ROBUSTNESS
   * fold-in and directly answers the SleepWakeDetector CPU-starvation lesson.
   */
  monotonicNow?: () => number;
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
  /**
   * Monotonic-clock reading at the last CONFIRMED renewal/acquisition — the
   * authority for the holder's self-fence (spec §L−1): an NTP step / VM pause /
   * sleep / CPU-starvation jump cannot move it backward, so a partitioned or
   * clock-chaotic holder still goes quiet on its own monotonic reading before
   * the TTL elapses. (Wall-clock is used only for the display `expiresAt`.)
   */
  private lastRenewOkMonoMs = 0;
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
    this.markRenewOk();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  /**
   * Monotonic clock — strictly non-decreasing, immune to wall-clock jumps (NTP
   * step, VM pause/resume, sleep/wake, CPU-starvation timer slip). Default uses
   * `process.hrtime`. The authority for the holder's self-expiry/self-fence
   * (spec §L−1); injectable for tests.
   */
  private monotonicNow(): number {
    if (this.d.monotonicNow) return this.d.monotonicNow();
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
  /**
   * Record a CONFIRMED renewal/acquisition on the monotonic self-fence clock.
   * Called wherever a renewal/acquisition/broadcast is confirmed over a medium.
   */
  private markRenewOk(): void {
    this.lastRenewOkMonoMs = this.monotonicNow();
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
        // acceptTunnelLease re-checks signature + git-floor + nonce-replay. The
        // transport already replay-guarded obs.lease on RECEIVE (recordObserved),
        // and by design its watermark for obs.lease's holder == obs.lease.nonce —
        // so passing the raw watermark here would self-reject the very lease we're
        // validating (nonce <= watermark). Exclude obs.lease's own holder from the
        // nonce floor so a genuine standby broadcast is folded in; the transport
        // remains the replay guard and the signature/git-floor checks still run.
        // (2026-05-31: this self-rejection silently broke the git-less tunnel-
        // observe path — a standby never learned the holder → MeshRpc not-router.)
        const { [obs.lease.holder]: _self, ...nonceFloor } = obs.lastNonceByHolder;
        void _self;
        const decision = this.fl.acceptTunnelLease(obs.lease, git.epoch, nonceFloor);
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
    if (!this.fl.holdsValidLease(view.lease, view.epoch, this.now())) return false;
    // Monotonic self-fence (spec §L−1): even if the wall-clock `expiresAt` has
    // not passed, a holder that has not CONFIRMED a renewal within ttlMs on its
    // MONOTONIC clock must NOT act — this is immune to NTP steps / VM-pause /
    // sleep / CPU-starvation clock jumps that could otherwise fool the
    // wall-clock check into believing a lapsed lease is still live. The
    // wall-clock `isExpired` check above is retained as a conservative second
    // gate (either gate may fence; both must pass to hold).
    if (this.monotonicNow() - this.lastRenewOkMonoMs > this.fl.ttlMs) return false;
    return true;
  }

  /** The current effective epoch (for stamping writes/sends). */
  currentEpoch(): number {
    return this.effectiveView().epoch;
  }

  currentHolder(): string | null {
    return this.effectiveView().lease?.holder ?? null;
  }

  /**
   * The current effective-view signed lease (max of tunnel-observed, git-committed,
   * and this machine's self-issued renewal), or null. Used to SERVE an active PULL
   * (POST /api/lease/pull, Cross-Machine Coherence): a peer asks for our lease and
   * we return this. Includes the holder's self-issued lease (which the transport's
   * observed() — receive-only — does not), so a holder serves its own current lease.
   */
  currentLease(): LeaseRecord | null {
    return this.effectiveView().lease;
  }

  /**
   * Relinquish this machine's claim to break a same-epoch contested tie (spec
   * §Problem A — the deterministic loser, lower-`machineId` LOSES is FALSE: the
   * lower machineId WINS, the higher relinquishes). Two effects, both required
   * for convergence:
   *  (a) clears `selfIssued` AND forces the local store's persisted self-lease to
   *      read as expired — so we stop being a "live holder at epoch N": the
   *      winner's `canAcquire()` no longer returns `held-by-live-peer` (it can
   *      now advance to N+1) and our `holdsLease()` returns false (we reconcile
   *      to standby);
   *  (b) we then ADOPT the winner's N+1 lease via the strict-`>` tunnel fold in
   *      effectiveView() (N+1 > N), so currentHolder() names the winner.
   * Idempotent. The caller (MultiMachineCoordinator's contested branch) latches
   * this ONE-SHOT per contested episode so we do not re-clear+re-acquire every
   * tick (which would re-introduce the leapfrog). The epoch FLOOR is preserved
   * (forceLocalExpiry keeps the committed epoch) so a replayed stale lease can't
   * win after we relinquish.
   */
  relinquish(): void {
    this.selfIssued = null;
    this.d.store.forceLocalExpiry?.();
    this.log('relinquished self-lease (contested tie-break loser) — winner may now advance to N+1');
  }

  /**
   * Force a ONE-TIME epoch advance to resolve a same-epoch contested tie (spec
   * §Problem A — the WINNER side, lower `machineId`). Unlike acquireIfEligible(),
   * which RENEWS the same epoch when we already hold it, this builds the NEXT
   * epoch (N+1) and CAS-writes it, establishing a strictly-higher signed lease
   * that the contested peer (the loser, having relinquished) adopts via the
   * strict-`>` tunnel fold. The caller latches this ONE-SHOT per contested
   * episode (NOT per tick), so it is a tie-resolution, never a per-tick bump →
   * no leapfrog. Routes through the SAME casWrite/broadcast/sign path as a normal
   * acquisition. Returns true if the advance landed (or we already hold a
   * strictly-higher epoch). Idempotent against a peer that advanced first.
   */
  async advanceEpochForContestedWin(): Promise<boolean> {
    const view = this.effectiveView();
    // buildAcquisition writes currentEpoch+1; currentEpoch is max(self@N, peer@N)=N.
    const candidate = this.fl.buildAcquisition(view.lease, this.now(), this.nextNonce());
    const res = this.d.store.casWrite(candidate);
    if (res.ok) {
      this.selfIssued = candidate;
      await this.broadcast(candidate);
      this.markRenewOk();
      this.emitEpoch(candidate.epoch);
      this.log(`advanced to epoch ${candidate.epoch} to resolve contested same-epoch tie (winner)`);
      return true;
    }
    // CAS lost — a strictly-higher epoch already exists (a peer advanced first);
    // adopt it. Either way the same-epoch tie is broken.
    this.emitEpoch(res.observed.epoch);
    this.log(`contested-win advance lost CAS to epoch ${res.observed.epoch} — adopting the higher lease`);
    return res.observed.lease?.holder === this.selfMachineId;
  }

  /**
   * Whether the attached transport can actively PULL peer leases (Cross-Machine
   * Coherence). False on a git-only mesh — the standby pull loop is then a no-op.
   */
  canPullPeers(): boolean {
    return typeof this.d.tunnel?.pullAllPeers === 'function';
  }

  /**
   * Active-pull every peer's current lease over the tunnel and fold the freshest
   * into our observed view (the transport's recordObserved path). Safe no-op when
   * the transport has no pull capability. Awaiting this then reading holdsLease()/
   * observedPeerLease() reflects whatever a peer just disclosed.
   */
  async pullFromPeers(): Promise<void> {
    if (this.d.tunnel?.pullAllPeers) await this.d.tunnel.pullAllPeers();
  }

  /**
   * The RAW lease most-recently observed from a peer (push or pull), independent
   * of our own self-issued/git view. effectiveView()'s max() masks a *same-epoch*
   * peer (our self-issued wins the tie), so the standby pull loop reads this to
   * detect a same-epoch contested split-brain that currentHolder() would hide.
   */
  observedPeerLease(): LeaseRecord | null {
    return this.d.tunnel?.observed().lease ?? null;
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
        this.markRenewOk();
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
   * Consented planned-handoff acquisition (spec §8 G3e). The incoming machine
   * takes the lease while the OUTGOING is still alive — which the liveness-gated
   * acquireIfEligible() correctly refuses. This path is reachable ONLY from the
   * onYield handler, which fires only on an authenticated POST /api/handoff/yield
   * after the outgoing verified the ack + passed validation. The existing
   * split-brain-critical canAcquire() gate is deliberately left UNTOUCHED — this
   * is an additive consent path, not a weakening of the liveness rule.
   *
   * Security guard: the yielding machine MUST be the holder we currently observe.
   * A yield from any non-holder is refused, so a forged/misdirected yield cannot
   * trigger a takeover. On success: CAS to epoch+1, broadcast, emit the new epoch.
   */
  async acquireOnConsent(yieldFromMachineId: string): Promise<boolean> {
    const view = this.effectiveView();
    const holder = view.lease?.holder ?? null;
    if (holder && holder === this.selfMachineId) {
      return true; // already ours — nothing to do
    }
    if (holder && holder !== yieldFromMachineId) {
      this.log(`consent acquire refused: yield from ${yieldFromMachineId} but current holder is ${holder}`);
      return false;
    }
    const candidate = this.fl.buildAcquisition(view.lease, this.now(), this.nextNonce());
    const res = this.d.store.casWrite(candidate);
    if (res.ok) {
      this.selfIssued = candidate;
      await this.broadcast(candidate);
      this.markRenewOk();
      this.emitEpoch(candidate.epoch);
      this.log(`acquired lease on consent at epoch ${candidate.epoch} (yield from ${yieldFromMachineId})`);
      return true;
    }
    // CAS lost — someone already advanced; adopt the observed epoch and stand down.
    this.emitEpoch(res.observed.epoch);
    this.log(`consent acquire lost CAS to epoch ${res.observed.epoch}`);
    return false;
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
      this.markRenewOk();
      return true;
    }

    if (this.monotonicNow() - this.lastRenewOkMonoMs > this.fl.ttlMs) {
      this.suspended = true;
      this.d.onSelfSuspend?.(
        `could not confirm lease over ${this.d.tunnel ? 'tunnel' : 'git'} for > leaseTtlMs (${this.fl.ttlMs}ms, monotonic) — lease lapsed`,
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
      if (ok) this.markRenewOk();
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
