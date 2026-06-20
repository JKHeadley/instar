/**
 * Feedback webhook retry/backoff decision (L364 — No Unbounded Self-Reinforcing
 * Loops; Responsible Resource).
 *
 * THE BUG THIS FIXES (observed live 2026-06-20, topic 13481): the agent had a
 * backlog of 661 un-forwarded feedback items and a canonical feedback endpoint
 * that was returning 429 (Too Many Requests). `retryUnforwarded()` looped the
 * ENTIRE backlog every scheduled cycle, POSTing all 661, getting 429 on each,
 * marking none forwarded — so the next cycle re-POSTed all 661 again, forever
 * (2,384 429s and climbing). A loop hammering a rate-limited external endpoint
 * with no backoff: bad-citizenship to the external service AND wasted local work
 * that contributed to event-loop pressure.
 *
 * This pure decider answers, per webhook response, three questions:
 *   - markForwarded — did this item land (2xx)?
 *   - breakBatch    — are we rate-limited (429/503)? Then STOP the rest of this
 *                     batch immediately; sending more only makes the 429 worse.
 *   - nextRetryAtMs — don't touch the webhook again until this wall-clock ms
 *                     (honors a Retry-After header, else exponential backoff,
 *                     capped). The caller gates BOTH submit() and the next
 *                     retry cycle on this.
 *
 * Pure + deterministic → fully unit-testable. SIGNAL-style: it decides cadence,
 * it never blocks the local record (the local feedback store is always written).
 */

export interface FeedbackRetryInputs {
  /** `response.ok` — the success signal. Robust: every real fetch Response has it,
   *  and we never depend on a numeric status being present to decide "forwarded". */
  ok: boolean;
  /** HTTP status of the webhook POST, or null on a network/timeout error / absent.
   *  Used ONLY to classify a rate-limit (429/503) for backoff — never for success. */
  status: number | null;
  /** Parsed Retry-After header in seconds, if the server sent one (429/503). */
  retryAfterSec?: number;
  /** Wall clock now (ms). */
  nowMs: number;
  /** Consecutive rate-limit (429/503) responses seen so far (for the exp curve). */
  consecutive429s: number;
  /** Base backoff (ms) for the exponential schedule. Default caller: 60_000. */
  baseBackoffMs?: number;
  /** Cap on the backoff (ms). Default caller: 3_600_000 (1h). */
  maxBackoffMs?: number;
}

export interface FeedbackRetryDecision {
  /** The item forwarded successfully (2xx) → mark it forwarded. */
  markForwarded: boolean;
  /** Rate-limited → STOP this retry batch (do not hammer the remaining items). */
  breakBatch: boolean;
  /** Do not POST the webhook again until this wall-clock ms. 0 = no hold. */
  nextRetryAtMs: number;
  /** New consecutive-429 count for the caller to persist. */
  consecutive429s: number;
  reason: string;
}

const RATE_LIMIT_STATUSES = new Set([429, 503]);

export function decideFeedbackRetry(i: FeedbackRetryInputs): FeedbackRetryDecision {
  const base = i.baseBackoffMs ?? 60_000;
  const cap = i.maxBackoffMs ?? 3_600_000;

  // Success → forwarded, clear any backoff. Driven by response.ok (always present),
  // NOT by a numeric status, so it is robust to any response shape.
  if (i.ok) {
    return {
      markForwarded: true,
      breakBatch: false,
      nextRetryAtMs: 0,
      consecutive429s: 0,
      reason: `forwarded${i.status !== null ? ` (${i.status})` : ''}`,
    };
  }

  // Rate-limited (429) or service-unavailable (503) → back off AND halt the batch.
  if (i.status !== null && RATE_LIMIT_STATUSES.has(i.status)) {
    const n = i.consecutive429s + 1;
    let waitMs: number;
    if (i.retryAfterSec !== undefined && Number.isFinite(i.retryAfterSec) && i.retryAfterSec > 0) {
      waitMs = Math.min(i.retryAfterSec * 1000, cap);
    } else {
      // Exponential from base: base, 2×base, 4×base, … capped.
      waitMs = Math.min(base * 2 ** (n - 1), cap);
    }
    return {
      markForwarded: false,
      breakBatch: true,
      nextRetryAtMs: i.nowMs + waitMs,
      consecutive429s: n,
      reason: `rate-limited (${i.status}) — backing off ${Math.round(waitMs / 1000)}s, batch halted`,
    };
  }

  // Any other non-2xx, or a network/timeout error: leave the item un-forwarded so
  // it retries on the next cycle (today's behavior), but do NOT halt the batch —
  // a per-item error is not a pool-wide rate-limit. PRESERVE the 429 streak (do not
  // reset it): an endpoint flapping between 429 and 500 must keep climbing the
  // exponential curve, not restart it at base on every interleaved 500. Only a
  // genuine 2xx success (above) clears the streak.
  return {
    markForwarded: false,
    breakBatch: false,
    nextRetryAtMs: 0,
    consecutive429s: i.consecutive429s,
    reason: i.status === null ? 'network/timeout error — retry next cycle' : `error ${i.status} — retry next cycle`,
  };
}

/** Parse a Retry-After header value (delta-seconds form only) → seconds | undefined. */
export function parseRetryAfterSeconds(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const n = Number(headerValue.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
