/**
 * Witness records — signed statements one agent makes about work with another.
 *
 * A record is self-contained: anyone holding the issuer's Witness public key
 * can verify it offline. A registry is a convenience, never the authority.
 * Which key counts as the issuer's is decided by the issuer's key bindings
 * (binding.ts); WitnessStore enforces that link.
 *
 * Records are append-only. Revocation is a NEW record from the same issuer
 * (claim "revoked", `revokes` = the original's hash), never a deletion.
 * Revocations have no valid_until (they never lapse) and cannot themselves
 * be revoked.
 *
 * Fields mirror MoltBridge's ATTESTED edge (claim, evidence, confidence,
 * timestamp, valid_until) so existing data maps over; confidence is an
 * integer percentage because signed data carries no floats (canonical.ts).
 *
 * issued_at is the issuer's own claim. It proves nothing by itself; it is
 * only checked for being well-formed and not in the future.
 */

import crypto from 'node:crypto';
import { canonicalize } from './canonical.js';
import { isHex, keyIdFor, signBytes, verifyBytes } from './keys.js';

export const RECORD_TYPE = 'WitnessRecord/v0';
/** Bound into every signature so a record signature can never be replayed as another kind of statement. */
const SIGNING_CONTEXT = 'instar-witness-record-v0\n';

/**
 * `verified-by-sas` is RESERVED for the Threadline pairing hook (an agent
 * recording that a human confirmed the 6-word SAS for a fingerprint). It is
 * in the format now so adding the hook later is not a format change; until
 * the hook exists nothing issues it automatically.
 */
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
/** How far ahead of the verifier's clock an issued_at may be before the record is refused. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
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
  /** Integer percentage, 0 to 100. */
  confidence: number;
  issued_at: string;
  /** Absent exactly when claim is "revoked": revocations never lapse. */
  valid_until?: string;
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
  const isRevocation = input.claim === 'revoked';
  const validUntil = isRevocation
    ? undefined
    : input.validUntil ?? new Date(issuedAt.getTime() + DEFAULT_VALIDITY_DAYS * 86_400_000);
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
    ...(validUntil ? { valid_until: validUntil.toISOString() } : {}),
    ...(input.revokes !== undefined ? { revokes: input.revokes } : {}),
  };
  const problems = validateShape(unsigned);
  if (problems.length) throw new TypeError(`invalid witness record: ${problems.join('; ')}`);
  return { ...unsigned, signature: signBytes(key.privateKey, signingMessage(unsigned)) };
}

/** A record that revokes `original`. Only the original's issuer can revoke it; the store enforces that. */
export function createRevocation(original: WitnessRecord, reason: string, key: SigningKey, at?: Date): WitnessRecord {
  return createRecord(
    {
      issuer: original.issuer,
      subject: original.subject,
      claim: 'revoked',
      context: reason,
      confidence: 100,
      issuedAt: at,
      revokes: recordHash(original),
    },
    key,
  );
}

/**
 * A record's id: SHA-256 of exactly what was signed (context string + canonical
 * unsigned body), NOT of the signature. Ed25519 signing is deterministic, but a
 * different library or a malleable encoding must never give one statement two ids,
 * or a revocation could miss the copy it was meant for.
 */
export function recordHash(record: UnsignedRecord | WitnessRecord): string {
  const { signature: _ignored, ...unsigned } = record as WitnessRecord;
  return crypto.createHash('sha256').update(signingMessage(unsigned)).digest('hex');
}

export type VerifyResult =
  | { ok: true; expired: boolean }
  | { ok: false; reason: string };

/**
 * Verify a record against a Witness public key.
 *
 * This checks the signature only. Whether that key is the issuer's is a
 * separate question answered by the issuer's bindings — use WitnessStore,
 * which enforces both.
 *
 * `ok: true, expired: true` means the signature is genuine but the record is past
 * valid_until — a true statement that has lapsed, which is different from a forgery.
 */
export function verifyRecord(record: unknown, publicKey: string, now: Date = new Date()): VerifyResult {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'not an object' };
  const { signature, ...rest } = record as Record<string, unknown>;
  const problems = validateShape(rest);
  if (problems.length) return { ok: false, reason: problems.join('; ') };
  if (!isHex(signature, 64)) return { ok: false, reason: 'signature must be 64 bytes of hex' };
  if (!isHex(publicKey, 32)) return { ok: false, reason: 'public key must be 32 bytes of hex' };
  const unsigned = rest as unknown as UnsignedRecord;
  if (unsigned.key_id !== keyIdFor(publicKey)) {
    return { ok: false, reason: 'key_id does not match the supplied key' };
  }
  if (Date.parse(unsigned.issued_at) > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'issued_at is in the future' };
  }
  if (!verifyBytes(publicKey, signingMessage(unsigned), signature)) {
    return { ok: false, reason: 'bad signature' };
  }
  const expired = unsigned.valid_until !== undefined && Date.parse(unsigned.valid_until) <= now.getTime();
  return { ok: true, expired };
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
  if (!Number.isInteger(o.confidence) || (o.confidence as number) < 0 || (o.confidence as number) > 100) {
    out.push('confidence must be an integer from 0 to 100');
  }
  const issued = isIsoDate(o.issued_at);
  if (!issued) out.push('issued_at must be an ISO-8601 UTC timestamp');
  if (o.claim === 'revoked') {
    if (!isHex(o.revokes, 32)) out.push('a revoked record must name the revoked record hash in revokes');
    if (o.valid_until !== undefined) out.push('a revocation has no valid_until; revocations never lapse');
  } else {
    if (o.revokes !== undefined) out.push('revokes is only allowed when claim is revoked');
    if (!isIsoDate(o.valid_until)) out.push('valid_until must be an ISO-8601 UTC timestamp');
    else if (issued && Date.parse(o.valid_until) <= Date.parse(o.issued_at as string)) {
      out.push('valid_until must be after issued_at');
    }
  }
  return out;
}

function isDid(v: unknown): v is string {
  return typeof v === 'string' && /^did:[a-z0-9]+:\S+$/.test(v) && v.length <= 300;
}

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
}
