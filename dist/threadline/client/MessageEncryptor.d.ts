/**
 * MessageEncryptor — Client-side E2E encryption for relay messages.
 *
 * Implements XChaCha20-Poly1305 with X25519 key exchange + HKDF-SHA256.
 * Forward secrecy via ephemeral X25519 keys per message.
 *
 * Part of Threadline Relay Phase 1.
 */
import type { MessageEnvelope, AgentFingerprint } from '../relay/types.js';
/** Plaintext message content before encryption */
export interface PlaintextMessage {
    content: string;
    type?: string;
    metadata?: Record<string, unknown>;
}
/**
 * Convert Ed25519 private key to X25519 private key.
 *
 * The Ed25519 private key seed is hashed with SHA-512. The first 32 bytes
 * are clamped per RFC 7748 to produce the X25519 private key scalar.
 */
export declare function edPrivateToX25519(edPrivateKey: Buffer): Buffer;
/**
 * Derive X25519 public key from Ed25519 private key.
 *
 * Since we can't do the birational map Ed25519→X25519 on public keys alone
 * in node:crypto, we derive the X25519 keypair from the Ed25519 seed.
 * Both sides need to share their X25519 public key alongside Ed25519.
 */
export declare function deriveX25519PublicKey(edPrivateKey: Buffer): Buffer;
/**
 * Compute agent fingerprint from Ed25519 public key.
 * First 16 bytes of the public key, hex-encoded (32 characters).
 */
export declare function computeFingerprint(publicKey: Buffer): AgentFingerprint;
export declare class MessageEncryptor {
    private readonly edPrivateKey;
    private readonly edPublicKey;
    private readonly x25519Private;
    /** X25519 public key — must be shared with peers for E2E encryption */
    readonly x25519Public: Buffer;
    readonly fingerprint: AgentFingerprint;
    constructor(edPrivateKey: Buffer, edPublicKey: Buffer);
    /**
     * Encrypt a message for a specific recipient.
     *
     * @param recipientEdPubKey - Recipient's Ed25519 public key (for fingerprint/signing)
     * @param recipientX25519PubKey - Recipient's X25519 public key (for encryption)
     * @param threadId - Thread identifier
     * @param message - Plaintext message
     */
    encrypt(recipientEdPubKey: Buffer, recipientX25519PubKey: Buffer, threadId: string, message: PlaintextMessage): MessageEnvelope;
    /**
     * Decrypt a message envelope.
     * Verifies signature and decrypts content.
     *
     * @param envelope - The encrypted message envelope
     * @param senderEdPubKey - Sender's Ed25519 public key (for signature verification)
     * @param senderX25519PubKey - Sender's X25519 public key (for key agreement)
     */
    decrypt(envelope: MessageEnvelope, senderEdPubKey: Buffer, senderX25519PubKey: Buffer): PlaintextMessage;
}
//# sourceMappingURL=MessageEncryptor.d.ts.map