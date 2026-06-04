import { describe, expect, it, beforeEach } from 'vitest';
import {
  decideGeminiCapacityPolicy,
  getGeminiCapacityGate,
  isGeminiCapacityError,
  parseGeminiRetryAfterMs,
  recordGeminiCapacityDeferral,
  resetGeminiCapacityPolicyForTests,
  resolveKnownGeminiFallback,
} from '../../src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.js';
import {
  isKnownGeminiModel,
  resolveCliModelFlag,
} from '../../src/providers/adapters/gemini-cli/models.js';

describe('geminiCapacityPolicy', () => {
  beforeEach(() => resetGeminiCapacityPolicyForTests());

  it('classifies Gemini 429/quota/capacity failures conservatively', () => {
    expect(isGeminiCapacityError('TerminalQuotaError: QUOTA_EXHAUSTED')).toBe(true);
    expect(isGeminiCapacityError('HTTP 429 resource exhausted')).toBe(true);
    expect(isGeminiCapacityError('too many requests')).toBe(true);
    expect(isGeminiCapacityError('syntax error in JSON')).toBe(false);
  });

  it('parses Gemini reset windows from quota text', () => {
    expect(parseGeminiRetryAfterMs('Your quota will reset after 7h32m28s.')).toBe(
      ((7 * 3600) + (32 * 60) + 28) * 1000,
    );
    expect(parseGeminiRetryAfterMs('try again in 45s')).toBe(45_000);
    expect(parseGeminiRetryAfterMs('reset in 2 minutes')).toBe(120_000);
  });

  it('retries once for short windows, then defers', () => {
    const first = decideGeminiCapacityPolicy({
      errorMessage: '429 resource exhausted, retry after 2s',
      attempt: 0,
      model: 'gemini-2.5-flash',
      config: { backoffMs: 1 },
    });
    expect(first.action).toBe('retry');
    expect(first.retryAfterMs).toBe(2_000);

    const second = decideGeminiCapacityPolicy({
      errorMessage: '429 resource exhausted, retry after 2s',
      attempt: 1,
      model: 'gemini-2.5-flash',
      config: { backoffMs: 1 },
    });
    expect(second.action).toBe('defer');
  });

  it('records a local deferral gate past the reset window', () => {
    recordGeminiCapacityDeferral({
      retryAfterMs: 60_000,
      reason: 'quota reset pending',
      now: 1_000,
    });
    const gate = getGeminiCapacityGate(2_000);
    expect(gate.allow).toBe(false);
    expect(gate.retryAfterMs).toBeGreaterThan(50_000);
    expect(getGeminiCapacityGate(70_000).allow).toBe(true);
  });
});

describe('Gemini known model resolution', () => {
  it('passes through explicit model ids but constrains automatic fallback models', () => {
    expect(isKnownGeminiModel('gemini-2.5-flash')).toBe(true);
    expect(isKnownGeminiModel('gemini-2.0-flash')).toBe(false);
    expect(resolveCliModelFlag('gemini-2.0-flash')).toBe('gemini-2.0-flash');
    expect(resolveCliModelFlag('capable')).toBe('gemini-2.5-pro');
    expect(resolveKnownGeminiFallback('gemini-2.0-flash', { fallbackModel: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
    expect(resolveKnownGeminiFallback('gemini-2.0-flash', { fallbackModel: 'gemini-2.0-flash' })).toBe('gemini-2.0-flash');
  });
});
