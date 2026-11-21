import { randomUUID } from 'node:crypto';
import type { LeaseHoldVerdict } from '../../core/LeaseCoordinator.js';

// A grant may be used late, so retain its debit for a full window AFTER its
// expiry. This bounds actual starts, not merely reservation timestamps.
export const ORIGIN_CAPACITY_TTL_MS = 250;
export const ORIGIN_CAPACITY_WINDOW_MS = 1000 + ORIGIN_CAPACITY_TTL_MS;
export interface OriginCapacityGrant { ownerBootId: string; accountId: string; nonce: string; expiresAt: number; }

/** The durable outcome reason every local capacity refusal carried before lease refusals were named. */
export const CREDENTIAL_CAPACITY_UNAVAILABLE = 'credential-capacity-unavailable';
/** lease-freshness-lapse-retry — the lease coordinator's own renewal fence refused the send. */
export const LEASE_FRESHNESS_LAPSED = 'lease-freshness-lapsed';
/** lease-freshness-lapse-retry — the lease was not held at the network boundary for another reason, or nothing could be measured. */
export const LEASE_NOT_HELD_AT_SEND = 'lease-not-held-at-send';
/** The two lease reasons: retried within seconds once the lease is held again, never reported at first detection. */
export const ORIGIN_LEASE_REFUSAL_REASONS: readonly string[] = Object.freeze([LEASE_FRESHNESS_LAPSED, LEASE_NOT_HELD_AT_SEND]);
/** Every durable reason a request-bound local refusal may carry (the store accepts exactly these with `localRefusal: true`). */
export const ORIGIN_LOCAL_REFUSAL_REASONS: readonly string[] = Object.freeze([CREDENTIAL_CAPACITY_UNAVAILABLE, ...ORIGIN_LEASE_REFUSAL_REASONS]);

/** What the lease coordinator answered when the capacity read it: which of its checks decided, in its own order. */
export type { LeaseHoldVerdict } from '../../core/LeaseCoordinator.js';
export interface LeaseFreshness { msSinceConfirmedRenewal: number; ttlMs: number; verdict: LeaseHoldVerdict }

/** Why a permit was refused, in the precedence the refusing evaluation uses. The two post-grant
 * causes are the egress's own: the permit ran out, or `consume()` re-checked liveness and said no. */
export type OriginCapacityRefusalCause =
  | 'owner-closed' | 'owner-not-ready' | 'lease-not-held' | 'account-unknown' | 'owner-check-failed' | 'rate-window-full'
  | 'grant-expired' | 'consume-refused';
export interface OriginCapacityRefusal { cause: OriginCapacityRefusalCause; leaseFreshness: LeaseFreshness | null }
export type OriginCapacityDecision = { grant: OriginCapacityGrant; refusal: null } | { grant: null; refusal: OriginCapacityRefusal };

export interface OriginCapacityAuthority {
  reserve(accountId: string): Promise<OriginCapacityGrant | null>;
  /** The same decision as `reserve()`, with the cause captured in the evaluation that refused. Optional: an
   * IPC client cannot explain, and its caller falls back to `reserve()` (an unexplained refusal). */
  reserveExplained?(accountId: string): Promise<OriginCapacityDecision>;
  consume(grant: OriginCapacityGrant): Promise<boolean>;
}
export class OriginCapacityUnavailable extends Error {
  /** The refusing evaluation's cause, or null when the authority could not explain (IPC client). */
  readonly refusal: OriginCapacityRefusal | null;
  constructor(refusal: OriginCapacityRefusal | null = null) {
    super(CREDENTIAL_CAPACITY_UNAVAILABLE); this.name = 'OriginCapacityUnavailable'; this.refusal = refusal;
  }
}
/** The durable outcome reason for a request-bound local refusal: written from what was observed, never inferred.
 * `lease-freshness-lapsed` only when the coordinator itself said its renewal fence answered. */
export function originLocalRefusalReason(error: unknown): string {
  const refusal = error instanceof OriginCapacityUnavailable ? error.refusal : null;
  if (refusal?.cause !== 'lease-not-held') return CREDENTIAL_CAPACITY_UNAVAILABLE;
  return refusal.leaseFreshness?.verdict === 'renewal-lapsed' ? LEASE_FRESHNESS_LAPSED : LEASE_NOT_HELD_AT_SEND;
}
/** One memory authority per credential owner. It survives recording-worker
 * failure. Missing lease, expired credits and owner replacement fail closed. */
export class OriginEgressCapacity implements OriginCapacityAuthority {
  readonly #debits = new Map<string, Array<{ at: number; grant: OriginCapacityGrant; consumed: boolean }>>();
  readonly #readyAt: number;
  #closed = false;
  constructor(readonly options: { ownerBootId: string; accountIds: () => string[];
    ownsLease: () => boolean; now?: () => number;
    /** lease-freshness-lapse-retry — the coordinator's one-snapshot verdict and renewal gap. When present it is
     * the lease read (permission and reason from the same sample); `ownsLease()` is read only without it. */
    leaseFreshness?: () => LeaseFreshness | null }) {
    this.#readyAt = this.#now() + ORIGIN_CAPACITY_WINDOW_MS;
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  /** The first failing liveness check, in the order `#live()` always used; null when live. */
  #liveCause(accountId: string): { cause: OriginCapacityRefusalCause; leaseFreshness: LeaseFreshness | null } | null {
    if (this.#closed) return { cause: 'owner-closed', leaseFreshness: null };
    if (this.#now() < this.#readyAt) return { cause: 'owner-not-ready', leaseFreshness: null };
    let freshness: LeaseFreshness | null = null, held: boolean;
    try {
      freshness = this.options.leaseFreshness?.() ?? null;
      held = freshness ? freshness.verdict === 'holding' : this.options.ownsLease();
    } catch { return { cause: 'owner-check-failed', leaseFreshness: null }; }
    if (!held) return { cause: 'lease-not-held', leaseFreshness: freshness };
    try { if (!this.options.accountIds().includes(accountId)) return { cause: 'account-unknown', leaseFreshness: null }; }
    catch { return { cause: 'owner-check-failed', leaseFreshness: null }; }
    return null;
  }
  #live(accountId: string): boolean { return this.#liveCause(accountId) === null; }
  async reserve(accountId: string): Promise<OriginCapacityGrant | null> { return (await this.reserveExplained(accountId)).grant; }
  async reserveExplained(accountId: string): Promise<OriginCapacityDecision> {
    const refusal = this.#liveCause(accountId);
    if (refusal) return { grant: null, refusal };
    const now = this.#now();
    const entries = (this.#debits.get(accountId) ?? []).filter(entry => now - entry.at < ORIGIN_CAPACITY_WINDOW_MS);
    this.#debits.set(accountId, entries);
    if (entries.length >= 10) return { grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } };
    const grant = { ownerBootId: this.options.ownerBootId, accountId, nonce: randomUUID(), expiresAt: now + ORIGIN_CAPACITY_TTL_MS };
    entries.push({ at: now, grant, consumed: false }); return { grant: { ...grant }, refusal: null };
  }
  async consume(grant: OriginCapacityGrant): Promise<boolean> {
    if (!this.#live(grant.accountId) || grant.ownerBootId !== this.options.ownerBootId || grant.expiresAt <= this.#now()) return false;
    const entry = this.#debits.get(grant.accountId)?.find(entry => entry.grant.nonce === grant.nonce);
    if (!entry || entry.consumed || entry.grant.expiresAt !== grant.expiresAt) return false;
    entry.consumed = true; return true;
  }
  close(): void { this.#closed = true; this.#debits.clear(); }
}
