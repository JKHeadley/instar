/**
 * PendingConfirmationManager — lifecycle for conversational confirmation records.
 *
 * Layer 1 component. Manages the queue, TTL, dedup, retry-with-sharpening,
 * and revalidation rules for pending confirmations. Per spec v14 section
 * "Pending-Confirmation Records (v9 — addresses GPT round-on-v8 finding #2)":
 *
 *   - At most one outstanding PendingConfirmation per topic
 *   - Queue depth: 3; 4th queued is dropped silently with telemetry
 *   - Queue dedup by refId
 *   - TTL: 5 substantive user turns OR 24h, whichever first
 *   - TTL clock starts at DEQUEUE time, not queue-entry time
 *   - Revalidation at dequeue: refId still tentative + proposition still
 *     semantically relevant; stale → drop silently with telemetry
 *   - Answer interpretation by Tier 1 LLM (positive / negative / ambiguous /
 *     non-responsive); ambiguous triggers sharpen + retry up to maxRetries=2,
 *     then status=abandoned
 *
 * Extended, not forked (context-budget-layered-summaries §6.1, decision 15):
 *
 *   - `kind`: `ref` (absent on every older record) or `evolution` (a purpose
 *     change in the context-budget ledger).
 *   - Per-kind TTL. `ref` keeps 5 turns OR 24h from dequeue. `evolution`
 *     never expires before it is SURFACED (the next agent reply after it went
 *     outstanding, `markSurfaced`), and then only when BOTH 7 days have passed
 *     since surfacing AND the user has sent at least one message since.
 *   - Priority: an evolution outranks ref confirmations. An outstanding ref
 *     it displaces is REQUEUED at the queue's head (its clock restarts at its
 *     next dequeue), never dropped; queued evolutions sit ahead of queued refs.
 *   - Overflow: past the queue depth the lowest-priority item (the newest ref,
 *     else the newest evolution) moves to `pending.deferred` with telemetry,
 *     and deferred items move back up as the queue drains. Nothing is dropped
 *     for lack of room (this replaces v14's "4th queued is dropped").
 *   - `settle`: a confirmation resolved by its ledger entry (confirmed,
 *     withdrawn or superseded by other evidence) leaves the queue.
 *   - `kind: backfill` (S7): one per topic, for the Anchor and ledger rebuilt
 *     from history. It ranks between the two (evolution > backfill > ref),
 *     never displaces an outstanding confirmation itself, has the evolution
 *     clock (never before surfaced, then 7 days AND a user turn), and is
 *     never dropped at dequeue (its refId names no ref; the ledger settles it).
 *
 * Every queue mutation runs under the store's per-topic lock (`mutate`), so
 * it can never lose a concurrent evidence append.
 *
 * Framework-agnostic: pure logic over the JSON store. No transport coupling.
 */

import { randomUUID } from 'node:crypto';
import {
  TopicIntentStore,
  buildEvent,
  projectConfidence,
  type PendingConfirmation,
  type PendingConfirmKind,
  type TopicIntentFile,
} from './TopicIntent.js';

const QUEUE_DEPTH_MAX = 3;
const DEFAULT_TTL = { turns: 5, hours: 24 };
const DEFAULT_MAX_RETRIES = 2;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Per-kind TTLs (§6.1). `ref`: 5 turns OR 24h from dequeue (v14). `evolution`:
 * 7 days AND at least one user turn, both counted from surfacing (decision 3:
 * "never before surfaced once and ≥ 1 user message since"; the 7-day clock is
 * a policy default in the spec's Defaults table).
 */
export const PENDING_TTL_BY_KIND: Readonly<Record<PendingConfirmKind, { turns: number; hours: number }>> = {
  ref: DEFAULT_TTL,
  evolution: { turns: 1, hours: 7 * 24 },
  backfill: { turns: 1, hours: 7 * 24 },
};

const kindOf = (p: PendingConfirmation): PendingConfirmKind => (p.kind === 'evolution' ? 'evolution' : p.kind === 'backfill' ? 'backfill' : 'ref');
/** Priority: a live purpose change, then the history rebuild, then ref confirmations. */
const RANK: Readonly<Record<PendingConfirmKind, number>> = { evolution: 2, backfill: 1, ref: 0 };
const rank = (p: PendingConfirmation): number => RANK[kindOf(p)];
/** Kinds whose clock runs from surfacing (evolution, backfill), not from dequeue. */
const surfacedKind = (p: PendingConfirmation): boolean => kindOf(p) !== 'ref';
/** Where a record of rank `r` goes in the queue: before the first lower-ranked item (FIFO within a rank). */
const insertAt = (queue: PendingConfirmation[], r: number): number => queue.findIndex(p => rank(p) < r);

export type AnswerVerdict = 'positive' | 'negative' | 'ambiguous' | 'non-responsive';

export interface CreateOpts {
  topicId: number;
  arcId: string;
  refId: string;
  propositionText: string;
  questionText: string;
  currentUserTurn: number;
  now?: string;          // ISO; defaults to new Date()
  ttl?: { turns: number; hours: number };
  maxRetries?: number;
  /** Absent ⇒ `ref`. */
  kind?: PendingConfirmKind;
}

export interface RevalidationResult {
  valid: boolean;
  reason?: 'no-longer-tentative' | 'proposition-stale' | 'ref-missing' | 'ok';
}

/**
 * Operator-supplied callbacks. Both are deterministic from the manager's
 * point of view — the caller routes them to whatever LLM/lexical check
 * makes sense in context.
 */
export interface PendingConfirmCallbacks {
  /**
   * Asked at DEQUEUE time. Returns whether the queued proposition is still
   * semantically relevant given more recent events on the topic.
   * Default: always valid (no-op stub for tests / pre-Layer-3).
   */
  revalidateProposition?: (queued: PendingConfirmation, file: TopicIntentFile) => RevalidationResult;
}

export interface CreateResult {
  /** `deferred`: past the queue depth — kept in `pending.deferred`, never dropped. */
  status: 'outstanding' | 'queued' | 'deferred' | 'dropped-duplicate';
  pendingId?: string;
  reason?: string;
  /** Set when an evolution displaced the outstanding ref confirmation back into the queue. */
  requeuedPendingId?: string;
}

export class PendingConfirmationManager {
  constructor(
    private store: TopicIntentStore,
    private callbacks: PendingConfirmCallbacks = {}
  ) {}

  /**
   * Create a new pending confirmation. It goes outstanding, queues, or (past
   * the queue depth) is deferred; a duplicate refId is a no-op. An evolution
   * displaces an outstanding ref confirmation, which is requeued at the head.
   */
  create(opts: CreateOpts): CreateResult {
    const now = opts.now ?? new Date().toISOString();
    const kind: PendingConfirmKind = opts.kind === 'evolution' ? 'evolution' : opts.kind === 'backfill' ? 'backfill' : 'ref';
    return this.store.mutate(opts.topicId, (file): CreateResult => {
      const deferred = file.pending.deferred ?? [];
      // Dedup: drop if a pending (outstanding, queued or deferred) already targets this refId
      if (file.pending.outstanding?.refId === opts.refId) {
        return { status: 'dropped-duplicate', reason: 'refId is already outstanding' };
      }
      if (file.pending.queue.some(p => p.refId === opts.refId)) {
        return { status: 'dropped-duplicate', reason: 'refId is already queued' };
      }
      if (deferred.some(p => p.refId === opts.refId)) {
        return { status: 'dropped-duplicate', reason: 'refId is already deferred' };
      }

      const record: PendingConfirmation = {
        pendingId: randomUUID(),
        topicId: opts.topicId,
        arcId: opts.arcId,
        refId: opts.refId,
        propositionText: opts.propositionText,
        questionText: opts.questionText,
        sentAtTurn: opts.currentUserTurn,
        sentAtTime: now,
        ttl: opts.ttl ?? PENDING_TTL_BY_KIND[kind],
        retries: 0,
        maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
        status: 'pending',
        queuedAtTime: now,
        // Older records carry no kind; only an evolution or a backfill is stamped, so a ref record is byte-identical.
        ...(kind !== 'ref' ? { kind } : {}),
      };
      file.telemetry.pending_confirm_created_total++;

      const goOutstanding = () => {
        record.dequeuedAtTime = now;
        record.sentAtTime = now;
        record.sentAtTurn = opts.currentUserTurn;
        file.pending.outstanding = record;
      };

      // Outstanding slot empty → goes outstanding immediately
      if (file.pending.outstanding === null) {
        goOutstanding();
        return { status: 'outstanding', pendingId: record.pendingId };
      }

      // An evolution outranks an outstanding ref or backfill: it is requeued at the head of its rank, never dropped.
      if (kind === 'evolution' && kindOf(file.pending.outstanding) !== 'evolution') {
        const displaced = file.pending.outstanding;
        displaced.requeued = (displaced.requeued ?? 0) + 1;
        // Its TTL clock restarts when it is next dequeued, and a surfaced-kind is surfaced again then.
        delete displaced.dequeuedAtTime;
        delete displaced.surfacedAtTime; delete displaced.surfacedAtTurn; delete displaced.surfacedAfterMessageId;
        file.telemetry.pending_confirm_requeued_total = (file.telemetry.pending_confirm_requeued_total ?? 0) + 1;
        // Ahead of everything of its own rank or lower (it was already outstanding).
        const at = file.pending.queue.findIndex(p => rank(p) <= rank(displaced));
        if (at === -1) file.pending.queue.push(displaced); else file.pending.queue.splice(at, 0, displaced);
        goOutstanding();
        this.overflow(file, now);
        return { status: 'outstanding', pendingId: record.pendingId, requeuedPendingId: displaced.pendingId };
      }

      // Queue by priority: evolutions, then backfill, then refs; FIFO within a kind.
      const at = insertAt(file.pending.queue, RANK[kind]);
      if (at === -1) file.pending.queue.push(record); else file.pending.queue.splice(at, 0, record);
      const spilled = this.overflow(file, now);
      if (spilled.includes(record.pendingId)) {
        return { status: 'deferred', pendingId: record.pendingId, reason: `queue at max depth ${QUEUE_DEPTH_MAX}` };
      }
      return { status: 'queued', pendingId: record.pendingId };
    });
  }

  /**
   * Move whatever no longer fits the queue to `pending.deferred` (the lowest
   * priority first: the newest ref, else the newest evolution). Returns the
   * pendingIds moved. Never drops anything.
   */
  private overflow(file: TopicIntentFile, _now: string): string[] {
    const moved: string[] = [];
    while (file.pending.queue.length > QUEUE_DEPTH_MAX) {
      // The last element is the lowest priority (refs sit behind evolutions).
      const out = file.pending.queue.pop()!;
      (file.pending.deferred ??= []).push(out);
      file.telemetry.pending_confirm_deferred_total = (file.telemetry.pending_confirm_deferred_total ?? 0) + 1;
      moved.push(out.pendingId);
    }
    return moved;
  }

  /**
   * Interpret an incoming user-authored message as an answer to the current
   * outstanding pending confirmation, if any.
   *
   * The caller is responsible for running the Tier-1 LLM verdict; this
   * method takes the verdict and applies the state machine.
   */
  interpretAnswer(
    topicId: number,
    verdict: AnswerVerdict,
    sourceMessageId: string,
    now?: string
  ): { applied: boolean; outcome: 'positive' | 'negative' | 'sharpen-retry' | 'abandoned' | 'no-outstanding' } {
    const at = now ?? new Date().toISOString();
    if (verdict === 'non-responsive') {
      // do nothing; TTL expiry handles it
      return { applied: false, outcome: 'no-outstanding' };
    }
    type Step = { out: PendingConfirmation | null; outcome: 'positive' | 'negative' | 'sharpen-retry' | 'abandoned' | 'no-outstanding' };
    const step = this.store.mutate(topicId, (file): Step => {
      const out = file.pending.outstanding;
      if (!out) return { out: null, outcome: 'no-outstanding' };
      if (verdict === 'positive' || verdict === 'negative') {
        out.status = 'answered';
        out.answeredAtTime = at;
        out.answerVerdict = verdict;
        file.pending.outstanding = null;
        file.telemetry.pending_confirm_answered_total[verdict] =
          (file.telemetry.pending_confirm_answered_total[verdict] ?? 0) + 1;
        return { out, outcome: verdict };
      }
      // ambiguous → sharpen + retry, up to maxRetries
      if (out.retries >= out.maxRetries) {
        out.status = 'abandoned';
        out.answeredAtTime = at;
        out.answerVerdict = 'ambiguous';
        file.pending.outstanding = null;
        file.telemetry.pending_confirm_abandoned_total++;
        return { out, outcome: 'abandoned' };
      }
      out.retries++;
      return { out, outcome: 'sharpen-retry' };
    });
    const { out, outcome } = step;
    if (!out) return { applied: false, outcome: 'no-outstanding' };
    if (outcome === 'positive') {
      // Emit confidence event
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'pending-confirm-positive', sourceMessageId, { at }));
      this.dequeueNext(topicId, at);
      return { applied: true, outcome };
    }
    if (outcome === 'negative') {
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'pending-confirm-negative', sourceMessageId, { at }));
      this.dequeueNext(topicId, at);
      return { applied: true, outcome };
    }
    if (outcome === 'abandoned') {
      // Bookkeeping event so the evidence log shows the retries happened
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'sharpen-retry-issued', sourceMessageId, { at, delta: 0, meta: { final: true } }));
      this.dequeueNext(topicId, at);
      return { applied: true, outcome };
    }
    this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'sharpen-retry-issued', sourceMessageId, { at, delta: 0, meta: { retry: out.retries } }));
    return { applied: true, outcome: 'sharpen-retry' };
  }

  /**
   * Record that the outstanding EVOLUTION confirmation was surfaced: the next
   * agent reply after it went outstanding has been captured. Its clock starts
   * here (§6.1). A ref confirmation, an already-surfaced one, or no
   * outstanding record ⇒ null.
   */
  markSurfaced(topicId: number, opts: { currentUserTurn: number; afterMessageId: string; now?: string }): PendingConfirmation | null {
    const at = opts.now ?? new Date().toISOString();
    return this.store.mutate(topicId, (file) => {
      const out = file.pending.outstanding;
      if (!out || !surfacedKind(out) || out.surfacedAtTime) return null;
      out.surfacedAtTime = at;
      out.surfacedAtTurn = opts.currentUserTurn;
      out.surfacedAfterMessageId = opts.afterMessageId;
      return { ...out };
    });
  }

  /**
   * Sweep for TTL expiry on the outstanding pending. Called by the caller
   * after every substantive user turn (turn-based TTL) and periodically
   * (clock-based TTL).
   *
   * `ref`: expires at 5 turns OR 24h since dequeue. `evolution`: never before
   * it was surfaced; then only when BOTH its hours have passed since surfacing
   * AND at least `ttl.turns` user turns have arrived since.
   *
   * Returns the dropped pending if one was swept.
   */
  sweepTtl(topicId: number, currentUserTurn: number, now?: string): PendingConfirmation | null {
    const nowDate = now ?? new Date().toISOString();
    const swept = this.store.mutate(topicId, (file) => {
      const out = file.pending.outstanding;
      if (!out) return null;
      let expired: boolean;
      if (surfacedKind(out)) {
        if (!out.surfacedAtTime || out.surfacedAtTurn === undefined) return null;
        const elapsedHours = (Date.parse(nowDate) - Date.parse(out.surfacedAtTime)) / MS_PER_HOUR;
        const turnsSince = currentUserTurn - out.surfacedAtTurn;
        expired = elapsedHours >= out.ttl.hours && turnsSince >= Math.max(1, out.ttl.turns);
      } else {
        const dequeuedAt = new Date(out.dequeuedAtTime ?? out.sentAtTime).getTime();
        const elapsedHours = (Date.parse(nowDate) - dequeuedAt) / MS_PER_HOUR;
        const elapsedTurns = currentUserTurn - out.sentAtTurn;
        expired = elapsedTurns >= out.ttl.turns || elapsedHours >= out.ttl.hours;
      }
      if (!expired) return null;
      out.status = 'expired';
      out.answeredAtTime = nowDate;
      file.pending.outstanding = null;
      file.telemetry.pending_confirm_expired_total++;
      return out;
    });
    if (swept) this.dequeueNext(topicId, nowDate, currentUserTurn);
    return swept;
  }

  /**
   * Remove the confirmation for `refId` (outstanding, queued or deferred)
   * because its ledger entry was resolved by other evidence (§6.1). Returns
   * the removed record, or null when none targets the refId.
   */
  settle(topicId: number, refId: string, settledAs: string, opts: { currentUserTurn?: number; now?: string } = {}): PendingConfirmation | null {
    const at = opts.now ?? new Date().toISOString();
    let wasOutstanding = false;
    const removed = this.store.mutate(topicId, (file) => {
      const mark = (p: PendingConfirmation) => {
        p.status = 'answered';
        p.answeredAtTime = at;
        p.settledAs = settledAs;
        file.telemetry.pending_confirm_settled_total = (file.telemetry.pending_confirm_settled_total ?? 0) + 1;
        return p;
      };
      if (file.pending.outstanding?.refId === refId) {
        const out = file.pending.outstanding;
        file.pending.outstanding = null;
        wasOutstanding = true;
        return mark(out);
      }
      for (const list of [file.pending.queue, file.pending.deferred ?? []]) {
        const i = list.findIndex(p => p.refId === refId);
        if (i >= 0) return mark(list.splice(i, 1)[0]);
      }
      return null;
    });
    // A slot or a queue place freed: promote and refill.
    if (removed) this.dequeueNext(topicId, at, opts.currentUserTurn);
    return removed;
  }

  /** Force-cancel the outstanding pending (e.g. on emergency stop / corrective input). */
  cancelOutstanding(topicId: number, now?: string): PendingConfirmation | null {
    const at = now ?? new Date().toISOString();
    const out = this.store.mutate(topicId, (file) => {
      const o = file.pending.outstanding;
      if (!o) return null;
      o.status = 'abandoned';
      o.answeredAtTime = at;
      file.pending.outstanding = null;
      file.telemetry.pending_confirm_abandoned_total++;
      return o;
    });
    if (out) this.dequeueNext(topicId, at);
    return out;
  }

  /**
   * Promote the next queued item to outstanding (if any), then refill the
   * queue from `deferred` (evolutions first). Runs revalidation at dequeue
   * time. Stale items are dropped silently (telemetry only).
   */
  private dequeueNext(topicId: number, now: string, currentUserTurn?: number): void {
    this.store.mutate(topicId, (file) => {
      const refill = () => {
        const deferred = file.pending.deferred;
        while (deferred && deferred.length > 0 && file.pending.queue.length < QUEUE_DEPTH_MAX) {
          // The highest rank moves up first, oldest first within a kind.
          const top = Math.max(...deferred.map(rank));
          const [up] = deferred.splice(deferred.findIndex(p => rank(p) === top), 1);
          const at = insertAt(file.pending.queue, rank(up));
          if (at === -1) file.pending.queue.push(up); else file.pending.queue.splice(at, 0, up);
        }
      };
      refill();
      while (file.pending.queue.length > 0 && file.pending.outstanding === null) {
        const next = file.pending.queue.shift()!;
        refill();
        const result = this.revalidate(next, file);
        if (!result.valid) {
          // Silent drop; telemetry only
          file.telemetry.pending_confirm_expired_total++; // re-use the expired counter for stale-queue-dropped
          continue;
        }
        next.dequeuedAtTime = now;
        next.sentAtTime = now; // TTL clock starts now
        // The turn it went outstanding at (surfacing needs a user turn after it); the store's counter when the caller has none.
        next.sentAtTurn = currentUserTurn ?? file.turn ?? next.sentAtTurn;
        file.pending.outstanding = next;
      }
    });
  }

  private revalidate(record: PendingConfirmation, file: TopicIntentFile): RevalidationResult {
    // A backfill confirmation names the topic's rebuilt history, not a ref: the ledger settles it.
    if (kindOf(record) === 'backfill') return { valid: true, reason: 'ok' };
    // Built-in check: refId still exists and still tentative (not authoritative, not gone)
    const ref = file.refs[record.refId];
    if (!ref) return { valid: false, reason: 'ref-missing' };

    // Use store's projection to determine tier (computed from the file in hand: the lock is held)
    // An evolution's standing is the ledger's to decide (context-budget §6.1), not the v14 tier:
    // it is never dropped at dequeue for having become authoritative.
    const proj = projectConfidence(ref.evidence, ref.lastReinforcedAt, undefined, ref.kind);
    if (proj.tier === 'authoritative' && kindOf(record) !== 'evolution') {
      return { valid: false, reason: 'no-longer-tentative' };
    }

    // Operator-supplied semantic-relevance check (defaults to always-valid)
    if (this.callbacks.revalidateProposition) {
      return this.callbacks.revalidateProposition(record, file);
    }
    return { valid: true, reason: 'ok' };
  }
}
