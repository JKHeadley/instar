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
import crypto from 'node:crypto';
// ── Key Generation ───────────────────────────────────────────────────
/**
 * Generate an Ed25519 identity key pair for an agent.
 * The identity key is long-lived — generated once and persisted.
 */
export function generateIdentityKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    };
}
/**
 * Generate an ephemeral X25519 key pair for Diffie-Hellman exchange.
 * Ephemeral keys are single-use per handshake.
 */
export function generateEphemeralKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    };
}
// ── Signing & Verification ───────────────────────────────────────────
/**
 * Ed25519 sign a message.
 * Returns a 64-byte signature.
 */
export function sign(privateKeyRaw, message) {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([
            // Ed25519 PKCS#8 prefix (16 bytes) + 2 bytes (octet string tag + length)
            Buffer.from('302e020100300506032b657004220420', 'hex'),
            privateKeyRaw,
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    return Buffer.from(crypto.sign(null, message, privateKey));
}
/**
 * Ed25519 verify a signature.
 */
export function verify(publicKeyRaw, message, signature) {
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([
            // Ed25519 SPKI prefix (12 bytes)
            Buffer.from('302a300506032b6570032100', 'hex'),
            publicKeyRaw,
        ]),
        format: 'der',
        type: 'spki',
    });
    return crypto.verify(null, message, publicKey, signature);
}
// ── Key Exchange ─────────────────────────────────────────────────────
/**
 * X25519 Diffie-Hellman key exchange.
 * Returns a 32-byte shared secret.
 */
export function ecdh(privateKeyRaw, publicKeyRaw) {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([
            // X25519 PKCS#8 prefix
            Buffer.from('302e020100300506032b656e04220420', 'hex'),
            privateKeyRaw,
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey({
        key: Buffer.concat([
            // X25519 SPKI prefix
            Buffer.from('302a300506032b656e032100', 'hex'),
            publicKeyRaw,
        ]),
        format: 'der',
        type: 'spki',
    });
    return Buffer.from(crypto.diffieHellman({
        privateKey,
        publicKey,
    }));
}
// ── Key Derivation ───────────────────────────────────────────────────
/**
 * HKDF-SHA256 key derivation for relay tokens.
 * Returns a 32-byte derived key.
 */
export function deriveRelayToken(sharedSecret, salt, info) {
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}
// ── Challenge Response ───────────────────────────────────────────────
/**
 * Compute a challenge response for the handshake.
 *
 * Signs: SHA256(nonce || identity_pub_A || identity_pub_B || eph_pub_A || eph_pub_B)
 *
 * This binds the challenge to both identities and both ephemeral keys,
 * preventing relay and mismatch attacks.
 */
export function computeChallengeResponse(signingKey, nonce, identityPubA, identityPubB, ephPubA, ephPubB) {
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(nonce, 'utf-8'));
    hash.update(identityPubA);
    hash.update(identityPubB);
    hash.update(ephPubA);
    hash.update(ephPubB);
    const digest = hash.digest();
    return sign(signingKey, digest);
}
//# sourceMappingURL=ThreadlineCrypto.js.map