/**
 * Pure repair planner for confirmed slot-label drift.
 *
 * It contains no credential IO. Execution is delegated to CredentialSwapExecutor,
 * preserving its staging, identity verification, quarantine, and audit contracts.
 * A plan is advisory until that executor repeats live identity pre-flight under locks.
 */

export interface RepairAccount {
  id: string;
  configHome: string;
}

export interface RepairObservation {
  slot: string;
  /** Confirmed live tenant. null means the oracle could not prove identity. */
  accountId: string | null;
}

export interface CredentialRepairMove {
  slotA: string;
  slotB: string;
  accountA: string;
  accountB: string;
  reason: 'restore-labelled-home';
}

export interface CredentialIdentityRepairPlan {
  moves: CredentialRepairMove[];
  vacates: Array<{ accountId: string; retainedSlot: string; impostorSlot: string }>;
  quarantineSlots: string[];
  ownerReloginAccountIds: string[];
  duplicateAccountIds: string[];
  complete: boolean;
}

/**
 * Produce an ordered exchange plan. Each move places at least one credential in
 * its labelled home. Unknown identities are quarantined, never guessed. Missing
 * credentials become explicit owner re-login residuals (tokens never cross machines).
 */
export function planCredentialIdentityRepair(
  accounts: readonly RepairAccount[],
  observations: readonly RepairObservation[],
): CredentialIdentityRepairPlan {
  const desiredSlot = new Map(accounts.map((a) => [a.id, a.configHome]));
  const current = new Map(observations.map((o) => [o.slot, o.accountId]));
  const quarantineSlots = observations.filter((o) => !o.accountId).map((o) => o.slot);

  const homesByTenant = new Map<string, string[]>();
  for (const [slot, accountId] of current) {
    if (!accountId) continue;
    const homes = homesByTenant.get(accountId) ?? [];
    homes.push(slot);
    homesByTenant.set(accountId, homes);
  }
  const duplicateAccountIds = [...homesByTenant]
    .filter(([, slots]) => slots.length > 1)
    .map(([id]) => id)
    .sort();
  const vacates: CredentialIdentityRepairPlan['vacates'] = [];

  // Duplicate copies violate one-home-per-credential and cannot be safely
  // distinguished by account identity alone. Keep every involved slot out of
  // mutation until the executor has a lineage-safe vacate operation.
  for (const id of duplicateAccountIds) {
    const homes = homesByTenant.get(id) ?? [];
    const retainedSlot = desiredSlot.get(id) && homes.includes(desiredSlot.get(id)!)
      ? desiredSlot.get(id)!
      : homes[0];
    for (const slot of homes) {
      if (slot === retainedSlot) continue;
      vacates.push({ accountId: id, retainedSlot, impostorSlot: slot });
      if (!quarantineSlots.includes(slot)) quarantineSlots.push(slot);
    }
  }

  const moves: CredentialRepairMove[] = [];
  const mutable = new Map(current);
  const blocked = new Set(quarantineSlots);
  for (let guard = 0; guard < accounts.length * accounts.length; guard++) {
    let changed = false;
    for (const account of accounts) {
      const home = account.configHome;
      if (blocked.has(home) || mutable.get(home) === account.id) continue;
      const source = [...mutable].find(([slot, tenant]) => tenant === account.id && !blocked.has(slot))?.[0];
      if (!source) continue;
      const displaced = mutable.get(home);
      if (!displaced) continue; // an empty/unknown home is re-login territory, never a guessed write
      moves.push({ slotA: source, slotB: home, accountA: account.id, accountB: displaced, reason: 'restore-labelled-home' });
      mutable.set(home, account.id);
      mutable.set(source, displaced);
      changed = true;
    }
    if (!changed) break;
  }

  const ownerReloginAccountIds = accounts
    .filter((a) => mutable.get(a.configHome) !== a.id)
    .map((a) => a.id)
    .sort();
  return {
    moves,
    vacates,
    quarantineSlots: [...new Set(quarantineSlots)].sort(),
    ownerReloginAccountIds,
    duplicateAccountIds,
    complete: quarantineSlots.length === 0 && ownerReloginAccountIds.length === 0 && vacates.length === 0,
  };
}
