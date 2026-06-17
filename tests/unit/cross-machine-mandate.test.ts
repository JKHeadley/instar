/**
 * Unit tests for WS5.2 R4a — asymmetric cross-machine mandate issuance signature
 * (CrossMachineMandate.ts) — spec §3.1a, §8.1, §8.4.
 *
 * Proves: a peer ACCEPTS a mandate signed by the trusted operator-machine's Ed25519 key,
 * and REJECTS (fail-closed) a forged/tampered/wrong-issuer/HMAC-only mandate.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  signMandateIssuance,
  verifyMandateIssuance,
  type CrossMachineIssuanceSignature,
} from '../../src/coordination/CrossMachineMandate.js';

function ed25519() {
  return crypto.generateKeyPairSync('ed25519');
}

const CANONICAL = '["MND-1","pair",["echo","mini"],[["account-follow-me",{"accountId":"a1","targetMachineId":"mini"},""]],"echo","2026-06-16","2026-06-17"]';
const OPERATOR_FP = 'fp-operator-machine';

describe('cross-machine mandate issuance signature (WS5.2 R4a)', () => {
  it('a peer ACCEPTS a mandate signed by the trusted operator-machine key', () => {
    const op = ed25519();
    const sig = signMandateIssuance(CANONICAL, OPERATOR_FP, op.privateKey);
    const r = verifyMandateIssuance({
      canonical: CANONICAL,
      signature: sig,
      issuerEd25519PublicKey: op.publicKey,
      expectedIssuerFingerprint: OPERATOR_FP,
    });
    expect(r.ok).toBe(true);
  });

  it('REJECTS a signature from a different (untrusted) machine key', () => {
    const attacker = ed25519();
    const sig = signMandateIssuance(CANONICAL, OPERATOR_FP, attacker.privateKey);
    const op = ed25519(); // the key the receiver actually trusts
    const r = verifyMandateIssuance({
      canonical: CANONICAL,
      signature: sig,
      issuerEd25519PublicKey: op.publicKey,
      expectedIssuerFingerprint: OPERATOR_FP,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  it('REJECTS when the claimed issuer is not the trusted operator-machine', () => {
    const op = ed25519();
    const sig = signMandateIssuance(CANONICAL, 'fp-some-other-machine', op.privateKey);
    const r = verifyMandateIssuance({
      canonical: CANONICAL,
      signature: sig,
      issuerEd25519PublicKey: op.publicKey,
      expectedIssuerFingerprint: OPERATOR_FP,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('issuer-not-trusted');
  });

  it('REJECTS a tampered canonical body (signature no longer matches)', () => {
    const op = ed25519();
    const sig = signMandateIssuance(CANONICAL, OPERATOR_FP, op.privateKey);
    const r = verifyMandateIssuance({
      canonical: CANONICAL.replace('mini', 'attacker-vm'),
      signature: sig,
      issuerEd25519PublicKey: op.publicKey,
      expectedIssuerFingerprint: OPERATOR_FP,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  it('REJECTS a re-attributed signature (issuerFingerprint swapped in the envelope)', () => {
    const op = ed25519();
    const sig = signMandateIssuance(CANONICAL, OPERATOR_FP, op.privateKey);
    // Attacker rewrites the claimed issuer to match expected, keeping the original sig bytes.
    const forged: CrossMachineIssuanceSignature = { ...sig, issuerFingerprint: 'fp-evil' };
    const r = verifyMandateIssuance({
      canonical: CANONICAL,
      signature: forged,
      issuerEd25519PublicKey: op.publicKey,
      expectedIssuerFingerprint: 'fp-evil',
    });
    // issuerFingerprint is bound into the signed bytes → sig fails for the swapped value.
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  it('FAILS CLOSED on a missing signature / wrong alg / missing expected issuer', () => {
    const op = ed25519();
    expect(verifyMandateIssuance({ canonical: CANONICAL, signature: undefined, issuerEd25519PublicKey: op.publicKey, expectedIssuerFingerprint: OPERATOR_FP }).reason).toBe('no-signature');
    const sig = signMandateIssuance(CANONICAL, OPERATOR_FP, op.privateKey);
    expect(verifyMandateIssuance({ canonical: CANONICAL, signature: { ...sig, alg: 'hmac' as never }, issuerEd25519PublicKey: op.publicKey, expectedIssuerFingerprint: OPERATOR_FP }).reason).toMatch(/unsupported-alg/);
    expect(verifyMandateIssuance({ canonical: CANONICAL, signature: sig, issuerEd25519PublicKey: op.publicKey, expectedIssuerFingerprint: '' }).reason).toBe('no-expected-issuer');
  });
});
