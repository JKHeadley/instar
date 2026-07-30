/**
 * relayContentDedup — content-hash dedup for the agent-to-agent `relay-agent`
 * ingress path.
 *
 * The id-based dedup in MessageRouter.relay keys on `message.id`. That misses a
 * specific failure mode observed 2026-05-30: a SENDER whose HTTP call blocks on
 * the RECEIVER's session spawn (slow on a loaded box) times out, then RETRIES
 * the same message with a FRESH `message.id`. The retry slips past the id-based
 * dedup → the receiver spawns/resumes and replies twice (the duplicate-reply
 * bug — saw 6 doubled replies in one evening).
 *
 * This layer recognizes the retry by the STABLE triple
 * (senderAgent, threadId, normalized content) within a short window, regardless
 * of the message id. It is a bounded, in-memory, fixed-window dedup:
 *   - fresh (sender, thread, content) → process + record
 *   - identical within `ttlMs` of first-seen → drop (duplicate retry)
 *   - identical `ttlMs`+ after first-seen → process (plausibly a real re-send)
 *
 * Memory is bounded by `maxEntries` (oldest-evicted) plus a lazy sweep of
 * expired keys on each call. The window is intentionally short so it only ever
 * collapses true rapid retries, never two genuinely-distinct sends.
 */

import crypto from 'node:crypto';

export interface RelayContentDedupOpts {
  /** Window from first-seen during which an identical inbound is a duplicate. */
  ttlMs?: number;
  /** Hard cap on retained keys (oldest evicted past this). */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class RelayContentDedup {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** key -> firstSeen epoch ms (Map preserves insertion order for eviction). */
  private readonly seen = new Map<string, number>();

  constructor(opts: RelayContentDedupOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  /** Stable dedup key for an inbound relay message. */
  static keyFor(senderAgent: string, threadId: string, content: string): string {
    // Collapse insignificant whitespace so a retry that only differs in
    // trailing/internal whitespace still matches.
    const normalized = content.trim().replace(/\s+/g, ' ');
    return crypto
      .createHash('sha256')
      .update(`${senderAgent}\u0000${threadId}\u0000${normalized}`)
      .digest('hex');
  }

  /**
   * Returns true if this inbound should be processed (fresh, or the prior
   * sighting has aged past the window); false if it is a duplicate retry seen
   * within the window. Fresh keys are recorded. Safe to call on every inbound.
   */
  shouldProcess(senderAgent: string, threadId: string, content: string): boolean {
    const t = this.now();
    this.sweep(t);
    const key = RelayContentDedup.keyFor(senderAgent, threadId, content);
    const prior = this.seen.get(key);
    if (prior !== undefined && t - prior < this.ttlMs) {
      return false;
    }
    // Fixed window: re-stamp from this sighting only when the prior one expired
    // (or never existed), so a persistent retrier doesn't slide the window open
    // forever while still being recognized as duplicate within each window.
    this.seen.set(key, t);
    this.enforceCap();
    return true;
  }

  /**
   * Release a fresh-key reservation when downstream inbox admission fails.
   * Otherwise the rejected attempt would poison an identical valid retry for
   * the full dedup window.
   */
  forget(senderAgent: string, threadId: string, content: string): void {
    this.seen.delete(RelayContentDedup.keyFor(senderAgent, threadId, content));
  }

  /** Number of retained keys (test/observability aid). */
  size(): number {
    return this.seen.size;
  }

  private sweep(t: number): void {
    if (this.seen.size === 0) return;
    for (const [k, ts] of this.seen) {
      if (t - ts >= this.ttlMs) this.seen.delete(k);
    }
  }

  private enforceCap(): void {
    if (this.seen.size <= this.maxEntries) return;
    const overflow = this.seen.size - this.maxEntries;
    let i = 0;
    for (const k of this.seen.keys()) {
      this.seen.delete(k);
      if (++i >= overflow) break;
    }
  }
}
