import { z } from 'zod';
import { canonicalHash, canonicalJson } from './GraphWitnessTypes.js';

const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative();
const positive = counter.min(1);

const cameraEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('requirement'), builders: z.array(token).min(1).max(32), designApprovalDigest: digest }),
  z.strictObject({ kind: z.literal('request'), id: token, receiptSequence: counter }),
  z.strictObject({
    kind: z.literal('submission'), requestId: token, evidenceHash: digest, receiptSequence: positive,
    decision: z.enum(['pass', 'fail']),
  }),
  z.strictObject({
    kind: z.literal('withdrawal'), id: token, passSequence: positive, receiptSequence: positive,
    reason: z.enum(['retest', 'regression']),
  }),
]);

const cameraRecordBody = z.strictObject({
  binding: z.strictObject({ physical: counter, logical: counter, node: token }),
  milestone: token,
  leaseEpoch: positive,
  assignmentEpoch: positive,
  journalSequence: positive,
  revision: positive,
  candidate: token,
  verifier: token,
  holder: token,
  event: cameraEvent,
});

const cameraRecord = cameraRecordBody.extend({ signature: z.string().regex(/^[A-Za-z0-9+/=_-]{1,1024}$/) });
export type CameraJournalRecordBody = z.infer<typeof cameraRecordBody>;
export type CameraJournalRecord = z.infer<typeof cameraRecord>;

export function parseCameraJournalRecord(input: unknown): CameraJournalRecord | null {
  const parsed = cameraRecord.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function cameraJournalSigningText(conversationKey: string, record: CameraJournalRecordBody | CameraJournalRecord): string {
  const { signature: _signature, ...body } = record as CameraJournalRecordBody & { signature?: string };
  return `instar.camera-acceptance.v1\n${canonicalJson({ conversationKey, body: cameraRecordBody.parse(body) })}`;
}

export const CAMERA_JOURNAL_KEY_PREFIX = 'camera-acceptance:';

/** Retain conflicting events at a sequence so the fold can detect them. */
export function cameraJournalRecordKey(conversationKey: string, record: CameraJournalRecord): string {
  return `${CAMERA_JOURNAL_KEY_PREFIX}${canonicalHash({ conversationKey, record })}`;
}
