/**
 * OutstandingPromptTracker — anti-ping-pong invariant for the mentor live loop.
 *
 * Spec: MENTOR-LIVE-READINESS §Fix 2b "Implementation surface" item 4 + Justin's original
 * concern (the rebuilt-slow ping-pong: a 15-min mentor tick + a Codey reply that takes
 * 16+ min = naive next-tick re-sends while the prior is in flight → loop).
 *
 * Justin's user-fidelity correction made this THE real cadence gate (Fix 1 idle-probe
 * was removed; users don't probe). The mentor refuses to send a new prompt while any
 * prior prompt is outstanding within `replyTimeoutMs`. On timeout expiry without a reply
 * → degradation event + Attention entry (silent reply-loss is observable).
 *
 * Pure in-memory + a small persistence shim so a server restart doesn't lose the "I'm
 * waiting on a reply" state (would otherwise re-send + double-prompt Codey).
 *
 * Keyed per-mentee. The same `corr` round-trips: mark on send, clear on matching reply.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface OutstandingPromptTrackerOptions {
  /** Absolute path to the JSON file backing the tracker (per-mentee state). */
  filePath: string;
  /** A reply that doesn't arrive within this window is treated as orphaned. */
  replyTimeoutMs?: number;
  /** Maximum sends of identical unanswered content before its breaker opens. */
  maxIdenticalAttempts?: number;
  /** Hard bound for distinct unresolved content keys retained in the ledger. */
  maxTrackedContentKeys?: number;
  /** Injected for testability. */
  now?: () => number;
}

interface OutstandingPrompt {
  /** Wall-clock when the prompt was sent. */
  sentAt: number;
  /** Mentee framework label (for the audit + future multi-mentee fan-out). */
  mentee: string;
  /** Stable hash of the normalized mentor content reserved for this send. */
  contentKey?: string;
}

interface DeliveryRetryRecord {
  mentee: string;
  attempts: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  /** Persisted one-shot latch for the retry-exhaustion escalation. */
  escalatedAt?: number;
}

interface PersistedFileV1 {
  v: 1;
  /** corr → record. */
  entries: Record<string, OutstandingPrompt>;
}

interface PersistedFileV2 {
  v: 2;
  /** corr → record. */
  entries: Record<string, OutstandingPrompt>;
  /** content key → bounded retry record. Raw prompt text is never persisted. */
  retries: Record<string, DeliveryRetryRecord>;
}

const DEFAULT_REPLY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — > the 15-min tick interval.
const DEFAULT_MAX_IDENTICAL_ATTEMPTS = 3;
const DEFAULT_MAX_TRACKED_CONTENT_KEYS = 64;

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: 'prior-prompt-in-flight'; outstandingCorr: string; sentAt: number };

export type ReserveSendResult =
  | { ok: true; contentKey: string; attempt: number; exhausted: boolean }
  | {
      ok: false;
      reason: 'prior-prompt-in-flight';
      outstandingCorr: string;
      sentAt: number;
    }
  | {
      ok: false;
      reason: 'identical-content-retry-exhausted';
      contentKey: string;
      attempts: number;
      firstAttemptAt: number;
      lastAttemptAt: number;
      escalated: boolean;
    }
  | {
      ok: false;
      reason: 'delivery-retry-ledger-full' | 'delivery-state-unavailable';
    };

export class OutstandingPromptTracker {
  private readonly filePath: string;
  private readonly replyTimeoutMs: number;
  private readonly maxIdenticalAttempts: number;
  private readonly maxTrackedContentKeys: number;
  private readonly now: () => number;
  private entries: Map<string, OutstandingPrompt>;
  private retries: Map<string, DeliveryRetryRecord>;
  /** Per-(reason,day) dedup for the orphan-degradation notification. */
  private orphanedNotifiedFor: Set<string>;

  constructor(opts: OutstandingPromptTrackerOptions) {
    this.filePath = opts.filePath;
    this.replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.maxIdenticalAttempts = Math.max(
      1,
      Math.floor(opts.maxIdenticalAttempts ?? DEFAULT_MAX_IDENTICAL_ATTEMPTS),
    );
    this.maxTrackedContentKeys = Math.max(
      1,
      Math.floor(opts.maxTrackedContentKeys ?? DEFAULT_MAX_TRACKED_CONTENT_KEYS),
    );
    this.now = opts.now ?? Date.now;
    this.entries = new Map();
    this.retries = new Map();
    this.orphanedNotifiedFor = new Set();
    this.load();
  }

  /**
   * Returns `{ok: true}` if the mentor can send a new prompt to this mentee; otherwise
   * `{ok: false, reason: 'prior-prompt-in-flight'}` (the tick must refuse the send). An
   * EXPIRED outstanding (past replyTimeoutMs) is automatically swept here and does NOT
   * block — the caller can also call sweepExpired() explicitly to surface orphans.
   */
  canSendTo(mentee: string): CheckResult {
    this.sweepExpired();
    for (const [corr, p] of this.entries) {
      if (p.mentee === mentee) {
        return { ok: false, reason: 'prior-prompt-in-flight', outstandingCorr: corr, sentAt: p.sentAt };
      }
    }
    return { ok: true };
  }

  /** Record that a prompt with this `corr` was sent to this mentee at now(). */
  markSent(corr: string, mentee: string): void {
    this.entries.set(corr, { sentAt: this.now(), mentee });
    this.persist();
  }

  /**
   * Atomically reserve one outbound attempt BEFORE the transport is called.
   *
   * The reservation is the self-action boundary: the content-key attempt and
   * outstanding correlation land in one durable file first. If that write
   * fails, the send is refused rather than performed without a restart-proof
   * brake. Identical unanswered content opens a durable breaker after the
   * bounded attempt count; a different content key gets its own budget.
   */
  reserveSend(corr: string, mentee: string, content: string): ReserveSendResult {
    this.sweepExpired();
    for (const [outstandingCorr, prompt] of this.entries) {
      if (prompt.mentee === mentee) {
        return {
          ok: false,
          reason: 'prior-prompt-in-flight',
          outstandingCorr,
          sentAt: prompt.sentAt,
        };
      }
    }

    const contentKey = this.contentKey(mentee, content);
    const prior = this.retries.get(contentKey);
    if (prior && prior.attempts >= this.maxIdenticalAttempts) {
      return {
        ok: false,
        reason: 'identical-content-retry-exhausted',
        contentKey,
        attempts: prior.attempts,
        firstAttemptAt: prior.firstAttemptAt,
        lastAttemptAt: prior.lastAttemptAt,
        escalated: prior.escalatedAt != null,
      };
    }
    if (!prior && this.retries.size >= this.maxTrackedContentKeys) {
      return { ok: false, reason: 'delivery-retry-ledger-full' };
    }

    const now = this.now();
    const next: DeliveryRetryRecord = prior
      ? { ...prior, attempts: prior.attempts + 1, lastAttemptAt: now }
      : { mentee, attempts: 1, firstAttemptAt: now, lastAttemptAt: now };
    this.retries.set(contentKey, next);
    this.entries.set(corr, { sentAt: now, mentee, contentKey });
    if (!this.persist()) {
      this.entries.delete(corr);
      if (prior) this.retries.set(contentKey, prior);
      else this.retries.delete(contentKey);
      return { ok: false, reason: 'delivery-state-unavailable' };
    }
    return {
      ok: true,
      contentKey,
      attempt: next.attempts,
      exhausted: next.attempts >= this.maxIdenticalAttempts,
    };
  }

  /**
   * The transport refused or threw after a durable reservation. Remove only
   * the in-flight correlation; retain the attempt so transport failures consume
   * the same bounded budget as unacknowledged sends.
   */
  markDeliveryFailed(corr: string): void {
    if (this.entries.delete(corr)) this.persist();
  }

  /**
   * Clear an outstanding prompt by `corr` (called when the matching reply arrives).
   * Returns true if an outstanding entry existed (legitimate reply); false if not
   * (a reply with no outstanding match — possibly a late reply after orphan-sweep,
   * or a spurious reply; the caller may want to log this).
   */
  clearByCorr(corr: string): boolean {
    const prompt = this.entries.get(corr);
    const had = this.entries.delete(corr);
    // A matching reply resolves the unanswered-content episode. Future use of
    // the same words is a new conversation turn, not a continuation of this
    // exhausted retry budget.
    if (prompt?.contentKey) this.retries.delete(prompt.contentKey);
    if (had) this.persist();
    return had;
  }

  /**
   * Find + remove orphans (sentAt + replyTimeoutMs < now). Returns the list. Caller
   * decides whether to fire DegradationReporter / Attention. The dedup field stays
   * across calls so the same orphan-episode doesn't re-fire repeatedly.
   */
  sweepExpired(): Array<{ corr: string; mentee: string; sentAt: number; ageMs: number }> {
    const cutoff = this.now() - this.replyTimeoutMs;
    const out: Array<{ corr: string; mentee: string; sentAt: number; ageMs: number }> = [];
    for (const [corr, p] of this.entries) {
      if (p.sentAt < cutoff) {
        out.push({ corr, mentee: p.mentee, sentAt: p.sentAt, ageMs: this.now() - p.sentAt });
        this.entries.delete(corr);
      }
    }
    if (out.length > 0) this.persist();
    return out;
  }

  /** Idempotent: once an orphan-notify has fired for a (corr), don't re-fire. */
  recordOrphanNotified(corr: string): boolean {
    if (this.orphanedNotifiedFor.has(corr)) return false;
    this.orphanedNotifiedFor.add(corr);
    return true;
  }

  /**
   * Durable one-shot latch for the distinct transport/delivery escalation.
   * Returns true exactly once for an exhausted content key, including across a
   * tracker reconstruction (server restart).
   */
  recordRetryExhaustionEscalated(contentKey: string): boolean {
    const prior = this.retries.get(contentKey);
    if (!prior || prior.attempts < this.maxIdenticalAttempts || prior.escalatedAt != null) {
      return false;
    }
    this.retries.set(contentKey, { ...prior, escalatedAt: this.now() });
    if (!this.persist()) {
      // Refuse to emit an escalation whose one-shot latch is not durable. The
      // next tick may retry the state write, but it cannot create a flood on a
      // restart from an unrecorded notification.
      this.retries.set(contentKey, prior);
      return false;
    }
    return true;
  }

  /** Test helper. */
  size(): number {
    return this.entries.size;
  }

  /** Test helper. */
  list(): Array<{ corr: string; mentee: string; sentAt: number }> {
    return [...this.entries].map(([corr, p]) => ({ corr, mentee: p.mentee, sentAt: p.sentAt }));
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedFileV1 | PersistedFileV2;
      if (parsed && (parsed.v === 1 || parsed.v === 2) && parsed.entries && typeof parsed.entries === 'object') {
        for (const [corr, p] of Object.entries(parsed.entries)) {
          if (p && typeof p.sentAt === 'number' && typeof p.mentee === 'string') {
            this.entries.set(corr, {
              sentAt: p.sentAt,
              mentee: p.mentee,
              contentKey: typeof p.contentKey === 'string' ? p.contentKey : undefined,
            });
          }
        }
      }
      if (parsed?.v === 2 && parsed.retries && typeof parsed.retries === 'object') {
        for (const [contentKey, r] of Object.entries(parsed.retries)) {
          if (
            r &&
            typeof r.mentee === 'string' &&
            Number.isInteger(r.attempts) &&
            r.attempts > 0 &&
            typeof r.firstAttemptAt === 'number' &&
            typeof r.lastAttemptAt === 'number'
          ) {
            this.retries.set(contentKey, {
              mentee: r.mentee,
              attempts: r.attempts,
              firstAttemptAt: r.firstAttemptAt,
              lastAttemptAt: r.lastAttemptAt,
              escalatedAt: typeof r.escalatedAt === 'number' ? r.escalatedAt : undefined,
            });
          }
        }
      }
    } catch {
      // Corrupted state → start fresh; better than crashing the mentor on a bad file.
      this.entries = new Map();
      this.retries = new Map();
    }
  }

  private contentKey(mentee: string, content: string): string {
    const normalized = content.normalize('NFKC').trim().replace(/\s+/g, ' ');
    return createHash('sha256').update(`${mentee}\0${normalized}`, 'utf8').digest('hex');
  }

  private persist(): boolean {
    const file: PersistedFileV2 = {
      v: 2,
      entries: Object.fromEntries(this.entries),
      retries: Object.fromEntries(this.retries),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      SafeFsExecutor.atomicWriteJsonSync(this.filePath, file, { operation: 'OutstandingPromptTracker.persist' });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mentor] OutstandingPromptTracker persist failed (non-fatal) at ${this.filePath}:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
