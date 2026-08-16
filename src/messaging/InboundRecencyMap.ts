/**
 * InboundRecencyMap.ts — the §2.5 in-memory inbound recency map (Quiet by Default,
 * docs/specs/notification-selectivity.md).
 *
 * MessageStore queries are disk-backed and must never run inside the send funnel.
 * The selectivity gate reads ONLY this in-memory per-topic map, maintained on the
 * INBOUND path: for each topic, the last N=20 inbound user message ids with
 * timestamps, plus the current unanswered-message id. Memory-bounded: topics idle
 * longer than 7 days are LRU-evicted and the map caps at ~1,000 tracked topics.
 *
 * Cold-map semantics are the CALLER's (the gate's) responsibility per category
 * (§2.5 fail directions); this map only answers "have I seen this inbound?" and
 * reports whether it is cold (fresh process, nothing recorded yet).
 */

const MAX_TOPICS = 1000;
const MAX_INBOUND_PER_TOPIC = 20;
const IDLE_EVICT_MS = 7 * 24 * 60 * 60 * 1000;

interface TopicRecency {
  /** messageId → receivedAt epoch ms (insertion-ordered; oldest first). */
  inbound: Map<string, number>;
  /** The currently-unanswered inbound id (set on inbound, cleared on reply commit). */
  currentUnanswered?: string;
  lastTouched: number;
}

export class InboundRecencyMap {
  private topics = new Map<number, TopicRecency>();
  private everRecorded = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** True until the FIRST inbound is recorded in this process (§2.5 `mapCold`). */
  isCold(): boolean {
    return !this.everRecorded;
  }

  recordInbound(topicId: number, messageId: string | number): void {
    const id = String(messageId);
    const t = this.touch(topicId);
    t.inbound.delete(id);
    t.inbound.set(id, this.now());
    while (t.inbound.size > MAX_INBOUND_PER_TOPIC) {
      const oldest = t.inbound.keys().next().value;
      if (oldest === undefined) break;
      t.inbound.delete(oldest);
    }
    t.currentUnanswered = id;
    this.everRecorded = true;
    this.evictIfNeeded();
  }

  /** Reply committed for the topic — the unanswered pointer clears (the ids stay recent). */
  clearUnanswered(topicId: number): void {
    const t = this.topics.get(topicId);
    if (t) t.currentUnanswered = undefined;
  }

  /** Is this specific inbound id known AND within the window? */
  hasInbound(topicId: number, messageId: string | number, windowMs: number): boolean {
    const t = this.topics.get(topicId);
    if (!t) return false;
    const at = t.inbound.get(String(messageId));
    if (at === undefined) return false;
    return this.now() - at <= windowMs;
  }

  /** The currently-unanswered inbound id for the topic (presence-standby binding, §3.2). */
  currentUnanswered(topicId: number): string | undefined {
    return this.topics.get(topicId)?.currentUnanswered;
  }

  /** Any inbound recorded for the topic within the window (§2.2.4 advisory metric). */
  hasRecentInbound(topicId: number, windowMs: number): boolean {
    const t = this.topics.get(topicId);
    if (!t) return false;
    const nowMs = this.now();
    for (const at of t.inbound.values()) {
      if (nowMs - at <= windowMs) return true;
    }
    return false;
  }

  trackedTopicCount(): number {
    return this.topics.size;
  }

  private touch(topicId: number): TopicRecency {
    let t = this.topics.get(topicId);
    if (!t) {
      t = { inbound: new Map(), lastTouched: this.now() };
    } else {
      this.topics.delete(topicId);
    }
    t.lastTouched = this.now();
    this.topics.set(topicId, t); // re-insert = LRU refresh
    return t;
  }

  private evictIfNeeded(): void {
    const nowMs = this.now();
    for (const [topicId, t] of this.topics) {
      if (this.topics.size <= MAX_TOPICS && nowMs - t.lastTouched <= IDLE_EVICT_MS) break;
      if (nowMs - t.lastTouched > IDLE_EVICT_MS || this.topics.size > MAX_TOPICS) {
        this.topics.delete(topicId);
      }
    }
    while (this.topics.size > MAX_TOPICS) {
      const oldest = this.topics.keys().next().value;
      if (oldest === undefined) break;
      this.topics.delete(oldest);
    }
  }
}
