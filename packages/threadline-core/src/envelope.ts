/**
 * End-to-end encrypted, signed Threadline message envelopes.
 *
 * Byte-compatible with Instar's `MessageEncryptor` (spec threadline-standalone-pairing D2): X25519
 * (ephemeral-static and static-static) → HKDF-SHA256 ('threadline-relay-v1', random 32-byte salt)
 * → XChaCha20-Poly1305 with the canonical envelope (payload '') as AAD → Ed25519 signature over
 * the canonical envelope. Canonical = keys sorted, `signature` excluded, JSON with no spaces.
 * Compatibility is checked against vectors produced by Instar itself (test/fixtures).
 */

import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { isX25519BoundToIdentity,
  computeFingerprint, deriveX25519PublicKey, ecdh, edPrivateToX25519, generateEphemeralKeyPair, sign, verify,
} from './crypto.js';

const HKDF_INFO = 'threadline-relay-v1';

export interface MessageEnvelope {
  from: string;
  to: string;
  threadId: string;
  messageId: string;
  timestamp: string;
  nonce: string;
  ephemeralPubKey: string;
  salt: string;
  payload: string;
  signature: string;
}

/** What travels inside the encrypted payload. */
export interface PlaintextMessage {
  content: string;
  type?: string;
  metadata?: Record<string, unknown>;
  resend?: boolean;
}

function secureEcdh(privateKey: Buffer, publicKey: Buffer): Buffer {
  const shared = ecdh(privateKey, publicKey);
  if (shared.every((b) => b === 0)) throw new Error('X25519 produced an all-zero shared secret (low-order point)');
  return shared;
}

function deriveKey(ikm: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, HKDF_INFO, 32));
}

/** Sorted keys, `signature` excluded, compact JSON. */
export function canonicalizeEnvelope(envelope: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(envelope).sort()) {
    if (key === 'signature') continue;
    sorted[key] = envelope[key];
  }
  return JSON.stringify(sorted);
}

export class EnvelopeCrypto {
  private readonly x25519Private: Buffer;
  readonly x25519Public: Buffer;
  readonly fingerprint: string;

  constructor(private readonly edPrivateKey: Buffer, edPublicKey: Buffer) {
    this.x25519Private = edPrivateToX25519(edPrivateKey);
    this.x25519Public = deriveX25519PublicKey(edPrivateKey);
    this.fingerprint = computeFingerprint(edPublicKey);
  }

  /**
   * Encrypt and sign `message` for a recipient. `recipientX25519PubKey` should come from the
   * recipient's PINNED identity key (`edPublicToX25519`) whenever one is pinned.
   */
  encrypt(recipientEdPubKey: Buffer, recipientX25519PubKey: Buffer, threadId: string, message: PlaintextMessage, messageId?: string): MessageEnvelope {
    const ephemeral = generateEphemeralKeyPair();
    const es = secureEcdh(ephemeral.privateKey, recipientX25519PubKey);
    const ss = secureEcdh(this.x25519Private, recipientX25519PubKey);
    const salt = crypto.randomBytes(32);
    const key = deriveKey(Buffer.concat([es, ss]), salt);
    ephemeral.privateKey.fill(0);

    const nonce = crypto.randomBytes(24);
    const base = {
      from: this.fingerprint,
      to: computeFingerprint(recipientEdPubKey),
      threadId,
      messageId: messageId || crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      nonce: nonce.toString('base64'),
      ephemeralPubKey: ephemeral.publicKey.toString('base64'),
      salt: salt.toString('base64'),
    };
    const aad = Buffer.from(canonicalizeEnvelope({ ...base, payload: '' }), 'utf-8');
    const ciphertext = xchacha20poly1305(new Uint8Array(key), nonce, aad).encrypt(new Uint8Array(Buffer.from(JSON.stringify(message), 'utf-8')));
    const envelope = { ...base, payload: Buffer.from(ciphertext).toString('base64') };
    const signature = sign(this.edPrivateKey, Buffer.from(canonicalizeEnvelope(envelope), 'utf-8'));
    return { ...envelope, signature: signature.toString('base64') };
  }

  /**
   * Verify the sender's signature, then decrypt. Throws on any failure (never returns plaintext
   * unverified). It does NOT check that `to` is you, the envelope's age, or replay: the caller owns those.
   */
  decrypt(envelope: MessageEnvelope, senderEdPubKey: Buffer, senderX25519PubKey: Buffer): PlaintextMessage {
    // The static key must belong to the identity that signed; a caller cannot pair one sender's
    // signature with another key's secret.
    if (!isX25519BoundToIdentity(senderEdPubKey, senderX25519PubKey)) throw new Error('X25519 key is not bound to the sender identity');
    const { signature, ...withoutSig } = envelope;
    if (!verify(senderEdPubKey, Buffer.from(canonicalizeEnvelope(withoutSig), 'utf-8'), Buffer.from(signature, 'base64'))) {
      throw new Error('Invalid message signature');
    }
    const es = secureEcdh(this.x25519Private, Buffer.from(envelope.ephemeralPubKey, 'base64'));
    const ss = secureEcdh(this.x25519Private, senderX25519PubKey);
    const key = deriveKey(Buffer.concat([es, ss]), Buffer.from(envelope.salt, 'base64'));
    const aad = Buffer.from(canonicalizeEnvelope({ ...withoutSig, payload: '' }), 'utf-8');
    const plaintext = xchacha20poly1305(new Uint8Array(key), new Uint8Array(Buffer.from(envelope.nonce, 'base64')), aad)
      .decrypt(new Uint8Array(Buffer.from(envelope.payload, 'base64')));
    return JSON.parse(Buffer.from(plaintext).toString('utf-8')) as PlaintextMessage;
  }
}
