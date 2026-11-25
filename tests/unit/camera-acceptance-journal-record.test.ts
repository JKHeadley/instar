import { describe, expect, it } from 'vitest';
import { cameraJournalRecordKey, cameraJournalSigningText, parseCameraJournalRecord, type CameraJournalRecord } from '../../src/core/CameraAcceptanceJournalRecord.js';
import { buildCameraAcceptancePut, chiefOfStaffRecordStoreSchema } from '../../src/core/ChiefOfStaffStore.js';

const conversation = 'app:camera-test';
const holder = 'studio';
const context = { countDroppedField() {}, countJailReject() {} };
const binding = { physical: 100, logical: 0, node: holder };
const record: CameraJournalRecord = {
  binding, milestone: 'camera', leaseEpoch: 2, assignmentEpoch: 3, journalSequence: 4,
  revision: 1, candidate: 'camera-build', verifier: 'reviewer', holder,
  event: { kind: 'request', id: 'request', receiptSequence: 0 }, signature: 'test',
};

describe('Camera journal records', () => {
  it('encodes the accepted record in the Chief of Staff schema and rejects a mismatched emitter', () => {
    const build = buildCameraAcceptancePut(conversation, record);
    const envelope = build(binding, holder);
    expect(envelope?.recordKey).toBe(cameraJournalRecordKey(conversation, record));
    expect(build(binding, 'other')).toBeNull();
    expect(chiefOfStaffRecordStoreSchema.validate(envelope!, context))
      .toEqual({ recordType: 'camera-acceptance', conversationKey: conversation, cameraAcceptance: record });
  });

  it('refuses Camera keys carrying deletes, other record types, mismatched origins or changed contents', () => {
    const envelope = buildCameraAcceptancePut(conversation, record)(binding, holder)!;
    for (const raw of [
      { ...envelope, op: 'delete', recordType: 'tree' },
      { ...envelope, recordType: 'tree' },
      { ...envelope, origin: 'other' },
      { ...envelope, recordKey: 'camera-acceptance:wrong' },
      { ...envelope, cameraAcceptance: { ...record, journalSequence: 5 } },
    ]) expect(chiefOfStaffRecordStoreSchema.validate(raw, context)).toBeNull();
  });

  it('refuses malformed records and unreviewed nested data', () => {
    expect(parseCameraJournalRecord({ ...record, leaseEpoch: 0 })).toBeNull();
    expect(parseCameraJournalRecord({ ...record, event: { ...record.event, secret: 'extra' } })).toBeNull();
    expect(parseCameraJournalRecord({ ...record, event: { kind: 'submission', decision: 'pending' } })).toBeNull();
  });

  it('keeps competing same-sequence bodies visible and binds the signing text to the conversation', () => {
    const changed: CameraJournalRecord = { ...record, event: { kind: 'request', id: 'other', receiptSequence: 0 } };
    expect(cameraJournalRecordKey(conversation, record)).not.toBe(cameraJournalRecordKey(conversation, changed));
    expect(cameraJournalRecordKey(conversation, record)).not.toBe(cameraJournalRecordKey(conversation, { ...record, signature: 'other' }));
    const { signature: _signature, ...body } = record;
    expect(cameraJournalSigningText(conversation, record)).toBe(cameraJournalSigningText(conversation, body));
    expect(cameraJournalSigningText(conversation, body)).not.toBe(cameraJournalSigningText('app:other', body));
  });
});
