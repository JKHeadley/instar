/**
 * WS5.2 (ws52-operator-tap-not-text Part B, R3.4) — point-of-use re-verification for
 * the cross-machine enroll connector.
 *
 * Convergence critical #3: the delivered-mandate enroll path re-verified ONLY the
 * R4a issuance signature + bounds (`verifyDeliveredMandate`) — it checked NEITHER
 * expiry NOR revocation, and revoke never purged the delivered store. So the
 * auto-enroll connector would honor a REVOKED or EXPIRED cross-machine mandate and
 * mint a fresh login the operator had killed. This pure predicate is the temporal +
 * revocation gate the convergence requires, run BEFORE every state transition that
 * could start or continue an enrollment ("never trust the stored flag").
 *
 * It is deliberately decoupled from the concrete mandate/store types: the caller
 * supplies the minimal facts (the mandate's id, expiry, and account-follow-me
 * bounds; the requested pair; the clock; and a LIVE revocation oracle). Fail-closed
 * on every uncertainty — an unknown/throwing revocation oracle is treated as
 * "revoked" (the safe direction), never "allow".
 */

export type EnrollDenyReason =
  | 'expired'
  | 'revoked'
  | 'bounds-mismatch'
  | 'revocation-unknown'
  | 'bad-expiry';

export interface EnrollPointOfUseInput {
  mandateId: string;
  /** The mandate's ISO expiry (R4a-signed). */
  expiresAt: string;
  /** The account-follow-me bounds the mandate was signed for. */
  bounds: { accountId: string; targetMachineId: string };
  /** What this enrollment is about to do — MUST equal the signed bounds. */
  requested: { accountId: string; targetMachineId: string };
  /** Wall-clock ms (injectable). */
  now: number;
  /**
   * LIVE revocation oracle: true ⇒ revoked. It MUST reflect both the local
   * `mandate.revoked` flag and the durable revocation record. A throw is treated
   * as revocation-unknown ⇒ DENY (fail-closed) — never silently allowed.
   */
  isRevoked: (mandateId: string) => boolean;
}

export interface EnrollPointOfUseResult {
  ok: boolean;
  reason: EnrollDenyReason | 'ok';
}

export function checkDeliveredMandateUsableForEnroll(
  input: EnrollPointOfUseInput,
): EnrollPointOfUseResult {
  // 1. Bounds must match the signed mandate EXACTLY (no caller-supplied drift —
  //    the lessons reviewer's "onMandateDelivered bounds came from the caller" gap).
  if (
    input.requested.accountId !== input.bounds.accountId ||
    input.requested.targetMachineId !== input.bounds.targetMachineId
  ) {
    return { ok: false, reason: 'bounds-mismatch' };
  }

  // 2. Expiry (a mandate always expires — a missing/garbage expiry is fail-closed).
  const exp = Date.parse(input.expiresAt);
  if (Number.isNaN(exp)) return { ok: false, reason: 'bad-expiry' };
  if (input.now > exp) return { ok: false, reason: 'expired' };

  // 3. Revocation — re-checked LIVE at point-of-use (the #3 critical). Fail-closed:
  //    a throwing/unknown oracle denies.
  let revoked: boolean;
  try {
    revoked = input.isRevoked(input.mandateId) === true;
  } catch {
    return { ok: false, reason: 'revocation-unknown' };
  }
  if (revoked) return { ok: false, reason: 'revoked' };

  return { ok: true, reason: 'ok' };
}
