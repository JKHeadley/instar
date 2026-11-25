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

export interface CameraJournalScope {
  readonly conversationKey: string;
  readonly binding: CameraJournalRecordBody['binding'];
  readonly milestone: string;
  readonly leaseEpoch: number;
}

export interface CameraJournalAuthority {
  /** Independently attested head for this exact scope. */
  readonly headSequence: number;
  readonly headRecordKey: string | null;
  readonly holder: string;
  verify(signingText: string, signature: string): boolean;
}

export interface CameraJournalEntry {
  readonly origin: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A null result holds the pilot. No partial prefix can authorize a decision. */
export function readCameraJournal(
  scope: CameraJournalScope,
  authority: CameraJournalAuthority | null,
  entries: readonly CameraJournalEntry[],
): CameraJournalRecord[] | null {
  if (!authority || !Number.isSafeInteger(authority.headSequence) || authority.headSequence < 0
    || (authority.headSequence === 0) !== (authority.headRecordKey === null)) return null;

  const bySequence = new Map<number, CameraJournalRecord>();
  for (const { origin, data } of entries) {
    if (data.recordType !== 'camera-acceptance' || data.conversationKey !== scope.conversationKey) continue;
    const record = parseCameraJournalRecord(data.cameraAcceptance);
    if (!record) return null;
    if (record.milestone !== scope.milestone
      || record.binding.physical !== scope.binding.physical
      || record.binding.logical !== scope.binding.logical
      || record.binding.node !== scope.binding.node) continue;
    if (record.leaseEpoch !== scope.leaseEpoch
      || record.holder !== authority.holder || origin !== authority.holder || data.origin !== origin
      || data.op !== 'put' || data.recordKey !== cameraJournalRecordKey(scope.conversationKey, record)) return null;

    const signingText = cameraJournalSigningText(scope.conversationKey, record);
    try {
      if (authority.verify(signingText, record.signature) !== true) return null;
    } catch {
      // @silent-fallback-ok: an unavailable verification provider holds the pilot.
      return null;
    }

    const previous = bySequence.get(record.journalSequence);
    if (previous) {
      if (cameraJournalSigningText(scope.conversationKey, previous) !== signingText) return null;
      if (record.journalSequence === authority.headSequence
        && cameraJournalRecordKey(scope.conversationKey, previous) === authority.headRecordKey) continue;
    }
    bySequence.set(record.journalSequence, record);
  }

  if (bySequence.size !== authority.headSequence) return null;
  const ordered: CameraJournalRecord[] = [];
  for (let sequence = 1; sequence <= bySequence.size; sequence++) {
    const record = bySequence.get(sequence);
    if (!record) return null;
    ordered.push(record);
  }
  const terminal = ordered.at(-1);
  if (terminal && cameraJournalRecordKey(scope.conversationKey, terminal) !== authority.headRecordKey) return null;
  return ordered;
}
