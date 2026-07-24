/** Unified replicated lifecycle record for correction class reviews. */
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ImpactTier, OriginRecord } from './UnionReader.js';
import type { ReplicatedEnvelope } from './ReplicatedRecordEnvelope.js';
import type { ReplicatedKindBounds } from './ReplicationBudget.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';
import type { ClassReviewRecord, ClassReviewObservation } from '../monitoring/ClassReviewStore.js';

export const CLASS_REVIEW_STORE_KEY = 'classReview';
export const CLASS_REVIEW_RECORD_KIND = 'class-review-record';
export const CLASS_REVIEW_IMPACT_TIER: ImpactTier = 'high';
export const CLASS_REVIEW_RECORD_BOUNDS: ReplicatedKindBounds = {
  retention: { maxFileBytes: 8 * 1024 * 1024, rotateKeep: 8 },
  rateCap: { capacity: 50, refillPerSec: 5 },
};

const FILL = new Set(['pending', 'filled', 'dead-lettered']);
const ORIGIN = new Set(['operator-attributed', 'agent-self']);
const STANDARD = new Set(['covered', 'needs-upgrade', 'new-standard-needed', 'not-applicable']);
const PROCESS = new Set(['covered', 'process-gap', 'not-applicable']);
const OUTCOME = new Set(['proposed', 'ratified', 'shipped', 'rejected', 'deferred', 'expired-unreviewed', 'no-action']);
const LIFECYCLE = new Set(['open', 'parked', 'resolved', 'superseded', 'reopened']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const KNOWN = ['semanticClassId', 'observations', 'effectiveOrigin', 'fillState', 'standardReview', 'processReview',
  'rationale', 'confidence', 'standardOutcome', 'processOutcome', 'reviewLifecycle', 'initiativeId', 'actionId',
  'authorityMachineId', 'recurrenceCount', 'deferredTrackingId', 'supersededBy', 'supersessionAudit',
  'createdAt', 'updatedAt', 'version'];

export const classReviewRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    const semanticClassId = bounded(raw.semanticClassId, 256);
    if (!semanticClassId) return null;
    const observations = Array.isArray(raw.observations) ? raw.observations.slice(0, 500).flatMap(clampObservation) : [];
    const standardRaw = object(raw.standardReview);
    const processRaw = object(raw.processReview);
    const standardVerdict = clampEnum(standardRaw?.verdict, STANDARD, 'not-applicable');
    const processVerdict = clampEnum(processRaw?.verdict, PROCESS, 'not-applicable');
    return {
      semanticClassId, observations,
      effectiveOrigin: clampEnum(raw.effectiveOrigin, ORIGIN, 'agent-self'),
      fillState: clampEnum(raw.fillState, FILL, 'pending'),
      ...(standardRaw ? { standardReview: {
        verdict: standardVerdict,
        ...(bounded(standardRaw.standardRef, 500) ? { standardRef: envelope(bounded(standardRaw.standardRef, 500)!) } : {}),
        ...(bounded(standardRaw.proposedDelta, 4000) ? { proposedDelta: envelope(bounded(standardRaw.proposedDelta, 4000)!) } : {}),
        isPolicyRelaxation: standardRaw.isPolicyRelaxation === true,
      } } : {}),
      ...(processRaw ? { processReview: {
        verdict: processVerdict,
        ...(bounded(processRaw.proposedDelta, 4000) ? { proposedDelta: envelope(bounded(processRaw.proposedDelta, 4000)!) } : {}),
      } } : {}),
      ...(bounded(raw.rationale, 4000) ? { rationale: envelope(bounded(raw.rationale, 4000)!) } : {}),
      ...(CONFIDENCE.has(String(raw.confidence)) ? { confidence: String(raw.confidence) } : {}),
      standardOutcome: clampEnum(raw.standardOutcome, OUTCOME, 'proposed'),
      processOutcome: clampEnum(raw.processOutcome, OUTCOME, 'proposed'),
      reviewLifecycle: clampEnum(raw.reviewLifecycle, LIFECYCLE, 'open'),
      authorityMachineId: bounded(raw.authorityMachineId, 256) ?? '',
      recurrenceCount: typeof raw.recurrenceCount === 'number' && Number.isFinite(raw.recurrenceCount)
        ? Math.max(0, Math.floor(raw.recurrenceCount)) : 0,
      ...(bounded(raw.deferredTrackingId, 256) ? { deferredTrackingId: bounded(raw.deferredTrackingId, 256) } : {}),
      ...(bounded(raw.supersededBy, 256) ? { supersededBy: bounded(raw.supersededBy, 256) } : {}),
      ...(clampSupersessionAudit(raw.supersessionAudit) ? { supersessionAudit: clampSupersessionAudit(raw.supersessionAudit) } : {}),
      ...(bounded(raw.initiativeId, 256) ? { initiativeId: bounded(raw.initiativeId, 256) } : {}),
      ...(bounded(raw.actionId, 256) ? { actionId: bounded(raw.actionId, 256) } : {}),
      createdAt: bounded(raw.createdAt, 64) ?? new Date(0).toISOString(),
      updatedAt: bounded(raw.updatedAt, 64) ?? new Date(0).toISOString(),
      version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.max(1, Math.floor(raw.version)) : 1,
    };
  },
};

export function buildClassReviewRecordData(input: { record: ClassReviewRecord; hlc: HlcTimestamp; op: ReplicatedOp; origin: string; observed?: HlcTimestamp }): Record<string, unknown> {
  const r = input.record;
  return {
    semanticClassId: r.semanticClassId, observations: r.observations, effectiveOrigin: r.effectiveOrigin,
    fillState: r.fillState, standardReview: r.standardReview, processReview: r.processReview,
    rationale: r.rationale, confidence: r.confidence, standardOutcome: r.standardOutcome,
    processOutcome: r.processOutcome, reviewLifecycle: r.reviewLifecycle, initiativeId: r.initiativeId,
    actionId: r.actionId, authorityMachineId: r.authorityMachineId, recurrenceCount: r.recurrenceCount,
    deferredTrackingId: r.deferredTrackingId, supersededBy: r.supersededBy, supersessionAudit: r.supersessionAudit,
    createdAt: r.createdAt, updatedAt: r.updatedAt, version: r.version,
    recordKey: r.dedupeKey, hlc: input.hlc, op: input.op, origin: input.origin,
    ...(input.observed ? { observed: input.observed } : {}),
  };
}

export const CLASS_REVIEW_KIND_REGISTRATION = {
  kind: CLASS_REVIEW_RECORD_KIND,
  store: CLASS_REVIEW_STORE_KEY,
  schema: classReviewRecordStoreSchema,
} as const;
export function classReviewTierOf(_store: string): ImpactTier { return CLASS_REVIEW_IMPACT_TIER; }

export function classReviewToOriginRecord(record: ClassReviewRecord, origin: string): OriginRecord {
  const physical = Date.parse(record.updatedAt);
  const envelope: ReplicatedEnvelope = {
    recordKey: record.dedupeKey,
    hlc: { physical: Number.isFinite(physical) ? physical : 0, logical: Math.max(0, record.version), node: origin },
    op: 'put', origin,
  };
  const { recordKey: _recordKey, hlc: _hlc, op: _op, origin: _origin, ...data } = buildClassReviewRecordData({ record, hlc: envelope.hlc, op: 'put', origin });
  return { origin, envelope, data };
}

export function classReviewFromOriginRecord(record: OriginRecord): ClassReviewRecord | null {
  if (record.envelope.op !== 'put') return null;
  const validated = classReviewRecordStoreSchema.validate(record.data, {
    countDroppedField: () => undefined,
    countJailReject: () => undefined,
  });
  if (!validated) return null;
  return {
    dedupeKey: record.envelope.recordKey,
    semanticClassId: String(validated.semanticClassId),
    observations: validated.observations as ClassReviewObservation[],
    effectiveOrigin: validated.effectiveOrigin as ClassReviewRecord['effectiveOrigin'],
    fillState: validated.fillState as ClassReviewRecord['fillState'],
    ...(validated.standardReview ? { standardReview: validated.standardReview as ClassReviewRecord['standardReview'] } : {}),
    ...(validated.processReview ? { processReview: validated.processReview as ClassReviewRecord['processReview'] } : {}),
    ...(validated.rationale ? { rationale: String(validated.rationale) } : {}),
    ...(validated.confidence ? { confidence: validated.confidence as ClassReviewRecord['confidence'] } : {}),
    standardOutcome: validated.standardOutcome as ClassReviewRecord['standardOutcome'],
    processOutcome: validated.processOutcome as ClassReviewRecord['processOutcome'],
    reviewLifecycle: validated.reviewLifecycle as ClassReviewRecord['reviewLifecycle'],
    // Replicated terminal dispositions are informational. Only the local
    // authenticated writer may operate lifecycle state.
    lifecycleAuthority: 'remote-advisory',
    authorityMachineId: String(validated.authorityMachineId || record.origin),
    recurrenceCount: Number(validated.recurrenceCount ?? 0),
    ...(validated.deferredTrackingId ? { deferredTrackingId: String(validated.deferredTrackingId) } : {}),
    ...(validated.supersededBy ? { supersededBy: String(validated.supersededBy) } : {}),
    ...(validated.supersessionAudit ? { supersessionAudit: validated.supersessionAudit as ClassReviewRecord['supersessionAudit'] } : {}),
    ...(validated.initiativeId ? { initiativeId: String(validated.initiativeId) } : {}),
    ...(validated.actionId ? { actionId: String(validated.actionId) } : {}),
    attemptCount: 0,
    createdAt: String(validated.createdAt), updatedAt: String(validated.updatedAt), version: Number(validated.version),
  };
}

function clampObservation(value: unknown): ClassReviewObservation[] {
  const row = object(value);
  const correctionId = bounded(row?.correctionId, 256);
  const machineId = bounded(row?.machineId, 256);
  const recordedAt = bounded(row?.recordedAt, 64);
  if (!correctionId || !machineId || !recordedAt) return [];
  return [{ correctionId, machineId, recordedAt,
    correctionOrigin: clampEnum(row?.correctionOrigin, ORIGIN, 'agent-self') as ClassReviewObservation['correctionOrigin'] }];
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function bounded(value: unknown, max: number): string | undefined { return typeof value === 'string' && value.length > 0 ? scrubSecrets(value).slice(0, max) : undefined; }
function clampEnum(value: unknown, values: Set<string>, fallback: string): string { return values.has(String(value)) ? String(value) : fallback; }
function envelope(value: string): string { return `<replicated-untrusted-data>${scrubSecrets(value)}</replicated-untrusted-data>`; }
function clampSupersessionAudit(value: unknown): ClassReviewRecord['supersessionAudit'] | undefined {
  const row = object(value); if (!row) return undefined;
  const actor = bounded(row.actor, 128); const reason = bounded(row.reason, 1000); const at = bounded(row.at, 64);
  return actor && reason && at ? { actor, reason, at } : undefined;
}
