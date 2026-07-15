import { describe, expect, it } from 'vitest';
import { planCredentialIdentityRepair } from '../../src/core/CredentialIdentityRepairPlan.js';

const accounts = [
  { id: 'alice', configHome: '/slots/alice' },
  { id: 'bob', configHome: '/slots/bob' },
  { id: 'carol', configHome: '/slots/carol' },
];

describe('planCredentialIdentityRepair', () => {
  it('orders exchanges that restore every credential to its labelled home', () => {
    const plan = planCredentialIdentityRepair(accounts, [
      { slot: '/slots/alice', accountId: 'bob' },
      { slot: '/slots/bob', accountId: 'carol' },
      { slot: '/slots/carol', accountId: 'alice' },
    ]);
    expect(plan.moves).toHaveLength(2);
    expect(plan.complete).toBe(true);
    expect(plan.ownerReloginAccountIds).toEqual([]);
  });

  it('never guesses around an unavailable identity and tracks the missing login', () => {
    const plan = planCredentialIdentityRepair(accounts, [
      { slot: '/slots/alice', accountId: null },
      { slot: '/slots/bob', accountId: 'bob' },
      { slot: '/slots/carol', accountId: 'carol' },
    ]);
    expect(plan.moves).toEqual([]);
    expect(plan.quarantineSlots).toEqual(['/slots/alice']);
    expect(plan.ownerReloginAccountIds).toEqual(['alice']);
    expect(plan.complete).toBe(false);
  });

  it('quarantines duplicate-copy homes instead of treating copies as capacity', () => {
    const plan = planCredentialIdentityRepair(accounts, [
      { slot: '/slots/alice', accountId: 'alice' },
      { slot: '/slots/bob', accountId: 'alice' },
      { slot: '/slots/carol', accountId: 'carol' },
    ]);
    expect(plan.duplicateAccountIds).toEqual(['alice']);
    expect(plan.vacates).toEqual([{ accountId: 'alice', retainedSlot: '/slots/alice', impostorSlot: '/slots/bob' }]);
    expect(plan.quarantineSlots).toEqual(['/slots/bob']);
    expect(plan.ownerReloginAccountIds).toContain('bob');
  });
});
