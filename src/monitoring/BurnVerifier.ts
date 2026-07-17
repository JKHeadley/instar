/**
 * BurnVerifier — post-throttle verification + follow-up alerts.
 *
 * Phase 6 (final phase) of docs/specs/token-burn-detection-and-self-heal.md.
 * Five minutes after the runbook installs a throttle, this module re-samples
 * the token-ledger telemetry for the affected attribution_key. If the
 * post-throttle rate dropped materially, a structured "I caught it, I
 * slowed it down, here's the before-and-after" Telegram message goes out
 * (the umbrella spec's "fixed, here's the before/after" follow-up shape).
 *
 * If the post-throttle rate did NOT drop, the verifier escalates: the
 * throttle was pointed at the wrong key, or the path doesn't honour the
 * gate. Operator gets a "I tried but it did not work" message with the
 * specific shape that distinguishes from "I caught it" so they know to
 * intervene manually.
 *
 * Pure timer + telemetry-read; no LLM calls (the umbrella spec's
 * §"Why it's safe — What if the watcher itself burns tokens?" guarantee).
 */

import type { TokenLedger } from './TokenLedger.js';
import type { RunbookOutcome } from './BurnThrottleRunbook.js';
import type { DegradationEvent } from './DegradationReporter.js';

const DEFAULT_SUCCESS_RATIO = 0.5;
const DEFAULT_VERIFY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_SAMPLE_WINDOW_MS = 5 * 60 * 1000;

export interface VerificationResult {
  attributionKey: string;
  preThrottleRate: number;
  postThrottleRate: number;
  ratio: number;
  successfullyThrottled: boolean;
  verifiedAt: string;
}

export interface BurnVerifierDeps {
  ledger: Pick<TokenLedger, 'byAttributionKey'>;
  sendTelegram?: (topicId: number, text: string) => void | Promise<void>;
  alertTopicId?: number;
  now?: () => number;
  config?: {
    verifyDelayMs?: number;
    sampleWindowMs?: number;
    successRatio?: number;
  };
  schedule?: (cb: () => void, delayMs: number) => void;
}

export class BurnVerifier {
  private readonly ledger: BurnVerifierDeps['ledger'];
  private readonly sendTelegram: ((topicId: number, text: string) => void | Promise<void>) | undefined;
  private readonly alertTopicId: number;
  private readonly now: () => number;
  private readonly verifyDelayMs: number;
  private readonly sampleWindowMs: number;
  private readonly successRatio: number;
  private readonly schedule: (cb: () => void, delayMs: number) => void;

  constructor(deps: BurnVerifierDeps) {
    this.ledger = deps.ledger;
    this.sendTelegram = deps.sendTelegram;
    this.alertTopicId = deps.alertTopicId ?? 8615;
    this.now = deps.now ?? (() => Date.now());
    this.verifyDelayMs = deps.config?.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
    this.sampleWindowMs = deps.config?.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS;
    this.successRatio = deps.config?.successRatio ?? DEFAULT_SUCCESS_RATIO;
    this.schedule = deps.schedule ?? ((cb, delayMs) => {
      const t = setTimeout(cb, delayMs);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
    });
  }

  /**
   * Called by the subscriber when the runbook installs a throttle. Pulls
   * the pre-throttle rate from the originating event, schedules a re-sample
   * after `verifyDelayMs`, and on fire sends the structured follow-up.
   */
  scheduleVerification(outcome: RunbookOutcome, event: DegradationEvent): void {
    if (outcome.kind !== 'throttle-installed') return;
    const preThrottleRate = extractTokensLast1h(event);
    const attributionKey = outcome.attributionKey;

    this.schedule(() => {
      try {
        this.runVerification(attributionKey, preThrottleRate);
      } catch (err) {
        console.warn(`[burn-verifier] verification threw (non-fatal): ${(err as Error).message}`);
      }
    }, this.verifyDelayMs);
  }

  /**
   * Run the verification re-sample. Exposed for tests + the manual-rerun
   * surface (Phase 6+ dashboard control).
   */
  runVerification(attributionKey: string, preThrottleRate: number): VerificationResult {
    const sinceMs = this.now() - this.sampleWindowMs;
    const rows = this.ledger.byAttributionKey({ sinceMs });
    const row = rows.find((r) => r.attributionKey === attributionKey);
    const postThrottleTokens = row ? (row.freshTokens ?? row.totalTokens) : 0;
    const postThrottleRate = postThrottleTokens * (60 * 60 * 1000 / this.sampleWindowMs);
    const ratio = preThrottleRate > 0 ? postThrottleRate / preThrottleRate : 0;
    const successfullyThrottled = ratio < this.successRatio;

    const result: VerificationResult = {
      attributionKey,
      preThrottleRate,
      postThrottleRate,
      ratio,
      successfullyThrottled,
      verifiedAt: new Date(this.now()).toISOString(),
    };
    this.fireFollowUp(result);
    return result;
  }

  private fireFollowUp(r: VerificationResult): void {
    const friendlyName = humanize(r.attributionKey);
    const text = r.successfullyThrottled
      ? `Caught and contained. ${friendlyName}: before the slowdown it was running at about ` +
        `${formatRate(r.preThrottleRate)}; now it is running at about ${formatRate(r.postThrottleRate)} ` +
        `— a ${formatReduction(r.ratio)} drop. The throttle will lift on its own at the configured time, ` +
        `or you can release it sooner from the original alert.`
      : `Slowdown did not take effect. I tried to slow ${friendlyName} down, but the rate did ` +
        `not drop (was ${formatRate(r.preThrottleRate)}, still at ${formatRate(r.postThrottleRate)}). ` +
        `This usually means one of two things: the attribution is pointing at the wrong code path ` +
        `and the real offender is elsewhere, or the offending path does not honour the slowdown. ` +
        `You may need to look at this one manually.`;
    this.fireTelegram(text);
  }

  private fireTelegram(text: string): void {
    if (!this.sendTelegram) return;
    try {
      void this.sendTelegram(this.alertTopicId, text);
    } catch {
      // Intentional swallow.
    }
  }
}

/* ---------- pure helpers ---------- */

export function extractTokensLast1h(event: DegradationEvent): number {
  const baselineM = /last-1h rate ([\d,]+)\s*tok\/h/.exec(event.reason || '');
  if (baselineM && baselineM[1]) {
    return Number(baselineM[1].replace(/,/g, ''));
  }
  const projectedM = /Projected ([\d,]+) tokens in next 24h/.exec(event.impact || '');
  if (projectedM && projectedM[1]) {
    return Number(projectedM[1].replace(/,/g, '')) / 24;
  }
  return 0;
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

function formatRate(tokensPerHour: number): string {
  if (tokensPerHour >= 1_000_000) return `${(tokensPerHour / 1_000_000).toFixed(1)} million tokens per hour`;
  if (tokensPerHour >= 1_000) return `${(tokensPerHour / 1_000).toFixed(1)} thousand tokens per hour`;
  return `${Math.round(tokensPerHour)} tokens per hour`;
}

function formatReduction(ratio: number): string {
  const pct = Math.round((1 - ratio) * 100);
  return `${pct}%`;
}
