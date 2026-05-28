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
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface OutstandingPromptTrackerOptions {
  /** Absolute path to the JSON file backing the tracker (per-mentee state). */
  filePath: string;
  /** A reply that doesn't arrive within this window is treated as orphaned. */
  replyTimeoutMs?: number;
  /** Injected for testability. */
  now?: () => number;
}

interface OutstandingPrompt {
  /** Wall-clock when the prompt was sent. */
  sentAt: number;
  /** Mentee framework label (for the audit + future multi-mentee fan-out). */
  mentee: string;
}

interface PersistedFile {
  v: 1;
  /** corr → record. */
  entries: Record<string, OutstandingPrompt>;
}

const DEFAULT_REPLY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — > the 15-min tick interval.

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: 'prior-prompt-in-flight'; outstandingCorr: string; sentAt: number };

export class OutstandingPromptTracker {
  private readonly filePath: string;
  private readonly replyTimeoutMs: number;
  private readonly now: () => number;
  private entries: Map<string, OutstandingPrompt>;
  /** Per-(reason,day) dedup for the orphan-degradation notification. */
  private orphanedNotifiedFor: Set<string>;

  constructor(opts: OutstandingPromptTrackerOptions) {
    this.filePath = opts.filePath;
    this.replyTimeoutMs = opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.entries = new Map();
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
   * Clear an outstanding prompt by `corr` (called when the matching reply arrives).
   * Returns true if an outstanding entry existed (legitimate reply); false if not
   * (a reply with no outstanding match — possibly a late reply after orphan-sweep,
   * or a spurious reply; the caller may want to log this).
   */
  clearByCorr(corr: string): boolean {
    const had = this.entries.delete(corr);
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
      const parsed = JSON.parse(raw) as PersistedFile;
      if (parsed && parsed.v === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const [corr, p] of Object.entries(parsed.entries)) {
          if (p && typeof p.sentAt === 'number' && typeof p.mentee === 'string') {
            this.entries.set(corr, { sentAt: p.sentAt, mentee: p.mentee });
          }
        }
      }
    } catch {
      // Corrupted state → start fresh; better than crashing the mentor on a bad file.
      this.entries = new Map();
    }
  }

  private persist(): void {
    const file: PersistedFile = {
      v: 1,
      entries: Object.fromEntries(this.entries),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      SafeFsExecutor.atomicWriteJsonSync(this.filePath, file, { operation: 'OutstandingPromptTracker.persist' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[mentor] OutstandingPromptTracker persist failed (non-fatal) at ${this.filePath}:`, err instanceof Error ? err.message : String(err));
    }
  }
}
