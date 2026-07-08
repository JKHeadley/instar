/**
 * TelegramSpendTopicChannel — the Increment-C concrete AlertChannel (FD-6):
 * delivers each already-deduped/coalesced spend alert as a MESSAGE into the
 * ONE dedicated "💰 Routing & Spend Alerts" topic, resolved through the
 * SpendAlertResolver ladder (operator-configured id → pool-published/persisted
 * record → fenced serving-lease-holder-only create-once), with the LIFELINE as
 * the single named emergency fallback.
 *
 * Money-critical deliveries (G5 hardened) prefer the DURABLE relay
 * (PendingRelayStore + DeliveryFailureSentinel — delivery-robustness Layers
 * 2/3) via the injected enqueue: retry-until-delivered instead of
 * fire-and-forget, and the dispatcher's edge latch only sets on a CONFIRMED /
 * durably-queued outcome. When no durable enqueue is wired (single-process
 * tests, lean installs) it degrades to direct send + lifeline fallback.
 *
 * Repoint audibility (G5): when the operator-configured topic id CHANGES, the
 * channel posts a one-line "spend alerts now route to <topic>" confirmation
 * into BOTH the old topic (if still resolvable) and the new one, and audits the
 * repoint — a Bearer-level actor cannot SILENTLY redirect the operator's money
 * alerts (the knob still cannot touch money admission).
 */

import crypto from 'node:crypto';
import type { AlertChannel } from './SpendAlertDispatcher.js';
import type { SpendAlertResolver } from './SpendAlertResolver.js';

export interface TelegramSpendTopicChannelDeps {
  resolver: SpendAlertResolver;
  /** Direct Telegram send; resolves true on confirmed delivery. */
  sendToTopic: (topicId: number, text: string) => Promise<boolean>;
  /** The always-existing system topic (emergency fallback). */
  lifelineTopicId: () => number | undefined;
  /**
   * OPTIONAL durable-relay enqueue (PendingRelayStore). Returns true when the
   * message is durably queued (retry-until-delivered — counts as handled).
   */
  enqueueDurable?: (topicId: number, text: string) => boolean;
  /** Scrubbed observability sink (shares the dispatcher's jsonl). */
  audit?: (entry: Record<string, unknown>) => void;
}

export class TelegramSpendTopicChannel implements AlertChannel {
  readonly id = 'telegram';
  private readonly d: TelegramSpendTopicChannelDeps;
  /** The configured id seen last delivery — repoint detection (G5). */
  private lastConfiguredId: number | undefined;

  constructor(deps: TelegramSpendTopicChannelDeps) {
    this.d = deps;
  }

  async deliver(text: string, moneyCritical: boolean): Promise<'sent' | 'sent-lifeline' | 'queued-durable' | 'failed'> {
    await this.announceRepointIfChanged();
    const topicId = await this.d.resolver.resolveTopicId();
    if (topicId !== undefined) {
      // Money-critical: durable relay FIRST (retry-until-delivered).
      if (moneyCritical && this.d.enqueueDurable) {
        try {
          if (this.d.enqueueDurable(topicId, text)) {
            this.d.audit?.({ channel: this.id, outcome: 'queued-durable', topicId });
            return 'queued-durable';
          }
        } catch {
          // @silent-fallback-ok: a relay enqueue failure falls through to the
          // direct send + lifeline ladder below — delivery degrades, never dies.
        }
      }
      try {
        if (await this.d.sendToTopic(topicId, text)) return 'sent';
      } catch {
        // @silent-fallback-ok: a set-but-wrong/deleted topic id is a FALLBACK
        // case, not a black hole — the lifeline path below is the designed
        // continuation (G5), and the terminal outcome is audited by the caller.
      }
    }
    const lifeline = this.d.lifelineTopicId();
    if (lifeline !== undefined) {
      // Money-critical: even the lifeline leg prefers the durable relay.
      if (moneyCritical && this.d.enqueueDurable) {
        try {
          if (this.d.enqueueDurable(lifeline, text)) return 'queued-durable';
        } catch {
          // @silent-fallback-ok: same degradation ladder as above.
        }
      }
      try {
        if (await this.d.sendToTopic(lifeline, text)) return 'sent-lifeline';
      } catch {
        // @silent-fallback-ok: terminal 'failed' is returned below and the
        // dispatcher leaves the alert UN-latched (eligible for re-send).
      }
    }
    return 'failed';
  }

  /** G5: a changed operator-configured id is made AUDIBLE, never silent. */
  private async announceRepointIfChanged(): Promise<void> {
    let configured: number | undefined;
    try {
      configured = this.d.resolver.configuredTopicIdForRepointCheck();
    } catch {
      return; // @silent-fallback-ok: repoint detection is best-effort observability
    }
    if (configured === this.lastConfiguredId) return;
    const old = this.lastConfiguredId;
    this.lastConfiguredId = configured;
    if (old === undefined || configured === undefined) return; // first observation / unset — nothing to announce
    const note = `🔀 Spend alerts now route to topic ${configured} (was ${old}). If you didn't change routingSpend.alerts.telegramTopicId, check your config.`;
    this.d.audit?.({ channel: this.id, outcome: 'repoint', from: old, to: configured });
    // Both topics, best-effort — the announcement must never block a delivery.
    await Promise.allSettled([this.d.sendToTopic(old, note), this.d.sendToTopic(configured, note)]);
  }
}

/** Deterministic delivery id for the durable relay (idempotent enqueue). */
export function spendAlertDeliveryId(topicId: number, text: string): string {
  return 'spend-alert:' + crypto.createHash('sha256').update(`${topicId}|${text}`).digest('hex').slice(0, 24);
}
