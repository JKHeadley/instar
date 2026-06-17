/**
 * WS5.2 R4a — the TARGET-side acceptance of a cross-machine-delivered account-follow-me mandate.
 *
 * Pure logic over INJECTED seams (the operator-machine key resolver, the bounds expectation, the
 * delivered-mandate store) so the dangerous authority decision is unit-testable without a server.
 * This is the brains behind the `account-follow-me-mandate-deliver` mesh handler.
 *
 * THE TRUST MODEL (Know Your Principal — load-bearing):
 *   - `sender` is the MESH-AUTHENTICATED operator machine (verifyEnvelope already proved the
 *     Ed25519 signature, recipient-binding, freshness, and registered-peer status before this runs).
 *     A name inside the payload is NEVER trusted; `sender` is the only fingerprint we anchor to.
 *   - We resolve the operator machine's REGISTERED Ed25519 public key for `sender` (the SAME key
 *     verifyEnvelope used), then `acceptDeliveredMandate` re-verifies the PortableMandate's OWN
 *     asymmetric issuance signature against that key + `sender` as the expected operator fingerprint.
 *     This proves the operator machine signed THIS mandate's canonical bytes (defense beyond the
 *     envelope), and that the mandate's embedded issuerFingerprint === the authenticated sender.
 *   - FAIL CLOSED on every uncertainty: feature dark, no operator key registered, signature fails,
 *     wrong issuer, or the delivered bounds are not an exact account-follow-me/re-mint shape → REFUSE
 *     and persist NOTHING. An unverified mandate never lands in the store.
 *
 * The accepted mandate's exact (accountId, targetMachineId, mechanism) bounds are validated to be a
 * re-mint account-follow-me grant for THIS machine here too (so a malformed delivery is rejected at
 * accept time); the enroll-start route re-verifies again at point-of-use (never trust a stored flag).
 */

import { acceptDeliveredMandate, type PortableMandate } from './AccountFollowMeMandateBridge.js';
import type { DeliveredMandateStore } from './DeliveredMandateStore.js';

export type MandateDeliveryResult =
  | { accepted: true; mandateId: string }
  | { accepted: false; reason: string };

export interface AccountFollowMeMandateDeliveryDeps {
  /** Is account follow-me enabled (resolved dev-gate) on THIS machine? Dark ⇒ refuse everything. */
  enabled: () => boolean;
  /** This machine's id — the delivered mandate's targetMachineId MUST equal it (exact-bounds, R1). */
  selfMachineId: () => string;
  /**
   * The REGISTERED Ed25519 public key (PEM) for the AUTHENTICATED sender (the operator machine), or
   * null if unknown. SAME source verifyEnvelope used (the registered machine-identity store) — NEVER
   * a key from the payload. PEM (not a KeyObject) so the verified key is persisted for the
   * point-of-use re-verify without a later peer-key lookup.
   */
  operatorMachinePublicKey: (sender: string) => string | null;
  /** Durable store of accepted+verified delivered mandates. */
  store: DeliveredMandateStore;
  log?: (msg: string) => void;
}

/**
 * Read the account-follow-me bounds off a (already-R4a-verified) mandate. Returns null when the
 * mandate carries no account-follow-me authority (so a foreign mandate delivered here is refused).
 */
export function readFollowMeBounds(
  mandate: PortableMandate['mandate'],
): { accountId: string; targetMachineId: string; mechanism: string } | null {
  const authority = (mandate.authorities ?? []).find((a) => a.action === 'account-follow-me');
  if (!authority) return null;
  const b = (authority.bounds ?? {}) as Record<string, unknown>;
  const accountId = typeof b.accountId === 'string' ? b.accountId : '';
  const targetMachineId = typeof b.targetMachineId === 'string' ? b.targetMachineId : '';
  const mechanism = typeof b.mechanism === 'string' ? b.mechanism : '';
  if (!accountId || !targetMachineId || !mechanism) return null;
  return { accountId, targetMachineId, mechanism };
}

/**
 * Accept (or refuse) a delivered account-follow-me mandate on the target. FAIL CLOSED.
 * `sender` MUST be the mesh-authenticated envelope sender.
 */
export function acceptMandateDelivery(
  deps: AccountFollowMeMandateDeliveryDeps,
  sender: string,
  portable: PortableMandate | undefined | null,
): MandateDeliveryResult {
  if (!deps.enabled()) return { accepted: false, reason: 'feature-disabled' };
  if (!portable || !portable.mandate || !portable.issuanceSignature) {
    return { accepted: false, reason: 'malformed-portable-mandate' };
  }
  if (!sender) return { accepted: false, reason: 'no-authenticated-sender' };

  // Know Your Principal: resolve the operator machine's REGISTERED key for the AUTHENTICATED sender.
  // No registered key ⇒ we cannot ground the trust anchor ⇒ refuse (deny-by-default).
  const operatorKey = deps.operatorMachinePublicKey(sender);
  if (!operatorKey) {
    deps.log?.(`[account-follow-me] mandate-deliver refused: no registered operator key for ${sender}`);
    return { accepted: false, reason: 'no-operator-key-registered' };
  }

  // R4a — the LOAD-BEARING authority: verify the asymmetric issuance signature against the
  // registered operator key, binding the expected issuer to the authenticated sender (a payload
  // name can never become the operator by construction).
  const accept = acceptDeliveredMandate({
    portable,
    operatorEd25519PublicKey: operatorKey,
    expectedOperatorMachineFingerprint: sender,
  });
  if (!accept.accepted) {
    deps.log?.(`[account-follow-me] mandate-deliver refused: ${accept.reason}`);
    return { accepted: false, reason: accept.reason };
  }

  // Exact-bounds (R1): the mandate MUST be a re-mint account-follow-me grant for THIS machine.
  // A foreign or mis-targeted mandate is refused — it can never be replayed for another machine.
  const bounds = readFollowMeBounds(accept.mandate);
  if (!bounds) return { accepted: false, reason: 'not-an-account-follow-me-mandate' };
  if (bounds.targetMachineId !== deps.selfMachineId()) {
    deps.log?.(
      `[account-follow-me] mandate-deliver refused: target ${bounds.targetMachineId} !== this machine`,
    );
    return { accepted: false, reason: 'target-not-this-machine' };
  }
  if (bounds.mechanism !== 're-mint') {
    return { accepted: false, reason: `unsupported-mechanism:${bounds.mechanism}` };
  }

  // Verified — persist the FULL portable bundle (so enroll-start can re-verify at point-of-use) +
  // the authenticated delivering operator machine AND the registered operator key the R4a signature
  // verified against (the trust anchor for that re-verify, re-bound without a later peer-key lookup).
  deps.store.put(portable, sender, operatorKey);
  deps.log?.(
    `[account-follow-me] accepted delivered mandate ${accept.mandate.id} (account=${bounds.accountId}) from ${sender}`,
  );
  return { accepted: true, mandateId: accept.mandate.id };
}
