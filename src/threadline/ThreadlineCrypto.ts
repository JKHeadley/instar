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

// ── Verified pairing v2: static identity-key SAS (spec §3.1 / FD2 / FD4, amended 2026-10-10) ──
//
// v1 derived the SAS from a per-handshake ephemeral shared secret, but no live path ever
// ran that handshake between relay agents (issue #2117 gap G). v2 derives the words from
// the two Ed25519 IDENTITY keys alone, so both sides compute them independently with no
// round trip. The words are therefore PUBLIC values: anyone who knows both keys can
// compute them. Security rests on the human comparison (§3.9) and on the LENGTH of the
// compared value: a relay substituting keys controls both substitutes and can search
// offline for a pair whose words collide, which costs about 2^(bits/2) key generations.
// 6 words (66 bits) → ~2^33, hours of compute. 12 words (132 bits) → ~2^66, out of reach.

const SAS_V2_WORDS = 12;

/** Sorted raw 32-byte keys concatenated — the order-independent pair identity (FD2 v2). */
function sortedPair(identityPubA: Buffer, identityPubB: Buffer): Buffer {
  if (identityPubA.length !== 32 || identityPubB.length !== 32) {
    throw new Error('identity public keys must be 32 raw bytes');
  }
  return sasSalt(identityPubA, identityPubB);
}

/** 17 bytes (136 bits ≥ 132) of v2 SAS material: HKDF-SHA256(ikm = sorted keys, info = "threadline-sas-v2"). */
export function deriveSasBitsV2(identityPubA: Buffer, identityPubB: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', sortedPair(identityPubA, identityPubB), Buffer.alloc(0), 'threadline-sas-v2', 17),
  );
}

/** The 12-word v2 SAS: the leading 132 bits, big-endian, as 12 × 11-bit wordlist indices. */
export function deriveSASv2(identityPubA: Buffer, identityPubB: Buffer): string[] {
  const bits = deriveSasBitsV2(identityPubA, identityPubB);
  const words = loadSasWordlist();
  let acc = 0n;
  for (let i = 0; i < 17; i++) acc = (acc << 8n) | BigInt(bits[i]);
  acc >>= 4n; // 136 bits → keep the leading 132
  const out: string[] = [];
  for (let i = SAS_V2_WORDS - 1; i >= 0; i--) {
    out.push(words[Number((acc >> BigInt(i * 11)) & 0x7ffn)]);
  }
  return out;
}

/** v2 sasFingerprint = first 8 bytes (hex) of SHA-256("threadline-sas-fp-v2" ‖ sasBits). */
export function deriveSasFingerprintV2(sasBitsV2: Buffer): string {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('threadline-sas-fp-v2', 'utf-8'), sasBitsV2]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * v2 pairingId: identifies the KEY PAIR, not a handshake. It changes exactly when either
 * identity key rotates, which is when a pairing must reset to pending (FD4 v2).
 */
export function derivePairingIdV2(identityPubA: Buffer, identityPubB: Buffer): string {
  return Buffer.from(
    crypto.hkdfSync('sha256', sortedPair(identityPubA, identityPubB), Buffer.alloc(0), 'threadline-pairing-id-v2', 16),
  ).toString('hex');
}

// ── Ed25519 public key → X25519 public key (RFC 7748 birational map) ──
//
// Our X25519 private key is the clamped first half of SHA-512(Ed25519 seed)
// (MessageEncryptor.edPrivateToX25519), the standard conversion, so the X25519 public key
// is a fixed function of the Ed25519 public key: u = (1 + y) / (1 - y) mod p. A receiver
// can therefore compute a peer's encryption key from the PINNED identity key instead of
// trusting whatever X25519 key the relay handed over (issue #2117 gap I).

const P25519 = (1n << 255n) - 19n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Convert a raw 32-byte Ed25519 public key to its raw 32-byte X25519 public key. Throws on an invalid encoding. */
export function edPublicToX25519(edPublicKey: Buffer): Buffer {
  if (edPublicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  // y is the little-endian integer with the sign bit (top bit of the last byte) cleared.
  const le = Buffer.from(edPublicKey);
  le[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(le[i]);
  if (y >= P25519) throw new Error('Ed25519 public key y coordinate out of range');
  const denom = (1n - y + P25519) % P25519;
  if (denom === 0n) throw new Error('Ed25519 public key maps to the point at infinity');
  const u = ((1n + y) * modPow(denom, P25519 - 2n, P25519)) % P25519;
  const out = Buffer.alloc(32);
  let v = u;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** True iff `x25519PublicKey` is exactly the key derived from `edPublicKey` (never throws). */
export function isX25519BoundToIdentity(edPublicKey: Buffer, x25519PublicKey: Buffer): boolean {
  try {
    const derived = edPublicToX25519(edPublicKey);
    return x25519PublicKey.length === 32 && crypto.timingSafeEqual(derived, x25519PublicKey);
  } catch {
    return false;
  }
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
