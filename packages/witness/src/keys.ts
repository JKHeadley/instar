/**
 * Witness keys.
 *
 * A Witness key is a dedicated Ed25519 key, separate from the agent's
 * Threadline transport key. The Threadline key is per-machine and identity
 * recovery can rotate it; if it signed witness records, a rotation would
 * orphan every record it ever signed. So Witness signs with its own key and
 * binds that key to the Threadline fingerprint with a signed statement
 * (see binding.ts).
 *
 * Node's native crypto only — no external libraries, same as ThreadlineCrypto.
 */

import crypto from 'node:crypto';

export interface WitnessKeyPair {
  /** Raw 32-byte Ed25519 public key, hex. */
  publicKey: string;
  /** Raw 32-byte Ed25519 private seed, hex. Never leaves the agent's machine. */
  privateKey: string;
  /** Stable id for this key: first 16 bytes of sha256(publicKey), hex. */
  keyId: string;
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function keyIdFor(publicKeyHex: string): string {
  assertHex(publicKeyHex, 32, 'publicKey');
  return crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 32);
}

export function generateWitnessKey(): WitnessKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  return { publicKey: pub, privateKey: priv, keyId: keyIdFor(pub) };
}

/** Derive the public key from a private seed (used to check a loaded key file is consistent). */
export function publicKeyFromPrivate(privateKeyHex: string): string {
  assertHex(privateKeyHex, 32, 'privateKey');
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

export function signBytes(privateKeyHex: string, message: Buffer): string {
  assertHex(privateKeyHex, 32, 'privateKey');
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(privateKeyHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, message, key).toString('hex');
}

export function verifyBytes(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  if (!isHex(publicKeyHex, 32) || !isHex(signatureHex, 64)) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, message, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function isHex(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);
}

function assertHex(value: string, bytes: number, name: string): void {
  if (!isHex(value, bytes)) throw new TypeError(`${name} must be ${bytes} bytes of lowercase hex`);
}
