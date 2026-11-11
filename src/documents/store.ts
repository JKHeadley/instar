/**
 * Instar Documents — the on-disk row store, ingest pipeline and export (spec §3.4, §5).
 *
 * Layout under `<stateDir>/documents/` (0700; files 0600):
 *   rows/<sha256(docId)>.jsonl   one document's rows, appended and fsynced before acknowledging
 *   blobs/<sha256(docId)>/…      salted content blobs (blobs.ts)
 *   origin-index.jsonl           (origin/incarnation, seq) → docKey, so "rows beyond a vector" is a seek
 *   pending.jsonl                rows whose standing can't be decided yet (waiting on team rows)
 *   purged.json / pruned.json    purged documents and pruned versions: their blobs are refused again
 *
 * Ingest order for every row, local or from a peer: structural validation → signature → chain
 * position → standing (from the immutable team rows its `access` names) → append. A row whose
 * standing can't be decided yet is held as pending and re-checked when the team log advances; a row
 * that fails is ignored and counted, never applied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineKeyLookup, MachineSigner } from '../core/AppRecordSignatures.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { BlobStore, checkBlob, type Blob } from './blobs.js';
import { rowHash, signRow, verifyRowSignature } from './chain.js';
import { rowKeyOf, streamOf, validateRow, type DocRow, type RowBody, type UnsignedDocRow, type Vector } from './rows.js';

export const docKeyOf = (docId: string): string => crypto.createHash('sha256').update(docId, 'utf8').digest('hex');

/** The standing re-check against the team rows a row's `access` names (fold of the team log). */
export type StandingCheck = (row: DocRow) => 'ok' | 'denied' | 'pending';

export interface StoreHealth {
  pending: number;
  oldestPendingAt: string | null;
  ignored: Record<string, number>;
  rows: number;
}

/**
 * A device-signed row's event id is derived from the device and its request id (§3.6), so the same
 * signed request names the same event on every machine; other rows get a fresh uuid.
 */
function requestKeyOf(r: DocRow): string | null {
  const a = r.actor;
  return (a.type === 'person' || a.type === 'owner-phone') && a.signedOrigin?.requestId ? `${a.signedOrigin.deviceId}|${a.signedOrigin.requestId}` : null;
}

function eventIdFor(actor: DocRow['actor']): string {
  if ((actor.type === 'person' || actor.type === 'owner-phone') && actor.signedOrigin?.requestId) {
    const h = crypto.createHash('sha256').update(`${actor.signedOrigin.deviceId}|${actor.signedOrigin.requestId}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  return crypto.randomUUID();
}

export type IngestResult = 'applied' | 'duplicate' | 'pending' | { ignored: string };

export class DocumentStore {
  readonly dir: string;
  readonly blobs: BlobStore;
  private readonly rowsDir: string;
  private readonly indexFile: string;
  private readonly pendingFile: string;
  private readonly purgedFile: string;
  private readonly prunedFile: string;
  /**
   * Rows whose chain position is proven but whose device origin is not verifiable here yet (the
   * device key or its binding has not arrived), or was found wrong later. Kept in the chain so later
   * rows of the same machine still apply, but left out of every read (`rowsOf`). Value: why.
   */
  private hidden = new Map<string, 'origin-pending' | 'origin-denied' | 'standing'>();
  private readonly hiddenFile: string;
  private readonly refusedFile: string;
  /** Hash per held row key, to tell a duplicate from a fork. */
  private hashes = new Map<string, string>();
  /** In memory: row keys held, per-origin head (seq + hash), per-doc row lists (metadata only). */
  private held = new Set<string>();
  private heads = new Map<string, { seq: number; hash: string }>();
  private byDoc = new Map<string, DocRow[]>();
  private pending = new Map<string, DocRow>();
  private purged = new Set<string>();
  private pruned = new Map<string, Set<string>>();
  private ignored: Record<string, number> = {};
  private incarnation: string;

  constructor(stateDir: string, private readonly opts: {
    signer: MachineSigner | null;
    keyLookup: MachineKeyLookup;
    standing: StandingCheck;
    incarnation?: string;
    /** Re-checks the device signature behind a person or owner row (originCheck.ts). Production always sets it. */
    origin?: (row: DocRow, usedRequestIds: ReadonlySet<string>) => 'ok' | 'denied' | 'pending';
  }) {
    this.dir = path.join(stateDir, 'documents');
    this.rowsDir = path.join(this.dir, 'rows');
    this.indexFile = path.join(this.dir, 'origin-index.jsonl');
    this.pendingFile = path.join(this.dir, 'pending.jsonl');
    this.purgedFile = path.join(this.dir, 'purged.json');
    this.prunedFile = path.join(this.dir, 'pruned.json');
    this.hiddenFile = path.join(this.dir, 'hidden.json');
    this.refusedFile = path.join(this.dir, 'refused.jsonl');
    fs.mkdirSync(this.rowsDir, { recursive: true, mode: 0o700 });
    this.blobs = new BlobStore(path.join(this.dir, 'blobs'));
    this.incarnation = opts.incarnation ?? 'i1';
    this.load();
  }

  // ── Boot ────────────────────────────────────────────────────────────────────────────

  private load(): void {
    this.purged = new Set(readJson<string[]>(this.purgedFile) ?? []);
    for (const [doc, ids] of Object.entries(readJson<Record<string, string[]>>(this.prunedFile) ?? {})) this.pruned.set(doc, new Set(ids));
    for (const file of safeReaddir(this.rowsDir)) {
      if (!file.endsWith('.jsonl')) continue;
      for (const row of readJsonl<DocRow>(path.join(this.rowsDir, file))) this.remember(row);
    }
    // Refused rows keep their place in their origin's chain (content discarded), so later rows apply.
    for (const m of readJsonl<{ s: string; seq: number; hash: string; reason: string }>(this.refusedFile)) {
      const key = `${m.s}#${m.seq}`;
      if (this.held.has(key)) continue;
      this.held.add(key);
      this.hashes.set(key, m.hash);
      const head = this.heads.get(m.s);
      if (!head || m.seq > head.seq) this.heads.set(m.s, { seq: m.seq, hash: m.hash });
    }
    for (const row of readJsonl<DocRow>(this.pendingFile)) if (!this.held.has(rowKeyOf(row))) this.pending.set(rowKeyOf(row), row);
    for (const [k, why] of Object.entries(readJson<Record<string, 'origin-pending' | 'origin-denied' | 'standing'>>(this.hiddenFile) ?? {})) this.hidden.set(k, why);
  }

  private writeHidden(): void {
    SafeFsExecutor.atomicWriteJsonSync(this.hiddenFile, Object.fromEntries(this.hidden), { operation: 'documents.hidden', mode: 0o600 });
  }

  private remember(row: DocRow): void {
    const k = rowKeyOf(row);
    if (this.held.has(k)) return;
    this.held.add(k);
    const h = rowHash(row);
    this.hashes.set(k, h);
    const s = streamOf(row);
    const head = this.heads.get(s);
    if (!head || row.seq > head.seq) this.heads.set(s, { seq: row.seq, hash: h });
    const list = this.byDoc.get(row.docId) ?? [];
    list.push(row);
    this.byDoc.set(row.docId, list);
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────

  /** Every held row of a document, readable or not (chain members): for export, restore and sync. */
  allRowsOf(docId: string): DocRow[] { return [...(this.byDoc.get(docId) ?? [])]; }

  rowsOf(docId: string): DocRow[] {
    const visible = (this.byDoc.get(docId) ?? []).filter((r) => !this.hidden.has(rowKeyOf(r)));
    // One row per signed device request: the lowest row key wins on every machine (§3.6 replay).
    const winner = new Map<string, string>();
    for (const r of visible) {
      const rq = requestKeyOf(r);
      if (!rq) continue;
      const k = rowKeyOf(r);
      const w = winner.get(rq);
      if (w === undefined || k < w) winner.set(rq, k);
    }
    return winner.size === 0 ? visible : visible.filter((r) => { const rq = requestKeyOf(r); return !rq || winner.get(rq) === rowKeyOf(r); });
  }

  /** Rows held but not readable here yet (origin not verifiable) or refused after the fact, with why. */
  hiddenRows(): Array<{ key: string; why: string }> { return [...this.hidden].map(([key, why]) => ({ key, why })); }
  docIds(): string[] { return [...this.byDoc.keys()]; }
  isPurged(docId: string): boolean { return this.purged.has(docId); }
  isPruned(docId: string, versionId: string): boolean { return this.pruned.get(docId)?.has(versionId) ?? false; }

  /** The vector of what this machine holds: highest contiguous seq per stream. */
  have(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [s, h] of this.heads) out[s] = h.seq;
    return out;
  }

  /** Rows beyond a peer's vector, oldest first per stream, bounded by bytes (sync pages, §5.1). */
  rowsBeyond(peerHave: Vector, maxBytes: number): DocRow[] {
    const out: DocRow[] = [];
    let bytes = 0;
    const all = [...this.byDoc.values()].flat().filter((r) => r.seq > (peerHave[streamOf(r)] ?? 0));
    all.sort((a, b) => (streamOf(a) === streamOf(b) ? a.seq - b.seq : streamOf(a) < streamOf(b) ? -1 : 1));
    for (const r of all) {
      const n = Buffer.byteLength(JSON.stringify(r), 'utf8');
      if (out.length > 0 && bytes + n > maxBytes) break;
      out.push(r);
      bytes += n;
    }
    return out;
  }

  health(): StoreHealth {
    let oldest: string | null = null;
    for (const r of this.pending.values()) if (!oldest || r.receivedAt < oldest) oldest = r.receivedAt;
    return { pending: this.pending.size, oldestPendingAt: oldest, ignored: { ...this.ignored }, rows: this.held.size };
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────

  /**
   * Write a new row from this machine: stamps origin, seq, prev hash and docDeps (everything this
   * machine holds of the document), signs it, and ingests it. Throws when this machine has no
   * identity (a document needs signed rows) or the row fails validation.
   */
  append(docId: string, body: RowBody, header: Pick<UnsignedDocRow, 'actor' | 'access' | 'primaryRow'> & { sessionAccess?: Vector }): DocRow {
    const signer = this.opts.signer;
    if (!signer) throw new Error('documents need this machine to have an identity');
    const origin = signer.machineId();
    const s = `${origin}/${this.incarnation}`;
    const head = this.heads.get(s);
    const docDeps: Record<string, number> = {};
    // What this writer has seen: the readable rows (a hidden row is not part of any disclosure, §3.2).
    for (const r of this.rowsOf(docId)) docDeps[streamOf(r)] = Math.max(docDeps[streamOf(r)] ?? 0, r.seq);
    const unsigned = {
      formatVersion: 1, docId, origin, incarnation: this.incarnation, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? null,
      eventId: eventIdFor(header.actor), receivedAt: new Date().toISOString(),
      actor: header.actor, access: header.access, ...(header.sessionAccess ? { sessionAccess: header.sessionAccess } : {}),
      docDeps, primaryRow: header.primaryRow, ...body,
    } as UnsignedDocRow;
    const row = signRow(unsigned, signer);
    const res = this.ingest(row);
    if (res !== 'applied') throw new Error(`row not applied: ${typeof res === 'string' ? res : res.ignored}`);
    return row;
  }

  /** Ingest one row from anywhere. Never throws. */
  ingest(row: DocRow): IngestResult {
    const k = rowKeyOf(row);
    if (this.held.has(k)) {
      // Same position, different content: a fork. Counted, never applied (§3.4, chain.ts).
      return this.hashes.get(k) === safeRowHash(row) ? 'duplicate' : this.ignore('fork');
    }
    const check = validateRow(row);
    if (!check.ok) return this.ignore(check.reason);
    const sig = verifyRowSignature(row, this.opts.keyLookup);
    if (sig === 'bad') return this.ignore('bad-signature');
    if (sig === 'unknown') return this.hold(row);
    const head = this.heads.get(streamOf(row));
    if (head && row.seq <= head.seq) return this.ignore('seq-conflict');
    if (head && row.seq === head.seq + 1 && row.prevHash !== head.hash) return this.ignore('broken-chain');
    if (!head && row.seq !== 1) return this.hold(row); // earlier rows of this origin still arriving
    if (!head && row.prevHash !== null) return this.ignore('broken-chain');
    if (head && row.seq > head.seq + 1) return this.hold(row);
    // From here the row's chain position is proven: a refusal keeps its place (content discarded).
    if (this.purged.has(row.docId) && row.eventKind !== 'purge') return this.refuse(row, 'document-purged');
    if (row.eventKind === 'created' && (this.byDoc.get(row.docId) ?? []).some((r) => r.eventKind === 'created')) return this.refuse(row, 'second-created');
    if (this.opts.origin) {
      // A request id already used is not refused by arrival order: both rows are kept and every
      // machine reads only the lowest row key for that device request (rowsOf), so all agree.
      const o = this.opts.origin(row, new Set());
      if (o === 'denied') return this.refuse(row, 'origin');
      if (o === 'pending') {
        // Keep its chain place so this machine's later rows still apply; hide it until it verifies.
        this.persist(row);
        this.hidden.set(k, 'origin-pending');
        this.writeHidden();
        this.pending.delete(k);
        return 'pending';
      }
    }
    const standing = this.opts.standing(row);
    if (standing === 'denied') return this.refuse(row, 'standing');
    if (standing === 'pending') return this.hold(row);
    this.persist(row);
    this.afterApply(row);
    this.pending.delete(k);
    return 'applied';
  }


  /** Re-check every pending row (call when the team log advances or new rows arrive). */
  recheckPending(): number {
    let applied = this.recheckHidden();
    let again = true;
    while (again) {
      again = false;
      const rows = [...this.pending.values()].sort((a, b) => a.seq - b.seq);
      for (const r of rows) {
        this.pending.delete(rowKeyOf(r));
        const res = this.ingest(r);
        if (res === 'applied') { applied++; again = true; }
      }
    }
    this.writePending();
    return applied;
  }

  /** Re-check rows hidden for an origin that was not verifiable yet. Returns how many became readable. */
  private recheckHidden(): number {
    if (!this.opts.origin) return 0;
    let shown = 0;
    let changed = false;
    for (const [k, why] of [...this.hidden]) {
      if (why !== 'origin-pending') continue;
      const row = this.findRow(k);
      if (!row) continue;
      const o = this.opts.origin(row, new Set());
      if (o === 'pending') continue;
      changed = true;
      if (o === 'denied') { this.hidden.set(k, 'origin-denied'); this.ignore('origin'); continue; }
      const standing = this.opts.standing(row);
      if (standing === 'pending') continue;
      if (standing === 'denied') { this.hidden.set(k, 'standing'); this.ignore('standing'); continue; }
      this.hidden.delete(k);
      this.afterApply(row);
      shown++;
    }
    if (changed) this.writeHidden();
    return shown;
  }

  private findRow(key: string): DocRow | null {
    for (const rows of this.byDoc.values()) for (const r of rows) if (rowKeyOf(r) === key) return r;
    return null;
  }

  /** Store a blob for a document, refusing purged documents and pruned versions' chunks. */
  putBlob(docId: string, blob: Blob, opts: { forVersion?: string } = {}): string | null {
    if (this.purged.has(docId)) return null;
    if (opts.forVersion && this.isPruned(docId, opts.forVersion)) return null;
    if (!checkBlob(blob).ok) return null;
    return this.blobs.put(docKeyOf(docId), blob);
  }

  getBlob(docId: string, hash: string): Blob | null {
    if (this.purged.has(docId)) return null;
    return this.blobs.get(docKeyOf(docId), hash);
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────

  private persist(row: DocRow): void {
    const file = path.join(this.rowsDir, `${docKeyOf(row.docId)}.jsonl`);
    appendLineSync(file, JSON.stringify(row));
    appendLineSync(this.indexFile, JSON.stringify({ s: streamOf(row), seq: row.seq, d: docKeyOf(row.docId) }));
    this.remember(row);
  }

  private afterApply(row: DocRow): void {
    if (row.eventKind === 'purge') {
      this.purged.add(row.docId);
      SafeFsExecutor.atomicWriteJsonSync(this.purgedFile, [...this.purged], { operation: 'documents.purged', mode: 0o600 });
      this.blobs.delete(docKeyOf(row.docId));
    }
    if (row.eventKind === 'prune') {
      const set = this.pruned.get(row.docId) ?? new Set<string>();
      for (const id of row.versionIds) set.add(id);
      this.pruned.set(row.docId, set);
      const obj: Record<string, string[]> = {};
      for (const [d, ids] of this.pruned) obj[d] = [...ids];
      SafeFsExecutor.atomicWriteJsonSync(this.prunedFile, obj, { operation: 'documents.pruned', mode: 0o600 });
      this.deletePrunedBlobs(row.docId);
    }
  }

  /** Delete blobs used only by pruned versions (blobs shared with a kept version stay). */
  private deletePrunedBlobs(docId: string): void {
    const rows = this.byDoc.get(docId) ?? [];
    const prunedIds = this.pruned.get(docId) ?? new Set<string>();
    const keep = new Set<string>();
    const drop = new Set<string>();
    for (const r of rows) {
      if (r.eventKind !== 'version-chunk') continue;
      (prunedIds.has(r.versionId) ? drop : keep).add(r.payloadHash);
    }
    const victims = [...drop].filter((h) => !keep.has(h));
    if (victims.length) this.blobs.delete(docKeyOf(docId), victims);
  }

  /** Refuse a row whose chain position is proven: keep the position and hash, drop the content. */
  private refuse(row: DocRow, reason: string): IngestResult {
    const k = rowKeyOf(row);
    const h = rowHash(row);
    appendLineSync(this.refusedFile, JSON.stringify({ s: streamOf(row), seq: row.seq, hash: h, reason }));
    this.held.add(k);
    this.hashes.set(k, h);
    const head = this.heads.get(streamOf(row));
    if (!head || row.seq > head.seq) this.heads.set(streamOf(row), { seq: row.seq, hash: h });
    this.pending.delete(k);
    return this.ignore(reason);
  }

  /** Start a new incarnation of this machine's chain (after a restore, §3.4). */
  newIncarnation(): string {
    this.incarnation = `i${Date.now().toString(36)}`;
    return this.incarnation;
  }

  private hold(row: DocRow): IngestResult {
    this.pending.set(rowKeyOf(row), row);
    this.writePending();
    return 'pending';
  }

  private ignore(reason: string): IngestResult {
    this.ignored[reason] = (this.ignored[reason] ?? 0) + 1;
    return { ignored: reason };
  }

  private writePending(): void {
    SafeFsExecutor.atomicWriteFileSync(this.pendingFile, [...this.pending.values()].map((r) => JSON.stringify(r)).join('\n') + (this.pending.size ? '\n' : ''), { operation: 'documents.pending', mode: 0o600 });
  }
}

// ── Export and merge-restore (§3.4 "document export") ───────────────────────────────────

/**
 * Bring the export at `<stateDir>/backups/documents/` up to date: append rows it lacks and
 * hard-link blobs it lacks (blobs are immutable and content-addressed, so a link is a full copy
 * that costs nothing). Purged documents and pruned blobs are removed from the export too.
 */
export function updateExport(store: DocumentStore, stateDir: string): { rows: number; blobs: number } {
  const exportDir = path.join(stateDir, 'backups', 'documents');
  const exportRows = path.join(exportDir, 'rows');
  const exportBlobs = path.join(exportDir, 'blobs');
  fs.mkdirSync(exportRows, { recursive: true, mode: 0o700 });
  fs.mkdirSync(exportBlobs, { recursive: true, mode: 0o700 });
  let rowsAdded = 0;
  let blobsLinked = 0;
  for (const docId of store.docIds()) {
    const key = docKeyOf(docId);
    if (store.isPurged(docId)) {
      SafeFsExecutor.safeRmSync(path.join(exportBlobs, key), { recursive: true, force: true, operation: 'documents.export.purge' });
    }
    const target = path.join(exportRows, `${key}.jsonl`);
    const have = new Set(readJsonl<DocRow>(target).map(rowKeyOf));
    for (const r of store.allRowsOf(docId)) {
      if (have.has(rowKeyOf(r))) continue;
      appendLineSync(target, JSON.stringify(r));
      rowsAdded++;
    }
    if (store.isPurged(docId)) continue;
    const src = path.join(store.dir, 'blobs', key);
    const dst = path.join(exportBlobs, key);
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    const live = new Set(safeReaddir(src));
    for (const f of live) {
      const to = path.join(dst, f);
      if (fs.existsSync(to)) continue;
      try { fs.linkSync(path.join(src, f), to); blobsLinked++; } catch { fs.copyFileSync(path.join(src, f), to); blobsLinked++; }
    }
    for (const f of safeReaddir(dst)) {
      if (!live.has(f)) SafeFsExecutor.safeRmSync(path.join(dst, f), { force: true, operation: 'documents.export.prune' });
    }
  }
  return { rows: rowsAdded, blobs: blobsLinked };
}

/**
 * Merge-restore from the export (`POST /docs/restore`): only ever ADDS rows and blobs. Every row is
 * ingested through the normal pipeline, so nothing invalid gets in; blobs of purged documents and
 * pruned versions are refused by the store. A restore can never remove a purge, tombstone or move.
 */
export function mergeRestore(store: DocumentStore, stateDir: string): { rows: number; blobs: number } {
  const exportDir = path.join(stateDir, 'backups', 'documents');
  let rows = 0;
  let blobs = 0;
  for (const file of safeReaddir(path.join(exportDir, 'rows'))) {
    const list = readJsonl<DocRow>(path.join(exportDir, 'rows', file)).sort((a, b) => a.seq - b.seq);
    for (const r of list) if (store.ingest(r) === 'applied') rows++;
  }
  store.recheckPending();
  // A restored machine must not reuse sequence numbers its peers may already hold.
  store.newIncarnation();
  for (const docId of store.docIds()) {
    const dir = path.join(exportDir, 'blobs', docKeyOf(docId));
    const chunkVersions = new Map<string, Set<string>>();
    for (const r of store.allRowsOf(docId)) {
      if (r.eventKind !== 'version-chunk') continue;
      const set = chunkVersions.get(r.payloadHash) ?? new Set<string>();
      set.add(r.versionId);
      chunkVersions.set(r.payloadHash, set);
    }
    for (const f of safeReaddir(dir)) {
      const b = readJson<Blob>(path.join(dir, f));
      if (!b) continue;
      const hash = f.replace(/\.json$/, '');
      const versions = [...(chunkVersions.get(hash) ?? [])];
      // A blob is kept if any version that uses it is kept.
      const keeper = versions.find((v) => !store.isPruned(docId, v));
      if (versions.length > 0 && !keeper) continue;
      if (store.putBlob(docId, b, keeper ? { forVersion: keeper } : {})) blobs++;
    }
  }
  return { rows, blobs };
}

// ── File helpers ────────────────────────────────────────────────────────────────────────

function safeRowHash(row: DocRow): string {
  try { return rowHash(row); } catch { return ''; } // @silent-fallback-ok — an unhashable row is never equal to a held one
}

function appendLineSync(file: string, line: string): void {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; } // @silent-fallback-ok — a missing file is an empty stream
  const out: T[] = [];
  const lines = text.split('\n');
  // A torn final line was never acknowledged (append fsyncs before returning): skip it.
  for (const line of lines) { if (!line.trim()) continue; try { out.push(JSON.parse(line) as T); } catch { /* @silent-fallback-ok — torn tail */ } }
  return out;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } // @silent-fallback-ok — absent state file is empty state
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; } // @silent-fallback-ok — absent dir has no entries
}
