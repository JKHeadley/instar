import { canonicalOrigin, originDigest, wireDigest } from './CanonicalOrigin.js';
import { attestOrigin } from './OriginAttestation.js';
import type { OriginAdmission } from './StoreTypes.js';
import type { TelegramOriginRecord } from './types.js';

/** Commit every execution bound and derivation permission. Attachment bytes are
 * represented by their digest/size; the outbox independently verifies the bytes. */
export function originAdmissionDigest(admission: OriginAdmission): string {
  const { record: _record, payloads, ...execution } = admission;
  return originDigest({ ...execution, ...(payloads ? { payloads: payloads.map(({ payloadId, digest, size }) => ({ payloadId, digest, size })) } : {}) });
}
export function sealOriginAdmission(operation: { record: TelegramOriginRecord; admission: OriginAdmission },
  key: { keyId: string; keyEpoch: number; privateKey: string }, now: number): void {
  const { attestation: _old, ...unsigned } = operation.record;
  const sealed = { ...unsigned, admissionDigest: originAdmissionDigest(operation.admission) };
  operation.record = { ...sealed, attestation: attestOrigin(sealed, key, now) };
  const envelopeJson = canonicalOrigin(operation.record);
  operation.admission.record = { ...operation.admission.record, envelopeJson, envelopeDigest: wireDigest(envelopeJson) };
}
export function validOriginAdmission(operation: { record: TelegramOriginRecord; admission: OriginAdmission }): boolean {
  try {
    return operation.record.operationId === operation.admission.operationId &&
      operation.record.createdAt === operation.admission.preparedAt &&
      operation.record.admissionDigest === originAdmissionDigest(operation.admission);
  } catch { return false; }
}
