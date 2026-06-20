/**
 * Feedback webhook 429-backoff decider (L364). Proves: success clears backoff;
 * 429/503 halts the batch + sets exponential backoff; Retry-After is honored and
 * capped; other errors retry-next-cycle without halting; Retry-After parsing.
 */

import { describe, it, expect } from 'vitest';
import { decideFeedbackRetry, parseRetryAfterSeconds, type FeedbackRetryInputs } from '../../src/core/feedbackBackoff.js';

const base: FeedbackRetryInputs = { ok: true, status: 200, nowMs: 1_000_000, consecutive429s: 0 };
// Derive `ok` from the status under test unless a case sets it explicitly — mirrors a
// real fetch Response where response.ok === (status in 200..299).
const d = (o: Partial<FeedbackRetryInputs>) => {
  const status = o.status !== undefined ? o.status : base.status;
  const ok = o.ok !== undefined ? o.ok : status !== null && status >= 200 && status < 300;
  return decideFeedbackRetry({ ...base, ...o, ok });
};

describe('decideFeedbackRetry', () => {
  it('2xx → forwarded, backoff cleared', () => {
    const v = d({ status: 204, consecutive429s: 5 });
    expect(v.markForwarded).toBe(true);
    expect(v.breakBatch).toBe(false);
    expect(v.nextRetryAtMs).toBe(0);
    expect(v.consecutive429s).toBe(0); // streak reset
  });

  it('429 → NOT forwarded, batch HALTED, backoff set, streak incremented', () => {
    const v = d({ status: 429, consecutive429s: 0 });
    expect(v.markForwarded).toBe(false);
    expect(v.breakBatch).toBe(true);
    expect(v.consecutive429s).toBe(1);
    expect(v.nextRetryAtMs).toBe(1_000_000 + 60_000); // base 60s on first 429
  });

  it('503 is treated as rate-limit too (halt + backoff)', () => {
    const v = d({ status: 503 });
    expect(v.breakBatch).toBe(true);
    expect(v.nextRetryAtMs).toBeGreaterThan(1_000_000);
  });

  it('exponential backoff grows with the 429 streak, capped at maxBackoffMs', () => {
    expect(d({ status: 429, consecutive429s: 0 }).nextRetryAtMs).toBe(1_000_000 + 60_000);   // 60s
    expect(d({ status: 429, consecutive429s: 1 }).nextRetryAtMs).toBe(1_000_000 + 120_000);  // 120s
    expect(d({ status: 429, consecutive429s: 2 }).nextRetryAtMs).toBe(1_000_000 + 240_000);  // 240s
    // huge streak → capped at 1h default, not unbounded
    expect(d({ status: 429, consecutive429s: 50 }).nextRetryAtMs).toBe(1_000_000 + 3_600_000);
  });

  it('Retry-After header is honored (and capped) over the exponential schedule', () => {
    const v = d({ status: 429, retryAfterSec: 30, consecutive429s: 3 });
    expect(v.nextRetryAtMs).toBe(1_000_000 + 30_000); // 30s from header, not 480s from streak
    // an absurd Retry-After is still capped
    const capped = d({ status: 429, retryAfterSec: 999_999, maxBackoffMs: 600_000 });
    expect(capped.nextRetryAtMs).toBe(1_000_000 + 600_000);
  });

  it('other 4xx/5xx → retry next cycle, batch NOT halted, no backoff, streak PRESERVED', () => {
    const v = d({ status: 500, consecutive429s: 2 });
    expect(v.markForwarded).toBe(false);
    expect(v.breakBatch).toBe(false);
    expect(v.nextRetryAtMs).toBe(0);
    expect(v.consecutive429s).toBe(2); // preserved — a flapping 429/500 endpoint keeps climbing the curve
  });

  it('only a genuine 2xx clears the 429 streak (flap protection)', () => {
    // 429 streak of 3 → a 500 preserves it → the next 429 backs off from streak 4, not 1.
    const afterErr = d({ status: 500, consecutive429s: 3 });
    expect(afterErr.consecutive429s).toBe(3);
    const next429 = d({ status: 429, consecutive429s: afterErr.consecutive429s });
    expect(next429.nextRetryAtMs).toBe(1_000_000 + Math.min(60_000 * 2 ** 3, 3_600_000)); // 480s, not 60s
    // a real success resets it
    expect(d({ status: 200, consecutive429s: 9 }).consecutive429s).toBe(0);
  });

  it('network/timeout error (status null) → retry next cycle, no halt', () => {
    const v = d({ status: null });
    expect(v.markForwarded).toBe(false);
    expect(v.breakBatch).toBe(false);
    expect(v.reason).toMatch(/network\/timeout/i);
  });

  it('a zero/negative Retry-After is ignored (falls back to exponential)', () => {
    expect(d({ status: 429, retryAfterSec: 0 }).nextRetryAtMs).toBe(1_000_000 + 60_000);
    expect(d({ status: 429, retryAfterSec: -5 }).nextRetryAtMs).toBe(1_000_000 + 60_000);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterSeconds('120')).toBe(120);
    expect(parseRetryAfterSeconds(' 45 ')).toBe(45);
    expect(parseRetryAfterSeconds('0')).toBe(0);
  });
  it('rejects junk / absent / negative', () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined(); // HTTP-date form unsupported → undefined (safe)
    expect(parseRetryAfterSeconds('-3')).toBeUndefined();
  });
});
