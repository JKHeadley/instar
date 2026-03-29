/**
 * ThreadlineCrypto — Cryptographic utilities for the Threadline handshake.
 *
 * Implements Ed25519 identity keys, X25519 ephemeral key exchange,
 * HKDF-SHA256 relay token derivation, and challenge-response signing.
 *
 * All operations use Node.js native `node:crypto` — no external libraries.
 *
 * Part of Threadline Protocol Phase 3.
 */
export interface KeyPair {
    publicKey: Buffer;
    privateKey: Buffer;
}
/**
 * Generate an Ed25519 identity key pair for an agent.
 * The identity key is long-lived — generated once and persisted.
 */
export declare function generateIdentityKeyPair(): KeyPair;
/**
 * Generate an ephemeral X25519 key pair for Diffie-Hellman exchange.
 * Ephemeral keys are single-use per handshake.
 */
export declare function generateEphemeralKeyPair(): KeyPair;
/**
 * Ed25519 sign a message.
 * Returns a 64-byte signature.
 */
export declare function sign(privateKeyRaw: Buffer, message: Buffer): Buffer;
/**
 * Ed25519 verify a signature.
 */
export declare function verify(publicKeyRaw: Buffer, message: Buffer, signature: Buffer): boolean;
/**
 * X25519 Diffie-Hellman key exchange.
 * Returns a 32-byte shared secret.
 */
export declare function ecdh(privateKeyRaw: Buffer, publicKeyRaw: Buffer): Buffer;
/**
 * HKDF-SHA256 key derivation for relay tokens.
 * Returns a 32-byte derived key.
 */
export declare function deriveRelayToken(sharedSecret: Buffer, salt: Buffer, info: string): Buffer;
/**
 * Compute a challenge response for the handshake.
 *
 * Signs: SHA256(nonce || identity_pub_A || identity_pub_B || eph_pub_A || eph_pub_B)
 *
 * This binds the challenge to both identities and both ephemeral keys,
 * preventing relay and mismatch attacks.
 */
export declare function computeChallengeResponse(signingKey: Buffer, nonce: string, identityPubA: Buffer, identityPubB: Buffer, ephPubA: Buffer, ephPubB: Buffer): Buffer;
//# sourceMappingURL=ThreadlineCrypto.d.ts.map