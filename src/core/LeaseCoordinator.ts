import {NativeDecommissionLeasePermit} from './NativeDecommissionLeasePermit.js';
import {LocalLeaseStore} from './LocalLeaseStore.js';
import {GitLeaseStore} from './GitLeaseStore.js';
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

import { FencedLease, type StaleHolderTakeoverOpts, type HandbackConsentToken } from './FencedLease.js';
import type { LeaseRecord } from './types.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import {
  resolveWindowMs, pendingCadenceMs, evaluateEpisodeEnd, bootDurationMs, silenceIsEvidence, ASK_DEADLINE_MS, EPISODE_CAP_MS,
  type ContinuityFile, type ContinuityMeta, type LeaseContinuityStore,
} from './LeaseContinuity.js';
import type { RestartAnnounce, RestartAnnounceOutcome } from './restartRequestSignal.js';
import type { RestartRequestFind } from './restartRequestAttribution.js';
import {
  evaluateBootHold,
  classifyPeer,
  unsignedAnswerWindowMs,
  UNSIGNED_WINDOW_CEILING_MS,
  DEFAULT_BOOT_HOLD_SETTINGS,
  type BootHoldVerdict,
  type PeerProbeRecord,
  type ProbeAnswer,
} from './BootClaimHold.js';

/** takeover-ready-pool R1 — the boot claim safety switch and its values, read live. */
export interface BootClaimSafetySettings {
  enabled: boolean;
  /** The named preferred machine (`leaseSelfHeal.preferredAwakeMachineId`), or null. */
  preferredMachineId: string | null;
  silentProbes?: number;
  silentSpanMs?: number;
}

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
  /**
   * True when this store is only this machine's own copy, so nothing durable tells it what a
   * peer did while it was down. A takeover made meanwhile can then only be learned by asking.
   */
  hasNoSharedMedium?(): boolean;
  /**
   * planned-restart-keeps-lead §1 step 4 — the pending marker on this machine's own stored record (a
   * local store only): set with every pending renewal, cleared by the confirmed boot renewal, by
   * relinquish and at an episode's end. Optional: a git store carries no marker (the continuity file
   * is the only local copy there).
   */
  readPendingEpisodeId?(): string | null;
  refreshWithPending?(lease: LeaseRecord, pendingEpisodeId: string | null): boolean;
  clearPendingEpisodeId?(): void;
  /**
   * Pull the latest durable state into the local view WITHOUT writing.
   * Used to prime a freshly-booted/joined machine with fresh data before its
   * first failover-eligibility decision — otherwise it evaluates
   * presumedDeadHolders against a STALE seed `lastSeen` (the holder's timestamp
   * from when the repo was seeded/cloned) and wrongly grabs a live holder's
   * lease (verified live on a two-machine mesh, 2026-05-28). Optional; a no-op
   * for stores that always read fresh.
   */
  syncDown?(): void;
}

/** Optional low-latency tunnel transport for the lease. */
export interface LeaseTransport {
  /**
   * Broadcast our lease to peers. Resolves false if unreachable. `onLateConfirm`
   * (optional) fires once if a peer confirms this lease after the call already
   * resolved false on its deadline.
   */
  broadcast(lease: LeaseRecord, onLateConfirm?: () => void): Promise<boolean>;
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
  /**
   * Per-peer lease-observation view (machine-coherence-guard §5b): what each
   * peer most recently disclosed as its lease view + when it was observed.
   * Optional — a git-only mesh has no pull-capable transport. Advisory data
   * (L4/SEC-4): feeds the awakeMachineCount counting rule, never demotion.
   */
  observedByPeer?(): Map<string, { lease: LeaseRecord | null; observedAtMs: number }>;
  /**
   * Highest epoch a peer reported in a VERIFIED broadcast ack above the epoch we
   * sent (0/absent = none). A monotonic high-water mark; any epoch below it is
   * superseded and fenced (holdsLease, renew and solo hold all refuse it).
   */
  higherEpochEvidence?(): number;
  /** takeover-ready-pool R1 — per-peer probe records of lease pulls since boot. Optional. */
  probeHistory?(): Map<string, PeerProbeRecord>;
  /** takeover-ready-pool R1 — the peers this transport can dial (excludes self). Optional. */
  knownPeerIds?(): string[];
  /** planned-restart-keeps-lead §2 — per-peer identity-verified pull answers (copies). Optional. */
  verifiedAnswers?(): Map<string, { lease: LeaseRecord | null; atMs: number; round: number }>;
  /** planned-restart-keeps-lead §2 — the current pull round and its start. Optional. */
  currentPullRound?(): { round: number; startedAtMs: number };
  /** planned-restart-keeps-lead §2 — be told when a probe lands. Optional; returns a detach. */
  attachProbeListener?(listener: (peerId: string, answer: ProbeAnswer, round: number) => void): () => void;
}

export interface LeaseCoordinatorDeps {
  lease: FencedLease;
  store: LeaseStore;
  tunnel?: LeaseTransport;
  /** Machines presumed dead (lastSeen older than failoverThresholdMs). */
  presumedDeadHolders: (opts?: { liveness?: boolean }) => ReadonlySet<string>;
  /**
   * a2a-single-agent-identity §1.1 — lease ELIGIBILITY, read live on every acquire tick. A
   * machine in `identity-not-provisioned` posture answers false: it declines to acquire the
   * serving lease and RELINQUISHES one it holds (an unprovisioned lease holder would take the
   * whole fleet off the agent network — it holds the one relay connection and cannot use it).
   * Absent ⇒ eligible (single-machine installs and every pre-existing caller are unchanged).
   */
  isLeaseEligible?: () => boolean;
  /** Live switch getters; absent means enabled. */
  getLivenessEnabled?: () => boolean;
  getUnconfirmedWriteAlertEnabled?: () => boolean;
  /** Samples liveness feeder health before each lease decision cycle. */
  sampleLiveness?: () => void;
  /** Reporting-only sink for sustained unconfirmed acquisition writes. */
  reportDegradation?: (event: { feature: string; primary: string; fallback: string; reason: string; impact: string; internalOnly?: boolean }) => void;
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
  /**
   * F2 (multi-machine-lease-self-heal staleHolderTakeover) — resolved live so a
   * config flip needs no restart. null/disabled ⇒ canAcquire is byte-for-byte the
   * legacy behavior. When enabled, a standby may take over a holder whose signed
   * nonce watermark hasn't advanced for `ttlMs × nonRenewalMissedObservations` of
   * the OBSERVER's own monotonic time (skew-immune; the takeover stays CAS-fenced).
   */
  staleHolderTakeover?: () => { enabled: boolean; nonRenewalMissedObservations: number } | null;
  /**
   * multi-transport-mesh-comms Layer 3 (soloCaptainHold) — resolved live; DARK by
   * default (null/disabled ⇒ renew() is byte-for-byte today's self-fence). When
   * enabled AND all three preconditions hold, a preferred stationary captain that
   * cannot confirm its renewal over ANY rope HOLDS its lease (same epoch) instead
   * of self-suspending. The preconditions are SIGNALS consumed here, never
   * authority invented here:
   *   - isPreferredAwakeAgreed(): this machine is the F4-agreed preferred-awake
   *     machine (NOT a raw-config read — the agreement signal from the coordinator).
   *   - allPeersPresumedGone(): every peer is presumed-gone by liveness-silence
   *     (the EXISTING presumedDeadHolders timeout), i.e. positively aged-out, not
   *     merely unreachable this tick.
   *   - no higher epoch observed (checked inline against the effective view).
   * The monotonic self-fence stays armed whenever allPeersPresumedGone() is false,
   * so a merely-unreachable-but-recently-alive peer can NEVER keep the captain
   * alive — only a liveness-aged-out one can. store.refresh is NOT used as
   * evidence (a tautology on LocalLeaseStore). Spec: docs/specs/multi-transport-mesh-comms.md.
   */
  soloCaptainHold?: () => { enabled: boolean } | null;
  /** F4-agreed preferred-awake signal (consumed by Layer 3 — never the raw config). */
  isPreferredAwakeAgreed?: () => boolean;
  /** True iff EVERY peer is presumed-gone by liveness-silence (Layer 3 gate). */
  allPeersPresumedGone?: () => boolean;
  /**
   * lease-takeover-no-shared-medium: true when this machine has a peer and no machine is
   * named preferred, read live. Absent or false keeps today's behaviour exactly, so a
   * single machine and a pool with a named captain are untouched.
   */
  survivorMayHold?: () => boolean;
  /**
   * session-pool-takeover-at-pairing: a joined machine that has not yet proved a lasting link to
   * its peer. It cannot tell a dead peer from a lost one, so it does not take the lease at all.
   */
  acquireHeldBack?: () => boolean;
  /**
   * takeover-ready-pool R1 (boot claim safety, fb-2bf6ccd0-705) — read live. Off or absent
   * keeps today's acquisition exactly. On: an own-lapsed or empty lease always asks the peers
   * first, whatever survivorMayHold/soloCaptainHold/preferred say, and no claim is made until
   * the boot hold ends (BootClaimHold.ts).
   */
  bootClaimSafety?: () => BootClaimSafetySettings | null;
  /**
   * takeover-ready-pool R5 seam — a peer's published restart time (p95 ms), which bounds how
   * long its unsigned answers count. Absent or null ⇒ the interim window.
   */
  peerRestartBudgetMs?: (machineId: string) => number | null;
  /**
   * planned-restart-keeps-lead — read live. Off or absent keeps today's renewal exactly; the boot
   * side (rule 1b) is keyed on the disk state whatever this says. `windowMs` replaces the measured
   * base of the window.
   */
  plannedRestartContinuity?: () => { enabled: boolean; windowMs: number | null } | null;
  /** planned-restart-keeps-lead — this machine's continuity file and restart budget. */
  continuity?: LeaseContinuityStore;
  /** The renew tick's normal cadence (the pending cadence derives from it). */
  renewIntervalMs?: () => number;
  /** The transport's resolved broadcast deadline (8 s with default settings). */
  broadcastDeadlineMs?: () => number;
  /** The resolved shutdown deadline, for the consumed-but-alive exit of the episode rule. */
  shutdownDeadlineMs?: () => number;
  /** Whether `state/restart-requested.json` exists, and what it says. */
  readRequestFile?: () => { present: boolean; requestedBy?: string | null; reason?: string | null; requestedAt?: string | null };
  /** The restart ledger's by-request lookup (findRestartRequestRecord bound to the state dir). */
  findConsumption?: (lookup: { requestedAt: string | null; sinceMs: number }) => RestartRequestFind;
  /** The role this machine booted with (null until known): a role-change request on a standby boot marks a late promotion. */
  bootRoleAwake?: () => boolean | null;
  /** Fired when a pending episode opens or ends, so the coordinator can re-arm the renew cadence. */
  onEpisodeChange?: (pending: boolean) => void;
  logger?: (msg: string) => void;
}

/** planned-restart-keeps-lead §1 step 3 — one open restart episode on this holder. */
interface PendingEpisode {
  id: string;
  openedAtMs: number;
  requestedBy: string;
  reason: string;
  requestedAt: string | null;
  windowMs: number;
  windowClampLogged: boolean;
  fileLastSeenMs: number | null;
  filePresent: boolean;
  consumptionAtMs: number | null;
  ledgerLookedUp: boolean;
  /** The last ledger read's coverage, latched: a cut or unreadable read is retried, never promoted to full. */
  ledgerCoverage: 'full' | 'cut' | 'unreadable' | null;
  extendLogged: boolean;
  lastWindowLease: LeaseRecord | null;
  confirmed: boolean;
  heldRowWritten: boolean;
  lastHourlyLogMs: number;
  afterLatePromotion: boolean;
  announcedAtMs: number | null;
  publishSettledAtMs: number | null;
}

/** planned-restart-keeps-lead §2 — the window lease found on disk at construction, until its verdict. */
interface BootReclaim {
  lease: LeaseRecord;
  file: ContinuityFile | null;
  storeEpisodeId: string | null;
  startedAtMono: number;
  unconfirmedLogged: boolean;
  verdict: 'confirmed' | 'superseded' | 'survivor-hold' | 'lapsed' | null;
}

export type ReclaimVerdict = 'confirmed' | 'superseded' | 'survivor-hold' | 'lapsed' | 'timeout';

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
  private lastRenewOkMonoMs: number | null = 0;
  /** The nonce of the last renewal a peer confirmed in this process (the exit stamp names it). */
  private lastConfirmedNonce: number | null = null;
  /** planned-restart-keeps-lead — the open restart episode, if any. */
  private episode: PendingEpisode | null = null;
  /** A request that reached the four-hour cap opens nothing until the file changes. */
  private cappedRequest: { requestedAt: string | null; requestedBy: string } | null = null;
  /** planned-restart-keeps-lead §2 — the window lease found at construction, awaiting its verdict. */
  private bootReclaim: BootReclaim | null = null;
  private reclaimWaiters: Array<(v: ReclaimVerdict) => void> = [];
  /** Peers logged once as alive-and-unknown (every route refused on this machine's side). */
  private reclaimUnknownLogged = new Set<string>();
  private lastObservedEpoch = 0;
  private suspended = false;
  /**
   * The renewal whose own early broadcast deadline caused the current suspension
   * (null otherwise). That deadline is provisional — the dials are still in flight —
   * so a late verified confirmation of EXACTLY this renewal may still finish it
   * (adoptLateRenewal). Any other suspension stays terminal until re-acquire.
   */
  private suspendedByRenewal: LeaseRecord | null = null;
  /**
   * Epoch acquired from a PEER through the normal fenced takeover authority.
   * When this machine is the preferred captain, this is positive evidence that
   * it may keep that exact epoch alive while the peer remains unreachable:
   * acquisition already proved expired/dead/non-renewing and won the CAS.
   * Process-local and epoch-bound by design; restart forgets it (fail-closed)
   * and any higher observed epoch makes it inapplicable.
   */
  private peerTakeoverAuthorizedEpoch: number | null = null;
  /**
   * The freshest lease THIS machine has signed (acquisition or renewal). It is
   * the authoritative low-latency copy of our own holding — we broadcast it
   * over the tunnel, but git is only updated coarsely (on epoch change), so a
   * renewal's new expiry lives here, not in git. Folded into effectiveView only
   * while it is not superseded by a higher epoch.
   */
  private selfIssued: LeaseRecord | null = null;
  /**
   * Bumped by relinquish(). A renewal whose broadcast was in flight when this
   * machine gave the lease up must never re-install it (on time or late):
   * relinquish only force-expires the local lease, so holder/epoch/released alone
   * cannot tell a relinquished lease from a live one.
   */
  private relinquishGeneration = 0;
  /**
   * F2 (staleHolderTakeover) — per-holder freshness on the OBSERVER's own
   * monotonic clock: the time we last saw that holder's signed nonce watermark
   * ADVANCE (a renewing holder bumps its nonce each renew). Stamped only when a
   * VERIFIED observed lease's nonce strictly exceeds the last we recorded for
   * that holder. `lastObservedNonce` is the per-holder high-water nonce that
   * gates the stamp. Single-clock ⇒ clock-skew immune; the holder cannot forge
   * freshness (the nonce is inside its Ed25519 signature).
   */
  private freshObservedMonoMs = new Map<string, number>();
  private lastObservedNonce = new Map<string, number>();
  private lastObservedNonceEpoch = new Map<string, number>();
  private unconfirmedWriteCount = 0;
  private unconfirmedWriteReported = false;
  /** Evidence only: the open solo-captain hold episode, so a hold records once, not per renew. */
  private soloHoldEvidenceEpoch: number | null = null;
  /** Evidence only: the last stale-holder takeover, to notice that holder renewing soon after. */
  private staleTakeoverEvidence: { holder: string; epoch: number; atMono: number } | null = null;

  /** takeover-ready-pool R1 — the boot hold, latched off once it ends (process-local). */
  private bootHoldEnded = false;
  private bootHoldLastLogged: string | null = null;
  /** This machine's own lease record as read at construction (before any pull): rule 1/4. */
  private readonly bootOwnRecord: { heldLast: boolean; epoch: number };

  constructor(deps: LeaseCoordinatorDeps) {
    this.d = deps;
    this.fl = deps.lease;
    let boot = { heldLast: false, epoch: 0 };
    try {
      const own = deps.store.read();
      boot = { heldLast: own.lease?.holder === deps.lease.selfMachineId, epoch: own.epoch ?? 0 };
    } catch {
      // @silent-fallback-ok: an unreadable own record means epoch 0, so any peer epoch is newer and nothing is claimed from it
    }
    this.bootOwnRecord = boot;
    // planned-restart-keeps-lead §2 — a window lease on disk (a continuity file, or a local store
    // record bearing the pending marker) is not held until a peer confirms: leave the fence "never
    // confirmed" (null; a zero would pass whenever process.hrtime reads under one TTL) and remember
    // the lease for rule 1b. Keyed on the disk state whatever the switches say, so a rollback cannot
    // reopen the hole. An ordinary unexpired record primes the fence as today.
    const reclaim = this.readWindowLeaseAtBoot(deps);
    if (reclaim) {
      this.bootReclaim = reclaim;
      this.lastRenewOkMonoMs = null;
      if (reclaim.file) {
        // The fold (§2): the file's renewal is this machine's freshest own record, so the view sees its
        // window expiry (a git store only holds the acquisition) and the nonce floor starts above it.
        this.selfIssued = reclaim.lease;
        if (Number.isSafeInteger(reclaim.lease.nonce) && reclaim.lease.nonce <= Math.floor((deps.now ?? Date.now)()) + LeaseCoordinator.NONCE_SEED_MAX_AHEAD_MS) {
          this.nonceCounter = Math.max(this.nonceCounter, reclaim.lease.nonce);
        }
      }
    } else {
      this.markRenewOk();
    }
  }

  /** The fold (§2 "The fold"): the continuity file's lease over the store's own record, when it verifies. */
  private readWindowLeaseAtBoot(deps: LeaseCoordinatorDeps): BootReclaim | null {
    let stored: LeaseRecord | null = null;
    try { stored = deps.store.read().lease; } catch { stored = null; } // @silent-fallback-ok: an unreadable store is no window lease
    const self = deps.lease.selfMachineId;
    const storeEpisodeId = deps.store.readPendingEpisodeId?.() ?? null;
    const storeIsSelf = !!stored && stored.holder === self && !stored.released;
    const storeVerifies = storeIsSelf && deps.lease.verifyLease(stored!);
    const now = (deps.now ?? Date.now)();
    let file: ContinuityFile | null = null;
    if (deps.continuity) {
      const r = deps.continuity.read();
      if (r.verdict === 'ok' && r.file) {
        const f = r.file;
        // Folds only when the store's own record verifies (a relinquished local record has its expiry
        // rewritten under the signature) and the file names the store's epoch at a higher nonce — or
        // the same nonce with an identical record, the local store having the same renewal.
        const sameEpoch = !!stored && f.lease.epoch === stored.epoch;
        const higherNonce = !!stored && f.lease.nonce > stored.nonce;
        const identical = !!stored && f.lease.nonce === stored.nonce && JSON.stringify(f.lease) === JSON.stringify(stored);
        if (storeVerifies && sameEpoch && (higherNonce || identical)) file = f;
        else this.discardContinuity(deps, f, !storeVerifies ? 'the stored record does not verify or was relinquished' : !sameEpoch ? 'the stored epoch moved past it' : 'its nonce is not newer than the stored record');
      } else if (r.file || r.verdict === 'unreadable') {
        this.discardContinuity(deps, r.file, r.verdict);
      }
    }
    const lease = file ? file.lease : (storeVerifies && storeEpisodeId ? stored : null);
    if (!lease || deps.lease.isExpired(lease, now)) {
      // No usable window lease: a marker left on the store must not make the NEXT boot a planned one.
      if (storeEpisodeId) { try { deps.store.clearPendingEpisodeId?.(); } catch { /* @silent-fallback-ok: cleared by the next ordinary write */ } }
      return null;
    }
    return { lease, file, storeEpisodeId, startedAtMono: 0, unconfirmedLogged: false, verdict: null };
  }

  /** Measure what can be measured, then delete and say why (§2 "The fold"). */
  private discardContinuity(deps: LeaseCoordinatorDeps, file: ContinuityFile | null, reason: string): void {
    if (file?.meta && deps.continuity) {
      const ms = bootDurationMs({ nowMs: (deps.now ?? Date.now)(), exitedAt: file.meta.exitedAt, renewedAt: file.meta.renewedAt, consumptionAtMs: null });
      if (ms !== null) deps.continuity.appendBootSample(ms, 'discarded', 'none');
    }
    deps.continuity?.delete();
    deps.logger?.(`[lease] lease-continuity: the continuity record left by the last restart is not usable here (${reason}); the record is discarded.`);
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
  private markRenewOk(confirmedNonce: number | null = null): void {
    this.lastRenewOkMonoMs = this.monotonicNow();
    if (confirmedNonce !== null) this.lastConfirmedNonce = confirmedNonce;
  }
  /**
   * ACT-1308 — milliseconds since the last CONFIRMED renewal/acquisition on the
   * monotonic self-fence clock. renew() returns true inside the grace window even
   * when the broadcast went unconfirmed, so a caller that wants to retry an
   * unconfirmed renewal before the fence lapses reads this instead.
   */
  msSinceConfirmedRenewal(): number | null {
    if (this.lastRenewOkMonoMs === null) return null;
    return this.monotonicNow() - this.lastRenewOkMonoMs;
  }
  private log(m: string): void {
    this.d.logger?.(`[lease] ${m}`);
  }
  private static readonly NONCE_SEED_MAX_AHEAD_MS = 365 * 24 * 3600 * 1000;
  private nonceFloorPrimed = false;
  /** Strictly increasing, at least the wall-clock milliseconds, and above this
   * machine's own durable lease nonce. The floor is read once, only from a
   * signature-verified own lease with a safe-integer nonce: a network
   * observation can never seed it, so a forged lease cannot poison the counter. */
  private nextNonce(): number {
    if (!this.nonceFloorPrimed) {
      this.nonceFloorPrimed = true;
      try {
        const durable = this.d.store.read().lease;
        // The seed must also sit within a year of the wall clock: a verified but
        // absurd nonce near MAX_SAFE_INTEGER would otherwise exhaust the counter.
        if (durable && durable.holder === this.selfMachineId && Number.isSafeInteger(durable.nonce)
            && durable.nonce <= Math.floor(this.now()) + LeaseCoordinator.NONCE_SEED_MAX_AHEAD_MS
            && this.fl.verifyLease(durable)) {
          this.nonceCounter = Math.max(this.nonceCounter, durable.nonce);
        }
      } catch {
        // @silent-fallback-ok — the wall-clock seed below still applies; a
        // failed read only loses the extra floor, never monotonicity.
      }
    }
    this.nonceCounter = Math.max(this.nonceCounter + 1, Math.floor(this.now()));
    return this.nonceCounter;
  }

  get selfMachineId(): string {
    return this.fl.selfMachineId;
  }
  get isSuspended(): boolean {
    return this.suspended;
  }

  freshRenewalWithin(machineId: string, ms: number): boolean {
    const observed = this.freshObservedMonoMs.get(machineId);
    return observed !== undefined && this.monotonicNow() - observed <= ms;
  }

  lastRenewalObservedMono(machineId: string): number | undefined {
    return this.freshObservedMonoMs.get(machineId);
  }

  sampleLiveness(): void {
    this.syncUnconfirmedWriteAlertState();
    try {
      this.d.sampleLiveness?.();
    } catch (err) {
      // @silent-fallback-ok — sampling is diagnostic-only and must never stop lease work.
      this.log(`liveness sampling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private syncUnconfirmedWriteAlertState(): boolean {
    const enabled = this.d.getUnconfirmedWriteAlertEnabled?.() ?? true;
    if (!enabled) {
      this.unconfirmedWriteCount = 0;
      this.unconfirmedWriteReported = false;
    }
    return enabled;
  }

  private recordCasWrite(candidate: LeaseRecord, result: ReturnType<LeaseStore['casWrite']>): void {
    if (!this.syncUnconfirmedWriteAlertState()) return;
    const observed = result.observed.lease;
    const ownCandidateFailure = !result.ok && !!observed &&
      observed.holder === this.selfMachineId &&
      observed.epoch === candidate.epoch &&
      observed.nonce === candidate.nonce;
    if (!ownCandidateFailure) {
      this.unconfirmedWriteCount = 0;
      this.unconfirmedWriteReported = false;
      return;
    }
    this.unconfirmedWriteCount++;
    if (this.unconfirmedWriteCount === 5 && !this.unconfirmedWriteReported) {
      this.unconfirmedWriteReported = true;
      try {
        this.d.reportDegradation?.({
          feature: 'lease.unconfirmed-acquisition-write',
          primary: 'Lease acquisition writes confirmed by the shared medium',
          fallback: 'Continue fenced lease reconciliation with the observed read-back',
          reason: 'lease writes remain unconfirmed by the medium',
          impact: 'Repeated acquisition candidates may not be reaching the shared lease medium.',
          internalOnly: true,
        });
      } catch (err) {
        // @silent-fallback-ok — reporting is diagnostic-only and cannot abort lease authority.
        this.log(`unconfirmed-write reporting failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private casWrite(candidate: LeaseRecord): ReturnType<LeaseStore['casWrite']> {
    const result = this.d.store.casWrite(candidate);
    this.recordCasWrite(candidate, result);
    return result;
  }

  /**
   * On a store holding only this machine's copy, nothing durable says what a peer did meanwhile,
   * so one number can be reached by both machines. Our copy at that number, once expired, says
   * nothing: a peer's later-expiring lease there is the truth. Without this the machine would
   * keep naming itself, serve its dead copy to the live holder, and read as a tie.
   */
  private peerOutranksLapsedSelf(peer: LeaseRecord, stored: LeaseRecord | null): boolean {
    if (!this.d.store.hasNoSharedMedium?.()) return false;
    if (peer.holder === this.selfMachineId || peer.released) return false;
    const own = this.selfIssued?.epoch === peer.epoch ? this.selfIssued : stored;
    if (!own || own.holder !== this.selfMachineId || !this.fl.isExpired(own, this.now())) return false;
    return new Date(peer.expiresAt).getTime() > new Date(own.expiresAt).getTime();
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
    let peerOutranksSelf = false;
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
        if (decision.accept) {
          // F2 freshness stamp (VERIFIED fold-in): a renewing holder bumps its
          // signed nonce each renew (same OR higher epoch), so its watermark
          // advances; a non-renewing holder's stops. Stamp the OBSERVER's own
          // monotonic time when a peer holder's nonce watermark strictly advances.
          const prevNonce = this.lastObservedNonce.get(obs.lease.holder) ?? -1;
          const prevEpoch = this.lastObservedNonceEpoch.get(obs.lease.holder) ?? -1;
          if (obs.lease.holder !== this.selfMachineId &&
              (obs.lease.epoch > prevEpoch || (obs.lease.epoch === prevEpoch && obs.lease.nonce > prevNonce))) {
            this.lastObservedNonceEpoch.set(obs.lease.holder, obs.lease.epoch);
            this.lastObservedNonce.set(obs.lease.holder, obs.lease.nonce);
            this.freshObservedMonoMs.set(obs.lease.holder, this.monotonicNow());
            if (this.staleTakeoverEvidence?.holder === obs.lease.holder) {
              const sinceMs = this.monotonicNow() - this.staleTakeoverEvidence.atMono;
              if (sinceMs <= 10 * 60_000) {
                featureEvidence.record('multiMachine.leaseSelfHeal.staleHolderTakeover', {
                  kind: 'error',
                  reason: 'taken-over holder was alive: its signed nonce advanced after the takeover',
                  context: { holder: obs.lease.holder, takeoverEpoch: this.staleTakeoverEvidence.epoch, holderEpoch: obs.lease.epoch, msSinceTakeover: sinceMs },
                });
              }
              this.staleTakeoverEvidence = null;
            }
          }
          if (obs.lease.epoch > epoch) {
            bestLease = obs.lease;
            epoch = obs.lease.epoch;
          } else if (obs.lease.epoch === epoch && this.peerOutranksLapsedSelf(obs.lease, bestLease)) {
            bestLease = obs.lease;
            peerOutranksSelf = true;
          }
        }
      }
    }
    // A higher accepted epoch permanently consumes any process-local solo-hold
    // authorization for our older takeover. Do this BEFORE selfIssued folding:
    // if the transport later forgets/removes that peer observation, the old
    // epoch must never resurrect authority merely because it becomes the max
    // visible record again.
    if (this.peerTakeoverAuthorizedEpoch !== null && epoch > this.peerTakeoverAuthorizedEpoch) {
      this.peerTakeoverAuthorizedEpoch = null;
    }
    // Fold in our own freshest self-issued lease (a renewal's new expiry lives
    // here, not in coarse git). Only while not superseded by a higher epoch.
    if (
      this.selfIssued && this.selfIssued.holder === this.selfMachineId && this.selfIssued.epoch >= epoch &&
      !(peerOutranksSelf && this.selfIssued.epoch === epoch)
    ) {
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
    if (this.lastRenewOkMonoMs === null) return false; // never confirmed in this process (rule 1b)
    if (this.monotonicNow() - this.lastRenewOkMonoMs > this.fl.ttlMs) return false;
    // A peer's verified ack reported a higher epoch than ours: we are superseded,
    // even before its signed holder lease reaches our observed view.
    if (this.higherEpochEvidence() > view.epoch) return false;
    return true;
  }

  private higherEpochEvidence(): number {
    return this.d.tunnel?.higherEpochEvidence?.() ?? 0;
  }

  /** No new native owner step can claim durable storage from an arbitrary
   * injected callback or from LocalLeaseStore's in-memory cache. */
  syncOwnerDecommissionDurably():string{
    const store=this.d.store;if(!(store instanceof LocalLeaseStore)&&!(store instanceof GitLeaseStore))throw new Error('native-decommission-store-durability-unavailable');store.syncDurably();return store.durabilityPath;
  }

  /** The current effective epoch (for stamping writes/sends). */
  currentEpoch(): number {
    return this.effectiveView().epoch;
  }

  /**
   * The lease TTL in ms (B3 — multimachine-lease-poll-robustness). Exposed so the
   * coordinator can size a dedicated renew timer SHORTER than the TTL, keeping the
   * lease fresh between renewals instead of letting it lapse every heartbeat tick
   * (the epoch-climb root: TTL 60s < tick 120s → always re-acquire at epoch+1).
   */
  get ttlMs(): number {
    return this.fl.ttlMs;
  }

  currentHolder(): string | null {
    const lease = this.effectiveView().lease;
    // F3 — a RELEASED tombstone declares "epoch N released, not held": it names
    // no live holder, so peers stop deferring to a muted ex-holder's zombie. A
    // higher-epoch normal acquisition still strictly dominates (epoch fold).
    if (!lease || lease.released) return null;
    return lease.holder;
  }

  /**
   * F4 — is `machineId` the current holder of a LIVE (non-expired, non-released)
   * lease we observe? The deferential-standby health gate: a non-preferred machine
   * defers to its preferred peer ONLY while this is true, so a frozen/down/released
   * preferred never strands coverage (the non-preferred then acquires normally).
   */
  isHolderHealthy(machineId: string): boolean {
    const view = this.effectiveView();
    if (!view.lease || view.lease.released || view.lease.holder !== machineId) return false;
    return !this.fl.isExpired(view.lease, this.now());
  }

  /**
   * multi-transport-mesh-comms Layer 3 — may a preferred stationary captain HOLD
   * its lease (same epoch) instead of self-suspending when no rope confirmed?
   * ALL must hold (each is an EXISTING signal, never authority invented here):
   *  (1) the feature is enabled (DARK by default);
   *  (2) this machine is the F4-AGREED preferred-awake machine;
   *  (3) EVERY peer is presumed-gone by liveness-silence, OR this exact epoch
   *      was acquired from a peer through the fenced takeover authority;
   *  (4) no higher epoch than ours is observed (a real takeover always wins).
   * Fail-closed: a missing dep ⇒ not eligible (today's self-suspend).
   */
  private soloCaptainHoldEligible(ourEpoch: number): boolean {
    const cfg = this.d.soloCaptainHold?.();
    if (!cfg?.enabled) return false;
    // With nobody named preferred, a dead peer and a cut link look the same and there is no
    // captain to defer to, so the holder keeps its epoch and only a higher one ends that. A
    // pool that names a captain keeps its rule whole, takeovers included.
    if (!this.d.survivorMayHold?.()) {
      if (!this.d.isPreferredAwakeAgreed?.()) return false;
      const authorizedByPeerTakeover = this.peerTakeoverAuthorizedEpoch === ourEpoch;
      if (!authorizedByPeerTakeover && !this.d.allPeersPresumedGone?.()) return false;
    }
    // No higher epoch observed than the one we hold (a real takeover dominates).
    const view = this.effectiveView();
    if (view.epoch > ourEpoch) return false;
    if (this.higherEpochEvidence() > ourEpoch) return false;
    return true;
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
  relinquish(why = 'contested tie-break loser — winner may now advance to N+1'): void {
    // planned-restart-keeps-lead: a conceded epoch is never renewed from the continuity file at the next boot.
    this.d.continuity?.delete();
    this.d.store.clearPendingEpisodeId?.();
    this.bootReclaim = null;
    this.relinquishGeneration++;
    this.selfIssued = null;
    this.d.store.forceLocalExpiry?.();
    this.log(`relinquished self-lease (${why})`);
  }

  /**
   * F2 — build the StaleHolderTakeoverOpts for `canAcquire`, or `undefined` when
   * the flag is off / the candidate is not a takeable peer (so canAcquire stays
   * byte-for-byte the legacy behavior). Uses this holder's observed freshness on
   * the OBSERVER's own monotonic clock.
   */
  private staleHolderOpts(currentLease: LeaseRecord | null | undefined): StaleHolderTakeoverOpts | undefined {
    const cfg = this.d.staleHolderTakeover?.();
    if (!cfg?.enabled) return undefined;
    if (!currentLease || currentLease.holder === this.selfMachineId) return undefined;
    return {
      monotonicNowMs: this.monotonicNow(),
      freshObservedMonoMs: this.freshObservedMonoMs.get(currentLease.holder),
      nonRenewalThresholdMs: this.fl.ttlMs * Math.max(1, cfg.nonRenewalMissedObservations),
    };
  }

  /**
   * F3 — relinquish a lease THIS machine holds AND broadcast a SIGNED tombstone
   * so peers stop deferring to a muted ex-holder's zombie. Called level-triggered
   * by the coordinator when this machine is observe-only yet still the named
   * holder (the 2026-06-19 silent-standby zombie). The tombstone is
   * `released:true` at our epoch with a fresh nonce strictly greater than our last
   * (so a concurrent in-flight renewal cannot out-nonce it) and a past expiry; a
   * higher-epoch normal takeover always strictly dominates it. Idempotent: a no-op
   * (just local relinquish) when we are not the named holder.
   */
  async relinquishAndBroadcast(why = 'silent-standby release'): Promise<void> {
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId || view.lease.released) {
      // Not the live holder (or already a tombstone) → just clear local state.
      this.relinquish(why);
      return;
    }
    const tombstone = this.fl.signLease(
      view.lease.epoch,
      view.lease.acquiredAt,
      new Date(this.now()).toISOString(), // past/now expiry — released regardless
      this.nextNonce(),                   // strictly > our last renewal nonce
      true,                               // released
    );
    this.relinquish(why); // clear our own self-hold first (forceLocalExpiry preserves the epoch floor)
    await this.broadcast(tombstone);
    this.log(`relinquished + broadcast tombstone for epoch ${view.lease.epoch} (${why})`);
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
    const res = this.casWrite(candidate);
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

  private static readonly OWN_LAPSE_PULL_DEADLINE_MS = 10_000;

  /** A pull that cannot hold up acquisition: an unreachable peer is the expected case here. */
  private async pullWithin(deadlineMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, deadlineMs); timer.unref?.(); });
    try {
      await Promise.race([this.pullFromPeers().catch(() => undefined), deadline]); // @silent-fallback-ok: no answer means re-acquire, which is this path's purpose
    } finally {
      if (timer) clearTimeout(timer);
    }
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
   * Per-peer lease observations (machine-coherence-guard §5b): the map behind
   * the lease-live awakeMachineCount derivation — each online peer's most
   * recently disclosed lease view with its observation time, keyed on the
   * machine-auth-verified peer id. Empty map when the transport has no pull
   * capability (a git-only mesh — the counting rule degrades to the legacy
   * 'registry-roles' source there).
   */
  peerLeaseObservations(): Map<string, { lease: LeaseRecord | null; observedAtMs: number }> {
    return this.d.tunnel?.observedByPeer?.() ?? new Map();
  }

  /**
   * machine-coherence-guard §5b — the LEASE-LIVE `awakeMachineCount` derivation
   * (the fix for "awakeMachineCount:0 while both machines are online and a peer
   * holds the lease"). The count is derived from the AUTHORITATIVE lease signal,
   * NOT the laggy git-synced registry role field:
   *
   *   awakeMachineCount = (self holdsLease() ? 1 : 0)
   *                     + #{ distinct online peers P whose most-recent observation
   *                         satisfies ALL of }:
   *       (i)  FRESHNESS — observed within `staleMs` (a stale claim contributes
   *            nothing; the post-failover stale-claim overcount dies here);
   *       (ii) LIVENESS  — the observed lease is NOT expired on OUR clock (an
   *            expired lease carries no authority — the same rule the supersede
   *            gate enforces);
   *       (iii) SELF-CLAIM — `lease.holder === P`. A pulled lease naming a THIRD
   *            machine is that peer's HEARSAY about someone else and contributes
   *            nothing (the third machine's own self-claim is counted when IT is
   *            pulled).
   *
   * Duplicate ids are impossible (map keying); observations are keyed on the
   * machine-auth-verified DIALED peer id (never a response-body holder claim) and
   * never include self, so `holder === P ≠ self` means self can never be
   * double-counted. ADVISORY only (L4/SEC-4) — this count NEVER drives an
   * automatic demotion; it feeds observability + the human-decision flow.
   *
   * Clock assumption (R2-N5): lease liveness is judged on the OBSERVER's clock;
   * the freshness bound caps how long any one misjudged observation can distort
   * the count, and the pool registry's clock-skew gate is the mesh-wide backstop.
   */
  deriveLiveAwakeCount(staleMs: number): number {
    let count = this.holdsLease() ? 1 : 0;
    const now = this.now();
    for (const [peerId, rec] of this.peerLeaseObservations()) {
      if (!rec.lease) continue; // an honest "no lease" — the peer is not awake
      if (now - rec.observedAtMs > staleMs) continue; // (i) freshness
      if (this.fl.isExpired(rec.lease, now)) continue; // (ii) liveness
      if (rec.lease.holder !== peerId) continue; // (iii) self-claim (no hearsay)
      count++;
    }
    return count;
  }

  /**
   * Whether the most-recently OBSERVED peer lease genuinely SUPERSEDES ours and
   * may therefore drive a pull-loop demotion. True ONLY when that peer lease is
   * LIVE (not expired) AND at a STRICTLY HIGHER epoch than our own self-issued
   * lease.
   *
   * Why this stricter gate exists (live incident 2026-06-02, the real laptop+mini
   * pair): the pull loop demoted on ANY non-null `observedPeerLease()`. A standby
   * peer kept disclosing a 2-DAY-EXPIRED, epoch-150 lease (vs our live epoch-1400+),
   * which satisfied that loose gate — so every time our own ~60s lease lapsed
   * transiently between renewals, the legitimate holder flipped to read-only
   * standby (~50% of the time), blocking real writes (#673 caught the crash but the
   * writes still failed). A stale/expired or lower-or-equal-epoch peer carries no
   * fencing authority and must NEVER demote a legitimate holder; that holder's
   * transient self-lapse is re-acquired by `tickLease`. Same-epoch contention is a
   * separate concern handled by the contested-split-brain resolver, not here.
   *
   * NOTE: compare against `selfIssued.epoch` (our OWN lease), NOT `currentEpoch()`
   * — the latter is `effectiveView().epoch = max(self, observed-peer)`, so it would
   * already fold the peer in and make `peer.epoch > currentEpoch()` impossible.
   */
  peerLeaseSupersedes(): boolean {
    const peer = this.observedPeerLease();
    if (!peer) return false;
    // A stale/expired observed peer lease carries no fencing authority.
    if (this.fl.isExpired(peer, this.now())) return false;
    // Only a STRICTLY higher epoch out-fences our own self-issued lease. A peer at
    // our epoch or below cannot demote us (same-epoch ties → contested resolver).
    const ourEpoch = this.selfIssued?.epoch ?? -1;
    return peer.epoch > ourEpoch;
  }

  /** The store is only this machine's copy: see LeaseStore.hasNoSharedMedium. */
  hasNoSharedMedium(): boolean {
    return !!this.d.store.hasNoSharedMedium?.();
  }

  /** A peer's expired or released record proves nothing is being held, so it cannot be a tie. */
  observedPeerLeaseLive(): boolean {
    const peer = this.observedPeerLease();
    return !!peer && !peer.released && !this.fl.isExpired(peer, this.now());
  }

  /**
   * Whether the current peer-held effective lease is takeable by the normal
   * fenced acquisition rules right now. This is a scheduling hint only: callers
   * still invoke acquireIfEligible(), which re-evaluates the same decision and
   * owns the CAS. Exposing the hint lets the fast anti-blinding pull loop wake
   * acquisition exactly when an expired/dead/non-renewing holder becomes
   * eligible without turning every pull into a noisy acquisition attempt.
   */
  peerTakeoverEligible(): boolean {
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder === this.selfMachineId) return false;
    return this.fl.canAcquire(
      view.lease,
      this.d.presumedDeadHolders(),
      this.now(),
      this.staleHolderOpts(view.lease),
    ).can;
  }

  /**
   * Attempt to acquire (or self-renew) the lease if eligible. Returns true if
   * THIS machine holds the lease afterward. Implements the bounded-retry CAS
   * with livelock backoff.
   */
  /**
   * Prime the local view from the durable medium (pull, no write). Call this
   * ONCE at boot before the first acquireIfEligible so a freshly-booted/joined
   * machine evaluates failover-eligibility against the holder's CURRENT
   * heartbeat — not a stale seed timestamp it would misread as "holder dead".
   */
  primeFromDurable(): void {
    try {
      this.d.store.syncDown?.();
    } catch {
      // @silent-fallback-ok — best-effort prime; steady-state ticks self-correct.
    }
  }

  private bootClaimSafetySettings(): BootClaimSafetySettings | null {
    try {
      const s = this.d.bootClaimSafety?.();
      return s?.enabled ? s : null;
    } catch {
      return null; // @silent-fallback-ok: an unreadable switch keeps today's acquisition, which is the shipped default
    }
  }

  /** takeover-ready-pool R1 — whether the boot claim safety switch is on right now. */
  bootClaimSafetyEnabled(): boolean {
    return this.bootClaimSafetySettings() !== null;
  }

  /**
   * takeover-ready-pool R1 — is the boot hold still in force? False when the switch is off or
   * the hold has ended (it latches off for the life of the process). Evaluating it may end it.
   */
  bootHoldActive(): boolean {
    const safety = this.bootClaimSafetySettings();
    if (!safety) return false;
    return this.evaluateBootHoldNow(safety).hold;
  }

  /**
   * Rule 4's end evidence, from peers only: a lease a peer sent (signature, git floor and
   * replay checked exactly as effectiveView folds it) that names a live holder or an epoch
   * strictly newer than this machine's own boot record; or, on a store with a shared medium
   * (a git remote), a durable epoch newer than the boot record, which only a fetch can bring
   * since nothing is written during the hold. This machine's own copy never counts: a local
   * file or a git store with no remote proves nothing about a peer.
   */
  private newerViewThanBootRecord(): boolean {
    const boot = this.bootOwnRecord.epoch;
    const git = this.d.store.read();
    const obs = this.d.tunnel?.observed();
    if (obs?.lease) {
      const { [obs.lease.holder]: _own, ...nonceFloor } = obs.lastNonceByHolder;
      void _own;
      if (this.fl.acceptTunnelLease(obs.lease, git.epoch, nonceFloor).accept) {
        const l = obs.lease;
        if (l.epoch > boot) return true;
        if (l.holder !== this.selfMachineId && !l.released && !this.fl.isExpired(l, this.now())) return true;
      }
    }
    if (!this.d.store.hasNoSharedMedium?.() && git.epoch > boot) return true;
    return false;
  }

  private evaluateBootHoldNow(safety: BootClaimSafetySettings): BootHoldVerdict {
    if (this.bootHoldEnded) return { hold: false, rule: 'ended', reason: 'boot hold already ended' };
    let verdict: BootHoldVerdict;
    try {
      const transport = this.d.tunnel;
      verdict = evaluateBootHold({
        nowMs: this.now(),
        selfMachineId: this.selfMachineId,
        preferredMachineId: safety.preferredMachineId,
        knownPeers: transport?.knownPeerIds?.() ?? [],
        probes: transport?.probeHistory?.() ?? new Map(),
        newerViewSeen: this.newerViewThanBootRecord(),
        windowMsFor: (id) => unsignedAnswerWindowMs(this.d.peerRestartBudgetMs?.(id) ?? null),
        settings: {
          silentProbes: safety.silentProbes ?? DEFAULT_BOOT_HOLD_SETTINGS.silentProbes,
          silentSpanMs: safety.silentSpanMs ?? DEFAULT_BOOT_HOLD_SETTINGS.silentSpanMs,
        },
      });
    } catch (err) {
      // A fault reading the probes holds the claim (the safe side) and says why; the next tick retries.
      verdict = { hold: true, rule: 'error', reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' };
    }
    const key = `${verdict.rule}:${verdict.hold ? 'defer' : 'end'}`;
    if (key !== this.bootHoldLastLogged) {
      this.bootHoldLastLogged = key;
      this.log(`boot-hold: ${verdict.rule} ${verdict.hold ? 'defer' : 'end'} — ${verdict.reason}`
        + (this.bootOwnRecord.heldLast ? ` (own record: held epoch ${this.bootOwnRecord.epoch} last)` : ''));
    }
    if (!verdict.hold) {
      this.bootHoldEnded = true;
      featureEvidence.record('multiMachine.takeoverReadyPool', {
        kind: 'fired',
        reason: 'boot hold ended',
        context: { rule: verdict.rule, reason: verdict.reason.slice(0, 160), ownHeldLast: this.bootOwnRecord.heldLast, ownEpoch: this.bootOwnRecord.epoch },
      });
    }
    return verdict;
  }

  private identityIneligibleLogged = false;
  private heldBackLogged = false;

  async acquireIfEligible(): Promise<boolean> {
    // §1.1 lease rule: an unprovisioned machine that can see a live provisioned sibling does
    // not acquire, and releases what it holds at this (the next) tick. Read live so adoption lifting the posture needs no restart.
    if (this.d.isLeaseEligible && !this.d.isLeaseEligible()) {
      const view = this.effectiveView();
      if (view.lease && view.lease.holder === this.selfMachineId && !this.fl.isExpired(view.lease, this.now())) {
        // Signed tombstone, not the bare local relinquish: peers stop deferring to this
        // machine now instead of waiting out the lease TTL.
        await this.relinquishAndBroadcast('identity-not-provisioned: a live sibling holds the agent identity');
      } else if (!this.identityIneligibleLogged) {
        // Once per ineligible stretch, not once per tick.
        this.log('acquire skipped: identity-not-provisioned and a live sibling holds the agent identity');
      }
      this.identityIneligibleLogged = true;
      return false;
    }
    this.identityIneligibleLogged = false;
    if (this.d.acquireHeldBack?.()) {
      if (!this.heldBackLogged) this.log('acquire skipped: no lasting link to the other machine has been proved yet');
      this.heldBackLogged = true;
      return false;
    }
    this.heldBackLogged = false;
    if (this.suspended) {
      // A suspended holder may resume only by re-acquiring cleanly below.
      this.suspended = false;
      this.suspendedByRenewal = null;
    }
    const liveness = this.d.getLivenessEnabled?.() ?? true;
    const legacyDead = liveness ? undefined : this.d.presumedDeadHolders({ liveness: false });
    let retries = 0;
    let askedPeers = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const view = this.effectiveView();
      const dead = legacyDead ?? this.d.presumedDeadHolders({ liveness });
      // Already hold it at the current epoch → just renew. planned-restart-keeps-lead rule 1b: a window
      // lease found at construction is confirmed with a peer first (evaluateReclaim), never renewed
      // from the local file.
      if (view.lease && view.lease.holder === this.selfMachineId && !this.fl.isExpired(view.lease, this.now())) {
        if (this.bootReclaim && this.bootReclaim.verdict === null) return this.evaluateReclaim(view);
        return this.renew();
      }
      // Rule 1b, lapsed: the window ran out before a verdict; today's lapsed path (rule 1) applies and
      // the reclaim is closed as such, never as a takeover.
      if (this.bootReclaim && this.bootReclaim.verdict === null && view.lease
          && view.lease.holder === this.selfMachineId && view.epoch <= this.bootReclaim.lease.epoch) {
        this.finishReclaim('lapsed', 'none', null);
      }
      // Rule 1b, superseded: the view already names another holder or a newer epoch than the window
      // lease on disk. Record the verdict (measure, evidence, clean-up) and go on as today's code does.
      if (this.bootReclaim && this.bootReclaim.verdict === null && view.lease
          && (view.lease.holder !== this.selfMachineId || view.epoch > this.bootReclaim.lease.epoch)) {
        this.finishReclaim('superseded', 'none', null);
      }
      const decision = this.fl.canAcquire(view.lease, dead, this.now(), this.staleHolderOpts(view.lease));
      if (!decision.can) {
        this.log(`acquire skipped: ${decision.reason}`);
        return false;
      }
      // Taking back our own lapsed lease (restart, wake): ask the peers first, once, so a
      // takeover that happened meanwhile is seen rather than tied at the same epoch. A store
      // holding only this machine's copy always asks: its lease says nothing about the peer,
      // and claiming without asking is what made a pair restart each other for good. What the
      // ask brings back lands in the view, so the check above refuses the claim on the next pass.
      const ownLapse = view.lease?.holder === this.selfMachineId;
      const safety = this.bootClaimSafetySettings();
      if (safety) {
        // takeover-ready-pool R1 rule 1: an own lapsed lease (or none) always asks the peers
        // first. Its own lapsed lease is never permission to re-take it, and a named preferred
        // machine no longer switches the ask off (the survivorMayHold conjunct is gone here).
        // While the boot hold is in force every claim asks first, whoever the stale view names.
        if (!askedPeers && (ownLapse || !view.lease || !this.bootHoldEnded) && this.canPullPeers()) {
          askedPeers = true;
          await this.pullWithin(LeaseCoordinator.OWN_LAPSE_PULL_DEADLINE_MS);
          continue;
        }
        const hold = this.evaluateBootHoldNow(safety);
        if (hold.hold) return false;
      } else if (
        !askedPeers &&
        (ownLapse || !view.lease) &&
        ((ownLapse && this.d.soloCaptainHold?.()?.enabled) || this.d.store.hasNoSharedMedium?.()) &&
        this.d.survivorMayHold?.() &&
        this.canPullPeers()
      ) {
        askedPeers = true;
        await this.pullWithin(LeaseCoordinator.OWN_LAPSE_PULL_DEADLINE_MS);
        continue;
      }
      const candidate = this.fl.buildAcquisition(view.lease, this.now(), this.nextNonce());
      const res = this.casWrite(candidate);
      if (res.ok) {
        this.selfIssued = candidate;
        if (view.lease && decision.reason.startsWith('holder-not-renewing')) {
          this.staleTakeoverEvidence = { holder: view.lease.holder, epoch: candidate.epoch, atMono: this.monotonicNow() };
          featureEvidence.record('multiMachine.leaseSelfHeal.staleHolderTakeover', {
            kind: 'fired',
            reason: 'took over a holder that stopped renewing',
            context: { decision: decision.reason, holder: view.lease.holder, fromEpoch: view.lease.epoch, toEpoch: candidate.epoch },
          });
        }
        if (
          view.lease &&
          view.lease.holder !== this.selfMachineId &&
          (
            decision.reason === 'current-lease-expired' ||
            decision.reason.startsWith('holder-presumed-dead') ||
            decision.reason.startsWith('holder-not-renewing')
          )
        ) {
          this.peerTakeoverAuthorizedEpoch = candidate.epoch;
        }
        await this.broadcast(candidate);
        this.markRenewOk();
        this.emitEpoch(candidate.epoch);
        this.log(`acquired lease at epoch ${candidate.epoch}`);
        if (this.episode) this.persistPending(candidate, false); // a casWrite during an open episode rewrites the file at once
        return true;
      }
      // CAS lost — someone advanced. Re-evaluate against the observed state.
      const observedEpoch = res.observed.epoch;
      if (view.lease && decision.reason.startsWith('holder-not-renewing')) {
        featureEvidence.record('multiMachine.leaseSelfHeal.staleHolderTakeover', {
          kind: 'held',
          reason: 'stale-holder takeover lost the epoch compare-and-set',
          context: { decision: decision.reason, holder: view.lease.holder, candidateEpoch: candidate.epoch, observedEpoch, retries },
        });
      }
      if (observedEpoch >= candidate.epoch) {
        this.log(`CAS lost to epoch ${observedEpoch} (our candidate ${candidate.epoch}) — yielding`);
        this.emitEpoch(observedEpoch);
        // If the winner is a presumed-dead/expired/non-renewing holder we'll retry; else stop.
        if (!this.fl.canAcquire(res.observed.lease, dead, this.now(), this.staleHolderOpts(res.observed.lease)).can) return false;
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
  /** Explicit owner decommission continuation. No liveness timeout, fabricated
   * yield or synthetic lease is substituted for actual native administration. */
  async acquireOnOwnerDecommission(permit:NativeDecommissionLeasePermit):Promise<boolean>{
    if(!(permit instanceof NativeDecommissionLeasePermit))throw new Error('native-decommission-permit-required');permit.assertCurrent(this,this.selfMachineId);this.syncOwnerDecommissionDurably();if(this.d.isLeaseEligible&&!this.d.isLeaseEligible())return false;
    const prior=permit.priorAcquisition(this),view=this.effectiveView();if(prior&&view.lease?.holder===this.selfMachineId&&view.epoch>=prior.epoch&&this.holdsLease()){this.syncOwnerDecommissionDurably();/* A real server takes a new epoch every boot. Keep the durable record on the epoch this machine actually holds, so an interrupted removal can finish. */if(view.epoch>prior.epoch)await permit.recordAcquisition(this,view.lease);return true;}if(this.higherEpochEvidence()>view.epoch)throw new Error('native-decommission-higher-native-evidence-unresolved');const base=permit.acquisitionBase(view.lease,view.epoch),candidate=this.fl.buildAcquisition(base,this.now(),this.nextNonce());permit.assertCurrent(this,this.selfMachineId);
    const result=this.casWrite(candidate);if(!result.ok){this.emitEpoch(result.observed.epoch);return false;}this.syncOwnerDecommissionDurably();this.selfIssued=candidate;if(base.holder!==this.selfMachineId)this.peerTakeoverAuthorizedEpoch=candidate.epoch;this.suspended=false;this.suspendedByRenewal=null;
    await this.broadcast(candidate);permit.assertCurrent(this,this.selfMachineId);this.syncOwnerDecommissionDurably();this.markRenewOk();this.emitEpoch(candidate.epoch);if(!this.holdsLease())return false;await permit.recordAcquisition(this,candidate);return true;
  }

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
    const res = this.casWrite(candidate);
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

  // ── U4.4 lease hand-back (docs/specs/u4-4-lease-handback.md) ────────

  /** Used consent-token nonces per holder (single-use enforcement on the
   *  ACQUIRING side). In-memory: a restart forgets, but the token TTL is short
   *  and the envelope nonce guard is durable — the safe direction. */
  private usedHandbackNonces = new Map<string, Set<number>>();

  /**
   * HOLDER side — mint the SIGNED, epoch-bound, TTL-bounded, SINGLE-USE consent
   * token a `handback-offer` carries (R-r2-1). Refuses (null) unless THIS
   * machine currently holds a valid lease — a non-holder can never mint
   * consent for a lease it does not hold.
   */
  mintHandbackConsent(target: string, ttlMs: number): HandbackConsentToken | null {
    if (!this.holdsLease()) return null;
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId) return null;
    const expiresAt = new Date(this.now() + Math.max(1_000, ttlMs)).toISOString();
    return this.fl.signHandbackConsent(view.epoch, target, expiresAt, this.nextNonce());
  }

  /**
   * PREFERRED-CAPTAIN side — claim the lease by presenting the holder's consent
   * token through the `handbackOpts` branch of canAcquire (R-r2-1). Claim-
   * before-release: on success the CAS advances the epoch and the old holder
   * steps down by observing it (isStampCurrent fencing — no double-serve
   * window); on ANY failure nothing changes and the holder keeps holding (a
   * failed hand-back can never leave zero holders). Single-use: the token's
   * (holder, nonce) is burned on FIRST presentation, success or not.
   */
  async acquireOnHandbackConsent(token: HandbackConsentToken): Promise<{ ok: boolean; reason: string }> {
    const view = this.effectiveView();
    const used = this.usedHandbackNonces.get(token?.holder ?? '') ?? new Set<number>();
    const alreadyUsed = used.has(token?.nonce);
    const decision = this.fl.canAcquire(view.lease, this.d.presumedDeadHolders(), this.now(), undefined, {
      token,
      alreadyUsed,
    });
    // Burn the nonce on first presentation (replay/reuse fail-closed after).
    if (token && typeof token.nonce === 'number') {
      used.add(token.nonce);
      this.usedHandbackNonces.set(token.holder, used);
      if (used.size > 256) {
        // bounded memory: keep the newest nonces
        const keep = [...used].sort((a, b) => b - a).slice(0, 128);
        this.usedHandbackNonces.set(token.holder, new Set(keep));
      }
    }
    if (!decision.can || !decision.reason.startsWith('handback-consent')) {
      // FAIL-CLOSED: only the consent branch may authorize this path — a
      // coincidentally-expired lease must not turn a bad token into a claim.
      return { ok: false, reason: decision.can ? `non-consent-grant-refused (${decision.reason})` : decision.reason };
    }
    const candidate = this.fl.buildAcquisition(view.lease, this.now(), this.nextNonce());
    const res = this.casWrite(candidate);
    if (res.ok) {
      this.selfIssued = candidate;
      await this.broadcast(candidate);
      this.markRenewOk();
      this.emitEpoch(candidate.epoch);
      this.log(`acquired lease on hand-back consent at epoch ${candidate.epoch} (from ${token.holder})`);
      return { ok: true, reason: 'handback-claimed' };
    }
    this.emitEpoch(res.observed.epoch);
    this.log(`hand-back consent acquire lost CAS to epoch ${res.observed.epoch} — holder keeps holding`);
    return { ok: false, reason: 'cas-lost' };
  }

  /**
   * Renew the held lease: re-sign with a fresh expiry, broadcast over the
   * tunnel, and (coarsely, via the store on epoch change) keep git current.
   * Returns false (and self-suspends) if the tunnel medium is configured but
   * has been unreachable for longer than the lease TTL.
   */
  /**
   * On a store holding only this machine's copy, a peer that just reached us over signed RPC and
   * is reading this lease proves the link as well as a push would. It also covers the case a push
   * cannot: a peer that is booting pulls long before it listens, and if our lease ran out in that
   * window it would claim, swap the roles, and restart a machine. A peer that is really gone sends
   * no pulls, so this never keeps a lease alive past a dead link. Re-signs only in the second half
   * of the lease, so a steady 5-second pull does not churn nonces.
   */
  confirmHoldOnPeerPull(): void {
    if (!this.hasNoSharedMedium() || !this.holdsLease()) return;
    if (this.d.isLeaseEligible && !this.d.isLeaseEligible()) return;
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId) return;
    if (new Date(view.lease.expiresAt).getTime() - this.now() > this.fl.ttlMs / 2) return;
    const pendingWindow = this.pendingWindowMs();
    this.selfIssued = this.fl.signLease(
      view.epoch,
      view.lease.acquiredAt,
      new Date(this.now() + (pendingWindow ?? this.fl.ttlMs)).toISOString(),
      this.nextNonce(),
    );
    this.markRenewOk();
    if (pendingWindow !== null) { this.persistPending(this.selfIssued, false); if (this.episode) this.noteFirstExtension(this.episode, view.epoch); }
  }

  /** A slow broadcast must not replace a newer lease signed while it waited (a peer's pull). */
  private installRenewal(renewed: LeaseRecord): void {
    if (this.selfIssued && this.selfIssued.epoch === renewed.epoch && this.selfIssued.nonce > renewed.nonce) return;
    this.selfIssued = renewed;
  }

  async renew(): Promise<boolean> {
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId) return false;
    // A holder never reaches acquireIfEligible's release once something keeps renewing it.
    if (this.d.isLeaseEligible && !this.d.isLeaseEligible()) {
      await this.relinquishAndBroadcast('identity-not-provisioned: a live sibling holds the agent identity');
      return false;
    }
    // Superseded: a peer verified a higher epoch. Never renew or hold the older one.
    if (this.higherEpochEvidence() > view.epoch) {
      if (this.soloHoldEvidenceEpoch !== null) {
        featureEvidence.record('multiMachine.leaseSelfHeal.soloCaptainHold', {
          kind: 'error',
          reason: 'a healthy peer advanced the epoch while the sole captain was holding',
          context: { heldEpoch: this.soloHoldEvidenceEpoch, higherEpoch: this.higherEpochEvidence() },
        });
        this.soloHoldEvidenceEpoch = null;
      }
      return false;
    }

    // Re-sign with a fresh expiry (same epoch — renewal never advances it). While a restart is
    // pending the expiry is the window, so the lease outlives the boot (planned-restart-keeps-lead §1).
    const pendingWindow = this.pendingWindowMs();
    const renewed = this.fl.signLease(
      view.epoch,
      view.lease.acquiredAt,
      new Date(this.now() + (pendingWindow ?? this.fl.ttlMs)).toISOString(),
      this.nextNonce(),
    );
    if (pendingWindow !== null) { this.persistPending(renewed, false); if (this.episode) this.noteFirstExtension(this.episode, view.epoch); }

    // Medium-agnostic renewal requirement: the renewal must be CONFIRMED over a
    // shared medium — the tunnel (reachable broadcast) when configured, else a
    // durable git refresh. A holder that cannot confirm over ANY medium for
    // > leaseTtlMs MUST self-suspend, rather than extend its lease locally
    // forever (which is exactly the partitioned-old-awake split-brain).
    let confirmed: boolean;
    if (this.d.tunnel) {
      const generation = this.relinquishGeneration;
      confirmed = await this.d.tunnel
        .broadcast(renewed, () => this.adoptLateRenewal(renewed, generation))
        .catch(() => false); // @silent-fallback-ok: a throw is an UNCONFIRMED renewal (fail-closed; hold/grace/suspend below)
      // Relinquished while the broadcast was in flight: never re-install the lease.
      if (generation !== this.relinquishGeneration) return false;
    } else {
      confirmed = this.d.store.refresh(renewed);
    }

    if (confirmed) {
      this.installRenewal(renewed);
      this.markRenewOk(renewed.nonce);
      if (pendingWindow !== null) this.persistPending(renewed, true);
      if (this.soloHoldEvidenceEpoch !== null) {
        featureEvidence.record('multiMachine.leaseSelfHeal.soloCaptainHold', {
          kind: 'held',
          reason: 'hold ended: renewal confirmed over a medium again',
          context: { heldEpoch: this.soloHoldEvidenceEpoch, epoch: view.epoch },
        });
        this.soloHoldEvidenceEpoch = null;
      }
      return true;
    }

    // ── multi-transport-mesh-comms Layer 3 — safe-by-construction solo-captain hold ──
    // The renewal could not confirm over any rope. BEFORE self-suspending, check the
    // partition floor: a PREFERRED stationary captain whose sole peer is PROVABLY
    // GONE (presumed-gone by liveness-silence) holds its lease (same epoch) instead
    // of thrashing. Gated on F4-agreed-preferred + every-peer-presumed-gone + no
    // higher epoch observed. The hold NEVER advances the epoch or takes over a
    // peer's lease, so even a wrongly-presumed-gone live peer cannot double-write
    // (the intact epoch-CAS + signature fence remains the authority). The monotonic
    // self-fence stays armed whenever the presumed-gone gate is NOT satisfied.
    // Exception, by design (lease-takeover-no-shared-medium): a pool with no named captain
    // skips the preferred and presumed-gone gates, so during a cut both machines may believe
    // they hold until reconnect, when the higher epoch wins.
    if (this.soloCaptainHoldEligible(view.epoch)) {
      this.installRenewal(renewed);
      this.markRenewOk(); // hold the SAME epoch — no re-acquire, no inflation
      if (this.soloHoldEvidenceEpoch !== view.epoch) {
        // Once per hold, not once per 30-second renewal: a machine can hold for days.
        this.log(this.d.survivorMayHold?.()
          ? 'solo-captain hold: unnamed pool, no higher epoch — held lease without medium confirm'
          : 'solo-captain hold: preferred + all peers presumed-gone + no higher epoch — held lease without medium confirm');
        this.soloHoldEvidenceEpoch = view.epoch;
        featureEvidence.record('multiMachine.leaseSelfHeal.soloCaptainHold', {
          kind: 'fired',
          reason: 'held the lease without medium confirmation',
          context: { epoch: view.epoch, hasTunnel: !!this.d.tunnel, peerTakeoverAuthorized: this.peerTakeoverAuthorizedEpoch === view.epoch },
        });
      }
      return true;
    }

    if (this.lastRenewOkMonoMs === null) {
      // Rule 1b: a boot renewal that did not confirm is not a lapse — nothing was ever confirmed in
      // this process. The machine stays standby; the pull tick's nudge retries. One sentence per boot.
      if (this.bootReclaim && !this.bootReclaim.unconfirmedLogged) {
        this.bootReclaim.unconfirmedLogged = true;
        this.log(`lease-continuity: the renewal of epoch ${view.epoch} after this machine's planned restart has not been confirmed by a peer yet; this machine stays standby until it is.`);
      }
      return false;
    }
    if (this.monotonicNow() - this.lastRenewOkMonoMs > this.fl.ttlMs) {
      if (this.d.soloCaptainHold?.()?.enabled) {
        featureEvidence.record('multiMachine.leaseSelfHeal.soloCaptainHold', {
          kind: 'held',
          reason: 'not eligible to hold: self-suspending on lapsed renewal',
          context: { epoch: view.epoch },
        });
      }
      this.suspended = true;
      // Only the tunnel's early deadline is provisional; a git refresh result is final.
      this.suspendedByRenewal = this.d.tunnel ? renewed : null;
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

  /**
   * A peer confirmed `renewed` after renew() had already returned on the broadcast
   * deadline (a slow-but-valid peer). Adopt it exactly as an on-time confirmation
   * would have — but only while it is still current: not suspended, not relinquished
   * since the renewal was sent, still our lease at the same epoch, not released, not
   * superseded by a higher epoch (observed or verified-ack evidence), not expired,
   * and not older than a renewal we already installed.
   *
   * Suspension: if THIS renewal's own early deadline is what suspended us (a
   * renewal started near the end of grace), that timeout was provisional, so the
   * exact renewal may still finish and lift that suspension. Any other suspension
   * (a different renewal, or none since re-acquire) still discards the ack. The
   * monotonic fence stays armed until the confirmation actually arrives.
   */
  private adoptLateRenewal(renewed: LeaseRecord, generation: number): void {
    if (this.suspended && this.suspendedByRenewal !== renewed) return;
    if (generation !== this.relinquishGeneration) return;
    if (this.fl.isExpired(renewed, this.now())) return;
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId || view.lease.released) return;
    if (view.epoch !== renewed.epoch || this.higherEpochEvidence() > renewed.epoch) return;
    if (this.selfIssued && this.selfIssued.epoch === renewed.epoch && this.selfIssued.nonce >= renewed.nonce) return;
    if (this.suspended) {
      this.suspended = false;
      this.suspendedByRenewal = null;
      this.log(`late confirmation of the renewal that timed out lifts its provisional suspension (epoch ${renewed.epoch})`);
    }
    this.selfIssued = renewed;
    this.markRenewOk(renewed.nonce);
    this.log(`late renewal confirmation adopted (epoch ${renewed.epoch}, nonce ${renewed.nonce})`);
    if (this.episode) this.persistPending(renewed, true);
    if (this.bootReclaim && this.bootReclaim.verdict === null) this.finishReclaim('confirmed', 'peer-confirmed', renewed);
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

  // ── planned-restart-keeps-lead: pending episodes, window renewals, the boot reclaim ──────────
  // @self-action-controller: planned-restart-lease-continuity (one window renewal per pending cadence while
  // an episode is open; the episode rule and its four-hour cap are the give-up; modeled in
  // src/testing/selfActionRegistry.ts)

  private continuitySettings(): { enabled: boolean; windowMs: number | null } | null {
    try {
      const v = this.d.plannedRestartContinuity?.();
      return v?.enabled ? v : null;
    } catch {
      return null; // @silent-fallback-ok: an unreadable switch keeps today's renewal
    }
  }

  /** The window an open episode's renewals carry, or null when nothing is pending or the switch is off. */
  private pendingWindowMs(): number | null {
    if (!this.episode) return null;
    if (!this.continuitySettings()) return null;
    return this.episode.windowMs;
  }

  /** Whether a restart episode is open on this holder (the renew tick runs at the pending cadence). */
  isPendingRestart(): boolean {
    return this.episode !== null && this.continuitySettings() !== null;
  }

  /** For `/health` `multiMachine.syncStatus.pendingRestart` (machine-local, in-memory). */
  pendingRestartStatus(): { requestedBy: string; since: string; windowMs: number } | null {
    if (!this.episode) return null;
    return { requestedBy: this.episode.requestedBy, since: new Date(this.episode.openedAtMs).toISOString(), windowMs: this.episode.windowMs };
  }

  private resolveWindow(settings: { windowMs: number | null }): { windowMs: number; note: string | null } {
    const renewInterval = this.d.renewIntervalMs?.() ?? Math.max(5_000, Math.min(60_000, Math.round(this.fl.ttlMs * 0.5)));
    const v = resolveWindowMs({
      ttlMs: this.fl.ttlMs,
      pendingRenewIntervalMs: pendingCadenceMs(renewInterval, !!this.d.tunnel),
      broadcastDeadlineMs: this.d.broadcastDeadlineMs?.() ?? 8_000,
      bootSamplesMs: this.d.continuity?.bootSamplesMs() ?? [],
      windowMsOverride: settings.windowMs,
      ownNonRenewalMissedObservations: this.d.staleHolderTakeover?.()?.nonRenewalMissedObservations ?? null,
      failoverThresholdMs: this.fl.failoverThreshold,
      unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS,
    });
    const note = v.clamped
      ? `the window was clamped to its ${v.clamped} (${v.windowMs} ms; ${v.clamped === 'ceiling' ? `the ${v.ceilingSource} cap` : 'the lease TTL plus the margin'}) from a base of ${v.baseMs} ms`
      : null;
    return { windowMs: v.windowMs, note };
  }

  /** The pending cadence's renewal interval for the coordinator's timer (null = the normal cadence). */
  pendingRenewIntervalMs(): number | null {
    if (!this.isPendingRestart()) return null;
    const renewInterval = this.d.renewIntervalMs?.() ?? Math.max(5_000, Math.min(60_000, Math.round(this.fl.ttlMs * 0.5)));
    return pendingCadenceMs(renewInterval, !!this.d.tunnel);
  }

  /** Write the window renewal beside the lease: the continuity file and, on a local store, the record with its pending marker. */
  private persistPending(lease: LeaseRecord, confirmed: boolean): void {
    const ep = this.episode;
    if (!ep || !this.d.continuity) return;
    ep.lastWindowLease = lease;
    if (confirmed) ep.confirmed = true;
    const meta: ContinuityMeta = {
      requestedBy: ep.requestedBy,
      reason: ep.reason,
      requestedAt: ep.requestedAt,
      episodeOpenedAt: new Date(ep.openedAtMs).toISOString(),
      renewedAt: new Date(this.now()).toISOString(),
      windowMs: ep.windowMs,
      confirmed: ep.confirmed,
      exitedAt: null,
      ...(ep.afterLatePromotion ? { afterLatePromotion: true } : {}),
    };
    this.d.continuity.write(this.d.continuity.sign({ v: 1, episodeId: ep.id, lease, meta }));
    try {
      this.d.store.refreshWithPending?.(lease, ep.id);
    } catch (err) {
      // @silent-fallback-ok: logged; the signed continuity file written just above carries the renewal
      this.log(`lease-continuity: the local lease store could not take the window renewal (${err instanceof Error ? err.message : String(err)}); the continuity file carries it.`);
    }
  }

  /**
   * §1 step 2 — the announce subscriber: open the episode; then, only as a holder with a known peer,
   * sign the window renewal, persist it and broadcast that exact renewal outside the tick guard.
   * Returns null when nothing was signed (the writer publishes at once).
   */
  beginPendingRestart(announce: RestartAnnounce): Promise<RestartAnnounceOutcome> | null {
    const settings = this.continuitySettings();
    if (!settings) return null;
    const ep = this.openEpisode({ requestedBy: announce.requestedBy, reason: announce.reason ?? '', requestedAt: announce.requestedAt ?? null }, 'announce');
    if (!ep) return null;
    ep.announcedAtMs = this.now();
    return this.extendForEpisode(ep);
  }

  /**
   * §1 step 2 — sign the window renewal for an open episode, persist it (synchronously, before this
   * returns) and broadcast that exact renewal. Null when this machine is not the holder or has no
   * peer to extend against.
   */
  private extendForEpisode(ep: PendingEpisode): Promise<RestartAnnounceOutcome> | null {
    if (!this.holdsLease()) return null;
    const peers = this.d.tunnel?.knownPeerIds?.() ?? [];
    if (peers.length === 0 && this.d.tunnel) return null; // nobody to extend against: inert
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId) return null;
    const renewed = this.fl.signLease(view.epoch, view.lease.acquiredAt, new Date(this.now() + ep.windowMs).toISOString(), this.nextNonce());
    this.installRenewal(renewed);
    this.persistPending(renewed, false);
    this.noteFirstExtension(ep, view.epoch);
    if (!this.d.tunnel) {
      // Test-only in production terms: a git-only mesh pushes its renewals on the renew tick; the announce resolves at once.
      return null;
    }
    const generation = this.relinquishGeneration;
    return this.d.tunnel.broadcast(renewed, () => this.adoptLateRenewal(renewed, generation)).then((ok) => {
      if (ok && generation === this.relinquishGeneration) {
        this.installRenewal(renewed);
        this.markRenewOk(renewed.nonce);
        this.persistPending(renewed, true);
        return 'confirmed' as const;
      }
      return 'unconfirmed' as const;
    }, () => 'unconfirmed' as const);
  }

  /**
   * §1 step 3 — the in-process consumer asks, once per request, for the holder's window renewal
   * before it acts. Null when there is nothing to extend (switch off, not the holder, no peer).
   * Resolves when that renewal is confirmed, or after the broadcast deadline passes.
   */
  awaitWindowRenewalForConsumer(req: { requestedBy?: string; reason?: string; requestedAt?: string }): Promise<unknown> | null {
    if (!this.continuitySettings()) return null;
    if (!this.holdsLease()) return null;
    const ep = this.openEpisode({ requestedBy: req.requestedBy ?? 'unattributed', reason: req.reason ?? '', requestedAt: req.requestedAt ?? null }, 'sighting');
    if (!ep) return null;
    ep.fileLastSeenMs = this.now();
    ep.filePresent = true;
    if (ep.confirmed && ep.lastWindowLease && Date.parse(ep.lastWindowLease.expiresAt) - this.now() > ep.windowMs / 2) return null;
    const p = this.extendForEpisode(ep);
    if (!p) return null;
    const deadline = (this.d.broadcastDeadlineMs?.() ?? 8_000) + 2_000;
    return Promise.race([p, new Promise((r) => { const t = setTimeout(r, deadline); (t as { unref?: () => void }).unref?.(); })]);
  }

  /** §1 step 3 — open an episode (or re-read an open one). Returns null when the request is a capped one. */
  private openEpisode(req: { requestedBy: string; reason: string; requestedAt: string | null }, source: 'announce' | 'sighting'): PendingEpisode | null {
    const settings = this.continuitySettings();
    if (!settings) return null;
    if (this.episode) return this.episode;
    if (this.cappedRequest && this.cappedRequest.requestedBy === req.requestedBy && this.cappedRequest.requestedAt === req.requestedAt) return null;
    const { windowMs, note } = this.resolveWindow(settings);
    const ep: PendingEpisode = {
      id: this.d.continuity?.newEpisodeId() ?? `${Date.now()}`,
      openedAtMs: this.now(),
      requestedBy: req.requestedBy,
      reason: req.reason,
      requestedAt: req.requestedAt,
      windowMs,
      windowClampLogged: false,
      fileLastSeenMs: source === 'sighting' ? this.now() : null,
      filePresent: source === 'sighting',
      consumptionAtMs: null,
      ledgerLookedUp: false,
      ledgerCoverage: null,
      extendLogged: false,
      lastWindowLease: null,
      confirmed: false,
      heldRowWritten: false,
      lastHourlyLogMs: this.now(),
      afterLatePromotion: req.requestedBy === 'role-change' && this.d.bootRoleAwake?.() === false,
      announcedAtMs: null,
      publishSettledAtMs: null,
    };
    this.episode = ep;
    if (note) { ep.windowClampLogged = true; this.log(`lease-continuity: ${note}.`); }
    try { this.d.onEpisodeChange?.(true); } catch { /* @silent-fallback-ok: a cadence re-arm fault never stops the renewal */ }
    return ep;
  }

  /** The first pending renewal of an episode: the sentence and the evidence row belong to it, not to the announce. */
  private noteFirstExtension(ep: PendingEpisode, epoch: number): void {
    if (ep.extendLogged) return;
    ep.extendLogged = true;
    this.log(`lease-continuity: a restart is pending (${ep.requestedBy}: ${ep.reason || 'no reason given'}); epoch ${epoch} is being renewed with a ${ep.windowMs} ms expiry so the lead survives the restart.`);
    featureEvidence.record('multiMachine.takeoverReadyPool', {
      kind: 'fired',
      reason: 'pending restart renewal extended the lease',
      context: { epoch, windowMs: ep.windowMs, requestedBy: ep.requestedBy.slice(0, 120) },
    });
  }

  /**
   * §1 step 1 — the 2 s poll while holder (and the renew tick): read the request file through the
   * dep and feed the episode. Backs off on a read error (the caller doubles its interval on false).
   */
  pollRequestFile(): boolean {
    if (!this.d.readRequestFile) return true;
    if (!this.continuitySettings()) return true;
    // Only a holder, a machine with an open episode, or a boot still confirming its window lease
    // (an episode open at confirmation makes the boot renewal a window renewal) reads the file.
    if (!this.holdsLease() && !this.episode && !this.bootReclaimPending()) return true;
    let file: ReturnType<NonNullable<LeaseCoordinatorDeps['readRequestFile']>>;
    try {
      file = this.d.readRequestFile();
    } catch (err) {
      // @silent-fallback-ok: logged; false backs the poll off and the next tick reads the file again
      this.log(`lease-continuity: the restart request file could not be read (${err instanceof Error ? err.message : String(err)}); polling backs off.`);
      return false;
    }
    this.noteRequestFile(file);
    if (this.episode) this.evaluateEpisode();
    return true;
  }

  /** §2 step 2 — the transport's probe events, for the coordinator's reclaim nudge. Returns a detach. */
  attachProbeListenerForReclaim(listener: () => void): () => void {
    if (!this.d.tunnel?.attachProbeListener) return () => {};
    return this.d.tunnel.attachProbeListener(() => { if (this.bootReclaimPending()) listener(); });
  }

  /** §2 — whether a known peer is answering unsigned right now (the boot wait extends while one does). */
  reclaimHasUnsignedPeer(): boolean {
    const probes = this.d.tunnel?.probeHistory?.();
    if (!probes) return false;
    for (const rec of probes.values()) {
      const last = rec.probes[rec.probes.length - 1];
      if (last && last.answer === 'unsigned') return true;
    }
    return false;
  }

  /** §1 step 1 — this process withdrew its request (withdrawRoleRestart). */
  noteRestartWithdrawn(): void {
    if (!this.episode) return;
    this.endEpisode('withdrawn');
  }

  /**
   * The poll and the renew tick report the request file's state here (§1 steps 1 and 3): a present
   * file opens an episode; an absent one is judged by the episode rule (never ended by a consumer's
   * deletion alone).
   */
  noteRequestFile(file: { present: boolean; requestedBy?: string | null; reason?: string | null; requestedAt?: string | null }): void {
    const settings = this.continuitySettings();
    if (!settings) return;
    const now = this.now();
    if (file.present) {
      if (this.cappedRequest && (this.cappedRequest.requestedBy !== (file.requestedBy ?? 'unattributed') || this.cappedRequest.requestedAt !== (file.requestedAt ?? null))) {
        this.cappedRequest = null; // the file changed: a new request may extend again
      }
      const hadEpisode = this.episode !== null;
      const ep = this.openEpisode({ requestedBy: file.requestedBy ?? 'unattributed', reason: file.reason ?? '', requestedAt: file.requestedAt ?? null }, 'sighting');
      if (ep) {
        ep.fileLastSeenMs = now;
        ep.filePresent = true;
        // A request written outside this process (the supervisor's consumers poll every 10 s): the
        // window renewal is signed, persisted and broadcast now rather than at the next renew tick.
        if (!hadEpisode) void this.extendForEpisode(ep);
      }
      return;
    }
    if (this.cappedRequest) this.cappedRequest = null; // the capped request is gone
    const ep = this.episode;
    if (!ep) return;
    ep.filePresent = false;
    // An announced episode whose file never appeared: closed one poll after the announce settled, unless a consumer took it.
    if (ep.fileLastSeenMs === null && ep.announcedAtMs !== null) {
      const settled = ep.publishSettledAtMs ?? (ep.announcedAtMs + (this.d.broadcastDeadlineMs?.() ?? 8_000));
      if (now - settled >= 2_000) {
        this.lookupConsumption(ep);
        if (ep.consumptionAtMs === null && ep.ledgerLookedUp) {
          this.log(`lease-continuity: the announced restart request (${ep.requestedBy}) never appeared on disk; the writer failed to publish and the episode is closed.`);
          this.endEpisode('withdrawn');
        }
      }
      return;
    }
    this.evaluateEpisode();
  }

  private lookupConsumption(ep: PendingEpisode): 'full' | 'cut' | 'unreadable' {
    if (!this.d.findConsumption) { ep.ledgerLookedUp = true; return 'unreadable'; }
    const r = this.d.findConsumption({ requestedAt: ep.requestedAt, sinceMs: ep.openedAtMs });
    ep.ledgerLookedUp = true;
    ep.ledgerCoverage = r.coverage;
    if (r.record) {
      const at = Date.parse(r.record.at);
      ep.consumptionAtMs = Number.isFinite(at) ? at : this.now();
    }
    return r.coverage;
  }

  /** Called from the renew tick and the poll: the episode rule, the hourly line and the held row. */
  evaluateEpisode(): void {
    const ep = this.episode;
    if (!ep) return;
    const now = this.now();
    const absentFor = ep.filePresent ? 0 : now - (ep.fileLastSeenMs ?? ep.openedAtMs);
    // A cut or unreadable read is retried on every evaluation and never promoted to "full" on its own.
    if (!ep.filePresent && absentFor >= 60_000 && ep.consumptionAtMs === null && (!ep.ledgerLookedUp || ep.ledgerCoverage !== 'full')) this.lookupConsumption(ep);
    const coverage: 'full' | 'cut' | 'unreadable' = ep.ledgerLookedUp ? (ep.ledgerCoverage ?? 'unreadable') : 'cut';
    const verdict = evaluateEpisodeEnd({
      nowMs: now,
      openedAtMs: ep.openedAtMs,
      fileLastSeenMs: ep.fileLastSeenMs,
      filePresent: ep.filePresent,
      consumptionAtMs: ep.consumptionAtMs,
      ledgerCoverage: coverage,
      withdrawn: false,
      shutdownDeadlineMs: this.d.shutdownDeadlineMs?.(),
    });
    if (verdict.ended) { this.endEpisode(verdict.cause); return; }
    if (!ep.heldRowWritten && now - ep.openedAtMs >= 60 * 60_000) {
      ep.heldRowWritten = true;
      featureEvidence.record('multiMachine.takeoverReadyPool', {
        kind: 'held',
        reason: 'a restart has been pending for an hour',
        context: { pendingForMs: now - ep.openedAtMs, requestedBy: ep.requestedBy.slice(0, 120) },
      });
    }
    if (now - ep.lastHourlyLogMs >= 60 * 60_000) {
      ep.lastHourlyLogMs = now;
      this.log(`lease-continuity: a restart (${ep.requestedBy}) has been pending for ${Math.round((now - ep.openedAtMs) / 60_000)} minutes; the lease keeps its ${ep.windowMs} ms expiry until a consumer acts.`);
    }
  }

  private endEpisode(cause: 'withdrawn' | 'removed-without-consumption' | 'consumed-process-alive' | 'cap'): void {
    const ep = this.episode;
    if (!ep) return;
    this.episode = null;
    if (cause === 'cap') {
      this.cappedRequest = { requestedAt: ep.requestedAt, requestedBy: ep.requestedBy };
      this.log(`lease-continuity: a restart request (${ep.requestedBy}) has been pending for four hours and no consumer acted on it; renewals return to the lease TTL.`);
    } else if (cause === 'removed-without-consumption') {
      this.log(`lease-continuity: the restart request (${ep.requestedBy}) was removed without being acted on; renewals return to the lease TTL.`);
    } else if (cause === 'consumed-process-alive') {
      this.log(`lease-continuity: the restart request (${ep.requestedBy}) was consumed but this process is still running; renewals return to the lease TTL.`);
      featureEvidence.record('multiMachine.takeoverReadyPool', { kind: 'error', reason: 'a consumed restart request did not end this process', context: { requestedBy: ep.requestedBy.slice(0, 120) } });
    }
    this.d.continuity?.delete();
    // One TTL renewal follows at once, so the store never holds an unmarked long-expiry record (a
    // crash in the next minutes must boot on today's path with today's expiry, not the window's).
    if (!this.renewToTtlNow()) {
      try { this.d.store.clearPendingEpisodeId?.(); } catch { /* @silent-fallback-ok: the marker is cleared again by the next ordinary renewal */ }
    }
    try { this.d.onEpisodeChange?.(false); } catch { /* @silent-fallback-ok */ }
  }

  /** Sign a TTL renewal now, write it to the local store without the marker, and broadcast it. False when not the holder. */
  private renewToTtlNow(): boolean {
    const view = this.effectiveView();
    if (!view.lease || view.lease.holder !== this.selfMachineId || this.fl.isExpired(view.lease, this.now()) || this.lastRenewOkMonoMs === null) return false;
    const ttl = this.fl.signLease(view.epoch, view.lease.acquiredAt, new Date(this.now() + this.fl.ttlMs).toISOString(), this.nextNonce());
    this.installRenewal(ttl);
    try {
      if (this.d.store.refreshWithPending) this.d.store.refreshWithPending(ttl, null);
      else if (!this.d.tunnel) this.d.store.refresh(ttl);
    } catch (err) {
      this.log(`lease-continuity: the local lease store could not take the TTL renewal (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (this.d.tunnel) {
      const generation = this.relinquishGeneration;
      void this.d.tunnel.broadcast(ttl, () => this.adoptLateRenewal(ttl, generation)).then((ok) => {
        if (ok && generation === this.relinquishGeneration) { this.installRenewal(ttl); this.markRenewOk(ttl.nonce); }
      }, () => { /* @silent-fallback-ok: the renew tick retries at its cadence */ });
    }
    return true;
  }

  /** §1 step 5 — the shutdown handler's one synchronous action. */
  stampContinuityExit(): boolean {
    return this.d.continuity?.stampExit(this.lastConfirmedNonce) ?? false;
  }

  // ── Rule 1b ──────────────────────────────────────────────────────

  /** Whether a window lease found at construction still awaits its verdict. */
  bootReclaimPending(): boolean {
    return this.bootReclaim !== null && this.bootReclaim.verdict === null;
  }

  /** The record left by the last restart said that boot followed a late promotion (the wait is the full window). */
  reclaimAfterLatePromotion(): boolean {
    return this.bootReclaim?.file?.meta.afterLatePromotion === true;
  }

  /** The window lease's remaining time at boot, for the coordinator's wait bound (clamped to its own window). */
  reclaimRemainingWindowMs(): number {
    const r = this.bootReclaim;
    if (!r) return 0;
    const exp = Date.parse(r.lease.expiresAt);
    const windowMs = r.file?.meta.windowMs ?? Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(Number.isFinite(exp) ? exp - this.now() : 0, windowMs));
  }

  /** Resolves with the reclaim's verdict, or `timeout` after `maxMs`. Resolves at once when nothing is pending. */
  awaitReclaimVerdict(maxMs: number): Promise<ReclaimVerdict> {
    if (!this.bootReclaimPending()) return Promise.resolve(this.bootReclaim?.verdict ?? 'timeout');
    return new Promise<ReclaimVerdict>((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve('timeout'); } }, Math.max(0, maxMs));
      timer.unref?.();
      this.reclaimWaiters.push((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } });
    });
  }

  private settleReclaimWaiters(v: ReclaimVerdict): void {
    const waiters = this.reclaimWaiters.splice(0);
    for (const w of waiters) { try { w(v); } catch { /* @silent-fallback-ok */ } }
  }

  /**
   * §2 steps 3–6 — one evaluation of the window lease against the latest evaluable round: adopt a
   * newer epoch or live other holder; renew after a qualifying answer from a live peer; renew as a
   * survivor hold when every known peer is presumed dead or settled silent; otherwise wait.
   */
  private async evaluateReclaim(view: { lease: LeaseRecord | null; epoch: number }): Promise<boolean> {
    const r = this.bootReclaim;
    if (!r || r.verdict !== null || !view.lease) return false;
    const transport = this.d.tunnel;
    // Superseded: a newer epoch, or a live lease at this epoch held by another machine (effectiveView masks it).
    if (this.newerViewThanBootRecord() || this.liveOtherHolderAtSameEpoch(view.epoch)) {
      this.finishReclaim('superseded', 'none', null);
      return false;
    }
    const known = transport?.knownPeerIds?.() ?? [];
    if (known.length === 0 || !transport) {
      // Nobody to ask: a medium confirms (zero peers → broadcast resolves true), as today.
      return this.renewForReclaim('peer-confirmed', [], []);
    }
    let round = transport.currentPullRound?.() ?? { round: 0, startedAtMs: 0 };
    if (round.round === 0) {
      // No round yet (the pull loop's first tick is still ahead): ask now rather than wait for it,
      // so a peer that answers at once confirms the lead inside the boot's own lease initialisation.
      try { await this.pullFromPeers(); } catch { /* @silent-fallback-ok: an unreachable peer is judged by the round rule below */ }
      round = transport.currentPullRound?.() ?? { round: 0, startedAtMs: 0 };
      if (round.round === 0) return false;
    }
    const probes = transport.probeHistory?.() ?? new Map<string, PeerProbeRecord>();
    const answers = transport.verifiedAnswers?.() ?? new Map<string, { lease: LeaseRecord | null; atMs: number; round: number }>();
    // With the liveness derivation off, "live peer" means every known peer not settled silent (a stale
    // registry must never count as death here).
    const dead = (this.d.getLivenessEnabled?.() ?? true) ? this.d.presumedDeadHolders({ liveness: true }) : new Set<string>();
    const settings = { silentProbes: this.bootClaimSafetySettings()?.silentProbes ?? DEFAULT_BOOT_HOLD_SETTINGS.silentProbes, silentSpanMs: this.bootClaimSafetySettings()?.silentSpanMs ?? DEFAULT_BOOT_HOLD_SETTINGS.silentSpanMs };
    const settledSilent = (p: string) => classifyPeer(probes.get(p), unsignedAnswerWindowMs(this.d.peerRestartBudgetMs?.(p) ?? null), settings) === 'silent-enough';
    // A peer whose last probes were all silent for THIS machine's reasons (every route refused here, or
    // nothing dialable) is alive-and-unknown: it stays in the live set whatever the registry or the
    // probe count says, so no survivor hold is taken on our own blindness. The window bounds the wait.
    const unknownHere = (p: string) => {
      const rec = probes.get(p);
      if (!rec || rec.probes.length < settings.silentProbes || silenceIsEvidence(rec, settings.silentProbes)) return false;
      if (!this.reclaimUnknownLogged.has(p)) {
        this.reclaimUnknownLogged.add(p);
        const cause = rec.probes[rec.probes.length - 1]?.cause ?? 'local-refusal';
        this.log(`lease-continuity: ${p} cannot be dialed from this machine (${cause === 'no-route' ? 'it advertises no route this machine may dial' : 'every route is refused on this machine\'s side: no route to host or a network permission'}); it is treated as alive and unknown, never as dead, so no survivor hold is taken while this lasts.`);
      }
      return true;
    };
    const live = known.filter((p) => unknownHere(p) || (!dead.has(p) && !settledSilent(p)));
    const roundOutcome = (p: string) => (probes.get(p)?.probes ?? []).some((pr) => pr.atMs >= round.startedAtMs);
    const evaluable = known.every(roundOutcome) || this.now() - round.startedAtMs >= ASK_DEADLINE_MS;
    if (!evaluable) return false;
    const answered = live.filter((p) => { const a = answers.get(p); return !!a && a.round === round.round; });
    if (live.length === 0) {
      return this.renewForReclaim('survivor-hold', known, []);
    }
    if (answered.length > 0) {
      return this.renewForReclaim('peer-confirmed', known, answered);
    }
    return false; // live peers that have not answered yet: wait for the next round
  }

  private liveOtherHolderAtSameEpoch(epoch: number): boolean {
    for (const [peerId, rec] of this.peerLeaseObservations()) {
      const l = rec.lease;
      if (!l || l.holder === this.selfMachineId || l.holder !== peerId || l.released) continue;
      if (l.epoch === epoch && !this.fl.isExpired(l, this.now()) && this.fl.verifyLease(l)) return true;
    }
    return false;
  }

  /** The reclaim's renewal: TTL expiry (or the window if an episode is already open), confirmed by a medium or as a survivor hold. */
  private async renewForReclaim(basis: 'peer-confirmed' | 'survivor-hold', known: string[], answered: string[]): Promise<boolean> {
    const r = this.bootReclaim;
    const view = this.effectiveView();
    if (!r || !view.lease || view.lease.holder !== this.selfMachineId) return false;
    if (this.fl.isExpired(view.lease, this.now())) return false; // straddled the expiry: the lapsed path applies
    const pendingWindow = this.pendingWindowMs();
    const renewed = this.fl.signLease(view.epoch, view.lease.acquiredAt, new Date(this.now() + (pendingWindow ?? this.fl.ttlMs)).toISOString(), this.nextNonce());
    const generation = this.relinquishGeneration;
    let confirmed: boolean;
    if (this.d.tunnel) {
      confirmed = await this.d.tunnel.broadcast(renewed, () => this.adoptLateRenewal(renewed, generation)).catch(() => false); // @silent-fallback-ok: an unanswered broadcast is an unconfirmed renewal; the caller treats false as not renewed
      if (generation !== this.relinquishGeneration) return false;
    } else {
      confirmed = this.d.store.refresh(renewed);
    }
    if (basis === 'survivor-hold') {
      // §2 step 5 — every known peer is presumed dead or settled silent: the same evidence R1 accepts
      // for a claim of the next epoch; keep this one instead, and prime the fence.
      this.installRenewal(renewed);
      this.markRenewOk(confirmed ? renewed.nonce : null);
      const silent = known.join(', ') || 'none';
      this.log(`lease-continuity: every known peer (${silent}) has been silent for at least the boot hold's span; this machine keeps its own epoch ${view.epoch} as a survivor hold, as boot claim safety would let it renew its own epoch now.`);
      this.finishReclaim('survivor-hold', 'survivor-hold', renewed, { known, answered });
      return true;
    }
    if (confirmed) {
      this.installRenewal(renewed);
      this.markRenewOk(renewed.nonce);
      this.finishReclaim('confirmed', 'peer-confirmed', renewed, { known, answered });
      return true;
    }
    if (!r.unconfirmedLogged) {
      r.unconfirmedLogged = true;
      this.log(`lease-continuity: the renewal of epoch ${view.epoch} after this machine's planned restart has not been confirmed by a peer yet; this machine stays standby until it is.`);
    }
    return false;
  }

  /** §2 steps 4, 6 and 7 — measure, record, clean up, and settle the waiters. */
  private finishReclaim(verdict: 'confirmed' | 'superseded' | 'survivor-hold' | 'lapsed', basis: 'peer-confirmed' | 'survivor-hold' | 'none', renewed: LeaseRecord | null, peers?: { known: string[]; answered: string[] }): void {
    const r = this.bootReclaim;
    if (!r || r.verdict !== null) return;
    r.verdict = verdict;
    const meta = r.file?.meta ?? null;
    const consumption = this.d.findConsumption && meta ? this.d.findConsumption({ requestedAt: meta.requestedAt, sinceMs: Date.parse(meta.episodeOpenedAt) || 0 }).record : null;
    const consumptionAtMs = consumption ? Date.parse(consumption.at) : null;
    const renewedAt = meta?.renewedAt ?? r.lease.expiresAt; // without a file the lease's own stamps are all we have
    const ms = bootDurationMs({ nowMs: this.now(), exitedAt: meta?.exitedAt ?? null, renewedAt, consumptionAtMs: Number.isFinite(consumptionAtMs ?? NaN) ? consumptionAtMs : null });
    const outcome = meta ? (meta.exitedAt ? 'planned' : 'exit-unstamped') : 'no-record';
    const requestedBy = (meta?.requestedBy ?? 'unknown').slice(0, 120);
    if (ms !== null && this.d.continuity) {
      const { previousSlowestMs } = this.d.continuity.appendBootSample(ms, verdict === 'superseded' || verdict === 'lapsed' ? verdict : outcome, basis);
      if (previousSlowestMs !== null && ms > previousSlowestMs) {
        this.log(`lease-continuity: this boot took ${ms} ms, longer than the slowest measured so far (${previousSlowestMs} ms); the next window will cover it.`);
      }
    }
    const silent = peers ? peers.known.filter((p) => !peers.answered.includes(p)) : [];
    if (verdict === 'lapsed') {
      this.log(`lease-continuity: the window of the lease this machine held before its planned restart ran out (boot ${ms ?? 'unknown'} ms against a ${meta?.windowMs ?? 'unknown'} ms window) before a peer answered; today's lapsed path applies.`);
    } else if (verdict === 'superseded') {
      const view = this.effectiveView();
      const holder = view.lease?.holder ?? 'unknown';
      this.log(`lease-continuity: the lease this machine held before its planned restart was superseded by epoch ${view.epoch}, now held by ${holder}; this machine adopts it and discards its continuity record.`);
      featureEvidence.record('multiMachine.takeoverReadyPool', {
        kind: 'fired',
        reason: 'taken over during a planned-restart boot',
        context: { epoch: r.lease.epoch, newEpoch: view.epoch, holder, bootMs: ms ?? -1, windowMs: meta?.windowMs ?? -1, requestedBy },
      });
    } else {
      this.bootHoldEnded = true;
      this.log(`lease-continuity: this machine renewed its own epoch ${r.lease.epoch} after its planned restart (${requestedBy}; boot ${ms ?? 'unknown'} ms; ${peers?.known.length ?? 0} peers asked, ${peers?.answered.length ?? 0} answered${silent.length ? `, ${silent.join(', ')} silent` : ''}); it keeps the lead.`);
      featureEvidence.record('multiMachine.takeoverReadyPool', {
        kind: 'fired',
        reason: 'kept the lead through a planned restart',
        context: { epoch: r.lease.epoch, bootMs: ms ?? -1, windowMs: meta?.windowMs ?? -1, requestedBy, confirmedAtExit: meta?.confirmed ?? false, peersAsked: peers?.known.length ?? 0, peersAnswered: peers?.answered.length ?? 0, outcome, basis },
      });
      if (renewed && !this.episode) {
        try { this.d.store.refreshWithPending?.(renewed, null); } catch { /* @silent-fallback-ok: the marker is cleared by the next renewal */ }
      }
    }
    // The record left by the last restart is spent either way; an episode already open writes the
    // next one from the confirmed renewal at once (§1 step 4).
    this.d.continuity?.delete();
    if (verdict === 'superseded') {
      // The store's own window record is spent: force-expire it (epoch floor kept, marker cleared) so a
      // crash before the next write never boots it as a live lease.
      let stored: LeaseRecord | null = null;
      try { stored = this.d.store.read().lease; } catch { stored = null; } // @silent-fallback-ok
      try {
        if (stored && stored.holder === this.selfMachineId && stored.epoch === r.lease.epoch && this.d.store.forceLocalExpiry) this.d.store.forceLocalExpiry();
        else this.d.store.clearPendingEpisodeId?.();
      } catch { /* @silent-fallback-ok */ }
    } else if (!this.episode) { try { this.d.store.clearPendingEpisodeId?.(); } catch { /* @silent-fallback-ok */ } }
    else if (renewed) this.persistPending(renewed, true);
    this.settleReclaimWaiters(verdict);
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
