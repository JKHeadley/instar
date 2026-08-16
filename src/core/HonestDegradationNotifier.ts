/**
 * HonestDegradationNotifier — §5.4 honest degradation for the cross-machine account
 * & quota sharing feature (spec: docs/specs/cross-machine-account-quota-sharing.md
 * §5.4, governed by D9).
 *
 * THE BUG THIS KILLS: when EVERY machine in the pool is walled, the old placement
 * path "places anyway" onto a walled machine that then produces the exact dead reply
 * ("🔭 working…" with no answer ever). This notifier replaces that with exactly ONE
 * honest in-channel notice from the topic's owner/voice-holder.
 *
 * D9 contract:
 *  - Idempotent per (topic, walled-episode) with a coalescing window — a repeat
 *    walled inbound on the SAME topic inside the window does NOT re-notify.
 *  - CROSS-TOPIC AGGREGATION: when ≥ `aggregateThreshold` topics enter a walled
 *    episode within the window (the correlated reset-boundary case), scoped per
 *    (operator, platform/workspace), collapse to ONE pool-level notice rather than
 *    one-per-topic (aggregate-don't-enumerate / Bounded Notification).
 *  - Both terminals: an episode closes on RECOVERY (drain the queued inbound) OR via
 *    the durable inbound-queue TTL loss-notice. This notifier owns the "tell the user
 *    once" half; the queue owns the loss terminal — never an open loop.
 *
 * SIGNAL-ONLY: this never blocks or rewrites a message; it only decides whether to
 * SEND one honest notice. Pure decision (`decideNotice`) is split from the side
 * effect so the aggregation logic is unit-testable without any send I/O.
 */

import type { ServeRequirement } from './serveCapability.js';

export interface HonestDegradationPolicy {
  /** D9: window (ms) over which repeat walled-episode notices for the SAME topic
   *  are coalesced into one. Default 600000 (10m). */
  coalesceWindowMs: number;
  /** D9: when ≥ this many topics enter a walled-episode within the window (scoped
   *  per operator+platform), collapse to ONE pool-level notice. Default 3. */
  aggregateThreshold: number;
}

export const DEFAULT_HONEST_DEGRADATION_POLICY: HonestDegradationPolicy = {
  coalesceWindowMs: 600_000,
  aggregateThreshold: 3,
};

export function resolveHonestDegradationPolicy(
  cfg: { degradationCoalesceWindowMs?: number; degradationAggregateThreshold?: number } | undefined,
): HonestDegradationPolicy {
  const d = DEFAULT_HONEST_DEGRADATION_POLICY;
  return {
    coalesceWindowMs: Math.max(0, cfg?.degradationCoalesceWindowMs ?? d.coalesceWindowMs),
    aggregateThreshold: Math.max(2, cfg?.degradationAggregateThreshold ?? d.aggregateThreshold),
  };
}

/** The decision the pure logic returns. */
export type NoticeDecision =
  | { send: 'none'; reason: string }
  | { send: 'per-topic'; topicId: string; reason: string }
  | { send: 'aggregated'; scopeKey: string; affectedTopics: string[]; reason: string };

/** A recorded walled-episode entry (per topic). */
interface EpisodeEntry {
  topicId: string;
  scopeKey: string; // operator+platform scope (D9)
  /** When this episode FIRST opened (epoch ms). */
  openedAtMs: number;
  /** When a per-topic notice was last emitted for this episode (epoch ms), or null. */
  lastNoticeAtMs: number | null;
}

/**
 * Derive the per-(operator, platform/workspace) scope key for aggregation (D9 —
 * "one busy user gets ONE notice per channel, not one per topic"). Falls back to the
 * platform alone when no operator is resolvable (still bounds to one notice per
 * channel rather than per topic).
 */
export function degradationScopeKey(operatorUid: string | null | undefined, requirement: ServeRequirement | undefined): string {
  const platform = requirement?.platform ?? 'unknown';
  const channel = requirement?.workspaceId ?? requirement?.chatId ?? 'default';
  const op = operatorUid && operatorUid.length > 0 ? operatorUid : 'unknown-operator';
  return `${op}::${platform}::${channel}`;
}

export interface HonestDegradationNotifierDeps {
  /** Send ONE per-topic honest in-channel notice (the voice-holder emits it). */
  sendPerTopicNotice: (topicId: string, requirement: ServeRequirement | undefined) => Promise<void> | void;
  /** Send ONE aggregated pool-level notice for a (operator, platform/workspace) scope. */
  sendAggregatedNotice: (scopeKey: string, affectedTopics: string[], requirement: ServeRequirement | undefined) => Promise<void> | void;
  /** Resolve the verified operator uid for a topic (Know Your Principal) — used only
   *  to scope aggregation; null is tolerated (scoped per platform). */
  resolveOperatorUid?: (topicId: string) => string | null;
  /** Whether dry-run holds — when true, the decision is computed + audited but no
   *  notice is sent (D6 canary). */
  isDryRun: () => boolean;
  /** Append one audit line. */
  audit?: (rec: { ts: string; topicId: string; decision: NoticeDecision; dryRun: boolean }) => void;
  policy: HonestDegradationPolicy;
  now?: () => number;
}

export class HonestDegradationNotifier {
  private readonly d: HonestDegradationNotifierDeps;
  /** Open episodes keyed by topicId. */
  private readonly episodes = new Map<string, EpisodeEntry>();
  /** Per-scope last-aggregated-notice time (epoch ms) — tracked SEPARATELY from a
   *  per-topic notice so a scope that already had per-topic notices can still
   *  aggregate once when it crosses the threshold, and a post-aggregation burst
   *  coalesces silently. */
  private readonly aggregatedAt = new Map<string, number>();

  constructor(deps: HonestDegradationNotifierDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Episodes within the coalesce window for a given scope key (D9 aggregation count). */
  private liveEpisodesForScope(scopeKey: string): EpisodeEntry[] {
    const cutoff = this.now() - this.d.policy.coalesceWindowMs;
    const out: EpisodeEntry[] = [];
    for (const e of this.episodes.values()) {
      if (e.scopeKey === scopeKey && e.openedAtMs >= cutoff) out.push(e);
    }
    return out;
  }

  /**
   * The pure decision: given a topic entering (or repeating in) a walled episode,
   * decide whether to send nothing (coalesced), a per-topic notice, or an aggregated
   * pool-level notice. MUTATES the episode table (records the open / notice time) so
   * idempotency holds across calls — callers must use this single entry point.
   */
  decideNotice(topicId: string, requirement: ServeRequirement | undefined): NoticeDecision {
    const nowMs = this.now();
    const operatorUid = this.d.resolveOperatorUid?.(topicId) ?? null;
    const scopeKey = degradationScopeKey(operatorUid, requirement);

    // Open or refresh this topic's episode.
    const existing = this.episodes.get(topicId);
    const withinWindow = existing != null && nowMs - existing.openedAtMs < this.d.policy.coalesceWindowMs;
    if (!existing || !withinWindow) {
      this.episodes.set(topicId, { topicId, scopeKey, openedAtMs: nowMs, lastNoticeAtMs: null });
    }

    // Count live episodes in this scope (including this one).
    const live = this.liveEpisodesForScope(scopeKey);

    // D9 cross-topic aggregation: ≥ threshold topics walled within the window for
    // the same scope → ONE pool-level notice. Idempotent per SCOPE per window via a
    // dedicated aggregatedAt map (NOT the per-topic lastNoticeAtMs — those two must
    // not conflate, or a scope that already sent per-topic notices could never
    // aggregate, and the post-aggregation burst could not coalesce).
    if (live.length >= this.d.policy.aggregateThreshold) {
      const aggCutoff = nowMs - this.d.policy.coalesceWindowMs;
      const lastAgg = this.aggregatedAt.get(scopeKey);
      if (lastAgg != null && lastAgg >= aggCutoff) {
        return { send: 'none', reason: 'aggregated-notice-already-sent-this-window' };
      }
      this.aggregatedAt.set(scopeKey, nowMs);
      // Stamp every live episode in the scope as notified (so a per-topic path below
      // never re-fires for a topic already covered by this aggregated notice).
      for (const e of live) e.lastNoticeAtMs = nowMs;
      return { send: 'aggregated', scopeKey, affectedTopics: live.map((e) => e.topicId).sort(), reason: 'cross-topic-aggregation-threshold-reached' };
    }

    // Below the aggregation threshold → per-topic notice, idempotent within the window.
    const entry = this.episodes.get(topicId)!;
    if (entry.lastNoticeAtMs != null && nowMs - entry.lastNoticeAtMs < this.d.policy.coalesceWindowMs) {
      return { send: 'none', reason: 'per-topic-notice-coalesced-within-window' };
    }
    entry.lastNoticeAtMs = nowMs;
    return { send: 'per-topic', topicId, reason: 'first-walled-episode-notice' };
  }

  /** Decide + (when not dry-run) send the honest notice. */
  async notify(topicId: string, requirement: ServeRequirement | undefined): Promise<NoticeDecision> {
    const decision = this.decideNotice(topicId, requirement);
    this.d.audit?.({ ts: new Date(this.now()).toISOString(), topicId, decision, dryRun: this.d.isDryRun() });
    if (this.d.isDryRun()) return decision; // canary: computed + audited, not sent
    if (decision.send === 'per-topic') {
      await this.d.sendPerTopicNotice(decision.topicId, requirement);
    } else if (decision.send === 'aggregated') {
      await this.d.sendAggregatedNotice(decision.scopeKey, decision.affectedTopics, requirement);
    }
    return decision;
  }

  /**
   * Close an episode on RECOVERY (D9 terminal A): the topic can serve again, so the
   * episode is cleared and a future wall opens a fresh one. The caller (the inbound
   * path) is responsible for draining the queued inbound; this just clears the state.
   */
  closeEpisodeOnRecovery(topicId: string): void {
    this.episodes.delete(topicId);
  }
}
