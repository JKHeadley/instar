/**
 * ReapNotifier — the single coalescing listener for `sessionReaped`
 * (UNIFIED-SESSION-LIFECYCLE §P3; v2 per reap-notify spec R1.1–R1.5).
 *
 * `SessionManager.terminateSession` emits `sessionReaped` exactly once per kill
 * at the one chokepoint. This listener turns TERMINAL reaps of user-facing
 * sessions into "your session was shut down" notices so a session never
 * silently vanishes (the 2026-05-27 incident). It stays SILENT for:
 *   - `recovery-bounce` reaps (a kill-to-respawn is a bounce, not a disappearance),
 *   - `origin:'operator'` reaps (the user clicked kill — telling them is noise).
 *
 * v2 (perTopic: true, the shipped default):
 *   - Per-topic coalescing (R1.1): every topic that lost a session gets ONE
 *     notice in THAT topic; the lifeline gets unbound sessions plus — when >1
 *     topic is affected — a one-line cross-topic index. Never creates topics.
 *   - Affected-set tracking is SEPARATE from the bounded detail buffer, so in
 *     a storm larger than the buffer every affected topic still gets at least
 *     a correct count (count-only notice when its detail was dropped).
 *   - Durable delivery (R1.3): notices become PendingRelayStore rows keyed
 *     `reap-notify:<noticeId>` with the release hold riding `next_attempt_at`;
 *     the always-on ReapNoticeDrain delivers them. Outcome records land in
 *     the reap-log as append-only pairs. Enqueue failure degrades LOUDLY to
 *     one direct send attempt, recorded `enqueue-failed`.
 *   - Release tiers (decision 1 + R1.5): a mid-work reap with a QUEUED resume
 *     releases IMMEDIATE outside quiet hours (quiet-hours end inside them —
 *     never wakes the user; a queued resume means the system is already
 *     handling it); everything else releases on the SUMMARY window. At most
 *     `maxImmediatePerFlush` immediate releases per flush.
 *   - Plain English (R1.2): reason slugs map to human sentences (unknown slug
 *     ⇒ generic sentence with the slug parenthesized); no curl/API pointers
 *     in any user-facing body.
 *
 * Legacy (perTopic: false — the rollback lever): byte-compatible with the
 * pre-v2 behavior (single buffer; burst ⇒ ONE consolidated lifeline message).
 *
 * Sanitization: session names follow user-controlled topic renames, so the
 * dynamic fields (name, reason) are wrapped as inline-code spans — the
 * downstream Telegram formatter renders code spans as literal, HTML-escaped
 * text, never markup. The notifier never emits raw markup around
 * user-controlled values.
 */

import type { Session } from '../core/types.js';
import type { ReapNotifyOutcome } from './ReapLog.js';
import { buildReapNotifyDeliveryId } from '../messaging/reap-notice-delivery-id.js';

export interface ReapEvent {
  session: Pick<Session, 'name' | 'tmuxSession'>;
  reason: string;
  disposition?: 'terminal' | 'recovery-bounce';
  origin?: 'operator' | 'autonomous';
  /** Mid-work stamp from the kill chokepoint (reap-notify spec R2.1). */
  midWork?: boolean;
  /** Clamped work-evidence names behind midWork. */
  workEvidence?: string[];
}

export interface ReapNotifierDeps {
  /** Bound messaging topic for a session, or null if unbound. */
  resolveTopic: (tmuxSession: string) => number | null;
  /** The always-on system/lifeline topic, or null if none is configured. */
  lifelineTopic: () => number | null;
  /** Legacy delivery (perTopic:false and drainEnabled:false modes). */
  send: (topicId: number, text: string) => void | Promise<void>;
  /** Durable store enqueue (v2). Returns false on PK-dedupe no-op. */
  enqueueNotice?: (input: {
    delivery_id: string;
    topic_id: number;
    text: string;
    next_attempt_at: string;
  }) => boolean;
  /** Append a notify outcome record to the reap-log (R1.3 pairs). */
  recordNotify?: (e: {
    noticeId: string;
    topicId: number | null;
    outcome: ReapNotifyOutcome;
    detail?: string;
  }) => void;
  /** Epoch ms when the current quiet-hours window ends; null = not in quiet hours. */
  quietHoursEndAt?: (nowMs: number) => number | null;
  /** Epoch ms of the next SUMMARY-window release (≤30 min out — R1.5). */
  summaryReleaseAt?: (nowMs: number) => number;
  /** True when a resume-queue entry is QUEUED for this session AND the queue is
   *  LIVE (not dry-run) — gates the "resume queued" line (R1.2). */
  resumeQueuedFor?: (tmuxSession: string) => boolean;
  /** Loud degradation surface for enqueue failures (aggregated upstream). */
  reportDegradation?: (reason: string, impact: string) => void;
  now?: () => number;
}

export interface ReapNotifierOptions {
  enabled: boolean;
  coalesceWindowMs: number;
  /** Max reaps retained for detail lists (counts stay exact regardless). */
  maxBuffer: number;
  /** v2 per-topic grouping (R1.1). false = legacy single-buffer behavior. */
  perTopic: boolean;
  /** Max notices released IMMEDIATE in one flush (R1.5). */
  maxImmediatePerFlush: number;
  /** Durable delivery via store + drain (R1.3). false = legacy direct send
   *  (grouping unaffected; the durability guarantee lapses — stated rollback). */
  drainEnabled: boolean;
}

export const DEFAULT_REAP_NOTIFIER_OPTIONS: ReapNotifierOptions = {
  enabled: true,
  coalesceWindowMs: 60_000,
  maxBuffer: 100,
  perTopic: true,
  maxImmediatePerFlush: 5,
  drainEnabled: true,
};

/** Hard cap on tracked affected topics per window (R1.1 storm bound). */
const AFFECTED_SET_CAP = 500;

/** Plain-English reason map (R1.2). Unknown slugs get the generic sentence. */
const REASON_MAP: Record<string, string> = {
  'quota-shed': 'usage limits were nearly exhausted, so running sessions were paused to switch accounts',
  'reaped-idle': 'it had been idle for a long time and the machine needed the resources',
  'age-limit': 'it reached its maximum allowed runtime',
  'idle-zombie': 'it stopped responding and looked abandoned',
  'orphan-reap': 'it was left over from an earlier run that already ended',
  'watchdog-stuck': 'it was stuck and not responding',
  'sentinel-complete': 'its work was detected as complete',
  'rerouted-lifetime': 'its background task reached its time limit',
  'boot-purge': 'it was already dead when the server restarted',
};

export function plainEnglishReason(slug: string): string {
  const mapped = REASON_MAP[slug];
  if (mapped) return mapped;
  // Free-text reasons (e.g. "topic moved to <machine> — …") read acceptably
  // as-is; slug-like unknowns get the generic sentence with the slug shown.
  if (slug.includes(' ')) return slug;
  return `it was shut down automatically (reason: ${slug})`;
}

/** Wrap a user-controlled value as a literal inline-code span (never markup). */
function literal(value: string): string {
  // Neutralize backticks so the code span can't be broken out of.
  return '`' + String(value).replace(/`/g, "'") + '`';
}

interface TopicAggregate {
  count: number;
  midWorkCount: number;
  resumeQueuedCount: number;
  /** Detail events for this topic still inside the bounded buffer. */
  detail: ReapEvent[];
}

export class ReapNotifier {
  private readonly deps: ReapNotifierDeps;
  private readonly opts: ReapNotifierOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private buffer: ReapEvent[] = [];
  private windowCount = 0;
  /** v2 affected-set (R1.1) — tracked separately from the detail buffer. */
  private affected = new Map<number, TopicAggregate>();
  private affectedOverflow = 0;
  private unbound: TopicAggregate = { count: 0, midWorkCount: 0, resumeQueuedCount: 0, detail: [] };
  private noticeSeq = 0;

  constructor(deps: ReapNotifierDeps, opts?: Partial<ReapNotifierOptions>) {
    this.deps = deps;
    this.opts = { ...DEFAULT_REAP_NOTIFIER_OPTIONS, ...(opts ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  /** The `sessionReaped` event handler. */
  onReaped(event: ReapEvent): void {
    if (!this.opts.enabled) return;
    // Silent dispositions/origins (R1.4): a bounce is not a disappearance, and
    // the user already knows about their own operator kill.
    if ((event.disposition ?? 'terminal') !== 'terminal') return;
    if (event.origin === 'operator') return;

    this.windowCount++;
    this.buffer.push(event);
    const dropped = this.buffer.length > this.opts.maxBuffer ? this.buffer.shift() : undefined;

    if (this.opts.perTopic) {
      this.trackAffected(event);
      // The dropped event's detail leaves the buffer but its topic's counts
      // remain in the affected set (already incremented when it arrived).
      if (dropped) this.dropDetail(dropped);
    }

    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.opts.coalesceWindowMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  private trackAffected(event: ReapEvent): void {
    const topicId = this.safeResolveTopic(event.session.tmuxSession);
    const resumeQueued = this.safeResumeQueued(event.session.tmuxSession);
    const bump = (agg: TopicAggregate) => {
      agg.count++;
      if (event.midWork) agg.midWorkCount++;
      if (resumeQueued) agg.resumeQueuedCount++;
      agg.detail.push(event);
    };
    if (topicId == null) {
      bump(this.unbound);
      return;
    }
    const existing = this.affected.get(topicId);
    if (existing) {
      bump(existing);
      return;
    }
    if (this.affected.size >= AFFECTED_SET_CAP) {
      this.affectedOverflow++;
      return;
    }
    const agg: TopicAggregate = { count: 0, midWorkCount: 0, resumeQueuedCount: 0, detail: [] };
    bump(agg);
    this.affected.set(topicId, agg);
  }

  /** Remove a buffer-evicted event from its topic's detail list (count stays). */
  private dropDetail(event: ReapEvent): void {
    const topicId = this.safeResolveTopic(event.session.tmuxSession);
    const agg = topicId == null ? this.unbound : this.affected.get(topicId);
    if (!agg) return;
    const idx = agg.detail.indexOf(event);
    if (idx >= 0) agg.detail.splice(idx, 1);
  }

  private safeResolveTopic(tmuxSession: string): number | null {
    try {
      return this.deps.resolveTopic(tmuxSession);
    } catch {
      // @silent-fallback-ok — null = "unbound": the session is routed to the
      // lifeline index line instead; a notice is never dropped on this path.
      return null;
    }
  }

  private safeResumeQueued(tmuxSession: string): boolean {
    try {
      return this.deps.resumeQueuedFor?.(tmuxSession) ?? false;
    } catch {
      // @silent-fallback-ok — cosmetic: only omits the "a restart is queued"
      // line from the notice text; queueing itself is not affected.
      return false;
    }
  }

  /**
   * Emit the coalesced notice(s) for the closed window and reset. Public so the
   * lifecycle (and tests) can drive it deterministically.
   */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    if (!this.opts.perTopic) {
      await this.flushLegacy();
      return;
    }

    const affected = this.affected;
    const unbound = this.unbound;
    const overflow = this.affectedOverflow;
    this.affected = new Map();
    this.unbound = { count: 0, midWorkCount: 0, resumeQueuedCount: 0, detail: [] };
    this.affectedOverflow = 0;
    this.windowCount = 0;
    this.buffer = [];
    if (affected.size === 0 && unbound.count === 0) return;

    // Release-tier selection (decision 1 + R1.5): topics with a mid-work reap
    // AND a queued resume go IMMEDIATE, capped at maxImmediatePerFlush —
    // most-severe first (resume-queued count, then mid-work count).
    const entries = [...affected.entries()];
    const immediateEligible = entries
      .filter(([, agg]) => agg.midWorkCount > 0 && agg.resumeQueuedCount > 0)
      .sort(([, a], [, b]) => b.resumeQueuedCount - a.resumeQueuedCount || b.midWorkCount - a.midWorkCount)
      .slice(0, this.opts.maxImmediatePerFlush)
      .map(([topicId]) => topicId);
    const immediateSet = new Set(immediateEligible);

    for (const [topicId, agg] of entries) {
      const body = this.formatTopicNotice(agg);
      await this.deliver(topicId, body, immediateSet.has(topicId) ? 'IMMEDIATE' : 'SUMMARY');
    }

    // Lifeline: unbound sessions + (when >1 topic affected) a cross-topic index.
    const lifeline = this.deps.lifelineTopic();
    const lifelineParts: string[] = [];
    if (unbound.count > 0) {
      lifelineParts.push(this.formatUnboundNotice(unbound));
    }
    if (affected.size > 1) {
      lifelineParts.push(this.formatCrossTopicIndex(affected, overflow));
    } else if (overflow > 0) {
      lifelineParts.push(`(${overflow} additional affected topic${overflow === 1 ? '' : 's'} exceeded the tracking cap — every reap is still in the reap-log.)`);
    }
    if (lifelineParts.length > 0) {
      if (lifeline == null) {
        this.deps.recordNotify?.({
          noticeId: this.nextNoticeId('lifeline'),
          topicId: null,
          outcome: 'no-topic',
          detail: 'lifeline topic not configured',
        });
      } else {
        await this.deliver(lifeline, lifelineParts.join('\n\n'), 'SUMMARY');
      }
    }
  }

  /** Legacy (pre-v2) flush — byte-compatible single-buffer behavior. */
  private async flushLegacy(): Promise<void> {
    const count = this.windowCount;
    const detail = this.buffer;
    this.windowCount = 0;
    this.buffer = [];
    if (count === 0) return;

    if (count === 1) {
      const ev = detail[0];
      const topic = this.deps.resolveTopic(ev.session.tmuxSession) ?? this.deps.lifelineTopic();
      if (topic == null) return; // unreachable channel — reap-log (P4) still has it
      await this.deps.send(topic, this.formatSingleLegacy(ev));
      return;
    }

    // Burst → ONE consolidated lifeline message stating the exact total count.
    const topic = this.deps.lifelineTopic();
    if (topic == null) return;
    await this.deps.send(topic, this.formatBurstLegacy(count, detail));
  }

  // ── v2 delivery (R1.3) ───────────────────────────────────────────────

  private nextNoticeId(scope: string | number): string {
    // Charset-clamped for the delivery-id helper: [A-Za-z0-9._-]
    return `${this.now().toString(36)}-${(this.noticeSeq++).toString(36)}-${scope}`;
  }

  private releaseAt(tier: 'IMMEDIATE' | 'SUMMARY'): number {
    const now = this.now();
    let quietEnd: number | null = null;
    try {
      quietEnd = this.deps.quietHoursEndAt?.(now) ?? null;
    } catch {
      // @silent-fallback-ok — unreadable quiet-hours ⇒ no quiet hold: the
      // notice releases SOONER, never later and never lost.
      quietEnd = null;
    }
    if (tier === 'IMMEDIATE') {
      // Never wakes the user: inside quiet hours an IMMEDIATE notice holds to
      // the window's end (a queued resume means the system is already on it).
      return quietEnd ?? now;
    }
    let summaryAt = now;
    try {
      summaryAt = this.deps.summaryReleaseAt?.(now) ?? now;
    } catch {
      summaryAt = now;
    }
    return Math.max(summaryAt, quietEnd ?? 0);
  }

  private async deliver(topicId: number, body: string, tier: 'IMMEDIATE' | 'SUMMARY'): Promise<void> {
    const noticeId = this.nextNoticeId(`t${topicId}`);
    if (!this.opts.drainEnabled || !this.deps.enqueueNotice) {
      // Legacy delivery lever (rollback): direct send, durability claim lapses.
      try {
        await this.deps.send(topicId, body);
      } catch {
        // legacy path is fire-and-forget by definition
      }
      return;
    }
    const releaseAtIso = new Date(this.releaseAt(tier)).toISOString();
    let enqueued = false;
    let enqueueError = '';
    try {
      enqueued = this.deps.enqueueNotice({
        delivery_id: buildReapNotifyDeliveryId(noticeId),
        topic_id: topicId,
        text: body,
        next_attempt_at: releaseAtIso,
      });
    } catch (err) {
      // @silent-fallback-ok — not silent: the captured error drives the
      // enqueue-failed fallback below (direct send + recordNotify outcome +
      // DegradationReporter via reportDegradation).
      enqueued = false;
      enqueueError = err instanceof Error ? err.message : String(err);
    }
    if (enqueued) {
      this.deps.recordNotify?.({ noticeId, topicId, outcome: 'enqueued', detail: `release ${releaseAtIso} (${tier})` });
      return;
    }
    // Enqueue failure (store probe-failed/disabled/threw): degrade LOUDLY to
    // ONE direct immediate send attempt, recorded with the send result (R1.3).
    let sendResult = 'sent-direct';
    try {
      await this.deps.send(topicId, body);
    } catch (err) {
      sendResult = `direct-send-failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.deps.recordNotify?.({
      noticeId,
      topicId,
      outcome: 'enqueue-failed',
      detail: `${enqueueError ? `enqueue: ${enqueueError}; ` : 'enqueue returned false; '}${sendResult}`,
    });
    try {
      this.deps.reportDegradation?.(
        `reap-notice enqueue failed for topic ${topicId}${enqueueError ? ` (${enqueueError})` : ''}`,
        `The durable-delivery guarantee degraded to one direct attempt (${sendResult}).`,
      );
    } catch {
      // degradation reporting is best-effort
    }
  }

  // ── v2 formatting (R1.2 — plain English, no API pointers) ───────────

  private formatTopicNotice(agg: TopicAggregate): string {
    const lines: string[] = [];
    if (agg.count === 1 && agg.detail.length === 1) {
      const ev = agg.detail[0];
      lines.push(`🪦 Your session ${literal(ev.session.name)} was shut down — ${plainEnglishReason(ev.reason)}.`);
      if (ev.midWork) {
        lines.push(`It was in the middle of work when it was stopped.`);
      }
      if (this.safeResumeQueued(ev.session.tmuxSession)) {
        lines.push(`A restart is queued: once the machine has recovered, I'll bring it back to pick the work up.`);
      }
      return lines.join('\n');
    }
    // Multiple reaps on one topic (or detail dropped in a storm): counts first.
    const header = agg.detail.length > 0
      ? `🪦 ${agg.count} of this topic's sessions were shut down:`
      : `🪦 ${agg.count} of this topic's sessions were shut down (details were trimmed in a busy window — every shutdown is still recorded).`;
    lines.push(header);
    for (const ev of agg.detail.slice(-5)) {
      lines.push(`• ${literal(ev.session.name)} — ${plainEnglishReason(ev.reason)}${ev.midWork ? ' (mid-work)' : ''}`);
    }
    if (agg.detail.length > 5) {
      lines.push(`(showing the latest 5 of ${agg.detail.length})`);
    }
    if (agg.midWorkCount > 0) {
      lines.push(`${agg.midWorkCount} ${agg.midWorkCount === 1 ? 'was' : 'were'} mid-work.`);
    }
    if (agg.resumeQueuedCount > 0) {
      lines.push(`${agg.resumeQueuedCount} restart${agg.resumeQueuedCount === 1 ? ' is' : 's are'} queued for when the machine recovers.`);
    }
    return lines.join('\n');
  }

  private formatUnboundNotice(unbound: TopicAggregate): string {
    const lines = [`🪦 ${unbound.count} background session${unbound.count === 1 ? ' was' : 's were'} shut down:`];
    for (const ev of unbound.detail.slice(-5)) {
      lines.push(`• ${literal(ev.session.name)} — ${plainEnglishReason(ev.reason)}${ev.midWork ? ' (mid-work)' : ''}`);
    }
    if (unbound.count > unbound.detail.length) {
      lines.push(`(showing ${Math.min(5, unbound.detail.length)} of ${unbound.count})`);
    }
    return lines.join('\n');
  }

  private formatCrossTopicIndex(affected: Map<number, TopicAggregate>, overflow: number): string {
    const total = [...affected.values()].reduce((n, a) => n + a.count, 0);
    const parts = [...affected.entries()].slice(0, 20).map(([topicId, agg]) => `topic ${topicId} (${agg.count})`);
    const more = affected.size > 20 ? `, +${affected.size - 20} more topics` : '';
    const overflowNote = overflow > 0 ? ` (+${overflow} past the tracking cap)` : '';
    return `Index: ${total} session${total === 1 ? '' : 's'} across ${affected.size} topics${overflowNote} — ${parts.join(', ')}${more}. Each affected topic got its own notice.`;
  }

  // ── Legacy formatting (byte-compatible) ──────────────────────────────

  private formatSingleLegacy(ev: ReapEvent): string {
    return `🪦 Session ${literal(ev.session.name)} was shut down — ${literal(ev.reason)}. `
      + `See the reap-log (\`GET /sessions/reap-log\`) for the full record.`;
  }

  private formatBurstLegacy(count: number, detail: ReapEvent[]): string {
    const lines = detail.map((e) => `• ${literal(e.session.name)} — ${literal(e.reason)}`);
    const shownNote = count > detail.length
      ? `\n\n(showing the latest ${detail.length}; full list in the reap-log)`
      : '';
    return `🪦 ${count} session${count === 1 ? '' : 's'} shut down in the last `
      + `${Math.round(this.opts.coalesceWindowMs / 1000)}s:\n\n`
      + lines.join('\n')
      + shownNote
      + `\n\nFull record: \`GET /sessions/reap-log\`.`;
  }
}
