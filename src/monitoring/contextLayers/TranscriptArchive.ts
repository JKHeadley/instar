/**
 * The per-topic transcript archive (context-budget-layered-summaries §6 row L0,
 * §9.7): the session JSONL entries that folds or compactions removed,
 * deduplicated by entry id, compressed, indexed by entry id and message id,
 * scrubbed, and retained under the Disk Steward.
 *
 *   <stateDir>/state/context-archive/<topicKey>/spans/<spanId>.jsonl.gz
 *   <stateDir>/state/context-archive/<topicKey>/index.json
 *
 * A sibling root of the layer store so backup can exclude it whole
 * (`context-archive` is a never-backup segment); never served (File Viewer
 * `NEVER_SERVED_PREFIXES`); machine-local, read across machines only through
 * the proxied transcript route (§14).
 *
 * Scrub: PER TRANSCRIPT ENTRY PER TEXT FIELD before compression, never a whole
 * span as one field (the scrub's oversize fail-safe would otherwise redact the
 * archive entirely), plus the live-value pass. An oversize field is kept as a
 * pointer with its size. The scrub runs AGAIN on every read, so a secret
 * learnt after a span was written never leaves through a later lookup.
 *
 * Retention (§9.7, §12 "Archive retention"): a span is kept while any chunk
 * points at it; eviction goes oldest-superseded-first and never touches the
 * current phase's spans; an evicted span is reported so its chunk is marked
 * `raw-evicted`. The archive itself decides nothing about sessions or
 * messages.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { scrubField, dirBytes } from './LayerStore.js';
import { contextArchiveRoot } from '../engineCheckpoint.js';

const SAFE_TOPIC = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,127}$/;
const SAFE_SPAN = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_ENTRY_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_BUSY = Symbol('index-lock-busy');

export { contextArchiveRoot };

export interface ArchiveEntryInput {
  /** The engine transcript entry id (Claude Code: `uuid`). */
  entryId: string;
  /** TopicMemory message ids this entry carries, if any. */
  messageIds?: number[];
  /** The entry's text fields, by name (each scrubbed on its own). */
  fields: Record<string, string>;
  /** Non-text metadata kept as-is (type, timestamp, tool name). Strings here are scrubbed too. */
  meta?: Record<string, string | number | boolean | null>;
}

export interface ArchivedEntry {
  entryId: string;
  messageIds: number[];
  fields: Record<string, string>;
  meta: Record<string, string | number | boolean | null>;
  /** Fields stored as pointers because they were over the scrub bound. */
  oversizeFields: string[];
  /** Always true: an archive entry is a scrubbed projection, never the original. */
  scrubbed: true;
}

export interface SpanIndexRow {
  spanId: string;
  createdAt: number;
  entries: number;
  bytes: number;
  /** Superseded spans evict first (§9.7 "oldest-superseded-first"). */
  superseded: boolean;
  evictedAt?: number;
}

export interface ArchiveIndex {
  schema: 'context-archive-index/1';
  topicKey: string;
  spans: SpanIndexRow[];
  /** entry id → span id (the dedupe key). */
  entries: Record<string, string>;
  /** message id → span ids that carry it. */
  messages: Record<string, string[]>;
}

export type ArchiveSpanResult =
  | { archived: true; spanId: string; entries: number; deduplicated: number; bytes: number }
  | { archived: false; reason: 'unsafe-id' | 'empty' | 'exists' | 'index-unreadable' | 'write-failed' };

export interface EvictionPlan {
  evict: string[];
  /** Bytes the plan frees. */
  bytes: number;
  /** True when the target could not be met without touching a protected span. */
  short: boolean;
}

export class TranscriptArchive {
  constructor(private readonly o: { stateDir: string; liveSecrets: () => readonly string[]; now?: () => number }) {}

  root(): string { return contextArchiveRoot(this.o.stateDir); }
  private topicDir(topicKey: string): string { return path.join(this.root(), topicKey); }
  private spanFile(topicKey: string, spanId: string): string { return path.join(this.topicDir(topicKey), 'spans', `${spanId}.jsonl.gz`); }
  private indexFile(topicKey: string): string { return path.join(this.topicDir(topicKey), 'index.json'); }

  private ensureDirs(topicKey: string): void {
    for (const d of [this.root(), this.topicDir(topicKey), path.join(this.topicDir(topicKey), 'spans')]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.chmodSync(d, 0o700);
    }
  }

  readIndex(topicKey: string): ArchiveIndex {
    const r = this.readIndexStrict(topicKey);
    return r === 'unreadable' ? { schema: 'context-archive-index/1', topicKey, spans: [], entries: {}, messages: {} } : r;
  }

  /** The index, an empty one when none exists yet, or `unreadable` (never overwritten then). */
  private readIndexStrict(topicKey: string): ArchiveIndex | 'unreadable' {
    const empty: ArchiveIndex = { schema: 'context-archive-index/1', topicKey, spans: [], entries: {}, messages: {} };
    if (!SAFE_TOPIC.test(topicKey)) return empty;
    let text: string;
    try {
      text = fs.readFileSync(this.indexFile(topicKey), 'utf-8');
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? empty : 'unreadable';
    }
    try {
      const raw = JSON.parse(text) as ArchiveIndex;
      return raw && raw.schema === 'context-archive-index/1' && Array.isArray(raw.spans) ? raw : 'unreadable';
    } catch {
      return 'unreadable'; // @silent-fallback-ok — a torn index is reported to the writer as a refused write, never overwritten
    }
  }

  /**
   * Serialise every read-modify-write of a topic's index: the server (archive
   * writes) and the Disk Steward prune child (eviction) are different
   * processes. An O_EXCL lock file; a lock older than LOCK_STALE_MS is a dead
   * holder's and is broken. Waits at most LOCK_WAIT_MS, then gives up (the
   * caller reports a failed write; nothing is half-applied).
   */
  private withIndexLock<T>(topicKey: string, fn: () => T): T | typeof LOCK_BUSY {
    this.ensureDirs(topicKey);
    const lock = path.join(this.topicDir(topicKey), 'index.lock');
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
            SafeFsExecutor.safeRmSync(lock, { force: true, operation: 'src/monitoring/contextLayers/TranscriptArchive.ts:staleLock' });
            continue;
          }
        } catch { continue; /* @silent-fallback-ok — the lock vanished between open and stat; retry */ }
        if (Date.now() > deadline) return LOCK_BUSY;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      SafeFsExecutor.safeRmSync(lock, { force: true, operation: 'src/monitoring/contextLayers/TranscriptArchive.ts:unlock' });
    }
  }

  private writeIndex(topicKey: string, idx: ArchiveIndex): void {
    const file = this.indexFile(topicKey);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private scrubEntry(e: ArchiveEntryInput, secrets: readonly string[]): ArchivedEntry {
    const fields: Record<string, string> = {};
    const oversize: string[] = [];
    for (const [k, v] of Object.entries(e.fields)) {
      const f = scrubField(typeof v === 'string' ? v : String(v), secrets);
      fields[k] = f.text;
      if (f.oversize) oversize.push(k);
    }
    const meta: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(e.meta ?? {})) meta[k] = typeof v === 'string' ? scrubField(v, secrets).text : v;
    const messageIds = (e.messageIds ?? []).filter((n) => Number.isSafeInteger(n));
    return { entryId: e.entryId, messageIds, fields, meta, oversizeFields: oversize, scrubbed: true };
  }

  /**
   * Archive one span. Entries already archived under another span are skipped
   * (deduplicated by entry id). A span id is written once: a second write is
   * refused rather than overwriting what a chunk may already point at.
   */
  archiveSpan(topicKey: string, spanId: string, entries: ArchiveEntryInput[]): ArchiveSpanResult {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_SPAN.test(spanId)) return { archived: false, reason: 'unsafe-id' };
    if (entries.some((e) => !SAFE_ENTRY_ID.test(e.entryId))) return { archived: false, reason: 'unsafe-id' };
    try {
      const r = this.withIndexLock(topicKey, () => this.archiveSpanLocked(topicKey, spanId, entries));
      return r === LOCK_BUSY ? { archived: false, reason: 'write-failed' } : r;
    } catch {
      return { archived: false, reason: 'write-failed' };
    }
  }

  private archiveSpanLocked(topicKey: string, spanId: string, entries: ArchiveEntryInput[]): ArchiveSpanResult {
    const idx = this.readIndexStrict(topicKey);
    // An index that exists but cannot be read is never replaced by a one-span index.
    if (idx === 'unreadable') return { archived: false, reason: 'index-unreadable' };
    if (idx.spans.some((s) => s.spanId === spanId) || fs.existsSync(this.spanFile(topicKey, spanId))) return { archived: false, reason: 'exists' };
    const seen = new Set<string>();
    const fresh = entries.filter((e) => {
      if (idx.entries[e.entryId] || seen.has(e.entryId)) return false;
      seen.add(e.entryId);
      return true;
    });
    if (fresh.length === 0) return { archived: false, reason: 'empty' };
    const secrets = this.o.liveSecrets();
    const lines = fresh.map((e) => JSON.stringify(this.scrubEntry(e, secrets))).join('\n') + '\n';
    try {
      this.ensureDirs(topicKey);
      const file = this.spanFile(topicKey, spanId);
      const tmp = `${file}.${process.pid}.tmp`;
      const gz = zlib.gzipSync(Buffer.from(lines, 'utf-8'));
      fs.writeFileSync(tmp, gz, { mode: 0o600 });
      fs.renameSync(tmp, file);
      for (const e of fresh) {
        idx.entries[e.entryId] = spanId;
        for (const m of e.messageIds ?? []) {
          const k = String(m);
          idx.messages[k] = [...new Set([...(idx.messages[k] ?? []), spanId])];
        }
      }
      idx.spans.push({ spanId, createdAt: (this.o.now ?? Date.now)(), entries: fresh.length, bytes: gz.length, superseded: false });
      this.writeIndex(topicKey, idx);
      return { archived: true, spanId, entries: fresh.length, deduplicated: entries.length - fresh.length, bytes: gz.length };
    } catch {
      return { archived: false, reason: 'write-failed' };
    }
  }

  /** Read a span, re-scrubbed on the way out. `null` when absent or evicted. */
  readSpan(topicKey: string, spanId: string): ArchivedEntry[] | null {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_SPAN.test(spanId)) return null;
    let buf: Buffer;
    try { buf = fs.readFileSync(this.spanFile(topicKey, spanId)); } catch { return null; }
    const secrets = this.o.liveSecrets();
    const out: ArchivedEntry[] = [];
    let text: string;
    try { text = zlib.gunzipSync(buf).toString('utf-8'); } catch { return null; /* @silent-fallback-ok — a corrupt span reads as absent; its index row stays */ }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as ArchivedEntry;
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fields ?? {})) fields[k] = scrubField(String(v), secrets).text;
        // The read-time pass covers metadata too (§9.7 "the scrub also runs on every transcript read").
        const meta: Record<string, string | number | boolean | null> = {};
        for (const [k, v] of Object.entries(e.meta ?? {})) meta[k] = typeof v === 'string' ? scrubField(v, secrets).text : v;
        out.push({ ...e, fields, meta, scrubbed: true });
      } catch { /* @silent-fallback-ok — a torn line is skipped; the rest of the span still reads */ }
    }
    return out;
  }

  /** The span holding an entry id, or null. */
  spanForEntry(topicKey: string, entryId: string): string | null {
    return this.readIndex(topicKey).entries[entryId] ?? null;
  }

  /** The spans carrying a message id. */
  spansForMessage(topicKey: string, messageId: number): string[] {
    return this.readIndex(topicKey).messages[String(messageId)] ?? [];
  }

  markSuperseded(topicKey: string, spanId: string): boolean {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_SPAN.test(spanId)) return false;
    const r = this.withIndexLock(topicKey, () => {
      const idx = this.readIndexStrict(topicKey);
      if (idx === 'unreadable') return false;
      const row = idx.spans.find((s) => s.spanId === spanId);
      if (!row || row.superseded) return false;
      row.superseded = true;
      this.writeIndex(topicKey, idx);
      return true;
    });
    return r === true;
  }

  topicBytes(topicKey: string): number {
    if (!SAFE_TOPIC.test(topicKey)) return 0;
    return dirBytes(this.topicDir(topicKey));
  }

  /**
   * Plan an eviction freeing `targetBytes`: superseded spans first, oldest
   * first, then unsuperseded oldest first. Never a span in `protectedSpans`
   * (the current phase's spans; the caller passes them). A span a chunk
   * points at IS evictable (§9.7: the chunk is then marked `raw-evicted`);
   * the floor is only the current phase.
   */
  planEviction(topicKey: string, targetBytes: number, protectedSpans: ReadonlySet<string>): EvictionPlan {
    const live = this.readIndex(topicKey).spans.filter((s) => s.evictedAt === undefined && !protectedSpans.has(s.spanId));
    const order = [...live].sort((a, b) => (Number(b.superseded) - Number(a.superseded)) || (a.createdAt - b.createdAt));
    const evict: string[] = [];
    let bytes = 0;
    for (const s of order) {
      if (bytes >= targetBytes) break;
      evict.push(s.spanId);
      bytes += s.bytes;
    }
    return { evict, bytes, short: bytes < targetBytes };
  }

  /** Remove a span's bytes; its index row stays (marked evicted) so lookups say `raw-evicted`, not unknown. */
  evictSpan(topicKey: string, spanId: string): boolean {
    if (!SAFE_TOPIC.test(topicKey) || !SAFE_SPAN.test(spanId)) return false;
    const r = this.withIndexLock(topicKey, () => {
      const idx = this.readIndexStrict(topicKey);
      if (idx === 'unreadable') return false;
      const row = idx.spans.find((s) => s.spanId === spanId);
      if (!row || row.evictedAt !== undefined) return false;
      // Index first (marked evicted), then the bytes: a crash between the two
      // leaves an orphan file, never an index row pointing at nothing it claims to hold.
      row.evictedAt = (this.o.now ?? Date.now)();
      this.writeIndex(topicKey, idx);
      SafeFsExecutor.safeRmSync(this.spanFile(topicKey, spanId), { force: true, operation: 'src/monitoring/contextLayers/TranscriptArchive.ts:evictSpan' });
      return true;
    });
    return r === true;
  }

  /** The state of a span for a lookup. */
  spanState(topicKey: string, spanId: string): 'present' | 'raw-evicted' | 'unknown' {
    const row = this.readIndex(topicKey).spans.find((s) => s.spanId === spanId);
    if (!row) return 'unknown';
    return row.evictedAt !== undefined ? 'raw-evicted' : 'present';
  }
}
