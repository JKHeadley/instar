/**
 * On-demand lookup of chunk (C) and range (C2) records
 * (context-budget-layered-summaries §7.6): `GET /topic/:id/chunks` and
 * `GET /topic/:id/chunks/:k`. Bounded and paginated; every item carries its
 * size so a session can see what it is about to pull, its status, and the
 * state of each archive span it points at (present / raw-evicted / unknown).
 * Read-only.
 */
import type { LayerStore, StoredRecord } from './LayerStore.js';
import type { TranscriptArchive, ArchiveIndex } from './TranscriptArchive.js';
import { estimateTokens } from './layerCadence.js';

export const CHUNK_LIST_DEFAULT_LIMIT = 50;
export const CHUNK_LIST_MAX_LIMIT = 200;
/** A single record response never exceeds this many bytes. */
export const CHUNK_RECORD_MAX_BYTES = 256 * 1024;
const SAFE_TOPIC = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,127}$/;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,160}$/;

export interface ChunkListItem {
  key: string;
  recordType: 'chunk' | 'c2';
  kind: string;
  status: string | null;
  seq: number | null;
  seqRange: [number, number] | null;
  rangeId: string | null;
  trigger: string | null;
  bytes: number;
  tokens: number;
  entryRange: unknown;
  sampling: string | null;
  gap: string | null;
  spans: Array<{ spanId: string; state: 'present' | 'raw-evicted' | 'unknown' }>;
  writtenAt: number;
  asOf: StoredRecord['asOf'];
  author: StoredRecord['author'];
}

export function isSafeChunkTopic(t: string): boolean { return SAFE_TOPIC.test(t); }
export function isSafeChunkKey(k: string): boolean { return SAFE_KEY.test(k) && !k.startsWith('.'); }

function order(r: StoredRecord): number {
  if (r.recordType === 'c2') { const s = r.data.seqRange as [number, number] | undefined; return Array.isArray(s) ? Number(s[1]) + 0.5 : 0; }
  return Number(r.data.seq ?? 0);
}

/** A span's state from an index read once per request (the index holds every entry id: never re-parsed per span). */
function stateIn(idx: ArchiveIndex, spanId: string): 'present' | 'raw-evicted' | 'unknown' {
  const row = idx.spans.find((s) => s.spanId === spanId);
  if (!row) return 'unknown';
  return row.evictedAt !== undefined ? 'raw-evicted' : 'present';
}

function item(r: StoredRecord, idx: ArchiveIndex): ChunkListItem {
  const json = JSON.stringify(r);
  const d = r.data as Record<string, unknown>;
  const seqRange = Array.isArray(d.seqRange) && d.seqRange.length === 2 ? [Number(d.seqRange[0]), Number(d.seqRange[1])] as [number, number] : null;
  return {
    key: r.entryKey,
    recordType: r.recordType as 'chunk' | 'c2',
    kind: typeof d.kind === 'string' ? d.kind : r.recordType,
    status: r.status ?? null,
    seq: typeof d.seq === 'number' ? d.seq : null,
    seqRange,
    rangeId: typeof d.rangeId === 'string' ? d.rangeId : null,
    trigger: typeof d.trigger === 'string' ? d.trigger : null,
    bytes: Buffer.byteLength(json, 'utf-8'),
    tokens: estimateTokens(json),
    entryRange: d.entryRange ?? null,
    sampling: typeof d.sampling === 'string' ? d.sampling : null,
    gap: typeof d.gap === 'string' ? d.gap : null,
    spans: (r.spanIds ?? []).slice(0, 100).map((spanId) => ({ spanId, state: stateIn(idx, spanId) })),
    writtenAt: r.writtenAt,
    asOf: r.asOf,
    author: r.author,
  };
}

/** One page of a topic's C and C2 records, newest first. */
export function listChunks(store: LayerStore, archive: TranscriptArchive, topicKey: string, o: { limit?: number; offset?: number; kind?: 'all' | 'chunk' | 'c2' } = {}): { topicKey: string; total: number; offset: number; limit: number; nextOffset: number | null; items: ChunkListItem[] } {
  const limit = Math.max(1, Math.min(Math.floor(o.limit ?? CHUNK_LIST_DEFAULT_LIMIT), CHUNK_LIST_MAX_LIMIT));
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const kind = o.kind ?? 'all';
  const recs = [
    ...(kind !== 'c2' ? store.list(topicKey, 'chunk') : []),
    ...(kind !== 'chunk' ? store.list(topicKey, 'c2') : []),
  ].sort((a, b) => order(b) - order(a));
  const page = recs.slice(offset, offset + limit);
  const idx = archive.readIndex(topicKey);
  return { topicKey, total: recs.length, offset, limit, nextOffset: offset + limit < recs.length ? offset + limit : null, items: page.map((r) => item(r, idx)) };
}

/** One record (a chunk key, or a C2 range id), with its spans' states; null when absent. */
export function readChunk(store: LayerStore, archive: TranscriptArchive, topicKey: string, key: string): { record: StoredRecord; summary: ChunkListItem; truncated: boolean } | null {
  const rec = store.read(topicKey, 'chunk', key) ?? store.read(topicKey, 'c2', key);
  if (!rec) return null;
  const summary = item(rec, archive.readIndex(topicKey));
  if (summary.bytes <= CHUNK_RECORD_MAX_BYTES) return { record: rec, summary, truncated: false };
  // Over the bound (not expected: the validator caps every field): the envelope without the data.
  return { record: { ...rec, data: { withheld: `record over ${CHUNK_RECORD_MAX_BYTES} bytes (${summary.bytes}); read its span through the transcript route` } }, summary, truncated: true };
}
