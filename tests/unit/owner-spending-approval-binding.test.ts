import { expect, it } from 'vitest';
import {
  ownerSpendingApprovalBinding,
  type OwnerSpendingApprovalDisclosure,
} from '../../src/core/ownerSpendingApprovalBinding.js';

import { createHash } from 'node:crypto';
import { actionApprovalMessage } from '../../src/server/mobileOwnerPresenceRoutes.js';
import vector from '../fixtures/owner-spending-approval/synthetic-signing-vector.json';

const disclosure: OwnerSpendingApprovalDisclosure = vector.disclosure;

it('matches the fixed disclosure digest and owner presence bytes', () => {
  const publishedBytes = Buffer.from(vector.canonicalDisclosureBase64, 'base64');
  expect(createHash('sha256').update(publishedBytes).digest('hex')).toBe(vector.expectedDigest);
  expect(ownerSpendingApprovalBinding(disclosure)).toBe(vector.expectedDigest);

  const { deviceId, host, purpose, challenge, expectedMessageBase64 } = vector.presence;
  const message = actionApprovalMessage(deviceId, host, purpose, vector.expectedDigest, challenge);
  expect(Buffer.from(message, 'utf8').toString('base64')).toBe(expectedMessageBase64);
});

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
