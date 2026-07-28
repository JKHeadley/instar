/**
 * WS5.2 §5.1/§5.2 — depth adapter: map real pool state (this machine's SubscriptionPool + the
 * cross-machine `?scope=pool` view) into the AccountFollowMeDetector's input shape.
 *
 * The adapter is PURE (no I/O) so it is unit-testable without a server; the route/tick supplies
 * the real fetched data (local accounts + the per-peer scope=pool rows). This is the seam between
 * the server-coupled fetch and the pure detection logic.
 *
 * "Usable" = a machine can actually SERVE from an account = it holds a real local login (a
 * config-home / non-meta-only account that is active or warming). A meta-only replicated account
 * (known but not held) does NOT count toward a machine's usable depth — that is the whole point of
 * follow-me (a machine that only KNOWS about an account still needs its own login).
 */

import type { PoolMachineDepth, OperatorAccount } from './AccountFollowMeDetector.js';

/** One account row as seen on a machine (local or via scope=pool). */
export interface MachineAccountRow {
  accountId: string;
  email?: string;
  /** Lifecycle status (active/warming = usable; rate-limited/needs-reauth/disabled = not). */
  status: string;
  /** True iff this machine holds a REAL local login for it (has a config-home), not meta-only. */
  locallyHeld: boolean;
}

export interface MachinePoolView {
  machineId: string;
  nickname: string;
  /** The accounts this machine sees/holds. */
  accounts: MachineAccountRow[];
}

const USABLE_STATUSES = new Set(['active', 'warming']);

function isUsable(row: MachineAccountRow): boolean {
  return row.locallyHeld === true && USABLE_STATUSES.has(row.status);
}

/**
 * Build the detector input from the per-machine pool views. `usableAccountCount` per machine =
 * the count of accounts it can actually serve from (locally-held + active/warming). `accounts`
 * (the operator's accounts + which machines hold each, usably) is derived across all machines —
 * keyed by accountId, so the SAME account on two machines collapses to one entry with both holders.
 */
export function buildDepthInput(views: MachinePoolView[]): { machines: PoolMachineDepth[]; accounts: OperatorAccount[] } {
  const machines: PoolMachineDepth[] = [];
  const accountMap = new Map<string, OperatorAccount>();

  for (const v of views) {
    let usableCount = 0;
    for (const row of v.accounts) {
      if (!accountMap.has(row.accountId)) {
        accountMap.set(row.accountId, { accountId: row.accountId, email: row.email ?? '', heldByMachineIds: [] });
      }
      const acct = accountMap.get(row.accountId)!;
      // Prefer a non-empty email if any holder reports one.
      if (!acct.email && row.email) acct.email = row.email;
      if (isUsable(row)) {
        usableCount++;
        if (!acct.heldByMachineIds.includes(v.machineId)) acct.heldByMachineIds.push(v.machineId);
      }
    }
    machines.push({ machineId: v.machineId, nickname: v.nickname, usableAccountCount: usableCount });
  }

  return { machines, accounts: [...accountMap.values()] };
}
