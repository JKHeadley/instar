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
import crypto from 'node:crypto';
export class DispatchVerifier {
    trustedKeys;
    replayCacheTtlMs;
    required;
    seenIds = new Map(); // dispatchId → timestamp seen
    constructor(config) {
        this.trustedKeys = config.trustedKeys;
        this.replayCacheTtlMs = config.replayCacheTtlMs ?? 24 * 60 * 60 * 1000;
        this.required = config.required ?? false;
    }
    /**
     * Verify a dispatch's origin and integrity.
     */
    verify(dispatch) {
        const signed = dispatch;
        // Check if dispatch has signature fields
        if (!signed.signature || !signed.signedAt || !signed.expiresAt || !signed.keyId) {
            if (this.required) {
                return { verified: false, reason: 'Dispatch is unsigned and verification is required' };
            }
            // Unsigned dispatches pass when verification is not required (gradual rollout)
            return { verified: true, reason: 'Unsigned dispatch accepted (verification not required)' };
        }
        // Check replay
        if (this.isReplay(dispatch.dispatchId)) {
            return { verified: false, reason: `Replay detected: dispatch ${dispatch.dispatchId} already seen` };
        }
        // Check expiry
        const now = new Date();
        const expiresAt = new Date(signed.expiresAt);
        if (isNaN(expiresAt.getTime()) || now > expiresAt) {
            return { verified: false, reason: `Dispatch expired at ${signed.expiresAt}` };
        }
        // Look up the signing key
        const publicKeyPem = this.trustedKeys[signed.keyId];
        if (!publicKeyPem) {
            return { verified: false, reason: `Unknown signing key ID: ${signed.keyId}` };
        }
        // Build canonical payload
        const canonicalPayload = this.buildCanonicalPayload(dispatch, signed.signedAt, signed.expiresAt);
        // Verify Ed25519 signature
        try {
            const isValid = crypto.verify(null, Buffer.from(canonicalPayload), publicKeyPem, Buffer.from(signed.signature, 'base64'));
            if (!isValid) {
                return { verified: false, reason: 'Invalid signature' };
            }
        }
        catch (err) {
            return { verified: false, reason: `Signature verification error: ${err instanceof Error ? err.message : String(err)}` };
        }
        // Mark as seen (replay prevention)
        this.markSeen(dispatch.dispatchId);
        return { verified: true, reason: 'Signature verified' };
    }
    /**
     * Build the canonical signing payload for a dispatch.
     * Keys sorted alphabetically for deterministic serialization.
     */
    buildCanonicalPayload(dispatch, signedAt, expiresAt) {
        const payload = {
            content: dispatch.content,
            dispatchId: dispatch.dispatchId,
            expiresAt,
            priority: dispatch.priority,
            signedAt,
            title: dispatch.title,
            type: dispatch.type,
        };
        return JSON.stringify(payload);
    }
    /**
     * Check if a dispatch ID has been seen before (replay prevention).
     */
    isReplay(dispatchId) {
        this.cleanReplayCache();
        return this.seenIds.has(dispatchId);
    }
    /**
     * Add a trusted key. Supports runtime key rotation.
     */
    addTrustedKey(keyId, publicKeyPem) {
        this.trustedKeys[keyId] = publicKeyPem;
    }
    /**
     * Remove a trusted key.
     */
    removeTrustedKey(keyId) {
        delete this.trustedKeys[keyId];
    }
    /**
     * Get the number of trusted keys.
     */
    get trustedKeyCount() {
        return Object.keys(this.trustedKeys).length;
    }
    // ── Private ───────────────────────────────────────────────────────
    markSeen(dispatchId) {
        this.seenIds.set(dispatchId, Date.now());
    }
    cleanReplayCache() {
        const cutoff = Date.now() - this.replayCacheTtlMs;
        for (const [id, timestamp] of this.seenIds) {
            if (timestamp < cutoff) {
                this.seenIds.delete(id);
            }
        }
    }
}
//# sourceMappingURL=DispatchVerifier.js.map