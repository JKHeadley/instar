/** EVO-022: full memory custody, shared with the existing action auto-expiry archive. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ActionArchiveEntry, ActionItem, CapabilityGap, EvolutionProposal, LearningEntry } from './types.js';
import { stableJson } from './stableJson.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const EVOLUTION_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const EVOLUTION_ARCHIVE_PAGE_BYTES = 1024 * 1024;
export type EvolutionArchiveKind = 'proposals' | 'learnings' | 'gaps' | 'actions';
export type EvolutionArchiveRecord = EvolutionProposal | LearningEntry | CapabilityGap | ActionItem;
export interface EvolutionArchiveEnvelope {
  origin: string;
  kind: EvolutionArchiveKind;
  record: EvolutionArchiveRecord;
  digest: string;
}
export interface EvolutionRetentionEntry { kind: EvolutionArchiveKind; record: EvolutionArchiveRecord; archivedAt: string }
export interface EvolutionArchiveSyncPeer {
  url: string;
  offset: number;
  incarnation?: string;
  failures: number;
  nextAttemptAt: number;
  parked: boolean;
}
export interface EvolutionArchiveDocument {
  entries: ActionArchiveEntry[];
  retentionEntries?: EvolutionRetentionEntry[];
  replicaEntries?: EvolutionArchiveEnvelope[];
  archiveId?: string;
  exportOrder?: string[];
  syncPeers?: Record<string, EvolutionArchiveSyncPeer>;
  [key: string]: unknown;
}
export interface EvolutionArchivePage {
  entries: EvolutionArchiveEnvelope[];
  nextOffset: number | null;
  incarnation: string;
  offset: number;
  total: number;
  oversized?: Array<{ digest: string; origin: string; kind: EvolutionArchiveKind; id: string; reason: 'oversized' }>;
}
const kinds = new Set(['proposals', 'learnings', 'gaps', 'actions']);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Structural custody validation only. Received content never becomes a local work item. */
export function validateEvolutionArchiveRecord(kind: EvolutionArchiveKind, record: unknown): asserts record is EvolutionArchiveRecord {
  if (!object(record) || typeof record.id !== 'string' || typeof record.title !== 'string' || typeof record.description !== 'string') throw new Error('invalid evolution archive record');
  const prefix = { proposals: 'EVO', learnings: 'LRN', gaps: 'GAP', actions: 'ACT' }[kind];
  if (record.id.length > 100 || !new RegExp(`^${prefix}-[0-9]+$`).test(record.id)) throw new Error('invalid evolution archive id');
  if (kind === 'learnings') {
    if (typeof record.applied !== 'boolean') throw new Error('invalid archived learning applied flag');
  } else {
    const statuses = kind === 'proposals' ? ['proposed', 'approved', 'in_progress', 'implemented', 'rejected', 'deferred']
      : kind === 'actions' ? ['pending', 'in_progress', 'completed', 'cancelled'] : ['identified', 'addressed', 'wont_fix'];
    if (!statuses.includes(record.status as string)) throw new Error('invalid evolution archive status');
  }
}
export function evolutionArchiveDigest(origin: string, kind: EvolutionArchiveKind, record: EvolutionArchiveRecord): string {
  return createHash('sha256').update(stableJson({ origin, kind, record })).digest('hex');
}
function assertEnvelope(raw: unknown): asserts raw is EvolutionArchiveEnvelope {
  if (!object(raw) || typeof raw.origin !== 'string' || !raw.origin || raw.origin.length > 200 || !kinds.has(raw.kind as string) || typeof raw.digest !== 'string') throw new Error('invalid evolution archive envelope');
  validateEvolutionArchiveRecord(raw.kind as EvolutionArchiveKind, raw.record);
  if (raw.digest !== evolutionArchiveDigest(raw.origin, raw.kind as EvolutionArchiveKind, raw.record)) throw new Error('evolution archive digest mismatch');
}
function assertDocument(raw: unknown): asserts raw is EvolutionArchiveDocument {
  if (!object(raw) || !Array.isArray(raw.entries)) throw new Error('archive has no entries array');
  for (const entry of raw.entries) {
    if (!object(entry) || typeof entry.archivedAt !== 'string' || typeof entry.class !== 'string' || typeof entry.ageDays !== 'number' || !Number.isFinite(entry.ageDays)) throw new Error('invalid action archive entry');
    validateEvolutionArchiveRecord('actions', entry.action);
    if (entry.restoredAt !== undefined && typeof entry.restoredAt !== 'string') throw new Error('invalid archive restore marker');
  }
  if (raw.retentionEntries !== undefined) {
    if (!Array.isArray(raw.retentionEntries)) throw new Error('invalid retention archive entries');
    for (const entry of raw.retentionEntries) {
      if (!object(entry) || !kinds.has(entry.kind as string) || typeof entry.archivedAt !== 'string') throw new Error('invalid retention archive entry');
      validateEvolutionArchiveRecord(entry.kind as EvolutionArchiveKind, entry.record);
    }
  }
  if (raw.replicaEntries !== undefined) {
    if (!Array.isArray(raw.replicaEntries)) throw new Error('invalid archive replicas');
    for (const entry of raw.replicaEntries) assertEnvelope(entry);
  }
  if (raw.archiveId !== undefined && (typeof raw.archiveId !== 'string' || !raw.archiveId)) throw new Error('invalid archive incarnation');
  if (raw.exportOrder !== undefined && (!Array.isArray(raw.exportOrder) || raw.exportOrder.some(x => typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x)) || new Set(raw.exportOrder).size !== raw.exportOrder.length)) throw new Error('invalid archive export order');
  if (raw.syncPeers !== undefined) {
    if (!object(raw.syncPeers)) throw new Error('invalid archive sync state');
    for (const peer of Object.values(raw.syncPeers)) {
      if (!object(peer) || typeof peer.url !== 'string' || !integer(peer.offset) || !integer(peer.failures) || typeof peer.nextAttemptAt !== 'number' || !Number.isFinite(peer.nextAttemptAt) || typeof peer.parked !== 'boolean' || (peer.incarnation !== undefined && typeof peer.incarnation !== 'string')) throw new Error('invalid archive peer state');
    }
  }
}

export class EvolutionArchive {
  readonly filePath: string;
  private originValue: string | undefined;
  private readonly generatedOrigin = `archive:${randomUUID()}`;
  private readonly emptyIncarnation = randomUUID();

  constructor(stateDir: string, private readonly explicitOrigin?: string) {
    this.filePath = path.join(stateDir, 'state', 'evolution', 'action-archive.json');
  }

  get origin(): string {
    if (this.originValue === undefined) this.read();
    return this.originValue!;
  }

  read(): EvolutionArchiveDocument {
    let text: string;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > EVOLUTION_ARCHIVE_MAX_BYTES) throw new Error('evolution archive exceeds 64 MiB ceiling');
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.originValue ??= this.explicitOrigin ?? this.generatedOrigin;
        return { entries: [], archiveId: this.emptyIncarnation, localOrigin: this.originValue };
      }
      throw err;
    }
    if (Buffer.byteLength(text) > EVOLUTION_ARCHIVE_MAX_BYTES) throw new Error('evolution archive exceeds 64 MiB ceiling');
    const doc: unknown = JSON.parse(text);
    assertDocument(doc);
    if (doc.localOrigin !== undefined && (typeof doc.localOrigin !== 'string' || !doc.localOrigin || doc.localOrigin.length > 200)) throw new Error('invalid archive local origin');
    // Legacy read-only exports must be stable across processes before adoption writes.
    // A missing empty archive may use a new UUID; an existing legacy document may not.
    this.originValue = typeof doc.localOrigin === 'string' ? doc.localOrigin : this.explicitOrigin
      ?? `legacy:${createHash('sha256').update(stableJson(doc)).digest('hex')}`;
    return doc;
  }

  private envelope(kind: EvolutionArchiveKind, record: EvolutionArchiveRecord): EvolutionArchiveEnvelope {
    return { origin: this.origin, kind, record, digest: evolutionArchiveDigest(this.origin, kind, record) };
  }

  private envelopes(doc: EvolutionArchiveDocument): Map<string, EvolutionArchiveEnvelope> {
    const all = new Map<string, EvolutionArchiveEnvelope>();
    for (const entry of doc.entries) { const e = this.envelope('actions', entry.action); all.set(e.digest, e); }
    for (const entry of doc.retentionEntries ?? []) { const e = this.envelope(entry.kind, entry.record); all.set(e.digest, e); }
    for (const e of doc.replicaEntries ?? []) all.set(e.digest, e);
    return all;
  }

  /** Fsync archive contents and directory before readback; callers may evict only after return. */
  write(doc: EvolutionArchiveDocument): void {
    assertDocument(doc);
    const prior = this.read();
    if (doc.localOrigin !== undefined && doc.localOrigin !== this.origin) throw new Error('archive origin cannot change');
    const all = this.envelopes(doc);
    for (const digest of this.envelopes(prior).keys()) if (!all.has(digest)) throw new Error('archive write would remove exported memory');
    const order = [...(prior.exportOrder ?? doc.exportOrder ?? [])];
    if (order.some(digest => !all.has(digest))) throw new Error('archive write would remove exported memory');
    const seen = new Set(order);
    for (const digest of all.keys()) if (!seen.has(digest)) { order.push(digest); seen.add(digest); }
    const stored = { ...doc, localOrigin: doc.localOrigin ?? this.origin, archiveId: doc.archiveId ?? randomUUID(), exportOrder: order };
    const serialized = JSON.stringify(stored, null, 2);
    if (Buffer.byteLength(serialized) > EVOLUTION_ARCHIVE_MAX_BYTES) throw new Error('evolution archive write exceeds 64 MiB ceiling');
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.filePath);
      const directoryFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      if (fs.readFileSync(this.filePath, 'utf8') !== serialized) throw new Error('evolution archive readback mismatch');
    } catch (err) {
      try { SafeFsExecutor.safeUnlinkSync(temp, { operation: 'EvolutionArchive:failed-write-temp' }); } catch { /* original error preserved */ }
      throw err;
    }
  }

  preserve(kind: EvolutionArchiveKind, records: readonly EvolutionArchiveRecord[]): void {
    const doc = this.read();
    const existing = this.envelopes(doc);
    for (const record of records) {
      validateEvolutionArchiveRecord(kind, record);
      // Normalize JSON once so equality/digests match persisted content, including undefined members.
      const clone = JSON.parse(JSON.stringify(record)) as EvolutionArchiveRecord;
      const e = this.envelope(kind, clone);
      if (Buffer.byteLength(JSON.stringify(e)) > EVOLUTION_ARCHIVE_PAGE_BYTES - 65536) throw new Error('oversized evolution archive record; retain hot record');
      if (kind === 'actions') {
        // A restored occurrence no longer licenses restore. Re-eviction needs a
        // new unrestored custody occurrence even when its content digest repeats.
        if (doc.entries.some(entry => !entry.restoredAt && this.envelope('actions', entry.action).digest === e.digest)) continue;
        doc.entries.push({ action: clone as ActionItem, archivedAt: new Date().toISOString(), ageDays: 0, class: 'retention' });
      } else {
        if (existing.has(e.digest)) continue;
        (doc.retentionEntries ??= []).push({ kind, record: clone, archivedAt: new Date().toISOString() });
      }
      existing.set(e.digest, e);
    }
    this.write(doc);
    const verified = this.envelopes(this.read());
    for (const record of records) if (!verified.has(this.envelope(kind, record).digest)) throw new Error('evolution archive preservation readback missing record');
  }

  localEntries(kind: EvolutionArchiveKind): EvolutionArchiveRecord[] {
    const doc = this.read();
    return kind === 'actions' ? doc.entries.map(e => e.action) : (doc.retentionEntries ?? []).filter(e => e.kind === kind).map(e => e.record);
  }

  /** Read-only pagination. Persisted export order never shifts when a different kind is appended. */
  page(opts: { kind?: EvolutionArchiveKind; id?: string; offset?: number; limit?: number } = {}): EvolutionArchivePage {
    const offset = opts.offset ?? 0, limit = opts.limit ?? 50;
    if (!integer(offset) || !integer(limit) || limit < 1 || limit > 50) throw new Error('invalid archive pagination');
    const doc = this.read(), all = this.envelopes(doc);
    const order = [...(doc.exportOrder ?? [])];
    const seen = new Set(order);
    for (const digest of all.keys()) if (!seen.has(digest)) { order.push(digest); seen.add(digest); }
    const selected = order.map(d => all.get(d)).filter((e): e is EvolutionArchiveEnvelope => !!e && (!opts.kind || e.kind === opts.kind) && (!opts.id || e.record.id === opts.id));
    const entries: EvolutionArchiveEnvelope[] = [], oversized: NonNullable<EvolutionArchivePage['oversized']> = [];
    let index = Math.min(offset, selected.length), bytes = 65536;
    while (index < selected.length && entries.length + oversized.length < limit) {
      const entry = selected[index], size = Buffer.byteLength(JSON.stringify(entry));
      if (size > EVOLUTION_ARCHIVE_PAGE_BYTES - 65536) { oversized.push({ digest: entry.digest, origin: entry.origin, kind: entry.kind, id: entry.record.id, reason: 'oversized' }); index++; continue; }
      if (bytes + size > EVOLUTION_ARCHIVE_PAGE_BYTES) break;
      entries.push(entry); bytes += size; index++;
    }
    return { entries, nextOffset: index < selected.length ? index : null, incarnation: doc.archiveId ?? createHash('sha256').update(stableJson(doc)).digest('hex'), offset, total: selected.length, ...(oversized.length ? { oversized } : {}) };
  }

  /** Validate the complete page before changing any memory or advancing its peer cursor. */
  importPage(page: EvolutionArchivePage): void {
    EvolutionArchive.validatePage(page);
    if (page.oversized?.length) throw new Error('peer archive contains oversized records; incomplete preservation');
    const doc = this.read(), known = this.envelopes(doc);
    for (const entry of page.entries) {
      if (known.has(entry.digest)) continue;
      (doc.replicaEntries ??= []).push(entry);
      known.set(entry.digest, entry);
    }
    this.write(doc);
  }

  static validatePage(page: unknown): asserts page is EvolutionArchivePage {
    if (!object(page) || !Array.isArray(page.entries) || page.entries.length > 50 || typeof page.incarnation !== 'string' || !page.incarnation || page.incarnation.length > 200 || !integer(page.offset) || !integer(page.total) || (page.nextOffset !== null && !integer(page.nextOffset))) throw new Error('invalid evolution archive page');
    if (Buffer.byteLength(JSON.stringify(page)) > EVOLUTION_ARCHIVE_PAGE_BYTES) throw new Error('evolution archive page exceeds byte ceiling');
    if (page.oversized !== undefined && (!Array.isArray(page.oversized) || page.oversized.length > 50)) throw new Error('invalid oversized archive metadata');
    const oversized = (page.oversized ?? []) as unknown[];
    for (const entry of oversized) {
      if (!object(entry) || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)
        || typeof entry.origin !== 'string' || !entry.origin || entry.origin.length > 200
        || !kinds.has(entry.kind as string) || typeof entry.id !== 'string' || entry.id.length > 100
        || entry.reason !== 'oversized') throw new Error('invalid oversized archive metadata');
      const prefix = { proposals: 'EVO', learnings: 'LRN', gaps: 'GAP', actions: 'ACT' }[entry.kind as EvolutionArchiveKind];
      if (!new RegExp(`^${prefix}-[0-9]+$`).test(entry.id)) throw new Error('invalid oversized archive id');
    }
    const delivered = page.entries.length + oversized.length;
    if (delivered > 50) throw new Error('evolution archive page exceeds record ceiling');
    if (page.nextOffset !== null) {
      if (page.nextOffset !== page.offset + delivered || page.nextOffset <= page.offset || page.nextOffset > page.total) throw new Error('invalid archive cursor coverage');
    } else if (page.offset + delivered !== page.total && !(page.offset > page.total && delivered === 0)) {
      // A rebuilt stream may answer an old cursor past its new end. The worker
      // verifies incarnation and rescans zero, rather than accepting missing rows.
      throw new Error('invalid terminal archive coverage');
    }
    for (const entry of page.entries) assertEnvelope(entry);
    const digests = [...page.entries.map((entry: EvolutionArchiveEnvelope) => entry.digest), ...oversized.map(entry => (entry as {digest: string}).digest)];
    if (new Set(digests).size !== digests.length) throw new Error('duplicate evolution archive page digest');
  }
}
