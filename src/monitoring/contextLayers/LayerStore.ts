/**
 * The layer store (context-budget-layered-summaries §9.7, §6).
 *
 *   <stateDir>/state/context-layers/<topicKey>/<recordType>/<entryKey>.json
 *
 * Root and every directory 0700, files 0600 (as IdentityKeyFile does).
 * `.instar/state/` is gitignored and never git-synced; the File Viewer refuses
 * the root (`NEVER_SERVED_PREFIXES`); backup carries the root as the directory
 * entry `state/context-layers/` with fold records and sidecars excluded.
 *
 * Two record families, never mixed:
 *
 *  - DERIVED projections (H1, H2, H3, chunks, C2, referent stubs, probe
 *    records): LLM outputs. Every string field passes
 *    `durableSecretScrub.scrubForStore` PER FIELD and then a live-value pass
 *    against the agent's own secrets. A field over the scrub bound is kept as
 *    a pointer with its size, disclosed (never a whole-record redaction).
 *
 *  - PROTECTED references (Anchor, ledger entries, U): the operator's own
 *    words are NEVER copied here. They are stored as row references
 *    (message id, sha256, length) and rendered from the TopicMemory rows
 *    themselves at stage time, so the verifier's byte-identity check is
 *    against the source row, never a scrubbed copy. A protected write that
 *    carries text is refused.
 *
 * Signal-only storage: this module makes no decision about any message or
 * session. Writers are the Phase 1 layer builders behind
 * `contextBudget.enabled`; nothing writes here while that switch is off.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from '../../core/durableSecretScrub.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { redactLiveValues } from '../PostCompactStore.js';
import { contextLayersRoot } from '../clearSeedPointer.js';
import type { ContextLayerRecordType } from '../contextLayerKind.js';

export const DERIVED_TYPES = ['h1', 'h2', 'h3', 'chunk', 'c2', 'u-stub', 'probe'] as const;
export type DerivedType = typeof DERIVED_TYPES[number];
/** `u-mark`: U's per-topic listing watermark (a row id on THIS machine's TopicMemory; never replicated). */
export const PROTECTED_TYPES = ['anchor', 'ledger-entry', 'u', 'u-mark'] as const;
export type ProtectedType = typeof PROTECTED_TYPES[number];

/** Per-field scrub bound: over it, the field is stored as a pointer with its size. */
export const MAX_FIELD_CHARS = 256 * 1024;

/** A topic key: one path segment, never a leading `_` (the carrier directories `_seeded`, `_clear-seed`, `_fold-markers` live beside topics). */
const SAFE_TOPIC = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,127}$/;
const SAFE_SPAN_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A protected record's data may hold only scalars and identifier-shaped strings: never words. */
const PROTECTED_STRING = /^[A-Za-z0-9_.:-]{0,128}$/;
const SAFE_ENTRY = /^[A-Za-z0-9_.-]{1,160}$/;
/** Field names a protected reference may never carry: the words themselves. */

export { contextLayersRoot };

export interface RowRef {
  /** TopicMemory message id (the per-channel derived integer, §14). */
  messageId: number;
  /** sha256 of the row's exact text, hex. */
  sha256: string;
  /** The row's text length in UTF-16 code units (JavaScript `length`). */
  length: number;
}

export function rowRefFor(messageId: number, text: string): RowRef {
  return { messageId, sha256: crypto.createHash('sha256').update(text, 'utf-8').digest('hex'), length: text.length };
}

/** True when `text` is byte-identical to the row a reference names. */
export function rowRefMatches(ref: RowRef, text: string): boolean {
  if (text.length !== ref.length) return false;
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex') === ref.sha256;
}

export interface ScrubbedField { text: string; redactionKinds: string[]; oversize: boolean }

/** Scrub one text field: shape patterns, then the live-value pass; oversize ⇒ a pointer with its size. */
export function scrubField(raw: string, liveSecrets: readonly string[]): ScrubbedField {
  if (raw.length > MAX_FIELD_CHARS) {
    return { text: `[REDACTED:oversize] (${raw.length} chars withheld)`, redactionKinds: ['oversize'], oversize: true };
  }
  const kinds = new Set<string>();
  const s = scrubForStore(raw, { maxBytes: MAX_FIELD_CHARS + 1 });
  for (const r of s.redactions) kinds.add(r.kind);
  const live = redactLiveValues(s.text, liveSecrets);
  if (live.hit) kinds.add('live-secret');
  return { text: live.text, redactionKinds: [...kinds].sort(), oversize: false };
}

/** Who wrote an H/C/C2/G entry (§6: "so a reseeded session can tell its own handoff from a twin's or the extractor's"). */
export interface LayerAuthor {
  sessionId: string | null;
  machine: string;
  model: string | null;
  kind: 'derived' | 'handoff' | 'user';
}

/** Freshness stamp rendered as `as of <time>, <n> messages behind` (§6). */
export interface LayerAsOf {
  /** When the content was current. */
  at: number;
  /** The last TopicMemory message id the content covers, or null when unknown. */
  lastMessageId: number | null;
}

export interface LayerMeta {
  author: LayerAuthor;
  asOf: LayerAsOf;
  status?: string;
  foldId?: string;
  /**
   * Archive spans this record points at (chunks, H2). Kept OUTSIDE the
   * scrubbed data and constrained to the span-id shape, so the eviction floor
   * (§12) always matches them exactly.
   */
  spanIds?: string[];
}

/** What replication did with the record (the local write stands either way). */
export type ReplicationOutcome = 'emitted' | 'unconfirmed' | 'disabled' | 'oversize' | 'invalid' | 'dropped' | 'not-replicated';

/** The replication seam: builds the layer-kind put and hands it to the journal emitter. */
export type ReplicateLayer = (input: {
  recordType: ContextLayerRecordType;
  topicKey: string;
  entryKey: string;
  body: string;
  status?: string;
  foldId?: string;
}) => ReplicationOutcome;

export interface StoredRecord {
  schema: 'context-layer/1';
  topicKey: string;
  recordType: DerivedType | ProtectedType;
  entryKey: string;
  writtenAt: number;
  /** Derived only: every redaction kind the scrub applied, across fields. */
  redactionKinds?: string[];
  /** Derived only: fields that were over the bound and stored as pointers. */
  oversizeFields?: string[];
  /** Protected only: the rows this record points at. */
  rows?: RowRef[];
  author: LayerAuthor;
  asOf: LayerAsOf;
  status?: string;
  foldId?: string;
  spanIds?: string[];
  data: Record<string, unknown>;
}

export type WriteResult =
  | { written: true; file: string; record: StoredRecord; replication: ReplicationOutcome }
  | { written: false; reason: 'unsafe-id' | 'unknown-type' | 'protected-text' | 'bad-row-ref' | 'bad-meta' | 'write-failed' };

const SAFE_STATUS = /^[A-Za-z0-9_.:-]{1,64}$/;
function validMeta(m: LayerMeta | undefined): m is LayerMeta {
  if (!m || !m.author || !m.asOf) return false;
  if (!['derived', 'handoff', 'user'].includes(m.author.kind) || typeof m.author.machine !== 'string' || !m.author.machine) return false;
  if (!Number.isFinite(m.asOf.at)) return false;
  if (m.asOf.lastMessageId !== null && !Number.isSafeInteger(m.asOf.lastMessageId)) return false;
  if (m.status !== undefined && !SAFE_STATUS.test(m.status)) return false;
  if (m.foldId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(m.foldId)) return false;
  if (m.spanIds !== undefined && (!Array.isArray(m.spanIds) || m.spanIds.length > 10_000 || !m.spanIds.every((x) => typeof x === 'string' && SAFE_SPAN_ID.test(x)))) return false;
  return true;
}

/** True when every leaf of a protected record's data is a scalar or an identifier-shaped string. */
function protectedDataOk(v: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true;
  if (typeof v === 'string') return PROTECTED_STRING.test(v);
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => protectedDataOk(x, depth + 1));
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).every(([k, x]) => PROTECTED_STRING.test(k) && protectedDataOk(x, depth + 1));
  return false;
}

/** The replicated record type for a stored type (U bodies are rows, only their stubs replicate). */
const REPLICATED_TYPE: Record<string, ContextLayerRecordType | null> = {
  h1: 'h1', h2: 'h2', h3: 'h3', chunk: 'chunk', c2: 'c2', 'u-stub': 'u-stub', probe: null,
  anchor: 'anchor', 'ledger-entry': 'ledger-entry', u: null, 'u-mark': null,
};

export class LayerStore {
  constructor(private readonly o: {
    stateDir: string;
    liveSecrets: () => readonly string[];
    now?: () => number;
    replicate?: ReplicateLayer;
    /** Observes every write attempt (feature evidence); never affects the write. */
    onWrite?: (topicKey: string, recordType: string, result: WriteResult) => void;
  }) {}

  private observe(topicKey: string, recordType: string, result: WriteResult): WriteResult {
    try { this.o.onWrite?.(topicKey, recordType, result); } catch { /* @silent-fallback-ok — an observer failure never affects the write */ }
    return result;
  }

  private replicateRecord(record: StoredRecord): ReplicationOutcome {
    const type = REPLICATED_TYPE[record.recordType];
    if (!type) return 'not-replicated';
    if (!this.o.replicate) return 'disabled';
    const { schema: _s, topicKey, recordType: _t, entryKey, ...rest } = record;
    try {
      return this.o.replicate({ recordType: type, topicKey, entryKey, body: JSON.stringify(rest), status: record.status, foldId: record.foldId });
    } catch {
      return 'dropped'; // @silent-fallback-ok — replication is best-effort; the local record stands and the outcome is returned to the writer
    }
  }

  root(): string { return contextLayersRoot(this.o.stateDir); }

  private dirFor(topicKey: string, recordType: string): string {
    return path.join(this.root(), topicKey, recordType);
  }

  private ensureDir(topicKey: string, recordType: string): string {
    const dir = this.dirFor(topicKey, recordType);
    for (const d of [this.root(), path.dirname(dir), dir]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(d).isSymbolicLink()) throw new Error(`layer store directory is a symlink: ${d}`);
      fs.chmodSync(d, 0o700);
    }
    return dir;
  }

  private writeAtomic(dir: string, entryKey: string, record: StoredRecord): string {
    const file = path.join(dir, `${entryKey}.json`);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }

  /** Write a derived projection; every string field (nested included) is scrubbed per field. */
  writeDerived(topicKey: string, recordType: DerivedType, entryKey: string, data: Record<string, unknown>, meta: LayerMeta): WriteResult {
    return this.observe(topicKey, recordType, this.writeDerivedInner(topicKey, recordType, entryKey, data, meta));
  }

  private writeDerivedInner(topicKey: string, recordType: DerivedType, entryKey: string, data: Record<string, unknown>, meta: LayerMeta): WriteResult {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_ENTRY.test(entryKey) || entryKey.startsWith('.')) return { written: false, reason: 'unsafe-id' };
    if (!(DERIVED_TYPES as readonly string[]).includes(recordType)) return { written: false, reason: 'unknown-type' };
    if (!validMeta(meta)) return { written: false, reason: 'bad-meta' };
    const secrets = this.o.liveSecrets();
    const kinds = new Set<string>();
    const oversize: string[] = [];
    const walk = (v: unknown, at: string, depth: number): unknown => {
      if (typeof v === 'string') {
        const f = scrubField(v, secrets);
        for (const k of f.redactionKinds) kinds.add(k);
        if (f.oversize) oversize.push(at);
        return f.text;
      }
      if (v === null || typeof v !== 'object') return v;
      // Past the bound a subtree is replaced, never stored unscrubbed.
      if (depth > 8) { kinds.add('too-deep'); return '[REDACTED:too-deep]'; }
      if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, at ? `${at}.${k}` : k, depth + 1);
      return out;
    };
    const scrubbed = walk(data, '', 0) as Record<string, unknown>;
    const record: StoredRecord = {
      schema: 'context-layer/1', topicKey, recordType, entryKey, writtenAt: (this.o.now ?? Date.now)(),
      redactionKinds: [...kinds].sort(), oversizeFields: oversize,
      author: { ...meta.author }, asOf: { ...meta.asOf },
      ...(meta.status !== undefined ? { status: meta.status } : {}),
      ...(meta.foldId !== undefined ? { foldId: meta.foldId } : {}),
      ...(meta.spanIds !== undefined ? { spanIds: [...meta.spanIds] } : {}),
      data: scrubbed,
    };
    let file: string;
    try {
      file = this.writeAtomic(this.ensureDir(topicKey, recordType), entryKey, record);
    } catch {
      return { written: false, reason: 'write-failed' };
    }
    return { written: true, file, record, replication: this.replicateRecord(record) };
  }

  /**
   * Write a protected reference. The operator's words never land here: a
   * record whose data carries a text-shaped field, or a row ref that is not
   * a (message id, sha256, length) triple, is refused.
   */
  writeProtected(topicKey: string, recordType: ProtectedType, entryKey: string, rows: RowRef[], meta: LayerMeta, data: Record<string, unknown> = {}): WriteResult {
    return this.observe(topicKey, recordType, this.writeProtectedInner(topicKey, recordType, entryKey, rows, meta, data));
  }

  private writeProtectedInner(topicKey: string, recordType: ProtectedType, entryKey: string, rows: RowRef[], meta: LayerMeta, data: Record<string, unknown>): WriteResult {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_ENTRY.test(entryKey) || entryKey.startsWith('.')) return { written: false, reason: 'unsafe-id' };
    if (!(PROTECTED_TYPES as readonly string[]).includes(recordType)) return { written: false, reason: 'unknown-type' };
    if (!validMeta(meta)) return { written: false, reason: 'bad-meta' };
    if (!protectedDataOk(data)) return { written: false, reason: 'protected-text' };
    for (const r of rows) {
      if (!Number.isSafeInteger(r.messageId) || !/^[0-9a-f]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.length) || r.length < 0) {
        return { written: false, reason: 'bad-row-ref' };
      }
    }
    const record: StoredRecord = {
      schema: 'context-layer/1', topicKey, recordType, entryKey, writtenAt: (this.o.now ?? Date.now)(),
      rows: rows.map((r) => ({ messageId: r.messageId, sha256: r.sha256, length: r.length })),
      author: { ...meta.author }, asOf: { ...meta.asOf },
      ...(meta.status !== undefined ? { status: meta.status } : {}),
      ...(meta.foldId !== undefined ? { foldId: meta.foldId } : {}),
      ...(meta.spanIds !== undefined ? { spanIds: [...meta.spanIds] } : {}),
      data,
    };
    let file: string;
    try {
      file = this.writeAtomic(this.ensureDir(topicKey, recordType), entryKey, record);
    } catch {
      return { written: false, reason: 'write-failed' };
    }
    return { written: true, file, record, replication: this.replicateRecord(record) };
  }

  read(topicKey: string, recordType: string, entryKey: string): StoredRecord | null {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_ENTRY.test(entryKey) || !/^[a-z0-9-]{1,32}$/.test(recordType)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dirFor(topicKey, recordType), `${entryKey}.json`), 'utf-8')) as StoredRecord; } catch { return null; }
  }

  /** Records of one type for a topic, newest write first. A torn file is skipped. */
  list(topicKey: string, recordType: string): StoredRecord[] {
    if (!SAFE_TOPIC.test(topicKey) || !/^[a-z0-9-]{1,32}$/.test(recordType)) return [];
    const dir = this.dirFor(topicKey, recordType);
    let names: string[];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out: StoredRecord[] = [];
    for (const f of names) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as StoredRecord); } catch { /* @silent-fallback-ok — a torn record is skipped; its writer rewrites it */ }
    }
    return out.sort((a, b) => b.writtenAt - a.writtenAt);
  }

  remove(topicKey: string, recordType: string, entryKey: string): boolean {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_ENTRY.test(entryKey) || !/^[a-z0-9-]{1,32}$/.test(recordType)) return false;
    const file = path.join(this.dirFor(topicKey, recordType), `${entryKey}.json`);
    if (!fs.existsSync(file)) return false;
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'src/monitoring/contextLayers/LayerStore.ts:remove' });
    return true;
  }

  /** Bytes the topic's layer records occupy (for the dashboard card). */
  topicBytes(topicKey: string): number {
    if (!SAFE_TOPIC.test(topicKey)) return 0;
    return dirBytes(path.join(this.root(), topicKey));
  }
}

export function dirBytes(dir: string, depth = 0): number {
  if (depth > 6) return 0;
  let n = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p, depth + 1);
    else if (e.isFile()) { try { n += fs.statSync(p).size; } catch { /* @silent-fallback-ok — a file removed mid-walk */ } }
  }
  return n;
}
