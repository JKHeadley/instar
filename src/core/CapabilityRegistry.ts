import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CAPABILITY_REGISTRY_SCHEMA_VERSION = 1;
export const MAX_ENTRIES_PER_MACHINE = 200;
export const MAX_STRING_LENGTH = 256;
export const MAX_SCHEMA_VERSION = 999;
export const MAX_MACHINE_EPOCH = 9_999_999_999;
export const MAX_PROJECTION_SEQ = 9_999_999_999;
export const MAX_SCAN_GENERATION = 9_999_999_999;

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
  scanGeneration: number; scanState: ScanState; truncated: boolean; entries: CapabilityEntry[];
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
    scanGeneration: int(r.scanGeneration, MAX_SCAN_GENERATION, 'scanGeneration'),
    scanState: oneOf(r.scanState, SCAN_STATES, 'scanState'), truncated: r.truncated === true,
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
  const digest = `cap1:${projection.schemaVersion}:${projection.machineEpoch}:${projection.projectionSeq}:${projection.truncated ? 1 : 0}:${state}:${projection.scanGeneration}:${hash}`;
  if (Buffer.byteLength(digest) > 64) throw new Error('digest-width'); return digest;
}

export function deriveStatus(entries: CapabilityEntry[], now = Date.now(), opts: { localStaleAfterMs?: number; remoteTtlCeilingMs?: number; lastConfirmedAt?: number } = {}): CapabilityStatus {
  if (!entries.length) return 'unknown';
  const byOutcome = new Set(entries.map(e => e.probeOutcome));
  if (byOutcome.size > 1) return 'conflict';
  if (entries.every(e => e.evidenceClass === 'manifest-only')) return 'unknown';
  if (entries.some(e => e.probeOutcome === 'unknown')) return 'unknown';
  const observedStale = entries.some(e => now - Date.parse(e.observedAt) > (opts.localStaleAfterMs ?? 86_400_000));
  const transportStale = opts.lastConfirmedAt !== undefined && now - opts.lastConfirmedAt > (opts.remoteTtlCeilingMs ?? 600_000);
  if (transportStale || observedStale) return 'stale';
  return entries[0].probeOutcome === 'positive' ? 'available' : 'unavailable';
}

export function readDoorwaySources(projectDir: string, stateDir: string, now = new Date().toISOString(), machineId = 'local'): { entries: CapabilityEntry[]; scanState: ScanState; scanGeneration: number } {
  const manifestPath = path.join(projectDir, 'scripts', 'model-registry-freshness.manifest.json');
  const scanPath = path.join(stateDir, 'state', 'doorway-scan.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const doors = (manifest.doors && typeof manifest.doors === 'object' ? manifest.doors : {}) as Record<string, any>;
  let scan: any = null; try { scan = JSON.parse(fs.readFileSync(scanPath, 'utf8')); } catch { /* no scan yet */ }
  const scanEntries = new Map<string, any>((Array.isArray(scan?.doorways) ? scan.doorways : []).map((d: any) => [d.id, d]));
  const entries: CapabilityEntry[] = [];
  for (const [doorwayId, door] of Object.entries(doors)) {
    const d = scanEntries.get(doorwayId); const scannedAt = d?.lastScannedAt ?? now;
    for (const model of (Array.isArray(door.topModels) ? door.topModels : [])) {
      if (!model?.id) continue;
      const capabilityId = canonicalCapabilityId(doorwayId, model.id);
      const common = { capabilityId, capabilityKind: 'model' as const, doorwayId, machineId, endpointRef: `mesh://${machineId}/doorways`, receivedAt: now, source: 'local-doorways' as const, evidence: { ...(typeof d?.lastScannedAt === 'string' ? { doorwayScanAt: d.lastScannedAt } : {}), ...(typeof manifest.lastReviewedAt === 'string' ? { manifestVerifiedAt: manifest.lastReviewedAt } : {}) } };
      entries.push({ ...common, probeOutcome: 'positive', observedAt: typeof manifest.lastReviewedAt === 'string' ? `${manifest.lastReviewedAt}T00:00:00Z` : now, sourceDetail: 'doorway-manifest', evidenceClass: 'manifest-only' });
      if (d) entries.push({ ...common, probeOutcome: d.probeStatus === 'ok' ? 'positive' : ['not-installed', 'http-4xx'].includes(d.probeStatus) ? 'negative' : 'unknown', observedAt: scannedAt, sourceDetail: 'doorway-scan', evidenceClass: d.probeStatus === 'ok' ? 'probe-answered' : 'cli-present' });
    }
  }
  return { entries, scanState: scan ? 'observed' : 'never-observed', scanGeneration: Number.isSafeInteger(scan?.scanGeneration) ? scan.scanGeneration : 0 };
}

export class CapabilityRegistryWriter {
  constructor(private readonly filePath: string, private readonly machineId: string) {}
  write(input: Omit<CapabilityProjection, 'machineId'>): CapabilityProjection {
    const previous = this.read(); let epoch = input.machineEpoch; let seq = input.projectionSeq;
    if (previous) { epoch = Math.max(epoch, previous.machineEpoch); seq = previous.machineEpoch === epoch ? previous.projectionSeq + 1 : seq; }
    let scanGeneration = input.scanGeneration;
    if (scanGeneration >= MAX_SCAN_GENERATION) { scanGeneration = 0; epoch = Math.max(Math.floor(Date.now() / 1000), epoch + 1); seq = 0; }
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
    const projection = validateProjection({ ...input, machineId: this.machineId, machineEpoch: epoch, projectionSeq: seq, scanGeneration, truncated, entries: sorted });
    const dir = path.dirname(this.filePath); fs.mkdirSync(dir, { recursive: true }); const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(projection, null, 2)); fs.renameSync(tmp, this.filePath); return projection;
  }
  read(): CapabilityProjection | null { try { return validateProjection(JSON.parse(fs.readFileSync(this.filePath, 'utf8'))); } catch { return null; } }
}
