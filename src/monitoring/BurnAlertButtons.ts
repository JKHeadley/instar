/**
 * BurnAlertButtons — principal-bound Telegram inline-button surface for the
 * burn-detection auto-heal system.
 *
 * Phase 5 of docs/specs/token-burn-detection-and-self-heal.md.
 *
 * The convergence audit identified that the original spec's "tap to throttle"
 * button could be tapped by anyone in any Telegram chat the bot was in. The
 * Phase 5 callback handler closes that vector with three layers:
 *
 *   1. **Principal verification**: every callback's `from.id` must be in the
 *      agent's `authorizedUserIds` list (the same list `MessagingToneGate`
 *      and other principal-aware code paths consult).
 *   2. **HMAC signature**: every `callback_data` is signed by the agent's
 *      capability key over the canonical action payload. Forged callback
 *      data fails verification.
 *   3. **Signal-id freshness**: each button carries the signal-id that
 *      produced it; once consumed, the same signal-id cannot be tapped
 *      twice (the spec's "replay reject" requirement).
 *
 * This module is pure logic over a tiny callback_data string. The actual
 * Telegram-wire integration (sending the inline_keyboard with reply_markup,
 * receiving the callback from TelegramAdapter, dispatching to handle())
 * is wired in a follow-up alongside the existing CallbackRegistry pattern
 * in TelegramAdapter.ts.
 */

import crypto from 'node:crypto';
import type { LlmRateGate } from './LlmRateGate.js';

/** The four actions a user can take from a burn alert. */
export type BurnAlertAction =
  | 'release' /* lift the throttle now (was: tap-to-release) */
  | 'snooze-24h' /* "this is fine, mute this key for 24h" */
  | 'extend' /* extend the throttle by another hour */
  | 'investigate'; /* mark for follow-up, no state change */

export interface BurnAlertCallback {
  /** What the user tapped. */
  action: BurnAlertAction;
  /** Which attribution key this button refers to. */
  attributionKey: string;
  /** Signal-id from the originating burn signal (replay prevention). */
  signalId: string;
}

export interface BurnAlertCallbackResult {
  ok: boolean;
  action: BurnAlertAction;
  attributionKey: string;
  reason:
    | 'accepted'
    | 'principal-not-authorized'
    | 'invalid-signature'
    | 'signal-id-replayed'
    | 'malformed-payload'
    | 'snooze-recorded'
    | 'extend-failed-not-throttled';
  /** Human-readable status to feed back to the Telegram user. */
  userMessage: string;
}

export interface BurnAlertButtonsDeps {
  /** HMAC key to sign + verify callback_data. */
  capabilityKey: Buffer;
  /** Authorized user IDs — same list MessagingToneGate consults. */
  authorizedUserIds: number[];
  /** The LlmRateGate; release/extend mutate throttles. */
  gate: LlmRateGate;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Snooze TTL (default 24h). */
  snoozeDurationMs?: number;
}

const DEFAULT_SNOOZE_MS = 24 * 60 * 60 * 1000;

export class BurnAlertButtons {
  private readonly capabilityKey: Buffer;
  private readonly authorizedUserIds: Set<number>;
  private readonly gate: LlmRateGate;
  private readonly now: () => number;
  private readonly snoozeDurationMs: number;
  /** Consumed signal-ids per button — guards against replay. */
  private readonly consumed = new Map<string, number>();
  /** Snoozed attribution keys → snooze-expires-at (ms). Inspected by the runbook before throttling. */
  private readonly snoozed = new Map<string, number>();

  constructor(deps: BurnAlertButtonsDeps) {
    this.capabilityKey = deps.capabilityKey;
    this.authorizedUserIds = new Set(deps.authorizedUserIds);
    this.gate = deps.gate;
    this.now = deps.now ?? (() => Date.now());
    this.snoozeDurationMs = deps.snoozeDurationMs ?? DEFAULT_SNOOZE_MS;
  }

  /**
   * Generate the signed payload for one button. The opaque callback_data
   * string is what the Telegram inline button carries. The button shape
   * itself (text label, button row layout) is the caller's job — they get
   * the payload, they pass it to Telegram's reply_markup.
   */
  encodeCallbackData(payload: BurnAlertCallback): string {
    const canonical = this.canonicalize(payload);
    const sig = crypto
      .createHmac('sha256', this.capabilityKey)
      .update(canonical)
      .digest('hex')
      .slice(0, 16);
    // Compact encoding for Telegram's 64-byte callback_data limit. Format:
    // <action>|<attributionKey>|<signalId>|<sig>
    return `${payload.action}|${payload.attributionKey}|${payload.signalId}|${sig}`;
  }

  /**
   * Build a four-button keyboard row for a burn alert. Returns the inline
   * objects the caller can pass to Telegram's reply_markup.inline_keyboard.
   */
  buildKeyboard(attributionKey: string, signalId: string): Array<{ text: string; callback_data: string }> {
    return [
      { text: 'Release', callback_data: this.encodeCallbackData({ action: 'release', attributionKey, signalId }) },
      { text: 'Snooze 24h', callback_data: this.encodeCallbackData({ action: 'snooze-24h', attributionKey, signalId }) },
      { text: 'Extend +1h', callback_data: this.encodeCallbackData({ action: 'extend', attributionKey, signalId }) },
      { text: 'Investigate', callback_data: this.encodeCallbackData({ action: 'investigate', attributionKey, signalId }) },
    ];
  }

  /**
   * Handle a Telegram callback. Returns a structured result the caller can
   * use to log the audit trail and answer the Telegram callback query.
   */
  handle(input: { callbackData: string; fromUserId: number }): BurnAlertCallbackResult {
    const parsed = this.parseCallbackData(input.callbackData);
    if (!parsed) {
      return {
        ok: false,
        action: 'investigate',
        attributionKey: '',
        reason: 'malformed-payload',
        userMessage: 'I could not parse that button.',
      };
    }

    // 1. Principal check.
    if (!this.authorizedUserIds.has(input.fromUserId)) {
      return {
        ok: false,
        action: parsed.action,
        attributionKey: parsed.attributionKey,
        reason: 'principal-not-authorized',
        userMessage: 'You are not authorized to act on this agent.',
      };
    }

    // 2. Signature check.
    const expectedSig = crypto
      .createHmac('sha256', this.capabilityKey)
      .update(this.canonicalize(parsed))
      .digest('hex')
      .slice(0, 16);
    if (parsed.sig !== expectedSig) {
      return {
        ok: false,
        action: parsed.action,
        attributionKey: parsed.attributionKey,
        reason: 'invalid-signature',
        userMessage: 'That button signature did not match. Refusing.',
      };
    }

    // 3. Freshness check. The same signal-id-action pair can fire at most once.
    const consumptionKey = `${parsed.action}|${parsed.signalId}`;
    if (this.consumed.has(consumptionKey)) {
      return {
        ok: false,
        action: parsed.action,
        attributionKey: parsed.attributionKey,
        reason: 'signal-id-replayed',
        userMessage: 'That button has already been used.',
      };
    }
    this.consumed.set(consumptionKey, this.now());
    this.gcConsumed();

    // 4. Apply the action.
    switch (parsed.action) {
      case 'release': {
        const released = this.gate.revokeThrottle(parsed.attributionKey);
        return {
          ok: true,
          action: 'release',
          attributionKey: parsed.attributionKey,
          reason: 'accepted',
          userMessage: released
            ? `Released the throttle on ${parsed.attributionKey}.`
            : `No throttle was active for ${parsed.attributionKey} — nothing to release.`,
        };
      }
      case 'snooze-24h': {
        this.snoozed.set(parsed.attributionKey, this.now() + this.snoozeDurationMs);
        this.gate.revokeThrottle(parsed.attributionKey);
        return {
          ok: true,
          action: 'snooze-24h',
          attributionKey: parsed.attributionKey,
          reason: 'snooze-recorded',
          userMessage: `Snoozed ${parsed.attributionKey} for 24 hours. The runbook will not throttle this key during that window.`,
        };
      }
      case 'extend': {
        // Re-install throttle for another hour using a fresh signalId derived
        // from "extend|<existing signalId>". Returns a structured error if no
        // throttle is currently active.
        const active = this.gate.listActiveThrottles().find((t) => t.attributionKey === parsed.attributionKey);
        if (!active) {
          return {
            ok: false,
            action: 'extend',
            attributionKey: parsed.attributionKey,
            reason: 'extend-failed-not-throttled',
            userMessage: `Cannot extend — no active throttle on ${parsed.attributionKey}.`,
          };
        }
        const extendSignalId = `extend:${parsed.signalId}:${this.now()}`;
        const extendDurationMs = 60 * 60 * 1000;
        const tok = this.gate.computeCapabilityToken({
          attributionKey: parsed.attributionKey,
          durationMs: extendDurationMs,
          issuer: active.issuer,
          signalId: extendSignalId,
        }) ?? undefined;
        try {
          this.gate.installThrottle({
            attributionKey: parsed.attributionKey,
            durationMs: extendDurationMs,
            reason: `User-initiated extension via Telegram button.`,
            issuer: active.issuer,
            signalId: extendSignalId,
            capabilityToken: tok,
          });
        } catch (err) {
          return {
            ok: false,
            action: 'extend',
            attributionKey: parsed.attributionKey,
            reason: 'extend-failed-not-throttled',
            userMessage: `Could not extend: ${(err as Error).message}`,
          };
        }
        return {
          ok: true,
          action: 'extend',
          attributionKey: parsed.attributionKey,
          reason: 'accepted',
          userMessage: `Extended the throttle on ${parsed.attributionKey} for another hour.`,
        };
      }
      case 'investigate': {
        // No state change; this is purely for audit. The user is saying "I'm
        // looking at this one". The agent records it but otherwise stands by.
        return {
          ok: true,
          action: 'investigate',
          attributionKey: parsed.attributionKey,
          reason: 'accepted',
          userMessage: `Logged. ${parsed.attributionKey} marked for follow-up.`,
        };
      }
    }
  }

  /**
   * Read-side: is this attribution key currently snoozed? Called by the
   * runbook before installing a throttle. Auto-expires entries.
   */
  isSnoozed(attributionKey: string): boolean {
    const expires = this.snoozed.get(attributionKey);
    if (!expires) return false;
    if (this.now() >= expires) {
      this.snoozed.delete(attributionKey);
      return false;
    }
    return true;
  }

  /** For tests + dashboard. */
  listSnoozes(): Array<{ attributionKey: string; expiresAt: string }> {
    const out: Array<{ attributionKey: string; expiresAt: string }> = [];
    for (const [key, expires] of this.snoozed.entries()) {
      if (this.now() < expires) {
        out.push({ attributionKey: key, expiresAt: new Date(expires).toISOString() });
      } else {
        this.snoozed.delete(key);
      }
    }
    return out;
  }

  private canonicalize(payload: BurnAlertCallback): string {
    return `${payload.action}|${payload.attributionKey}|${payload.signalId}`;
  }

  private parseCallbackData(s: string): (BurnAlertCallback & { sig: string }) | null {
    const parts = s.split('|');
    if (parts.length !== 4) return null;
    const action = parts[0] as BurnAlertAction;
    if (!['release', 'snooze-24h', 'extend', 'investigate'].includes(action)) return null;
    if (!parts[1] || !parts[2] || !parts[3]) return null;
    return {
      action,
      attributionKey: parts[1],
      signalId: parts[2],
      sig: parts[3],
    };
  }

  /** GC consumed signal-id-action pairs older than 24h. */
  private gcConsumed(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    for (const [key, ts] of this.consumed.entries()) {
      if (ts < cutoff) this.consumed.delete(key);
    }
  }
}
