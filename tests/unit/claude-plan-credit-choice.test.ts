import { describe, expect, it, vi } from 'vitest';
import { chooseClaudePlanCredit, readClaudePlanCreditChoice } from '../../src/core/claudePlanCreditChoice.js';

const balance = {
  accountId: 'test-account',
  keyRef: 'test-key',
  includedRemainingCents: 110,
  purchasedRemainingCents: 0,
  autoReload: false,
  hardStopAtIncludedExhaustion: true,
  measuredAtMs: 1_000,
  expiresAtMs: 10_000,
};
const input = {
  enabled: true,
  accountId: balance.accountId,
  approvedAccountId: balance.accountId,
  approvedKeyRef: balance.keyRef,
  balance,
  maxCostCents: 100,
  safetyMarginCents: 10,
  nowMs: 2_000,
  maxBalanceAgeMs: 1_500,
};

describe('Claude plan credit selection', () => {
  it('selects included credit when the approved account has enough fresh credit', () => {
    expect(chooseClaudePlanCredit(input)).toBe('included-credit');
  });

  it.each([
    { enabled: false },
    { balance: null },
    { accountId: 'different-account' },
    { approvedKeyRef: 'different-key' },
    { balance: { ...balance, includedRemainingCents: 109 } },
    { balance: { ...balance, measuredAtMs: 499 } },
    { balance: { ...balance, measuredAtMs: 2_001 } },
    { balance: { ...balance, expiresAtMs: 2_000 } },
    { balance: { ...balance, purchasedRemainingCents: 1 } },
    { balance: { ...balance, autoReload: true } },
    { balance: { ...balance, hardStopAtIncludedExhaustion: false } },
    { safetyMarginCents: 0 },
    { maxCostCents: Number.NaN },
  ])('keeps subscription when the credit proof or budget is invalid (%j)', (patch) => {
    expect(chooseClaudePlanCredit({ ...input, ...patch })).toBe('subscription');
  });
  it('falls back when the trusted reader is unavailable', async () => {
    await expect(readClaudePlanCreditChoice(input, async () => {
      throw new Error('unavailable');
    })).resolves.toBe('subscription');
  });

  it('does not read a balance when dark or when the account differs', async () => {
    const read = vi.fn(async () => balance);
    await expect(readClaudePlanCreditChoice({ ...input, enabled: false }, read)).resolves.toBe('subscription');
    await expect(readClaudePlanCreditChoice({ ...input, accountId: 'other' }, read)).resolves.toBe('subscription');
    expect(read).not.toHaveBeenCalled();
  });
});
