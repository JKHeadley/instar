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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────

export interface KeyPair {
  publicKey: Buffer;   // 32 bytes
  privateKey: Buffer;  // 64 bytes (Ed25519) or 32 bytes (X25519)
}

// ── Key Generation ───────────────────────────────────────────────────

/**
 * Generate an Ed25519 identity key pair for an agent.
 * The identity key is long-lived — generated once and persisted.
 */
export function generateIdentityKeyPair(): KeyPair {
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
export function generateEphemeralKeyPair(): KeyPair {
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
export function sign(privateKeyRaw: Buffer, message: Buffer): Buffer {
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
export function verify(publicKeyRaw: Buffer, message: Buffer, signature: Buffer): boolean {
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
export function ecdh(privateKeyRaw: Buffer, publicKeyRaw: Buffer): Buffer {
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
export function deriveRelayToken(sharedSecret: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, info, 32));
}

// ── SAS (Short Authentication String) ────────────────────────────────
//
// Secure A2A Verified Pairing (docs/specs/secure-a2a-verified-pairing.md).
// Both sides of a handshake derive the IDENTICAL 6-word SAS from the shared
// secret; a human compares them out-of-band to defeat relay/MITM substitution.
// The SAS is NEVER transmitted. Only the `sasFingerprint` is ever logged.

/** Pinned BIP-39 English wordlist sha256 (newline-joined) — asserted at load (FD1). */
export const SAS_WORDLIST_SHA256 =
  '187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae';

let _sasWordlist: string[] | null = null;

/**
 * Load + verify the vendored BIP-39 English wordlist (2048 words, 11 bits/word).
 * ONLY a fixed index→word table is used — NONE of BIP-39's mnemonic/checksum/
 * seed/PBKDF2/NFKD semantics apply (FD1). Fails closed on tamper/length/hash.
 */
export function loadSasWordlist(): string[] {
  if (_sasWordlist) return _sasWordlist;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/threadline/ → data lives alongside source; copied into dist at build.
  const candidates = [
    path.join(here, 'data', 'sas-wordlist-en.json'),
    path.join(here, '..', '..', 'src', 'threadline', 'data', 'sas-wordlist-en.json'),
  ];
  let raw: string | null = null;
  for (const c of candidates) {
    try { raw = fs.readFileSync(c, 'utf-8'); break; } catch { /* try next */ }
  }
  if (!raw) throw new Error('SAS wordlist not found (sas-wordlist-en.json)');
  const parsed = JSON.parse(raw) as { words?: unknown };
  const words = parsed.words;
  if (!Array.isArray(words) || words.length !== 2048 || !words.every((w) => typeof w === 'string')) {
    throw new Error('SAS wordlist malformed: expected 2048 string entries');
  }
  const sha = crypto.createHash('sha256').update((words as string[]).join('\n')).digest('hex');
  if (sha !== SAS_WORDLIST_SHA256) {
    throw new Error(`SAS wordlist hash mismatch (got ${sha.slice(0, 16)}…) — refusing (FD1 tamper guard)`);
  }
  _sasWordlist = words as string[];
  return _sasWordlist;
}

/** Order-independent salt: the two identity pubkeys concatenated in byte-sorted order (FD2). */
function sasSalt(identityPubA: Buffer, identityPubB: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(identityPubA, identityPubB) <= 0
    ? [identityPubA, identityPubB]
    : [identityPubB, identityPubA];
  return Buffer.concat([lo, hi]);
}

/**
 * Derive the 12-byte SAS key material (FD2).
 * `sasBits = HKDF-SHA256(ikm=sharedSecret, salt=sort(idPubA‖idPubB), info="threadline-sas-v1", L=12)`.
 */
export function deriveSasBits(sharedSecret: Buffer, identityPubA: Buffer, identityPubB: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, sasSalt(identityPubA, identityPubB), 'threadline-sas-v1', 12),
  );
}

/**
 * Render the 6-word SAS from the SAS bits (FD1/FD2): leading 66 bits, big-endian,
 * split into 6 × 11-bit indices into the wordlist. Both sides produce the identical array.
 */
export function deriveSAS(sharedSecret: Buffer, identityPubA: Buffer, identityPubB: Buffer): string[] {
  const bits = deriveSasBits(sharedSecret, identityPubA, identityPubB);
  const words = loadSasWordlist();
  const out: string[] = [];
  // Big-endian bit reader over the first 9 bytes (72 bits ≥ 66 needed).
  let acc = 0n;
  for (let i = 0; i < 9; i++) acc = (acc << 8n) | BigInt(bits[i]);
  // acc holds 72 bits; we want the leading 66 → drop the low 6 bits.
  acc >>= 6n;
  for (let i = 5; i >= 0; i--) {
    const idx = Number((acc >> BigInt(i * 11)) & 0x7ffn); // 11-bit mask
    out.push(words[idx]);
  }
  return out;
}

/**
 * sasFingerprint (FD3) = first 8 bytes (hex) of SHA-256("threadline-sas-fp-v1" ‖ sasBits).
 * This is the value logged/audited + bound into the receipt; the SAS WORDS are never logged.
 */
export function deriveSasFingerprint(sasBits: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('threadline-sas-fp-v1', 'utf-8'), sasBits]))
    .digest('hex')
    .slice(0, 16); // 8 bytes
}

/**
 * pairingId (FD4) — identifies THIS handshake instance (epoch binding).
 * `HKDF-SHA256(ikm=sharedSecret, salt=sort(idPubA‖idPubB), info="threadline-pairing-id-v1", L=16)` hex.
 */
export function derivePairingId(sharedSecret: Buffer, identityPubA: Buffer, identityPubB: Buffer): string {
  return Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, sasSalt(identityPubA, identityPubB), 'threadline-pairing-id-v1', 16),
  ).toString('hex');
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
export function computeChallengeResponse(
  signingKey: Buffer,
  nonce: string,
  identityPubA: Buffer,
  identityPubB: Buffer,
  ephPubA: Buffer,
  ephPubB: Buffer,
): Buffer {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(nonce, 'utf-8'));
  hash.update(identityPubA);
  hash.update(identityPubB);
  hash.update(ephPubA);
  hash.update(ephPubB);
  const digest = hash.digest();
  return sign(signingKey, digest);
}
