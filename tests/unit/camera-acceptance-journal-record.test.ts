import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cameraJournalRecordKey, cameraJournalSigningText, parseCameraJournalRecord, readCameraJournal, type CameraJournalRecord } from '../../src/core/CameraAcceptanceJournalRecord.js';
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

describe('Camera journal authority and coverage', () => {
  const keys = generateKeyPairSync('ed25519');
  const scope = { conversationKey: conversation, binding, milestone: record.milestone, leaseEpoch: 2 };
  const authority = {
    holder, headSequence: 2,
    verify: (text: string, signature: string) => verify(null, Buffer.from(text), keys.publicKey, Buffer.from(signature, 'base64')),
  };

  function signed(sequence: number, id: string) {
    const unsigned: CameraJournalRecord = {
      ...record, journalSequence: sequence, event: { kind: 'request', id, receiptSequence: 0 },
    };
    const signature = sign(null, Buffer.from(cameraJournalSigningText(conversation, unsigned)), keys.privateKey).toString('base64');
    const event = { ...unsigned, signature };
    return { origin: holder, data: buildCameraAcceptancePut(conversation, event)(binding, holder)! };
  }

  it('orders complete verified records and tolerates duplicated transport entries', () => {
    const first = signed(1, 'first');
    const second = signed(2, 'second');
    expect(readCameraJournal(scope, authority, [second, first, second])?.map(event => event.journalSequence))
      .toEqual([1, 2]);
  });

  it('holds a truncated head, internal gap, conflicting sequence or changed lease', () => {
    const first = signed(1, 'first');
    const second = signed(2, 'second');
    expect(readCameraJournal(scope, authority, [first])).toBeNull();
    expect(readCameraJournal(scope, authority, [first, signed(3, 'gap')])).toBeNull();
    expect(readCameraJournal(scope, authority, [first, second, signed(2, 'conflict')])).toBeNull();
    expect(readCameraJournal({ ...scope, leaseEpoch: 3 }, authority, [first, second])).toBeNull();
  });

  it('holds if the signature verification provider throws', () => {
    expect(readCameraJournal(scope, {
      ...authority, verify: () => { throw new Error('key unavailable'); },
    }, [signed(1, 'first'), signed(2, 'second')])).toBeNull();
  });

  it('rejects a key-shaped record with an invalid signature and a false envelope origin', () => {
    const first = signed(1, 'first');
    const second = signed(2, 'second');
    const fake = { ...record, journalSequence: 2 };
    expect(readCameraJournal(scope, authority, [first, {
      origin: holder, data: buildCameraAcceptancePut(conversation, fake)(binding, holder)!,
    }])).toBeNull();
    expect(readCameraJournal(scope, authority, [first, { ...second, origin: 'other' }])).toBeNull();
  });
});
