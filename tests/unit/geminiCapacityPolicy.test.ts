import { describe, expect, it, beforeEach } from 'vitest';
import {
  decideGeminiCapacityPolicy,
  getGeminiCapacityGate,
  isGeminiCapacityError,
  parseGeminiRetryAfterMs,
  pickGeminiFallbackModel,
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

  it('retries once for a short window, then switches model, then defers once ALL models are exhausted', () => {
    // attempt 0, short window → immediate retry on the same model.
    const first = decideGeminiCapacityPolicy({
      errorMessage: '429 resource exhausted, retry after 2s',
      attempt: 0,
      model: 'gemini-2.5-flash',
      config: { backoffMs: 1 },
      now: 1_000,
    });
    expect(first.action).toBe('retry');
    expect(first.retryAfterMs).toBe(2_000);

    // attempt 1, immediate retries spent + a long reset → flash is exhausted, but
    // pro draws on a separate quota and has headroom, so switch to pro rather than
    // globally deferring (the bug: a single-model exhaustion read as a full block).
    const second = decideGeminiCapacityPolicy({
      errorMessage: 'exhausted your capacity on this model. quota will reset after 46m',
      attempt: 1,
      model: 'gemini-2.5-flash',
      config: { backoffMs: 1 },
      now: 1_000,
    });
    expect(second.action).toBe('retry');
    expect(second.model).toBe('gemini-2.5-pro');

    // pro exhausts too → the remaining known model (gemini-3.1-pro-preview) still
    // has headroom, so switch to it rather than declaring a global block yet.
    const third = decideGeminiCapacityPolicy({
      errorMessage: 'exhausted your capacity on this model. quota will reset after 46m',
      attempt: 2,
      model: 'gemini-2.5-pro',
      config: { backoffMs: 1 },
      now: 1_000,
    });
    expect(third.action).toBe('retry');
    expect(third.model).toBe('gemini-3.1-pro-preview');

    // the last known model exhausts → every known model is now in an exhaustion
    // window → genuine account-wide block → defer (only NOW a stop-state write).
    const fourth = decideGeminiCapacityPolicy({
      errorMessage: 'exhausted your capacity on this model. quota will reset after 46m',
      attempt: 3,
      model: 'gemini-3.1-pro-preview',
      config: { backoffMs: 1 },
      now: 1_000,
    });
    expect(fourth.action).toBe('defer');
  });

  it('a single-model exhaustion switches to the model with headroom (no global stop)', () => {
    const d = decideGeminiCapacityPolicy({
      errorMessage:
        'You have exhausted your capacity on this model. Your quota will reset after 46m11s.',
      attempt: 5, // well past immediate retries
      model: 'gemini-2.5-flash',
      config: {},
      now: 0,
    });
    // retry-with-switch, NOT defer → the caller never records a global deferral
    // / writes recommendation:'stop' for a one-model exhaustion.
    expect(d.action).toBe('retry');
    expect(d.model).toBe('gemini-2.5-pro');
  });

  it('pickGeminiFallbackModel returns the next model with headroom, then undefined once ALL are exhausted', () => {
    expect(pickGeminiFallbackModel('gemini-2.5-flash', undefined, 0)).toBe('gemini-2.5-pro');
    // record every known model as exhausted via the decision path
    decideGeminiCapacityPolicy({ errorMessage: 'quota exhausted; reset after 46m', attempt: 9, model: 'gemini-2.5-flash', now: 0 });
    decideGeminiCapacityPolicy({ errorMessage: 'quota exhausted; reset after 46m', attempt: 9, model: 'gemini-2.5-pro', now: 0 });
    decideGeminiCapacityPolicy({ errorMessage: 'quota exhausted; reset after 46m', attempt: 9, model: 'gemini-3.1-pro-preview', now: 0 });
    expect(pickGeminiFallbackModel('gemini-2.5-flash', undefined, 0)).toBeUndefined();
  });

  it('per-model exhaustion windows self-clear once the reset passes', () => {
    const t0 = 1_000;
    // both heavy models (pro + the preview pro) exhaust with a ~1m reset → no
    // non-flash model has headroom during the window.
    decideGeminiCapacityPolicy({ errorMessage: 'quota exhausted; reset after 1m', attempt: 9, model: 'gemini-2.5-pro', now: t0 });
    decideGeminiCapacityPolicy({ errorMessage: 'quota exhausted; reset after 1m', attempt: 9, model: 'gemini-3.1-pro-preview', now: t0 });
    // before the windows pass, no usable fallback remains
    expect(pickGeminiFallbackModel('gemini-2.5-flash', undefined, t0 + 1_000)).toBeUndefined();
    // after the windows, the heavy models have headroom again (pro is first in order)
    expect(pickGeminiFallbackModel('gemini-2.5-flash', undefined, t0 + 120_000)).toBe('gemini-2.5-pro');
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
    expect(resolveCliModelFlag('capable')).toBe('gemini-3.1-pro-preview');
    expect(resolveKnownGeminiFallback('gemini-2.0-flash', { fallbackModel: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
    expect(resolveKnownGeminiFallback('gemini-2.0-flash', { fallbackModel: 'gemini-2.0-flash' })).toBe('gemini-2.0-flash');
  });
});
