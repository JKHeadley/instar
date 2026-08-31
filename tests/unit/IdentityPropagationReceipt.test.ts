import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, sign } from '../../src/core/MachineIdentity.js';
import {
  acceptIdentityPropagationReceipt,
  identityPropagationReceiptMessage,
  type IdentityPropagationReceiptUnsigned,
} from '../../src/core/IdentityPropagationReceipt.js';

describe('IdentityPropagationReceipt', () => {
  const keys = generateSigningKeyPair();
  const other = generateSigningKeyPair();
  const unsigned: IdentityPropagationReceiptUnsigned = {
    version: 1,
    action: 'recovery-root',
    responderMachineId: 'm_peer',
    requesterMachineId: 'm_self',
    requestNonce: 'a'.repeat(64),
    subjectMachineId: 'm_self',
    epoch: 2,
    contentHash: 'b'.repeat(64),
    status: 'rotated',
  };
  const receipt = () => ({ ...unsigned, signature: sign(identityPropagationReceiptMessage(unsigned), keys.privateKey) });
  const accept = (candidate: unknown, expected = {}, publicKey = keys.publicKey) => acceptIdentityPropagationReceipt({
    receipt: candidate,
    expected: { ...unsigned, ...expected },
    allowedStatuses: ['rotated', 'already-current'],
    responderSigningPublicKeyPem: publicKey,
  });

  it('accepts an exact receiver-signed committed result', () => {
    expect(accept(receipt())).toBe('rotated');
  });

  it.each([
    ['responderMachineId', 'm_attacker'],
    ['requesterMachineId', 'm_other'],
    ['requestNonce', 'c'.repeat(64)],
    ['subjectMachineId', 'm_other'],
    ['epoch', 3],
    ['contentHash', 'd'.repeat(64)],
    ['action', 'signing-ack'],
  ] as const)('rejects a receipt substituted under the wrong %s', (field, value) => {
    expect(accept(receipt(), { [field]: value })).toBeNull();
  });

  it('rejects replay under a fresh request nonce', () => {
    expect(accept(receipt(), { requestNonce: 'e'.repeat(64) })).toBeNull();
  });

  it('rejects a forged signature and an unsigned 2xx-shaped body', () => {
    expect(accept({ ...unsigned, signature: sign(identityPropagationReceiptMessage(unsigned), other.privateKey) })).toBeNull();
    expect(accept({ status: 'rotated' })).toBeNull();
  });

  it('rejects signed dry-run success as non-committed', () => {
    const dry = { ...unsigned, status: 'would-rotate' as const };
    expect(accept({ ...dry, signature: sign(identityPropagationReceiptMessage(dry), keys.privateKey) })).toBeNull();
  });
});
