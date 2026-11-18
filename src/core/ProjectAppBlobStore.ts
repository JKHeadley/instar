/**
 * ProjectAppBlobStore — the `project-app-blob` replicated kind (store key `projectAppBlobs`) for
 * custom project apps (docs/specs/project-apps-sandbox.md §3.2).
 *
 * PURE: the record schema, builders, the AES-256-GCM chunk sealing (node:crypto, with a key the
 * caller provides), splitting and reassembly, and the folds (newest complete revision, crossed
 * edits, stale base, fenced late writes, the per-app daily byte budget). No file or network I/O.
 *
 * Record types (discriminator `recordType`), all immutable:
 *   project-app-chunk     key chunk:<appId>:<kind>:<keyGen>:<chunk id>
 *                         one ≤ 32 KiB piece of a document, encrypted; base64 ciphertext + nonce.
 *                         The chunk id (field `sha`) is the plain sha256 of the piece for SOURCE, and
 *                         an HMAC-SHA256 of the piece under the generation's data key for DATA, so an
 *                         erase (destroying that key) also leaves nothing to confirm a guess against.
 *                         The key generation is part of the identity, so identical plaintext saved
 *                         after an erase (new generation) is a NEW chunk and never collides with one
 *                         sealed under a destroyed key.
 *   project-app-revision  key rev:<appId>:<hlc>
 *                         {appId, kind, keyGen, contentSha, chunks, bytes, base, by, note?, epoch, at}.
 *                         `contentSha` follows the same rule: plain sha256 for source (it is the
 *                         version's identity on the owner's approval card, and source keys are not
 *                         destroyed by an erase), keyed HMAC for data.
 *                         Writing A → B → A makes three revisions that point at two contents.
 *
 * Every record's complete serialized line stays ≤ 64 KiB (the journal's bound is 80 KiB): the
 * builders refuse a larger one and the schema refuses one from a peer, so JSON escaping can never
 * push a record over the journal bound.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { StoreFieldSchema } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';

export const PROJECT_APP_BLOB_KIND = 'project-app-blob';
/** The stateSync config sub-key (`multiMachine.stateSync.projectAppBlobs`). */
export const PROJECT_APP_BLOB_STORE_KEY = 'projectAppBlobs';

/** At most 32 KiB of raw plaintext per chunk. */
export const CHUNK_PLAINTEXT_MAX = 32 * 1024;
/** The complete serialized JSON line of any record of this kind (and the part-2 summary). */
export const RECORD_LINE_MAX = 64 * 1024;
/** Per-write defaults (owner settings, raised only by a phone-approved card). */
export const SOURCE_WRITE_MAX_DEFAULT = 2 * 1024 * 1024;
export const DATA_WRITE_MAX_DEFAULT = 1 * 1024 * 1024;
export const DAILY_BUDGET_DEFAULT = 8 * 1024 * 1024;
/** Hard ceiling on a revision's chunk list (a raised write limit still fits one record line). */
export const REVISION_CHUNKS_MAX = 512;
export const NOTE_MAX_CHARS = 2000;

export const APP_ID_RE = /^pa_[0-9a-f]{16}$/;
export const BLOB_KINDS = ['source', 'data'] as const;
export type BlobKind = typeof BLOB_KINDS[number];
export const BLOB_RECORD_TYPES = ['project-app-chunk', 'project-app-revision'] as const;
export const REVISION_BY = ['agent', 'app'] as const;
export type RevisionBy = typeof REVISION_BY[number];

const SHA_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const REV_KEY_RE = /^rev:pa_[0-9a-f]{16}:\d+\.\d+\.[\w-]{1,64}$/;
const NONCE_B64_LEN = 16; // 12 bytes
/** base64 of (32 KiB plaintext + 16-byte GCM tag). */
const CHUNK_CT_B64_MAX = Math.ceil((CHUNK_PLAINTEXT_MAX + 16) / 3) * 4;
/** base64 bound for a sealed note (2000 chars × up to 4 UTF-8 bytes + tag). */
const NOTE_CT_B64_MAX = Math.ceil((NOTE_MAX_CHARS * 4 + 16) / 3) * 4;

const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v);
const isGen = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000;
const isB64 = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.length % 4 === 0 && B64_RE.test(v);
export const isAppId = (v: unknown): v is string => typeof v === 'string' && APP_ID_RE.test(v);
const isBlobKind = (v: unknown): v is BlobKind => v === 'source' || v === 'data';

export function sha256Hex(b: Buffer | string): string { return createHash('sha256').update(b).digest('hex'); }

/** Bytes of a record's complete serialized journal line (JSON + the newline). */
export function serializedLineBytes(record: unknown): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
}

/** The emitter's refusal: true only when the complete serialized line fits the 64 KiB cap. */
export function fitsRecordLine(record: unknown): boolean {
  return serializedLineBytes(record) <= RECORD_LINE_MAX;
}

// ── keys and ids ────────────────────────────────────────────────────────────

export function hlcKey(h: HlcTimestamp): string { return `${h.physical}.${h.logical}.${h.node}`; }

export function chunkKey(appId: string, kind: BlobKind, keyGen: number, sha: string): string {
  return `chunk:${appId}:${kind}:${keyGen}:${sha}`;
}

export function revisionKey(appId: string, hlc: HlcTimestamp): string { return `rev:${appId}:${hlcKey(hlc)}`; }

// ── sealing (AES-256-GCM) ───────────────────────────────────────────────────

export interface Sealed { nonce: string; ct: string }

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('project app key must be 32 bytes');
}

/** Seal bytes; `aad` binds the ciphertext to where it belongs so it cannot be moved. `ct` = ciphertext ‖ tag. */
export function seal(key: Buffer, plaintext: Buffer, aad: string, nonce: Buffer = randomBytes(12)): Sealed {
  assertKey(key);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  return { nonce: nonce.toString('base64'), ct: ct.toString('base64') };
}

/** Open sealed bytes; null when the key, the binding or the bytes are wrong. */
export function open(key: Buffer, s: Sealed, aad: string): Buffer | null {
  try {
    assertKey(key);
    const nonce = Buffer.from(s.nonce, 'base64');
    const all = Buffer.from(s.ct, 'base64');
    if (nonce.length !== 12 || all.length < 16) return null;
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(all.subarray(all.length - 16));
    return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
  } catch { return null; } // @silent-fallback-ok — a chunk that does not open is treated as unreadable, never served
}

export const noteAad = (appId: string, keyGen: number) => `project-app-note:${appId}:source:${keyGen}`;
export const summaryAad = (appId: string, keyGen: number) => `project-app-summary:${appId}:data:${keyGen}`;

export function sealText(key: Buffer, text: string, aad: string): Sealed { return seal(key, Buffer.from(text, 'utf8'), aad); }
export function openText(key: Buffer, s: Sealed, aad: string): string | null {
  const b = open(key, s, aad);
  return b ? b.toString('utf8') : null;
}

// ── documents: split, seal, reassemble ──────────────────────────────────────

/** Split on byte boundaries (never characters); the pieces are joined before UTF-8 decoding. */
export function splitIntoChunks(doc: Buffer | string, max = CHUNK_PLAINTEXT_MAX): Buffer[] {
  const b = typeof doc === 'string' ? Buffer.from(doc, 'utf8') : doc;
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += max) out.push(b.subarray(i, Math.min(b.length, i + max)));
  return out;
}

export interface ChunkFields { appId: string; kind: BlobKind; keyGen: number; sha: string; nonce: string; ct: string; at?: string }

/** How a document's chunk ids and whole-content hash are computed (see the header). */
export interface DocHashes { piece: (b: Buffer) => string; doc: (b: Buffer) => string }

/** Plain sha256: the source kind (and the default). */
export const PLAIN_HASHES: DocHashes = { piece: sha256Hex, doc: sha256Hex };

function hmacHex(key: Buffer, label: string, b: Buffer): string {
  return createHmac('sha256', key).update(label, 'utf8').update(Buffer.from([0])).update(b).digest('hex');
}

/**
 * The hashes for one app, kind and key generation. DATA is keyed: HMAC-SHA256 under that
 * generation's data key (separate labels for a piece and the whole document), so the ids in the
 * journal confirm nothing about the contents once an erase destroys the key. The key holder gets the
 * same ids for the same bytes, so dedupe and lookup still work. SOURCE stays plain sha256.
 */
export function docHashes(key: Buffer, ids: { appId: string; kind: BlobKind; keyGen: number }): DocHashes {
  if (ids.kind !== 'data') return PLAIN_HASHES;
  assertKey(key);
  const scope = `${ids.appId}:data:${ids.keyGen}`;
  return {
    piece: (b) => hmacHex(key, `project-app-chunk-id:${scope}`, b),
    doc: (b) => hmacHex(key, `project-app-content-id:${scope}`, b),
  };
}

export interface PreparedDocument {
  contentSha: string;
  bytes: number;
  /** The chunk ids in document order (repeats allowed). */
  chunks: string[];
  /** One sealed chunk per distinct id (what may need writing). */
  chunkRecords: ChunkFields[];
}

/** Split and seal a whole document under one app, kind and key generation. */
export function prepareDocument(key: Buffer, ids: { appId: string; kind: BlobKind; keyGen: number }, doc: Buffer | string): PreparedDocument {
  const b = typeof doc === 'string' ? Buffer.from(doc, 'utf8') : doc;
  const h = docHashes(key, ids);
  const pieces = splitIntoChunks(b);
  const chunks: string[] = [];
  const seen = new Map<string, ChunkFields>();
  for (const p of pieces) {
    const sha = h.piece(p);
    chunks.push(sha);
    if (!seen.has(sha)) {
      const s = seal(key, p, chunkKey(ids.appId, ids.kind, ids.keyGen, sha));
      seen.set(sha, { ...ids, sha, nonce: s.nonce, ct: s.ct });
    }
  }
  return { contentSha: h.doc(b), bytes: b.length, chunks, chunkRecords: [...seen.values()] };
}

/** Open one chunk and check its id; null when anything is off. */
export function openChunk(key: Buffer, c: ChunkFields): Buffer | null {
  const p = open(key, { nonce: c.nonce, ct: c.ct }, chunkKey(c.appId, c.kind, c.keyGen, c.sha));
  return p && docHashes(key, c).piece(p) === c.sha ? p : null;
}

export interface RevisionFields {
  appId: string; kind: BlobKind; keyGen: number; contentSha: string; chunks: string[]; bytes: number;
  base: string | null; by: RevisionBy; note?: Sealed; epoch: number; at: string;
}

/**
 * Reassemble a revision from its chunks' plaintexts (looked up by id) and verify the whole hash
 * and size. Null when a chunk is missing or the result does not match: never a partial document.
 * `hashes` is `docHashes(key, rev)` for a data revision (plain sha256 by default).
 */
export function reassemble(rev: Pick<RevisionFields, 'contentSha' | 'chunks' | 'bytes'>, plainOf: (sha: string) => Buffer | null, hashes: DocHashes = PLAIN_HASHES): Buffer | null {
  const parts: Buffer[] = [];
  for (const sha of rev.chunks) {
    const p = plainOf(sha);
    if (!p || hashes.piece(p) !== sha) return null;
    parts.push(p);
  }
  const all = Buffer.concat(parts);
  return all.length === rev.bytes && hashes.doc(all) === rev.contentSha ? all : null;
}

export function decodeDocument(b: Buffer): string { return b.toString('utf8'); }

// ── schema ──────────────────────────────────────────────────────────────────

const KNOWN_FIELDS = ['recordType', 'appId', 'kind', 'keyGen', 'sha', 'nonce', 'ct', 'contentSha', 'chunks', 'bytes', 'base', 'by', 'note', 'epoch', 'at'] as const;

function vSealed(v: unknown, max: number): Sealed | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (!isB64(s.nonce, NONCE_B64_LEN) || (s.nonce as string).length !== NONCE_B64_LEN || !isB64(s.ct, max)) return null;
  return { nonce: s.nonce as string, ct: s.ct as string };
}

export function validateChunk(raw: Readonly<Record<string, unknown>>): ChunkFields | null {
  if (!isAppId(raw.appId) || !isBlobKind(raw.kind) || !isGen(raw.keyGen) || typeof raw.sha !== 'string' || !SHA_RE.test(raw.sha)) return null;
  if (!isB64(raw.nonce, NONCE_B64_LEN) || (raw.nonce as string).length !== NONCE_B64_LEN || !isB64(raw.ct, CHUNK_CT_B64_MAX)) return null;
  // The ciphertext is the plaintext plus a 16-byte tag; the plaintext is at most 32 KiB.
  const ctBytes = Buffer.from(raw.ct as string, 'base64').length;
  if (ctBytes < 17 || ctBytes > CHUNK_PLAINTEXT_MAX + 16) return null;
  if (raw.recordKey !== undefined && raw.recordKey !== chunkKey(raw.appId, raw.kind, raw.keyGen, raw.sha)) return null;
  if (raw.at !== undefined && !isIso(raw.at)) return null;
  return { appId: raw.appId, kind: raw.kind, keyGen: raw.keyGen, sha: raw.sha, nonce: raw.nonce as string, ct: raw.ct as string, ...(raw.at !== undefined ? { at: raw.at as string } : {}) };
}

export function validateRevision(raw: Readonly<Record<string, unknown>>): RevisionFields | null {
  if (!isAppId(raw.appId) || !isBlobKind(raw.kind) || !isGen(raw.keyGen)) return null;
  if (typeof raw.contentSha !== 'string' || !SHA_RE.test(raw.contentSha)) return null;
  if (!Array.isArray(raw.chunks) || raw.chunks.length > REVISION_CHUNKS_MAX || !raw.chunks.every((c) => typeof c === 'string' && SHA_RE.test(c))) return null;
  if (typeof raw.bytes !== 'number' || !Number.isInteger(raw.bytes) || raw.bytes < 0) return null;
  // The chunk list must be exactly what splitting `bytes` on 32 KiB boundaries gives.
  if (raw.chunks.length !== Math.ceil(raw.bytes / CHUNK_PLAINTEXT_MAX)) return null;
  if (raw.base !== null && (typeof raw.base !== 'string' || !REV_KEY_RE.test(raw.base) || !raw.base.startsWith(`rev:${raw.appId}:`))) return null;
  if (!(REVISION_BY as ReadonlyArray<unknown>).includes(raw.by)) return null;
  if (typeof raw.epoch !== 'number' || !Number.isInteger(raw.epoch) || raw.epoch < 0) return null;
  if (!isIso(raw.at)) return null;
  let note: Sealed | undefined;
  if (raw.note !== undefined) {
    if (raw.kind !== 'source') return null; // only source revisions carry the agent's change note
    const n = vSealed(raw.note, NOTE_CT_B64_MAX); if (!n) return null; note = n;
  }
  if (raw.recordKey !== undefined && (typeof raw.recordKey !== 'string' || !REV_KEY_RE.test(raw.recordKey) || !raw.recordKey.startsWith(`rev:${raw.appId}:`))) return null;
  return {
    appId: raw.appId, kind: raw.kind, keyGen: raw.keyGen, contentSha: raw.contentSha, chunks: [...raw.chunks as string[]],
    bytes: raw.bytes, base: raw.base as string | null, by: raw.by as RevisionBy, ...(note ? { note } : {}), epoch: raw.epoch, at: raw.at,
  };
}

export const projectAppBlobStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['kind', 'by'],
  validate(raw) {
    if (raw.op === 'delete') return null; // immutable; erasure is by destroying keys, never by deleting lines
    if (!fitsRecordLine(raw)) return null;
    const type = raw.recordType;
    if (typeof type !== 'string' || !/^project-app-[a-z-]{1,40}$/.test(type)) return null;
    // A record type from a later build is an inert stub (never refused: refusing stalls replication).
    if (!(BLOB_RECORD_TYPES as ReadonlyArray<string>).includes(type)) return { recordType: type };
    if (type === 'project-app-chunk') { const c = validateChunk(raw); return c ? { recordType: type, ...c } : null; }
    const r = validateRevision(raw);
    return r ? { recordType: type, ...r } : null;
  },
};

export const PROJECT_APP_BLOB_KIND_REGISTRATION = {
  kind: PROJECT_APP_BLOB_KIND,
  store: PROJECT_APP_BLOB_STORE_KEY,
  schema: projectAppBlobStoreSchema,
} as const;

// ── builders (BuildRecordData shape; null = the emitter refuses) ────────────

type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

function envelope(recordKey: string, hlc: HlcTimestamp, origin: string, observed: HlcTimestamp | undefined, fields: Record<string, unknown>): Record<string, unknown> | null {
  const rec = { ...fields, recordKey, hlc, op: 'put', origin, ...(observed !== undefined ? { observed } : {}) };
  return fitsRecordLine(rec) ? rec : null;
}

export function buildChunk(c: ChunkFields, at: string): Build {
  return (hlc, origin, observed) => {
    if (!validateChunk(c as unknown as Record<string, unknown>)) return null;
    return envelope(chunkKey(c.appId, c.kind, c.keyGen, c.sha), hlc, origin, observed, { recordType: 'project-app-chunk', ...c, at });
  };
}

export function buildRevision(r: RevisionFields): Build {
  return (hlc, origin, observed) => {
    if (!validateRevision(r as unknown as Record<string, unknown>)) return null;
    return envelope(revisionKey(r.appId, hlc), hlc, origin, observed, { recordType: 'project-app-revision', ...r });
  };
}

// ── folds ───────────────────────────────────────────────────────────────────

export interface UnionEntry { data: Record<string, unknown>; origin: string }

export interface Revision extends RevisionFields { id: string; hlc: HlcTimestamp; origin: string }

function hlcOf(d: Record<string, unknown>): HlcTimestamp | null {
  const h = d.hlc as HlcTimestamp | undefined;
  return h && Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string' ? h : null;
}

/** Every valid revision, oldest first (HLC order, ties by origin). */
export function foldRevisions(union: UnionEntry[], filter?: { appId?: string; kind?: BlobKind }): Revision[] {
  const out: Revision[] = [];
  for (const e of union) {
    const d = e.data;
    if (d.recordType !== 'project-app-revision') continue;
    const h = hlcOf(d); if (!h) continue;
    const r = validateRevision(d); if (!r) continue;
    if (filter?.appId && r.appId !== filter.appId) continue;
    if (filter?.kind && r.kind !== filter.kind) continue;
    const id = typeof d.recordKey === 'string' ? d.recordKey : revisionKey(r.appId, h);
    out.push({ ...r, id, hlc: h, origin: e.origin });
  }
  return out.sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
}

/** The set of chunk keys present (from the journal or the disk store). */
export function availableChunkKeys(union: UnionEntry[]): Set<string> {
  const s = new Set<string>();
  for (const e of union) {
    if (e.data.recordType !== 'project-app-chunk') continue;
    const c = validateChunk(e.data); if (c) s.add(chunkKey(c.appId, c.kind, c.keyGen, c.sha));
  }
  return s;
}

/** Every chunk the revision names is present (the whole-hash check is `reassemble`'s, at read time). */
export function isComplete(rev: RevisionFields, available: ReadonlySet<string>): boolean {
  return rev.chunks.every((sha) => available.has(chunkKey(rev.appId, rev.kind, rev.keyGen, sha)));
}

/** The lease epoch in force at an HLC. */
export type EpochAt = (hlc: HlcTimestamp) => number;

/** Build an EpochAt from the lease's epoch changes (each epoch and the HLC it took force at). */
export function epochTimeline(changes: Array<{ epoch: number; since: HlcTimestamp }>): EpochAt {
  const sorted = [...changes].sort((a, b) => compareHlc(a.since, b.since));
  return (hlc) => {
    let e = 0;
    for (const c of sorted) { if (compareHlc(c.since, hlc) <= 0) e = Math.max(e, c.epoch); else break; }
    return e;
  };
}

/** A fenced old holder writing late: its epoch is older than the lease epoch in force when journaled. */
export function isFencedLateWrite(rev: Pick<Revision, 'epoch' | 'hlc'>, epochAt?: EpochAt): boolean {
  return !!epochAt && rev.epoch < epochAt(rev.hlc);
}

/** The head of an app+kind: its newest non-fenced revision (complete or not), or null. */
export function headRevision(revs: Revision[], appId: string, kind: BlobKind, epochAt?: EpochAt): Revision | null {
  let head: Revision | null = null;
  for (const r of revs) if (r.appId === appId && r.kind === kind && !isFencedLateWrite(r, epochAt)) head = r; // sorted oldest first
  return head;
}

/** The newest complete, non-fenced revision of an app+kind (optionally restricted by `accept`). */
export function newestCompleteRevision(revs: Revision[], appId: string, kind: BlobKind, available: ReadonlySet<string>, opts?: { epochAt?: EpochAt; accept?: (r: Revision) => boolean }): Revision | null {
  for (let i = revs.length - 1; i >= 0; i--) {
    const r = revs[i];
    if (r.appId !== appId || r.kind !== kind || isFencedLateWrite(r, opts?.epochAt)) continue;
    if (opts?.accept && !opts.accept(r)) continue;
    if (isComplete(r, available)) return r;
  }
  return null;
}

/** Revisions written over the same base (two tabs or machines crossed): groups of ≥ 2, per app+kind. */
export function crossedEdits(revs: Revision[], epochAt?: EpochAt): Array<{ appId: string; kind: BlobKind; base: string | null; revisions: Revision[] }> {
  const groups = new Map<string, Revision[]>();
  for (const r of revs) {
    if (isFencedLateWrite(r, epochAt)) continue;
    const k = `${r.appId}\u0000${r.kind}\u0000${r.base ?? ''}`;
    const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => ({ appId: g[0].appId, kind: g[0].kind, base: g[0].base, revisions: g }));
}

export type BaseCheck = { ok: true } | { ok: false; status: 409; error: 'conflict'; current: Revision | null };

/** A write names the revision it was written over; anything but the current head answers 409. */
export function checkWriteBase(revs: Revision[], appId: string, kind: BlobKind, base: string | null, epochAt?: EpochAt): BaseCheck {
  const head = headRevision(revs, appId, kind, epochAt);
  if ((head?.id ?? null) === base) return { ok: true };
  return { ok: false, status: 409, error: 'conflict', current: head };
}

/** Records that count toward an app's daily budget: its chunks, revisions (whatever the epoch) and summaries. */
const BUDGET_TYPES = new Set(['project-app-chunk', 'project-app-revision', 'project-app-summary']);

export function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

function recordDay(d: Record<string, unknown>): string | null {
  const h = hlcOf(d);
  if (h) return utcDay(h.physical);
  return isIso(d.at) ? (d.at as string).slice(0, 10) : null;
}

/**
 * Serialized journal bytes an app wrote on one UTC day (YYYY-MM-DD), across the blob kind and the
 * summary records of `project-app-record`. Fenced late writes count: they were admitted.
 */
export function budgetUsage(union: UnionEntry[], appId: string, day: string): number {
  let n = 0;
  for (const e of union) {
    const d = e.data;
    if (d.appId !== appId || typeof d.recordType !== 'string' || !BUDGET_TYPES.has(d.recordType)) continue;
    if (recordDay(d) !== day) continue;
    n += serializedLineBytes(d);
  }
  return n;
}

export type BudgetCheck = { ok: true; usedAfter: number } | { ok: false; status: 429; used: number; budget: number };

/** Admit a write of `incomingBytes` serialized bytes against the day's budget (lease holder only). */
export function admitBudget(used: number, incomingBytes: number, budget = DAILY_BUDGET_DEFAULT): BudgetCheck {
  return used + incomingBytes <= budget ? { ok: true, usedAfter: used + incomingBytes } : { ok: false, status: 429, used, budget };
}

/** Per-write size limit (413 naming the limit). */
export function checkWriteSize(kind: BlobKind, bytes: number, limits?: { source?: number; data?: number }): { ok: true } | { ok: false; status: 413; limit: number } {
  const limit = kind === 'source' ? limits?.source ?? SOURCE_WRITE_MAX_DEFAULT : limits?.data ?? DATA_WRITE_MAX_DEFAULT;
  return bytes <= limit ? { ok: true } : { ok: false, status: 413, limit };
}
