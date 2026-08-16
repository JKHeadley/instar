/**
 * DispatchVerifier — Ed25519 dispatch origin verification.
 *
 * Verifies that dispatches came from a trusted Portal instance using
 * asymmetric cryptographic signatures. Portal signs with its private key;
 * agents verify with the public key.
 *
 * Why asymmetric, not HMAC: HMAC uses a shared secret — if any agent
 * is compromised, the attacker can forge dispatches for the entire network.
 * With Ed25519, agents can verify but never forge.
 *
 * Features:
 * - Ed25519 signature verification
 * - Replay prevention via seen-dispatch-ID cache (TTL: 24 hours)
 * - Expiry checking
 * - Key rotation support via keyId
 * - Canonical payload serialization
 */
import type { Dispatch } from './DispatchManager.js';
export interface SignedDispatch extends Dispatch {
    /** Ed25519 signature of canonical dispatch payload */
    signature: string;
    /** Timestamp of signing */
    signedAt: string;
    /** Expiry — dispatches older than this are rejected */
    expiresAt: string;
    /** Signing key ID — supports key rotation */
    keyId: string;
}
export interface VerificationResult {
    verified: boolean;
    reason: string;
}
export interface DispatchVerifierConfig {
    /** Map of keyId → PEM-encoded Ed25519 public key */
    trustedKeys: Record<string, string>;
    /** Replay cache TTL in ms (default: 24 hours) */
    replayCacheTtlMs?: number;
    /** Whether verification is required (default: false for gradual rollout) */
    required?: boolean;
}
export declare class DispatchVerifier {
    private trustedKeys;
    private replayCacheTtlMs;
    private required;
    private seenIds;
    constructor(config: DispatchVerifierConfig);
    /**
     * Verify a dispatch's origin and integrity.
     */
    verify(dispatch: Dispatch): VerificationResult;
    /**
     * Build the canonical signing payload for a dispatch.
     * Keys sorted alphabetically for deterministic serialization.
     */
    buildCanonicalPayload(dispatch: Dispatch, signedAt: string, expiresAt: string): string;
    /**
     * Check if a dispatch ID has been seen before (replay prevention).
     */
    isReplay(dispatchId: string): boolean;
    /**
     * Add a trusted key. Supports runtime key rotation.
     */
    addTrustedKey(keyId: string, publicKeyPem: string): void;
    /**
     * Remove a trusted key.
     */
    removeTrustedKey(keyId: string): void;
    /**
     * Get the number of trusted keys.
     */
    get trustedKeyCount(): number;
    private markSeen;
    private cleanReplayCache;
}
//# sourceMappingURL=DispatchVerifier.d.ts.map