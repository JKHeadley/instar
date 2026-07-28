/**
 * Unit tests for WS5.2 §5.2/R4a — cross-machine mandate delivery bridge
 * (AccountFollowMeMandateBridge). Proves a mandate issued on the operator machine is verifiable
 * on the target via the asymmetric issuance signature, and a forged/tampered/wrong-issuer one is
 * rejected (fail-closed) — without any shared secret.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  packageMandateForDelivery,
  acceptDeliveredMandate,
} from '../../src/coordination/AccountFollowMeMandateBridge.js';
import type { CoordinationMandate } from '../../src/coordination/types.js';

function mandate(over: Partial<CoordinationMandate> = {}): CoordinationMandate {
  return {
    id: 'MND-afm-1',
    scope: 'account-follow-me',
    agents: ['fp-operator-agent', 'fp-target-agent'],
    authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct-1', targetMachineId: 'mini', mechanism: 're-mint' } }],
    author: 'justin',
    createdAt: '2026-06-17T00:00:00Z',
    expiresAt: '2026-06-18T00:00:00Z',
    revoked: null,
    authProof: 'local-hmac-irrelevant-to-cross-machine',
    ...over,
  };
}

const OP_FP = 'fp-operator-machine';

describe('AccountFollowMeMandateBridge (WS5.2 R4a)', () => {
  it('target ACCEPTS a mandate signed by the trusted operator-machine key', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptDeliveredMandate({
      portable,
      operatorEd25519PublicKey: op.publicKey,
      expectedOperatorMachineFingerprint: OP_FP,
    });
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.mandate.id).toBe('MND-afm-1');
  });

  it('REJECTS a mandate signed by an untrusted machine key', () => {
    const attacker = crypto.generateKeyPairSync('ed25519');
    const op = crypto.generateKeyPairSync('ed25519');
    const portable = packageMandateForDelivery(mandate(), OP_FP, attacker.privateKey);
    const r = acceptDeliveredMandate({ portable, operatorEd25519PublicKey: op.publicKey, expectedOperatorMachineFingerprint: OP_FP });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/issuance-verify-failed:bad-signature/);
  });

  it('REJECTS a mandate whose authored body was tampered after signing', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    // Tamper: widen the bounds to a different account after signing.
    portable.mandate.authorities[0].bounds = { accountId: 'acct-EVIL', targetMachineId: 'mini', mechanism: 're-mint' };
    const r = acceptDeliveredMandate({ portable, operatorEd25519PublicKey: op.publicKey, expectedOperatorMachineFingerprint: OP_FP });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/issuance-verify-failed:bad-signature/);
  });

  it('REJECTS when the expected operator fingerprint does not match the signer', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptDeliveredMandate({ portable, operatorEd25519PublicKey: op.publicKey, expectedOperatorMachineFingerprint: 'fp-different-machine' });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/issuer-not-trusted/);
  });

  it('REJECTS a malformed portable mandate (fail-closed)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    expect(acceptDeliveredMandate({ portable: null, operatorEd25519PublicKey: op.publicKey, expectedOperatorMachineFingerprint: OP_FP }).accepted).toBe(false);
    // @ts-expect-error intentionally malformed
    expect(acceptDeliveredMandate({ portable: { mandate: mandate() }, operatorEd25519PublicKey: op.publicKey, expectedOperatorMachineFingerprint: OP_FP }).accepted).toBe(false);
  });
});
