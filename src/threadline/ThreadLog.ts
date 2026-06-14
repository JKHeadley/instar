/**
 * ThreadLog — the canonical, append-only, hash-chained log, ONE file per thread
 * (Threadline Robustness Phase 2, D-A). The structural fix for F3 (an agent
 * reading "0 messages" on a thread it had just sent 4 messages on).
 *
 * Reuses the `MandateAudit`/`TrustAuditLog` pattern VERBATIM (no new crypto, no
 * new format): each entry embeds the hash of the previous one
 * (`hash = sha256(prevHash + canonical(entry-without-hash))`), append-only JSONL,
 * `verify() → {ok, brokenAt}`. One log file per thread at
 * `{stateDir}/threadline/threads/{threadId}.log.jsonl`.
 *
 * Design points (all from the converged spec):
 *  - Append is IDEMPOTENT on `(threadId, messageId, direction)` via a persisted
 *    per-thread seen-set whose authority is the LIVE LOG itself (rebuilt from the
 *    log on a cold/evicted thread) — NOT a best-effort tail scan (FD-2). A second
 *    append on an existing key whose `contentDigest` DIFFERS is a `collision`
 *    (recorded, never overwritten — a same-id-different-content replay is a
 *    poisoning signal).
 *  - The JSONL append (O(1) `appendFileSync`) is the SOURCE OF TRUTH. `head()`
 *    returns `{count, headHash, setAccum}` from an in-memory running cache that is
 *    REBUILT FROM THE LOG whenever cold — the log always wins.
 *  - `count`/`setAccum` are RETENTION-INDEPENDENT running totals (SI2): rotating
 *    old entries to `archive/` folds them into a base sidecar so the observable
 *    total never changes — asymmetric local rotation between two ends can never
 *    manufacture a false `diverged`.
 *  - `verify()` walks the LIVE segment, anchored at the first live entry's
 *    `prevHash` as the documented chain root (the archived prefix is not walked).
 *    It detects a torn/edited line but not a wholesale self-consistent re-chain —
 *    that residual is caught (partially) by the ConversationStore head stamp and
 *    is named honestly in the spec (the local-FS attacker is already out of scope).
 *
 * Machine-local BY DESIGN under the single-holder model; the per-entry `author`
 * field is the Phase-3 cross-machine-merge seam (recorded, not yet trusted).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import {
  DIGEST_VERSION,
  EMPTY_SET_ACCUM,
  setAccumAdd,
  computeSetAccum,
} from './threadDigest.js';

export type ThreadDirection = 'outbound' | 'inbound';

/** Who authored THIS leg — the Phase-3 cross-machine-merge seam (recorded, not trusted). */
export interface ThreadLogAuthor {
  agentFingerprint?: string;
  sessionName?: string;
  machineId?: string;
}

export type ThreadTextRef =
  | { kind: 'inline'; text: string }
  | { kind: 'store'; messageStoreId: string };

/** A persisted log entry (the full hash-chained shape). */
export interface ThreadLogEntry {
  seq: number;
  threadId: string;
  messageId: string;
  direction: ThreadDirection;
  digestVersion: number;
  contentDigest: string;
  /** Reconstructed from outbox/aggregate; EXCLUDED from the symmetry head (FD-5). */
  backfilled?: true;
  author: ThreadLogAuthor;
  /** The verified peer on the other end of this leg (participant key). */
  peerFingerprint?: string;
  /** Snapshot at append (display only). */
  subject?: string;
  textRef: ThreadTextRef;
  /** The sender-stamped message `createdAt` (the digest input — distinct from `at`). */
  createdAt: string;
  /** ISO APPEND time (when this end logged it) — distinct from the message createdAt. */
  at: string;
  prevHash: string;
  hash: string;
}

/** Caller-supplied fields for an append (seq/at/prevHash/hash are computed here). */
export interface ThreadLogAppendInput {
  threadId: string;
  messageId: string;
  direction: ThreadDirection;
  contentDigest: string;
  digestVersion?: number;
  backfilled?: true;
  author?: ThreadLogAuthor;
  peerFingerprint?: string;
  subject?: string;
  textRef: ThreadTextRef;
  /** The sender-stamped message `createdAt` (the digest input). */
  createdAt: string;
  /** Test/seam injection for the ISO append time. */
  at?: string;
}

export type ThreadLogAppendStatus = 'appended' | 'duplicate' | 'collision';

export interface ThreadLogAppendResult {
  status: ThreadLogAppendStatus;
  entry: ThreadLogEntry | null;
}

export interface ThreadLogHead {
  count: number;
  headHash: string;
  setAccum: string;
}

export interface ThreadLogOptions {
  /** Live-segment size before oldest entries rotate to archive/. */
  maxEntriesPerThread?: number;
  /** Per-thread in-memory seen-set ceiling (memory bound; live log is the authority). */
  seenSetMaxPerThread?: number;
  /** Global LRU ceiling on how many threads' state is held in memory. */
  seenSetMaxThreads?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES_PER_THREAD = 2000;
const DEFAULT_SEEN_SET_MAX_PER_THREAD = 5000;
const DEFAULT_SEEN_SET_MAX_THREADS = 512;
/** archive/ file-count cap per thread (oldest rotated segment is reclaimed). */
const ARCHIVE_SEGMENTS_PER_THREAD = 8;

/** The anchored allowlist for a thread id — the real minted shapes only (FD-7). */
export const THREAD_ID_RE = /^(?:[0-9a-f-]{36}|msg-[a-z0-9]+(?:-[a-z0-9]+)*|thread-[a-z0-9]+(?:-[a-z0-9]+)*)$/;

interface ThreadState {
  /** seq of the next entry to append. */
  nextSeq: number;
  /** hash of the current chain head ('' when empty). */
  headHash: string;
  /** Running total count of NON-backfilled entries (base + live). */
  count: number;
  /** Running setAccum over NON-backfilled entries (base + live). */
  setAccum: string;
  /** messageId|direction → contentDigest, the in-memory dedup + collision cache. */
  seen: Map<string, string>;
  /**
   * True while `seen` holds EVERY live-segment key (no trim has dropped one). When
   * false, a seen-set MISS is not authoritative — the LIVE LOG is consulted before
   * an append, so the seen-set bound is a memory cap, never a (wrong) tail window.
   */
  seenComplete: boolean;
  /** seq of the first entry still in the live segment (rotation root). */
  firstLiveSeq: number;
}

interface RotationBase {
  baseCount: number;
  baseSetAccum: string;
  /** Highest seq that has rotated to archive (so live starts at +1). */
  rotatedThroughSeq: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Canonical bytes an entry's hash covers — field-ordered, hash EXCLUDED. */
function canonicalEntry(e: Omit<ThreadLogEntry, 'hash'>): string {
  return JSON.stringify([
    e.seq, e.threadId, e.messageId, e.direction, e.digestVersion, e.contentDigest,
    e.backfilled ?? false,
    [e.author.agentFingerprint ?? '', e.author.sessionName ?? '', e.author.machineId ?? ''],
    e.peerFingerprint ?? '', e.subject ?? '',
    e.textRef.kind === 'inline' ? ['inline', e.textRef.text] : ['store', e.textRef.messageStoreId],
    e.createdAt, e.at, e.prevHash,
  ]);
}

export class ThreadLog {
  private readonly dir: string;
  private readonly archiveDir: string;
  private readonly maxEntriesPerThread: number;
  private readonly seenSetMaxPerThread: number;
  private readonly seenSetMaxThreads: number;
  private readonly now: () => number;

  /** Bounded LRU of per-thread in-memory state. The log on disk is the authority. */
  private readonly states = new Map<string, ThreadState>();

  constructor(stateDir: string, opts: ThreadLogOptions = {}) {
    this.dir = path.join(stateDir, 'threadline', 'threads');
    this.archiveDir = path.join(this.dir, 'archive');
    this.maxEntriesPerThread = opts.maxEntriesPerThread ?? DEFAULT_MAX_ENTRIES_PER_THREAD;
    this.seenSetMaxPerThread = opts.seenSetMaxPerThread ?? DEFAULT_SEEN_SET_MAX_PER_THREAD;
    this.seenSetMaxThreads = opts.seenSetMaxThreads ?? DEFAULT_SEEN_SET_MAX_THREADS;
    this.now = opts.now ?? Date.now;
  }

  // ── Paths ──────────────────────────────────────────────────────

  private logPath(threadId: string): string {
    return path.join(this.dir, `${threadId}.log.jsonl`);
  }
  private metaPath(threadId: string): string {
    return path.join(this.dir, `${threadId}.meta.json`);
  }
  private archivePath(threadId: string, segment: number): string {
    return path.join(this.archiveDir, `${threadId}.${segment}.log.jsonl`);
  }

  /** Confirm a resolved log path is inside the threads dir (traversal defense, FD-7). */
  isPathConfined(threadId: string): boolean {
    if (!THREAD_ID_RE.test(threadId)) return false;
    const resolved = path.resolve(this.logPath(threadId));
    const root = path.resolve(this.dir) + path.sep;
    return resolved.startsWith(root);
  }

  // ── Append (idempotent, synchronous, off the send critical path) ──

  /**
   * Append one message to the thread's canonical log. Idempotent on
   * `(threadId, messageId, direction)`; first-write-wins. A differing
   * `contentDigest` on an existing key returns `collision` (NOT overwritten). The
   * append is SYNCHRONOUS so two appends in this process cannot interleave the
   * read-head→write window (Node is single-threaded; `appendFileSync` of one
   * sub-PIPE_BUF line is atomic).
   */
  append(input: ThreadLogAppendInput): ThreadLogAppendResult {
    const threadId = input.threadId;
    const direction = input.direction;
    const messageId = input.messageId;
    const key = `${messageId}|${direction}`;
    const state = this.loadState(threadId);

    const existing = this.lookupSeen(threadId, state, key);
    if (existing !== undefined) {
      if (existing === input.contentDigest) return { status: 'duplicate', entry: null };
      return { status: 'collision', entry: null };
    }

    const unsigned: Omit<ThreadLogEntry, 'hash'> = {
      seq: state.nextSeq,
      threadId,
      messageId,
      direction,
      digestVersion: input.digestVersion ?? DIGEST_VERSION,
      contentDigest: input.contentDigest,
      ...(input.backfilled ? { backfilled: true as const } : {}),
      author: input.author ?? {},
      ...(input.peerFingerprint ? { peerFingerprint: input.peerFingerprint } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      textRef: input.textRef,
      createdAt: input.createdAt,
      at: input.at ?? new Date(this.now()).toISOString(),
      prevHash: state.headHash,
    };
    const entry: ThreadLogEntry = { ...unsigned, hash: sha256(state.headHash + canonicalEntry(unsigned)) };

    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.logPath(threadId), JSON.stringify(entry) + '\n');

    // Advance in-memory running state. Backfilled legs are EXCLUDED from the
    // symmetry head (count/setAccum) — they cannot reproduce the live projection.
    state.nextSeq += 1;
    state.headHash = entry.hash;
    state.seen.set(key, entry.contentDigest);
    if (!entry.backfilled) {
      state.count += 1;
      state.setAccum = setAccumAdd(state.setAccum, entry.contentDigest);
    }
    this.trimSeen(state);
    this.rotateIfNeeded(threadId, state);
    return { status: 'appended', entry };
  }

  // ── Reads ──────────────────────────────────────────────────────

  /** True if `(messageId, direction)` is already logged (live-log authority). */
  has(threadId: string, messageId: string, direction: ThreadDirection): boolean {
    const state = this.loadState(threadId);
    return this.lookupSeen(threadId, state, `${messageId}|${direction}`) !== undefined;
  }

  /**
   * The authoritative dedup lookup: the in-memory seen cache first, falling back
   * to a LIVE-LOG scan when the cache is incomplete (trimmed). Returns the stored
   * `contentDigest` for the key, or undefined when genuinely unseen. This is what
   * makes idempotency the full-live-log authority rather than a tail window — a
   * duplicate is caught however many entries intervened.
   */
  private lookupSeen(threadId: string, state: ThreadState, key: string): string | undefined {
    const cached = state.seen.get(key);
    if (cached !== undefined) return cached;
    if (state.seenComplete) return undefined; // cache holds every live key — a miss is final
    const fromLog = this.findInLiveLog(threadId, key);
    if (fromLog !== undefined) state.seen.set(key, fromLog); // re-warm the bounded cache
    return fromLog;
  }

  private findInLiveLog(threadId: string, key: string): string | undefined {
    for (const e of this.readLiveEntries(threadId)) {
      if (`${e.messageId}|${e.direction}` === key) return e.contentDigest;
    }
    return undefined;
  }

  /**
   * Read the LIVE segment paginated by `seq` cursor. `afterSeq` returns entries
   * with `seq > afterSeq`; O(limit) per page over the bounded live segment.
   */
  read(threadId: string, opts: { limit?: number; afterSeq?: number } = {}): { entries: ThreadLogEntry[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const after = opts.afterSeq ?? -1;
    const all = this.readLiveEntries(threadId);
    const filtered = all.filter((e) => e.seq > after);
    const page = filtered.slice(0, limit);
    return { entries: page, hasMore: filtered.length > page.length };
  }

  /** Head `{count, headHash, setAccum}` — from the in-memory cache, log-rebuilt if cold. */
  head(threadId: string): ThreadLogHead {
    const s = this.loadState(threadId);
    return { count: s.count, headHash: s.headHash, setAccum: s.setAccum };
  }

  /** The verified peer fingerprints recorded across this thread's live legs. */
  participants(threadId: string): Set<string> {
    const out = new Set<string>();
    for (const e of this.readLiveEntries(threadId)) {
      if (e.peerFingerprint) out.add(e.peerFingerprint);
    }
    return out;
  }

  /** True if any live leg is `backfilled` (drives the `unverified-backfill` state). */
  hasBackfilledLegs(threadId: string): boolean {
    return this.readLiveEntries(threadId).some((e) => e.backfilled === true);
  }

  /**
   * Verify the LIVE segment of the chain, anchored at the first live entry's
   * `prevHash` as the documented chain root (FD-10). Returns `{ok:false, brokenAt}`
   * at the first entry whose recomputed hash or prevHash linkage breaks.
   */
  verify(threadId: string): { ok: true } | { ok: false; brokenAt: number } {
    const all = this.readLiveEntries(threadId);
    if (all.length === 0) return { ok: true };
    let prevHash = all[0].prevHash; // anchor: archived predecessor's hash (root)
    for (let i = 0; i < all.length; i++) {
      const { hash, ...unsigned } = all[i];
      if (unsigned.prevHash !== prevHash) return { ok: false, brokenAt: i };
      if (sha256(prevHash + canonicalEntry(unsigned)) !== hash) return { ok: false, brokenAt: i };
      prevHash = hash;
    }
    return { ok: true };
  }

  /** All live thread ids that have a log file on disk (for the orphan sweep). */
  listThreadIds(): string[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { /* @silent-fallback-ok — no threads dir yet, empty history is the natural default */ return []; }
    const out: string[] = [];
    for (const n of names) {
      const m = n.match(/^(.+)\.log\.jsonl$/);
      if (m) out.push(m[1]);
    }
    return out;
  }

  // ── Retention ──────────────────────────────────────────────────

  /**
   * Delete a thread's log + archive segments + meta sidecar (close-only
   * retention, driven by the ConversationStore `closed` lifecycle — NEVER on cold
   * LRU eviction; SA5). All deletes route through SafeFsExecutor.
   */
  deleteThread(threadId: string): void {
    this.states.delete(threadId);
    const targets = [this.logPath(threadId), this.metaPath(threadId)];
    for (let seg = 0; seg < ARCHIVE_SEGMENTS_PER_THREAD + 2; seg++) targets.push(this.archivePath(threadId, seg));
    for (const t of targets) {
      try {
        if (fs.existsSync(t)) SafeFsExecutor.safeUnlinkSync(t, { operation: 'ThreadLog.deleteThread' });
      } catch { /* @silent-fallback-ok — best-effort retention delete; a residual file is reclaimed by the orphan sweep */ }
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  /** Read every entry in the live segment (tolerant of a torn trailing line). */
  private readLiveEntries(threadId: string): ThreadLogEntry[] {
    let content: string;
    try { content = fs.readFileSync(this.logPath(threadId), 'utf-8'); } catch { /* @silent-fallback-ok — no log file = empty history, not an error (D-A) */ return []; }
    const out: ThreadLogEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as ThreadLogEntry); } catch { /* @silent-fallback-ok — torn trailing line; a crash mid-append must not poison reads */ }
    }
    return out;
  }

  private readBase(threadId: string): RotationBase {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(threadId), 'utf-8'));
      if (raw && typeof raw.baseCount === 'number' && typeof raw.baseSetAccum === 'string') {
        return { baseCount: raw.baseCount, baseSetAccum: raw.baseSetAccum, rotatedThroughSeq: raw.rotatedThroughSeq ?? -1 };
      }
    } catch { /* @silent-fallback-ok — no rotation yet, base is the zero element */ }
    return { baseCount: 0, baseSetAccum: EMPTY_SET_ACCUM, rotatedThroughSeq: -1 };
  }

  private writeBase(threadId: string, base: RotationBase): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.metaPath(threadId)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(base));
    fs.renameSync(tmp, this.metaPath(threadId));
  }

  /** Load (or rebuild from the log) the in-memory running state for a thread. */
  private loadState(threadId: string): ThreadState {
    const cached = this.states.get(threadId);
    if (cached) {
      // LRU touch.
      this.states.delete(threadId);
      this.states.set(threadId, cached);
      return cached;
    }
    const base = this.readBase(threadId);
    const live = this.readLiveEntries(threadId);
    const seen = new Map<string, string>();
    let count = base.baseCount;
    let setAccum = base.baseSetAccum;
    let nextSeq = base.rotatedThroughSeq + 1;
    let headHash = '';
    let firstLiveSeq = base.rotatedThroughSeq + 1;
    if (live.length > 0) firstLiveSeq = live[0].seq;
    for (const e of live) {
      seen.set(`${e.messageId}|${e.direction}`, e.contentDigest);
      if (!e.backfilled) {
        count += 1;
        setAccum = setAccumAdd(setAccum, e.contentDigest);
      }
      headHash = e.hash;
      if (e.seq + 1 > nextSeq) nextSeq = e.seq + 1;
    }
    const state: ThreadState = { nextSeq, headHash, count, setAccum, seen, seenComplete: true, firstLiveSeq };
    this.trimSeen(state);
    this.states.set(threadId, state);
    this.evictStatesIfNeeded();
    return state;
  }

  /** Cap the in-memory seen cache; once it evicts a key it is no longer complete. */
  private trimSeen(state: ThreadState): void {
    while (state.seen.size > this.seenSetMaxPerThread) {
      const oldest = state.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      state.seen.delete(oldest);
      state.seenComplete = false; // the live log is now the authority on a miss
    }
  }

  private evictStatesIfNeeded(): void {
    while (this.states.size > this.seenSetMaxThreads) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.states.delete(oldest); // cold-evict ONLY (never deletes the log — SA5)
    }
  }

  /**
   * Rotate the oldest entries to archive/ when the live segment exceeds the cap.
   * Rotation NEVER changes the observable total `count`/`setAccum` (SI2): the
   * rotated entries are folded into the base sidecar so base + live is invariant.
   */
  private rotateIfNeeded(threadId: string, state: ThreadState): void {
    const live = this.readLiveEntries(threadId);
    if (live.length <= this.maxEntriesPerThread) return;
    // Keep the newest half of the cap; rotate the rest.
    const keepFrom = live.length - Math.floor(this.maxEntriesPerThread / 2);
    const rotate = live.slice(0, keepFrom);
    const keep = live.slice(keepFrom);
    if (rotate.length === 0) return;

    const base = this.readBase(threadId);
    // Fold rotated NON-backfilled entries into the base — total stays invariant.
    let baseCount = base.baseCount;
    let baseSetAccum = base.baseSetAccum;
    for (const e of rotate) {
      if (!e.backfilled) {
        baseCount += 1;
        baseSetAccum = setAccumAdd(baseSetAccum, e.contentDigest);
      }
    }
    const rotatedThroughSeq = rotate[rotate.length - 1].seq;

    // Append rotated lines to the next archive segment, then rewrite live to keep.
    const segment = (base.rotatedThroughSeq < 0 ? 0 : this.nextArchiveSegment(threadId));
    fs.mkdirSync(this.archiveDir, { recursive: true });
    fs.appendFileSync(this.archivePath(threadId, segment), rotate.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const tmp = `${this.logPath(threadId)}.${process.pid}.rot.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, this.logPath(threadId));
    this.writeBase(threadId, { baseCount, baseSetAccum, rotatedThroughSeq });
    this.reclaimOldArchive(threadId);
    state.firstLiveSeq = keep.length ? keep[0].seq : rotatedThroughSeq + 1;
  }

  private nextArchiveSegment(threadId: string): number {
    let names: string[];
    try { names = fs.readdirSync(this.archiveDir); } catch { /* @silent-fallback-ok — no archive yet, first segment is 0 */ return 0; }
    let max = -1;
    for (const n of names) {
      const m = n.match(new RegExp(`^${threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.log\\.jsonl$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  /** Keep the archive file-count bounded (oldest rotated segment reclaimed). */
  private reclaimOldArchive(threadId: string): void {
    let names: string[];
    try { names = fs.readdirSync(this.archiveDir); } catch { /* @silent-fallback-ok — no archive dir, nothing to reclaim */ return; }
    const segs: number[] = [];
    for (const n of names) {
      const m = n.match(new RegExp(`^${threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)\\.log\\.jsonl$`));
      if (m) segs.push(Number(m[1]));
    }
    segs.sort((a, b) => a - b);
    while (segs.length > ARCHIVE_SEGMENTS_PER_THREAD) {
      const drop = segs.shift()!;
      try { SafeFsExecutor.safeUnlinkSync(this.archivePath(threadId, drop), { operation: 'ThreadLog.reclaimOldArchive' }); } catch { /* @silent-fallback-ok — best-effort archive reclaim */ }
    }
  }
}
