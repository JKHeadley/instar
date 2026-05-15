/**
 * BurnThrottleRunbook — Tier-2 authority surface for burn-detection signals.
 *
 * Phase 4 of docs/specs/token-burn-detection-and-self-heal.md. This is the
 * ONLY blocking surface in the burn-detection pipeline. The BurnDetector
 * (Phase 3) emits structured signals via DegradationReporter; this runbook
 * subscribes via the existing handler hook and decides:
 *   - alert-only (default for `unknown::*` keys and any caller config disables)
 *   - throttle (default for known component names)
 *   - both (the umbrella spec's primary policy)
 *
 * Authority shape (per umbrella spec §"Signal-vs-Authority Decomposition"):
 * the runbook is the only piece in this pipeline with blocking authority.
 * The detector emits; the gate enforces; the runbook decides.
 *
 * Self-reinforcing-loop guard: the runbook never throttles a key starting
 * with `burn-throttle-runbook::*` — defence-in-depth (the gate also refuses
 * to install such throttles, the detector also exempts the prefix). This
 * three-layer guard is from the convergence audit.
 */

import { LlmRateGate, type InstalledThrottle } from './LlmRateGate.js';
import type { DegradationEvent } from './DegradationReporter.js';

export interface BurnThrottleConfig {
  /** Whether to auto-throttle (true) or alert-only (false). Default true. */
  autoThrottle: boolean;
  /**
   * Whether to auto-throttle keys with no known component (`unknown::*`).
   * Default false — the umbrella spec is conservative here: an unknown key
   * may be a user extension the agent doesn't recognise, and throttling
   * something the agent doesn't understand can break user workflows.
   * Operators opt in to auto-throttle on unknown explicitly.
   */
  autoThrottleOnUnknown: boolean;
  /** Throttle duration (default 60min). */
  throttleDurationMs: number;
}

export const DEFAULT_BURN_THROTTLE_CONFIG: BurnThrottleConfig = {
  autoThrottle: true,
  autoThrottleOnUnknown: false,
  throttleDurationMs: 60 * 60 * 1000,
};

export type RunbookOutcomeKind =
  | 'alert-only-unknown'
  | 'alert-only-config-disabled'
  | 'alert-only-self-attribution'
  | 'throttle-installed'
  | 'throttle-failed';

export interface RunbookOutcome {
  kind: RunbookOutcomeKind;
  attributionKey: string;
  decidedAt: string;
  trigger: string;
  /** When kind === 'throttle-installed', the actually-installed throttle. */
  throttle?: InstalledThrottle;
  /** Free-text reason for the decision. */
  reason: string;
}

/** Telegram emit function. Phase 5 upgrades to principal-bound buttons. */
export type TelegramAlertSender = (topicId: number, text: string) => void | Promise<void>;

export interface BurnThrottleRunbookDeps {
  gate: LlmRateGate;
  config?: Partial<BurnThrottleConfig>;
  /** Telegram emit. Optional — when missing, decisions still happen, just no alert. */
  sendTelegram?: TelegramAlertSender;
  /** Telegram topic ID for alerts. */
  alertTopicId?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Identity tag the runbook uses when installing throttles. */
export const RUNBOOK_ISSUER = 'burn-throttle-runbook';

export class BurnThrottleRunbook {
  private readonly gate: LlmRateGate;
  private readonly config: BurnThrottleConfig;
  private readonly sendTelegram: TelegramAlertSender | undefined;
  private readonly alertTopicId: number;
  private readonly now: () => number;

  constructor(deps: BurnThrottleRunbookDeps) {
    this.gate = deps.gate;
    this.config = { ...DEFAULT_BURN_THROTTLE_CONFIG, ...(deps.config ?? {}) };
    this.sendTelegram = deps.sendTelegram;
    this.alertTopicId = deps.alertTopicId ?? 8615;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Handle a burn-detection signal. Called from a subscriber hook on
   * DegradationReporter for feature='token-burn-detection' events.
   *
   * Returns the outcome so tests + audit + the verification step (Phase 6)
   * can inspect what happened.
   */
  handle(event: DegradationEvent): RunbookOutcome {
    const attributionKey = extractAttributionKey(event);
    const trigger = extractTrigger(event);
    const decidedAt = new Date(this.now()).toISOString();
    const signalId = `${event.timestamp}:${attributionKey}`;

    // 1. Self-attribution: refuse to throttle the runbook itself, AND emit
    //    a high-severity escalation alert. Per Phase 4 second-pass review §3:
    //    silent swallow is the wrong response here — if the runbook itself
    //    is being attributed-to as a burn source, something is structurally
    //    wrong (a bug in the runbook's own LLM-bound code, or attribution
    //    being mis-applied to a legitimate runbook call). Either way, that's
    //    exactly the case a user needs to know about. So we DO send Telegram.
    if (attributionKey.startsWith(`${RUNBOOK_ISSUER}::`)) {
      this.fireTelegram(
        `URGENT: the burn-throttle runbook itself is being flagged as a burn source ` +
        `(${attributionKey}). I refused to throttle myself by design, but this likely ` +
        `means either the runbook has a bug producing too many LLM calls, or attribution ` +
        `is being mis-applied to legitimate runbook work. Please investigate.`,
      );
      return {
        kind: 'alert-only-self-attribution',
        attributionKey,
        decidedAt,
        trigger,
        reason: 'Refusing to throttle the runbook itself (self-reinforcing-loop guard); escalation alert sent.',
      };
    }

    // Compose the alert text now so we send it regardless of throttle outcome.
    const alertText = composeAlertText(event, attributionKey, trigger);

    // 2. Caller config disables auto-throttle.
    if (!this.config.autoThrottle) {
      this.fireTelegram(alertText);
      return {
        kind: 'alert-only-config-disabled',
        attributionKey,
        decidedAt,
        trigger,
        reason: 'autoThrottle is disabled in config; alert sent but no throttle installed.',
      };
    }

    // 3. Unknown attribution + caller has not opted in to auto-throttle on unknown.
    if (isUnknownKey(attributionKey) && !this.config.autoThrottleOnUnknown) {
      this.fireTelegram(alertText);
      return {
        kind: 'alert-only-unknown',
        attributionKey,
        decidedAt,
        trigger,
        reason: 'Attribution key has no known component; operator must opt in to auto-throttle on unknown.',
      };
    }

    // 4. Install throttle, send alert.
    const token = this.gate.computeCapabilityToken({
      attributionKey,
      durationMs: this.config.throttleDurationMs,
      issuer: RUNBOOK_ISSUER,
      signalId,
    }) ?? undefined;

    try {
      const throttle = this.gate.installThrottle({
        attributionKey,
        durationMs: this.config.throttleDurationMs,
        reason: `${trigger} trigger crossed threshold; runbook installed bounded throttle.`,
        issuer: RUNBOOK_ISSUER,
        signalId,
        capabilityToken: token,
      });
      this.fireTelegram(`${alertText}\n\nI have slowed this component down. It will resume automatically in ${Math.round(this.config.throttleDurationMs / 60000)} minutes, or you can reply STOP to release it sooner.`);
      return {
        kind: 'throttle-installed',
        attributionKey,
        decidedAt,
        trigger,
        throttle,
        reason: 'Throttle installed, alert sent.',
      };
    } catch (err) {
      this.fireTelegram(`${alertText}\n\nI tried to slow it down automatically but the slowdown did not take effect. You may need to look at this one.`);
      return {
        kind: 'throttle-failed',
        attributionKey,
        decidedAt,
        trigger,
        reason: `Throttle install failed: ${(err as Error).message}`,
      };
    }
  }

  private fireTelegram(text: string): void {
    if (!this.sendTelegram) return;
    try {
      // Caller may return a promise; we don't await — the runbook is on the
      // signal-handling hot path and must not block. Errors are swallowed:
      // a failed alert can't block the throttle decision, which is the
      // important part.
      void this.sendTelegram(this.alertTopicId, text);
    } catch {
      // Intentional swallow.
    }
  }
}

/* ---------- pure helpers (exported for tests) ---------- */

/**
 * Extract the attribution key from a burn-detection DegradationEvent. The
 * BurnDetector formats the `primary` field as "attribution_key <KEY>
 * sustained spend within thresholds" — we parse it back here. The wire
 * shape is internal to the burn-detection pipeline; if it changes, change
 * both ends in the same PR.
 */
export function extractAttributionKey(event: DegradationEvent): string {
  const m = /attribution_key\s+(\S+)/.exec(event.primary || '');
  return m && m[1] ? m[1] : 'unknown::no-key';
}

/**
 * Extract the trigger label from the event's reason field. Returns
 * 'absolute-share' or 'baseline-divergence' or 'unknown-trigger'.
 */
export function extractTrigger(event: DegradationEvent): string {
  if (/% of 24h spend/.test(event.reason || '')) return 'absolute-share';
  if (/baseline/i.test(event.reason || '')) return 'baseline-divergence';
  return 'unknown-trigger';
}

/** Is the attribution key one of the unknown::* fallback shapes? */
export function isUnknownKey(attributionKey: string): boolean {
  return attributionKey.startsWith('unknown::');
}

/** Compose the ELI16 alert text for Telegram. No backticks, no camelCase config keys, narrative tone. */
export function composeAlertText(event: DegradationEvent, attributionKey: string, trigger: string): string {
  const friendlyName = humanize(attributionKey);
  const triggerNarrative =
    trigger === 'absolute-share'
      ? 'is using more than a quarter of the agent\'s total token budget over the last day'
      : trigger === 'baseline-divergence'
      ? 'has more than doubled its normal rate in the last hour, and the absolute amount is large enough to matter'
      : 'crossed one of the burn thresholds';
  return (
    `Heads up: ${friendlyName} ${triggerNarrative}.\n\n` +
    `${event.reason}\n\n` +
    `${event.impact}`
  );
}

function humanize(attributionKey: string): string {
  if (attributionKey.startsWith('unknown::')) return 'an unknown component';
  if (attributionKey.startsWith('user-job:')) {
    const m = /^user-job:([^:]+)/.exec(attributionKey);
    return m ? `your scheduled job "${m[1]}"` : 'a scheduled job';
  }
  if (attributionKey.startsWith('user-hook:')) {
    const m = /^user-hook:([^:]+)/.exec(attributionKey);
    return m ? `your hook "${m[1]}"` : 'a hook';
  }
  const m = /^([^:]+)::/.exec(attributionKey);
  return m ? `the ${m[1]} component` : attributionKey;
}
