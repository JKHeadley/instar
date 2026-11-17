/**
 * The organization recovery copy (docs/specs/org-members-and-keepers.md §E): the organization's
 * private key, current bundle and registries, encrypted under a key derived from a six-word phrase
 * the agent generates and shows once. Pure functions: no files, no routes.
 */
import crypto from 'node:crypto';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const RECOVERY_WORDS = 6;
/** Base64 ciphertext limit: registries at their limits are at most about 16 MB of JSON (org-recovery-copy §A). */
export const RECOVERY_CIPHERTEXT_MAX = 24 * 1024 * 1024;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface RecoveryContents {
  privateKeyPem: string;
  bundle: unknown;
  /** The copying agent's own member key, so recovery can retire its entry; null when it had none. */
  selfMemberKey: string | null;
  registries: { members?: unknown; invites?: unknown; keepers?: unknown };
}

export interface RecoveryFile {
  v: 1;
  orgId: string;
  orgName: string;
  fingerprint: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  nonce: string;
  ciphertext: string;
  tag: string;
}

/** Six words from the 2048-word list, about 66 bits, chosen with crypto randomness. */
export function newRecoveryPhrase(): string {
  return Array.from({ length: RECOVERY_WORDS }, () => wordlist[crypto.randomInt(wordlist.length)]!).join(' ');
}

/** Spacing and case don't matter when the person types the phrase back. */
export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(' ');
}

function deriveKey(phrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer {
  return crypto.scryptSync(normalizePhrase(phrase), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });
}

/** The header fields are bound to the ciphertext as additional data, so none can be swapped. */
function aad(f: Pick<RecoveryFile, 'v' | 'orgId' | 'orgName' | 'fingerprint'>): Buffer {
  return Buffer.from(JSON.stringify([f.v, f.orgId, f.orgName, f.fingerprint]), 'utf8');
}

export function makeRecoveryCopy(
  header: { orgId: string; orgName: string; fingerprint: string },
  contents: RecoveryContents,
  phrase: string,
): RecoveryFile {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = deriveKey(phrase, salt, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const base = { v: 1 as const, ...header };
  c.setAAD(aad(base));
  const ct = Buffer.concat([c.update(JSON.stringify(contents), 'utf8'), c.final()]);
  if (Math.ceil(ct.length / 3) * 4 > RECOVERY_CIPHERTEXT_MAX) throw new Error('recovery copy too large');
  return {
    ...base,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), ciphertext: ct.toString('base64'), tag: c.getAuthTag().toString('base64'),
  };
}

export type OpenResult = { ok: true; contents: RecoveryContents } | { ok: false; error: 'malformed' | 'wrong-phrase' };

export function openRecoveryCopy(raw: unknown, phrase: string): OpenResult {
  const f = raw as Partial<RecoveryFile> | null;
  if (!f || f.v !== 1 || f.cipher !== 'aes-256-gcm' || f.kdf?.name !== 'scrypt' || typeof f.orgId !== 'string' || typeof f.orgName !== 'string'
    || typeof f.fingerprint !== 'string' || typeof f.nonce !== 'string' || typeof f.ciphertext !== 'string' || typeof f.tag !== 'string'
    || typeof f.kdf.salt !== 'string') return { ok: false, error: 'malformed' };
  // Refuse cost parameters an attacker-made file could use to exhaust memory or time, and oversized fields.
  if (f.kdf.N !== SCRYPT.N || f.kdf.r !== SCRYPT.r || f.kdf.p !== SCRYPT.p) return { ok: false, error: 'malformed' };
  // Checked as strings before anything is decoded.
  const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
  const fixed = (v: string, chars: number): boolean => v.length === chars && B64.test(v);
  if (!fixed(f.kdf.salt, 24) || !fixed(f.nonce, 16) || !fixed(f.tag, 24) || f.ciphertext.length > RECOVERY_CIPHERTEXT_MAX || !B64.test(f.ciphertext)) return { ok: false, error: 'malformed' };
  try {
    const key = deriveKey(phrase, Buffer.from(f.kdf.salt, 'base64'), f.kdf);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.nonce, 'base64'));
    d.setAAD(aad(f as RecoveryFile));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(f.ciphertext, 'base64')), d.final()]).toString('utf8');
    const contents = JSON.parse(pt) as RecoveryContents;
    if (typeof contents?.privateKeyPem !== 'string' || !(typeof contents.selfMemberKey === 'string' || contents.selfMemberKey === null)) return { ok: false, error: 'malformed' };
    return { ok: true, contents };
  } catch {
    // @silent-fallback-ok — a failed authentication tag is how a wrong phrase shows itself
    return { ok: false, error: 'wrong-phrase' };
  }
}
