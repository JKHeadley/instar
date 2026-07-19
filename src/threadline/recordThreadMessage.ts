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

// canonical-migration-producer: threadline-inbound-canonical-store@1

import fs from 'node:fs';
import path from 'node:path';
import type { ThreadLog, ThreadLogAuthor, ThreadDirection, ThreadTextRef } from './ThreadLog.js';
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
  /** The message-store id to reference when the body exceeds inlineMaxBytes. */
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
   * Append one message to its canonical log. Returns synchronously (off the send
   * critical path); never throws into the caller.
   */
  record(input: RecordThreadMessageInput): RecordThreadMessageResult {
    const digest = contentDigest({
      threadId: input.threadId,
      messageId: input.messageId,
      body: input.body,
      createdAt: input.createdAt,
    });
    const wireDigestMismatch = input.wireDigest !== undefined && input.wireDigest !== digest;

    const bytes = Buffer.byteLength(input.body, 'utf-8');
    const textRef: ThreadTextRef = bytes <= this.inlineMaxBytes
      ? { kind: 'inline', text: input.body }
      : { kind: 'store', messageStoreId: input.messageStoreId ?? input.messageId };

    try {
      const res = this.d.threadLog.append({
        threadId: input.threadId,
        messageId: input.messageId,
        direction: input.direction,
        contentDigest: digest,
        digestVersion: DIGEST_VERSION,
        createdAt: input.createdAt,
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
          summary: `The canonical log for thread ${threadId} has failed to append ${n} consecutive messages. History for this thread may be incomplete (F3 symptom). Check disk/permissions under threadline/threads/.`,
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

/**
 * The funnel entry point every message-persisting route calls (the greppable name
 * the wiring-integrity test enumerates). Thin wrapper over the injected recorder
 * so funnel state (failure streaks, coalesced head timers) lives in one instance.
 */
export function recordThreadMessage(recorder: ThreadMessageRecorder, input: RecordThreadMessageInput): RecordThreadMessageResult {
  return recorder.record(input);
}
