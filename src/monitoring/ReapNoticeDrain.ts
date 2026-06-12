/**
 * ReapNoticeDrain — the ALWAYS-ON delivery loop for reap notices
 * (reap-notify spec R1.3, tier0 supervision — deterministic delivery of
 * pre-authored template content, declared per P7).
 *
 * Why it exists: the durable layer's existing drain (DeliveryFailureSentinel)
 * is default-OFF fleet-wide, so "DFS will retry it" is false on a default
 * agent — the round-2 foundation audit's central finding. The R1 guarantee
 * ("every non-silent reap produces a durable, retried, recorded notice")
 * therefore ships its OWN small always-on drain, independent of the DFS flag.
 *
 * Contract:
 *  - Claims ONLY rows inside the `reap-notify:` PK range (index-compatible
 *    range predicate; DFS claims the complement). The claim itself is a CAS
 *    UPDATE — two drains can never double-claim a row.
 *  - 30s tick; idle cost is one indexed claim query (~zero on an empty store).
 *  - Per-pass send cap (15) keeps a 500-topic storm under Telegram's
 *    per-group rate: 500 durable rows drain over ~17 minutes (R1.5's global
 *    release throttle); the remainder is picked up next tick.
 *  - Delivery is the DIRECT adapter send (`sendToTopic`) — NOT the
 *    /telegram/reply relay — so the relay's tone gate, whoami check, and
 *    duplicate-suppression are structurally off this path (notices carry
 *    per-notice distinct content anyway).
 *  - Bounded retries: store-backed exponential backoff on the existing
 *    attempts/next_attempt_at columns; at `maxAttempts` (8) the row is
 *    escalated terminally into ONE aggregated attention item (updated in
 *    place — never per-row items; P17).
 *  - Outcome records (R1.3 pairs): the terminal record (`sent` /
 *    `send-failed-escalated`) is appended HERE, event-driven from the drain
 *    that owns the terminal transition.
 *  - Loop brakes (P19, declared): backoff + maxAttempts + per-pass cap +
 *    terminal escalation; plus a bounded terminal-row cleanup so the
 *    always-on lane cannot grow the store unboundedly while DFS's retention
 *    pass is off.
 */

import type { PendingRelayRow, DeliveryState } from '../messaging/pending-relay-store.js';
import { parseReapNotifyDeliveryId } from '../messaging/reap-notice-delivery-id.js';
import type { ReapNotifyOutcome } from './ReapLog.js';

export interface ReapNoticeDrainStore {
  selectClaimableReapNotices(nowIso: string, limit?: number): PendingRelayRow[];
  claimCas(
    deliveryId: string,
    newClaimedBy: string,
    expected: { state: DeliveryState; claimed_by: string | null },
  ): boolean;
  transition(
    deliveryId: string,
    newState: DeliveryState,
    fields?: Partial<{ claimed_by: string | null; next_attempt_at: string | null; attempts: number; error_body: string | null }>,
  ): boolean;
  purgeTerminalReapNotices(beforeIso: string): number;
}

export interface ReapNoticeDrainDeps {
  store: ReapNoticeDrainStore;
  /** Direct adapter send to an EXISTING topic (never creates topics). */
  sendToTopic: (topicId: number, text: string) => Promise<void>;
  /** Append a notify outcome record (reap-log pairs, R1.3). */
  recordNotify: (e: {
    noticeId: string;
    topicId: number | null;
    outcome: ReapNotifyOutcome;
    detail?: string;
  }) => void;
  /** ONE aggregated, deduped attention item (stable id) for terminal
   *  escalations — updated in place, never per-row (P17). */
  emitAttention?: (item: {
    id: string;
    title: string;
    summary?: string;
    description?: string;
    category?: string;
    priority?: 'low' | 'medium' | 'high';
    sourceContext?: string;
  }) => Promise<void>;
  bootId: string;
  now?: () => number;
}

export interface ReapNoticeDrainOptions {
  tickIntervalMs: number;
  perPassSendCap: number;
  maxAttempts: number;
  leaseDurationMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Terminal rows older than this are cleaned from the reap-notify lane. */
  terminalRetentionMs: number;
}

export const DEFAULT_REAP_NOTICE_DRAIN_OPTIONS: ReapNoticeDrainOptions = {
  tickIntervalMs: 30_000,
  perPassSendCap: 15,
  maxAttempts: 8,
  leaseDurationMs: 120_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60_000,
  terminalRetentionMs: 24 * 3600_000,
};

const ESCALATION_ATTENTION_ID = 'reap-notice-drain:escalations';

export class ReapNoticeDrain {
  private readonly deps: ReapNoticeDrainDeps;
  private readonly opts: ReapNoticeDrainOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Rolling escalation aggregate since boot (feeds the ONE attention item). */
  private escalations: Array<{ noticeId: string; topicId: number; at: string }> = [];
  private lastCleanupAt = 0;

  constructor(deps: ReapNoticeDrainDeps, opts?: Partial<ReapNoticeDrainOptions>) {
    this.deps = deps;
    this.opts = { ...DEFAULT_REAP_NOTICE_DRAIN_OPTIONS, ...(opts ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* @silent-fallback-ok — last-resort belt: tick() already guards and
           records every per-row failure durably (attempts/backoff/escalation);
           a throw here would only kill the interval timer. */
      });
    }, this.opts.tickIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One drain pass. Public so tests (and a manual flush) can drive it. */
  async tick(): Promise<{ sent: number; retried: number; escalated: number }> {
    const counters = { sent: 0, retried: 0, escalated: 0 };
    if (this.ticking) return counters; // re-entrancy guard
    this.ticking = true;
    try {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();

      let candidates: PendingRelayRow[] = [];
      try {
        candidates = this.deps.store
          .selectClaimableReapNotices(nowIso, this.opts.perPassSendCap * 2)
          .filter((row) => row.state === 'queued' || this.isLeaseStale(row, nowMs));
      } catch (err) {
        console.warn('[reap-notice-drain] select raised:', err);
        return counters;
      }

      let processed = 0;
      for (const row of candidates) {
        if (processed >= this.opts.perPassSendCap) break;
        const leaseUntil = new Date(nowMs + this.opts.leaseDurationMs).toISOString();
        const claimedBy = `${this.deps.bootId}:${process.pid}:${leaseUntil}`;
        let won = false;
        try {
          won = this.deps.store.claimCas(row.delivery_id, claimedBy, {
            state: row.state,
            claimed_by: row.claimed_by,
          });
        } catch {
          won = false;
        }
        if (!won) continue; // lost the race (or the row moved) — next tick re-selects
        processed++;

        const noticeId = parseReapNotifyDeliveryId(row.delivery_id) ?? row.delivery_id;
        const text = Buffer.isBuffer(row.text) ? row.text.toString('utf-8') : String(row.text ?? '');
        try {
          await this.deps.sendToTopic(row.topic_id, text);
          this.safeTransition(row.delivery_id, 'delivered-recovered', { claimed_by: null });
          this.safeRecord({ noticeId, topicId: row.topic_id, outcome: 'sent' });
          counters.sent++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const attempts = (row.attempts ?? 1) + 1;
          if (attempts >= this.opts.maxAttempts) {
            this.safeTransition(row.delivery_id, 'escalated', {
              attempts,
              claimed_by: null,
              error_body: errMsg.slice(0, 512),
            });
            this.safeRecord({
              noticeId,
              topicId: row.topic_id,
              outcome: 'send-failed-escalated',
              detail: `after ${attempts} attempts: ${errMsg.slice(0, 200)}`,
            });
            counters.escalated++;
            await this.escalate(noticeId, row.topic_id, nowIso);
          } else {
            const backoff = Math.min(
              this.opts.backoffBaseMs * 2 ** Math.max(0, attempts - 1),
              this.opts.backoffMaxMs,
            );
            this.safeTransition(row.delivery_id, 'queued', {
              attempts,
              claimed_by: null,
              next_attempt_at: new Date(nowMs + backoff).toISOString(),
              error_body: errMsg.slice(0, 512),
            });
            counters.retried++;
          }
        }
      }

      // Bounded terminal-row cleanup (≤ once/hour).
      if (nowMs - this.lastCleanupAt > 3600_000) {
        this.lastCleanupAt = nowMs;
        try {
          this.deps.store.purgeTerminalReapNotices(
            new Date(nowMs - this.opts.terminalRetentionMs).toISOString(),
          );
        } catch {
          /* cleanup is best-effort */
        }
      }
      return counters;
    } finally {
      this.ticking = false;
    }
  }

  /** Lease format mirrors DFS: `<bootId>:<pid>:<leaseUntilIso>`. */
  private isLeaseStale(row: PendingRelayRow, nowMs: number): boolean {
    if (!row.claimed_by) return true;
    const parts = row.claimed_by.split(':');
    if (parts.length < 3) return true;
    const bootId = parts[0];
    const leaseUntilIso = parts.slice(2).join(':');
    if (bootId !== this.deps.bootId) return true; // prior boot — reclaimable
    const lease = Date.parse(leaseUntilIso);
    if (Number.isNaN(lease)) return true;
    return lease < nowMs;
  }

  private safeTransition(
    deliveryId: string,
    state: DeliveryState,
    fields?: Partial<{ claimed_by: string | null; next_attempt_at: string | null; attempts: number; error_body: string | null }>,
  ): void {
    try {
      this.deps.store.transition(deliveryId, state, fields);
    } catch (err) {
      console.warn(`[reap-notice-drain] transition(${deliveryId}, ${state}) raised:`, err);
    }
  }

  private safeRecord(e: { noticeId: string; topicId: number | null; outcome: ReapNotifyOutcome; detail?: string }): void {
    try {
      this.deps.recordNotify(e);
    } catch {
      /* the audit sink never endangers delivery */
    }
  }

  /** ONE rolling deduped attention item, updated in place (P17). */
  private async escalate(noticeId: string, topicId: number, atIso: string): Promise<void> {
    this.escalations.push({ noticeId, topicId, at: atIso });
    if (this.escalations.length > 50) this.escalations.shift();
    if (!this.deps.emitAttention) return;
    const topics = [...new Set(this.escalations.map((e) => e.topicId))];
    try {
      await this.deps.emitAttention({
        id: ESCALATION_ATTENTION_ID,
        title: `Reap notices could not be delivered (${this.escalations.length} since startup)`,
        summary: `Delivery of session-shutdown notices failed after all retries for topic(s) ${topics.join(', ')}.`,
        description:
          `I tried to tell the affected conversation(s) that sessions were shut down, but the messages ` +
          `could not be delivered after repeated attempts. The shutdowns themselves are all recorded — ` +
          `ask me "what happened to my sessions?" and I can reconstruct it. Most recent failure: notice ` +
          `${noticeId} for topic ${topicId} at ${atIso}.`,
        category: 'delivery',
        priority: 'medium',
        sourceContext: 'reap-notice-drain',
      });
    } catch (err) {
      console.warn('[reap-notice-drain] attention emit failed:', err);
    }
  }
}
