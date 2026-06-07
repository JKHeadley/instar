/**
 * A2ARedeliverySentinel — the active-recovery layer of "communications never
 * just die out" (A2A-DURABLE-DELIVERY-SPEC.md §4, issue #939, CMT-1143). PR2.
 *
 * PR1 (A2ADeliveryTracker) made every outbound A2A message a durable, tracked
 * loop (`awaiting-ack`) and turned channel-liveness into a read. This sentinel
 * is the consumer that CLOSES those loops: on a cadence it sweeps the tracker's
 * overdue work-list and either gets the message through (redelivery with
 * backoff) or, once retries are exhausted, surfaces ONE aggregated, operator-
 * visible escalation per peer — so a peer going dark is impossible to miss.
 *
 * Signal-vs-authority: this is a SIGNAL CONSUMER feeding existing surfaces
 * (the relay client for redelivery, the Attention queue for escalation). It owns
 * NO blocking authority — it never gates a send or a receive; it only re-attempts
 * and reports. The state machine guarantees escalate-once: `markEscalated` moves a
 * row out of `awaiting-ack`, so `findOverdue` never returns it again (no
 * re-escalation, no cooldown log needed).
 *
 * Modeled on CollaborationRedriveEngine (the sibling redrive/escalate engine):
 * injected deps for testability, per-tick caps, setInterval+unref lifecycle,
 * disabled-by-default (it sends + escalates, so it ships dark and is opt-in).
 */

import type { A2ADeliveryTracker, A2ADeliveryEntry } from '../threadline/A2ADeliveryTracker.js';

/** A redelivery attempt: re-send the message body to the peer. Returns whether
 *  the transport accepted it. Resolving false (or throwing) leaves the message
 *  awaiting-ack for the next sweep. */
export type A2ARedeliverFn = (entry: A2ADeliveryEntry) => Promise<boolean> | boolean;

/** Raise ONE aggregated attention item (P17 — never one per message). */
export type A2ARaiseAttentionFn = (item: {
  title: string;
  body: string;
  priority?: 'low' | 'medium' | 'high';
  source?: string;
}) => Promise<unknown> | unknown;

export interface A2ARedeliveryConfig {
  /** Master switch. Ships OFF (it re-sends + escalates). */
  enabled: boolean;
  /** Sweep cadence. */
  sweepIntervalMs: number;
  /** A message awaiting-ack longer than this (since last attempt) is overdue. */
  ttlMs: number;
  /** Re-attempts before escalation (the original send counts as attempt 1). */
  maxAttempts: number;
  /** Backoff base: nextRetry ≈ backoffBaseMs * 2^(attempts-1). */
  backoffBaseMs: number;
  /** Cap redelivery sends per sweep (protect a degraded transport). */
  maxRedrivesPerTick: number;
}

export const DEFAULT_A2A_REDELIVERY_CONFIG: A2ARedeliveryConfig = {
  enabled: false,
  sweepIntervalMs: 15 * 60 * 1000, // 15m
  ttlMs: 6 * 60 * 60 * 1000,       // 6h — matches the ACK-discipline window
  maxAttempts: 5,
  backoffBaseMs: 5 * 60 * 1000,    // 5m, doubling
  maxRedrivesPerTick: 10,
};

export interface A2ARedeliveryDeps {
  tracker: A2ADeliveryTracker;
  /** Re-send a message. Omit to run escalate-only (no redelivery). */
  redeliver?: A2ARedeliverFn;
  /** Raise the aggregated escalation. Omit and escalations are state-only. */
  raiseAttention?: A2ARaiseAttentionFn;
  now?: () => number;
  log?: { log: (m: string) => void; warn: (m: string) => void };
}

export interface A2ARedeliveryTickResult {
  disabled: boolean;
  overdue: number;
  redelivered: number;
  escalated: number;
  /** Peers that received an aggregated escalation this tick. */
  escalatedPeers: string[];
}

export class A2ARedeliverySentinel {
  private readonly cfg: A2ARedeliveryConfig;
  private readonly deps: A2ARedeliveryDeps;
  private readonly now: () => number;
  private readonly log: { log: (m: string) => void; warn: (m: string) => void };
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: A2ARedeliveryDeps, cfg: Partial<A2ARedeliveryConfig> = {}) {
    this.cfg = { ...DEFAULT_A2A_REDELIVERY_CONFIG, ...cfg };
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? {
      log: (m) => console.log(`[A2ARedelivery] ${m}`),
      warn: (m) => console.warn(`[A2ARedelivery] ${m}`),
    };
  }

  start(): void {
    if (this.timer) return;
    if (!this.cfg.enabled) {
      this.log.log('disabled; sweep NOT armed');
      return;
    }
    this.timer = setInterval(() => {
      void Promise.resolve(this.tick()).catch((err) => {
        // @silent-fallback-ok: a sweep error must never crash the interval; it's
        // logged and the next sweep retries (the tracker state is durable).
        this.log.warn(`tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.cfg.sweepIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log.log(`armed (sweep ${this.cfg.sweepIntervalMs}ms, ttl ${this.cfg.ttlMs}ms, maxAttempts ${this.cfg.maxAttempts})`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One sweep: redeliver overdue messages under the attempt cap, escalate the rest. */
  async tick(): Promise<A2ARedeliveryTickResult> {
    if (!this.cfg.enabled) {
      return { disabled: true, overdue: 0, redelivered: 0, escalated: 0, escalatedPeers: [] };
    }
    const nowMs = this.now();
    const overdue = this.deps.tracker.findOverdue(this.cfg.ttlMs, nowMs);
    let redelivered = 0;
    // Peer → messages escalated this tick (for one aggregated attention item each).
    const escalatedByPeer = new Map<string, A2ADeliveryEntry[]>();

    for (const entry of overdue) {
      if (entry.attempts >= this.cfg.maxAttempts) {
        // Retries exhausted → escalate (once: markEscalated removes it from findOverdue).
        this.deps.tracker.markEscalated(entry.messageId, new Date(nowMs).toISOString());
        const list = escalatedByPeer.get(entry.peerFp) ?? [];
        list.push(entry);
        escalatedByPeer.set(entry.peerFp, list);
        continue;
      }
      // Under the cap → re-attempt delivery (subject to the per-tick cap).
      if (redelivered >= this.cfg.maxRedrivesPerTick) continue;
      let accepted = false;
      if (this.deps.redeliver) {
        try {
          accepted = await Promise.resolve(this.deps.redeliver(entry));
        } catch (err) {
          // @silent-fallback-ok: a redelivery transport error must not abort the
          // sweep; the message stays awaiting-ack and is retried next tick. Logged.
          this.log.warn(`redeliver failed for ${entry.messageId} → ${entry.peerFp.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Whether or not the transport accepted, count the attempt + set backoff:
      // an "accepted" send still isn't acked (that's the whole point), so it must
      // remain awaiting-ack and keep its retry clock advancing toward escalation.
      const backoffMs = this.cfg.backoffBaseMs * Math.pow(2, Math.max(0, entry.attempts - 1));
      const nextRetry = new Date(nowMs + backoffMs).toISOString();
      this.deps.tracker.markAttempt(entry.messageId, nextRetry, new Date(nowMs).toISOString());
      if (accepted) redelivered++;
    }

    // ONE aggregated attention item per dark peer (P17 — never per message).
    const escalatedPeers: string[] = [];
    let escalatedCount = 0;
    for (const [peerFp, msgs] of escalatedByPeer) {
      escalatedCount += msgs.length;
      escalatedPeers.push(peerFp);
      if (this.deps.raiseAttention) {
        const peerName = msgs.find((m) => m.peerName)?.peerName ?? peerFp.slice(0, 12);
        const oldest = msgs.reduce((a, b) => (Date.parse(a.sentAt) <= Date.parse(b.sentAt) ? a : b));
        const ageH = Math.round((nowMs - Date.parse(oldest.sentAt)) / 3_600_000);
        try {
          await Promise.resolve(this.deps.raiseAttention({
            title: `Agent ${peerName} is dark: ${msgs.length} message(s) undelivered`,
            body: `${msgs.length} message(s) to ${peerName} (${peerFp.slice(0, 16)}…) have gone unacknowledged for ~${ageH}h after ${this.cfg.maxAttempts} delivery attempts. The peer may be offline or unreachable — check the relay and the peer's address. (A2A delivery escalation; threads: ${msgs.map((m) => m.threadId ?? '?').slice(0, 5).join(', ')})`,
            priority: 'medium',
            source: `a2a-redelivery:${peerFp}`,
          }));
        } catch (err) {
          // @silent-fallback-ok: a failed attention raise must not abort the sweep
          // or lose the escalated state (already persisted via markEscalated). Logged.
          this.log.warn(`raiseAttention failed for ${peerFp.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (redelivered || escalatedCount) {
      this.log.log(`sweep: ${overdue.length} overdue, ${redelivered} redelivered, ${escalatedCount} escalated across ${escalatedPeers.length} peer(s)`);
    }
    return { disabled: false, overdue: overdue.length, redelivered, escalated: escalatedCount, escalatedPeers };
  }
}
