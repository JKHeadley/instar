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
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];
export type ScanState = (typeof SCAN_STATES)[number];
export type SourceDetail = (typeof SOURCE_DETAILS)[number];
export type CapabilityStatus = 'available' | 'unavailable' | 'unknown' | 'stale' | 'conflict';

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

export function deriveStatus(entries: CapabilityEntry[], now = Date.now(), opts: { localStaleAfterMs?: number; remoteTtlCeilingMs?: number; lastConfirmedAt?: number } = {}): CapabilityStatus {
  if (!entries.length) return 'unknown';
  const byOutcome = new Set(entries.map(e => e.probeOutcome));
  if (byOutcome.size > 1) return 'conflict';
  if (entries.every(e => e.evidenceClass === 'manifest-only')) return 'unknown';
  if (entries.some(e => e.probeOutcome === 'unknown')) return 'unknown';
  const observedStale = entries.some(e => now - Date.parse(e.observedAt) > (opts.localStaleAfterMs ?? 86_400_000));
  const manifestStale = entries.some(e => e.evidence.manifestVerifiedAt !== undefined && now - Date.parse(e.evidence.manifestVerifiedAt) > (opts.localStaleAfterMs ?? 86_400_000));
  const transportStale = opts.lastConfirmedAt !== undefined && now - opts.lastConfirmedAt > (opts.remoteTtlCeilingMs ?? 600_000);
  if (transportStale || observedStale || manifestStale) return 'stale';
  return entries[0].probeOutcome === 'positive' ? 'available' : 'unavailable';
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
  const entries: CapabilityEntry[] = [];
  for (const door of body.doorways) {
    const d = door.probeStatus === 'never-scanned' ? null : door;
    for (const model of door.topModels) {
      if (!model.id) continue;
      const doorwayId = door.doorId;
      const scannedAt = d?.lastScannedAt ?? now;
      const capabilityId = canonicalCapabilityId(doorwayId, model.id);
      const common = { capabilityId, capabilityKind: 'model' as const, doorwayId, machineId, endpointRef: `mesh://${machineId}/doorways`, receivedAt: now, source: 'local-doorways' as const, evidence: { ...(d?.lastScannedAt ? { doorwayScanAt: d.lastScannedAt } : {}), ...(model.verifiedAt ? { manifestVerifiedAt: model.verifiedAt } : {}) } };
      entries.push({ ...common, probeOutcome: 'positive', observedAt: model.verifiedAt ?? now, sourceDetail: 'doorway-manifest', evidenceClass: 'manifest-only' });
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
