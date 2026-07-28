/**
 * CredentialShareGate — the credential-workflow authorization gate.
 *
 * Part of Secure A2A Verified Pairing (docs/specs/secure-a2a-verified-pairing.md §3.5).
 *
 * NAMING HONESTY (spec §3.5): this is a credential-WORKFLOW authorization gate, not
 * a universal secret-exfiltration control. It guarantees the *sanctioned* credential
 * path (the `kind:'credential-share'` send + the credential-ingestion chokepoint)
 * requires a `mutual-verified` peer. It does NOT claim to stop a secret pasted into
 * free text — that is the ExternalOperationGate/DLP family's concern (FD5 deliberately
 * rejects content-sniffing as a security boundary).
 *
 * Two boundaries, both keyed on WHO the peer is (resolved trust source), never on a
 * message's self-declared kind or content:
 *   - OUTBOUND (load-bearing): refuse a credential-bearing send unless the recipient
 *     is `mutual-verified` AND the encrypted+signed path is available (never plaintext).
 *     LIVE whenever the feature flag is enabled — NOT gated by dryRun (FD10).
 *   - INBOUND: refuse to act on/persist an inbound payload AS a credential unless the
 *     resolved SENDER trust source is `mutual-verified`. dryRun governs observability
 *     of this side ONLY (logs the verdict it WOULD apply).
 *
 * Fail-closed (FD9): any error/uncertainty resolving pairing state → refuse.
 */

import type { AgentTrustManager } from './AgentTrustManager.js';

// ── Types ────────────────────────────────────────────────────────────

export type CredentialShareRefusalReason =
  | 'peer-not-mutually-verified'
  | 'credential-requires-encrypted-path';

export interface CredentialShareDecision {
  /** True = the sanctioned credential path is authorized for this peer. */
  allow: boolean;
  /** Present iff `allow` is false — a structured, content-free refusal reason. */
  reason?: CredentialShareRefusalReason;
}

/**
 * Minimal read surface the outbound chokepoint needs to decide whether the
 * encrypted+signed send path is available to a recipient (never plaintext for a
 * credential, spec §3.5). Implemented by ThreadlineClient.hasEncryptedSendPath.
 */
export interface EncryptedPathProbe {
  /** True iff this recipient's keys are known so MessageEncryptor.encrypt is used. */
  hasEncryptedSendPath(recipientFp: string): boolean;
}

// ── Agent-facing READ helper (the guarantee lives at the funnel) ──────

/**
 * `assertCanShareCredential` — the agent-facing READ of whether a credential MAY be
 * shared with a peer (spec §3.5). This is a courtesy/read; the structural GUARANTEE
 * lives at the relay-send funnel chokepoint (`evaluateOutboundCredentialShare`).
 *
 * Returns allow ONLY when the peer is `mutual-verified` AND level ≥ trusted. Any
 * uncertainty (unknown peer, error) → deny, fail-closed (FD9).
 */
export function assertCanShareCredential(
  trustManager: Pick<AgentTrustManager, 'isCredentialShareAllowedByFingerprint'>,
  peerFp: string,
): CredentialShareDecision {
  try {
    if (!peerFp) return { allow: false, reason: 'peer-not-mutually-verified' };
    if (trustManager.isCredentialShareAllowedByFingerprint(peerFp)) {
      return { allow: true };
    }
    return { allow: false, reason: 'peer-not-mutually-verified' };
  } catch {
    // FD9 — fail-closed on any uncertainty resolving pairing state.
    return { allow: false, reason: 'peer-not-mutually-verified' };
  }
}

// ── Outbound chokepoint decision (load-bearing, §3.5 / FD9) ───────────

/**
 * The OUTBOUND credential-share decision, called from inside the relay-send funnel
 * (a gate sibling to the existing send gates — NOT a voluntary helper). LIVE whenever
 * the feature flag is enabled; NOT gated by dryRun (FD10 — a leak gate has no
 * allow-by-default soak).
 *
 * Refuses unless BOTH hold:
 *   1. the recipient peer is `mutual-verified` (peer-not-mutually-verified), AND
 *   2. the encrypted+signed send path is available for that recipient — a credential
 *      must NEVER traverse the plaintext fallback (credential-requires-encrypted-path).
 *
 * Fail-closed (FD9): any thrown error → refuse with peer-not-mutually-verified.
 *
 * @param recipientFp the peer's RESOLVED full routing fingerprint (never a name).
 */
export function evaluateOutboundCredentialShare(
  trustManager: Pick<AgentTrustManager, 'isCredentialShareAllowedByFingerprint'>,
  encryptedPath: EncryptedPathProbe | null | undefined,
  recipientFp: string,
): CredentialShareDecision {
  try {
    if (!recipientFp) return { allow: false, reason: 'peer-not-mutually-verified' };

    // (1) WHO the peer is — the security input (FD5). Never a message label.
    if (!trustManager.isCredentialShareAllowedByFingerprint(recipientFp)) {
      return { allow: false, reason: 'peer-not-mutually-verified' };
    }

    // (2) The credential must go encrypted+signed only — never sendPlaintext.
    // If we cannot probe the path, or the path is plaintext-only, fail closed.
    if (!encryptedPath || !encryptedPath.hasEncryptedSendPath(recipientFp)) {
      return { allow: false, reason: 'credential-requires-encrypted-path' };
    }

    return { allow: true };
  } catch {
    return { allow: false, reason: 'peer-not-mutually-verified' };
  }
}
