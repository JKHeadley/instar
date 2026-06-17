/**
 * WS5.2 R7a — grant / lease-slice primitives for account follow-me.
 *
 * Two load-bearing properties for a SHARED account spread across N machines:
 *  - SINGLE-USE GRANTS: each credential share carries a one-time grant; a replayed (already
 *    consumed) grant is refused (R3 — consumed at the `account-credential-share` gate).
 *  - SUM-OF-LEASES SPEND BOUND: each grant reserves a SLICE of the account's spend ceiling; the
 *    sum of OUTSTANDING slices for an account can never exceed the ceiling, regardless of issue
 *    order, and the bound is RE-DERIVABLE from the durable ledger so a fenced-lease-holder
 *    FAILOVER cannot double-allocate (a new holder rebuilds outstanding from the ledger before
 *    issuing). Slices are LEASE-EPOCH-FENCED: a slice stamped with a stale epoch is void at a
 *    newer epoch (the single-writer-by-fenced-lease guarantee).
 *
 * PR1 scope: the durable ledger + accounting logic, with an injected store seam (production wires
 * a durable JSON/SQLite store; tests use in-memory). The fenced-lease HOLDER election + the live
 * placement wiring are integration-layer (later PR); this module enforces the math the holder runs.
 */

export type GrantStatus = 'outstanding' | 'consumed' | 'released' | 'expired';

export interface GrantRecord {
  grantId: string;
  mandateId: string;
  accountId: string;
  targetFingerprint: string;
  /** This grant's slice of the account spend ceiling (provider quota-fraction, 0..ceiling). */
  amount: number;
  /** Fenced-lease epoch this slice was issued under — stale-epoch slices are void (R7a). */
  leaseEpoch: number;
  issuedAt: number;
  expiresAt: number;
  status: GrantStatus;
}

export interface GrantLedgerData {
  grants: Record<string, GrantRecord>;
}

/** Durable persistence seam (production: JSON/SQLite; tests: in-memory). */
export interface GrantStore {
  read(): GrantLedgerData;
  write(data: GrantLedgerData): void;
}

export function inMemoryGrantStore(): GrantStore {
  let data: GrantLedgerData = { grants: {} };
  return { read: () => data, write: (d) => { data = d; } };
}

export interface IssueSliceArgs {
  grantId: string;
  mandateId: string;
  accountId: string;
  targetFingerprint: string;
  amount: number;
  /** The account's spend ceiling (provider quota-fraction). */
  ceiling: number;
  /** Current fenced-lease epoch (the accountant must be the lease holder). */
  leaseEpoch: number;
  expiresAt: number;
}

export type IssueResult = { ok: true; grant: GrantRecord } | { ok: false; reason: string };
export type ConsumeResult = { ok: true } | { ok: false; reason: string };

/**
 * Per-account spend accountant + single-use grant ledger. ALL outstanding state is re-derived
 * from the durable store on every call, so a fresh instance after a lease-holder failover sees
 * the exact same outstanding set (no double-allocation).
 */
export class AccountFollowMeGrantLedger {
  constructor(
    private readonly store: GrantStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sum of OUTSTANDING (live, unexpired) slices for an account — the spend currently committed. */
  outstandingFor(accountId: string): number {
    const { grants } = this.store.read();
    const t = this.now();
    return Object.values(grants)
      .filter((g) => g.accountId === accountId && g.status === 'outstanding' && g.expiresAt > t)
      .reduce((sum, g) => sum + g.amount, 0);
  }

  /**
   * Issue a single-use grant reserving `amount` of the account ceiling. Refused when:
   * the grant id already exists; the amount is non-positive/over-ceiling; or the new sum-of-
   * outstanding would exceed the ceiling (R7a). Idempotent against the durable ledger.
   */
  issue(args: IssueSliceArgs): IssueResult {
    const data = this.store.read();
    if (data.grants[args.grantId]) return { ok: false, reason: 'duplicate-grant-id' };
    if (!(args.amount > 0)) return { ok: false, reason: 'non-positive-amount' };
    if (args.amount > args.ceiling) return { ok: false, reason: 'amount-exceeds-ceiling' };
    const outstanding = this.outstandingFor(args.accountId);
    if (outstanding + args.amount > args.ceiling) {
      return { ok: false, reason: 'would-exceed-ceiling' };
    }
    const grant: GrantRecord = {
      grantId: args.grantId,
      mandateId: args.mandateId,
      accountId: args.accountId,
      targetFingerprint: args.targetFingerprint,
      amount: args.amount,
      leaseEpoch: args.leaseEpoch,
      issuedAt: this.now(),
      expiresAt: args.expiresAt,
      status: 'outstanding',
    };
    this.store.write({ grants: { ...data.grants, [args.grantId]: grant } });
    return { ok: true, grant };
  }

  /**
   * Consume a single-use grant at the credential-share gate. Refused when: unknown; wrong
   * mandate; expired; issued under a STALE lease epoch (void at the current epoch); or already
   * consumed/released (replay defeat — R3). On success the grant flips to `consumed`.
   */
  consume(grantId: string, mandateId: string, currentLeaseEpoch: number): ConsumeResult {
    const data = this.store.read();
    const g = data.grants[grantId];
    if (!g) return { ok: false, reason: 'unknown-grant' };
    if (g.mandateId !== mandateId) return { ok: false, reason: 'mandate-mismatch' };
    if (g.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
    if (g.leaseEpoch < currentLeaseEpoch) return { ok: false, reason: 'stale-lease-epoch' };
    if (g.status !== 'outstanding') return { ok: false, reason: `already-${g.status}` };
    this.store.write({ grants: { ...data.grants, [grantId]: { ...g, status: 'consumed' } } });
    return { ok: true };
  }

  /** Release a slice (revocation / completion) — frees its spend back to the ceiling. */
  release(grantId: string): ConsumeResult {
    const data = this.store.read();
    const g = data.grants[grantId];
    if (!g) return { ok: false, reason: 'unknown-grant' };
    if (g.status === 'released') return { ok: true };
    this.store.write({ grants: { ...data.grants, [grantId]: { ...g, status: 'released' } } });
    return { ok: true };
  }
}
