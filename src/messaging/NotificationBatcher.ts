/**
 * NotificationBatcher - Batches non-critical Telegram notifications into periodic digests.
 *
 * Classifies notifications into three tiers:
 * - IMMEDIATE: Sent instantly (stall alerts, triage, quota warnings)
 * - SUMMARY: Batched every 30 min (job completions, attention items, session lifecycle)
 * - DIGEST: Batched every 2 hours (routine system notices)
 *
 * Born from: Matthew Berman OpenClaw analysis (2026-02-25)
 *
 * Bounded-surface additions (docs/specs/bounded-attention-notification-surface.md):
 * the batched lane honours `enabled`, persists its suppression + rate-limit state,
 * and is bounded by a rolling-window limit enforced ONLY by the machine that owns
 * the topic. IMMEDIATE never enters that machinery.
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireDeliverySink, reportDeliverySinkFailure } from './DeliverySinkFailure.js';

export type NotificationTier = 'IMMEDIATE' | 'SUMMARY' | 'DIGEST';

/**
 * Verdict from the pool's placement record for one topic.
 * `unresolvable-no-pool` is a single-machine install: this machine is trivially
 * the owner. `unresolvable-pool` means a pool exists but placement could not be
 * read — the batched lane HOLDS there, so two machines can never both emit.
 */
export type OwnershipVerdict = 'owner' | 'other' | 'unresolvable-no-pool' | 'unresolvable-pool';

export type OwnershipResolver = (topicId: number) => OwnershipVerdict;

export interface BatchedNotification {
  tier: NotificationTier;
  category: string;
  message: string;
  timestamp: Date;
  topicId: number;
}

export interface BatcherQuietHours {
  enabled: boolean;
  start: string;   // "HH:MM"
  end: string;     // "HH:MM"
}

export interface BatcherConfig {
  enabled: boolean;
  summaryIntervalMinutes: number;
  digestIntervalMinutes: number;
  /** Rolling-window limit per topic. 0 disables the limiter entirely. */
  maxMessagesPerTopicPerHour: number;
  /** TTL on cross-batch suppression entries. */
  suppressionTtlHours: number;
  /**
   * A topic blocked for a PERSISTENT reason (foreign ownership, unresolved
   * ownership, corrupt rate state) drops its backlog after this long, with an
   * audit row and a per-reason counter. Nothing is sent on that path — an
   * earlier design "collapsed" an aged hold into one digest, which was both
   * unreachable and forbidden for exactly those reasons.
   */
  maxHoldHours: number;
  /** Storage ceiling on the held queue; overflow folds oldest into a counted aggregate. */
  maxHeldItemsPerTopic: number;
  quietHours?: BatcherQuietHours;
}

interface QueuedNotification {
  category: string;
  message: string;
  timestamp: Date;
  topicId: number;
  dedupKey: string;
  count: number;
  /** Epoch ms this item was first held, or null while it has never been held. */
  heldSince: number | null;
  /** Count of older items folded into this one by the storage ceiling. */
  foldedCount?: number;
}

export interface BatcherStats {
  summaryQueueSize: number;
  digestQueueSize: number;
  totalFlushed: number;
  totalSuppressed: number;
  lastSummaryFlush: Date | null;
  lastDigestFlush: Date | null;
  /** Items currently held by the rolling-window limit or by ownership. */
  heldCount: number;
  /** Epoch ms of the oldest current hold, or null when nothing is held. */
  heldSince: number | null;
  /** Batched items not sent because another machine owns the topic. */
  notOwnerSkipped: number;
  /** Non-owner items that expired on maxHoldHours without ownership arriving. */
  notOwnerExpired: number;
  /** Items expired for a non-ownership reason (breaker active, or corrupt rate state). */
  heldExpired: number;
  /** Items folded into a counted aggregate by the storage ceiling. */
  foldedItems: number;
  /** Whether the persisted rate-limit state could be read. */
  rateStateReadable: boolean;
}

export type SendFunction = (topicId: number, text: string) => Promise<{ messageId: number }>;

const CATEGORY_HEADERS: Record<string, string> = {
  'job-complete': 'JOBS',
  'attention-update': 'ATTENTION',
  'session-lifecycle': 'SESSIONS',
  'quota': 'QUOTA',
  'system': 'SYSTEM',
};

const DEFAULT_CONFIG: BatcherConfig = {
  enabled: true,
  summaryIntervalMinutes: 30,
  digestIntervalMinutes: 120,
  maxMessagesPerTopicPerHour: 4,
  suppressionTtlHours: 24,
  maxHoldHours: 6,
  maxHeldItemsPerTopic: 200,
};

const WINDOW_MS = 3_600_000;

interface PersistedState {
  /** dedupKey → epoch ms it was sent. Replaces the old value-is-the-key scheme. */
  suppression: Record<string, number>;
  /** topicId → epoch ms of sends inside the rolling window. */
  sendTimes: Record<string, number[]>;
}

export class NotificationBatcher {
  private summaryQueue: QueuedNotification[] = [];
  private digestQueue: QueuedNotification[] = [];
  private sendFn: SendFunction | null = null;
  private config: BatcherConfig;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastSummaryFlush: Date | null = null;
  private lastDigestFlush: Date | null = null;
  private totalFlushed = 0;
  private suppressedCount = 0;

  // ── Bounded-surface state ────────────────────────────────────
  private stateDir: string | null = null;
  private ownershipResolver: OwnershipResolver | null = null;
  private auditPath: string | null = null;

  /** dedupKey → epoch ms sent. Persisted; TTL-expired on load and on write. */
  private lastSentContent: Map<string, number> = new Map();
  /** topicId → epoch ms of sends within the rolling window. Persisted. */
  private sendTimes: Map<number, number[]> = new Map();

  /**
   * FALSE when the persisted rate-limit state could not be read. The batched
   * lane HOLDS while this is false: losing sendTimes would mint fresh capacity,
   * which is the exact ceiling-bypass this class exists to prevent. The
   * suppression map fails the opposite way (see loadState).
   */
  private rateStateReadable = true;

  private notOwnerSkipped = 0;
  private notOwnerExpired = 0;
  /** Items expired by maxHoldHours for a NON-ownership reason (breaker / corrupt rate state). */
  private heldExpired = 0;
  private foldedItems = 0;

  constructor(config?: Partial<BatcherConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setSendFunction(sendFn: SendFunction): void {
    this.sendFn = sendFn;
  }

  /**
   * Wire durable state and the ownership source. Called once at startup.
   * Absent stateDir keeps the pre-existing in-memory-only behaviour, so tests
   * and embedders that never call this are unaffected.
   */
  configureBounds(opts: { stateDir?: string | null; ownershipResolver?: OwnershipResolver | null }): void {
    this.stateDir = opts.stateDir ?? null;
    this.ownershipResolver = opts.ownershipResolver ?? null;
    this.auditPath = this.stateDir ? path.join(this.stateDir, 'notification-ceiling.jsonl') : null;
    if (this.stateDir) this.loadState();
  }

  start(): void {
    if (this.flushTimer) return;

    const now = new Date();
    this.lastSummaryFlush = now;
    this.lastDigestFlush = now;

    this.flushTimer = setInterval(() => this.checkFlush(), 60_000);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async enqueue(notification: BatchedNotification): Promise<void> {
    let effectiveTier = notification.tier;

    // Quiet hours: demote SUMMARY to DIGEST
    if (effectiveTier === 'SUMMARY' && this.isQuietHours()) {
      effectiveTier = 'DIGEST';
    }

    // IMMEDIATE bypasses every gate in this class — the `enabled` kill-switch,
    // the rolling-window limit, ownership, and the brakes. A kill-switch on
    // batching must never become a kill-switch on urgency.
    if (effectiveTier === 'IMMEDIATE') {
      await this.sendDirect(notification.topicId, notification.message);
      return;
    }

    // C2: honour the previously-dead `enabled` flag, batched tiers only.
    if (!this.config.enabled) {
      this.suppressedCount++;
      return;
    }

    const dedupKey = this.generateDedupKey(notification.category, notification.message);
    const queue = effectiveTier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;

    // Cross-batch suppression: an unexpired entry means this exact shape was
    // already DELIVERED (the map is written after a successful flush, so
    // presence follows delivery rather than intent).
    const crossBatchKey = `${notification.topicId}:${dedupKey}`;
    const sentAt = this.lastSentContent.get(crossBatchKey);
    if (sentAt !== undefined && Date.now() - sentAt < this.config.suppressionTtlHours * 3_600_000) {
      this.suppressedCount++;
      return;
    }

    // Within-batch dedup: collapse identical shapes into one entry with count
    const existing = queue.find(q => q.dedupKey === dedupKey && q.topicId === notification.topicId);
    if (existing) {
      existing.count++;
      existing.timestamp = notification.timestamp; // Update to latest
      return;
    }

    queue.push({
      category: notification.category,
      message: notification.message,
      timestamp: notification.timestamp,
      topicId: notification.topicId,
      dedupKey,
      count: 1,
      heldSince: null,
    });

    this.enforceStorageCeiling(queue, notification.topicId);
  }

  async flushAll(): Promise<number> {
    let flushed = 0;
    flushed += await this.flush('SUMMARY');
    flushed += await this.flush('DIGEST');
    return flushed;
  }

  async flush(tier: 'SUMMARY' | 'DIGEST'): Promise<number> {
    const queue = tier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;
    if (queue.length === 0) return 0;

    const tierLabel = tier === 'SUMMARY' ? 'Summary' : 'Digest';
    const now = Date.now();

    // Group by topicId WITHOUT removing from the queue — items for a topic that
    // cannot send stay queued and release themselves at the next opportunity.
    const byTopic = new Map<number, QueuedNotification[]>();
    for (const item of queue) {
      const existing = byTopic.get(item.topicId) || [];
      existing.push(item);
      byTopic.set(item.topicId, existing);
    }

    let sentCount = 0;

    for (const [topicId, topicItems] of byTopic) {
      const decision = this.canSendToTopic(topicId, now, tier);

      if (decision.verdict !== 'send') {
        this.markHeld(topicItems, now);
        this.expireStaleHolds(topicId, topicItems, now, decision.reason);
        this.audit({ event: 'held', topicId, reason: decision.reason, items: topicItems.length });
        continue;
      }

      const digestMessage = this.formatDigest(tierLabel, topicItems);
      const delivered = await this.sendDirect(topicId, digestMessage);

      if (!delivered) {
        // NOT delivered ⇒ nothing is dequeued, nothing is suppressed, and no
        // rate-limit slot is consumed. The items stay queued and retry.
        this.markHeld(topicItems, now);
        this.audit({ event: 'send-failed', topicId, items: topicItems.length });
        continue;
      }

      // Remove the sent items from the live queue.
      for (const item of topicItems) {
        const idx = queue.indexOf(item);
        if (idx !== -1) queue.splice(idx, 1);
      }

      // Record delivery for cross-batch suppression + the rolling window.
      // Reached ONLY on a confirmed send, so presence follows delivery.
      for (const item of topicItems) {
        this.lastSentContent.set(`${topicId}:${item.dedupKey}`, now);
      }
      this.recordSend(topicId, now);
      sentCount += topicItems.length;
    }

    this.totalFlushed += sentCount;
    this.persistState();

    if (tier === 'SUMMARY') {
      this.lastSummaryFlush = new Date();
    } else {
      this.lastDigestFlush = new Date();
    }

    return sentCount;
  }

  getQueueSize(): { summary: number; digest: number } {
    return {
      summary: this.summaryQueue.length,
      digest: this.digestQueue.length,
    };
  }

  getStats(): BatcherStats {
    const all = [...this.summaryQueue, ...this.digestQueue];
    const held = all.filter(q => q.heldSince !== null);
    const heldSince = held.length ? Math.min(...held.map(q => q.heldSince as number)) : null;
    return {
      summaryQueueSize: this.summaryQueue.length,
      digestQueueSize: this.digestQueue.length,
      totalFlushed: this.totalFlushed,
      totalSuppressed: this.suppressedCount,
      lastSummaryFlush: this.lastSummaryFlush,
      lastDigestFlush: this.lastDigestFlush,
      heldCount: held.length,
      heldSince,
      notOwnerSkipped: this.notOwnerSkipped,
      notOwnerExpired: this.notOwnerExpired,
      heldExpired: this.heldExpired,
      foldedItems: this.foldedItems,
      rateStateReadable: this.rateStateReadable,
    };
  }

  /**
   * Clear the cross-batch suppression memory for a specific key or all keys.
   * Use when you know state has changed and want to force re-notification.
   */
  clearSuppression(dedupKey?: string): void {
    if (dedupKey) {
      for (const key of this.lastSentContent.keys()) {
        if (key.endsWith(`:${dedupKey}`)) {
          this.lastSentContent.delete(key);
        }
      }
    } else {
      this.lastSentContent.clear();
    }
    this.persistState();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── Rolling-window limit + ownership ─────────────────────────

  /**
   * The single send decision. Deliberately content-blind: it never reads a
   * message, so it cannot mis-judge one. See the spec's §Signal vs authority.
   */
  private canSendToTopic(
    topicId: number,
    now: number,
    tier: 'SUMMARY' | 'DIGEST',
  ): { verdict: 'send' | 'hold'; reason: string } {
    // `0` disables the limiter entirely. This guard is FIRST and load-bearing:
    // without it `sendTimes.length >= 0` is always true and 0 would hold every
    // message forever — the opposite of the documented meaning.
    if (this.config.maxMessagesPerTopicPerHour === 0) return { verdict: 'send', reason: 'limiter-disabled' };

    // Rate state unreadable ⇒ hold. Losing sendTimes would mint fresh capacity.
    if (!this.rateStateReadable) return { verdict: 'hold', reason: 'rate-state-unreadable' };


    const ownership = this.resolveOwnership(topicId);
    if (ownership === 'other') {
      this.notOwnerSkipped++;
      return { verdict: 'hold', reason: 'not-owner' };
    }
    if (ownership === 'unresolvable-pool') {
      return { verdict: 'hold', reason: 'ownership-unresolved' };
    }

    const times = (this.sendTimes.get(topicId) ?? []).filter(t => now - t < WINDOW_MS);
    this.sendTimes.set(topicId, times);
    if (times.length >= this.config.maxMessagesPerTopicPerHour) {
      return { verdict: 'hold', reason: 'rate-limited' };
    }

    return { verdict: 'send', reason: 'ok' };
  }

  private resolveOwnership(topicId: number): OwnershipVerdict {
    if (!this.ownershipResolver) return 'unresolvable-no-pool';
    try {
      return this.ownershipResolver(topicId);
    } catch {
      // A throwing resolver is an unreadable placement record on a machine that
      // HAS a pool wired — hold rather than assume ownership.
      return 'unresolvable-pool';
    }
  }

  private recordSend(topicId: number, now: number): void {
    const times = (this.sendTimes.get(topicId) ?? []).filter(t => now - t < WINDOW_MS);
    times.push(now);
    this.sendTimes.set(topicId, times);
  }

  private markHeld(items: QueuedNotification[], now: number): void {
    for (const item of items) if (item.heldSince === null) item.heldSince = now;
  }

  /**
   * maxHoldHours EXPIRY. Returns false always — there is no collapse-to-send.
   *
   * An earlier revision converted an aged hold into "one digest sent anyway",
   * with a breaker counting three such collapses. Writing the test for it showed
   * the path was UNREACHABLE: the rolling window is 1h and maxHoldHours is 6h,
   * so a rate-limit hold always drains when its window clears, hours before it
   * could mature. The only holds that DO persist that long are the ones whose
   * reason persists — foreign ownership, unresolved ownership, corrupt rate
   * state — and every one of those must never age into a send (that is the
   * fail-closed rule). So the collapse fired for nothing, and the breaker that
   * counted collapses could never trip.
   *
   * The spec claimed both as brakes. They were removed rather than repaired:
   * a documented brake that cannot fire is worse than no brake, because a
   * reader (including a future audit) records it as protection that exists.
   *
   * What remains is honest and load-bearing: a topic blocked for a PERSISTENT
   * reason drops its backlog after maxHoldHours with an audit row, so the queue
   * has a terminal state. Bounded size is carried by the storage ceiling.
   */
  private expireStaleHolds(
    topicId: number,
    items: QueuedNotification[],
    now: number,
    reason: string,
  ): boolean {
    const oldest = items.reduce<number | null>(
      (acc, i) => (i.heldSince !== null && (acc === null || i.heldSince < acc) ? i.heldSince : acc),
      null,
    );
    if (oldest === null || now - oldest < this.config.maxHoldHours * 3_600_000) return false;

    // Counted separately per reason: folding a corrupt-state hold into
    // `notOwnerSkipped` would tell an operator another machine had the topic —
    // a different, more reassuring story than the truth. A counter that answers
    // the wrong question is worse than no counter.
    if (reason === 'not-owner' || reason === 'ownership-unresolved') {
      this.notOwnerExpired += items.length;
    } else {
      this.heldExpired += items.length;
    }

    for (const item of items) {
      const q = this.summaryQueue.indexOf(item) !== -1 ? this.summaryQueue : this.digestQueue;
      const idx = q.indexOf(item);
      if (idx !== -1) q.splice(idx, 1);
    }
    this.audit({ event: 'hold-expired', topicId, reason, items: items.length });
    return false;
  }

  /**
   * Storage ceiling. Dedup bounds REPEATS, not VARIETY — a stream of
   * structurally distinct notices coalesces to nothing and would grow without
   * bound. Overflow folds the OLDEST entries into one counted aggregate.
   */
  private enforceStorageCeiling(queue: QueuedNotification[], topicId: number): void {
    const forTopic = queue.filter(q => q.topicId === topicId);
    if (forTopic.length <= this.config.maxHeldItemsPerTopic) return;

    const overflow = forTopic.length - this.config.maxHeldItemsPerTopic;
    const oldest = forTopic.slice(0, overflow + 1);
    const folded = oldest.reduce((n, i) => n + i.count + (i.foldedCount ?? 0), 0);

    for (const item of oldest) {
      const idx = queue.indexOf(item);
      if (idx !== -1) queue.splice(idx, 1);
    }
    this.foldedItems += folded;

    queue.unshift({
      category: 'system',
      message: `+${folded} earlier notices`,
      timestamp: oldest[oldest.length - 1].timestamp,
      topicId,
      dedupKey: `${topicId}:__folded__`,
      count: 1,
      heldSince: oldest[0].heldSince,
      foldedCount: folded,
    });
    this.audit({ event: 'folded', topicId, items: folded });
  }

  // ── Persistence ──────────────────────────────────────────────

  private statePath(): string | null {
    return this.stateDir ? path.join(this.stateDir, 'notification-suppression.json') : null;
  }

  /**
   * The two persisted states fail in OPPOSITE directions, deliberately:
   * suppression unreadable ⇒ empty map ⇒ send (at most a duplicate);
   * rate state unreadable ⇒ hold the batched lane (losing it would mint capacity).
   */
  private loadState(): void {
    const p = this.statePath();
    if (!p) return;
    if (!fs.existsSync(p)) {
      this.rateStateReadable = true; // no file yet is not "unreadable"
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as PersistedState;
      const now = Date.now();
      const ttl = this.config.suppressionTtlHours * 3_600_000;

      this.lastSentContent = new Map(
        Object.entries(raw.suppression ?? {}).filter(([, at]) => now - at < ttl),
      );
      this.sendTimes = new Map(
        Object.entries(raw.sendTimes ?? {}).map(([k, v]) => [
          Number(k),
          (v ?? []).filter(t => now - t < WINDOW_MS),
        ]),
      );
      this.rateStateReadable = true;
    } catch {
      // Suppression fails OPEN (empty map, we may repeat).
      this.lastSentContent = new Map();
      // Rate state fails CLOSED — hold until a clean write replaces the file.
      this.sendTimes = new Map();
      this.rateStateReadable = false;
      this.audit({ event: 'state-unreadable', topicId: 0, reason: 'parse-failed' });
      // Visible OUTSIDE this component. With C1 defaulting degradation alerts
      // off, a batched lane that is quietly holding everything would otherwise be
      // invisible except in a local JSONL nobody reads — "the bounding works, and
      // hides that the bounding path is unhealthy" (Phase 5 re-review finding 2).
      // console.warn reaches logs/server.log, and `rateStateReadable` is carried
      // on getStats() into the telemetry collector, so both a human tail and the
      // metrics surface can see it. Deliberately NOT a user message: it is not
      // something the operator can act on, and adding one would violate the very
      // discipline this change establishes.
      console.warn(
        '[NotificationBatcher] rate-limit state unreadable — the batched lane is HOLDING ' +
        'until this process restarts. Urgent notices are unaffected.',
      );
    }
  }

  private persistState(): void {
    const p = this.statePath();
    if (!p) return;
    const now = Date.now();
    const ttl = this.config.suppressionTtlHours * 3_600_000;
    const payload: PersistedState = {
      suppression: Object.fromEntries(
        [...this.lastSentContent.entries()].filter(([, at]) => now - at < ttl),
      ),
      sendTimes: Object.fromEntries(
        [...this.sendTimes.entries()].map(([k, v]) => [String(k), v.filter(t => now - t < WINDOW_MS)]),
      ),
    };
    try {
      fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
      // Deliberately does NOT clear `rateStateReadable`. An earlier revision did,
      // reasoning that a good write means coherent state — but the state being
      // written is the EMPTY map we failed to load, so clearing the flag turned
      // corrupt state into minted capacity within the same process. The flag
      // latches for the process lifetime; recovery is a restart, which loads the
      // freshly-written valid file. That costs one window of extra capacity once,
      // after a restart, which is bounded and honest.
    } catch {
      // @silent-fallback-ok — self-referential. Reporting a degradation here
      // would route through notify() → this same batcher → persistState(), i.e.
      // a failure loop in the component whose whole purpose is bounding message
      // volume. The consequence is bounded and safe: the state simply does not
      // survive a restart, and `rateStateReadable` already latches false on the
      // load side, so a lost write degrades toward HOLDING rather than sending.
    }
  }

  /** Metadata-only audit row. Never carries message content. */
  private audit(row: { event: string; topicId: number; reason?: string; items?: number }): void {
    if (!this.auditPath) return;
    try {
      fs.appendFileSync(this.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n', 'utf8');
    } catch {
      // @silent-fallback-ok — self-referential, same reasoning as persistState():
      // this is the audit sink for the notification path, so reporting its own
      // failure through the notification path is a loop. A lost audit row costs
      // observability of one hold, never a delivery decision.
    }
  }

  formatDigest(_tierLabel: string, items: QueuedNotification[]): string {
    const lines: string[] = [];

    // Sort all items by timestamp
    const sortedItems = [...items].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );

    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];
      const cleanMessage = item.message.replace(/<[^>]+>/g, '').trim();
      const suffix = item.count > 1 ? ` (×${item.count})` : '';

      if (suffix) {
        lines.push(`${cleanMessage}${suffix}`);
      } else {
        lines.push(cleanMessage);
      }

      // Add separator between items
      if (i < sortedItems.length - 1) {
        lines.push('');
      }
    }

    return lines.join('\n').trimEnd();
  }

  /**
   * Epoch ms when the CURRENT quiet-hours window ends, or null when quiet
   * hours are disabled / not currently active. The single quiet-hours
   * definition shared with the reap-notice release-hold computation
   * (reap-notify spec R1.5) — one clock, not two.
   */
  quietHoursEndAt(nowMs: number = Date.now()): number | null {
    if (!this.config.quietHours?.enabled) return null;
    const now = new Date(nowMs);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = this.config.quietHours.start.split(':').map(Number);
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const inWindow =
      startMinutes > endMinutes
        ? currentMinutes >= startMinutes || currentMinutes < endMinutes
        : currentMinutes >= startMinutes && currentMinutes < endMinutes;
    if (!inWindow) return null;
    const end = new Date(nowMs);
    end.setHours(endH, endM, 0, 0);
    if (end.getTime() <= nowMs) end.setDate(end.getDate() + 1);
    return end.getTime();
  }

  /**
   * Epoch ms of the next SUMMARY-window flush (≤ one interval out). Used as
   * the SUMMARY-tier release hold for durable reap notices (R1.5).
   */
  nextSummaryReleaseAt(nowMs: number = Date.now()): number {
    const intervalMs = this.config.summaryIntervalMinutes * 60_000;
    const last = this.lastSummaryFlush?.getTime() ?? nowMs;
    const next = last + intervalMs;
    return next > nowMs ? next : nowMs + intervalMs;
  }

  isQuietHours(): boolean {
    if (!this.config.quietHours?.enabled) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = this.config.quietHours.start.split(':').map(Number);
    const [endH, endM] = this.config.quietHours.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * Generate a stable dedup key from category + message content.
   * Strips variable parts (PIDs, memory values, timestamps, durations)
   * so structurally identical notifications collapse.
   */
  private generateDedupKey(category: string, message: string): string {
    const firstLine = message.split('\n').find(l => l.trim().length > 0) || message;
    const normalized = firstLine
      .replace(/PID \d+/g, 'PID _')
      .replace(/\d+MB/g, '_MB')
      .replace(/\d+KB/g, '_KB')
      .replace(/\d+h \d+m/g, '_dur')
      .replace(/\d+m/g, '_dur')
      .replace(/\d+d \d+h/g, '_dur')
      .replace(/v[\d.]+/g, 'v_')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g, '_ts')
      .replace(/\d+/g, '_')
      .toLowerCase()
      .trim();
    return `${category}:${normalized}`;
  }

  /**
   * Returns TRUE only on a CONFIRMED delivery. The caller uses that to decide
   * whether to dequeue, write suppression, and consume a rate-limit slot.
   *
   * An earlier revision returned void and the caller treated every attempt as a
   * delivery: a failed Telegram send dropped the item AND suppressed it for 24h.
   * That is silent loss, and it contradicted this class's own invariant that
   * suppression-presence follows DELIVERY rather than intent. Caught by the
   * Phase 5 second-pass review.
   */
  private async sendDirect(topicId: number, message: string): Promise<boolean> {
    if (!requireDeliverySink(this.sendFn, {
      component: 'NotificationBatcher',
      primary: 'Deliver queued and immediate notifications through the configured messaging sink',
      reason: `No delivery sink is configured for topic ${topicId}`,
      impact: 'A notification was not delivered; startup composition or messaging configuration is incomplete',
    })) return false;

    try {
      await this.sendFn!(topicId, message);
      return true;
    } catch (err) {
      // @silent-fallback-ok — NOT silent: reportDeliverySinkFailure() funnels to
      // DegradationReporter, so the failure is reported, audited, and (since the
      // Phase 5 fix) returns false so the caller neither dequeues nor suppresses
      // the item. The ratchet flags this only because its heuristic greps the
      // literal string "DegradationReporter" inside the catch and the added
      // `return false` matches its default-value pattern.
      // Keep batching non-throwing, but never treat a failed send as silence.
      reportDeliverySinkFailure({
        component: 'NotificationBatcher',
        primary: 'Deliver queued and immediate notifications through the configured messaging sink',
        reason: `Configured sink failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'A notification was not delivered; the queue remains observable through degradation state',
      });
      return false;
    }
  }

  private async checkFlush(): Promise<void> {
    const now = new Date();

    if (this.lastSummaryFlush) {
      const elapsed = now.getTime() - this.lastSummaryFlush.getTime();
      if (elapsed >= this.config.summaryIntervalMinutes * 60_000 && this.summaryQueue.length > 0) {
        await this.flush('SUMMARY');
      }
    }

    if (this.lastDigestFlush) {
      const elapsed = now.getTime() - this.lastDigestFlush.getTime();
      if (elapsed >= this.config.digestIntervalMinutes * 60_000 && this.digestQueue.length > 0) {
        await this.flush('DIGEST');
      }
    }
  }
}
