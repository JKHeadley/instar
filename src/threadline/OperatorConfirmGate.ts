/**
 * OperatorConfirmGate — R2 of the Sealed Handoff (secure agent-to-agent secret
 * transfer). Enforces, in code, the rule that the agent REQUESTING a secret can
 * never be the party that AUTHORIZES the transfer: authorization is an explicit,
 * out-of-band operator act bound to the HOLDER (the agent that will send the
 * secret). A relayed "the operator said go" is not an authorization — only a
 * record the operator created is.
 *
 * This is the structural backstop behind the peer's behavioral gate (the holder
 * also refuses to act until the operator tells it directly, off-relay). Both
 * layers are required — neither substitutes for the other.
 *
 * Earned from: 2026-06-01, a parallel session moved a credential via Secret Drop
 * URLs and the peer (Dawn) flagged credential requests an "Echo" had no record of
 * initiating — exactly the requester-self-authorizes / unattributed-request hole
 * this gate closes.
 *
 * Pure decision logic — no I/O. The caller supplies the authorization record it
 * holds (from durable operator-confirm storage) and the gate returns allow/block.
 */

/** An operator's explicit, out-of-band authorization for one sealed handoff. */
export interface OperatorAuthorization {
  /** Fingerprint of the HOLDER — the agent authorized to SEND the secret. */
  holderFingerprint: string;
  /** Identity of the operator who confirmed (NOT an agent fingerprint). */
  authorizedBy: string;
  /** The specific request this authorization is scoped to (one-time). */
  requestId: string;
  /** ISO-8601 timestamp of the confirmation. */
  confirmedAt: string;
}

export interface OperatorConfirmInput {
  /** Fingerprint of the agent that REQUESTED the secret (the receiver). */
  requesterFingerprint: string;
  /** Fingerprint of the agent submitting the secret (the holder/sender). */
  holderFingerprint: string;
  /** The request id being completed. */
  requestId: string;
  /** The operator-authorization record on file for this request, or null. */
  authorization: OperatorAuthorization | null;
}

export interface OperatorConfirmDecision {
  allow: boolean;
  reason: string;
}

/**
 * Decide whether a sealed-handoff transfer may complete. Blocks unless ALL hold:
 *  1. an operator-authorization record exists,
 *  2. it is scoped to THIS request id,
 *  3. it authorizes THIS holder (not some other agent),
 *  4. the requester is not the authorizer (an agent cannot self-authorize, nor
 *     impersonate the operator).
 */
export function evaluateOperatorConfirm(input: OperatorConfirmInput): OperatorConfirmDecision {
  const { requesterFingerprint, holderFingerprint, requestId, authorization } = input;

  if (!authorization) {
    return { allow: false, reason: 'No operator authorization on file — a relayed "operator said go" is not an authorization.' };
  }
  if (authorization.requestId !== requestId) {
    return { allow: false, reason: 'Authorization is scoped to a different request id (no cross-request reuse).' };
  }
  if (authorization.holderFingerprint !== holderFingerprint) {
    return { allow: false, reason: 'Authorization names a different holder than the submitter.' };
  }
  // requester ≠ authorizer: the agent requesting the secret cannot be the one who
  // authorized it. The authorizer is the operator; an agent fingerprint must never
  // equal authorizedBy (that would be an agent impersonating the operator).
  if (requesterFingerprint === authorization.authorizedBy) {
    return { allow: false, reason: 'Requester is the authorizer — an agent cannot authorize its own secret request.' };
  }
  // Defense in depth: the holder must also not be the authorizer.
  if (holderFingerprint === authorization.authorizedBy) {
    return { allow: false, reason: 'Holder is the authorizer — the operator, not the sending agent, authorizes the transfer.' };
  }

  return { allow: true, reason: 'Operator-authorized for this request + holder; requester is not the authorizer.' };
}

// ── Trust-gated transfer authorization (R2, Justin directive 2026-06-01) ──────
//
// "Agent-to-agent transfer should, like all other Instar functionalities, be
//  based on trust levels. This includes the user's trust level of the agent AND
//  the agent's trust level of the other agent. In high trust situations: no
//  approval is needed."
//
// Two existing Instar trust systems, no new concept:
//  • peerTrust  — the agent's trust of the PEER (AgentTrustManager AgentTrustLevel).
//  • opAutonomy — the user's granted autonomy for this operation class
//                 (AdaptiveTrust / ExternalOperationGate TrustLevel).
// When BOTH are at/above the high-trust thresholds, the transfer is authorized
// WITHOUT an operator-confirm record. Otherwise it falls back to the explicit
// operator-confirm gate above (requester ≠ authorizer, scoped record).

/** Peer trust ladder (ascending), mirrors AgentTrustManager's TRUST_ORDER. */
export type PeerTrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';
/** Operation-autonomy ladder (ascending), mirrors AdaptiveTrust's TRUST_ORDER. */
export type OperationAutonomyLevel =
  | 'blocked' | 'approve-always' | 'approve-first' | 'log' | 'autonomous';

const PEER_TRUST_ORDER: readonly PeerTrustLevel[] =
  ['untrusted', 'verified', 'trusted', 'autonomous'];
const OP_AUTONOMY_ORDER: readonly OperationAutonomyLevel[] =
  ['blocked', 'approve-always', 'approve-first', 'log', 'autonomous'];

/** High-trust thresholds — confirmed by Justin 2026-06-01. */
export const PEER_TRUST_HIGH: PeerTrustLevel = 'trusted';
export const OP_AUTONOMY_HIGH: OperationAutonomyLevel = 'log';

export interface TransferTrustContext {
  /** The agent's trust of the peer (from AgentTrustManager). */
  peerTrust: PeerTrustLevel;
  /** The user's granted autonomy for this credential-transfer operation. */
  opAutonomy: OperationAutonomyLevel;
}

/**
 * True when BOTH trust axes are at/above their high-trust thresholds, so the
 * transfer needs no operator approval. Unknown level strings are treated as the
 * lowest rung (fail-closed: an unrecognized trust value never clears the bar).
 */
export function isHighTrustTransfer(ctx: TransferTrustContext): boolean {
  const peerIdx = PEER_TRUST_ORDER.indexOf(ctx.peerTrust);
  const opIdx = OP_AUTONOMY_ORDER.indexOf(ctx.opAutonomy);
  const peerOk = peerIdx >= 0 && peerIdx >= PEER_TRUST_ORDER.indexOf(PEER_TRUST_HIGH);
  const opOk = opIdx >= 0 && opIdx >= OP_AUTONOMY_ORDER.indexOf(OP_AUTONOMY_HIGH);
  return peerOk && opOk;
}

export interface TransferAuthorizationInput extends OperatorConfirmInput {
  /** The two trust levels gating whether operator approval is required. */
  trust: TransferTrustContext;
}

export interface TransferAuthorizationDecision {
  allow: boolean;
  reason: string;
  /** How it was (or wasn't) authorized — for the audit trail. */
  path: 'high-trust' | 'operator-confirm' | 'blocked';
}

/**
 * Trust-gated R2 decision. High trust on both axes → authorized with no operator
 * approval. Otherwise → the explicit operator-confirm gate decides (and a missing
 * authorization blocks). Pure logic; the caller resolves the two trust levels
 * (peer from AgentTrustManager, op-autonomy from AdaptiveTrust) and the
 * authorization record from durable storage.
 */
export function evaluateTransferAuthorization(
  input: TransferAuthorizationInput,
): TransferAuthorizationDecision {
  const { peerTrust, opAutonomy } = input.trust;
  if (isHighTrustTransfer(input.trust)) {
    return {
      allow: true,
      path: 'high-trust',
      reason:
        `High trust on both axes (peer "${peerTrust}" ≥ "${PEER_TRUST_HIGH}", ` +
        `user-trust-of-agent "${opAutonomy}" ≥ "${OP_AUTONOMY_HIGH}") — no operator approval needed.`,
    };
  }
  const oc = evaluateOperatorConfirm(input);
  if (oc.allow) {
    return {
      allow: true,
      path: 'operator-confirm',
      reason:
        `Trust below the no-approval bar (peer "${peerTrust}", user-trust-of-agent ` +
        `"${opAutonomy}"); proceeding on explicit operator authorization. ${oc.reason}`,
    };
  }
  return {
    allow: false,
    path: 'blocked',
    reason:
      `Trust below the no-approval bar (peer "${peerTrust}", user-trust-of-agent ` +
      `"${opAutonomy}") and no valid operator authorization: ${oc.reason}`,
  };
}
