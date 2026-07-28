import type { TurnEvidence } from './TurnEvidence.js';
import type { ClaimClauseArbitration } from './ClaimClauseArbiter.js';
import type { ClaimObservationContext, CompletionEnqueueResult } from './CompletionClaimVerifier.js';

interface AdmissionItem {
  message: string;
  evidence: TurnEvidence;
  onArbitrated?: (arbitration: ClaimClauseArbitration) => void | Promise<void>;
  context: ClaimObservationContext;
  enqueuedAt: number;
}

/** The single feature-ingress owner for dedupe, fairness, caps, and expiry. */
export class ClaimObservationAdmissionQueue {
  private worker?: (item: AdmissionItem) => Promise<void>;
  private queued = 0;
  private active = 0;
  private cursor = 0;
  private readonly activeTopics = new Set<string>();
  private readonly topicQueued = new Map<string, number>();
  private readonly pending = new Map<string, AdmissionItem[]>();
  private readonly recent = new Map<string, number>();
  private readonly attempts = new Map<string, { fingerprint: string; at: number; result: CompletionEnqueueResult }>();
  private readonly topicAdmissions: Array<{ at: number; topic: string }> = [];

  constructor(private readonly opts: { maxQueued?: number; maxQueuedPerTopic?: number; maxConcurrent?: number;
    queueTtlMs?: number; now?: () => number } = {}) {}

  setWorker(worker: (item: AdmissionItem) => Promise<void>): void { this.worker = worker; }

  enqueue(item: Omit<AdmissionItem, 'enqueuedAt'>, fingerprint: string): CompletionEnqueueResult {
    if (!this.worker) return { accepted: false, reason: 'queue-unwired' };
    const now = this.opts.now?.() ?? Date.now();
    for (const [key, seenAt] of this.recent) if (now - seenAt > 60_000) this.recent.delete(key);
    for (const [key, prior] of this.attempts) if (now - prior.at > 120_000) this.attempts.delete(key);
    const attemptId = item.context.messageAttemptId;
    if (attemptId) {
      const prior = this.attempts.get(attemptId);
      if (prior) return prior.fingerprint === fingerprint ? prior.result : { accepted: false, reason: 'attempt-id-collision' };
    }
    if (this.recent.has(fingerprint)) return { accepted: false, reason: 'duplicate' };
    const topic = item.context.topicId === undefined ? 'unbound' : String(item.context.topicId);
    while (this.topicAdmissions[0] && now - this.topicAdmissions[0].at > 3_600_000) this.topicAdmissions.shift();
    if (this.topicAdmissions.filter((row) => row.topic === topic).length >= 30) return { accepted: false, reason: 'rate-limit-exhausted' };
    if ((this.topicQueued.get(topic) ?? 0) >= (this.opts.maxQueuedPerTopic ?? 8)) return this.remember(attemptId, fingerprint, now, { accepted: false, reason: 'topic-queue-full' });
    if (this.queued >= (this.opts.maxQueued ?? 128)) return this.remember(attemptId, fingerprint, now, { accepted: false, reason: 'queue-full' });
    this.topicAdmissions.push({ at: now, topic });
    this.recent.set(fingerprint, now);
    this.queued++;
    this.topicQueued.set(topic, (this.topicQueued.get(topic) ?? 0) + 1);
    const queue = this.pending.get(topic) ?? [];
    queue.push({ ...item, enqueuedAt: now });
    this.pending.set(topic, queue);
    setImmediate(() => this.drain());
    return this.remember(attemptId, fingerprint, now, { accepted: true });
  }

  private remember(id: string | undefined, fingerprint: string, at: number, result: CompletionEnqueueResult): CompletionEnqueueResult {
    if (id) this.attempts.set(id, { fingerprint, at, result });
    return result;
  }

  private drain(): void {
    while (this.active < (this.opts.maxConcurrent ?? 4)) {
      const topics = [...this.pending.keys()].filter((topic) => !this.activeTopics.has(topic) && (this.pending.get(topic)?.length ?? 0) > 0);
      if (!topics.length) return;
      const topic = topics[this.cursor++ % topics.length];
      const queue = this.pending.get(topic)!;
      let item = queue.shift();
      while (item && (this.opts.now?.() ?? Date.now()) - item.enqueuedAt > (this.opts.queueTtlMs ?? 120_000)) {
        this.release(topic); item = queue.shift();
      }
      if (!queue.length) this.pending.delete(topic);
      if (!item) continue;
      this.active++; this.activeTopics.add(topic);
      void this.worker!(item).finally(() => { this.active--; this.activeTopics.delete(topic); this.release(topic); this.drain(); });
    }
  }

  private release(topic: string): void {
    this.queued = Math.max(0, this.queued - 1);
    const next = Math.max(0, (this.topicQueued.get(topic) ?? 1) - 1);
    if (next) this.topicQueued.set(topic, next); else this.topicQueued.delete(topic);
  }
}
