/**
 * recordThreadMessage — the ONE append funnel every Threadline message-persisting
 * path calls (Robustness Phase 2, D-B; the structural F3 fix) + the
 * conversation-discipline resolver (D-E) + the identity-free digest (FD-5).
 *
 * Mirrors Phase 1's `recordInboundAck` funnel: outbound send AND inbound receive,
 * EVERY path, append to the canonical per-thread log through this one helper. A
 * wiring-integrity test enumerates the message-persisting routes and asserts each
 * goes through `recordThreadMessage` — so a future bypassing path fails the test
 * (Structure > Willpower). This is the structural guarantee that no leg is
 * silently dropped again (the root of F3).
 *
 * Discipline:
 *  - The append NEVER blocks delivery and is off the send critical path (Signal
 *    vs. Authority — observability must not gate the message).
 *  - But a failure is LOUD, matching Phase 1's fail-open bar: N consecutive append
 *    failures on a thread raise ONE deduped Attention item (Bounded Notification
 *    Surface) — a persistently-incomplete history is the literal F3 symptom and
 *    must be operator-visible, not log-file-visible.
 *  - The content digest is ALWAYS recomputed locally (identity-free); a
 *    wire-supplied digest is a cross-check only and NEVER enters the chain.
 *  - The head-cache is refreshed on a COALESCED cadence (debounced, single-flight),
 *    never inside a synchronous per-message CAS (FD-2).
 */

// canonical-migration-producer: threadline-inbound-canonical-store@4

import { storageMachineName } from '../core/storageMachineName.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ThreadLog, ThreadLogAuthor, ThreadDirection, ThreadTextRef, ThreadLogEntry } from './ThreadLog.js';
import type { MessageEnvelope } from '../messaging/types.js';
import type { ConversationStore } from './ConversationStore.js';
import { contentDigest, DIGEST_VERSION } from './threadDigest.js';

/** The bounded Attention surface (a subset of TelegramAdapter.createAttentionItem). */
export interface AttentionRaiser {
  createAttentionItem?: (item: {
    id: string;
    title: string;
    summary: string;
    category: string;
    priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
    sourceContext?: string;
  }) => unknown;
}

export interface ThreadMessageRecorderDeps {
  threadLog: ThreadLog;
  conversationStore: ConversationStore;
  /** Bounded notification surface for the append-failure Attention item (FD-1). */
  attention?: AttentionRaiser | null;
  /** Directory for the dry-run resolver decision log (default `{stateDir}/logs`). */
  logDir?: string;
  now?: () => number;
  /** Coalesce window for the head-cache refresh (FD-2). Default 500ms. */
  headCacheCoalesceMs?: number;
  /** Consecutive-append-failure threshold before the ONE Attention item (FD-1). Default 3. */
  appendFailureAlertThreshold?: number;
  /** Inline body cap before a `store` reference (FD-4). Default 8 KB. */
  inlineMaxBytes?: number;
  /**
   * The resolvable backing for over-cap bodies (the server passes its real
   * MessageStore). Without it an over-cap body is NOT logged with a dangling
   * reference — the record fails observably through the append-failure path.
   */
  bodyStore?: ThreadBodyStore | null;
}

/** The subset of MessageStore the recorder uses to back a `textRef: {kind:'store'}`. */
export interface ThreadBodyStore {
  saveThreadBodySync(storeId: string, envelope: MessageEnvelope): void;
  getThreadBodySync(storeId: string): MessageEnvelope | null;
  /** Close-only retention: remove exactly this thread's body partition. */
  deleteThreadBodiesSync(threadId: string): void;
}

/**
 * The store id for an over-cap body: `tlbody-<sha256(threadId)>-<digest>`. The
 * first part is the thread's body partition (so close-only retention removes one
 * thread's bodies without a scan or index); the second is namespaced by
 * direction + verified peer + thread + original message id + local content
 * digest. Both are hashed so no raw wire value ever becomes a path, and a
 * same-id/different-body replay gets a DIFFERENT id — it can never overwrite.
 */
export function threadBodyStoreId(parts: { direction: ThreadDirection; peerFingerprint?: string; threadId: string; messageId: string; contentDigest: string }): string {
  const partition = createHash('sha256').update(parts.threadId).digest('hex');
  const h = createHash('sha256')
    .update(JSON.stringify([parts.direction, parts.peerFingerprint ?? '', parts.threadId, parts.messageId, parts.contentDigest]))
    .digest('hex');
  return `tlbody-${partition}-${h}`;
}

export interface RecordThreadMessageInput {
  threadId: string;
  messageId: string;
  direction: ThreadDirection;
  /** The EXACT body text (used for the identity-free digest + inline storage). */
  body: string;
  /** The verbatim wire `createdAt` (hashed AS RECEIVED). */
  createdAt: string;
  /** Optional wire-supplied digest — a CROSS-CHECK only, never trusted into the chain. */
  wireDigest?: string;
  wireDigestVersion?: number;
  author?: ThreadLogAuthor;
  peerFingerprint?: string;
  subject?: string;
  backfilled?: true;
  /**
   * Legacy compatibility: the inbound carried no wire timestamp, so `createdAt` is
   * this end's receive time. Recorded as provenance (never presented as a sender
   * stamp); a retry of an already-logged leg is a `duplicate`, never re-hashed
   * with a fresh time (which would read as a collision).
   */
  createdAtSource?: 'receive-time';
  /**
   * @deprecated Ignored: the store id is always the recorder-minted namespaced id
   * (a caller-supplied id could point at a record that was never written).
   */
  messageStoreId?: string;
}

export interface RecordThreadMessageResult {
  status: 'appended' | 'duplicate' | 'collision' | 'append-failed';
  contentDigest: string;
  /** True when a present wire digest disagreed with the locally-computed one (flagged, never overwritten). */
  wireDigestMismatch?: boolean;
}

// ── Resolver (D-E) ─────────────────────────────────────────────────────────

export type WorkstreamKeyMode = 'subject-slug' | 'peer-only' | 'off';

export interface ResolveOutboundInput {
  /** Caller-supplied explicit threadId (a reply / continuation). */
  explicitThreadId?: string;
  /** The threadId this send would mint today (the as-today UUID). */
  mintedThreadId: string;
  /** The VERIFIED peer fingerprint, when locally resolvable (never a name/subject). */
  peerPrincipal?: string;
  subject?: string;
  /** Caller asked for a brand-new thread (explicit fork intent). */
  fork?: boolean;
  /** Resolver master switch (dev-gated; off → mint as today). */
  enabled: boolean;
  /** Dry-run: log the would-join/would-fork decision but DO NOT reroute. */
  dryRun: boolean;
  workstreamKeyMode: WorkstreamKeyMode;
  /** Holder-only (E5): the JOIN runs only on the conversation's holder machine. */
  isHolder?: boolean;
}

export type ResolverDecision =
  | 'resolver-off'
  | 'explicit-threadid'
  | 'minted:fork-requested'
  | 'minted:no-binding'
  | 'minted:lookup-failed'
  | 'joined:existing-binding'
  | 'would-join:existing-binding';

export interface ResolveOutboundResult {
  /** The threadId the send should use (== minted/explicit unless ENFORCE-join). */
  threadId: string;
  decision: ResolverDecision;
  /** The canonical thread a dry-run would have joined (telemetry). */
  wouldJoin?: string;
  workstreamKey?: string;
}

/** Normalize a subject to a workstream slug (lower, collapse ws/punct, length-cap). */
export function deriveWorkstreamKey(subject: string | undefined, mode: WorkstreamKeyMode): string {
  if (mode === 'peer-only') return 'default';
  const s = (subject ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return s || 'default';
}

export class ThreadMessageRecorder {
  private readonly d: ThreadMessageRecorderDeps;
  private readonly coalesceMs: number;
  private readonly failThreshold: number;
  private readonly inlineMaxBytes: number;
  private readonly now: () => number;

  /** Consecutive append-failure counts per thread (reset on a successful append). */
  private failCounts = new Map<string, number>();
  /** Pending coalesced head refresh: threadId → debounce timer. */
  private headTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: ThreadMessageRecorderDeps) {
    this.d = deps;
    this.coalesceMs = deps.headCacheCoalesceMs ?? 500;
    this.failThreshold = deps.appendFailureAlertThreshold ?? 3;
    this.inlineMaxBytes = deps.inlineMaxBytes ?? 8192;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Resolve an entry's body: inline text, or the backing record verified against
   * the entry (id, thread, createdAt, and the locally recomputed digest). Returns
   * null when the reference cannot be resolved or does not match — never a guess.
   */
  resolveText(entry: Pick<ThreadLogEntry, 'threadId' | 'messageId' | 'createdAt' | 'contentDigest' | 'textRef'>): string | null {
    if (entry.textRef.kind === 'inline') return entry.textRef.text;
    const env = this.d.bodyStore?.getThreadBodySync(entry.textRef.messageStoreId);
    const m = env?.message;
    if (!m || m.id !== entry.messageId || m.threadId !== entry.threadId || m.createdAt !== entry.createdAt || typeof m.body !== 'string') return null;
    const digest = contentDigest({ threadId: m.threadId, messageId: m.id, body: m.body, createdAt: m.createdAt });
    return digest === entry.contentDigest ? m.body : null;
  }

  /**
   * Append one message to its canonical log. Returns synchronously (off the send
   * critical path); never throws into the caller.
   */
  record(input: RecordThreadMessageInput): RecordThreadMessageResult {
    if (input.createdAtSource === 'receive-time') {
      // No sender stamp: this end's receive time differs on every retry, so the
      // candidate is compared against the ALREADY-LOGGED leg using THAT entry's
      // createdAt (the digest input). Same body → duplicate; a different body →
      // collision through the normal path below. The first row/time is kept
      // (append() never overwrites). Bounded live-segment lookup, only on a hit.
      try {
        if (this.d.threadLog.has(input.threadId, input.messageId, input.direction)) {
          const existing = this.d.threadLog.findLiveEntry(input.threadId, input.messageId, input.direction);
          if (existing) input = { ...input, createdAt: existing.createdAt };
        }
      } catch { /* @silent-fallback-ok: fall through — append() re-checks and reports */ }
    }
    const digest = contentDigest({
      threadId: input.threadId,
      messageId: input.messageId,
      body: input.body,
      createdAt: input.createdAt,
    });
    const wireDigestMismatch = input.wireDigest !== undefined && input.wireDigest !== digest;

    const bytes = Buffer.byteLength(input.body, 'utf-8');

    try {
      let textRef: ThreadTextRef;
      if (bytes <= this.inlineMaxBytes) {
        textRef = { kind: 'inline', text: input.body };
      } else {
        // Over-cap: write the resolvable backing record FIRST, so a logged row can
        // never reference a body that was not written. No backing store → throw
        // into the observable append-failure path below (never a dangling ref).
        const store = this.d.bodyStore;
        if (!store) throw new Error(`body of ${bytes} bytes exceeds the ${this.inlineMaxBytes}-byte inline cap and no body store is wired`);
        const storeId = threadBodyStoreId({
          direction: input.direction, peerFingerprint: input.peerFingerprint,
          threadId: input.threadId, messageId: input.messageId, contentDigest: digest,
        });
        // An already-logged key resolves to duplicate/collision in append(); skip
        // writing a backing record that no row will reference.
        if (!this.d.threadLog.has(input.threadId, input.messageId, input.direction)) {
          store.saveThreadBodySync(storeId, bodyEnvelope(input, this.now()));
        }
        textRef = { kind: 'store', messageStoreId: storeId };
      }
      const res = this.d.threadLog.append({
        threadId: input.threadId,
        messageId: input.messageId,
        direction: input.direction,
        contentDigest: digest,
        digestVersion: DIGEST_VERSION,
        createdAt: input.createdAt,
        ...(input.createdAtSource ? { createdAtSource: input.createdAtSource } : {}),
        ...(input.backfilled ? { backfilled: true as const } : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.peerFingerprint ? { peerFingerprint: input.peerFingerprint } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        textRef,
      });

      if (res.status === 'collision') {
        // A same-id-different-content replay — a poisoning/tamper signal. Record
        // it (saturating counter + ONE observability line); never overwrite.
        void this.d.conversationStore.recordCollision(input.threadId).catch(() => { /* best-effort */ });
        console.warn(`[recordThreadMessage] content collision on ${input.threadId} (${input.messageId}/${input.direction}) — not overwritten`);
        this.failCounts.delete(input.threadId);
        return { status: 'collision', contentDigest: digest, ...(wireDigestMismatch ? { wireDigestMismatch: true } : {}) };
      }

      // appended | duplicate — both heal the failure streak.
      this.failCounts.delete(input.threadId);
      if (res.status === 'appended') this.scheduleHeadRefresh(input.threadId);
      return { status: res.status, contentDigest: digest, ...(wireDigestMismatch ? { wireDigestMismatch: true } : {}) };
    } catch (err) {
      this.onAppendFailure(input.threadId, err);
      return { status: 'append-failed', contentDigest: digest, ...(wireDigestMismatch ? { wireDigestMismatch: true } : {}) };
    }
  }

  /**
   * Resolve which threadId an OUTBOUND send should use (D-E). Recoverable routing,
   * never an authority: returns the minted/explicit threadId unless the resolver is
   * ENABLED + ENFORCE (not dry-run) + a binding exists. Always logs the decision to
   * the dry-run JSONL so join/fork rates are measurable before enforce.
   */
  async resolveOutboundThread(input: ResolveOutboundInput): Promise<ResolveOutboundResult> {
    // Off / non-holder / no verified principal → mint as today (no grouping).
    if (!input.enabled || input.workstreamKeyMode === 'off' || input.isHolder === false || !input.peerPrincipal) {
      return this.logDecision(input, { threadId: input.explicitThreadId ?? input.mintedThreadId, decision: 'resolver-off' });
    }
    if (input.explicitThreadId) {
      return this.logDecision(input, { threadId: input.explicitThreadId, decision: 'explicit-threadid' });
    }
    const workstreamKey = deriveWorkstreamKey(input.subject, input.workstreamKeyMode);
    if (input.fork) {
      // Explicit new-thread intent — mint, do NOT steal the existing canonical.
      return this.logDecision(input, { threadId: input.mintedThreadId, decision: 'minted:fork-requested', workstreamKey });
    }
    const lookup = this.d.conversationStore.resolveCanonicalThread(input.peerPrincipal, workstreamKey);
    if (lookup.kind === 'lookup-failed') {
      // Transient (CAS contention) — observe/retry; do NOT mint a fresh canonical.
      return this.logDecision(input, { threadId: input.mintedThreadId, decision: 'minted:lookup-failed', workstreamKey });
    }
    if (lookup.kind === 'found') {
      if (input.dryRun) {
        return this.logDecision(input, { threadId: input.mintedThreadId, decision: 'would-join:existing-binding', wouldJoin: lookup.threadId, workstreamKey });
      }
      return this.logDecision(input, { threadId: lookup.threadId, decision: 'joined:existing-binding', wouldJoin: lookup.threadId, workstreamKey });
    }
    // No binding → this minted thread BECOMES the canonical for the key (bound in
    // both dry-run and enforce — the first thread for the key IS the minted one).
    try {
      await this.d.conversationStore.bindCanonicalThread(input.mintedThreadId, input.peerPrincipal, workstreamKey);
    } catch { /* best-effort — a failed bind only means the next send re-evaluates */ }
    return this.logDecision(input, { threadId: input.mintedThreadId, decision: 'minted:no-binding', workstreamKey });
  }

  /** Force any pending coalesced head refresh immediately (tests + shutdown). */
  async flushPending(): Promise<void> {
    const ids = [...this.headTimers.keys()];
    for (const id of ids) {
      const t = this.headTimers.get(id);
      if (t) clearTimeout(t);
      this.headTimers.delete(id);
      await this.refreshHead(id);
    }
  }

  // ── Internal ───────────────────────────────────────────────────

  private scheduleHeadRefresh(threadId: string): void {
    if (this.headTimers.has(threadId)) return; // single-flight per thread (debounced)
    const t = setTimeout(() => {
      this.headTimers.delete(threadId);
      void this.refreshHead(threadId);
    }, this.coalesceMs);
    if (typeof t.unref === 'function') t.unref();
    this.headTimers.set(threadId, t);
  }

  private async refreshHead(threadId: string): Promise<void> {
    try {
      const head = this.d.threadLog.head(threadId);
      await this.d.conversationStore.stampHistoryHead(threadId, head);
    } catch { /* @silent-fallback-ok: the head cache is best-effort; the log is the source of truth and a read rebuilds on mismatch */ }
  }

  private onAppendFailure(threadId: string, err: unknown): void {
    const n = (this.failCounts.get(threadId) ?? 0) + 1;
    this.failCounts.set(threadId, n);
    console.warn(`[recordThreadMessage] append FAILED for ${threadId} (streak ${n}): ${err instanceof Error ? err.message : String(err)}`);
    if (n >= this.failThreshold) {
      // ONE deduped Attention item per thread (Bounded Notification Surface) — the
      // dedup is the stable id; a continuing streak refreshes the same item.
      try {
        this.d.attention?.createAttentionItem?.({
          id: `threadline-canonical-append-fail:${threadId}`,
          title: 'Threadline canonical history: append failing',
          summary: `The canonical log on ${storageMachineName(this.d.logDir ? path.dirname(this.d.logDir) : undefined)} for thread ${threadId} has failed to append ${n} consecutive messages. History for this thread may be incomplete (F3 symptom). Check disk/permissions under threadline/threads/.`,
          category: 'general',
          priority: 'HIGH',
          sourceContext: 'threadline-canonical-append-fail',
        });
      } catch { /* @silent-fallback-ok: the alert is best-effort; the streak is still logged above */ }
    }
  }

  private logDecision(input: ResolveOutboundInput, result: Omit<ResolveOutboundResult, 'workstreamKey'> & { workstreamKey?: string }): ResolveOutboundResult {
    // Only log when the resolver is engaged (enabled) — an off resolver is the
    // default and would flood the log with no-ops.
    if (input.enabled && input.workstreamKeyMode !== 'off') {
      try {
        const dir = this.d.logDir;
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          const line = JSON.stringify({
            ts: new Date(this.now()).toISOString(),
            threadId: result.threadId,
            decision: result.decision,
            dryRun: input.dryRun,
            peerPrincipal: input.peerPrincipal,
            workstreamKey: result.workstreamKey,
            ...(result.wouldJoin ? { wouldJoin: result.wouldJoin } : {}),
          });
          fs.appendFileSync(path.join(dir, 'threadline-canonical-history.jsonl'), line + '\n');
        }
      } catch { /* @silent-fallback-ok: the decision log is telemetry; never block a send */ }
    }
    return result;
  }
}

/** The backing record for an over-cap body — history text, not a delivery claim. */
function bodyEnvelope(input: RecordThreadMessageInput, nowMs: number): MessageEnvelope {
  const peer = input.peerFingerprint ?? input.author?.agentFingerprint ?? 'peer';
  const local = { agent: 'local', session: input.author?.sessionName ?? 'threadline', machine: input.author?.machineId ?? 'local' };
  const remote = { agent: peer, session: 'threadline', machine: 'relay' };
  return {
    schemaVersion: 1,
    message: {
      id: input.messageId,
      from: input.direction === 'inbound' ? remote : local,
      to: input.direction === 'inbound' ? local : remote,
      type: 'info',
      priority: 'medium',
      subject: input.subject ?? '',
      body: input.body,
      threadId: input.threadId,
      createdAt: input.createdAt,
      ttlMinutes: 0,
    },
    transport: { relayChain: [], originServer: 'threadline-canonical-history', nonce: input.messageId, timestamp: new Date(nowMs).toISOString() },
    delivery: { phase: 'created', transitions: [], attempts: 0 },
  };
}

/**
 * The funnel entry point every message-persisting route calls (the greppable name
 * the wiring-integrity test enumerates). Thin wrapper over the injected recorder
 * so funnel state (failure streaks, coalesced head timers) lives in one instance.
 */
export function recordThreadMessage(recorder: ThreadMessageRecorder, input: RecordThreadMessageInput): RecordThreadMessageResult {
  return recorder.record(input);
}
