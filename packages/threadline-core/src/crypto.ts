/**
 * Threadline identity and key primitives, framework-free.
 *
 * Ported from Instar's `src/threadline/ThreadlineCrypto.ts` and `client/MessageEncryptor.ts`
 * with the SAME algorithms, encodings and labels, so keys, fingerprints, pairing ids and
 * X25519 derivations agree byte for byte with Instar (spec threadline-standalone-pairing D1, D2).
 * Node's built-in crypto only.
 */

import crypto from 'node:crypto';

export interface KeyPair {
  /** 32 raw bytes. */
  publicKey: Buffer;
  /** 32 raw bytes (the Ed25519 seed, or the X25519 scalar). */
  privateKey: Buffer;
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** A long-lived Ed25519 identity key pair (raw 32-byte halves). */
export function generateIdentityKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
  };
}

/** A single-use X25519 key pair (raw 32-byte halves). */
export function generateEphemeralKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
  };
}

/** The Ed25519 public key for a raw 32-byte seed. */
export function publicKeyFromSeed(seed: Buffer): Buffer {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32));
}

/** Ed25519 signature (64 bytes) over `message`. */
export function sign(privateKeyRaw: Buffer, message: Buffer): Buffer {
  const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKeyRaw]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.sign(null, message, key));
}

/** Ed25519 verification. Never throws: a malformed key or signature is `false`. */
export function verify(publicKeyRaw: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Raw X25519 Diffie-Hellman (32-byte shared secret). */
export function ecdh(privateKeyRaw: Buffer, publicKeyRaw: Buffer): Buffer {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKeyRaw]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, publicKeyRaw]), format: 'der', type: 'spki' });
  return Buffer.from(crypto.diffieHellman({ privateKey, publicKey }));
}

/** An agent's routing fingerprint: the first 16 bytes of its identity key, hex (32 chars). */
export function computeFingerprint(identityPublicKey: Buffer): string {
  return identityPublicKey.subarray(0, 16).toString('hex');
}

/** X25519 private scalar from an Ed25519 seed: clamped first half of SHA-512(seed) (RFC 7748). */
export function edPrivateToX25519(edPrivateKey: Buffer): Buffer {
  const hash = crypto.createHash('sha512').update(edPrivateKey).digest();
  const scalar = Buffer.from(hash.subarray(0, 32));
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

/** The X25519 public key that goes with an Ed25519 seed. */
export function deriveX25519PublicKey(edPrivateKey: Buffer): Buffer {
  const key = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, edPrivateToX25519(edPrivateKey)]), format: 'der', type: 'pkcs8' });
  return Buffer.from(crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32));
}

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

/**
 * A peer's X25519 public key computed from its Ed25519 PUBLIC key (the birational map
 * u = (1 + y) / (1 - y) mod p). This is how a receiver gets the encryption key from a PINNED
 * identity key instead of trusting an X25519 key the relay handed over. Throws on a bad encoding.
 */
export function edPublicToX25519(edPublicKey: Buffer): Buffer {
  if (edPublicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
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

/** The eight small-order points, canonically encoded (they would let an attacker force a known shared secret). */
const SMALL_ORDER_ENCODINGS = new Set([
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
]);
const ED_D = (P25519 - ((121665n * modPow(121666n, P25519 - 2n, P25519)) % P25519)) % P25519;

/**
 * May this Ed25519 public key be pinned? (Spec D8, Echo's review SEC-16.) It must be 32 bytes, a
 * canonical encoding (y < p, and not x = 0 with the sign bit set), a point on the curve, and not
 * one of the small-order points. Never throws.
 */
export function isAcceptableIdentityKey(edPublicKey: Buffer): boolean {
  try {
    if (!Buffer.isBuffer(edPublicKey) || edPublicKey.length !== 32) return false;
    if (SMALL_ORDER_ENCODINGS.has(edPublicKey.toString('hex'))) return false;
    const sign = edPublicKey[31] >> 7;
    const le = Buffer.from(edPublicKey);
    le[31] &= 0x7f;
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(le[i]);
    if (y >= P25519) return false;
    // x^2 = (y^2 - 1) / (d*y^2 + 1); the key is on the curve iff that has a square root.
    const y2 = (y * y) % P25519;
    const u = (y2 - 1n + P25519) % P25519;
    const v = (ED_D * y2 + 1n) % P25519;
    const x2 = (u * modPow(v, P25519 - 2n, P25519)) % P25519;
    if (x2 === 0n) return sign === 0;
    return modPow(x2, (P25519 - 1n) / 2n, P25519) === 1n; // Euler's criterion
  } catch {
    return false;
  }
}

/** True iff `x25519PublicKey` is exactly the key derived from `edPublicKey`. Never throws. */
export function isX25519BoundToIdentity(edPublicKey: Buffer, x25519PublicKey: Buffer): boolean {
  try {
    const derived = edPublicToX25519(edPublicKey);
    return x25519PublicKey.length === 32 && crypto.timingSafeEqual(derived, x25519PublicKey);
  } catch {
    return false;
  }
}

/**
 * The pairing id of a KEY PAIR (Instar's `derivePairingIdV2`): HKDF over the two identity keys in
 * byte order. It changes exactly when either key changes, which is when a pairing must reset.
 */
export function derivePairingId(identityPubA: Buffer, identityPubB: Buffer): string {
  if (identityPubA.length !== 32 || identityPubB.length !== 32) throw new Error('identity public keys must be 32 raw bytes');
  const [lo, hi] = Buffer.compare(identityPubA, identityPubB) <= 0 ? [identityPubA, identityPubB] : [identityPubB, identityPubA];
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.concat([lo, hi]), Buffer.alloc(0), 'threadline-pairing-id-v2', 16)).toString('hex');
}
