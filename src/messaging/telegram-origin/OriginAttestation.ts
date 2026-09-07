import { sign, verify } from 'node:crypto';
import { canonicalOrigin, wireDigest } from './CanonicalOrigin.js';
import type { OriginAttestation, TelegramOriginRecord } from './types.js';
export interface OriginVerificationKey {
  machineId: string;
  agentId: string;
  keyId: string;
  keyEpoch: number;
  publicKey: string;
  validFrom: number | null;
  validUntil: number | null;
  revokedAt: number | null;
}
export type UnsignedOriginRecord = Omit<TelegramOriginRecord, 'attestation'>;
export function attestOrigin(record: UnsignedOriginRecord, key: {
  keyId: string; keyEpoch: number; privateKey: string;
}, now = Date.now()): OriginAttestation {
  const bytes = canonicalOrigin({ protocol: 'instar-telegram-origin-v1', keyId: key.keyId,
    keyEpoch: key.keyEpoch, signedAt: now, record });
  return { keyId: key.keyId, keyEpoch: key.keyEpoch, signedAt: now,
    envelopeDigest: wireDigest(bytes), signature: sign(null, Buffer.from(bytes), key.privateKey).toString('base64url') };
}
export function verifyOriginAttestation(record: TelegramOriginRecord,
  key: OriginVerificationKey, authenticatedPeer: { machineId: string; agentId: string },
  now = Date.now()): { valid: true; verifiedAt: number; keyStatus: 'active' } | { valid: false; reason: string } {
  const attestation = record.attestation;
  if (!attestation) return { valid: false, reason: 'missing-attestation' };
  const attestingMachine = record.producerKind === 'imported-legacy' ? record.importedByMachineId : record.originMachineId;
  if (record.producerKind === 'imported-legacy' && (record.machine.status !== 'unknown' || record.harness.status !== 'unknown' || record.model.status !== 'unknown')) return { valid: false, reason: 'legacy-attribution-invented' };
  if (record.agentId !== authenticatedPeer.agentId || attestingMachine !== authenticatedPeer.machineId ||
    key.agentId !== record.agentId || key.machineId !== attestingMachine) return { valid: false, reason: 'origin-peer-mismatch' };
  if (key.keyId !== attestation.keyId || key.keyEpoch !== attestation.keyEpoch) return { valid: false, reason: 'key-epoch-mismatch' };
  if (key.revokedAt !== null && key.revokedAt <= now) return { valid: false, reason: 'key-revoked' };
  if (key.validUntil !== null && key.validUntil <= now) return { valid: false, reason: 'key-superseded' };
  if (key.validFrom !== null && key.validFrom > now) return { valid: false, reason: 'key-not-yet-valid' };
  if (!Number.isSafeInteger(attestation.signedAt) || (key.validFrom !== null && attestation.signedAt < key.validFrom) || (key.validUntil !== null && attestation.signedAt >= key.validUntil) || attestation.signedAt > now + 60_000) {
    return { valid: false, reason: 'key-validity' };
  }
  const { attestation: _signature, ...unsigned } = record;
  const bytes = canonicalOrigin({ protocol: 'instar-telegram-origin-v1', keyId: key.keyId,
    keyEpoch: key.keyEpoch, signedAt: attestation.signedAt, record: unsigned });
  if (wireDigest(bytes) !== attestation.envelopeDigest) return { valid: false, reason: 'envelope-tampered' };
  try {
    if (!verify(null, Buffer.from(bytes), key.publicKey, Buffer.from(attestation.signature, 'base64url'))) return { valid: false, reason: 'signature-invalid' };
  } catch { return { valid: false, reason: 'invalid-key-or-signature' }; }
  return { valid: true, verifiedAt: now, keyStatus: 'active' };
}

/** Retrospective signature checking is not fresh acceptance. Only separately
 * retained local acceptance evidence can establish an earlier verification. */
export function verifyHistoricalOriginAttestation(record: TelegramOriginRecord, key: OriginVerificationKey,
  evidence: import('./StoreTypes.js').OriginAcceptanceVerification | null, now = Date.now()) {
  const peer = { machineId: key.machineId, agentId: key.agentId };
  const signedAt = record.attestation?.signedAt;
  const signature = verifyOriginAttestation(record, { ...key, validFrom: null, validUntil: null, revokedAt: null }, peer, now);
  const keyStatus = key.revokedAt !== null && key.revokedAt <= now ? 'revoked' : key.validUntil !== null && key.validUntil <= now ? 'superseded' : 'active';
  const signedDuringKnownValidity = signedAt === undefined || !Number.isSafeInteger(signedAt) ? 'invalid'
    : key.validUntil !== null && signedAt >= key.validUntil || key.validFrom !== null && signedAt < key.validFrom ? 'invalid'
    : key.validFrom === null ? 'unknown' : 'valid';
  const matching = !!evidence && evidence.envelopeDigest === wireDigest(canonicalOrigin(record)) &&
    evidence.keyId === key.keyId && evidence.keyEpoch === key.keyEpoch && evidence.keyFingerprint === wireDigest(key.publicKey) &&
    Number.isSafeInteger(evidence.verifiedAt) && evidence.verifiedAt >= 0 && evidence.verifiedAt <= now;
  return { signatureValid: signature.valid, keyStatus, signedDuringKnownValidity,
    acceptedVerifiedAt: matching ? evidence!.verifiedAt : null,
    verificationBeforeRevocation: !matching ? 'unknown' : key.revokedAt === null ? 'not-revoked'
      : evidence!.verifiedAt < key.revokedAt ? 'yes' : 'no' };
}
