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

/**
 * F2 (staleHolderTakeover) inputs to `canAcquire`, passed ONLY when the dark
 * `multiMachine.leaseSelfHeal.staleHolderTakeover` flag is enabled. All times
 * are the OBSERVER's OWN monotonic clock (no remote wall-clock subtraction) so
 * the takeover decision is clock-skew immune. `freshObservedMonoMs` is stamped
 * when the holder's signed nonce watermark last advanced on a VERIFIED tunnel
 * fold-in; `undefined` ⇒ never observed ⇒ fail-closed (no takeover).
 */
export interface StaleHolderTakeoverOpts {
  monotonicNowMs: number;
  freshObservedMonoMs: number | undefined;
  /** ttlMs × nonRenewalMissedObservations */
  nonRenewalThresholdMs: number;
}

/**
 * U4.4 (lease hand-back, R-r2-1) — the SIGNED, epoch-bound, TTL-bounded,
 * SINGLE-USE holder consent token. `canAcquire` returns `held-by-live-peer`
 * for a live, healthy holder — which is EXACTLY the hand-back state (the
 * holder is alive and CONSENTING, not stale). The consent token is the
 * holder's cryptographic authorization for ONE named target to claim at the
 * next epoch. Minted by the holder (signed with its machine key), bound to
 * the holder's CURRENT epoch + the offered target + an expiry + a fresh
 * nonce. Presented at acquire time via `HandbackTakeoverOpts` (the
 * `handbackOpts` analogue of `StaleHolderTakeoverOpts`).
 */
export interface HandbackConsentToken {
  /** The consenting CURRENT holder (the signer). */
  holder: string;
  /** The holder's current epoch the consent is bound to. */
  epoch: number;
  /** The ONLY machine this token authorizes to claim. */
  target: string;
  /** ISO expiry — a token older than this is dead (TTL-bounded). */
  expiresAt: string;
  /** Single-use id, holder-scoped (the acquirer records used nonces). */
  nonce: number;
  /** Holder's Ed25519 signature over the canonical form. */
  signature: string;
}

/**
 * U4.4 inputs to `canAcquire`, passed ONLY when a handback-offer delivered a
 * consent token. FAIL-CLOSED default: absent / invalid / expired / replayed /
 * reused token ⇒ the legacy `held-by-live-peer` refusal, unchanged.
 */
export interface HandbackTakeoverOpts {
  token: HandbackConsentToken;
  /** Single-use enforcement: the caller's used-(holder,nonce) check. */
  alreadyUsed: boolean;
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
  static canonicalize(
    lease: Pick<LeaseRecord, 'holder' | 'epoch' | 'acquiredAt' | 'expiresAt' | 'nonce'> & { released?: boolean },
  ): string {
    const base: Array<string | number | boolean> = [
      lease.holder,
      lease.epoch,
      lease.acquiredAt,
      lease.expiresAt,
      lease.nonce,
    ];
    // OMIT-WHEN-FALSE (multi-machine-lease-self-heal F3, load-bearing invariant):
    // a non-released lease canonicalizes to the IDENTICAL legacy 5-element form,
    // so (a) existing signed leases from un-upgraded peers still verify byte-for-
    // byte and (b) an upgraded signer's normal `released:false` renewal verifies
    // on an un-upgraded verifier. ONLY a genuine tombstone (released===true)
    // appends the 6th element — and that `true` is INSIDE the signature, so a
    // relay can neither strip nor inject it.
    if (lease.released === true) base.push(true);
    return JSON.stringify(base);
  }

  /**
   * Build + sign a lease record naming THIS machine as holder. Pass
   * `released:true` to mint a tombstone (F3 relinquish) — the bit is signed.
   */
  signLease(
    epoch: number,
    acquiredAtIso: string,
    expiresAtIso: string,
    nonce: number,
    released = false,
  ): LeaseRecord {
    const base = {
      holder: this.crypto.selfMachineId,
      epoch,
      acquiredAt: acquiredAtIso,
      expiresAt: expiresAtIso,
      nonce,
      // conditional spread: a non-tombstone record carries NO `released` field
      // at all (so it is byte-identical to a legacy record), a tombstone carries
      // released:true (covered by the signature via canonicalize).
      ...(released ? { released: true as const } : {}),
    };
    const signature = this.crypto.sign(FencedLease.canonicalize(base));
    return { ...base, signature };
  }

  // ── U4.4 hand-back consent token (mint + verify) ──────────────────

  /** Stable, field-ordered serialization of the signable consent fields. The
   *  leading discriminator prevents cross-protocol confusion with a lease
   *  record's canonical form (a consent token can never verify as a lease). */
  static canonicalizeHandbackConsent(
    t: Pick<HandbackConsentToken, 'holder' | 'epoch' | 'target' | 'expiresAt' | 'nonce'>,
  ): string {
    return JSON.stringify(['handback-consent', t.holder, t.epoch, t.target, t.expiresAt, t.nonce]);
  }

  /** Mint a consent token naming THIS machine as the consenting holder.
   *  The CALLER (LeaseCoordinator) is responsible for only minting while it
   *  actually holds the lease at `epoch`. */
  signHandbackConsent(epoch: number, target: string, expiresAtIso: string, nonce: number): HandbackConsentToken {
    const base = {
      holder: this.crypto.selfMachineId,
      epoch,
      target,
      expiresAt: expiresAtIso,
      nonce,
    };
    return { ...base, signature: this.crypto.sign(FencedLease.canonicalizeHandbackConsent(base)) };
  }

  /** Verify a consent token's signature against its claimed holder's
   *  REGISTERED key (an unknown/forged holder never verifies). */
  verifyHandbackConsent(token: HandbackConsentToken): boolean {
    if (!token || typeof token.holder !== 'string' || typeof token.epoch !== 'number') return false;
    if (typeof token.target !== 'string' || typeof token.expiresAt !== 'string') return false;
    if (typeof token.nonce !== 'number' || typeof token.signature !== 'string') return false;
    return this.crypto.verify(FencedLease.canonicalizeHandbackConsent(token), token.signature, token.holder);
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
    staleHolderOpts?: StaleHolderTakeoverOpts,
    handbackOpts?: HandbackTakeoverOpts,
  ): AcquireDecision {
    if (!currentLease) return { can: true, reason: 'no-current-lease' };
    if (this.isExpired(currentLease, nowMs)) return { can: true, reason: 'current-lease-expired' };
    if (currentLease.holder === this.crypto.selfMachineId) {
      return { can: true, reason: 'self-renew' };
    }
    if (presumedDeadHolders.has(currentLease.holder)) {
      return { can: true, reason: `holder-presumed-dead (${currentLease.holder})` };
    }
    // F2 (staleHolderTakeover) — DARK by default: opts are passed ONLY when the
    // flag is on, so with no opts this method is byte-for-byte the legacy
    // behavior. A holder whose signed nonce watermark hasn't advanced for
    // `nonRenewalThresholdMs` of the OBSERVER'S OWN monotonic time is not
    // renewing. Single-clock (no remote wall-clock subtraction) ⇒ skew-immune;
    // unforgeable (the watermark advances only on a VERIFIED tunnel fold-in).
    // FAIL-CLOSED: an absent/NaN observation never grants takeover.
    if (staleHolderOpts) {
      const { monotonicNowMs, freshObservedMonoMs, nonRenewalThresholdMs } = staleHolderOpts;
      if (
        typeof freshObservedMonoMs === 'number' &&
        Number.isFinite(freshObservedMonoMs) &&
        nonRenewalThresholdMs > 0 &&
        monotonicNowMs - freshObservedMonoMs > nonRenewalThresholdMs
      ) {
        const stalledS = Math.round((monotonicNowMs - freshObservedMonoMs) / 1000);
        return { can: true, reason: `holder-not-renewing (nonce watermark stalled ${stalledS}s)` };
      }
    }
    // U4.4 (preferredCaptainHandback, R-r2-1) — the consent-authorized
    // acquisition branch. `held-by-live-peer` is EXACTLY the hand-back state
    // (the holder is alive and consenting, not stale), so a claim is granted
    // ONLY when the presented consent token:
    //   • verifies against the HOLDER's registered key (unforgeable),
    //   • names THIS machine as the target,
    //   • matches the LIVE lease's holder AND epoch (epoch-bound — a token
    //     minted for an older epoch is dead the moment the lease moves),
    //   • is unexpired (TTL-bounded), and
    //   • is unused (single-use — the caller's used-nonce check).
    // FAIL-CLOSED default: absent/invalid/expired/replayed/reused token ⇒ the
    // legacy `held-by-live-peer` refusal below, byte-for-byte unchanged.
    if (handbackOpts) {
      const t = handbackOpts.token;
      const expMs = Date.parse(t?.expiresAt ?? '');
      if (
        !handbackOpts.alreadyUsed &&
        t &&
        t.target === this.crypto.selfMachineId &&
        t.holder === currentLease.holder &&
        t.epoch === currentLease.epoch &&
        Number.isFinite(expMs) &&
        nowMs < expMs &&
        this.verifyHandbackConsent(t)
      ) {
        return { can: true, reason: `handback-consent (from ${t.holder} at epoch ${t.epoch})` };
      }
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
