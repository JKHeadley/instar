/**
 * MessageEncryptor — Client-side E2E encryption for relay messages.
 *
 * Implements XChaCha20-Poly1305 with X25519 key exchange + HKDF-SHA256.
 * Forward secrecy via ephemeral X25519 keys per message.
 *
 * Part of Threadline Relay Phase 1.
 */
import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { generateEphemeralKeyPair, ecdh, sign, verify, } from '../ThreadlineCrypto.js';
/** HKDF info string for relay message encryption */
const HKDF_INFO = 'threadline-relay-v1';
/**
 * Convert Ed25519 private key to X25519 private key.
 *
 * The Ed25519 private key seed is hashed with SHA-512. The first 32 bytes
 * are clamped per RFC 7748 to produce the X25519 private key scalar.
 */
export function edPrivateToX25519(edPrivateKey) {
    const hash = crypto.createHash('sha512').update(edPrivateKey).digest();
    const scalar = Buffer.from(hash.subarray(0, 32));
    // Clamp per RFC 7748
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;
    return scalar;
}
/**
 * Derive X25519 public key from Ed25519 private key.
 *
 * Since we can't do the birational map Ed25519→X25519 on public keys alone
 * in node:crypto, we derive the X25519 keypair from the Ed25519 seed.
 * Both sides need to share their X25519 public key alongside Ed25519.
 */
export function deriveX25519PublicKey(edPrivateKey) {
    const x25519Private = edPrivateToX25519(edPrivateKey);
    const privateKeyObj = crypto.createPrivateKey({
        key: Buffer.concat([
            Buffer.from('302e020100300506032b656e04220420', 'hex'),
            x25519Private,
        ]),
        format: 'der',
        type: 'pkcs8',
    });
    const publicKeyDer = crypto.createPublicKey(privateKeyObj)
        .export({ type: 'spki', format: 'der' });
    return Buffer.from(publicKeyDer.subarray(-32));
}
/**
 * Compute agent fingerprint from Ed25519 public key.
 * First 16 bytes of the public key, hex-encoded (32 characters).
 */
export function computeFingerprint(publicKey) {
    return publicKey.subarray(0, 16).toString('hex');
}
/**
 * Perform X25519 key exchange between a private key and a public key.
 * Validates that the shared secret is not all zeros (low-order point attack).
 */
function secureEcdh(privateKey, publicKey) {
    const shared = ecdh(privateKey, publicKey);
    // Validate: reject all-zero shared secrets
    if (shared.every(b => b === 0)) {
        throw new Error('X25519 produced all-zero shared secret (low-order point attack)');
    }
    return shared;
}
/**
 * Derive encryption key using HKDF-SHA256.
 */
function deriveKey(ikm, salt) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, HKDF_INFO, 32));
}
/**
 * Canonicalize envelope fields for signing.
 * Sorted alphabetically, no whitespace, signature field excluded.
 */
function canonicalizeEnvelope(envelope) {
    const sorted = {};
    for (const key of Object.keys(envelope).sort()) {
        if (key === 'signature')
            continue;
        sorted[key] = envelope[key];
    }
    return JSON.stringify(sorted);
}
export class MessageEncryptor {
    edPrivateKey;
    edPublicKey;
    x25519Private;
    /** X25519 public key — must be shared with peers for E2E encryption */
    x25519Public;
    fingerprint;
    constructor(edPrivateKey, edPublicKey) {
        this.edPrivateKey = edPrivateKey;
        this.edPublicKey = edPublicKey;
        this.x25519Private = edPrivateToX25519(edPrivateKey);
        this.x25519Public = deriveX25519PublicKey(edPrivateKey);
        this.fingerprint = computeFingerprint(edPublicKey);
    }
    /**
     * Encrypt a message for a specific recipient.
     *
     * @param recipientEdPubKey - Recipient's Ed25519 public key (for fingerprint/signing)
     * @param recipientX25519PubKey - Recipient's X25519 public key (for encryption)
     * @param threadId - Thread identifier
     * @param message - Plaintext message
     */
    encrypt(recipientEdPubKey, recipientX25519PubKey, threadId, message) {
        // 1. Generate ephemeral X25519 keypair for forward secrecy
        const ephemeral = generateEphemeralKeyPair();
        // 2. Key agreement
        // ES: ephemeral sender private × static recipient X25519 public
        const es = secureEcdh(ephemeral.privateKey, recipientX25519PubKey);
        // SS: static sender X25519 private × static recipient X25519 public
        const ss = secureEcdh(this.x25519Private, recipientX25519PubKey);
        // 3. Combine shared secrets and derive encryption key
        const salt = crypto.randomBytes(32);
        const ikm = Buffer.concat([es, ss]);
        const encryptionKey = deriveKey(ikm, salt);
        // 4. Securely erase ephemeral private key
        ephemeral.privateKey.fill(0);
        // 5. Encrypt with XChaCha20-Poly1305
        const plaintext = Buffer.from(JSON.stringify(message), 'utf-8');
        const nonce = crypto.randomBytes(24); // 192-bit nonce
        const messageId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        // Build envelope fields for AAD
        const envelopeBase = {
            from: this.fingerprint,
            to: computeFingerprint(recipientEdPubKey),
            threadId,
            messageId,
            timestamp,
            nonce: Buffer.from(nonce).toString('base64'),
            ephemeralPubKey: ephemeral.publicKey.toString('base64'),
            salt: salt.toString('base64'),
        };
        const aad = Buffer.from(canonicalizeEnvelope({ ...envelopeBase, payload: '' }), 'utf-8');
        const cipher = xchacha20poly1305(new Uint8Array(encryptionKey), nonce, aad);
        const ciphertext = cipher.encrypt(new Uint8Array(plaintext));
        // 6. Build full envelope
        const envelope = {
            ...envelopeBase,
            payload: Buffer.from(ciphertext).toString('base64'),
        };
        // 7. Sign the canonical envelope
        const canonical = canonicalizeEnvelope(envelope);
        const signature = sign(this.edPrivateKey, Buffer.from(canonical, 'utf-8'));
        return {
            ...envelope,
            signature: signature.toString('base64'),
        };
    }
    /**
     * Decrypt a message envelope.
     * Verifies signature and decrypts content.
     *
     * @param envelope - The encrypted message envelope
     * @param senderEdPubKey - Sender's Ed25519 public key (for signature verification)
     * @param senderX25519PubKey - Sender's X25519 public key (for key agreement)
     */
    decrypt(envelope, senderEdPubKey, senderX25519PubKey) {
        // 1. Verify signature
        const { signature: sig, ...withoutSig } = envelope;
        const canonical = canonicalizeEnvelope(withoutSig);
        const sigBuf = Buffer.from(sig, 'base64');
        const valid = verify(senderEdPubKey, Buffer.from(canonical, 'utf-8'), sigBuf);
        if (!valid) {
            throw new Error('Invalid message signature');
        }
        // 2. Decode ephemeral public key
        const ephemeralPub = Buffer.from(envelope.ephemeralPubKey, 'base64');
        const salt = Buffer.from(envelope.salt, 'base64');
        // 3. Key agreement (mirror of encryption)
        // ES: static recipient X25519 private × ephemeral sender public
        const es = secureEcdh(this.x25519Private, ephemeralPub);
        // SS: static recipient X25519 private × static sender X25519 public
        const ss = secureEcdh(this.x25519Private, senderX25519PubKey);
        // 4. Derive encryption key
        const ikm = Buffer.concat([es, ss]);
        const encryptionKey = deriveKey(ikm, salt);
        // 5. Decrypt
        const nonce = Buffer.from(envelope.nonce, 'base64');
        const ciphertext = Buffer.from(envelope.payload, 'base64');
        // Recreate AAD
        const envelopeForAAD = { ...withoutSig, payload: '' };
        const aad = Buffer.from(canonicalizeEnvelope(envelopeForAAD), 'utf-8');
        const decipher = xchacha20poly1305(new Uint8Array(encryptionKey), new Uint8Array(nonce), aad);
        const plaintext = decipher.decrypt(new Uint8Array(ciphertext));
        return JSON.parse(Buffer.from(plaintext).toString('utf-8'));
    }
}
//# sourceMappingURL=MessageEncryptor.js.map