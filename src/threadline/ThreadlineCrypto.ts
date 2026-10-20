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

// ── From threadline-core ─────────────────────────────────────────────
//
// Key generation, Ed25519 signing, X25519 key exchange and the Ed25519→X25519 public-key map are
// the same code in `@sagemindai/threadline-core` (spec threadline-standalone-pairing D1, rollout
// step 3), so they come from there, as does the v2 pairing id (core's `derivePairingId`, the same
// length check, key order and HKDF info). `verify` stays here: core's returns false on a malformed
// key where Instar's throws, so it is not the same behaviour.

import {
  generateIdentityKeyPair, generateEphemeralKeyPair, sign, ecdh, edPublicToX25519, isX25519BoundToIdentity,
  derivePairingId as coreDerivePairingIdV2,
} from '@sagemindai/threadline-core';
export { generateIdentityKeyPair, generateEphemeralKeyPair, sign, ecdh, edPublicToX25519, isX25519BoundToIdentity };

// ── Signing & Verification ───────────────────────────────────────────

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
  return coreDerivePairingIdV2(identityPubA, identityPubB);
}

// ── Ed25519 public key → X25519 public key (RFC 7748 birational map) ──
//
// Our X25519 private key is the clamped first half of SHA-512(Ed25519 seed)
// (MessageEncryptor.edPrivateToX25519), the standard conversion, so the X25519 public key
// is a fixed function of the Ed25519 public key: u = (1 + y) / (1 - y) mod p. A receiver
// can therefore compute a peer's encryption key from the PINNED identity key instead of
// trusting whatever X25519 key the relay handed over (issue #2117 gap I).
// `edPublicToX25519` and `isX25519BoundToIdentity` are imported from threadline-core above.

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
