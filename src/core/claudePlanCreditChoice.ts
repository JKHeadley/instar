/** A balance observation for the included credit tied to one account and key. */
export interface ClaudePlanCreditBalance {
  accountId: string;
  keyRef: string;
  includedRemainingCents: number;
  purchasedRemainingCents: number;
  autoReload: boolean;
  /** The credential's billing configuration enforces a stop at included credit exhaustion. */
  hardStopAtIncludedExhaustion: boolean;
  measuredAtMs: number;
  expiresAtMs: number;
}

interface ClaudePlanCreditChoice {
  enabled: boolean;
  accountId: string;
  approvedAccountId: string;
  approvedKeyRef: string;
  balance: ClaudePlanCreditBalance | null;
  maxCostCents: number;
  safetyMarginCents: number;
  nowMs: number;
  maxBalanceAgeMs: number;
}

/**
 * Dark decision logic for an existing non-interactive Claude subscription call.
 * The caller must reserve the worst-case cost before starting a credit-backed
 * request. This function neither reserves funds nor reads or uses a credential.
 */
export function chooseClaudePlanCredit(input: ClaudePlanCreditChoice): 'included-credit' | 'subscription' {
  const { balance, accountId, approvedAccountId, approvedKeyRef, maxCostCents, safetyMarginCents, nowMs, maxBalanceAgeMs } = input;
  if (!input.enabled || !balance || !accountId || !approvedKeyRef
    || accountId !== approvedAccountId || balance.accountId !== accountId || balance.keyRef !== approvedKeyRef) {
    return 'subscription';
  }
  if (!Number.isSafeInteger(maxCostCents) || maxCostCents <= 0
    || !Number.isSafeInteger(safetyMarginCents) || safetyMarginCents <= 0
    || !Number.isSafeInteger(balance.includedRemainingCents)
    || balance.includedRemainingCents - maxCostCents < safetyMarginCents
    || balance.purchasedRemainingCents !== 0 || balance.autoReload !== false
    || balance.hardStopAtIncludedExhaustion !== true
    || !Number.isFinite(nowMs) || !Number.isFinite(maxBalanceAgeMs) || maxBalanceAgeMs <= 0
    || !Number.isFinite(balance.measuredAtMs) || balance.measuredAtMs > nowMs
    || nowMs - balance.measuredAtMs > maxBalanceAgeMs
    || !Number.isFinite(balance.expiresAtMs) || balance.expiresAtMs <= nowMs) {
    return 'subscription';
  }
  return 'included-credit';
}

/** Read through a trusted account-scoped reader supplied by the billing integration. */
export async function readClaudePlanCreditChoice(
  input: Omit<ClaudePlanCreditChoice, 'balance'>,
  readBalance: (accountId: string, keyRef: string) => Promise<ClaudePlanCreditBalance | null>,
): Promise<'included-credit' | 'subscription'> {
  if (!input.enabled || !input.accountId || input.accountId !== input.approvedAccountId || !input.approvedKeyRef) {
    return 'subscription';
  }

  let balance: ClaudePlanCreditBalance | null;
  try {
    balance = await readBalance(input.accountId, input.approvedKeyRef);
  } catch {
    // @silent-fallback-ok: an unavailable credit read must keep the subscription path.
    return 'subscription';
  }
  return chooseClaudePlanCredit({ ...input, balance, nowMs: Math.max(input.nowMs, Date.now()) });
}
