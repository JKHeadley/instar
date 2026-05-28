/**
 * LiveTailSource — the HOLDER-side flush producer (spec §8 G3b). Tracks, per
 * active topic, what conversation content has already been streamed to the
 * standby, and emits the NEW suffix as a monotonic-sequence flush via the
 * live-tail transport. The standby's LiveTailBuffer appends each flush's content
 * contiguously (applies only lastAppliedSeq+1), so the source MUST send deltas,
 * not the full tail — this class owns that delta accounting.
 *
 * Two drivers:
 *   - cadence (liveTailPushRateMs): pushTick() flushes any topic with new content,
 *     keeping the standby's persisted copy fresh to within liveTailMaxStalenessMs.
 *   - handoff: flushTopic()/flushAll() force a flush and return the resulting per-
 *     topic sequence numbers so HandoffSentinel can build the manifest the incoming
 *     machine must echo.
 *
 * The content provider (getTopicContent) and the transport are injected, so this
 * is unit-testable without a network or a live message store, and so the same
 * producer works for any channel (Telegram, Slack) — the source is channel-
 * agnostic; only the content provider differs.
 */

export interface LiveTailSourceDeps {
  /** The holder's full current tail content for a topic (caller resolves it). */
  getTopicContent: (topic: string) => string;
  /** Topics with live conversation worth streaming to the standby. */
  activeTopics: () => string[];
  /** The wire — redacts + encrypts + posts to the standby (HttpLiveTailTransport). */
  transport: {
    broadcast: (flush: { topic: string; seq: number; content: string }) => Promise<boolean>;
  };
  logger?: (msg: string) => void;
}

export interface FlushOutcome {
  topic: string;
  /** The per-topic sequence of the flush that was sent (or the current high-water if none). */
  seq: number;
  /** Whether new content was actually flushed (false = nothing new). */
  flushed: boolean;
}

export class LiveTailSource {
  private readonly d: LiveTailSourceDeps;
  /** Per-topic content already streamed (the prefix the standby has). */
  private streamed = new Map<string, string>();
  /** Per-topic monotonic sequence (matches the standby's applied seq). */
  private seq = new Map<string, number>();

  constructor(deps: LiveTailSourceDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[live-tail-source] ${m}`);
  }

  /** Current high-water sequence for a topic (for the handoff manifest). */
  currentSeq(topic: string): number {
    return this.seq.get(topic) ?? 0;
  }

  /**
   * Flush the NEW suffix of a topic's content (the delta since the last flush).
   * If the content shrank or diverged from what we streamed (e.g. a history
   * rewrite), we resend the whole content as a fresh delta. No new content → no
   * flush, no sequence bump (so duplicate ticks don't inflate the standby's seq).
   */
  async flushTopic(topic: string): Promise<FlushOutcome> {
    const full = this.d.getTopicContent(topic) ?? '';
    const prior = this.streamed.get(topic) ?? '';

    let delta: string;
    if (full === prior) {
      return { topic, seq: this.currentSeq(topic), flushed: false };
    }
    if (full.startsWith(prior)) {
      delta = full.slice(prior.length);
    } else {
      // Divergence (history rewrite/compaction) — resend the full content.
      this.log(`topic ${topic} content diverged from streamed prefix — resending full tail`);
      delta = full;
    }
    if (delta.length === 0) {
      return { topic, seq: this.currentSeq(topic), flushed: false };
    }

    const nextSeq = this.currentSeq(topic) + 1;
    const ok = await this.d.transport.broadcast({ topic, seq: nextSeq, content: delta });
    if (!ok) {
      // The standby was unreachable — do NOT advance our streamed/seq state, so
      // the next tick retries the same delta (the buffer dedups on seq anyway).
      this.log(`flush of topic ${topic} seq ${nextSeq} not acknowledged — will retry`);
      return { topic, seq: this.currentSeq(topic), flushed: false };
    }
    this.seq.set(topic, nextSeq);
    this.streamed.set(topic, full);
    return { topic, seq: nextSeq, flushed: true };
  }

  /** Flush every active topic; returns each topic's outcome (used by the handoff). */
  async flushAll(): Promise<FlushOutcome[]> {
    const outcomes: FlushOutcome[] = [];
    for (const topic of this.d.activeTopics()) {
      outcomes.push(await this.flushTopic(topic));
    }
    return outcomes;
  }

  /** The cadence driver — flush whatever has new content. Returns count actually flushed. */
  async pushTick(): Promise<number> {
    const outcomes = await this.flushAll();
    return outcomes.filter((o) => o.flushed).length;
  }
}
