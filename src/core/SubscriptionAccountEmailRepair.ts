import type { IdentityOracle } from './CredentialLocationLedger.js';
import {
  SubscriptionAccountEmailRegistrar,
  SubscriptionIdentityError,
  type SubscriptionEmailBindingAuthority,
  type SubscriptionPool,
} from './SubscriptionPool.js';

export interface SubscriptionEmailRepairResult {
  scanned: number;
  repaired: string[];
  unresolved: Array<{ accountId: string; reason: string }>;
}

/**
 * One-shot legacy repair. Identity comes only from the account's own credential
 * slot; account ids, nicknames and peer metadata are never treated as proof.
 */
export async function repairMissingSubscriptionEmails(
  pool: SubscriptionPool,
  oracle: IdentityOracle,
  binding: SubscriptionEmailBindingAuthority,
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<SubscriptionEmailRepairResult> {
  const missing = pool.listEmailGaps();
  const result: SubscriptionEmailRepairResult = { scanned: missing.length, repaired: [], unresolved: [] };
  const registrar = new SubscriptionAccountEmailRegistrar(pool, oracle, binding);
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let cursor = 0;
  let acceptingResults = true;
  const resolved = new Set<string>();
  const worker = async (): Promise<void> => {
    while (cursor < missing.length && Date.now() < deadline) {
      const account = missing[cursor++]!;
      if (account.identityDrifted) {
        result.unresolved.push({ accountId: account.accountId, reason: 'identity-drifted' });
        resolved.add(account.accountId);
        continue;
      }
      try {
        await registrar.repairLegacy(account.accountId, { canCommit: () => Date.now() < deadline });
        if (acceptingResults) result.repaired.push(account.accountId);
      } catch (error) {
        if (acceptingResults) result.unresolved.push({
          accountId: account.accountId,
          reason: error instanceof SubscriptionIdentityError
            ? error.code
            : 'identity-oracle-unavailable',
        });
      } finally {
        resolved.add(account.accountId);
      }
    }
  };
  const workers = Promise.all(Array.from(
    { length: Math.min(Math.max(1, options.concurrency ?? 3), missing.length) },
    () => worker(),
  ));
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    workers,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, remainingMs); }),
  ]);
  if (timer) clearTimeout(timer);
  acceptingResults = false;
  for (const account of missing) {
    if (!resolved.has(account.accountId) && !result.unresolved.some((row) => row.accountId === account.accountId)) {
      result.unresolved.push({ accountId: account.accountId, reason: 'reconciliation-timeout' });
    }
  }
  return result;
}
