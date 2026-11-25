import { expect, it } from 'vitest';
import {
  ownerSpendingApprovalBinding,
  type OwnerSpendingApprovalDisclosure,
} from '../../src/core/ownerSpendingApprovalBinding.js';

const disclosure: OwnerSpendingApprovalDisclosure = {
  slipId: 'synthetic-slip',
  origin: 'https://fixture.invalid',
  ownerGeneration: 'owner-8',
  deviceGeneration: 'device-2',
  holderEpoch: 'epoch-4',
  enableRevision: 'enable-1',
  capsRevision: 'caps-3',
  grantRevision: 'grant-0',
  enablePlanId: 'fixture-plan',
  enablePlanText: 'Enable the money layer. No paid service is armed.',
  slipExpiresAt: 1795590300000,
  grantStartsAt: 1795590000000,
  grantExpiresAt: 1795676400000,
  resetTimeZone: 'UTC',
  dailyCapMicroUsd: 50_000_000,
  agentIds: ['fixture-agent'],
  purposeClasses: ['fixture-work'],
  doors: [{ id: 'fixture-door', provider: 'fixture-provider', keyRef: 'fixture-key', dailyCapMicroUsd: 5_000_000 }],
};

it('binds the exact rendered plan and the visible grant scope in the same approval', () => {
  const expected = ownerSpendingApprovalBinding(disclosure);
  expect(expected).toMatch(/^[a-f0-9]{64}$/);
  expect(ownerSpendingApprovalBinding({ ...disclosure })).toBe(expected);
  for (const change of [
    { enablePlanText: disclosure.enablePlanText + '\n' }, { enablePlanId: 'other-plan' },
    { dailyCapMicroUsd: 50_000_001 }, { resetTimeZone: 'America/Los_Angeles' },
    { grantExpiresAt: disclosure.grantExpiresAt + 1 }, { slipExpiresAt: disclosure.slipExpiresAt + 1 },
    { agentIds: ['other-agent'] }, { purposeClasses: ['other-purpose'] },
    { doors: [{ ...disclosure.doors[0], dailyCapMicroUsd: 4_000_000 }] },
    { holderEpoch: 'epoch-5' }, { grantRevision: 'grant-1' }, { capsRevision: 'caps-4' },
    { enableRevision: 'enable-2' }, { deviceGeneration: 'device-3' }, { ownerGeneration: 'owner-9' },
    { origin: 'https://other.invalid' }, { slipId: 'different-slip' },
  ]) {
    expect(ownerSpendingApprovalBinding({ ...disclosure, ...change })).not.toBe(expected);
  }
});
