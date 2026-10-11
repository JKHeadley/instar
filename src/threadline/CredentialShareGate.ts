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
  | 'credential-requires-encrypted-path'
  | 'encryption-key-not-bound';

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
  /**
   * True iff the channel is bound to the verified pairing: the peer's current identity key
   * is the pinned one, its encryption key is derived from it, and the pairingId still
   * matches our current key (FD4 v2). Implemented by ThreadlineClient.isChannelBoundToPairing.
   * Optional so older probes compile; an absent method REFUSES (fail-closed).
   */
  isChannelBoundToPairing?(recipientFp: string, pinnedIdentityPubHex: string, pairingId: string): boolean;
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
 * Refuses unless ALL hold:
 *   1. the recipient peer is `mutual-verified` (peer-not-mutually-verified), AND
 *   2. the encrypted+signed send path is available for that recipient — a credential
 *      must NEVER traverse the plaintext fallback (credential-requires-encrypted-path), AND
 *   3. that path's encryption key is derived from the pinned, human-verified identity key
 *      and the pairing still matches our current key (encryption-key-not-bound, FD4 v2).
 *
 * Fail-closed (FD9): any thrown error → refuse with peer-not-mutually-verified.
 *
 * @param recipientFp the peer's RESOLVED full routing fingerprint (never a name).
 */
export function evaluateOutboundCredentialShare(
  trustManager: Pick<AgentTrustManager, 'isCredentialShareAllowedByFingerprint' | 'getProfileByFingerprint'>,
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

    // (3) The encryption key must be bound to the identity key the human verified
    // (FD4 v2, issue #2117 gap I). The SAS proves the Ed25519 identity key only; if the
    // X25519 key were whatever the relay handed over, a relay could pass the SAS check
    // and then read the credential.
    const profile = trustManager.getProfileByFingerprint(recipientFp);
    if (
      !profile?.peerIdentityPub ||
      !profile.pairingId ||
      typeof encryptedPath.isChannelBoundToPairing !== 'function' ||
      !encryptedPath.isChannelBoundToPairing(recipientFp, profile.peerIdentityPub, profile.pairingId)
    ) {
      return { allow: false, reason: 'encryption-key-not-bound' };
    }

    return { allow: true };
  } catch {
    return { allow: false, reason: 'peer-not-mutually-verified' };
  }
}
