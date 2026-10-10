/**
 * Witness records — signed statements one agent makes about work with another.
 *
 * A record is self-contained: anyone holding the issuer's Witness public key
 * can verify it offline. A registry is a convenience, never the authority.
 *
 * Records are append-only. Revocation is a NEW record from the same issuer
 * (claim "revoked", `revokes` = the original's hash), never a deletion.
 *
 * Fields mirror MoltBridge's ATTESTED edge (claim, evidence, confidence,
 * timestamp, valid_until) so existing data maps over.
 */

import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';
import { isHex, keyIdFor, signBytes, verifyBytes } from './keys.js';

export const RECORD_TYPE = 'WitnessRecord/v0';
/** Bound into every signature so a record signature can never be replayed as another kind of statement. */
const SIGNING_CONTEXT = 'instar-witness-record-v0\n';

export const CLAIMS = [
  'completed',
  'delivered',
  'collaborated',
  'disputed',
  'verified-by-sas',
  'revoked',
  'other',
] as const;
export type Claim = (typeof CLAIMS)[number];

export const DEFAULT_VALIDITY_DAYS = 180;
const MAX_CONTEXT = 2000;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_ITEM = 500;

export interface UnsignedRecord {
  type: typeof RECORD_TYPE;
  issuer: string;
  subject: string;
  key_id: string;
  claim: Claim;
  context: string;
  evidence: string[];
  confidence: number;
  issued_at: string;
  valid_until: string;
  /** Hash of the record being revoked. Present exactly when claim is "revoked". */
  revokes?: string;
}

export interface WitnessRecord extends UnsignedRecord {
  /** Hex Ed25519 signature over SIGNING_CONTEXT + canonical JSON of every other field. */
  signature: string;
}

export interface CreateRecordInput {
  issuer: string;
  subject: string;
  claim: Claim;
  context: string;
  evidence?: string[];
  confidence: number;
  issuedAt?: Date;
  validUntil?: Date;
  revokes?: string;
}

export interface SigningKey {
  publicKey: string;
  privateKey: string;
}

export function createRecord(input: CreateRecordInput, key: SigningKey): WitnessRecord {
  const issuedAt = input.issuedAt ?? new Date();
  const validUntil = input.validUntil ?? new Date(issuedAt.getTime() + DEFAULT_VALIDITY_DAYS * 86_400_000);
  const unsigned: UnsignedRecord = {
    type: RECORD_TYPE,
    issuer: input.issuer,
    subject: input.subject,
    key_id: keyIdFor(key.publicKey),
    claim: input.claim,
    context: input.context,
    evidence: input.evidence ?? [],
    confidence: input.confidence,
    issued_at: issuedAt.toISOString(),
    valid_until: validUntil.toISOString(),
    ...(input.revokes !== undefined ? { revokes: input.revokes } : {}),
  };
  const problems = validateShape(unsigned);
  if (problems.length) throw new TypeError(`invalid witness record: ${problems.join('; ')}`);
  return { ...unsigned, signature: signBytes(key.privateKey, signingMessage(unsigned)) };
}

/** A record that revokes `original`. Only meaningful from the original's issuer; the store enforces that. */
export function createRevocation(original: WitnessRecord, reason: string, key: SigningKey, at?: Date): WitnessRecord {
  return createRecord(
    {
      issuer: original.issuer,
      subject: original.subject,
      claim: 'revoked',
      context: reason,
      confidence: 1,
      issuedAt: at,
      revokes: recordHash(original),
    },
    key,
  );
}

/** Content hash of a full signed record. Records are stored and referenced by this, never by a local id. */
export function recordHash(record: WitnessRecord): string {
  return crypto.createHash('sha256').update(canonicalize(record)).digest('hex');
}

export type VerifyResult =
  | { ok: true; expired: boolean }
  | { ok: false; reason: string };

/**
 * Verify a record against the issuer's Witness public key.
 *
 * `ok: true, expired: true` means the signature is genuine but the record is past
 * valid_until — a true statement that has lapsed, which is different from a forgery.
 */
export function verifyRecord(record: unknown, issuerPublicKey: string, now: Date = new Date()): VerifyResult {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'not an object' };
  const { signature, ...rest } = record as Record<string, unknown>;
  const problems = validateShape(rest);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  if (!isHex(signature, 64)) return { ok: false, reason: 'signature must be 64 bytes of hex' };
  if (!isHex(issuerPublicKey, 32)) return { ok: false, reason: 'issuer public key must be 32 bytes of hex' };
  const unsigned = rest as unknown as UnsignedRecord;
  if (unsigned.key_id !== keyIdFor(issuerPublicKey)) {
    return { ok: false, reason: 'key_id does not match the supplied issuer key' };
  }
  if (!verifyBytes(issuerPublicKey, signingMessage(unsigned), signature)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true, expired: Date.parse(unsigned.valid_until) <= now.getTime() };
}

function signingMessage(unsigned: UnsignedRecord): Buffer {
  return Buffer.from(SIGNING_CONTEXT + canonicalize(unsigned), 'utf8');
}

const ALLOWED_FIELDS = new Set([
  'type', 'issuer', 'subject', 'key_id', 'claim', 'context', 'evidence',
  'confidence', 'issued_at', 'valid_until', 'revokes',
]);

/** Returns every problem with the shape, so a caller sees all of them at once. */
export function validateShape(r: Record<string, unknown> | UnsignedRecord): string[] {
  const o = r as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!ALLOWED_FIELDS.has(k)) out.push(`unknown field ${k}`);
  if (o.type !== RECORD_TYPE) out.push(`type must be ${RECORD_TYPE}`);
  if (!isDid(o.issuer)) out.push('issuer must be a did: URI');
  if (!isDid(o.subject)) out.push('subject must be a did: URI');
  if (!isHex(o.key_id, 16)) out.push('key_id must be 16 bytes of hex');
  if (!CLAIMS.includes(o.claim as Claim)) out.push(`claim must be one of ${CLAIMS.join(', ')}`);
  if (typeof o.context !== 'string' || o.context.length === 0 || o.context.length > MAX_CONTEXT) {
    out.push(`context must be a non-empty string of at most ${MAX_CONTEXT} chars`);
  }
  if (
    !Array.isArray(o.evidence) ||
    o.evidence.length > MAX_EVIDENCE ||
    !o.evidence.every(e => typeof e === 'string' && e.length > 0 && e.length <= MAX_EVIDENCE_ITEM)
  ) {
    out.push(`evidence must be at most ${MAX_EVIDENCE} non-empty strings`);
  }
  if (typeof o.confidence !== 'number' || !(o.confidence >= 0 && o.confidence <= 1)) {
    out.push('confidence must be a number from 0 to 1');
  }
  const issued = isIsoDate(o.issued_at);
  const until = isIsoDate(o.valid_until);
  if (!issued) out.push('issued_at must be an ISO-8601 UTC timestamp');
  if (!until) out.push('valid_until must be an ISO-8601 UTC timestamp');
  if (issued && until && Date.parse(o.valid_until as string) <= Date.parse(o.issued_at as string)) {
    out.push('valid_until must be after issued_at');
  }
  if (o.claim === 'revoked') {
    if (!isHex(o.revokes, 32)) out.push('a revoked record must name the revoked record hash in revokes');
  } else if (o.revokes !== undefined) {
    out.push('revokes is only allowed when claim is revoked');
  }
  return out;
}

function isDid(v: unknown): v is string {
  return typeof v === 'string' && /^did:[a-z0-9]+:\S+$/.test(v) && v.length <= 300;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
}
