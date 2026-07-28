/**
 * WS5.2 R7a — per-account spend-slice ORCHESTRATION (the LEASE-SLICED ceiling, owned by the
 * fenced single-writer). This is the cohesive control-plane unit on top of the durable
 * `AccountFollowMeGrantLedger` (AccountFollowMeGrants.ts), kept PURE + injectable so the
 * distributed math is unit-testable without a live mesh.
 *
 * Spec bounds enforced here (docs/specs/ws52-account-follow-me-security.md §R7a, §S5, §I5):
 *
 *  (a) FENCED single-writer issuance. Slices are issued ONLY by the current `FencedLease` holder;
 *      a non-holder issuing is refused (`not-lease-holder`). Issuance is epoch-fenced: a renew
 *      stamped with a stale lease epoch is void (`stale-lease-epoch`). On a holder FAILOVER the new
 *      holder constructs `SliceIssuer` over the SAME durable ledger and re-derives outstanding
 *      slices BEFORE issuing — the ledger's sum-of-leases bound holds across the handoff with no
 *      double-allocation (proven in AccountFollowMeGrants).
 *
 *  (b) `maxSpend` is denominated in provider quota-FRACTION (0..1), reusing AccountQuotaSnapshot.
 *      The issuer takes the ceiling as a fraction; per-slice consumption is the durable grant amount.
 *
 *  (c) The requester-side renewal CONTROL PLANE is rate-capped + coalesced + P19-breaker-protected,
 *      so N VMs on one hot account produce O(per-account-cap) renewal RPCs — never an O(N) herd:
 *        - per-(account,machine) in-flight COALESCING: a VM with an outstanding renewal does not
 *          start a second (`coalesced-in-flight`);
 *        - per-account renewal RATE CAP with EXPONENTIAL backoff after each refusal/failure;
 *        - a P19 sustained-FAILURE breaker: after `breakerThreshold` consecutive failures the VM
 *          FAILS CLOSED TO ITS OWN ACCOUNT (`breaker-open`) instead of retry-storming a slow/
 *          partitioned/unreachable holder. The breaker re-closes after `breakerCooldownMs`.
 *
 *  (d) FIRST-SLICE-under-partition: a VM that never received a slice is treated identically to a
 *      VM whose slice is exhausted — it FAILS CLOSED TO ITS OWN ACCOUNT until it obtains its first
 *      slice (the `decideAccountUse` consultation below).
 *
 * INVARIANT (load-bearing): fail-closed-to-OWN-account on EVERY uncertainty — no slice, exhausted,
 * partition, breaker open, no mandate, ledger error. A borrowed account is NEVER overspent past its
 * grant. Everything stays dark behind `multiMachine.accountFollowMe` at the wiring layer.
 */

import {
  AccountFollowMeGrantLedger,
  type GrantStore,
  type IssueResult,
} from './AccountFollowMeGrants.js';

// ───────────────────────────── Issuer side (the fenced holder) ─────────────────────────────

export interface SliceIssuerConfig {
  /** This machine's id — must equal the lease holder for issuance to be authorized. */
  selfMachineId: string;
  /**
   * The current effective lease epoch + whether THIS machine holds the lease at it. Read live so a
   * mid-flight failover (we lost the lease) refuses issuance rather than double-allocating.
   */
  holdsLease: () => boolean;
  currentLeaseEpoch: () => number;
  now?: () => number;
}

/** The renewal request a requesting VM sends to the holder (the `slice-renew` verb payload, decoded). */
export interface SliceRenewRequest {
  grantId: string;
  mandateId: string;
  accountId: string;
  /** Requesting machine's routing fingerprint (carried in the verb; bound into the grant). */
  requestingMachineFp: string;
  /** Slice size requested (provider quota-fraction). */
  amount: number;
  /** Absolute expiry of the slice (ms since epoch). */
  expiresAt: number;
}

export interface SliceIssuanceContext {
  /** The account's spend ceiling (provider quota-fraction, 0..1) — from the live grant/quota policy. */
  ceiling: number;
}

export type SliceIssueOutcome =
  | { ok: true; grantId: string; amount: number; leaseEpoch: number; expiresAt: number }
  | { ok: false; reason: string };

/**
 * The HOLDER-side issuer. Runs ON the fenced lease holder (the `slice-renew` handler wires this).
 * Refuses unless this machine genuinely holds the lease right now, then delegates the sum-of-leases
 * accounting to the durable ledger (single source of truth, re-derived on every call → failover-safe).
 */
export class SliceIssuer {
  private readonly ledger: AccountFollowMeGrantLedger;
  private readonly now: () => number;

  constructor(
    store: GrantStore,
    private readonly cfg: SliceIssuerConfig,
  ) {
    this.now = cfg.now ?? Date.now;
    this.ledger = new AccountFollowMeGrantLedger(store, this.now);
  }

  /** Outstanding committed slices for an account (re-derived from the durable ledger). */
  outstandingFor(accountId: string): number {
    return this.ledger.outstandingFor(accountId);
  }

  /**
   * Issue (or re-issue) a slice in response to a renew request. FENCED: refuses unless this machine
   * holds the lease at the current epoch. The slice is stamped with the CURRENT lease epoch, so it is
   * void at a later epoch (consume/renew checks via the ledger). The ledger enforces the sum-of-leases
   * ceiling and single-use grant ids.
   */
  issueForRenew(req: SliceRenewRequest, ctx: SliceIssuanceContext): SliceIssueOutcome {
    // (a) FENCED single-writer: only the live lease holder may issue. A non-holder (e.g. a stale
    //     ex-holder mid-failover) refuses — the safe direction (no double-allocation).
    if (!this.cfg.holdsLease()) {
      return { ok: false, reason: 'not-lease-holder' };
    }
    const leaseEpoch = this.cfg.currentLeaseEpoch();
    const result: IssueResult = this.ledger.issue({
      grantId: req.grantId,
      mandateId: req.mandateId,
      accountId: req.accountId,
      targetFingerprint: req.requestingMachineFp,
      amount: req.amount,
      ceiling: ctx.ceiling,
      leaseEpoch,
      expiresAt: req.expiresAt,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      grantId: result.grant.grantId,
      amount: result.grant.amount,
      leaseEpoch: result.grant.leaseEpoch,
      expiresAt: result.grant.expiresAt,
    };
  }
}

// ───────────────────────── Requester side (renewal control plane) ─────────────────────────

export interface SliceLeaseState {
  /** The grant id of the slice this VM currently holds for the account, if any. */
  grantId?: string;
  /** Remaining unspent budget on the held slice (provider quota-fraction). */
  remaining: number;
  /** Lease epoch the held slice was issued under — void if the holder advanced past it. */
  leaseEpoch: number;
  /** Absolute expiry of the held slice (ms since epoch). */
  expiresAt: number;
}

export interface RenewControlConfig {
  /**
   * Minimum interval between renewal RPCs for ONE account on this machine (ms). The per-account
   * rate cap — combined with coalescing + the holder's own ceiling, the worst-case fleet renewal
   * rate is O(per-account-cap), independent of N. Default 5000.
   */
  minRenewIntervalMs?: number;
  /** Exponential-backoff multiplier applied to the interval after each refusal/failure. Default 2. */
  backoffMultiplier?: number;
  /** Backoff ceiling (ms) so the interval cannot grow unbounded. Default 300000 (5m). */
  maxRenewIntervalMs?: number;
  /** Consecutive failures before the P19 breaker opens (fail closed to own account). Default 3. */
  breakerThreshold?: number;
  /** How long the breaker stays open before a probe is allowed again (ms). Default 60000. */
  breakerCooldownMs?: number;
  now?: () => number;
}

export type RenewAttemptDecision =
  | { proceed: true }
  | { proceed: false; reason: 'coalesced-in-flight' | 'rate-capped' | 'breaker-open' };

export type RenewOutcomeKind = 'issued' | 'refused' | 'failed';

/**
 * The per-machine requester-side renewal control plane for ONE account. Pure state-machine: a caller
 * asks `shouldAttempt()` before sending a `slice-renew` RPC, marks `beginAttempt()` when it sends,
 * and reports `recordOutcome()` with the result. It enforces coalescing, the rate cap with
 * exponential backoff, and the P19 breaker — so the transport above it can be a thin RPC.
 */
export class SliceRenewalControl {
  private readonly minInterval: number;
  private readonly backoffMul: number;
  private readonly maxInterval: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly now: () => number;

  private inFlight = false;
  private lastAttemptAt = -Infinity;
  /** Current backoff interval (grows on refusal/failure, resets on success). */
  private currentInterval: number;
  private consecutiveFailures = 0;
  private breakerOpenedAt: number | null = null;

  constructor(cfg: RenewControlConfig = {}) {
    this.minInterval = cfg.minRenewIntervalMs ?? 5000;
    this.backoffMul = cfg.backoffMultiplier ?? 2;
    this.maxInterval = cfg.maxRenewIntervalMs ?? 300000;
    this.breakerThreshold = cfg.breakerThreshold ?? 3;
    this.breakerCooldownMs = cfg.breakerCooldownMs ?? 60000;
    this.now = cfg.now ?? Date.now;
    this.currentInterval = this.minInterval;
  }

  /** Is the P19 breaker currently open (a probe not yet allowed)? */
  breakerOpen(): boolean {
    if (this.breakerOpenedAt === null) return false;
    return this.now() - this.breakerOpenedAt < this.breakerCooldownMs;
  }

  /**
   * May this VM send a renewal RPC for the account right now? Refuses (fail-closed at the call site)
   * when a renewal is already in flight (coalescing), the rate cap has not elapsed, or the breaker is
   * open. The caller treats any `proceed:false` as "use my OWN account this turn."
   */
  shouldAttempt(): RenewAttemptDecision {
    if (this.inFlight) return { proceed: false, reason: 'coalesced-in-flight' };
    if (this.breakerOpen()) return { proceed: false, reason: 'breaker-open' };
    if (this.now() - this.lastAttemptAt < this.currentInterval) {
      return { proceed: false, reason: 'rate-capped' };
    }
    return { proceed: true };
  }

  /** Mark a renewal RPC as started (coalescing latch). Must be paired with recordOutcome(). */
  beginAttempt(): void {
    this.inFlight = true;
    this.lastAttemptAt = this.now();
  }

  /**
   * Report the RPC result, advancing the control state:
   *  - issued  → reset backoff + breaker (the channel is healthy again);
   *  - refused → grant-level refusal (e.g. would-exceed-ceiling); back off, but NOT a transport
   *              failure, so it does not advance the breaker (the holder answered);
   *  - failed  → transport failure (timeout/partition/unreachable); back off AND advance the breaker.
   */
  recordOutcome(kind: RenewOutcomeKind): void {
    this.inFlight = false;
    if (kind === 'issued') {
      this.currentInterval = this.minInterval;
      this.consecutiveFailures = 0;
      this.breakerOpenedAt = null;
      return;
    }
    // Back off on any non-success.
    this.currentInterval = Math.min(this.currentInterval * this.backoffMul, this.maxInterval);
    if (kind === 'failed') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.breakerThreshold && this.breakerOpenedAt === null) {
        this.breakerOpenedAt = this.now();
      }
    }
  }
}

// ───────────────────────── Router consultation (selection time) ─────────────────────────

export type AccountUseDecision =
  | { use: 'borrowed'; remaining: number; reason: 'live-slice' }
  | {
      use: 'own';
      reason:
        | 'follow-me-disabled'
        | 'not-a-borrowed-account'
        | 'no-slice'
        | 'slice-exhausted'
        | 'slice-expired'
        | 'stale-lease-epoch';
    };

export interface AccountUseQuery {
  /** Master dark gate (`multiMachine.accountFollowMe`). When false → ALWAYS own account. */
  followMeEnabled: boolean;
  /** Is the candidate account a BORROWED (follow-me / metadata-only-credentialed) account? */
  isBorrowedAccount: boolean;
  /** The slice this VM currently holds for the candidate account (undefined ⇒ never received one). */
  slice: SliceLeaseState | undefined;
  /** The current effective lease epoch (a slice from an older epoch is void). */
  currentLeaseEpoch: number;
  now: number;
}

/**
 * The SELECTION-TIME consultation (R7a(b)/(d), S5, §6.2). Returns whether a candidate BORROWED
 * account may be used this turn, or whether the call must FALL BACK to this machine's OWN account.
 *
 * Fail-closed-to-own-account on EVERY uncertainty: flag off, not a borrowed account, no slice ever
 * received (first-slice-under-partition), exhausted slice, expired slice, or a stale-epoch slice all
 * resolve to `own`. ONLY a live, unexpired, current-epoch slice with remaining budget yields
 * `borrowed`. This is pure — the router/pool wiring calls it and routes accordingly; when off it can
 * never be reached so default behavior is byte-identical.
 */
export function decideAccountUse(q: AccountUseQuery): AccountUseDecision {
  if (!q.followMeEnabled) return { use: 'own', reason: 'follow-me-disabled' };
  if (!q.isBorrowedAccount) return { use: 'own', reason: 'not-a-borrowed-account' };
  const s = q.slice;
  // (d) first-slice-under-partition: never received a slice → own account.
  if (!s || !s.grantId) return { use: 'own', reason: 'no-slice' };
  // A slice from a superseded lease epoch is void (the holder failed over).
  if (s.leaseEpoch < q.currentLeaseEpoch) return { use: 'own', reason: 'stale-lease-epoch' };
  if (s.expiresAt <= q.now) return { use: 'own', reason: 'slice-expired' };
  if (!(s.remaining > 0)) return { use: 'own', reason: 'slice-exhausted' };
  return { use: 'borrowed', remaining: s.remaining, reason: 'live-slice' };
}
