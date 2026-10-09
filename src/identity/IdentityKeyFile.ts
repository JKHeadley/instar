/**
 * IdentityKeyFile — the one place an agent identity key file is decoded,
 * validated, repaired and written.
 *
 * Spec: docs/specs/threadline-identity-single-writer.md
 *
 * Why this exists (ACT-062): two modules used to write
 * `{stateDir}/threadline/identity.json` with different encodings. One wrote the
 * keys as hex, the other read them as base64 without checking the length. 64
 * hex characters decode as base64 to 48 bytes, so an agent whose file was
 * written by the hex writer offered the relay a 48-byte "public key" and was
 * rejected on every boot, permanently, once the bad strings had been copied
 * into the canonical `{stateDir}/identity.json`.
 *
 * Rules enforced here:
 *  - A stored key is valid only if it decodes to exactly 32 bytes, and (for an
 *    unencrypted file) the public key is the one the private key derives.
 *  - A key stored as 64 hex characters is the SAME key in the wrong encoding.
 *    It is decoded as hex and the file is rewritten as base64 — a lossless
 *    repair that keeps the agent's address.
 *  - Anything else invalid throws. The file is left untouched and nothing is
 *    minted over it: a new identity is a new address.
 *  - Every write is atomic (temp file + rename) and owner-only (0600).
 *  - No message, log line or error produced here contains key material — only
 *    lengths and the file path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeFingerprint, deriveX25519PublicKey } from '../threadline/client/MessageEncryptor.js';
import { computeCanonicalId, computeDisplayFingerprint } from './types.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

/** Raw Ed25519 public key and private seed are both 32 bytes. */
export const IDENTITY_KEY_BYTES = 32;

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BASE64_ALPHABET = /^[A-Za-z0-9+/_-]+={0,2}$/;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export type KeyEncoding = 'base64' | 'hex';

/**
 * Thrown when an identity file exists but cannot be used. Callers must NOT
 * respond by minting a new identity.
 */
export class IdentityFileInvalidError extends Error {
  readonly code = 'identity-file-invalid';
  readonly filePath: string;
  readonly reason: string;
  constructor(filePath: string, reason: string) {
    super(
      `Identity file ${filePath} cannot be used: ${reason}. The file was left untouched and no ` +
        'new identity was created, because a new identity would change this agent\'s address.',
    );
    this.name = 'IdentityFileInvalidError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

/**
 * Decode one stored key. Returns null unless the value is a 32-byte key in
 * base64 or in hex. Hex is tested first: 64 hex characters are also valid
 * base64 text, but they decode to 48 bytes, so the two never overlap.
 */
export function decodeKey32(value: unknown): { key: Buffer; encoding: KeyEncoding } | null {
  if (typeof value !== 'string') return null;
  // Whitespace (a trailing newline from a hand edit) was always ignored by the
  // lenient decoder the old readers used; keep ignoring it.
  const text = value.replace(/\s+/g, '');
  if (text.length === 0) return null;
  if (HEX_KEY.test(text)) return { key: Buffer.from(text, 'hex'), encoding: 'hex' };
  if (!BASE64_ALPHABET.test(text)) return null;
  const key = Buffer.from(text, 'base64');
  return key.length === IDENTITY_KEY_BYTES ? { key, encoding: 'base64' } : null;
}

/** A description of a stored value that is safe to log: type and lengths only. */
function describeStored(value: unknown): string {
  if (typeof value !== 'string') return `stored as ${value === undefined ? 'nothing' : typeof value}`;
  return `${value.length} characters, ${Buffer.from(value, 'base64').length} bytes after base64 decode`;
}

/** The Ed25519 public key a 32-byte private seed derives. */
export function derivePublicKey(privateSeed: Buffer): Buffer {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, privateSeed]),
    format: 'der',
    type: 'pkcs8',
  });
  const der = crypto.createPublicKey(privateKeyObj).export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(-IDENTITY_KEY_BYTES));
}

/**
 * Write a file atomically with owner-only permissions. The temp file is
 * created 0600 before any secret byte is written to it.
 */
export function writeFileAtomicOwnerOnly(filePath: string, data: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    // `mode` only applies when the file is created; make it explicit either way.
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Never leave a stray copy of a private key behind a failed write.
    try {
      SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/identity/IdentityKeyFile.ts:writeFileAtomicOwnerOnly' });
    } catch { /* nothing was created, or it cannot be removed either */ }
    throw err;
  }
}

/**
 * Create a file only if it does not exist yet — atomically, owner-only, and
 * never visible half-written. Returns false (and writes nothing) when the file
 * already exists: another writer got there first and ITS content stands.
 *
 * This is what makes "mint an identity" safe when two processes both found no
 * file: exactly one mint lands; the loser re-reads the winner's file.
 */
export function createFileExclusiveOwnerOnly(filePath: string, data: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  try {
    // link(2) fails with EEXIST if the target exists; it never replaces it.
    fs.linkSync(tmpPath, filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // No hard links on this filesystem: fall back to an exclusive create.
    try {
      fs.writeFileSync(filePath, data, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err2;
    }
  } finally {
    try {
      SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/identity/IdentityKeyFile.ts:createFileExclusiveOwnerOnly' });
    } catch { /* the temp file holds the same bytes as the target and is 0600 */ }
  }
}

export interface IdentityKeyFileContents {
  /** The parsed file. After a repair this is the repaired object. */
  raw: Record<string, unknown>;
  publicKey: Buffer;
  /** null when the private key is passphrase-encrypted. */
  privateKey: Buffer | null;
  encrypted: boolean;
  /** True when hex-encoded keys were found and the file was rewritten as base64. */
  repaired: boolean;
  /** Set when a needed repair could not be written. The keys are still usable in memory. */
  repairError?: string;
}

/**
 * Read and validate an identity key file.
 *
 * @returns null when the file does not exist.
 * @throws IdentityFileInvalidError when it exists but is not a usable identity.
 */
export function readIdentityKeyFile(
  filePath: string,
  options: { repair?: boolean } = {},
): IdentityKeyFileContents | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IdentityFileInvalidError(filePath, `it could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new IdentityFileInvalidError(filePath, 'it is not a JSON object');
  }

  const encrypted = typeof raw.privateKeyEncryption === 'string' && raw.privateKeyEncryption !== 'none';

  const pub = decodeKey32(raw.publicKey);
  if (!pub) {
    throw new IdentityFileInvalidError(
      filePath,
      `the public key is not a 32-byte Ed25519 key (${describeStored(raw.publicKey)})`,
    );
  }

  if (encrypted) {
    // The private key is ciphertext; only the holder of the passphrase can
    // check it. A hex public key here cannot be repaired without re-deriving
    // the identifiers the encrypted half is bound to, so it is refused.
    if (pub.encoding !== 'base64') {
      throw new IdentityFileInvalidError(filePath, 'the public key of an encrypted identity is hex-encoded');
    }
    return { raw, publicKey: pub.key, privateKey: null, encrypted: true, repaired: false };
  }

  const priv = decodeKey32(raw.privateKey);
  if (!priv) {
    throw new IdentityFileInvalidError(
      filePath,
      `the private key is not a 32-byte Ed25519 key (${describeStored(raw.privateKey)})`,
    );
  }

  let derived: Buffer;
  try {
    derived = derivePublicKey(priv.key);
  } catch {
    throw new IdentityFileInvalidError(filePath, 'the private key is not a usable Ed25519 key');
  }
  if (!derived.equals(pub.key)) {
    throw new IdentityFileInvalidError(filePath, 'the public key does not belong to the private key');
  }

  const result: IdentityKeyFileContents = {
    raw,
    publicKey: pub.key,
    privateKey: priv.key,
    encrypted: false,
    repaired: false,
  };

  const needsRepair = pub.encoding === 'hex' || priv.encoding === 'hex';
  if (!needsRepair || !options.repair) return result;

  // ── Repair: same key material, correct encoding ────────────────────
  const next: Record<string, unknown> = {
    ...raw,
    publicKey: pub.key.toString('base64'),
    privateKey: priv.key.toString('base64'),
  };
  const canonicalShape = ['version', 'canonicalId', 'privateKeyEncryption', 'provenance'].some(k => k in raw);
  if (canonicalShape) {
    // Canonical shape. Identifiers stored beside the key were computed from the
    // mis-decoded 48-byte value; recompute the ones that are present. No field
    // is added that the file did not already carry.
    if ('canonicalId' in raw || 'displayFingerprint' in raw) {
      const canonicalId = computeCanonicalId(pub.key);
      next.canonicalId = canonicalId;
      next.displayFingerprint = computeDisplayFingerprint(canonicalId);
    }
  } else {
    // Legacy threadline shape.
    next.fingerprint = computeFingerprint(pub.key);
    next.x25519PublicKey = deriveX25519PublicKey(priv.key).toString('base64');
    if (typeof raw.createdAt !== 'string') {
      let createdAt = new Date().toISOString();
      try { createdAt = fs.statSync(filePath).mtime.toISOString(); } catch { /* keep now */ }
      next.createdAt = createdAt;
    }
  }

  try {
    // Compare-then-replace: if anything rewrote the file since it was read
    // (a concurrent repair, or a deliberate replacement), do not write over
    // it — read what is there now instead.
    if (fs.readFileSync(filePath, 'utf-8') !== text) {
      return readIdentityKeyFile(filePath, { repair: false });
    }
    writeFileAtomicOwnerOnly(filePath, JSON.stringify(next, null, 2));
    result.raw = next;
    result.repaired = true;
  } catch (err) {
    if (err instanceof IdentityFileInvalidError) throw err;
    result.repairError = (err as NodeJS.ErrnoException).code ?? 'write failed';
  }
  return result;
}
