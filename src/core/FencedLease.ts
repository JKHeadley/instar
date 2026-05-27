/**
 * FencedLease — the single coordination primitive for cross-machine
 * seamlessness: "exactly one holder, safe under clock skew and partition."
 *
 * Spec: docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md §6.
 *
 * This module is the PURE LOGIC of the lease — epoch arithmetic, signing,
 * expiry, the fencing check, tunnel-message acceptance, and the acquisition
 * decision. The transport (git push-or-reject-reread, tunnel broadcast) is
 * driven by a higher-level coordinator that calls these methods; keeping the
 * logic pure makes the dangerous parts (CAS, fencing, clock-skew) unit-testable
 * with in-memory fakes.
 *
 * Authority is the EPOCH (a monotonically increasing integer advanced once per
 * acquisition), never wall-clock time. A machine with a fast clock cannot win
 * anything — it has no way to advance the epoch without a valid CAS. `lastSeen`
 * is retained only for the liveness heuristic (presumed-dead), and that
 * threshold must exceed worst-case NTP drift by ≥2× (enforced by the caller).
 */

import type { LeaseRecord } from './types.js';

/** Crypto seam — injected so the logic is testable without real key files. */
export interface LeaseCrypto {
  /** This machine's id (the only id we may name as `holder` when signing). */
  selfMachineId: string;
  /** Sign canonical bytes with this machine's Ed25519 private key → base64. */
  sign(canonical: string): string;
  /**
   * Verify a signature attributed to `holderMachineId` against that machine's
   * REGISTERED public key (looked up from the SAS-verified pairing registry).
   * Returns false if the holder is unknown or the signature is invalid — so a
   * forged lease naming an unknown/foreign holder never verifies.
   */
  verify(canonical: string, signature: string, holderMachineId: string): boolean;
}

export interface FencedLeaseConfig {
  leaseTtlMs: number;
  failoverThresholdMs: number;
  /** Bounded CAS retry before the livelock backoff kicks in. Default 5. */
  casMaxRetries?: number;
}

export interface AcquireDecision {
  can: boolean;
  reason: string;
}

export interface TunnelAcceptDecision {
  accept: boolean;
  reason: string;
}

const DEFAULT_CAS_MAX_RETRIES = 5;

export class FencedLease {
  private readonly crypto: LeaseCrypto;
  private readonly leaseTtlMs: number;
  private readonly failoverThresholdMs: number;
  private readonly casMaxRetries: number;

  constructor(crypto: LeaseCrypto, config: FencedLeaseConfig) {
    this.crypto = crypto;
    this.leaseTtlMs = config.leaseTtlMs;
    this.failoverThresholdMs = config.failoverThresholdMs;
    this.casMaxRetries = config.casMaxRetries ?? DEFAULT_CAS_MAX_RETRIES;
  }

  get selfMachineId(): string {
    return this.crypto.selfMachineId;
  }

  // ── Canonical serialization + signing ─────────────────────────────

  /**
   * Stable, field-ordered serialization of the signable lease fields. The
   * signature covers exactly these so a holder cannot later be impersonated
   * by re-ordering fields or smuggling extra keys.
   */
  static canonicalize(lease: Pick<LeaseRecord, 'holder' | 'epoch' | 'acquiredAt' | 'expiresAt' | 'nonce'>): string {
    return JSON.stringify([lease.holder, lease.epoch, lease.acquiredAt, lease.expiresAt, lease.nonce]);
  }

  /** Build + sign a lease record naming THIS machine as holder. */
  signLease(epoch: number, acquiredAtIso: string, expiresAtIso: string, nonce: number): LeaseRecord {
    const base = {
      holder: this.crypto.selfMachineId,
      epoch,
      acquiredAt: acquiredAtIso,
      expiresAt: expiresAtIso,
      nonce,
    };
    const signature = this.crypto.sign(FencedLease.canonicalize(base));
    return { ...base, signature };
  }

  /** Verify a lease's signature against its claimed holder's registered key. */
  verifyLease(lease: LeaseRecord): boolean {
    if (!lease || typeof lease.holder !== 'string' || typeof lease.epoch !== 'number') return false;
    return this.crypto.verify(FencedLease.canonicalize(lease), lease.signature, lease.holder);
  }

  // ── Expiry + epoch ────────────────────────────────────────────────

  /** True if the lease's holder-local expiry has passed. */
  isExpired(lease: LeaseRecord | undefined | null, nowMs: number): boolean {
    if (!lease) return true;
    const expMs = Date.parse(lease.expiresAt);
    if (Number.isNaN(expMs)) return true;
    return nowMs >= expMs;
  }

  /**
   * The epoch the fencing check uses: max(tunnel-observed, git-committed).
   * A fast tunnel copy can ACCELERATE acquisition but can never lower the
   * observed epoch below what git has already committed (spec §6).
   */
  static effectiveEpoch(tunnelEpoch: number, gitEpoch: number): number {
    return Math.max(tunnelEpoch | 0, gitEpoch | 0);
  }

  // ── Fencing check (before EVERY awake-only action) ────────────────

  /**
   * Does THIS machine hold the lease at the current effective epoch? Used to
   * gate ingress polls, scheduler ticks, outbound sends, and authority-bearing
   * registry writes. A wedged old-awake whose lease moved on fails this and is
   * fenced out (spec §6 "Fencing check").
   */
  holdsValidLease(lease: LeaseRecord | undefined | null, effectiveEpoch: number, nowMs: number): boolean {
    if (!lease) return false;
    if (lease.holder !== this.crypto.selfMachineId) return false;
    // The lease we hold must be AT the current effective epoch — a stale-epoch
    // lease (someone advanced past us) does not grant authority.
    if (lease.epoch !== effectiveEpoch) return false;
    if (this.isExpired(lease, nowMs)) return false;
    return this.verifyLease(lease);
  }

  /**
   * Should an action stamped with `stampedEpoch` be honored, given the current
   * effective epoch? Any consumer (registry, outbox, channel-send) rejects
   * actions stamped with a stale epoch (spec §6). Late writes/sends from a
   * fenced old-awake carry an old epoch and are dropped.
   */
  static isStampCurrent(stampedEpoch: number, effectiveEpoch: number): boolean {
    return stampedEpoch === effectiveEpoch;
  }

  // ── Tunnel lease acceptance (replay + floor guard) ────────────────

  /**
   * Decide whether to accept a lease record observed over the tunnel. Accept
   * ONLY if: the signature verifies, the epoch is ≥ the git-committed floor
   * (a below-floor message can neither trick a standby into believing a stale
   * lease is current nor suppress a legitimate acquisition), AND the per-holder
   * nonce is strictly greater than the last seen for that holder (replay guard).
   */
  acceptTunnelLease(
    msg: LeaseRecord,
    gitCommittedEpoch: number,
    lastNonceByHolder: Record<string, number>,
  ): TunnelAcceptDecision {
    if (!this.verifyLease(msg)) {
      return { accept: false, reason: 'signature-invalid-or-unknown-holder' };
    }
    if (msg.epoch < gitCommittedEpoch) {
      return { accept: false, reason: `below-git-floor (msg epoch ${msg.epoch} < committed ${gitCommittedEpoch})` };
    }
    const lastNonce = lastNonceByHolder[msg.holder] ?? -1;
    if (msg.nonce <= lastNonce) {
      return { accept: false, reason: `replayed-or-stale-nonce (${msg.nonce} <= ${lastNonce})` };
    }
    return { accept: true, reason: 'accepted' };
  }

  // ── Acquisition decision (CAS candidate) ──────────────────────────

  /**
   * May this machine attempt to acquire the lease right now? True when:
   *  - there is no current lease, OR
   *  - the current lease is expired, OR
   *  - the current holder is presumed dead (caller passes the set, derived
   *    from lastSeen > failoverThresholdMs — never from a raw clock compare).
   * A genuinely-live contended lease is resolved by the CAS itself (only one
   * epoch advance wins); this method only decides whether to try.
   */
  canAcquire(
    currentLease: LeaseRecord | undefined | null,
    presumedDeadHolders: ReadonlySet<string>,
    nowMs: number,
  ): AcquireDecision {
    if (!currentLease) return { can: true, reason: 'no-current-lease' };
    if (this.isExpired(currentLease, nowMs)) return { can: true, reason: 'current-lease-expired' };
    if (currentLease.holder === this.crypto.selfMachineId) {
      return { can: true, reason: 'self-renew' };
    }
    if (presumedDeadHolders.has(currentLease.holder)) {
      return { can: true, reason: `holder-presumed-dead (${currentLease.holder})` };
    }
    return { can: false, reason: `held-by-live-peer (${currentLease.holder})` };
  }

  /**
   * Build the CAS candidate that advances the epoch by exactly one. Acquisition
   * may only ever write `epoch = currentEpoch + 1`; epoch GAPS are explicitly
   * safe (a higher epoch observed on re-read always wins). The expiry is
   * holder-local (now + TTL), used for liveness/display, never for authority.
   */
  buildAcquisition(currentLease: LeaseRecord | undefined | null, nowMs: number, nonce: number): LeaseRecord {
    const currentEpoch = currentLease?.epoch ?? 0;
    const acquiredAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.leaseTtlMs).toISOString();
    return this.signLease(currentEpoch + 1, acquiredAt, expiresAt, nonce);
  }

  /**
   * After CAS exhaustion (bounded retry), should THIS machine back off to let
   * the other side land (livelock prevention, spec §6)? The deterministic rule:
   * the higher unforgeable machineId backs off for one lease-TTL, guaranteeing
   * one side wins. Below the retry cap, no backoff (keep contending).
   */
  shouldBackoffAfterContention(retryCount: number, contenderMachineId: string): boolean {
    if (retryCount < this.casMaxRetries) return false;
    // Higher machineId yields; lower machineId keeps trying → exactly one lands.
    return this.crypto.selfMachineId > contenderMachineId;
  }

  /** Backoff duration after losing CAS contention. */
  get backoffMs(): number {
    return this.leaseTtlMs;
  }

  /** Expose config for callers that derive timers from it. */
  get ttlMs(): number {
    return this.leaseTtlMs;
  }
  get presumedDeadThresholdMs(): number {
    return this.failoverThresholdMs;
  }
}
