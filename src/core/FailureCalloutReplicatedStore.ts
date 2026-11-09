/** Failure evidence rides the existing authenticated journal/peer-stream substrate.
 * Chunks stay below its 80KiB entry bound; incomplete versions never become cases.
 * Replicas are read evidence only. The origin remains the sole CAS writer.
 */
import { createHash } from 'node:crypto';
import type { StoreFieldSchema } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { OriginRecord } from './UnionReader.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';
import type { CorrectionRecord } from '../monitoring/CorrectionLedger.js';
import { scrubFailureContext, type FailureCase } from '../monitoring/FailureCallout.js';
import { resolveCorrectionLearningMode } from './correctionLearningMode.js';
import type { InstarConfig } from './types.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';

/** Default forensic continuity uses the established transport; explicit opt-outs
 * win. Its implicit activation never enables placement/working-set replication.
 */
export function resolveFailureReplicationTransport(config: Pick<InstarConfig, 'monitoring' | 'multiMachine'>, legacyJournalDefault = false) {
  const cj = config.multiMachine?.coherenceJournal;
  const forensicDefault = resolveCorrectionLearningMode(config).failureCalloutsEnabled;
  const storeEnabled = (config.multiMachine?.stateSync?.failureCallout as { enabled?: boolean } | undefined)?.enabled !== false;
  const failureEvidenceEnabled = forensicDefault && storeEnabled;
  const journalEnabled = cj?.enabled ?? (forensicDefault || legacyJournalDefault);
  const replicationEnabled = journalEnabled && (cj?.replication?.enabled ?? failureEvidenceEnabled);
  return { journalEnabled, replicationEnabled, failureOnly: replicationEnabled && cj?.replication?.enabled !== true, failureEvidenceEnabled };
}

/** One policy for both incoming mesh RPC and outgoing puller seams. */
export function isFailureReplicationKindAllowed(mode: { replicationEnabled: boolean; failureOnly: boolean; failureEvidenceEnabled?: boolean }, kind: unknown): boolean {
  return mode.replicationEnabled && typeof kind === 'string'
    && (kind !== 'failure-callout-chunk' || mode.failureEvidenceEnabled !== false)
    && (!mode.failureOnly || kind === 'failure-callout-chunk');
}
export function filterFailureReplicationBatch<T extends { kind: string }>(mode: { replicationEnabled: boolean; failureOnly: boolean; failureEvidenceEnabled?: boolean }, batch: T[]): T[] {
  return batch.filter(stream => isFailureReplicationKindAllowed(mode, stream.kind));
}

export const FAILURE_CALLOUT_STORE_KEY = 'failureCallout';
export const FAILURE_CALLOUT_RECORD_KIND = 'failure-callout-chunk';
const CHUNK_BYTES = 32 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
export interface FailureReplica { machineId: string; record: CorrectionRecord; }
export interface FailureReplicaReader {
  all(): FailureReplica[];
  episodes(id: string, machineId: string): Array<{ version: number; archivedAt: string; episode: FailureCase }>;
}
export interface FailureReplicationEmitter { emitPut(record: CorrectionRecord): void; }
interface Chunk { caseId: string; version: number; digest: string; index: number; total: number; chunk: string; type: 'record' | 'episode'; }
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const str = (v: unknown, max = 4000) => typeof v === 'string' ? scrubSecrets(v).slice(0, max) : '';
const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Math.floor(number(v, min, max));
const strings = (v: unknown) => Array.isArray(v) ? v.slice(0, 20).map(x => str(x)) : [];
function cleanCase(raw: unknown): FailureCase | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as FailureCase;
  if (!['captured', 'investigated', 'verified', 'reopened'].includes(r.state)) return null;
  const c: FailureCase = { state: r.state, updatedAt: str(r.updatedAt, 64), context: scrubFailureContext(r.context) };
  if (r.investigation && ['constitution-gap', 'enforcement-gap'].includes(r.investigation.classification)) c.investigation = {
    classification: r.investigation.classification, standardRefs: strings(r.investigation.standardRefs), rootCause: str(r.investigation.rootCause),
    classFix: str(r.investigation.classFix), fixRefs: strings(r.investigation.fixRefs),
  };
  if (r.verification) c.verification = { scenario: str(r.verification.scenario), baselineRef: str(r.verification.baselineRef),
    replayRef: str(r.verification.replayRef), allowedCaseRef: str(r.verification.allowedCaseRef),
    replayPassed: r.verification.replayPassed === true, allowedCasePassed: r.verification.allowedCasePassed === true,
    ...(typeof (r.verification as any).paraphraseRef === 'string' ? { paraphraseRef: str((r.verification as any).paraphraseRef), paraphrasePassed: (r.verification as any).paraphrasePassed === true } : {}),
  } as FailureCase['verification'];
  if (Array.isArray(r.history)) c.history = r.history.slice(-5).flatMap(e => { const one = cleanCase({ ...e, history: undefined }); return one ? [one] : []; });
  return c;
}
function cleanRecord(raw: unknown): CorrectionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as CorrectionRecord, failureCase = cleanCase(r.failureCase);
  if (!failureCase || !r.id || !r.dedupeKey || !['infra-gap', 'user-preference', 'noise'].includes(r.kind)
    || !Number.isSafeInteger(r.version) || r.version < 1) return null;
  return { id: str(r.id, 256), dedupeKey: str(r.dedupeKey, 256), kind: r.kind, severity: 'failure-callout', failureCase,
    ...(r.investigationAdmission ? { investigationAdmission: {
      occurrenceCount: integer(r.investigationAdmission.occurrenceCount, 1), attempts: integer(r.investigationAdmission.attempts, 0, 3), maxAttempts: 3 as const,
      nextAttemptAt: typeof r.investigationAdmission.nextAttemptAt === 'string' ? str(r.investigationAdmission.nextAttemptAt, 64) : null,
      paused: r.investigationAdmission.paused === true,
      ...(r.investigationAdmission.resumeEvidenceRef ? { resumeEvidenceRef: str(r.investigationAdmission.resumeEvidenceRef) } : {}),
    } } : {}),
    learning: str(r.learning, 2000), scrubbedSummary: str(r.scrubbedSummary, 500), occurrenceCount: integer(r.occurrenceCount, 1),
    detectedAt: str(r.detectedAt, 64), dayBucket: str(r.dayBucket, 64), deterministicWeight: integer(r.deterministicWeight, 0, 100),
    llmConfidence: number(r.llmConfidence, 0, 1), topicId: Number.isSafeInteger(r.topicId) && Number(r.topicId) >= 0 ? r.topicId : null, sessionId: null,
    status: ['open', 'acted-on', 'verified', 'inconclusive', 'reopened'].includes(r.status) ? r.status : 'open',
    reopenCount: integer(r.reopenCount), createdAt: str(r.createdAt, 64), updatedAt: str(r.updatedAt, 64), version: r.version };
}
export function failureSnapshotChunks(record: CorrectionRecord, episode?: { version: number; archivedAt: string; episode: FailureCase }): Array<{ key: string; data: Chunk }> {
  const cleaned = cleanRecord(record); if (!cleaned) return [];
  const value = episode ? { caseId: cleaned.id, version: episode.version, archivedAt: str(episode.archivedAt, 64), episode: cleanCase(episode.episode) } : cleaned;
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BYTES) throw new Error('failure snapshot exceeds bound');
  const hash = digest(bytes), total = Math.ceil(bytes.length / CHUNK_BYTES), type = episode ? 'episode' : 'record';
  const version = episode?.version ?? cleaned.version;
  return Array.from({ length: total }, (_, index) => ({
    key: `${digest(cleaned.id)}:${type}:${version}:${hash}:${index}`,
    data: { caseId: cleaned.id, version, digest: hash, index, total, chunk: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'), type },
  }));
}
export const failureCalloutStoreSchema: StoreFieldSchema = {
  knownFields: ['caseId', 'version', 'digest', 'index', 'total', 'chunk', 'type'],
  validate(raw) {
    if (typeof raw.caseId !== 'string' || !raw.caseId || raw.caseId.length > 256 || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1
      || typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.digest) || !Number.isSafeInteger(raw.index)
      || !Number.isSafeInteger(raw.total) || Number(raw.total) < 1 || Number(raw.total) > MAX_BYTES / CHUNK_BYTES
      || Number(raw.index) < 0 || Number(raw.index) >= Number(raw.total) || typeof raw.chunk !== 'string'
      || raw.chunk.length > 44000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.chunk) || !['record', 'episode'].includes(String(raw.type))) return null;
    return { caseId: raw.caseId, version: raw.version, digest: raw.digest, index: raw.index, total: raw.total, chunk: raw.chunk, type: raw.type };
  },
};
export const FAILURE_CALLOUT_KIND_REGISTRATION = { kind: FAILURE_CALLOUT_RECORD_KIND, store: FAILURE_CALLOUT_STORE_KEY, schema: failureCalloutStoreSchema } as const;
export function buildFailureChunkData(chunk: { key: string; data: Chunk }, hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> {
  return { ...chunk.data, recordKey: chunk.key, hlc, origin, op: 'put', ...(observed ? { observed } : {}) };
}
export function failureReplicationEmitter(emitter: ReplicatedRecordEmitter): FailureReplicationEmitter {
  return { emitPut(record) { for (const chunk of [...failureSnapshotChunks(record), ...failureSnapshotChunks(record, { version: record.version, archivedAt: record.failureCase!.updatedAt, episode: { ...record.failureCase!, history: undefined } })]) emitter.emit(FAILURE_CALLOUT_STORE_KEY, chunk.key, (hlc, origin, observed) => buildFailureChunkData(chunk, hlc, origin, observed)); } };
}
export interface FailureOriginSource { loadAllOriginRecords(store: string): Map<string, OriginRecord[]>; }
export function failureReplicaReader(source: FailureOriginSource, droppedOrigins: () => ReadonlySet<string> = () => new Set()): FailureReplicaReader {
  function load(): Array<{ machineId: string; type: string; value: any }> {
    const dropped = droppedOrigins();
    const groups = new Map<string, { machineId: string; data: Chunk; chunks: Map<number, string> }>();
    for (const records of source.loadAllOriginRecords(FAILURE_CALLOUT_STORE_KEY).values()) for (const record of records) {
      if (record.envelope.op !== 'put' || record.origin !== record.envelope.origin || dropped.has(record.origin)) continue;
      const valid = failureCalloutStoreSchema.validate(record.data, { countDroppedField() {}, countJailReject() {} }) as unknown as Chunk | null;
      if (!valid) continue;
      const expected = `${digest(valid.caseId)}:${valid.type}:${valid.version}:${valid.digest}:${valid.index}`;
      if (record.envelope.recordKey !== expected) continue;
      const key = JSON.stringify([record.origin, valid.caseId, valid.type, valid.version, valid.digest]);
      let group = groups.get(key);
      if (!group) { group = { machineId: record.origin, data: valid, chunks: new Map() }; groups.set(key, group); }
      if (group.data.total === valid.total) group.chunks.set(valid.index, valid.chunk);
    }
    const rows: Array<{ machineId: string; type: string; value: any }> = [];
    for (const group of groups.values()) {
      if (group.chunks.size !== group.data.total) continue;
      const bytes = Buffer.concat(Array.from({ length: group.data.total }, (_, i) => Buffer.from(group.chunks.get(i)!, 'base64')));
      if (bytes.length > MAX_BYTES || digest(bytes) !== group.data.digest) continue;
      try { const value = JSON.parse(bytes.toString()); if ((value.id ?? value.caseId) === group.data.caseId && value.version === group.data.version) rows.push({ machineId: group.machineId, type: group.data.type, value }); } catch { /* incomplete/invalid evidence is never a case */ }
    }
    return rows;
  }
  return {
    all() {
      const latest = new Map<string, FailureReplica>();
      for (const row of load()) { if (row.type !== 'record') continue; const record = cleanRecord(row.value); if (!record) continue;
        const key = JSON.stringify([row.machineId, record.id]); if ((latest.get(key)?.record.version ?? 0) < record.version) latest.set(key, { machineId: row.machineId, record }); }
      return [...latest.values()];
    },
    episodes(id, machineId) { return load().filter(row => row.type === 'episode' && row.machineId === machineId && row.value.caseId === id)
      .flatMap(row => { const episode = cleanCase(row.value.episode); return episode ? [{ version: Number(row.value.version), archivedAt: str(row.value.archivedAt, 64), episode }] : []; }); },
  };
}
