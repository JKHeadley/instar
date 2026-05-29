/**
 * SessionOwnershipRegistry — the distributed per-session ownership registry
 * (Multi-Machine Session Pool §L3). Holds a SessionOwnershipRecord per session;
 * answers "which machine holds session X"; and mutates ownership via a per-session
 * CAS at `ownershipEpoch+1`, reusing the §L−1 single-ref fast-forward discipline
 * (the same pattern as GitLeaseStore/LeaseCoordinator) but at per-session
 * granularity — thousands of independent CAS points, one ref-file per session.
 *
 * The dangerous parts (CAS contention, per-session replay) are driven through
 * injected seams so they are unit-testable with in-memory fakes:
 *  - `store` — the durable CAS substrate (git single-ref fast-forward push per
 *    session). `casWrite(candidate)` returns ok:true if the candidate landed
 *    (fast-forwarded from the current epoch), or ok:false + the freshly-observed
 *    record after a reject+reread (a peer won the race). MUST NOT force-push.
 *  - `seenNonce`/`recordNonce` — the per-session-scoped replay guard
 *    (keyed on {sessionKey, sender, epoch} — see SessionOwnership.ownershipNonceKey).
 *
 * The FSM (legal transitions, run-fence, output-exclusion) lives in
 * SessionOwnership.ts; this module enforces the CAS + replay + retry-backoff +
 * lifecycle around it.
 */

import {
  applyOwnershipAction,
  ownershipNonceKey,
  type OwnershipAction,
  type OwnershipReason,
  type SessionOwnershipRecord,
} from './SessionOwnership.js';

/**
 * In-memory per-session ownership store with fast-forward CAS — correct for a
 * single machine (no cross-machine contention) and for the dark v0.1 state.
 * The CROSS-MACHINE durable store (git single-ref-per-session push, mirroring
 * GitLeaseStore) swaps in for the Track-H real-hardware proof; the registry/FSM/
 * CAS logic above is store-agnostic. A candidate lands only if it fast-forwards
 * from the current epoch (`candidate.ownershipEpoch === current.epoch + 1`).
 */
export class InMemorySessionOwnershipStore {
  private recs = new Map<string, import('./SessionOwnership.js').SessionOwnershipRecord>();
  read(sessionKey: string) {
    return this.recs.get(sessionKey) ?? null;
  }
  casWrite(candidate: import('./SessionOwnership.js').SessionOwnershipRecord) {
    const current = this.recs.get(candidate.sessionKey) ?? null;
    const curEpoch = current?.ownershipEpoch ?? 0;
    if (candidate.ownershipEpoch === curEpoch + 1) {
      this.recs.set(candidate.sessionKey, candidate);
      return { ok: true, observed: candidate };
    }
    return { ok: false, observed: current };
  }
  all() {
    return [...this.recs.values()];
  }
}

/** Durable per-session CAS substrate (git single-ref fast-forward push). */
export interface SessionOwnershipStore {
  /** Read the current committed record for a session (null if none). */
  read(sessionKey: string): SessionOwnershipRecord | null;
  /**
   * Attempt to land `candidate` as the new record via a fast-forward push from
   * the current epoch. ok:true if it landed; ok:false + observed (the
   * freshly-reread record) if a peer advanced first (non-fast-forward reject).
   */
  casWrite(candidate: SessionOwnershipRecord): { ok: boolean; observed: SessionOwnershipRecord | null };
}

export interface SessionOwnershipRegistryDeps {
  store: SessionOwnershipStore;
  /** Has this per-session nonce been seen (replay guard)? */
  seenNonce: (key: string) => boolean;
  /** Record a per-session nonce as seen (called only on a successful CAS). */
  recordNonce: (key: string) => void;
  now?: () => number;
  /** Eviction age (ms) for `released` records. Default 86400000 (24h). */
  releasedEvictionMs?: number;
  logger?: (msg: string) => void;
}

export type CasResult =
  | { ok: true; record: SessionOwnershipRecord }
  | { ok: false; reason: OwnershipReason | 'replayed-nonce' | 'cas-lost'; observed: SessionOwnershipRecord | null };

export class SessionOwnershipRegistry {
  private readonly d: SessionOwnershipRegistryDeps;
  private casConflicts = 0;
  private casRetryExhaustions = 0;

  constructor(deps: SessionOwnershipRegistryDeps) {
    this.d = deps;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  read(sessionKey: string): SessionOwnershipRecord | null {
    return this.d.store.read(sessionKey);
  }

  /** The current owner machine of a session (null if none / released). */
  ownerOf(sessionKey: string): string | null {
    const r = this.d.store.read(sessionKey);
    if (!r || r.status === 'released') return null;
    return r.ownerMachineId;
  }

  /**
   * The machine the router last assigned for a session (§L4 RBAC `claim` check):
   * the placed-owner while `placing`, or the transfer target while `transferring`.
   */
  placementTargetOf(sessionKey: string): string | null {
    const r = this.d.store.read(sessionKey);
    if (!r) return null;
    if (r.status === 'placing') return r.ownerMachineId;
    if (r.status === 'transferring') return r.transferTo ?? null;
    return null;
  }

  /**
   * Apply an ownership action via CAS (§L3). Runs the FSM transition, the
   * per-session replay check, then the durable fast-forward CAS. On a lost CAS
   * (a peer advanced the epoch first) returns `cas-lost` + the observed record —
   * the caller backs off (ownershipCasRetryBackoffMs) or stands down. The nonce
   * is recorded ONLY on a landed CAS (a rejected attempt never burns a nonce).
   */
  cas(action: OwnershipAction, ctx: { sessionKey: string; sender: string; nonce: string }): CasResult {
    const current = this.d.store.read(ctx.sessionKey);
    const t = applyOwnershipAction(current, action, { sessionKey: ctx.sessionKey, nonce: ctx.nonce, now: this.now() });
    if (!t.ok) return { ok: false, reason: t.reason, observed: current };

    const nkey = ownershipNonceKey(ctx.sessionKey, ctx.sender, t.next.ownershipEpoch, ctx.nonce);
    if (this.d.seenNonce(nkey)) return { ok: false, reason: 'replayed-nonce', observed: current };

    const res = this.d.store.casWrite(t.next);
    if (!res.ok) {
      this.casConflicts++;
      this.d.logger?.(`[ownership] CAS lost for ${ctx.sessionKey} → observed epoch ${res.observed?.ownershipEpoch ?? 0}`);
      return { ok: false, reason: 'cas-lost', observed: res.observed };
    }
    this.d.recordNonce(nkey);
    return { ok: true, record: t.next };
  }

  /** Observability counters (spec §L3: /pool ownership.casConflicts/casRetryExhaustions). */
  noteRetryExhaustion(): void {
    this.casRetryExhaustions++;
  }
  metrics(): { casConflicts: number; casRetryExhaustions: number } {
    return { casConflicts: this.casConflicts, casRetryExhaustions: this.casRetryExhaustions };
  }
}

/**
 * Exponential-jitter retry delay for a lost CAS (spec §L3): `ownershipCasRetryBackoffMs`
 * 50→500ms, biased so the lowest-machineId contender retries first (a client-side
 * ordering hint ONLY — never the CAS arbiter; the remote ref-update decides the winner).
 */
export function ownershipRetryDelayMs(
  retryCount: number,
  selfMachineId: string,
  contenderMachineId: string,
  opts: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = opts.baseMs ?? 50;
  const max = opts.maxMs ?? 500;
  const backoff = Math.min(max, base * 2 ** Math.max(0, retryCount - 1));
  // Lowest machineId retries first (shorter delay) — ordering hint, not arbitration.
  const yieldBias = selfMachineId > contenderMachineId ? backoff : Math.floor(backoff / 2);
  return Math.min(max, yieldBias);
}
