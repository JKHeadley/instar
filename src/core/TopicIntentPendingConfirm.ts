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
 * Framework-agnostic: pure logic over the JSON store. No transport coupling.
 */

import { randomUUID } from 'node:crypto';
import {
  TopicIntentStore,
  buildEvent,
  type PendingConfirmation,
  type TopicIntentFile,
} from './TopicIntent.js';

const QUEUE_DEPTH_MAX = 3;
const DEFAULT_TTL = { turns: 5, hours: 24 };
const DEFAULT_MAX_RETRIES = 2;
const MS_PER_HOUR = 60 * 60 * 1000;

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
  status: 'outstanding' | 'queued' | 'dropped-duplicate' | 'dropped-queue-full';
  pendingId?: string;
  reason?: string;
}

export class PendingConfirmationManager {
  constructor(
    private store: TopicIntentStore,
    private callbacks: PendingConfirmCallbacks = {}
  ) {}

  /**
   * Create a new pending confirmation. May go outstanding immediately,
   * queue, or be dropped (duplicate / queue full).
   */
  create(opts: CreateOpts): CreateResult {
    const file = this.store.load(opts.topicId);
    const now = opts.now ?? new Date().toISOString();

    // Dedup: drop if a pending (outstanding or queued) already targets this refId
    if (file.pending.outstanding?.refId === opts.refId) {
      return { status: 'dropped-duplicate', reason: 'refId is already outstanding' };
    }
    if (file.pending.queue.some(p => p.refId === opts.refId)) {
      return { status: 'dropped-duplicate', reason: 'refId is already queued' };
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
      ttl: opts.ttl ?? DEFAULT_TTL,
      retries: 0,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      status: 'pending',
      queuedAtTime: now,
    };

    // Outstanding slot empty → goes outstanding immediately
    if (file.pending.outstanding === null) {
      record.dequeuedAtTime = now;
      record.sentAtTime = now;
      record.sentAtTurn = opts.currentUserTurn;
      file.pending.outstanding = record;
      file.telemetry.pending_confirm_created_total++;
      this.store.save(file);
      return { status: 'outstanding', pendingId: record.pendingId };
    }

    // Otherwise queue if there's room
    if (file.pending.queue.length >= QUEUE_DEPTH_MAX) {
      file.telemetry.pending_confirm_queue_dropped_total++;
      this.store.save(file);
      return { status: 'dropped-queue-full', reason: `queue at max depth ${QUEUE_DEPTH_MAX}` };
    }
    file.pending.queue.push(record);
    file.telemetry.pending_confirm_created_total++;
    this.store.save(file);
    return { status: 'queued', pendingId: record.pendingId };
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
    const file = this.store.load(topicId);
    const out = file.pending.outstanding;
    const at = now ?? new Date().toISOString();
    if (!out) return { applied: false, outcome: 'no-outstanding' };

    if (verdict === 'positive') {
      out.status = 'answered';
      out.answeredAtTime = at;
      out.answerVerdict = 'positive';
      file.pending.outstanding = null;
      file.telemetry.pending_confirm_answered_total['positive'] =
        (file.telemetry.pending_confirm_answered_total['positive'] ?? 0) + 1;
      this.store.save(file);
      // Emit confidence event
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'pending-confirm-positive', sourceMessageId, { at }));
      this.dequeueNext(topicId, at);
      return { applied: true, outcome: 'positive' };
    }
    if (verdict === 'negative') {
      out.status = 'answered';
      out.answeredAtTime = at;
      out.answerVerdict = 'negative';
      file.pending.outstanding = null;
      file.telemetry.pending_confirm_answered_total['negative'] =
        (file.telemetry.pending_confirm_answered_total['negative'] ?? 0) + 1;
      this.store.save(file);
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'pending-confirm-negative', sourceMessageId, { at }));
      this.dequeueNext(topicId, at);
      return { applied: true, outcome: 'negative' };
    }
    if (verdict === 'ambiguous') {
      // Sharpen + retry, up to maxRetries
      if (out.retries >= out.maxRetries) {
        out.status = 'abandoned';
        out.answeredAtTime = at;
        out.answerVerdict = 'ambiguous';
        file.pending.outstanding = null;
        file.telemetry.pending_confirm_abandoned_total++;
        // Bookkeeping event so the evidence log shows the retries happened
        this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'sharpen-retry-issued', sourceMessageId, { at, delta: 0, meta: { final: true } }));
        this.store.save(file);
        this.dequeueNext(topicId, at);
        return { applied: true, outcome: 'abandoned' };
      }
      out.retries++;
      this.store.appendEvidence(topicId, out.refId, buildEvent(out.refId, 'sharpen-retry-issued', sourceMessageId, { at, delta: 0, meta: { retry: out.retries } }));
      this.store.save(file);
      return { applied: true, outcome: 'sharpen-retry' };
    }
    // verdict === 'non-responsive' → do nothing; TTL expiry handles it
    return { applied: false, outcome: 'no-outstanding' };
  }

  /**
   * Sweep for TTL expiry on the outstanding pending. Called by the caller
   * after every substantive user turn (turn-based TTL) and periodically
   * (clock-based TTL).
   *
   * Returns the dropped pending if one was swept.
   */
  sweepTtl(topicId: number, currentUserTurn: number, now?: string): PendingConfirmation | null {
    const file = this.store.load(topicId);
    const out = file.pending.outstanding;
    if (!out) return null;
    const nowDate = now ?? new Date().toISOString();
    const dequeuedAt = new Date(out.dequeuedAtTime ?? out.sentAtTime).getTime();
    const elapsedHours = (Date.parse(nowDate) - dequeuedAt) / MS_PER_HOUR;
    const elapsedTurns = currentUserTurn - out.sentAtTurn;

    if (elapsedTurns >= out.ttl.turns || elapsedHours >= out.ttl.hours) {
      out.status = 'expired';
      out.answeredAtTime = nowDate;
      file.pending.outstanding = null;
      file.telemetry.pending_confirm_expired_total++;
      this.store.save(file);
      this.dequeueNext(topicId, nowDate);
      return out;
    }
    return null;
  }

  /** Force-cancel the outstanding pending (e.g. on emergency stop / corrective input). */
  cancelOutstanding(topicId: number, now?: string): PendingConfirmation | null {
    const file = this.store.load(topicId);
    const out = file.pending.outstanding;
    if (!out) return null;
    out.status = 'abandoned';
    out.answeredAtTime = now ?? new Date().toISOString();
    file.pending.outstanding = null;
    file.telemetry.pending_confirm_abandoned_total++;
    this.store.save(file);
    this.dequeueNext(topicId, out.answeredAtTime);
    return out;
  }

  /**
   * Promote the next queued item to outstanding (if any).
   * Runs revalidation at dequeue time. Stale items are dropped silently.
   */
  private dequeueNext(topicId: number, now: string): void {
    const file = this.store.load(topicId);
    while (file.pending.queue.length > 0 && file.pending.outstanding === null) {
      const next = file.pending.queue.shift()!;
      const result = this.revalidate(next, file);
      if (!result.valid) {
        // Silent drop; telemetry only
        file.telemetry.pending_confirm_expired_total++; // re-use the expired counter for stale-queue-dropped
        continue;
      }
      next.dequeuedAtTime = now;
      next.sentAtTime = now; // TTL clock starts now
      file.pending.outstanding = next;
      break;
    }
    this.store.save(file);
  }

  private revalidate(record: PendingConfirmation, file: TopicIntentFile): RevalidationResult {
    // Built-in check: refId still exists and still tentative (not authoritative, not gone)
    const ref = file.refs[record.refId];
    if (!ref) return { valid: false, reason: 'ref-missing' };

    // Use store's projection to determine tier
    const proj = this.store.getProjection(record.topicId, record.refId);
    if (!proj || proj.tier === 'authoritative') {
      return { valid: false, reason: 'no-longer-tentative' };
    }

    // Operator-supplied semantic-relevance check (defaults to always-valid)
    if (this.callbacks.revalidateProposition) {
      return this.callbacks.revalidateProposition(record, file);
    }
    return { valid: true, reason: 'ok' };
  }
}
