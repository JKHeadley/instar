/**
 * CoherenceJournalReader — the bounded, merged READ path for the coherence
 * journal (P1.2 of multi-machine coherence).
 *
 * Spec: docs/specs/COHERENCE-JOURNAL-SPEC.md §3.5 (Read API — bounded, honest
 * about trust and time) and §3.1 (stream layout).
 *
 * DELIBERATELY SEPARATE from the writer (`CoherenceJournal`): §3.9's
 * actuation-ban lint targets imports of THIS module — no actuating code path
 * (kill / spawn / place / transfer / reap) may consume journal data. Keeping
 * the reader its own module gives that lint a single, precise symbol to grep.
 *
 * Read-side discipline (§3.5):
 *  - `machine` / `kind` query params are NEVER used to build a file path. They
 *    are matched against the enumerated on-disk stream set (a directory
 *    listing), so a traversal-shaped param simply matches nothing — the
 *    read-side mirror of the write-side sanitization.
 *  - Reads are reverse-tail (reuse `readTailTolerant`), O(limit) not O(file).
 *  - `limit` is server-capped (≤500). Each query has a total byte ceiling
 *    (default 4MB) and a generic per-stream archive-file scan cap (default 8)
 *    — EXCEPT `kind=topic-placement` queries, which are ANSWER-COMPLETE: they
 *    scan all placement archives newest-first until `limit` is satisfied (the
 *    byte ceiling stays the hard bound). Over any bound → partial +
 *    `truncated: true`.
 *  - Merged ordering: `(epoch, ts)` for topic-placement (epoch from
 *    `data.epoch`); `(ts, machineId, seq)` for other kinds. The opaque
 *    base64url cursor encodes THE QUERY'S order key — a cursor over a different
 *    key than the sort order would skip/duplicate at boundaries. A malformed
 *    cursor is rejected with a clean error, never a crash.
 *  - topic-placement entries sharing one `(topic, epoch)` collapse to
 *    first-seen (defense-in-depth dedupe, §3.1).
 *  - Per-line tolerant parsing everywhere; corrupt lines skipped + counted.
 *  - Replication states (`behind`/`gapped`/`suspect`/`reset`) arrive in P1.3;
 *    P1.2 reports status `current` for every present stream.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  JOURNAL_KINDS,
  readTailTolerant,
  type JournalEntry,
  type JournalFs,
  type JournalKind,
} from './CoherenceJournal.js';

/** Server-side caps (§3.5). */
export const READER_MAX_LIMIT = 500;
export const READER_DEFAULT_LIMIT = 100;
/** Per-query total byte ceiling — the hard bound across ALL streams scanned. */
export const READER_DEFAULT_BYTE_CEILING = 4 * 1024 * 1024;
/** Generic archive-file scan cap per stream (NOT applied to topic-placement). */
export const READER_DEFAULT_ARCHIVE_CAP = 8;

export type StreamSource = 'own' | 'replica';
/** P1.2 reports `current`; the rest land with the P1.3 replication states. */
export type StreamStatusName = 'current' | 'behind' | 'gapped' | 'suspect' | 'reset';

/** A merged entry as returned by the read API. */
export interface ReaderEntry extends JournalEntry {
  source: StreamSource;
  /** When THIS machine learned a replicated entry (replica streams only). */
  recvTs?: string;
}

/** One row of the response `streams` map. */
export interface ReaderStreamStatus {
  incarnation?: string;
  lastSeq: number;
  lastTs: string | null;
  source: StreamSource;
  status: StreamStatusName;
  stalenessMs: number | null;
}

export interface ReaderQueryOpts {
  topic?: number;
  kind?: string;
  machine?: string;
  limit?: number;
  cursor?: string;
}

export interface ReaderQueryResult {
  entries: ReaderEntry[];
  streams: Record<string, ReaderStreamStatus>;
  skippedCorrupt: number;
  truncated: boolean;
}

/**
 * Own-stream autonomous-run evidence for ONE topic (P2 §3.1 source 2).
 * Own stream ONLY by construction — `query()`'s merged own+replica view is
 * deliberately not used: replicas NOMINATE, they never feed THIS machine's
 * manifest (WORKING-SET-HANDOFF-SPEC §3.1).
 */
export interface OwnAutonomousRuns {
  /** Own-stream autonomous-run entries for the topic, newest-first. */
  entries: ReaderEntry[];
  /** True when the newest `started` run has no matching `stopped`. */
  liveRun: boolean;
  /** Union of jailed artifactPaths across the entries, deduped, order-stable. */
  artifactPaths: string[];
  /** Byte/archive bound hit — the answer may be missing older evidence. */
  truncated: boolean;
}

export interface CoherenceJournalReaderConfig {
  /** Absolute path to the agent's `.instar/` directory (the stateDir). */
  stateDir: string;
  /** Per-query total byte ceiling. Default 4MB. */
  byteCeiling?: number;
  /** Generic archive-file scan cap per stream. Default 8. */
  archiveCap?: number;
  /** Optional clock override (tests). */
  now?: () => Date;
  /** Optional fs seam (tests). Defaults to node:fs primitives. */
  fsImpl?: JournalFs;
}

/** Raised when a supplied cursor cannot be parsed. The route maps it to 400. */
export class InvalidCursorError extends Error {
  constructor(message = 'invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** One discovered on-disk stream file (own current/archive, or a peer replica). */
interface DiscoveredStream {
  machineId: string;
  kind: JournalKind;
  file: string;
  isArchive: boolean;
  source: StreamSource;
}

/** The opaque keyset cursor (§3.5). Shape mirrors the query's order key. */
interface Cursor {
  /** present for topic-placement order. */
  epoch?: number;
  ts: string;
  machineId: string;
  seq: number;
}

// ── U4.1 §2C — the answer-complete pin fold (docs/specs/u4-1-pin-persistence.md) ──

/** Per-file byte offsets for the incremental pin-record tail (TokenLedgerPoller
 *  pattern made explicit: idempotent re-scan via byte offsets; a file-identity
 *  change resets the offset). Keyed by absolute file path. */
export type PinFoldOffsets = Record<string, { offset: number; identity: string }>;

/** One raw `topic-pin-record` entry surfaced by the fold (envelope data + origin). */
export interface PinFoldEntry {
  data: Record<string, unknown>;
  origin: string;
  source: StreamSource;
  machineId: string;
}

export interface PinFoldResult {
  entries: PinFoldEntry[];
  /** Updated offsets to feed the NEXT incremental fold. */
  offsets: PinFoldOffsets;
  scannedBytes: number;
  skippedCorrupt: number;
  /** True when the byte-guard engaged (newest-first partial fold; LOUD upstream). */
  truncated: boolean;
  /** The byte ranges left unfolded when the guard engaged — the escalation body. */
  unfolded: Array<{ file: string; fromByte: number; toByte: number }>;
}

function realFs(): JournalFs {
  return {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    fdatasyncSync: fs.fdatasyncSync,
    closeSync: fs.closeSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    renameSync: fs.renameSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    truncateSync: fs.truncateSync,
    mkdirSync: fs.mkdirSync,
    readSync: fs.readSync,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// RULE 3: EXEMPT — this is NOT a provider/CLI state-detector (the Rule-3 class:
// is_running / pane-state / prompt-readiness detection across agent frameworks).
// It reads the coherence journal's own append-only JSONL streams and returns a
// merged history view; there is no external process/provider state being sniffed,
// no fallback chain to mis-detect. Tolerant line-parsing + skippedCorrupt is its
// robustness surface (COHERENCE-JOURNAL-SPEC §3.5), not provider-portability.
export class CoherenceJournalReader {
  private readonly stateDir: string;
  private readonly byteCeiling: number;
  private readonly archiveCap: number;
  private readonly now: () => Date;
  private readonly io: JournalFs;

  constructor(config: CoherenceJournalReaderConfig) {
    this.stateDir = config.stateDir;
    this.byteCeiling = config.byteCeiling ?? READER_DEFAULT_BYTE_CEILING;
    this.archiveCap = config.archiveCap ?? READER_DEFAULT_ARCHIVE_CAP;
    this.now = config.now ?? (() => new Date());
    this.io = config.fsImpl ?? realFs();
  }

  // ---- paths --------------------------------------------------------------

  private dirPath(): string {
    return path.join(this.stateDir, 'state', 'coherence-journal');
  }

  private peersDirPath(): string {
    return path.join(this.dirPath(), 'peers');
  }

  // ---- stream enumeration (the ONLY way machine/kind params are honored) ---

  /**
   * Enumerate every on-disk stream file (own current + archives, peer replicas).
   * `machine` / `kind` filters are matched HERE against the discovered set —
   * never used to build a path — so a traversal-shaped param matches nothing.
   */
  private enumerate(filterMachine?: string, filterKind?: string): DiscoveredStream[] {
    const out: DiscoveredStream[] = [];
    // Own + peer directories use the SAME filename grammar:
    //   <machineId>.<kind>.jsonl                (current)
    //   <machineId>.<kind>.<digits>.jsonl       (archive)
    // The machineId is whatever literal precedes `.<kind>.` on disk (already
    // sanitized at write time). We compare the matched literal against the
    // filter rather than constructing a path from it.
    this.scanDir(this.dirPath(), 'own', out);
    this.scanDir(this.peersDirPath(), 'replica', out);

    return out.filter((s) => {
      if (filterKind !== undefined && s.kind !== filterKind) return false;
      if (filterMachine !== undefined && s.machineId !== filterMachine) return false;
      return true;
    });
  }

  private scanDir(dir: string, source: StreamSource, out: DiscoveredStream[]): void {
    let names: string[];
    try {
      names = this.io.readdirSync(dir) as string[];
    } catch {
      return; // dir absent (e.g. no peers yet) → no streams from here
    }
    // For each known kind, match `<machineId>.<kind>.jsonl` and
    // `<machineId>.<kind>.<digits>.jsonl`. machineId is `[^/]+?` but in
    // practice the write-time sanitization keeps it to [A-Za-z0-9_%-].
    for (const kind of JOURNAL_KINDS) {
      const k = escapeRegExp(kind);
      const re = new RegExp(`^(.+)\\.${k}(?:\\.(\\d+))?\\.jsonl$`);
      for (const name of names) {
        const m = re.exec(name);
        if (!m) continue;
        const machineId = m[1];
        const isArchive = m[2] !== undefined;
        out.push({
          machineId,
          kind,
          file: path.join(dir, name),
          isArchive,
          source,
        });
      }
    }
  }

  // ---- cursor (opaque base64url keyset) -----------------------------------

  private encodeCursor(c: Cursor): string {
    return Buffer.from(JSON.stringify(c), 'utf-8').toString('base64url');
  }

  private decodeCursor(raw: string, isPlacement: boolean): Cursor {
    let obj: unknown;
    try {
      const json = Buffer.from(raw, 'base64url').toString('utf-8');
      obj = JSON.parse(json);
    } catch {
      throw new InvalidCursorError();
    }
    if (!obj || typeof obj !== 'object') throw new InvalidCursorError();
    const o = obj as Record<string, unknown>;
    if (typeof o.ts !== 'string' || typeof o.machineId !== 'string' || typeof o.seq !== 'number') {
      throw new InvalidCursorError();
    }
    if (isPlacement) {
      if (typeof o.epoch !== 'number' || !Number.isFinite(o.epoch)) {
        throw new InvalidCursorError('cursor key does not match query order');
      }
    }
    return {
      ...(isPlacement ? { epoch: o.epoch as number } : {}),
      ts: o.ts,
      machineId: o.machineId,
      seq: o.seq,
    };
  }

  // ---- the main query -----------------------------------------------------

  query(opts: ReaderQueryOpts = {}): ReaderQueryResult {
    const limit = this.clampLimit(opts.limit);
    const kindFilter = opts.kind;
    const machineFilter = opts.machine;
    const topicFilter = typeof opts.topic === 'number' ? opts.topic : undefined;
    const isPlacement = kindFilter === 'topic-placement';

    const streams = this.enumerate(machineFilter, kindFilter);

    // A cursor only round-trips against the query's order key. If a cursor is
    // present we decode it (rejecting a mismatched/garbled one) before reading.
    const cursor = opts.cursor ? this.decodeCursor(opts.cursor, isPlacement) : undefined;

    // Read entries from every matched stream, newest-first, under the shared
    // byte ceiling. The placement exemption (answer-complete) is applied per
    // stream while accumulating.
    const collected: ReaderEntry[] = [];
    let skippedCorrupt = 0;
    let truncated = false;
    let bytesRemaining = this.byteCeiling;

    // Group discovered files by (source, machineId, kind) so we can scan a
    // stream's current file + its archives newest-first as one logical stream.
    const grouped = this.groupStreams(streams);

    for (const group of grouped) {
      // current first (newest), then archives newest→oldest.
      const ordered = this.orderNewestFirst(group.files);
      const isPlacementStream = group.kind === 'topic-placement';
      let archivesScanned = 0;
      for (const f of ordered) {
        if (bytesRemaining <= 0) {
          truncated = true;
          break;
        }
        // Generic archive scan cap — NOT applied to topic-placement (§3.5
        // answer-complete). The current file is always read; the cap counts
        // archive files only.
        if (f.isArchive && !isPlacementStream && archivesScanned >= this.archiveCap) {
          truncated = true;
          break;
        }
        if (f.isArchive) archivesScanned++;

        // Read this file under the *remaining* byte budget. readTailTolerant
        // reads at most `bytesRemaining` bytes from the file end and reports
        // truncation if it could not read the whole file.
        const read = readTailTolerant(this.io, f.file, READER_MAX_LIMIT, bytesRemaining);
        skippedCorrupt += read.skippedCorrupt;
        if (read.truncated) truncated = true;

        // Subtract what readTailTolerant actually consumed (file size bounded
        // by the remaining budget) so the ceiling is shared across all streams.
        const fileSize = this.safeSize(f.file);
        bytesRemaining -= Math.min(fileSize, bytesRemaining);

        for (const e of read.entries) {
          if (topicFilter !== undefined && e.topic !== topicFilter) continue;
          collected.push({
            ...e,
            source: group.source,
            ...(group.source === 'replica' ? { recvTs: this.recvTsFor(f.file) } : {}),
          });
        }
      }
    }

    // Defense-in-depth (topic,epoch) collapse for placement.
    const deduped = isPlacement ? this.collapsePlacement(collected) : collected;

    // Merge-order across all streams.
    const sorted = this.sortMerged(deduped, isPlacement);

    // Apply the cursor (keyset: strictly AFTER the cursor in sort order).
    const afterCursor = cursor ? this.dropThroughCursor(sorted, cursor, isPlacement) : sorted;

    // Page.
    const page = afterCursor.slice(0, limit);
    if (afterCursor.length > limit) {
      // There's a next page; truncation here is paging, not a bound hit, so we
      // do NOT set truncated for it — `truncated` is reserved for byte/archive
      // bound hits per §3.5. (A consumer pages via the next cursor.)
    }

    return {
      entries: page,
      streams: this.buildStreamMap(streams),
      skippedCorrupt,
      truncated,
    };
  }

  /**
   * P2 §3.1: the working-set manifest's journal-evidence source. Reads the
   * OWN stream only (source === 'own', machineId === ownMachineId — never a
   * replica, never a peer's stream that happens to sit in our own dir),
   * kind `autonomous-run`, filtered to `topic`. Bounded exactly like query()
   * (shared byte ceiling + archive cap); over-bound → truncated: true, the
   * caller treats the evidence as partial rather than failing.
   */
  readOwnAutonomousRuns(topic: number, ownMachineId: string): OwnAutonomousRuns {
    const streams = this.enumerate(ownMachineId, 'autonomous-run').filter(
      (s) => s.source === 'own',
    );

    const collected: ReaderEntry[] = [];
    let truncated = false;
    let bytesRemaining = this.byteCeiling;

    for (const group of this.groupStreams(streams)) {
      const ordered = this.orderNewestFirst(group.files);
      let archivesScanned = 0;
      for (const f of ordered) {
        if (bytesRemaining <= 0) {
          truncated = true;
          break;
        }
        if (f.isArchive && archivesScanned >= this.archiveCap) {
          truncated = true;
          break;
        }
        if (f.isArchive) archivesScanned++;
        const read = readTailTolerant(this.io, f.file, READER_MAX_LIMIT, bytesRemaining);
        if (read.truncated) truncated = true;
        bytesRemaining -= Math.min(this.safeSize(f.file), bytesRemaining);
        for (const e of read.entries) {
          if (e.topic !== topic) continue;
          collected.push({ ...e, source: 'own' });
        }
      }
    }

    const sorted = this.sortMerged(collected, false); // newest-first, (ts, machineId, seq)

    // liveRun: the newest run's `started` with no `stopped` for the same runId.
    // Scanning newest-first, the first action we see per runId is its LATEST
    // state — a runId whose first-seen action is 'started' is still running.
    let liveRun = false;
    const seenRuns = new Set<string>();
    for (const e of sorted) {
      const runId = typeof e.data?.runId === 'string' ? (e.data.runId as string) : '';
      const action = e.data?.action;
      if (!runId || seenRuns.has(runId)) continue;
      seenRuns.add(runId);
      if (action === 'started') {
        liveRun = true;
        break;
      }
      if (action === 'stopped') break; // newest run is finished → not live
    }

    // artifactPaths union (write-time jailed already), deduped, newest-first
    // stable order.
    const seenPaths = new Set<string>();
    const artifactPaths: string[] = [];
    for (const e of sorted) {
      const paths = Array.isArray(e.data?.artifactPaths) ? (e.data.artifactPaths as unknown[]) : [];
      for (const p of paths) {
        if (typeof p !== 'string' || !p || seenPaths.has(p)) continue;
        seenPaths.add(p);
        artifactPaths.push(p);
      }
    }

    return { entries: sorted, liveRun, artifactPaths, truncated };
  }

  /**
   * U4.1 §2C (R-r2-3): the dedicated ANSWER-COMPLETE fold path for
   * `topic-pin-record` — streams EVERY entry of the kind (active file AND
   * archives, OWN stream AND every peer-replica stream) FORWARD from the
   * caller's per-file byte offsets, WITHOUT the `READER_MAX_LIMIT` newest-tail
   * clamp (that clamp exists to bound generic tail reads; it silently broke
   * pin answer-completeness — a long-untouched topic's winning record fell out
   * of the newest-500 window as other topics churned).
   *
   * Bounds honestly: `maxBytes` is the fold byte-guard (`ws13FoldMaxBytes`).
   * When the PENDING bytes exceed it the fold reads NEWEST-FIRST up to the
   * budget, reports `truncated: true` + the exact `unfolded` byte ranges, and
   * does NOT advance offsets over unread bytes — never a silent truncation
   * (the caller raises the ONE deduped `u41:pin-fold-truncated` item).
   *
   * Offsets are only advanced past COMPLETE lines (a torn mid-write tail line
   * is left for the next fold), and a file whose identity (dev:ino) changed —
   * or whose size shrank below the recorded offset — resets to 0; re-scans are
   * idempotent by the caller's HLC winner-map semantics.
   */
  foldPinRecords(opts: { priorOffsets?: PinFoldOffsets; maxBytes?: number } = {}): PinFoldResult {
    const KIND = 'topic-pin-record';
    const result: PinFoldResult = {
      entries: [], offsets: {}, scannedBytes: 0, skippedCorrupt: 0, truncated: false, unfolded: [],
    };
    const prior = opts.priorOffsets ?? {};
    const maxBytes = typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : Number.POSITIVE_INFINITY;

    // Discover every stream file of the kind (own + replicas), with stat + resume offset.
    interface FoldFile {
      file: string; source: StreamSource; machineId: string; isArchive: boolean;
      size: number; identity: string; startOffset: number;
    }
    const files: FoldFile[] = [];
    for (const s of this.enumerate(undefined, KIND)) {
      let size = 0;
      let identity = '';
      try {
        const st = this.io.statSync(s.file) as { size: number; dev?: number; ino?: number };
        size = st.size;
        identity = `${st.dev ?? 0}:${st.ino ?? 0}`;
      } catch {
        continue; // vanished between enumerate and stat — next fold re-discovers
      }
      const p = prior[s.file];
      // Identity change (rotation swapped the inode) or shrink → reset to 0.
      const startOffset = p && p.identity === identity && p.offset <= size ? p.offset : 0;
      files.push({ file: s.file, source: s.source, machineId: s.machineId, isArchive: s.isArchive, size, identity, startOffset });
    }

    const pendingOf = (f: FoldFile) => Math.max(0, f.size - f.startOffset);
    const totalPending = files.reduce((acc, f) => acc + pendingOf(f), 0);
    const overBudget = totalPending > maxBytes;
    // Newest-first order for the budgeted partial fold: current files before
    // archives, archives by descending rotation stamp (mirrors orderNewestFirst).
    const ordered = overBudget
      ? [...files].sort((a, b) => {
          if (a.isArchive !== b.isArchive) return a.isArchive ? 1 : -1;
          return this.archiveStamp(b.file) - this.archiveStamp(a.file);
        })
      : files;

    let budget = maxBytes;
    for (const f of ordered) {
      const pending = pendingOf(f);
      if (pending === 0) {
        result.offsets[f.file] = { offset: f.startOffset, identity: f.identity };
        continue;
      }
      if (overBudget && budget <= 0) {
        // Byte-guard engaged: this file's pending range goes UNFOLDED (loud upstream);
        // its offset is NOT advanced, so the next fold retries it.
        result.truncated = true;
        result.unfolded.push({ file: f.file, fromByte: f.startOffset, toByte: f.size });
        result.offsets[f.file] = { offset: f.startOffset, identity: f.identity };
        continue;
      }
      const toRead = overBudget ? Math.min(pending, budget) : pending;
      const { consumedBytes, lines } = this.readForward(f.file, f.startOffset, toRead);
      if (overBudget) budget -= toRead;
      result.scannedBytes += consumedBytes;
      const newOffset = f.startOffset + consumedBytes;
      result.offsets[f.file] = { offset: newOffset, identity: f.identity };
      if (newOffset < f.size) {
        // Partially read (budget cut, or a torn tail line at file end mid-write).
        if (overBudget) {
          result.truncated = true;
          result.unfolded.push({ file: f.file, fromByte: newOffset, toByte: f.size });
        }
      }
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          result.skippedCorrupt++;
          continue;
        }
        const e = parsed as JournalEntry;
        if (!e || typeof e !== 'object' || e.kind !== KIND || !e.data || typeof e.data !== 'object') {
          result.skippedCorrupt++;
          continue;
        }
        result.entries.push({
          data: e.data,
          origin: typeof e.data.origin === 'string' ? (e.data.origin as string) : '',
          source: f.source,
          machineId: f.machineId,
        });
      }
    }
    return result;
  }

  /** Read up to `maxBytes` FORWARD from `offset`, returning complete lines only
   *  (consumedBytes stops at the last newline so a torn tail is never consumed). */
  private readForward(file: string, offset: number, maxBytes: number): { consumedBytes: number; lines: string[] } {
    if (maxBytes <= 0) return { consumedBytes: 0, lines: [] };
    let fd: number;
    try {
      fd = this.io.openSync(file, 'r');
    } catch {
      return { consumedBytes: 0, lines: [] };
    }
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = this.io.readSync(fd, buf, 0, maxBytes, offset);
      if (bytesRead <= 0) return { consumedBytes: 0, lines: [] };
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return { consumedBytes: 0, lines: [] }; // one torn line — wait for the writer
      const complete = text.slice(0, lastNewline);
      // Byte length of the consumed prefix (multi-byte safe), + 1 for the newline.
      const consumedBytes = Buffer.byteLength(complete, 'utf-8') + 1;
      const lines = complete.split('\n').filter((l) => l.trim().length > 0);
      return { consumedBytes, lines };
    } catch {
      return { consumedBytes: 0, lines: [] };
    } finally {
      try { this.io.closeSync(fd); } catch { /* best-effort close */ }
    }
  }

  /** The opaque cursor for the LAST entry of a page (callers echo it back). */
  cursorFor(entry: ReaderEntry, isPlacement: boolean): string {
    const c: Cursor = {
      ...(isPlacement ? { epoch: this.epochOf(entry) } : {}),
      ts: entry.ts,
      machineId: entry.machine,
      seq: entry.seq,
    };
    return this.encodeCursor(c);
  }

  // ---- ordering + dedupe --------------------------------------------------

  private epochOf(e: JournalEntry): number {
    const ep = (e.data as Record<string, unknown>)?.epoch;
    return typeof ep === 'number' && Number.isFinite(ep) ? ep : 0;
  }

  /**
   * Merge order (§3.5):
   *  - topic-placement: (epoch, ts, machineId, seq)
   *  - other kinds:     (ts, machineId, seq)
   * Returned NEWEST-FIRST (descending) — the read API returns most-recent.
   */
  private sortMerged(entries: ReaderEntry[], isPlacement: boolean): ReaderEntry[] {
    const copy = entries.slice();
    copy.sort((a, b) => -this.compareKey(a, b, isPlacement)); // negate → descending
    return copy;
  }

  /** Ascending compare on the query's order key. */
  private compareKey(a: ReaderEntry, b: ReaderEntry, isPlacement: boolean): number {
    if (isPlacement) {
      const ea = this.epochOf(a);
      const eb = this.epochOf(b);
      if (ea !== eb) return ea - eb;
    }
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.machine !== b.machine) return a.machine < b.machine ? -1 : 1;
    return a.seq - b.seq;
  }

  /** Compare an entry against a cursor on the query's order key (ascending). */
  private compareToCursor(e: ReaderEntry, c: Cursor, isPlacement: boolean): number {
    if (isPlacement) {
      const ee = this.epochOf(e);
      const ce = c.epoch ?? 0;
      if (ee !== ce) return ee - ce;
    }
    if (e.ts !== c.ts) return e.ts < c.ts ? -1 : 1;
    if (e.machine !== c.machineId) return e.machine < c.machineId ? -1 : 1;
    return e.seq - c.seq;
  }

  /**
   * Keyset pagination: results are NEWEST-FIRST, the cursor names the last
   * entry already returned, so the next page is everything STRICTLY BEFORE
   * the cursor in descending order (i.e. compareToCursor < 0). No skip/dup at
   * equal-ts boundaries because the full composite key disambiguates.
   */
  private dropThroughCursor(sorted: ReaderEntry[], c: Cursor, isPlacement: boolean): ReaderEntry[] {
    return sorted.filter((e) => this.compareToCursor(e, c, isPlacement) < 0);
  }

  /** topic-placement (topic, epoch) collapse to first-seen (§3.1 dedupe). */
  private collapsePlacement(entries: ReaderEntry[]): ReaderEntry[] {
    const seen = new Set<string>();
    const out: ReaderEntry[] = [];
    for (const e of entries) {
      const key = `${e.topic}:${this.epochOf(e)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  // ---- stream grouping + file ordering ------------------------------------

  private groupStreams(
    streams: DiscoveredStream[],
  ): { source: StreamSource; machineId: string; kind: JournalKind; files: DiscoveredStream[] }[] {
    const map = new Map<string, { source: StreamSource; machineId: string; kind: JournalKind; files: DiscoveredStream[] }>();
    for (const s of streams) {
      const key = `${s.source}|${s.machineId}|${s.kind}`;
      let g = map.get(key);
      if (!g) {
        g = { source: s.source, machineId: s.machineId, kind: s.kind, files: [] };
        map.set(key, g);
      }
      g.files.push(s);
    }
    return [...map.values()];
  }

  /**
   * Newest-first file order for one stream: the current file (no numeric
   * stamp) first, then archives by descending numeric stamp (newest archive
   * before oldest). Archive stamps embed the rotation time (see writer).
   */
  private orderNewestFirst(files: DiscoveredStream[]): DiscoveredStream[] {
    const current = files.filter((f) => !f.isArchive);
    const archives = files.filter((f) => f.isArchive);
    archives.sort((a, b) => this.archiveStamp(b.file) - this.archiveStamp(a.file)); // newest first
    return [...current, ...archives];
  }

  private archiveStamp(file: string): number {
    const m = /\.(\d+)\.jsonl$/.exec(path.basename(file));
    return m ? Number(m[1]) : 0;
  }

  // ---- streams map (status + staleness) -----------------------------------

  /**
   * Build the response `streams` map: one row per discovered stream file's
   * logical stream (`<machineId>.<kind>`), reading the durable tail for
   * lastSeq / lastTs and meta for incarnation. P1.2 reports status `current`.
   */
  private buildStreamMap(streams: DiscoveredStream[]): Record<string, ReaderStreamStatus> {
    const out: Record<string, ReaderStreamStatus> = {};
    const groups = this.groupStreams(streams);
    const nowMs = this.now().getTime();
    for (const g of groups) {
      const key = `${g.machineId}.${g.kind}`;
      // Read the most-recent entry from the newest file for lastSeq/lastTs.
      const ordered = this.orderNewestFirst(g.files);
      let lastSeq = 0;
      let lastTs: string | null = null;
      for (const f of ordered) {
        const read = readTailTolerant(this.io, f.file, 1, this.byteCeiling);
        if (read.entries.length > 0) {
          lastSeq = read.entries[0].seq;
          lastTs = read.entries[0].ts;
          break;
        }
      }
      const incarnation = this.readIncarnation(g.source, g.machineId);
      out[key] = {
        ...(incarnation ? { incarnation } : {}),
        lastSeq,
        lastTs,
        source: g.source,
        status: 'current', // P1.2: replication states land in P1.3
        stalenessMs: lastTs ? Math.max(0, nowMs - new Date(lastTs).getTime()) : null,
      };
    }
    return out;
  }

  /** Read the incarnation token from the stream set's meta sidecar, if present. */
  private readIncarnation(source: StreamSource, machineId: string): string | undefined {
    const dir = source === 'own' ? this.dirPath() : this.peersDirPath();
    const metaPath = path.join(dir, `${machineId}.meta.json`);
    try {
      if (!this.io.existsSync(metaPath)) return undefined;
      const raw = this.io.readFileSync(metaPath, 'utf-8') as string;
      const obj = JSON.parse(raw);
      return typeof obj?.incarnation === 'string' ? obj.incarnation : undefined;
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return undefined;
    }
  }

  /**
   * recvTs for a replica file. P1.2 has no per-entry receipt stamp on disk yet
   * (that rides the P1.3 apply path); we surface the replica file's mtime as a
   * best-effort "when this machine last learned something on this stream".
   */
  private recvTsFor(file: string): string | undefined {
    try {
      const st = this.io.statSync(file);
      return new Date(st.mtimeMs).toISOString();
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return undefined;
    }
  }

  private safeSize(file: string): number {
    try {
      return this.io.statSync(file).size;
    } catch { /* @silent-fallback-ok: journal observability must never endanger the observed operation (COHERENCE-JOURNAL-SPEC §3.1) */
      return 0;
    }
  }

  private clampLimit(raw: number | undefined): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return READER_DEFAULT_LIMIT;
    return Math.min(Math.floor(raw), READER_MAX_LIMIT);
  }
}
