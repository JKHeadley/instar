/**
 * Pairing protocol for multi-machine coordination.
 *
 * Handles the secure pairing flow:
 * 1. Pairing code generation (WORD-WORD-NNNN)
 * 2. Key exchange (ephemeral X25519 ECDH, code-bound via HKDF)
 * 3. Short Authentication String (SAS) derivation
 * 4. Encrypted secret transfer (XChaCha20-Poly1305)
 *
 * Security properties:
 * - Online brute-force: 3-attempt rate limit + 2-minute expiry
 * - MITM: SAS verification (24-bit, 6 symbols)
 * - Forward secrecy: ephemeral keys per pairing session
 * - Offline brute-force: rate limiting + SAS prevents practical exploitation
 *   (SPAKE2 can be substituted via PairingKeyExchange interface for paranoid mode)
 *
 * Phase 2 of the multi-machine spec.
 */
import crypto from 'node:crypto';
/**
 * Generate a pairing code: WORD-WORD-NNNN
 * ~29.3 bits of entropy (256 * 256 * 10000 = 655,360,000 combinations).
 */
export declare function generatePairingCode(): string;
/**
 * Constant-time comparison of pairing codes.
 * Prevents timing side-channel attacks.
 */
export declare function comparePairingCodes(a: string, b: string): boolean;
/**
 * Derive a Short Authentication String from a shared key and both public keys.
 *
 * SAS = first 24 bits of SHA-256(sharedKey || sort(pubKeyA, pubKeyB))
 * Mapped to 6 symbols from a set of 16 (4 bits each).
 *
 * @param sharedKey - The ECDH shared secret or SPAKE2 session key
 * @param publicKeyA - Public key of machine A (base64 or PEM)
 * @param publicKeyB - Public key of machine B (base64 or PEM)
 */
export declare function deriveSAS(sharedKey: Buffer, publicKeyA: string, publicKeyB: string): {
    symbols: Array<{
        word: string;
        emoji: string;
    }>;
    display: string;
};
export interface EphemeralKeyPair {
    publicKey: Buffer;
    privateKey: crypto.KeyObject;
}
/**
 * Generate an ephemeral X25519 key pair for a single pairing session.
 */
export declare function generateEphemeralKeyPair(): EphemeralKeyPair;
/**
 * Perform X25519 ECDH key agreement, then derive a session key using HKDF
 * bound to the pairing code. This ensures the session key is tied to both
 * the ECDH exchange AND the pairing code.
 *
 * @param myPrivateKey - This machine's ephemeral private key
 * @param theirPublicKeyDer - The other machine's ephemeral public key (DER format)
 * @param pairingCode - The shared pairing code (used as HKDF salt)
 * @param info - HKDF info string (identifies the purpose)
 */
export declare function deriveSessionKey(myPrivateKey: crypto.KeyObject, theirPublicKeyDer: Buffer, pairingCode: string, info?: string): Buffer;
/**
 * Encrypt data with XChaCha20-Poly1305 (or chacha20-poly1305 with 12-byte nonce).
 * Node.js doesn't natively support XChaCha20, so we use chacha20-poly1305.
 *
 * @param plaintext - Data to encrypt
 * @param key - 32-byte encryption key
 * @param aad - Additional authenticated data (optional)
 * @returns { nonce, ciphertext, tag } all as Buffers
 */
export declare function encrypt(plaintext: Buffer, key: Buffer, aad?: Buffer): {
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
};
/**
 * Decrypt data with ChaCha20-Poly1305.
 *
 * @param ciphertext - Encrypted data
 * @param key - 32-byte decryption key
 * @param nonce - 12-byte nonce
 * @param tag - 16-byte authentication tag
 * @param aad - Additional authenticated data (must match encryption)
 * @returns Decrypted plaintext
 * @throws If authentication fails (tampered data or wrong key)
 */
export declare function decrypt(ciphertext: Buffer, key: Buffer, nonce: Buffer, tag: Buffer, aad?: Buffer): Buffer;
export interface PairingSession {
    /** The pairing code */
    code: string;
    /** When the session was created */
    createdAt: number;
    /** Number of failed attempts */
    failedAttempts: number;
    /** Maximum allowed attempts before invalidation */
    maxAttempts: number;
    /** Session expiry in milliseconds */
    expiryMs: number;
    /** Ephemeral key pair for this session */
    ephemeralKeys: EphemeralKeyPair;
    /** Whether the code has been consumed (single-use) */
    consumed: boolean;
}
/**
 * Create a new pairing session.
 */
export declare function createPairingSession(options?: {
    code?: string;
    maxAttempts?: number;
    expiryMs?: number;
}): PairingSession;
/**
 * Check if a pairing session is still valid.
 */
export declare function isPairingSessionValid(session: PairingSession): boolean;
/**
 * Validate a pairing code against a session.
 * Returns true if the code matches and the session is valid.
 * Increments failedAttempts on mismatch.
 */
export declare function validatePairingCode(session: PairingSession, code: string): {
    valid: boolean;
    reason?: string;
};
//# sourceMappingURL=PairingProtocol.d.ts.map