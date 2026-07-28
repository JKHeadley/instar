/**
 * WS5.2 §5.2 + R7 — depth-zero enrollment-offer detector.
 *
 * Decides WHICH (account → target-machine) enrollment offers to surface, from the pool's
 * per-machine account state. A "depth-zero" machine has NO usable account for an operator
 * subscription; the agent should OFFER (never auto-do) to enroll one there. This is the pure
 * decision layer that feeds AccountFollowMeOrchestrator (§5.2) — it decides the candidate offers;
 * the orchestrator still requires an operator mandate before anything happens.
 *
 * R7 bounds (so adding the Mth machine can't multiply traffic):
 *   - only machines with ZERO usable accounts are candidates;
 *   - per-account **max-follow-machines cap** — never offer an account to more targets than the cap
 *     (counting machines that ALREADY hold it);
 *   - **one offer per (account, target)** — an offer already in-flight (a pending mandate/consent)
 *     is not re-emitted;
 *   - the caller raises ONE AGGREGATED consent item over the returned list (P17), never one per offer.
 *
 * Pure + deterministic (no I/O); unit-tested. PR2 increment 3a.
 */

export interface PoolMachineDepth {
  machineId: string;
  nickname: string;
  /** Count of accounts this machine can actually serve from (a real local login). 0 = depth-zero. */
  usableAccountCount: number;
}

export interface OperatorAccount {
  accountId: string;
  email: string;
  /** Machine ids that ALREADY hold a usable login for this account (re-mint instances). */
  heldByMachineIds: string[];
}

export interface EnrollmentOffer {
  accountId: string;
  accountEmail: string;
  targetMachineId: string;
  targetMachineNickname: string;
}

export interface DetectInput {
  machines: PoolMachineDepth[];
  accounts: OperatorAccount[];
  /** Per-account cap on total machines that may hold it (R7; small default e.g. 5). */
  maxFollowMachines: number;
  /** (account, target) pairs with an offer/mandate already in flight — never re-offered. */
  inFlight?: ReadonlySet<string>; // key: `${accountId}::${targetMachineId}`
}

const key = (accountId: string, targetMachineId: string) => `${accountId}::${targetMachineId}`;

/**
 * Compute the enrollment offers to surface. Deterministic: candidates are depth-zero machines,
 * each offered the operator's "primary" account (the most-held one, stable tie-break by accountId),
 * subject to the per-account cap and the in-flight dedup. Returns at most ONE offer per target
 * machine (a machine needs only one account to stop being depth-zero).
 */
export function detectEnrollmentOffers(input: DetectInput): EnrollmentOffer[] {
  const inFlight = input.inFlight ?? new Set<string>();
  const cap = Number.isFinite(input.maxFollowMachines) && input.maxFollowMachines > 0 ? input.maxFollowMachines : 5;

  // Mutable copy of how many machines each account is committed to (held + offers we emit this pass).
  const committed = new Map<string, number>();
  for (const a of input.accounts) committed.set(a.accountId, new Set(a.heldByMachineIds).size);

  // Prefer the account already on the most machines (the operator's "main"), stable by accountId.
  const ranked = [...input.accounts].sort(
    (x, y) => y.heldByMachineIds.length - x.heldByMachineIds.length || x.accountId.localeCompare(y.accountId),
  );

  const offers: EnrollmentOffer[] = [];
  for (const m of input.machines) {
    if (m.usableAccountCount > 0) continue; // not depth-zero
    // Pick the first ranked account that (a) this machine doesn't already hold, (b) is under cap,
    // (c) has no in-flight offer for this (account, target).
    for (const a of ranked) {
      if (a.heldByMachineIds.includes(m.machineId)) continue;
      if ((committed.get(a.accountId) ?? 0) >= cap) continue;
      if (inFlight.has(key(a.accountId, m.machineId))) continue;
      offers.push({ accountId: a.accountId, accountEmail: a.email, targetMachineId: m.machineId, targetMachineNickname: m.nickname });
      committed.set(a.accountId, (committed.get(a.accountId) ?? 0) + 1);
      break; // one offer per target machine
    }
  }
  return offers;
}
