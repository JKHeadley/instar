/**
 * ConversationStore — the single source of truth for a Threadline conversation.
 *
 * Phase 1 of the Threadline re-assessment (THREADLINE-CONVERSATION-KEYSTONE-SPEC.md)
 * introduced this as a server-process in-memory store. Phase 2a
 * (THREADLINE-SINGLE-STORE-SPEC.md / CMT-497) makes it **cross-process safe** so it
 * can be the ONE authoritative store and the legacy `ThreadResumeMap` can become a
 * view over it.
 *
 * Concurrency (Phase 2a): `conversations.json` on disk is the source of truth.
 * Every write — async `mutate()` and sync `mutateSync()` — does reload-per-op +
 * optimistic per-record version CAS + atomic tmp-write+rename, the same
 * cross-process-safe pattern the legacy maps used (reload-per-op) hardened with a
 * `version` token so a same-thread race loses no update (a strict improvement over
 * the legacy last-writer-wins). A write reads the LATEST full file immediately
 * before committing and rewrites it with only its own record changed, so a
 * concurrent write to a DIFFERENT thread from another process is preserved — the
 * only residual is the microsecond window between that final re-read and the
 * atomic rename, which matches the (accepted, never-observed-as-a-problem) legacy
 * full-file-rewrite behavior. Reads use a very-short-TTL snapshot cache so the
 * loop gate's hot path doesn't re-read on every call; staleness only ever causes a
 * redundant reload on the next mutate (which always re-reads), never a lost write.
 *
 * Storage: {stateDir}/threadline/conversations.json. NOT relay-hosted —
 * authoritative state stays local. The append-only SharedStateLedger remains the
 * audit trail; this is the live mutable state it logs transitions from.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { NegotiatorLease, LeaseOwner, LeaseResult } from './NegotiatorLease.js';

// ── Types ───────────────────────────────────────────────────────

/**
 * Conversation lifecycle state. Superset of the legacy `ThreadState`
 * (`active|idle|resolved|failed|archived`) plus `open` (created, not yet
 * worked) and `awaiting-reply` (we replied, waiting on the peer). `idle` is
 * also the warrants-a-reply gate's "suppressed, do not spawn" terminal-ish
 * state.
 */
export type ConversationState =
  | 'open'
  | 'active'
  | 'idle'
  | 'awaiting-reply'
  | 'resolved'
  | 'failed'
  | 'archived';

/**
 * The durable conversation record. EXHAUSTIVE against the legacy stores — an
 * incomplete field list silently drops live data on migration (convergence
 * finding). Every field the four legacy stores held is preserved here.
 */
export interface Conversation {
  /** Primary key — the Threadline thread id. */
  threadId: string;
  /** Monotonic version for optimistic CAS in mutate(). */
  version: number;

  /** Conversation participants — self + peer fingerprint(s). */
  participants: {
    /** This agent's name/fingerprint (best-effort). */
    self?: string;
    /** Remote peer fingerprint(s). */
    peers: string[];
  };
  /** Convenience display handle for the primary remote peer. */
  remoteAgent?: string;

  /** Lifecycle state. */
  state: ConversationState;
  /** When state became 'resolved' (grace-period clock). */
  resolvedAt?: string;

  // ── Resume primitives (from ThreadResumeEntry — dropping these breaks resume) ──
  /** The Claude/Codex session UUID the resume primitive depends on. */
  sessionUuid?: string;
  /** The live (or last-known) tmux session bound to this conversation. */
  boundSessionName?: string;
  /** Owning Telegram topic (formerly originTopicId). */
  boundTopicId?: number;
  /** Originating topic-session name at send time (fast-path resume cache). */
  originSessionName?: string;
  /** Spawn mode of the worker handling this conversation. */
  spawnMode?: 'interactive' | 'pipe';
  /** Thread subject. */
  subject?: string;

  // ── A2A context binding (from ContextThreadMap — the hijack guard) ──
  /** A2A contextId mapped to this thread, if any. */
  contextId?: string;
  /**
   * The authenticated agent identity that owns the contextId binding. Dropping
   * this reopens the session-smuggling vector ContextThreadMap defends.
   */
  agentIdentity?: string;

  // ── Bookkeeping ──
  pinned: boolean;
  messageCount: number;

  // ── Cross-machine failover (from ThreadResumeEntry) ──
  machineOrigin?: string;
  migratedTo?: string;
  migrateFrom?: string;

  // ── Turn state + novelty (the loop-gate's home — lives here, not on the worker) ──
  turnCount: number;
  lastInboundHash?: string;
  lastOutboundHash?: string;

  // ── Timestamps + trust snapshot ──
  createdAt: string;
  savedAt: string;
  lastActivityAt: string;
  /** Snapshot of the unified-trust level at last contact. */
  trustLevel?: string;
  /** Snapshot of the MoltBridge IQS band at last contact. */
  iqsBand?: string;

  // ── Negotiator lease (Robustness Phase 1 — additive + optional) ──
  // An existing conversations.json without these loads unchanged; the acquire
  // path defensively initializes them. See THREADLINE-SINGLE-NEGOTIATOR-SPEC.md.
  /** The single-negotiator lease — names the one session that owns the voice. */
  negotiatorLease?: NegotiatorLease;
  /** Durable per-epoch holding-notice rate limit (FD-3). */
  lastHoldingNoticeEpoch?: number;
  /** Durable global min-interval floor for holding notices (FD-3). */
  lastHoldingNoticeAt?: string;

  // ── Canonical-history head cache (Robustness Phase 2, D-A/FD-2 — additive) ──
  // A best-effort COALESCED cache of the ThreadLog head — the JSONL log is the
  // source of truth. Refreshed off a debounce / lifecycle mutate, NEVER inside a
  // synchronous per-message CAS. On any read, if the cache ≠ the log's actual
  // head, the cache is rebuilt from the log (log wins) before use.
  /** Cached count of NON-backfilled canonical-log entries (symmetry `count`). */
  historyCount?: number;
  /** Cached canonical-log chain head hash. */
  historyHeadHash?: string;
  /** Cached order-independent symmetry accumulator (64-hex). */
  historySetAccum?: string;
  /** Saturating count of same-id-different-content collisions (FD-2, anti-amplify). */
  collisionCount?: number;

  // ── Conversation-discipline resolver binding (D-E — additive, verified-only) ──
  // When set, THIS thread is the canonical thread for the (peerPrincipal,
  // workstreamKey) group. The resolver joins later outbound sends on the same key
  // to this threadId instead of minting a fork. peerPrincipal is ALWAYS the
  // VERIFIED peer fingerprint (never a name/subject a peer asserts).
  canonicalBinding?: { peerPrincipal: string; workstreamKey: string };

  // ── Cross-end symmetry state (D-D — additive, advisory-only) ──
  /** Last symmetry health computed for this thread (closed set; advisory). */
  symmetryState?: string;
  /** Last peer-reported threadSync (verified-participant, monotonic). */
  peerThreadSync?: { digestVersion: number; count: number; setAccum: string; at: string };
  /** True once a one-time bounded backfill has run for this thread (memoized). */
  backfilled?: boolean;
}

/** Mutation function: receives a draft clone, returns the next record. */
export type ConversationMutateFn = (draft: Conversation) => Conversation | Promise<Conversation>;

interface ConversationStoreFile {
  version: 1;
  conversations: Record<string, Conversation>;
  lastModified: string;
}

// ── Constants ───────────────────────────────────────────────────

/** Entries older than 7 days are pruned (non-pinned only) — matches legacy TTL. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Resolved conversations get a 7-day grace before removal — matches legacy. */
const RESOLVED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap before LRU eviction of non-pinned entries — matches ThreadResumeMap. */
const MAX_ENTRIES = 1000;
/** Inactive non-pinned conversations leave the active set after this window. */
const DEFAULT_INACTIVE_RETIRE_MS = 24 * 60 * 60 * 1000;

/** Max depth of the per-id mutate queue. Enqueue beyond this rejects. */
const MUTATE_QUEUE_MAX_DEPTH = 256;
/** Max CAS retries when the version drifts under an apply (cross-process). */
const MUTATE_CAS_MAX_RETRIES = 8;
/** Read-snapshot cache TTL — keeps the gate's hot path off per-call disk reads. */
const READ_CACHE_TTL_MS = 250;

/** Saturating ceiling for the per-thread collision counter (FD-2, anti-amplify). */
const COLLISION_COUNTER_CEILING = 1000;

// ── Ephemeral verified-only peer-affinity (NOT persisted) ────────
//
// The legacy peer-affinity map is a SHORT (10-min sliding / 2-hr absolute),
// verified-only, deliberately ephemeral hint — promoting it to a durable,
// unverified binding would reopen a hijack vector (spec §1). We keep it in
// memory on the store so it is lost on restart by design (accepted loss).
const AFFINITY_SLIDING_MS = 10 * 60 * 1000;
const AFFINITY_ABSOLUTE_MS = 2 * 60 * 60 * 1000;

interface AffinityHint {
  threadId: string;
  firstSeen: number;
  lastSeen: number;
}

// ── Mutate queue plumbing ────────────────────────────────────────

interface MutateQueueEntry {
  fn: ConversationMutateFn;
  resolve: (c: Conversation) => void;
  reject: (e: Error) => void;
}

// ── Implementation ──────────────────────────────────────────────

/** P3 §3.1 — states whose entry counts as 'closed' for the lifecycle diff. */
const TERMINAL_CONVERSATION_STATES = new Set(['resolved', 'failed', 'archived']);

/**
 * Robustness Phase 2 (SA5/FD-10) — the states whose ENTRY drives canonical-log
 * DELETION. Deliberately a STRICT SUBSET of TERMINAL_CONVERSATION_STATES: it
 * EXCLUDES 'archived' because `archived` is the COLD/inactivity-retired state
 * (retireInactive uses it, and a later peer reply can reactivate the thread) —
 * deleting its log would destroy a live relationship's history and re-create an
 * empty log on the next message, a fresh F3 regression. Only a genuine terminal
 * close (resolved/failed) deletes the log. A cold LRU/prune eviction never fires
 * this seam at all (pruneMapInPlace deletes the map key with no lifecycle diff).
 */
const LOG_DELETION_STATES = new Set(['resolved', 'failed']);

export class ConversationStore {
  /** P3 §3.1 — injected coherence-journal emitter (undefined = dark). */
  private journalSeam?: (data: { action: 'started' | 'bound' | 'unbound' | 'closed'; conversationId: string; peerFingerprint: string; topicId?: number }) => void;

  /**
   * Robustness Phase 2 (SA5/E1) — injected post-commit canonical-log retention
   * seam (undefined = dark). Fired ONLY when a NON-pinned conversation transitions
   * INTO a genuine terminal close (resolved/failed) — NOT on cold archive/LRU
   * eviction. The server wires this to `ThreadLog.deleteThread` (SafeFsExecutor).
   */
  private logRetentionSeam?: (threadId: string) => void;

  private filePath: string;

  /** Per-threadId FIFO mutate queues — serialize same-process concurrent writers. */
  private mutateQueues: Map<string, MutateQueueEntry[]> = new Map();
  private mutateRunning: Set<string> = new Set();

  /** Ephemeral verified-only peer-affinity hints (peerFingerprint → hint). */
  private affinity: Map<string, AffinityHint> = new Map();

  /** Short-TTL read snapshot cache (disk is the source of truth). */
  private cache: ConversationStoreFile | null = null;
  private cacheAt = 0;

  constructor(stateDir: string) {
    const threadlineDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(threadlineDir, { recursive: true });
    this.filePath = path.join(threadlineDir, 'conversations.json');
  }

  // ── Reads (from disk, via a very-short-TTL snapshot cache) ─────

  /** A cached snapshot of the on-disk file (reloaded after READ_CACHE_TTL_MS). */
  private snapshot(): ConversationStoreFile {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < READ_CACHE_TTL_MS) return this.cache;
    this.cache = this.readFileFresh();
    this.cacheAt = now;
    return this.cache;
  }

  private invalidateCache(): void {
    this.cache = null;
    this.cacheAt = 0;
  }

  /** Get a conversation by threadId. Returns null if missing or TTL-expired. */
  get(threadId: string): Conversation | null {
    const c = this.snapshot().conversations[threadId];
    if (!c) return null;
    if (!c.pinned && this.isExpired(c)) return null;
    return c;
  }

  /** True if a (non-expired) conversation exists for the threadId. */
  has(threadId: string): boolean {
    return this.get(threadId) !== null;
  }

  /** Find conversations whose peer set includes the given fingerprint/name. */
  getByParticipant(participant: string): Conversation[] {
    const out: Conversation[] = [];
    for (const c of Object.values(this.snapshot().conversations)) {
      if (c.pinned || !this.isExpired(c)) {
        if (c.participants.peers.includes(participant) || c.remoteAgent === participant) {
          out.push(c);
        }
      }
    }
    return out;
  }

  /** Find the conversation bound to a Telegram topic, if any. */
  getByTopicId(topicId: number): Conversation | null {
    for (const c of Object.values(this.snapshot().conversations)) {
      if (c.boundTopicId === topicId && (c.pinned || !this.isExpired(c))) return c;
    }
    return null;
  }

  /** Reverse lookup: conversation owning an A2A contextId (identity-bound). */
  getByContextId(contextId: string, agentIdentity: string): Conversation | null {
    for (const c of Object.values(this.snapshot().conversations)) {
      if (c.contextId === contextId && (c.pinned || !this.isExpired(c))) {
        // Identity binding — prevents session smuggling (ContextThreadMap parity).
        if (c.agentIdentity && c.agentIdentity !== agentIdentity) return null;
        return c;
      }
    }
    return null;
  }

  /** List active/idle conversations (not resolved/failed/archived). */
  listActive(): Conversation[] {
    const out: Conversation[] = [];
    for (const c of Object.values(this.snapshot().conversations)) {
      if ((c.state === 'active' || c.state === 'idle' || c.state === 'open' || c.state === 'awaiting-reply') &&
          (c.pinned || !this.isExpired(c))) {
        out.push(c);
      }
    }
    return out;
  }

  /** All non-expired (or pinned) conversations, any lifecycle state. */
  all(): Conversation[] {
    const out: Conversation[] = [];
    for (const c of Object.values(this.snapshot().conversations)) {
      if (c.pinned || !this.isExpired(c)) out.push(c);
    }
    return out;
  }

  /** Total stored conversations (for monitoring). */
  size(): number {
    return Object.keys(this.snapshot().conversations).length;
  }

  // ── Writes (single-writer CAS) ─────────────────────────────────

  /**
   * Single-writer mutate surface. Every write path routes through here so
   * concurrent writers (the inbound funnel gate, the router resume/spawn, the
   * relay-send binding stamp) can't clobber each other.
   *
   * Contract (mirrors CommitmentTracker.mutate):
   *  - FIFO queue per threadId, max depth 256.
   *  - Optimistic CAS on `version`: read → fn(clone) → write iff version
   *    unchanged, else retry (max 5). On success version is incremented and
   *    the store is persisted atomically.
   *  - If the conversation does not exist yet, the fn receives a fresh skeleton
   *    (state 'open', version 0) so callers can upsert in one call.
   */
  async mutate(threadId: string, fn: ConversationMutateFn): Promise<Conversation> {
    return new Promise<Conversation>((resolve, reject) => {
      let queue = this.mutateQueues.get(threadId);
      if (!queue) {
        queue = [];
        this.mutateQueues.set(threadId, queue);
      }
      if (queue.length >= MUTATE_QUEUE_MAX_DEPTH) {
        reject(new Error(
          `ConversationStore.mutate: queue full for ${threadId} (depth ${queue.length} >= ${MUTATE_QUEUE_MAX_DEPTH})`,
        ));
        return;
      }
      queue.push({ fn, resolve, reject });
      void this.drainMutateQueue(threadId);
    });
  }

  private async drainMutateQueue(threadId: string): Promise<void> {
    if (this.mutateRunning.has(threadId)) return;
    this.mutateRunning.add(threadId);
    try {
      const queue = this.mutateQueues.get(threadId);
      while (queue && queue.length > 0) {
        const entry = queue.shift()!;
        try {
          const result = await this.applyMutationWithCAS(threadId, entry.fn);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (queue && queue.length === 0) this.mutateQueues.delete(threadId);
    } finally {
      this.mutateRunning.delete(threadId);
    }
  }

  private async applyMutationWithCAS(threadId: string, fn: ConversationMutateFn): Promise<Conversation> {
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const file = this.readFileFresh();
      const current = file.conversations[threadId] ?? this.skeleton(threadId);
      const observedVersion = current.version ?? 0;

      const draft: Conversation = { ...current, participants: { ...current.participants, peers: [...current.participants.peers] } };
      const next = await fn(draft);

      // Re-read fresh immediately before commit: CAS against the latest on-disk
      // version, AND preserve any concurrent write to a DIFFERENT thread.
      const latestFile = this.readFileFresh();
      const latest = latestFile.conversations[threadId];
      if (latest && (latest.version ?? 0) !== observedVersion) {
        attempt++;
        continue; // someone else mutated THIS thread — reload and retry
      }
      const committed = this.commit(latestFile, threadId, next, observedVersion);
      return committed;
    }
    throw new Error(
      `ConversationStore.mutate: CAS retry budget exhausted for ${threadId} after ${MUTATE_CAS_MAX_RETRIES} retries`,
    );
  }

  /**
   * Synchronous single-record mutate (Phase 2a). Used by the synchronous legacy
   * interfaces (the `ThreadResumeMap` view's `save`/`remove`/etc.). Same file
   * version-CAS as `mutate`, but the fn is synchronous so the re-read→write
   * window has no await and is atomic within this process. Cross-process safety
   * is identical to `mutate` (per-record version CAS + atomic rename).
   *
   * The fn MAY return null to signal "delete this record".
   */
  mutateSync(threadId: string, fn: (draft: Conversation) => Conversation | null): Conversation | null {
    let attempt = 0;
    while (attempt <= MUTATE_CAS_MAX_RETRIES) {
      const file = this.readFileFresh();
      const current = file.conversations[threadId] ?? this.skeleton(threadId);
      const observedVersion = current.version ?? 0;
      const draft: Conversation = { ...current, participants: { ...current.participants, peers: [...current.participants.peers] } };
      const next = fn(draft);

      const latestFile = this.readFileFresh();
      const latest = latestFile.conversations[threadId];
      if (latest && (latest.version ?? 0) !== observedVersion) {
        attempt++;
        continue;
      }
      if (next === null) {
        if (latestFile.conversations[threadId]) {
          delete latestFile.conversations[threadId];
          this.writeFileAtomic(latestFile);
          this.invalidateCache();
        }
        return null;
      }
      return this.commit(latestFile, threadId, next, observedVersion);
    }
    throw new Error(
      `ConversationStore.mutateSync: CAS retry budget exhausted for ${threadId} after ${MUTATE_CAS_MAX_RETRIES} retries`,
    );
  }

  /** Commit a record into the freshly-read file with version+1 (LOAD-BEARING:
   *  both async and sync commit paths bump version so the CAS detects races). */
  private commit(file: ConversationStoreFile, threadId: string, next: Conversation, observedVersion: number): Conversation {
    // P3 (THREADLINE-CONVERSATION-COHERENCE-SPEC §3.1): the prev record for
    // the transition diff is read BEFORE the write lands. commit() is the
    // single write funnel (mutate/mutateSync both route here), so the diff
    // sees every lifecycle change exactly once.
    const prev = file.conversations[threadId] ?? null;
    const committed: Conversation = {
      ...next,
      threadId,
      version: observedVersion + 1,
      savedAt: new Date().toISOString(),
    };
    file.conversations[threadId] = committed;
    this.pruneMapInPlace(file.conversations);
    this.writeFileAtomic(file);
    this.invalidateCache();
    this.emitLifecycleDiff(prev, committed);
    this.fireLogRetention(prev, committed);
    return committed;
  }

  /**
   * P3 §3.1 — derive the content-free lifecycle action from a prev/next
   * transition diff on `state` + `boundTopicId` ONLY (a message append /
   * lastActivity bump / unread write changes neither and emits NOTHING).
   * Never throws into the write path (observability never endangers the
   * observed operation).
   */
  private emitLifecycleDiff(prev: Conversation | null, next: Conversation): void {
    if (!this.journalSeam) return;
    try {
      const peer = next.participants?.peers?.[0] ?? '';
      if (!peer) return; // no fingerprint = nothing coherent to record
      const wasTerminal = prev ? TERMINAL_CONVERSATION_STATES.has(prev.state) : false;
      const isTerminal = TERMINAL_CONVERSATION_STATES.has(next.state);
      if (!prev) {
        this.journalSeam({ action: 'started', conversationId: next.threadId, peerFingerprint: peer, ...(typeof next.boundTopicId === 'number' ? { topicId: next.boundTopicId } : {}) });
        if (typeof next.boundTopicId === 'number') {
          this.journalSeam({ action: 'bound', conversationId: next.threadId, peerFingerprint: peer, topicId: next.boundTopicId });
        }
        return;
      }
      if (prev.boundTopicId !== next.boundTopicId) {
        if (typeof prev.boundTopicId === 'number') {
          this.journalSeam({ action: 'unbound', conversationId: next.threadId, peerFingerprint: peer, topicId: prev.boundTopicId });
        }
        if (typeof next.boundTopicId === 'number') {
          this.journalSeam({ action: 'bound', conversationId: next.threadId, peerFingerprint: peer, topicId: next.boundTopicId });
        }
      }
      if (!wasTerminal && isTerminal) {
        this.journalSeam({ action: 'closed', conversationId: next.threadId, peerFingerprint: peer, ...(typeof next.boundTopicId === 'number' ? { topicId: next.boundTopicId } : {}) });
      }
    } catch { /* @silent-fallback-ok: journal observability must never endanger the conversation write (THREADLINE-CONVERSATION-COHERENCE-SPEC §4.1) */
    }
  }

  /** P3 §3.1 — inject the coherence-journal emitter (server wiring). */
  setCoherenceJournalSeam(seam: (data: { action: 'started' | 'bound' | 'unbound' | 'closed'; conversationId: string; peerFingerprint: string; topicId?: number }) => void): void {
    this.journalSeam = seam;
  }

  /**
   * Robustness Phase 2 (SA5/E1) — inject the post-commit canonical-log retention
   * seam (server wires it to `ThreadLog.deleteThread`). Fires ONLY on a non-pinned
   * conversation's transition INTO resolved/failed — NOT on cold archive/LRU.
   */
  setLogRetentionSeam(seam: (threadId: string) => void): void {
    this.logRetentionSeam = seam;
  }

  /**
   * Robustness Phase 2 — fire the canonical-log retention seam when a non-pinned
   * conversation transitions INTO a genuine terminal close (resolved/failed). A
   * POST-COMMIT action (the write has already landed), never mid-mutate, so a CAS
   * rollback can't strand a record without its log. Never throws into the write.
   */
  private fireLogRetention(prev: Conversation | null, next: Conversation): void {
    if (!this.logRetentionSeam) return;
    try {
      if (next.pinned) return; // pinned conversations keep their log
      const wasDeletable = prev ? LOG_DELETION_STATES.has(prev.state) : false;
      const isDeletable = LOG_DELETION_STATES.has(next.state);
      if (!wasDeletable && isDeletable) this.logRetentionSeam(next.threadId);
    } catch { /* @silent-fallback-ok: retention is post-commit best-effort; a residual log is reclaimed by the orphan sweep */ }
  }

  /**
   * Direct upsert of a full record. Used by migration / bulk import. Now does a
   * read-merge-write so it is safe even if the file changed since construction.
   */
  importDirect(conversation: Conversation): void {
    const file = this.pendingFile ?? this.readFileFresh();
    const existing = file.conversations[conversation.threadId];
    file.conversations[conversation.threadId] = {
      ...conversation,
      version: existing ? Math.max(existing.version ?? 0, conversation.version ?? 0) : (conversation.version ?? 0),
      savedAt: new Date().toISOString(),
    };
    this.pendingFile = file;
  }

  /** Holds an in-flight importDirect batch until flush(). */
  private pendingFile: ConversationStoreFile | null = null;

  /** Persist after a batch of importDirect calls. */
  flush(): void {
    if (this.pendingFile) {
      this.writeFileAtomic(this.pendingFile);
      this.pendingFile = null;
      this.invalidateCache();
    }
  }

  /** Remove a conversation. */
  remove(threadId: string): void {
    const file = this.readFileFresh();
    if (file.conversations[threadId]) {
      delete file.conversations[threadId];
      this.writeFileAtomic(file);
      this.invalidateCache();
    }
  }

  /**
   * Move stale non-terminal conversations out of the active set without
   * deleting them. Archived records keep history/resume metadata; a later peer
   * reply can still reactivate the thread through the normal resume path.
   */
  retireInactive(maxInactiveMs: number = DEFAULT_INACTIVE_RETIRE_MS, now: Date = new Date()): number {
    const cutoff = now.getTime() - maxInactiveMs;
    const file = this.readFileFresh();
    const candidates: string[] = [];
    let retired = 0;

    for (const c of Object.values(file.conversations)) {
      if (c.pinned) continue;
      if (c.state !== 'active' && c.state !== 'idle' && c.state !== 'open' && c.state !== 'awaiting-reply') continue;
      const last = new Date(c.lastActivityAt || c.savedAt).getTime();
      if (!Number.isFinite(last) || last >= cutoff) continue;
      candidates.push(c.threadId);
    }

    for (const threadId of candidates) {
      const next = this.mutateSync(threadId, d => {
        if (d.pinned) return d;
        if (d.state !== 'active' && d.state !== 'idle' && d.state !== 'open' && d.state !== 'awaiting-reply') return d;
        const last = new Date(d.lastActivityAt || d.savedAt).getTime();
        if (!Number.isFinite(last) || last >= cutoff) return d;
        d.state = 'archived';
        return d;
      });
      if (next?.state === 'archived') retired += 1;
    }

    return retired;
  }

  // ── Negotiator lease (Robustness Phase 1, D-A) ─────────────────

  /**
   * Acquire-or-renew the negotiator lease for a thread (D-A). One synchronous
   * CAS transaction over `mutate()` — no background timers (FD-6). Decision:
   *  - no lease / expired / owner provably dead → acquire (epoch += 1).
   *  - already owned by the caller (and not expired) → renew (epoch unchanged).
   *  - a live, unexpired FOREIGN lease → held (caller does NOT own the voice).
   *
   * `isOwnerLive(sessionName)` lets the caller fence a dead owner: a foreign
   * lease whose owner session is absent from the live session registry is
   * reclaimable even before its TTL expires. Never reads identity from a
   * message body — the owner is always the server-authoritative live session.
   */
  async acquireOrRenewLease(
    threadId: string,
    owner: LeaseOwner,
    opts: { ttlMs: number; now?: number; isOwnerLive?: (sessionName: string) => boolean },
  ): Promise<LeaseResult> {
    const nowMs = opts.now ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + opts.ttlMs).toISOString();
    const isOwnerLive = opts.isOwnerLive ?? (() => true);

    let result: LeaseResult | null = null;
    await this.mutate(threadId, (draft) => {
      const existing = draft.negotiatorLease;
      const ownedByCaller =
        !!existing &&
        existing.ownerSessionName === owner.ownerSessionName &&
        existing.ownerMachineId === owner.ownerMachineId;
      const expired = existing ? new Date(existing.expiresAt).getTime() <= nowMs : true;
      const foreignDead =
        !!existing && !ownedByCaller && !isOwnerLive(existing.ownerSessionName);

      if (existing && !expired && !ownedByCaller && !foreignDead) {
        // Live foreign lease — HELD. The lease itself is not mutated.
        result = { disposition: 'held', lease: existing, ownedByCaller: false };
        return draft;
      }
      if (existing && ownedByCaller && !expired) {
        // Renew — extend expiry, epoch unchanged.
        const renewed: NegotiatorLease = { ...existing, renewedAt: nowIso, expiresAt: expiresIso };
        draft.negotiatorLease = renewed;
        result = { disposition: 'renewed', lease: renewed, ownedByCaller: true };
        return draft;
      }
      // Acquire (no lease / expired / dead foreign owner) — new monotonic epoch.
      const acquired: NegotiatorLease = {
        ownerSessionName: owner.ownerSessionName,
        ownerMachineId: owner.ownerMachineId,
        epoch: (existing?.epoch ?? 0) + 1,
        acquiredAt: nowIso,
        renewedAt: nowIso,
        expiresAt: expiresIso,
      };
      draft.negotiatorLease = acquired;
      result = { disposition: 'acquired', lease: acquired, ownedByCaller: true };
      return draft;
    });
    // result is always set by the mutate fn (which runs at least once on commit).
    if (!result) {
      throw new Error(`acquireOrRenewLease: no result produced for ${threadId}`);
    }
    return result;
  }

  /** Read the current lease for a thread (no TTL filtering — lease may be stale). */
  readLease(threadId: string): NegotiatorLease | null {
    return this.snapshot().conversations[threadId]?.negotiatorLease ?? null;
  }

  /**
   * Stamp the durable holding-notice rate-limit fields (FD-3). Called by the
   * gate when it decides to emit a notice, so the per-epoch + min-interval
   * limits survive restarts.
   */
  async recordHoldingNotice(threadId: string, epoch: number, now?: number): Promise<void> {
    const nowIso = new Date(now ?? Date.now()).toISOString();
    await this.mutate(threadId, (draft) => {
      draft.lastHoldingNoticeEpoch = epoch;
      draft.lastHoldingNoticeAt = nowIso;
      return draft;
    });
  }

  // ── Ephemeral verified-only peer affinity (in-memory, non-durable) ──

  /**
   * Record a short-lived, verified-only affinity hint (peer → most-recent
   * thread). Deliberately NOT persisted (accepted loss on restart). Callers
   * MUST only call this for VERIFIED peers — an unverified affinity would be a
   * hijack vector.
   */
  recordAffinity(peerFingerprint: string, threadId: string): void {
    const now = Date.now();
    const existing = this.affinity.get(peerFingerprint);
    if (existing && existing.threadId === threadId) {
      existing.lastSeen = now;
    } else {
      this.affinity.set(peerFingerprint, { threadId, firstSeen: now, lastSeen: now });
    }
  }

  /** Look up a fresh affinity hint, honoring the sliding + absolute windows. */
  getAffinity(peerFingerprint: string): string | null {
    const hint = this.affinity.get(peerFingerprint);
    if (!hint) return null;
    const now = Date.now();
    if (now - hint.lastSeen > AFFINITY_SLIDING_MS || now - hint.firstSeen > AFFINITY_ABSOLUTE_MS) {
      this.affinity.delete(peerFingerprint);
      return null;
    }
    return hint.threadId;
  }

  // ── Canonical-history head cache + collisions (Robustness Phase 2, D-A/FD-2) ──

  /**
   * Stamp the COALESCED canonical-log head cache (count/headHash/setAccum). The
   * JSONL log is the source of truth; this is a best-effort cache the funnel
   * refreshes on a debounced cadence — NEVER a synchronous per-message CAS. A
   * READ never calls this (read-never-writes, SI1).
   */
  async stampHistoryHead(threadId: string, head: { count: number; headHash: string; setAccum: string }): Promise<void> {
    await this.mutate(threadId, (draft) => {
      draft.historyCount = head.count;
      draft.historyHeadHash = head.headHash;
      draft.historySetAccum = head.setAccum;
      return draft;
    });
  }

  /** Record the memoized one-time backfill marker for a thread (D-C). */
  async stampBackfilled(threadId: string, value: boolean): Promise<void> {
    await this.mutate(threadId, (draft) => { draft.backfilled = value; return draft; });
  }

  /** Stamp the last computed symmetry state + (optionally) the peer threadSync (D-D). */
  async stampSymmetry(threadId: string, symmetryState: string, peerThreadSync?: { digestVersion: number; count: number; setAccum: string; at: string }): Promise<void> {
    await this.mutate(threadId, (draft) => {
      draft.symmetryState = symmetryState;
      if (peerThreadSync) draft.peerThreadSync = peerThreadSync;
      return draft;
    });
  }

  /**
   * Bump the SATURATING collision counter (FD-2). Saturates at a ceiling so an
   * endless same-id-different-content replay cannot write-amplify conversations.json.
   */
  async recordCollision(threadId: string): Promise<void> {
    await this.mutate(threadId, (draft) => {
      const cur = draft.collisionCount ?? 0;
      if (cur < COLLISION_COUNTER_CEILING) draft.collisionCount = cur + 1;
      return draft;
    });
  }

  // ── Conversation-discipline resolver binding (D-E — verified-only, durable) ──

  /**
   * Resolve the canonical thread for a verified `(peerPrincipal, workstreamKey)`
   * group, or null if none is bound yet. Returns `{ kind:'found', threadId }`,
   * `{ kind:'none' }`, or `{ kind:'lookup-failed' }` (a transient read error). The
   * caller MUST distinguish lookup-failed from none — a lookup failure observes/
   * retries; it does NOT mint a fresh canonical (avoids an under-load F5
   * regression). `peerPrincipal` MUST be the VERIFIED peer fingerprint.
   */
  resolveCanonicalThread(peerPrincipal: string, workstreamKey: string): { kind: 'found'; threadId: string } | { kind: 'none' } | { kind: 'lookup-failed' } {
    let convs: Conversation[];
    try {
      convs = Object.values(this.snapshot().conversations);
    } catch {
      return { kind: 'lookup-failed' };
    }
    // The FIRST (oldest by createdAt) matching binding is canonical (deterministic).
    let best: Conversation | null = null;
    for (const c of convs) {
      const b = c.canonicalBinding;
      if (!b || b.peerPrincipal !== peerPrincipal || b.workstreamKey !== workstreamKey) continue;
      if (!c.pinned && this.isExpired(c)) continue;
      if (!best || new Date(c.createdAt).getTime() < new Date(best.createdAt).getTime()) best = c;
    }
    return best ? { kind: 'found', threadId: best.threadId } : { kind: 'none' };
  }

  /**
   * Bind a thread as the canonical thread for a verified `(peerPrincipal,
   * workstreamKey)` group. First-write-wins: if a DIFFERENT thread already holds
   * the binding for that key, this is a no-op (the existing canonical stands).
   */
  async bindCanonicalThread(threadId: string, peerPrincipal: string, workstreamKey: string): Promise<void> {
    const existing = this.resolveCanonicalThread(peerPrincipal, workstreamKey);
    if (existing.kind === 'found' && existing.threadId !== threadId) return; // first-write-wins
    await this.mutate(threadId, (draft) => {
      if (!draft.canonicalBinding) draft.canonicalBinding = { peerPrincipal, workstreamKey };
      return draft;
    });
  }

  // ── Maintenance ────────────────────────────────────────────────

  /** Prune expired + resolved-past-grace + LRU-overflow (non-pinned). */
  prune(): void {
    const file = this.readFileFresh();
    this.pruneMapInPlace(file.conversations);
    this.writeFileAtomic(file);
    this.invalidateCache();
  }

  // ── Private helpers ────────────────────────────────────────────

  private skeleton(threadId: string): Conversation {
    const now = new Date().toISOString();
    return {
      threadId,
      version: 0,
      participants: { peers: [] },
      state: 'open',
      pinned: false,
      messageCount: 0,
      turnCount: 0,
      createdAt: now,
      savedAt: now,
      lastActivityAt: now,
    };
  }

  private isExpired(c: Conversation): boolean {
    const now = Date.now();
    if (c.state === 'resolved' && c.resolvedAt) {
      return now - new Date(c.resolvedAt).getTime() > RESOLVED_GRACE_MS;
    }
    const ref = c.lastActivityAt || c.savedAt;
    return now - new Date(ref).getTime() > MAX_AGE_MS;
  }

  /** Prune a conversations map in place (non-pinned expired + LRU overflow). */
  private pruneMapInPlace(map: Record<string, Conversation>): void {
    for (const key of Object.keys(map)) {
      const c = map[key];
      if (c.pinned) continue;
      if (this.isExpired(c)) delete map[key];
    }
    const keys = Object.keys(map);
    if (keys.length <= MAX_ENTRIES) return;
    const unpinned: Array<{ key: string; t: number }> = [];
    for (const key of keys) {
      const c = map[key];
      if (c.pinned) continue;
      unpinned.push({ key, t: new Date(c.lastActivityAt || c.savedAt).getTime() });
    }
    unpinned.sort((a, b) => a.t - b.t);
    const toEvict = keys.length - MAX_ENTRIES;
    for (let i = 0; i < toEvict && i < unpinned.length; i++) {
      delete map[unpinned[i].key];
    }
  }

  /** Read + parse the on-disk store fresh (the source of truth). */
  private readFileFresh(): ConversationStoreFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data && data.version === 1 && data.conversations && typeof data.conversations === 'object') {
          return data as ConversationStoreFile;
        }
      }
    } catch {
      // Corrupted / mid-write torn read — treat as empty; the next write heals it.
    }
    return { version: 1, conversations: {}, lastModified: new Date().toISOString() };
  }

  /** Atomic write (tmp + rename) — no reader ever sees a torn file. */
  private writeFileAtomic(file: ConversationStoreFile): void {
    file.lastModified = new Date().toISOString();
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2) + '\n');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // @silent-fallback-ok — state persistence failure, retried on next write.
    }
  }
}
