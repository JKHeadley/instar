/**
 * Unit tests — Burn-detection Phase 6 (verifier + follow-up).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BurnVerifier, extractTokensLast1h } from '../../src/monitoring/BurnVerifier.js';
import type { DegradationEvent } from '../../src/monitoring/DegradationReporter.js';
import type { RunbookOutcome } from '../../src/monitoring/BurnThrottleRunbook.js';
import type { AttributionKeyRow } from '../../src/monitoring/TokenLedger.js';

function makeBurnEvent(attributionKey: string, trigger: 'absolute-share' | 'baseline-divergence' = 'baseline-divergence'): DegradationEvent {
  return {
    feature: 'token-burn-detection',
    primary: `attribution_key ${attributionKey} sustained spend within thresholds`,
    fallback: 'signal-only',
    reason: trigger === 'absolute-share'
      ? `${attributionKey} consumed 73.0% of 24h spend (threshold 25%)`
      : `${attributionKey} last-1h rate 50,000,000 tok/h, baseline 5,000,000 tok/h (multiplier 2x)`,
    impact: 'Projected 1,200,000,000 tokens in next 24h at current rate.',
    timestamp: '2026-05-15T23:30:00Z',
    reported: false,
    alerted: false,
  };
}

function makeThrottleOutcome(attributionKey: string): RunbookOutcome {
  return {
    kind: 'throttle-installed',
    attributionKey,
    decidedAt: '2026-05-15T23:30:00Z',
    trigger: 'absolute-share',
    throttle: {
      attributionKey,
      installedAt: '2026-05-15T23:30:00Z',
      expiresAt: '2026-05-16T00:30:00Z',
      reason: 'test',
      issuer: 'burn-throttle-runbook',
    },
    reason: 'test',
  };
}

describe('BurnVerifier — pre-throttle rate extraction', () => {
  it('extractTokensLast1h reads the baseline-divergence rate from event.reason', () => {
    expect(extractTokensLast1h(makeBurnEvent('X::y', 'baseline-divergence'))).toBe(50_000_000);
  });

  it('extractTokensLast1h falls back to event.impact projected/24 for absolute-share', () => {
    expect(extractTokensLast1h(makeBurnEvent('X::y', 'absolute-share'))).toBe(50_000_000);
  });

  it('extractTokensLast1h returns 0 if neither field has a parseable rate', () => {
    const ev: DegradationEvent = {
      feature: 'token-burn-detection',
      primary: '', fallback: '', reason: 'nothing parseable', impact: 'nothing parseable',
      timestamp: '', reported: false, alerted: false,
    };
    expect(extractTokensLast1h(ev)).toBe(0);
  });
});

describe('BurnVerifier — verification cycle', () => {
  let messages: string[];
  let scheduled: Array<{ cb: () => void; delay: number }>;
  let now: number;

  beforeEach(() => {
    messages = [];
    scheduled = [];
    now = 1_000_000_000_000;
  });

  function fakeLedger(byKeyRows: AttributionKeyRow[]) {
    return { byAttributionKey: () => byKeyRows };
  }

  it('cache reads never inflate the post-throttle burn rate', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([
        { attributionKey: 'Warm::cache', totalTokens: 10_416_666, freshTokens: 416_666, eventCount: 50, firstTs: 0, lastTs: 0 },
      ]) as any,
      sendTelegram: (_, m) => messages.push(m),
      now: () => now,
      schedule: (cb, delay) => scheduled.push({ cb, delay }),
    });

    const result = verifier.runVerification('Warm::cache', 50_000_000);
    expect(result.postThrottleRate).toBeCloseTo(4_999_992);
    expect(result.successfullyThrottled).toBe(true);
  });

  it('successful throttle: post-rate dropped → caught-and-contained message', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([
        { attributionKey: 'InputDetector::abcd1234', totalTokens: 416_666, eventCount: 50, firstTs: 0, lastTs: 0 },
      ]) as any,
      sendTelegram: (_, m) => messages.push(m),
      now: () => now,
      schedule: (cb, delay) => scheduled.push({ cb, delay }),
    });
    verifier.scheduleVerification(
      makeThrottleOutcome('InputDetector::abcd1234'),
      makeBurnEvent('InputDetector::abcd1234', 'baseline-divergence'),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(5 * 60 * 1000);
    now += 5 * 60 * 1000;
    scheduled[0].cb();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/Caught and contained/i);
    expect(messages[0]).toMatch(/InputDetector/);
  });

  it('unsuccessful throttle: post-rate still high → did-not-take-effect escalation', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([
        { attributionKey: 'Surge::aa', totalTokens: 4_166_666, eventCount: 1000, firstTs: 0, lastTs: 0 },
      ]) as any,
      sendTelegram: (_, m) => messages.push(m),
      now: () => now,
      schedule: (cb, _delay) => scheduled.push({ cb, delay: _delay }),
    });
    verifier.scheduleVerification(
      makeThrottleOutcome('Surge::aa'),
      makeBurnEvent('Surge::aa', 'baseline-divergence'),
    );
    scheduled[0].cb();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/did not take effect/i);
    expect(messages[0]).toMatch(/Surge/);
  });

  it('runVerification computes ratio + flag correctly', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([
        { attributionKey: 'X::y', totalTokens: 500_000, eventCount: 10, firstTs: 0, lastTs: 0 },
      ]) as any,
      sendTelegram: () => {},
      now: () => now,
    });
    const result = verifier.runVerification('X::y', 50_000_000);
    expect(result.postThrottleRate).toBe(6_000_000);
    expect(result.ratio).toBeCloseTo(0.12, 2);
    expect(result.successfullyThrottled).toBe(true);
  });

  it('non-throttle-installed outcomes do not schedule verification', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([]) as any,
      sendTelegram: () => {},
      schedule: (cb, delay) => scheduled.push({ cb, delay }),
      now: () => now,
    });
    const alertOnlyOutcome: RunbookOutcome = {
      kind: 'alert-only-unknown',
      attributionKey: 'unknown::aa',
      decidedAt: '', trigger: 'absolute-share', reason: '',
    };
    verifier.scheduleVerification(alertOnlyOutcome, makeBurnEvent('unknown::aa'));
    expect(scheduled).toHaveLength(0);
  });

  it('configurable successRatio (e.g. require 90% drop)', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([
        { attributionKey: 'X::y', totalTokens: 5_000_000, eventCount: 100, firstTs: 0, lastTs: 0 },
      ]) as any,
      sendTelegram: () => {},
      now: () => now,
      config: { successRatio: 0.1 },
    });
    const result = verifier.runVerification('X::y', 100_000_000);
    expect(result.successfullyThrottled).toBe(false);
  });

  it('handles missing post-throttle row gracefully (key fell out entirely)', () => {
    const verifier = new BurnVerifier({
      ledger: fakeLedger([]) as any,
      sendTelegram: (_, m) => messages.push(m),
      now: () => now,
    });
    const result = verifier.runVerification('Vanished::aa', 50_000_000);
    expect(result.postThrottleRate).toBe(0);
    expect(result.successfullyThrottled).toBe(true);
    expect(messages[0]).toMatch(/Caught and contained/i);
  });
});
