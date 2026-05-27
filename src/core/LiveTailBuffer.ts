/**
 * LiveTailBuffer — the standby-side persisted live-tail with sequence-dedup
 * (spec §8 G3b). The holder pushes monotonic-sequence flushes of the live
 * conversation tail; the standby applies a flush ONLY if its sequence is
 * lastAppliedSeq + 1, coalescing/holding out-of-order flushes and dropping
 * duplicates — so an at-least-once tunnel redelivery cannot double-append and
 * corrupt the persisted context window (which would make a post-failover reply
 * misrepresent history, violating acceptance criterion 3).
 *
 * Out-of-order flushes are held only until liveTailOutOfOrderTimeoutMs; if the
 * gap is never filled (sender died mid-sequence) the buffer DECLARES THE GAP
 * UNFILLABLE, discards the held flushes, and proceeds with the last contiguous
 * sequence as its resumable tail — bounding the holdout buffer and never
 * wedging the standby behind a gap the at-least-once channel will re-present.
 *
 * Bounded by liveTailMaxBytesPerTopic (drop-oldest). Pure logic — the encrypted
 * transport feeds applyFlush(); persistence is the caller's (an injected sink).
 */

export interface LiveTailFlush {
  seq: number;
  topic: string;
  /** Already-redacted, already-decrypted tail content for this flush. */
  content: string;
  /** Bytes (for the cap); defaults to content length. */
  bytes?: number;
  receivedAtMs?: number;
}

export interface LiveTailBufferConfig {
  outOfOrderTimeoutMs: number;
  maxBytesPerTopic: number;
  now?: () => number;
  logger?: (msg: string) => void;
}

interface TopicState {
  lastAppliedSeq: number;
  applied: LiveTailFlush[];
  held: Map<number, LiveTailFlush & { heldAtMs: number }>;
  bytes: number;
}

export interface ApplyResult {
  applied: boolean;
  reason: 'applied' | 'duplicate' | 'held-out-of-order' | 'gap-discarded-then-applied';
}

export class LiveTailBuffer {
  private readonly cfg: LiveTailBufferConfig;
  private topics = new Map<string, TopicState>();

  constructor(cfg: LiveTailBufferConfig) {
    this.cfg = cfg;
  }

  private now(): number {
    return (this.cfg.now ?? Date.now)();
  }
  private log(m: string): void {
    this.cfg.logger?.(`[live-tail] ${m}`);
  }

  private topic(id: string): TopicState {
    let t = this.topics.get(id);
    if (!t) {
      t = { lastAppliedSeq: 0, applied: [], held: new Map(), bytes: 0 };
      this.topics.set(id, t);
    }
    return t;
  }

  /**
   * Apply a flush. Returns whether it was applied (or held/dropped). Enforces
   * exactly-once contiguous application: dup dropped, out-of-order held, gap
   * timed-out and discarded.
   */
  applyFlush(flush: LiveTailFlush): ApplyResult {
    const t = this.topic(flush.topic);
    const seq = flush.seq;

    if (seq <= t.lastAppliedSeq) {
      return { applied: false, reason: 'duplicate' };
    }

    if (seq === t.lastAppliedSeq + 1) {
      this.commit(t, flush);
      // Drain any held flushes that are now contiguous.
      let next = t.lastAppliedSeq + 1;
      while (t.held.has(next)) {
        const h = t.held.get(next)!;
        t.held.delete(next);
        this.commit(t, h);
        next = t.lastAppliedSeq + 1;
      }
      return { applied: true, reason: 'applied' };
    }

    // seq > lastAppliedSeq + 1 → there's a gap. Check whether the earliest held
    // gap has timed out; if so, declare unfillable, discard held, and treat this
    // flush's predecessor chain as the new contiguous baseline.
    const evicted = this.evictTimedOutGaps(t);
    if (evicted) {
      // After discarding the unfillable gap, accept this flush as the new
      // baseline (we proceed with the last contiguous sequence == this one).
      t.lastAppliedSeq = seq - 1;
      this.commit(t, flush);
      return { applied: true, reason: 'gap-discarded-then-applied' };
    }

    // Hold it for the out-of-order window.
    if (!t.held.has(seq)) {
      t.held.set(seq, { ...flush, heldAtMs: this.now() });
    }
    return { applied: false, reason: 'held-out-of-order' };
  }

  /** Discard held flushes whose gap has exceeded the out-of-order timeout. */
  private evictTimedOutGaps(t: TopicState): boolean {
    if (t.held.size === 0) return false;
    const oldestHeldAt = Math.min(...[...t.held.values()].map((h) => h.heldAtMs));
    if (this.now() - oldestHeldAt > this.cfg.outOfOrderTimeoutMs) {
      this.log(`gap unfillable after ${this.cfg.outOfOrderTimeoutMs}ms — discarding ${t.held.size} held flush(es)`);
      t.held.clear();
      return true;
    }
    return false;
  }

  /** A periodic tick the caller invokes to time out gaps even without new flushes. */
  tick(topic: string): void {
    const t = this.topics.get(topic);
    if (t) this.evictTimedOutGaps(t);
  }

  private commit(t: TopicState, flush: LiveTailFlush): void {
    const bytes = flush.bytes ?? Buffer.byteLength(flush.content);
    t.applied.push({ ...flush });
    t.bytes += bytes;
    t.lastAppliedSeq = flush.seq;
    // Enforce the per-topic byte cap (drop-oldest).
    while (t.bytes > this.cfg.maxBytesPerTopic && t.applied.length > 1) {
      const dropped = t.applied.shift()!;
      t.bytes -= dropped.bytes ?? Buffer.byteLength(dropped.content);
    }
  }

  /** The resumable tail for a topic (the contiguous applied content). */
  getTail(topic: string): { lastAppliedSeq: number; content: string } {
    const t = this.topics.get(topic);
    if (!t) return { lastAppliedSeq: 0, content: '' };
    return { lastAppliedSeq: t.lastAppliedSeq, content: t.applied.map((f) => f.content).join('') };
  }

  getLastAppliedSeq(topic: string): number {
    return this.topics.get(topic)?.lastAppliedSeq ?? 0;
  }

  heldCount(topic: string): number {
    return this.topics.get(topic)?.held.size ?? 0;
  }
}
