/**
 * WS5.2 R4a — asymmetric cross-machine mandate issuance signature.
 *
 * Foundational finding (spec §3.1a): the existing mandate authorship proof
 * (`MandateStore.verifyAuthorship` → injected `verifySig`) is a SYMMETRIC HMAC keyed on the
 * per-machine issuance secret. It is LOCAL-ONLY — a target machine has a DIFFERENT secret and
 * would reject every legitimate cross-machine mandate. Sharing that secret across machines is
 * forbidden (one disk compromise → forge-any-mandate-on-any-peer).
 *
 * Therefore a mandate that crosses the mesh carries an ADDITIONAL asymmetric signature: the
 * issuing (operator) machine signs the canonical mandate bytes — bound to its own machine
 * fingerprint — with its Ed25519 *identity* private key (the MachineIdentity key used for mesh
 * envelopes). Any peer holding the registered operator-machine public key verifies "this
 * mandate was issued by my trusted operator-machine," WITHOUT any shared secret. The operator's
 * PIN authority reaches the remote verifier through the trust root: PIN-gated issuance on
 * machine M → M's Ed25519 signature → the peer verifies M is the registered operator machine.
 *
 * This module is the pure-crypto primitive (PR1). It is INDEPENDENT of, and ADDITIVE to, the
 * existing local HMAC proof — both must hold where both apply. Wiring to the live MachineIdentity
 * key + the registered operator-machine fingerprint is a later step (proven by a wiring test).
 */

import crypto from 'node:crypto';

/** Domain-separation tag — these bytes are NEVER interchangeable with any other signed surface. */
const ISSUANCE_DOMAIN = 'instar-account-follow-me-mandate-issuance-v1';

export interface CrossMachineIssuanceSignature {
  alg: 'ed25519';
  /** Fingerprint of the issuing (operator) machine — bound into the signed bytes. */
  issuerFingerprint: string;
  /** Ed25519 signature (base64) over the domain-tagged (issuerFingerprint, canonical) bytes. */
  sig: string;
}

/** The exact bytes signed/verified — issuer fingerprint is bound so a sig can't be re-attributed. */
function issuanceSigningInput(canonical: string, issuerFingerprint: string): Buffer {
  return Buffer.from(`${ISSUANCE_DOMAIN}\x1f${issuerFingerprint}\x1f${canonical}`, 'utf-8');
}

/**
 * Produce the asymmetric issuance signature on the operator-machine (R4a).
 * @param canonical canonical mandate bytes (from `canonicalMandate`)
 * @param issuerFingerprint the issuing machine's routing fingerprint
 * @param ed25519PrivateKey the issuing machine's Ed25519 identity private key
 */
export function signMandateIssuance(
  canonical: string,
  issuerFingerprint: string,
  ed25519PrivateKey: crypto.KeyObject,
): CrossMachineIssuanceSignature {
  if (!issuerFingerprint) throw new Error('signMandateIssuance: issuerFingerprint required');
  const sig = crypto.sign(null, issuanceSigningInput(canonical, issuerFingerprint), ed25519PrivateKey);
  return { alg: 'ed25519', issuerFingerprint, sig: sig.toString('base64') };
}

/**
 * Verify an asymmetric issuance signature at the receiving peer (R4a). FAILS CLOSED on:
 * a missing/wrong-alg signature, a claimed issuer that is not the EXPECTED registered
 * operator-machine, a malformed key, or a bad signature. Returns a reason for audit.
 */
export function verifyMandateIssuance(args: {
  canonical: string;
  signature: CrossMachineIssuanceSignature | undefined | null;
  /** The trusted operator-machine's Ed25519 public key (KeyObject or PEM/DER acceptable by crypto). */
  issuerEd25519PublicKey: crypto.KeyObject | string | Buffer;
  /** The fingerprint the receiver TRUSTS as its operator-machine (verified-operator binding). */
  expectedIssuerFingerprint: string;
}): { ok: boolean; reason?: string } {
  const { canonical, signature, issuerEd25519PublicKey, expectedIssuerFingerprint } = args;
  if (!signature || typeof signature !== 'object') return { ok: false, reason: 'no-signature' };
  if (signature.alg !== 'ed25519') return { ok: false, reason: `unsupported-alg:${signature.alg}` };
  if (!expectedIssuerFingerprint) return { ok: false, reason: 'no-expected-issuer' };
  // The signature must claim the issuer the receiver actually trusts (no content-name trust).
  if (signature.issuerFingerprint !== expectedIssuerFingerprint) {
    return { ok: false, reason: 'issuer-not-trusted' };
  }
  let pub: crypto.KeyObject;
  try {
    pub = issuerEd25519PublicKey instanceof crypto.KeyObject
      ? issuerEd25519PublicKey
      : crypto.createPublicKey(issuerEd25519PublicKey);
  } catch (err) {
    return { ok: false, reason: `bad-issuer-key:${err instanceof Error ? err.message : String(err)}` };
  }
  let valid: boolean;
  try {
    valid = crypto.verify(
      null,
      issuanceSigningInput(canonical, signature.issuerFingerprint),
      pub,
      Buffer.from(signature.sig, 'base64'),
    );
  } catch (err) {
    return { ok: false, reason: `verify-error:${err instanceof Error ? err.message : String(err)}` };
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad-signature' };
}
