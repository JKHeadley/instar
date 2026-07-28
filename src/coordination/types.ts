/**
 * Coordination Mandate — shared types.
 *
 * A Coordination Mandate is a human-authored, signed, bounded, conditioned,
 * revocable, audited delegation of SPECIFIC authorities to a SPECIFIC pair of
 * agents for a SPECIFIC purpose and bounded time. It moves the human's
 * authorization from per-action to standing-policy WITHOUT removing the human as
 * the authorizer — preserving `requester ≠ authorizer` (the agent is the
 * requester; the human-authored mandate is the authorizer).
 *
 * Spec: docs/specs/coordination-mandate.md (§4 concrete shape). The first mandate's
 * resolved bounds (Justin's A/A/B sign-off, 2026-06-05): cutover stays his manual
 * click; issuance is dashboard-PIN-gated; the first mandate carries only authorities
 * 1–2 (exchange-read-credential + sign-code-review), NOT execute-cutover.
 */

/** A single delegated authority within a mandate. */
export interface Authority {
  /** The action this authority permits, e.g. 'exchange-read-credential' | 'sign-code-review' | 'execute-cutover'. */
  action: string;
  /** Explicit bounds the action's params must satisfy (exact-match per key). */
  bounds: Record<string, unknown>;
  /** Optional objective gate that must evaluate true before the action is allowed,
   *  e.g. 'integrity-gate-pass' | 'parity-zero-divergence'. Resolved from REAL state,
   *  never from an agent's assertion. */
  requiresCondition?: string;
}

/**
 * A user→agent authority grant carried INSIDE a signed mandate. This is the
 * extension that lets the human (the mandate author) delegate a Slack FLOOR
 * action (money / prod-deploy / credentials / destructive / external / grant)
 * to a SPECIFIC verified Slack user for a bounded time — the same deny-by-default,
 * signed, expiring, revocable model the mandate already enforces for A2A authority.
 *
 * The grant is covered by the mandate's `authProof` (it is appended to the canonical
 * byte sequence when present), so an agent cannot mint or widen a grant: only the
 * PIN-gated issuance path can sign one in.
 *
 * `expiresAt` is independent of (and MUST be <= ) the mandate's own `expiresAt` —
 * the grant can never outlive the delegation that carries it. The store-side query
 * clamps to the mandate expiry, so a grant is void the moment EITHER clock passes.
 */
export interface UserAuthorityGrant {
  /** The Slack FLOOR action this grant authorizes (e.g. 'prod-deploy'). Matched
   *  against the gate's `scope` (the floorAction) on lookup. */
  floorAction: string;
  /** The VERIFIED Slack user id (U…) this grant is for — never a content name. */
  grantedTo: string;
  /** Who authorized it (the human author / operator). Requester ≠ authorizer. */
  authorizedBy: string;
  /** ISO timestamp after which the grant is void. MUST be <= the mandate's expiresAt. */
  expiresAt: string;
  /** Optional bounds carried for audit/future enforcement (advisory at the floor). */
  bounds?: Record<string, unknown>;
}

/** The human-authored delegation. `authProof` covers all other fields. */
export interface CoordinationMandate {
  id: string;
  /** e.g. 'feedback-migration'. */
  scope: string;
  /** The two agents bound by the mandate, by routing fingerprint. */
  agents: [string, string];
  authorities: Authority[];
  /** Always the human author identifier (e.g. 'justin'). */
  author: string;
  createdAt: string;
  expiresAt: string;
  /** Set when revoked; checked on every action. */
  revoked: { at: string; reason: string } | null;
  /**
   * Optional user→agent authority grants (the Slack-floor delegation extension).
   * Covered by `authProof` ONLY when present and non-empty — a mandate with no
   * grants canonicalizes byte-for-byte identically to a pre-extension mandate, so
   * existing signed mandates keep verifying (backward-compat is non-negotiable).
   */
  grants?: UserAuthorityGrant[];
  /** Authorship proof — an HMAC over the canonical (proof-excluded) mandate bytes,
   *  produced ONLY by the PIN-gated issuance path. An agent cannot mint or widen its
   *  own mandate without it; a forged/edited mandate fails verification. */
  authProof: string;
}

export type MandateDecision = 'allow' | 'deny';

/** The input to a gate evaluation — what the agent is asking to do. */
export interface MandateEvaluation {
  action: string;
  params: Record<string, unknown>;
  /** The calling agent's routing fingerprint (must be a named party). */
  agentFp: string;
  mandateId: string;
}

/** A single audited gate decision (one row of the hash-chained audit). */
export interface MandateAuditEntry {
  ts: string;
  mandateId: string;
  agentFp: string;
  action: string;
  decision: MandateDecision;
  /** Human-readable reason — which check passed/failed. */
  reason: string;
  /** The condition result when a `requiresCondition` was evaluated (else null). */
  conditionResult: boolean | null;
  /** Hash of the previous entry (genesis = ''), making the log tamper-evident (T8). */
  prevHash: string;
  /** sha256(prevHash + canonical(this-entry-without-hash)). */
  hash: string;
}
