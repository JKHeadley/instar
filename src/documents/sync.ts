/**
 * Instar Documents — replication between machines by version-vector pull (spec §5.1).
 *
 * A peer asks with what it holds (`have`: stream → highest seq); the answer is the rows beyond it,
 * paged by bytes (at most `FORMAT.pageBytes`, always at least one row) together with every blob those
 * rows name. Rows are ingested before blobs, so a purge or prune row is applied before any blob of
 * that document arrives; the responder never serves purged or pruned text, and `purged`/`pruned` are
 * listed for diagnostics. Every row is re-verified by the receiver's
 * own ingest; nothing a peer sends is trusted as-is. Failures are counted per peer, never swallowed.
 */
import { checkBlob, type Blob } from './blobs.js';
import { FORMAT, type DocRow } from './rows.js';
import type { DocumentStore } from './store.js';

export interface SyncPage {
  purged: string[];
  pruned: Record<string, string[]>;
  rows: DocRow[];
  blobs: Array<{ docId: string; hash: string; blob: Blob }>;
  /** The responder's vector, so the receiver knows whether more pages remain. */
  vector: Record<string, number>;
}

/** Build one page for a peer. Bounded by bytes; blobs ride with the rows that name them. */
export function buildSyncPage(store: DocumentStore, have: Record<string, number>, maxBytes: number = FORMAT.pageBytes): SyncPage {
  const purged = store.docIds().filter((d) => store.isPurged(d));
  const pruned: Record<string, string[]> = {};
  for (const d of store.docIds()) {
    const ids = [...new Set(store.rowsOf(d).flatMap((r) => (r.eventKind === 'prune' ? r.versionIds : [])))];
    if (ids.length) pruned[d] = ids;
  }
  // Rows and the blobs they name travel together under ONE budget: a row is added only with all of
  // its blobs, so a receiver whose vector moves past a row has that row's text too. The first row always
  // goes, with its blobs, so a page is never empty (a single row's blobs are each ≤ the blob bound).
  const candidates = store.rowsBeyond(have, Number.MAX_SAFE_INTEGER);
  const rows: DocRow[] = [];
  const blobs: SyncPage['blobs'] = [];
  const sent = new Set<string>();
  let bytes = 0;
  for (const r of candidates) {
    const rowBytes = Buffer.byteLength(JSON.stringify(r), 'utf8');
    const extra: SyncPage['blobs'] = [];
    let extraBytes = 0;
    if (!store.isPurged(r.docId)) {
      for (const hash of blobHashesOf(r)) {
        if (sent.has(`${r.docId}|${hash}`)) continue;
        if (r.eventKind === 'version-chunk' && store.isPruned(r.docId, r.versionId)) continue;
        const blob = store.getBlob(r.docId, hash);
        if (!blob) continue;
        extra.push({ docId: r.docId, hash, blob });
        extraBytes += Buffer.byteLength(JSON.stringify(blob), 'utf8');
      }
    }
    if (rows.length > 0 && bytes + rowBytes + extraBytes > maxBytes) break;
    rows.push(r);
    for (const b of extra) { blobs.push(b); sent.add(`${b.docId}|${b.hash}`); }
    bytes += rowBytes + extraBytes;
  }
  return { purged, pruned, rows, blobs, vector: store.have() };
}

/** The blob hashes a row names (its text lives in blobs). */
export function blobHashesOf(r: DocRow): string[] {
  switch (r.eventKind) {
    case 'created': return [r.titleHash, r.docSaltHash];
    case 'version': return [r.noteHash, r.addressesHash].filter((x): x is string => !!x);
    case 'version-chunk': return [r.payloadHash];
    case 'comment': return [r.anchor.anchorHash, r.bodyHash];
    case 'comment-edit': return [r.bodyHash];
    case 'comment-reanchor': return [r.anchor.anchorHash];
    case 'reply': return [r.bodyHash];
    case 'addressed': return [r.commentKeysHash];
    case 'send': return [r.coveredHash];
    case 'link': return r.reasonHash ? [r.reasonHash] : [];
    case 'title': return [r.titleHash];
    default: return [];
  }
}

export interface ApplyResult { applied: number; pending: number; ignored: number; blobs: number }

/** Apply a page from a peer: purges first, then rows through ingest, then blobs, then re-check. */
export function applySyncPage(store: DocumentStore, input: unknown): ApplyResult {
  const out: ApplyResult = { applied: 0, pending: 0, ignored: 0, blobs: 0 };
  if (!input || typeof input !== 'object') return out;
  const page = input as Partial<SyncPage>;
  const rows = Array.isArray(page.rows) ? (page.rows as DocRow[]) : [];
  // Rows in seq order per stream, so chains apply in one pass where possible.
  rows.sort((a, b) => (a.origin === b.origin ? a.seq - b.seq : a.origin < b.origin ? -1 : 1));
  for (const r of rows) {
    const res = store.ingest(r);
    if (res === 'applied') out.applied++;
    else if (res === 'pending') out.pending++;
    else if (typeof res === 'object') out.ignored++;
  }
  out.applied += store.recheckPending();
  const blobs = Array.isArray(page.blobs) ? page.blobs : [];
  for (const b of blobs) {
    if (!b || typeof b !== 'object' || typeof b.docId !== 'string' || typeof b.hash !== 'string') continue;
    if (!checkBlob(b.blob, b.hash).ok) continue;
    if (!rowNamesBlob(store, b.docId, b.hash)) continue; // only blobs some held row names
    const version = chunkVersion(store, b.docId, b.hash);
    if (store.putBlob(b.docId, b.blob, version ? { forVersion: version } : {})) out.blobs++;
  }
  return out;
}

function rowNamesBlob(store: DocumentStore, docId: string, hash: string): boolean {
  return store.rowsOf(docId).some((r) => blobHashesOf(r).includes(hash));
}

function chunkVersion(store: DocumentStore, docId: string, hash: string): string | null {
  // A blob shared by a pruned and a kept version is kept: name a kept version if there is one.
  const versions = store.rowsOf(docId).filter((r) => r.eventKind === 'version-chunk' && r.payloadHash === hash).map((r) => (r as { versionId: string }).versionId);
  if (versions.length === 0) return null;
  return versions.find((v) => !store.isPruned(docId, v)) ?? versions[0];
}

export interface DocumentPeer {
  machineId: string;
  fetchPage(have: Record<string, number>): Promise<unknown>;
}

/** Pulls from every peer on a cadence, page by page, counting failures per peer. */
export class DocumentPuller {
  private failures = new Map<string, { count: number; lastError: string; at: string }>();
  private running = false;

  constructor(private readonly store: () => DocumentStore | null, private readonly peers: () => DocumentPeer[], private readonly maxPages = 20) {}

  health(): Record<string, { count: number; lastError: string; at: string }> { return Object.fromEntries(this.failures); }

  async tick(): Promise<void> {
    if (this.running) return;
    const store = this.store();
    if (!store) return;
    this.running = true;
    try {
      for (const peer of this.peers()) {
        try {
          for (let page = 0; page < this.maxPages; page++) {
            const before = JSON.stringify(store.have());
            const res = await peer.fetchPage(store.have());
            const applied = applySyncPage(store, res);
            const theirs = (res as { vector?: Record<string, number> } | null)?.vector ?? {};
            const behind = Object.entries(theirs).some(([s, n]) => (store.have()[s] ?? 0) < n);
            if (!behind || JSON.stringify(store.have()) === before || applied.applied === 0) break;
          }
          this.failures.delete(peer.machineId);
        } catch (err) {
          const prev = this.failures.get(peer.machineId);
          this.failures.set(peer.machineId, { count: (prev?.count ?? 0) + 1, lastError: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
