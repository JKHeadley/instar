import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';
import {
  prepareSubscriptionReloginPoolTarget, subscriptionReloginConfigureDigest, validateSubscriptionReloginOperatorInput,
} from '../../src/core/SubscriptionReloginOperatorConfig.js';
import vector from '../fixtures/owner-approvals/signin-repair-v1.json';

const spki = (encoded: string) => createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('signs the exact inventory, disclosure and challenge and binds one configuration revision', () => {
  const authority = spki(vector.keys.authorityEd25519SpkiBase64);
  const signed = [
    [vector.inventory.inventory, vector.inventory.signature, vector.exactBytesBase64.inventory],
    [vector.disclosure.disclosure, vector.disclosure.signature, vector.exactBytesBase64.disclosure],
    [vector.challenge.challenge, vector.challenge.signature, vector.exactBytesBase64.challenge],
  ] as const;
  for (const [fields, signature, exact] of signed) {
    const bytes = Buffer.from(JSON.stringify(fields));
    expect(bytes.toString('base64')).toBe(exact);
    expect(verify(null, bytes, authority, Buffer.from(signature, 'base64url'))).toBe(true);
  }

  const parsed = validateSubscriptionReloginOperatorInput(vector.policy.config);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(subscriptionReloginConfigureDigest(parsed.value, vector.policy.expectedRevision)).toBe(vector.policy.configDigest);
  expect(prepareSubscriptionReloginPoolTarget(vector.policy.config.unattendedPolicy, parsed.value.mode, vector.policy.expectedRevision))
    .toEqual({ config: parsed.value, configDigest: vector.policy.configDigest });
  expect(subscriptionReloginConfigureDigest(parsed.value, 'sha256:' + 'c'.repeat(64))).not.toBe(vector.policy.configDigest);
  expect(JSON.stringify(vector.disclosure.disclosure)).toContain(vector.policy.configDigest);
  expect(hash(Buffer.from(vector.exactBytesBase64.disclosure, 'base64'))).toBe(vector.submit.proposalHash);
  expect(vector.challenge.challenge[12]).toBe(vector.submit.proposalHash);
  expect(vector.challenge.challenge[13]).toBe(vector.submit.challengeId);
});

it('the dedicated phone key signs the exact challenge and rejects changed assurance', () => {
  const phone = spki(vector.keys.phoneP256SpkiBase64);
  expect(hash(phone.export({ type: 'spki', format: 'der' }))).toBe(vector.challenge.challenge[8]);
  const signature = Buffer.from(vector.submit.signature, 'base64url');
  expect(isStrictLowSDer(signature)).toBe(true);
  expect(verify('sha256', Buffer.from(vector.exactBytesBase64.challenge, 'base64'), phone, signature)).toBe(true);
  const changed = [...vector.challenge.challenge.slice(0, -1), 'user-presence'];
  expect(verify('sha256', Buffer.from(JSON.stringify(changed)), phone, signature)).toBe(false);
  expect(Number(vector.challenge.challenge[15])).toBeGreaterThan(Number(vector.appClockMs));
  expect(Number(vector.challenge.challenge[15])).toBeLessThan(Number(vector.disclosure.disclosure[8]));
});
