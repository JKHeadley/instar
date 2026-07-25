import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDoorwayRegistry, scanStatePath } from './DoorwayRegistryReader.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1;
export const MAX_ENTRIES_PER_MACHINE = 200;
export const MAX_STRING_LENGTH = 256;
export const MAX_SCHEMA_VERSION = 999;
export const MAX_MACHINE_EPOCH = 9_999_999_999;
export const MAX_PROJECTION_SEQ = 9_999_999_999;
export const MAX_SCAN_STAMP_SECS = 9_999_999_999;

export const CAPABILITY_KINDS = ['model'] as const;
export const PROBE_OUTCOMES = ['positive', 'negative', 'unknown'] as const;
export const SCAN_STATES = ['observed', 'never-observed', 'source-unavailable'] as const;
export const SOURCES = ['local-doorways'] as const;
export const SOURCE_DETAILS = ['doorway-scan', 'doorway-manifest', 'pool-observation'] as const;
export const EVIDENCE_CLASSES = ['cli-present', 'probe-answered', 'manifest-only'] as const;
export const CAPABILITY_REGISTRY_FAILURE_REASONS = [
  'timeout',
  'stale-projection',
  'origin-mismatch',
  'clock-skew',
  'malformed',
  'version-unsupported',
  'over-limit',
  'source-unavailable',
  'not-participating',
  'no-data-yet',
] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];
export type ScanState = (typeof SCAN_STATES)[number];
export type SourceDetail = (typeof SOURCE_DETAILS)[number];
export type CapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'stale' | 'conflict';
export type CapabilityRegistryFailureReason = (typeof CAPABILITY_REGISTRY_FAILURE_REASONS)[number];

export interface CapabilityEvidence { doorwayScanAt?: string; manifestVerifiedAt?: string }
export interface CapabilityEntry {
  capabilityId: string; capabilityKind: 'model'; doorwayId: string; machineId: string;
  probeOutcome: ProbeOutcome; endpointRef: string; observedAt: string; receivedAt: string;
  source: 'local-doorways'; sourceDetail: SourceDetail;
  evidenceClass: (typeof EVIDENCE_CLASSES)[number]; evidence: CapabilityEvidence;
}
export interface CapabilityProjection {
  schemaVersion: number; machineId: string; machineEpoch: number; projectionSeq: number;
  scanStampSecs: number; scanState: ScanState; truncated: boolean; entries: CapabilityEntry[];
}

const int = (v: unknown, max: number, name: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error(`${name}-width`);
  return v as number;
};
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_STRING_LENGTH) throw new Error(`${name}-invalid`);
  return v;
};
const iso = (v: unknown, name: string): string => {
  const s = str(v, name); if (Number.isNaN(Date.parse(s))) throw new Error(`${name}-timestamp`); return s;
};
const isoOrAbsent = (v: unknown): string | undefined => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined;
const oneOf = <T extends readonly string[]>(v: unknown, values: T, name: string): T[number] => {
  if (!values.includes(v as string)) throw new Error(`${name}-enum`); return v as T[number];
};

export function canonicalCapabilityId(doorwayId: unknown, modelId: unknown): string {
  const d = str(doorwayId, 'doorwayId').toLowerCase(); const m = str(modelId, 'modelId').toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(d) || !/^[a-z0-9._-]+$/.test(m)) throw new Error('capability-id-invalid');
  return `models:${d}/${m}`;
}

function validateEntry(raw: unknown, machineId: string): CapabilityEntry {
  if (!raw || typeof raw !== 'object') throw new Error('entry-invalid');
  const r = raw as Record<string, unknown>;
  if (r.machineId !== machineId) throw new Error('origin-mismatch');
  const capabilityId = str(r.capabilityId, 'capabilityId');
  if (!/^models:[a-z0-9._-]+\/[a-z0-9._-]+$/.test(capabilityId)) throw new Error('capability-id-invalid');
  const doorwayId = str(r.doorwayId, 'doorwayId').toLowerCase();
  const endpointRef = str(r.endpointRef, 'endpointRef');
  if (!new RegExp(`^mesh://${escapeRegExp(machineId)}/doorways$`).test(endpointRef)) throw new Error('endpoint-ref-invalid');
  const evidence = r.evidence && typeof r.evidence === 'object' ? r.evidence as Record<string, unknown> : {};
  if (Object.keys(evidence).some(k => !['doorwayScanAt', 'manifestVerifiedAt'].includes(k))) throw new Error('evidence-keys');
  return {
    capabilityId, capabilityKind: oneOf(r.capabilityKind, CAPABILITY_KINDS, 'capabilityKind'), doorwayId,
    machineId, probeOutcome: oneOf(r.probeOutcome, PROBE_OUTCOMES, 'probeOutcome'), endpointRef,
    observedAt: iso(r.observedAt, 'observedAt'), receivedAt: iso(r.receivedAt, 'receivedAt'),
    source: oneOf(r.source, SOURCES, 'source'), sourceDetail: oneOf(r.sourceDetail, SOURCE_DETAILS, 'sourceDetail'),
    evidenceClass: oneOf(r.evidenceClass, EVIDENCE_CLASSES, 'evidenceClass'),
    evidence: { ...(evidence.doorwayScanAt ? { doorwayScanAt: iso(evidence.doorwayScanAt, 'doorwayScanAt') } : {}), ...(evidence.manifestVerifiedAt ? { manifestVerifiedAt: iso(evidence.manifestVerifiedAt, 'manifestVerifiedAt') } : {}) },
  };
}

export function validateProjection(raw: unknown): CapabilityProjection {
  if (!raw || typeof raw !== 'object') throw new Error('malformed'); const r = raw as Record<string, unknown>;
  const machineId = str(r.machineId, 'machineId');
  const schemaVersion = int(r.schemaVersion, MAX_SCHEMA_VERSION, 'schemaVersion');
  if (schemaVersion > CAPABILITY_REGISTRY_SCHEMA_VERSION) throw new Error('version-unsupported');
  if (!Array.isArray(r.entries) || r.entries.length > MAX_ENTRIES_PER_MACHINE) throw new Error('over-limit');
  const p: CapabilityProjection = {
    schemaVersion, machineId, machineEpoch: int(r.machineEpoch, MAX_MACHINE_EPOCH, 'machineEpoch'),
    projectionSeq: int(r.projectionSeq, MAX_PROJECTION_SEQ, 'projectionSeq'),
    scanStampSecs: int(r.scanStampSecs, MAX_SCAN_STAMP_SECS, 'scanStampSecs'),
    scanState: oneOf(r.scanState, SCAN_STATES, 'scanState'),
    truncated: typeof r.truncated === 'boolean' ? r.truncated : (() => { throw new Error('truncated-invalid'); })(),
    entries: r.entries.map(e => validateEntry(e, machineId)),
  };
  return p;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fact(e: CapabilityEntry): Record<string, unknown> { return { capabilityId: e.capabilityId, capabilityKind: e.capabilityKind, doorwayId: e.doorwayId, machineId: e.machineId, probeOutcome: e.probeOutcome, endpointRef: e.endpointRef, source: e.source, sourceDetail: e.sourceDetail, evidenceClass: e.evidenceClass }; }
export function canonicalDigest(projection: CapabilityProjection): string {
  const entries = [...projection.entries].sort((a, b) => `${a.doorwayId}\0${a.capabilityId}\0${a.sourceDetail}`.localeCompare(`${b.doorwayId}\0${b.capabilityId}\0${b.sourceDetail}`));
  const serialized = JSON.stringify(entries.map(fact));
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16);
  const state = SCAN_STATES.indexOf(projection.scanState);
  const digest = `cap1:${projection.schemaVersion}:${projection.machineEpoch}:${projection.projectionSeq}:${projection.truncated ? 1 : 0}:${state}:${projection.scanStampSecs}:${hash}`;
  if (Buffer.byteLength(digest) > 64) throw new Error('digest-width'); return digest;
}

export function deriveStatus(entries: CapabilityEntry[], now = Date.now(), opts: { localStaleAfterMs?: number; manifestStaleAfterMs?: number; remoteTtlCeilingMs?: number; lastConfirmedAt?: number } = {}): CapabilityStatus {
  if (!entries.length) return 'unknown';
  const byOutcome = new Set(entries.map(e => e.probeOutcome));
  if (byOutcome.size > 1) return 'conflict';
  if (entries.every(e => e.evidenceClass === 'manifest-only')) return 'unknown';
  if (entries.some(e => e.probeOutcome === 'unknown')) return 'unknown';
  const observedStale = entries.some(e => now - Date.parse(e.observedAt) > (opts.localStaleAfterMs ?? 86_400_000));
  const manifestStale = entries.some(e => e.evidence.manifestVerifiedAt !== undefined && now - Date.parse(e.evidence.manifestVerifiedAt) > (opts.manifestStaleAfterMs ?? 45 * 86_400_000));
  const transportStale = opts.lastConfirmedAt !== undefined && now - opts.lastConfirmedAt > (opts.remoteTtlCeilingMs ?? 600_000);
  if (transportStale || observedStale || manifestStale) return 'stale';
  return entries[0].probeOutcome === 'positive' ? 'available' : 'unavailable';
}

export interface CapabilityDigestParts {
  schemaVersion: number; machineEpoch: number; projectionSeq: number; truncated: boolean;
  scanState: ScanState; scanStampSecs: number; entriesHash: string; tuple: string;
}

export function parseCapabilityDigest(raw: unknown): CapabilityDigestParts {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64) throw new Error('malformed');
  const parts = raw.split(':');
  if (parts.length !== 8 || parts[0] !== 'cap1') throw new Error('malformed');
  const schemaVersion = int(Number(parts[1]), MAX_SCHEMA_VERSION, 'schemaVersion');
  if (schemaVersion > CAPABILITY_REGISTRY_SCHEMA_VERSION) throw new Error('version-unsupported');
  const machineEpoch = int(Number(parts[2]), MAX_MACHINE_EPOCH, 'machineEpoch');
  const projectionSeq = int(Number(parts[3]), MAX_PROJECTION_SEQ, 'projectionSeq');
  if (!['0', '1'].includes(parts[4])) throw new Error('malformed');
  const scanStateIdx = int(Number(parts[5]), SCAN_STATES.length - 1, 'scanState');
  const scanStampSecs = int(Number(parts[6]), MAX_SCAN_STAMP_SECS, 'scanStampSecs');
  if (!/^[0-9a-f]{16}$/.test(parts[7])) throw new Error('malformed');
  const tuple = `${schemaVersion}:${parts[4]}:${scanStateIdx}:${scanStampSecs}:${parts[7]}`;
  return { schemaVersion, machineEpoch, projectionSeq, truncated: parts[4] === '1', scanState: SCAN_STATES[scanStateIdx], scanStampSecs, entriesHash: parts[7], tuple };
}

export type CapabilityHeartbeatProof =
  | { kind: 'sequence'; value: number }
  | { kind: 'signed-time'; value: string | number | Date };

export type CapabilityRegistryIngestResult =
  | { status: 'accepted'; digest: string }
  | { status: 'noop'; digest: string }
  | { status: 'pull-required'; digest: string }
  | { status: 'pull-suppressed'; reason: CapabilityRegistryFailureReason }
  | { status: 'rejected'; reason: CapabilityRegistryFailureReason };

export type CapabilityRegistryPoolRow =
  | { kind: 'failure'; machineId: string; reason: CapabilityRegistryFailureReason }
  | { kind: 'capability'; machineId: string; entry: CapabilityEntry; status: CapabilityStatus };

interface CapabilityReceiverOriginState {
  projection?: CapabilityProjection;
  digest?: string;
  digestTuple?: string;
  watermark?: { machineEpoch: number; projectionSeq: number; lastAcceptedAt: number };
  lastConfirmedAt?: number;
  lastHeartbeatSequence?: number;
  lastHeartbeatSignedTime?: number;
  failureReason?: CapabilityRegistryFailureReason;
  pullFailures: number;
  breakerOpenUntil?: number;
  notParticipating?: boolean;
}

export interface CapabilityRegistryReceiverOptions {
  remoteTtlCeilingMs?: number;
  localStaleAfterMs?: number;
  manifestStaleAfterMs?: number;
  epochClampBoundMs?: number;
  watermarkMaxAgeMs?: number;
  pullFailureBreakerThreshold?: number;
  pullBreakerMs?: number;
}

// RULE 3: EXEMPT — ingest consumes only validated in-repo projections and never raw provider or tmux output, so a state-detection canary has no external format to exercise.
export class CapabilityRegistryReceiver {
  private readonly states = new Map<string, CapabilityReceiverOriginState>();
  private readonly opts: Required<CapabilityRegistryReceiverOptions>;

  constructor(opts: CapabilityRegistryReceiverOptions = {}) {
    this.opts = {
      remoteTtlCeilingMs: opts.remoteTtlCeilingMs ?? 600_000,
      localStaleAfterMs: opts.localStaleAfterMs ?? 86_400_000,
      manifestStaleAfterMs: opts.manifestStaleAfterMs ?? 45 * 86_400_000,
      epochClampBoundMs: opts.epochClampBoundMs ?? 86_400_000,
      watermarkMaxAgeMs: opts.watermarkMaxAgeMs ?? 86_400_000,
      pullFailureBreakerThreshold: opts.pullFailureBreakerThreshold ?? 5,
      pullBreakerMs: opts.pullBreakerMs ?? 600_000,
    };
  }

  ingestProjection(origin: string, raw: unknown, now = Date.now(), confirmed = true): CapabilityRegistryIngestResult {
    let projection: CapabilityProjection;
    try {
      projection = validateProjection(raw);
    } catch (error) {
      return this.reject(origin, mapProjectionError(error));
    }
    if (projection.machineId !== origin) return this.reject(origin, 'origin-mismatch');
    if (projection.machineEpoch > Math.floor((now + this.opts.epochClampBoundMs) / 1000)) return this.reject(origin, 'clock-skew');
    try {
      projection = this.receiverStampedProjection(projection, now);
    } catch (error) {
      return this.reject(origin, mapProjectionError(error));
    }
    const digest = canonicalDigest(projection);
    const state = this.state(origin);
    this.ageWatermark(state, now);
    const monotonic = this.compareWatermark(state, projection.machineEpoch, projection.projectionSeq, digest);
    if (monotonic === 'reject') return this.reject(origin, 'stale-projection');
    if (monotonic === 'noop') {
      state.failureReason = undefined;
      state.notParticipating = false;
      return { status: 'noop', digest };
    }
    state.projection = projection;
    state.digest = digest;
    state.digestTuple = parseCapabilityDigest(digest).tuple;
    state.watermark = { machineEpoch: projection.machineEpoch, projectionSeq: projection.projectionSeq, lastAcceptedAt: now };
    if (confirmed) state.lastConfirmedAt = now;
    state.failureReason = undefined;
    state.notParticipating = false;
    state.pullFailures = 0;
    state.breakerOpenUntil = undefined;
    return { status: 'accepted', digest };
  }

  ingestHeartbeat(origin: string, digestRaw: unknown, now = Date.now(), proof?: CapabilityHeartbeatProof): CapabilityRegistryIngestResult {
    const state = this.state(origin);
    if (digestRaw === undefined || digestRaw === null || digestRaw === '') {
      state.notParticipating = true;
      state.failureReason = 'not-participating';
      return { status: 'rejected', reason: 'not-participating' };
    }
    let digest: CapabilityDigestParts;
    try {
      digest = parseCapabilityDigest(digestRaw);
    } catch (error) {
      return this.reject(origin, mapProjectionError(error));
    }
    if (digest.machineEpoch > Math.floor((now + this.opts.epochClampBoundMs) / 1000)) return this.reject(origin, 'clock-skew');
    this.ageWatermark(state, now);
    const rendered = digestRaw as string;
    const monotonic = this.compareWatermarkParts(state, digest, rendered);
    if (monotonic === 'reject') return this.reject(origin, 'stale-projection');
    const fresh = this.acceptHeartbeatProof(state, now, proof);
    if (monotonic === 'noop') {
      return { status: 'noop', digest: rendered };
    }
    if (state.digestTuple === digest.tuple) {
      state.watermark = { machineEpoch: digest.machineEpoch, projectionSeq: digest.projectionSeq, lastAcceptedAt: now };
      state.digest = rendered;
      if (fresh) state.lastConfirmedAt = now;
      return { status: 'noop', digest: rendered };
    }
    if (state.breakerOpenUntil !== undefined && state.breakerOpenUntil > now) return { status: 'pull-suppressed', reason: 'timeout' };
    return { status: 'pull-required', digest: rendered };
  }

  ingestPullResponse(origin: string, response: unknown, expectedNonce: string, now = Date.now()): CapabilityRegistryIngestResult {
    if (!response || typeof response !== 'object') return this.reject(origin, 'malformed');
    const r = response as Record<string, unknown>;
    if (r.nonce !== expectedNonce) return this.recordPullFailure(origin, 'malformed', now);
    return this.ingestProjection(origin, r.projection, now, true);
  }

  recordPullFailure(origin: string, reason: CapabilityRegistryFailureReason = 'timeout', now = Date.now()): CapabilityRegistryIngestResult {
    const state = this.state(origin);
    state.pullFailures += 1;
    state.failureReason = reason;
    if (state.pullFailures >= this.opts.pullFailureBreakerThreshold) state.breakerOpenUntil = now + this.opts.pullBreakerMs;
    return { status: 'rejected', reason };
  }

  classifyMachine(origin: string, now = Date.now()): CapabilityRegistryPoolRow[] {
    const state = this.states.get(origin);
    if (!state) return [{ kind: 'failure', machineId: origin, reason: 'no-data-yet' }];
    if (state.notParticipating) return [{ kind: 'failure', machineId: origin, reason: 'not-participating' }];
    if (state.failureReason && !state.projection) return [{ kind: 'failure', machineId: origin, reason: state.failureReason }];
    if (!state.projection) return [{ kind: 'failure', machineId: origin, reason: state.failureReason ?? 'no-data-yet' }];
    if (state.projection.scanState === 'source-unavailable') return [{ kind: 'failure', machineId: origin, reason: 'source-unavailable' }];
    if (state.projection.scanState === 'never-observed') return [{ kind: 'failure', machineId: origin, reason: 'no-data-yet' }];
    return state.projection.entries.map(entry => ({
      kind: 'capability' as const,
      machineId: origin,
      entry,
      status: deriveStatus([entry], now, {
        localStaleAfterMs: this.opts.localStaleAfterMs,
        manifestStaleAfterMs: this.opts.manifestStaleAfterMs,
        remoteTtlCeilingMs: this.opts.remoteTtlCeilingMs,
        lastConfirmedAt: state.lastConfirmedAt,
      }),
    }));
  }

  classifyPool(machineIds: string[], now = Date.now()): CapabilityRegistryPoolRow[] {
    return machineIds.flatMap(machineId => this.classifyMachine(machineId, now));
  }

  getLastConfirmedAt(origin: string): number | undefined { return this.states.get(origin)?.lastConfirmedAt; }
  getFailureReason(origin: string): CapabilityRegistryFailureReason | undefined { return this.states.get(origin)?.failureReason; }

  private state(origin: string): CapabilityReceiverOriginState {
    const current = this.states.get(origin);
    if (current) return current;
    const next: CapabilityReceiverOriginState = { pullFailures: 0 };
    this.states.set(origin, next);
    return next;
  }

  private reject(origin: string, reason: CapabilityRegistryFailureReason): CapabilityRegistryIngestResult {
    const state = this.state(origin);
    state.failureReason = reason;
    return { status: 'rejected', reason };
  }

  private receiverStampedProjection(projection: CapabilityProjection, now: number): CapabilityProjection {
    const nowIso = new Date(now).toISOString();
    const clampObservedAt = (raw: string): string => {
      const t = Date.parse(raw);
      if (t > now + this.opts.epochClampBoundMs) throw new Error('clock-skew');
      return t > now ? nowIso : raw;
    };
    try {
      return {
        ...projection,
        entries: projection.entries.map(entry => ({ ...entry, observedAt: clampObservedAt(entry.observedAt), receivedAt: nowIso })),
      };
    } catch (error) {
      throw error instanceof Error && error.message === 'clock-skew' ? error : new Error('malformed');
    }
  }

  private ageWatermark(state: CapabilityReceiverOriginState, now: number): void {
    if (state.watermark && now - state.watermark.lastAcceptedAt > this.opts.watermarkMaxAgeMs) state.watermark = undefined;
  }

  private compareWatermark(state: CapabilityReceiverOriginState, epoch: number, seq: number, digest: string): 'accept' | 'noop' | 'reject' {
    if (!state.watermark) return 'accept';
    if (epoch < state.watermark.machineEpoch || (epoch === state.watermark.machineEpoch && seq < state.watermark.projectionSeq)) return 'reject';
    if (epoch === state.watermark.machineEpoch && seq === state.watermark.projectionSeq) return digest === state.digest ? 'noop' : 'reject';
    return 'accept';
  }

  private compareWatermarkParts(state: CapabilityReceiverOriginState, parts: CapabilityDigestParts, rendered: string): 'accept' | 'noop' | 'reject' {
    if (!state.watermark) return 'accept';
    if (parts.machineEpoch < state.watermark.machineEpoch || (parts.machineEpoch === state.watermark.machineEpoch && parts.projectionSeq < state.watermark.projectionSeq)) return 'reject';
    if (parts.machineEpoch === state.watermark.machineEpoch && parts.projectionSeq === state.watermark.projectionSeq) return rendered === state.digest ? 'noop' : 'reject';
    return 'accept';
  }

  private acceptHeartbeatProof(state: CapabilityReceiverOriginState, now: number, proof?: CapabilityHeartbeatProof): boolean {
    if (!proof) return false;
    if (proof.kind === 'sequence') {
      if (!Number.isSafeInteger(proof.value) || proof.value <= (state.lastHeartbeatSequence ?? -1)) return false;
      state.lastHeartbeatSequence = proof.value;
      return true;
    }
    const t = proof.value instanceof Date ? proof.value.getTime() : typeof proof.value === 'number' ? proof.value : Date.parse(proof.value);
    if (!Number.isFinite(t) || Math.abs(t - now) > this.opts.epochClampBoundMs || t <= (state.lastHeartbeatSignedTime ?? -Infinity)) return false;
    state.lastHeartbeatSignedTime = t;
    return true;
  }
}

function mapProjectionError(error: unknown): CapabilityRegistryFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'version-unsupported') return 'version-unsupported';
  if (message === 'over-limit') return 'over-limit';
  if (message === 'origin-mismatch') return 'origin-mismatch';
  if (message === 'clock-skew') return 'clock-skew';
  return 'malformed';
}

export function readDoorwaySources(projectDir: string, stateDir: string, now = new Date().toISOString(), machineId = 'local'): { entries: CapabilityEntry[]; scanState: ScanState; scanStampSecs: number } {
  const scanPath = scanStatePath(stateDir);
  const scanExists = fs.existsSync(scanPath);
  let scanReadable = false;
  if (scanExists) {
    try { JSON.parse(fs.readFileSync(scanPath, 'utf8')); scanReadable = true; }
    catch (error) {
      DegradationReporter.getInstance().report({ feature: 'CapabilityRegistry.scanState', primary: 'Readable doorway scan-state', fallback: 'Source-unavailable projection state', reason: `scan-state parse failed: ${error instanceof Error ? error.message : String(error)}`, impact: 'Local doorway freshness is unavailable until the next successful scan.' });
    }
  }
  const result = readDoorwayRegistry({ projectDir, stateDir });
  if (result.status !== 'ok') throw new Error(`doorway-registry-${result.status}`);
  const { body } = result;
  const scanState: ScanState = !scanReadable && scanExists ? 'source-unavailable' : body.scanState === 'scanned' ? 'observed' : 'never-observed';
  const scanStampSecs = body.lastScanAt ? Math.floor(Date.parse(body.lastScanAt) / 1000) : 0;
  let manifestReviewedAt: string | undefined;
  try { manifestReviewedAt = isoOrAbsent((JSON.parse(fs.readFileSync(path.join(projectDir, 'scripts/model-registry-freshness.manifest.json'), 'utf8')) as Record<string, unknown>).lastReviewedAt); } catch { /* canonical reader owns manifest failure classification */ }
  const entries: CapabilityEntry[] = [];
  for (const door of body.doorways) {
    const d = door.probeStatus === 'never-scanned' ? null : door;
    for (const model of door.topModels) {
      if (!model.id) continue;
      const doorwayId = door.doorId;
      const scannedAt = d?.lastScannedAt ?? now;
      const capabilityId = canonicalCapabilityId(doorwayId, model.id);
      const manifestVerifiedAt = isoOrAbsent(model.verifiedAt) ?? manifestReviewedAt;
      const common = { capabilityId, capabilityKind: 'model' as const, doorwayId, machineId, endpointRef: `mesh://${machineId}/doorways`, receivedAt: now, source: 'local-doorways' as const, evidence: { ...(d?.lastScannedAt ? { doorwayScanAt: d.lastScannedAt } : {}), ...(manifestVerifiedAt ? { manifestVerifiedAt } : {}) } };
      entries.push({ ...common, probeOutcome: 'positive', observedAt: manifestVerifiedAt ?? now, sourceDetail: 'doorway-manifest', evidenceClass: 'manifest-only' });
      if (d) entries.push({ ...common, probeOutcome: d.probeStatus === 'ok' ? 'positive' : ['not-installed', 'http-4xx'].includes(d.probeStatus) ? 'negative' : 'unknown', observedAt: scannedAt, sourceDetail: 'doorway-scan', evidenceClass: d.probeStatus === 'ok' ? 'probe-answered' : 'cli-present' });
    }
  }
  return { entries, scanState, scanStampSecs };
}

export class CapabilityRegistryWriter {
  constructor(private readonly filePath: string, private readonly machineId: string) {}
  write(input: Omit<CapabilityProjection, 'machineId'>): CapabilityProjection {
    const previous = this.read(); let epoch = input.machineEpoch; let seq = input.projectionSeq;
    if (previous) { epoch = Math.max(epoch, previous.machineEpoch); seq = previous.machineEpoch === epoch ? previous.projectionSeq + 1 : seq; }
    const scanStampSecs = input.scanStampSecs;
    if (seq >= MAX_PROJECTION_SEQ) { epoch = Math.max(Math.floor(Date.now() / 1000), epoch + 1); seq = 0; }
    const sorted = [...input.entries].sort((a, b) => `${a.doorwayId}\0${a.capabilityId}\0${a.sourceDetail}`.localeCompare(`${b.doorwayId}\0${b.capabilityId}\0${b.sourceDetail}`));
    let truncated = input.truncated;
    if (sorted.length > MAX_ENTRIES_PER_MACHINE) {
      const kept: CapabilityEntry[] = []; let i = 0;
      while (i < sorted.length && kept.length < MAX_ENTRIES_PER_MACHINE) {
        const id = sorted[i].capabilityId; const group = sorted.filter(e => e.capabilityId === id);
        if (kept.length + group.length > MAX_ENTRIES_PER_MACHINE) break;
        kept.push(...group); i += group.length;
      }
      sorted.splice(0, sorted.length, ...kept); truncated = true;
    }
    if (!previous) epoch = Math.max(Math.floor(Date.now() / 1000), epoch);
    const projection = validateProjection({ ...input, machineId: this.machineId, machineEpoch: epoch, projectionSeq: seq, scanStampSecs, truncated, entries: sorted });
    const dir = path.dirname(this.filePath); fs.mkdirSync(dir, { recursive: true }); const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(projection, null, 2)); fs.renameSync(tmp, this.filePath); return projection;
  }
  read(): CapabilityProjection | null {
    if (!fs.existsSync(this.filePath)) return null;
    try { return validateProjection(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); }
    catch (error) {
      DegradationReporter.getInstance().report({ feature: 'CapabilityRegistry.projection', primary: 'Valid local capability projection', fallback: 'Fresh projection rebuild', reason: `projection read failed: ${error instanceof Error ? error.message : String(error)}`, impact: 'The registry will rebuild from current local doorway sources.' });
      return null;
    }
  }
}
