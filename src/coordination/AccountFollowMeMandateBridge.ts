/**
 * WS5.2 §5.2 + R4a — cross-machine delivery of an `account-follow-me` mandate.
 *
 * Coordination mandates are issued (PIN-gated) and verified LOCALLY today; their authorship proof
 * is a SYMMETRIC HMAC over the per-machine issuance secret, which a PEER cannot verify (§3.1a).
 * For account-follow-me the mandate is issued on the OPERATOR machine but must be acted on by the
 * TARGET machine — so it has to cross the mesh and be verified there WITHOUT a shared secret.
 *
 * This bridge wires PR1's asymmetric primitives (CrossMachineMandate.signMandateIssuance /
 * verifyMandateIssuance, R4a) onto the mandate's canonical bytes:
 *   - on the operator machine: sign the canonical mandate with the machine's Ed25519 IDENTITY key,
 *     bound to its fingerprint, producing a portable issuance signature;
 *   - on the target machine: verify that signature against the REGISTERED operator-machine's
 *     Ed25519 public key + expected fingerprint (verified-operator binding) BEFORE acting. A
 *     forged/edited/wrong-issuer mandate is rejected (deny-by-default; reach ≠ authority, L15).
 *
 * The bridge does NOT itself grant anything — a verified mandate still flows through MandateGate
 * (via AccountFollowMeOrchestrator) for the exact (account, target, mechanism) bounds check. This
 * is the transport+authenticity layer only. Pure logic + injected crypto; PR2 increment 3b.
 */

import crypto from 'node:crypto';
import { canonicalMandate } from './MandateStore.js';
import { signMandateIssuance, verifyMandateIssuance, type CrossMachineIssuanceSignature } from './CrossMachineMandate.js';
import type { CoordinationMandate } from './types.js';

/** A mandate packaged for cross-machine delivery: the mandate + its asymmetric issuance signature. */
export interface PortableMandate {
  mandate: CoordinationMandate;
  issuanceSignature: CrossMachineIssuanceSignature;
}

/**
 * Sign an issued mandate for cross-machine delivery (operator machine side). The canonical bytes
 * are the SAME authored-field projection the local authProof covers, so the asymmetric signature
 * and the local HMAC proof attest to identical content.
 */
export function packageMandateForDelivery(
  mandate: CoordinationMandate,
  issuerFingerprint: string,
  ed25519PrivateKey: crypto.KeyObject,
): PortableMandate {
  const canonical = canonicalMandate(mandate);
  const issuanceSignature = signMandateIssuance(canonical, issuerFingerprint, ed25519PrivateKey);
  return { mandate, issuanceSignature };
}

export type MandateAcceptResult =
  | { accepted: true; mandate: CoordinationMandate }
  | { accepted: false; reason: string };

/**
 * Verify a delivered mandate on the TARGET machine (R4a). FAILS CLOSED: the asymmetric issuance
 * signature must verify against the EXPECTED registered operator-machine's Ed25519 key + fingerprint
 * (a name in the payload is never trusted — only the cryptographic + verified-operator binding).
 * On success the mandate is returned for the orchestrator/gate to evaluate the exact bounds; this
 * layer asserts ONLY "this mandate was genuinely issued by my trusted operator machine."
 */
export function acceptDeliveredMandate(args: {
  portable: PortableMandate | undefined | null;
  /** The trusted operator-machine's Ed25519 public key (registered MachineIdentity key). */
  operatorEd25519PublicKey: crypto.KeyObject | string | Buffer;
  /** The fingerprint the target TRUSTS as its operator machine (verified-operator binding). */
  expectedOperatorMachineFingerprint: string;
}): MandateAcceptResult {
  const { portable, operatorEd25519PublicKey, expectedOperatorMachineFingerprint } = args;
  if (!portable || !portable.mandate || !portable.issuanceSignature) {
    return { accepted: false, reason: 'malformed-portable-mandate' };
  }
  const canonical = canonicalMandate(portable.mandate);
  const v = verifyMandateIssuance({
    canonical,
    signature: portable.issuanceSignature,
    issuerEd25519PublicKey: operatorEd25519PublicKey,
    expectedIssuerFingerprint: expectedOperatorMachineFingerprint,
  });
  if (!v.ok) return { accepted: false, reason: `issuance-verify-failed:${v.reason ?? 'unknown'}` };
  return { accepted: true, mandate: portable.mandate };
}
