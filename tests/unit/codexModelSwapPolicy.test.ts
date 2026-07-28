import { describe, it, expect } from 'vitest';
import {
  resolveCodexLaunchModel,
  resolveCodexLaunchModelWithUsage,
  DEFAULT_WEEKLY_REMAINING_THRESHOLD,
  type CodexModelSwapConfig,
} from '../../src/providers/adapters/openai-codex/observability/codexModelSwapPolicy.js';
import type { CodexUsageSnapshot } from '../../src/providers/adapters/openai-codex/observability/codexRateLimitReader.js';

/**
 * Unit coverage for the codex rate-limit model-swap policy (directive #4b).
 * Pure decision + the best-effort async wrapper. Every guard is exercised on
 * both sides: swaps only when codex + enabled + fallback set + a window is
 * exhausted; otherwise passes the requested model through untouched.
 */

function usage(opts: { weeklyRemaining?: number; reached?: string | null }): CodexUsageSnapshot {
  return {
    source: 'codex-rollout',
    rolloutPath: '/x/rollout.jsonl',
    threadId: 'tid',
    capturedAt: '2026-05-30T19:22:00.000Z',
    model: 'gpt-5.5',
    planType: 'plus',
    rateLimitReachedType: opts.reached ?? null,
    primary: { usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: 1, resetsAtIso: null, resetsInSeconds: null },
    secondary:
      opts.weeklyRemaining === undefined
        ? null
        : { usedPercent: 100 - opts.weeklyRemaining, remainingPercent: opts.weeklyRemaining, windowMinutes: 10080, resetsAt: 1, resetsAtIso: null, resetsInSeconds: null },
  };
}

const ON: CodexModelSwapConfig = { enabled: true, fallbackModel: 'gpt-5.3-codex-spark' };

describe('resolveCodexLaunchModel (pure)', () => {
  it('swaps to the fallback when the weekly window is at/below the threshold', () => {
    const d = resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: usage({ weeklyRemaining: 7 }) });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe('gpt-5.3-codex-spark');
    expect(d.reason).toContain('7%');
  });

  it('swaps when rate_limit_reached_type is set, regardless of threshold', () => {
    const d = resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: usage({ weeklyRemaining: 80, reached: 'secondary' }) });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe('gpt-5.3-codex-spark');
    expect(d.reason).toContain('reached');
  });

  it('does NOT swap when the weekly window is comfortably above threshold', () => {
    const d = resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: usage({ weeklyRemaining: 50 }) });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe('gpt-5.5');
  });

  it('uses the default threshold (10%) when none is configured', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'm', config: ON, usage: usage({ weeklyRemaining: DEFAULT_WEEKLY_REMAINING_THRESHOLD }) }).swapped).toBe(true);
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'm', config: ON, usage: usage({ weeklyRemaining: DEFAULT_WEEKLY_REMAINING_THRESHOLD + 1 }) }).swapped).toBe(false);
  });

  it('respects a custom threshold', () => {
    const cfg: CodexModelSwapConfig = { ...ON, weeklyRemainingThreshold: 25 };
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'm', config: cfg, usage: usage({ weeklyRemaining: 20 }) }).swapped).toBe(true);
  });

  it('does NOT swap for a non-codex framework', () => {
    expect(resolveCodexLaunchModel({ framework: 'claude-code', requestedModel: 'opus', config: ON, usage: usage({ weeklyRemaining: 1 }) }).swapped).toBe(false);
  });

  it('does NOT swap when disabled', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: { ...ON, enabled: false }, usage: usage({ weeklyRemaining: 1 }) }).swapped).toBe(false);
  });

  it('does NOT swap when no fallbackModel is set (operator has not confirmed the id)', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: { enabled: true }, usage: usage({ weeklyRemaining: 1 }) }).swapped).toBe(false);
  });

  it('does NOT re-swap when already on the fallback model', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.3-codex-spark', config: ON, usage: usage({ weeklyRemaining: 1 }) }).swapped).toBe(false);
  });

  it('does NOT swap when usage is unavailable (conservative)', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: null }).swapped).toBe(false);
  });

  it('tolerates a missing weekly window (only swaps on reached flag then)', () => {
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: usage({}) }).swapped).toBe(false);
    expect(resolveCodexLaunchModel({ framework: 'codex-cli', requestedModel: 'gpt-5.5', config: ON, usage: usage({ reached: 'primary' }) }).swapped).toBe(true);
  });
});

describe('resolveCodexLaunchModelWithUsage (best-effort wrapper)', () => {
  it('reads usage and swaps when exhausted', async () => {
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: ON,
      readUsage: async () => usage({ weeklyRemaining: 5 }),
    });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe('gpt-5.3-codex-spark');
  });

  it('does NOT read usage at all when disabled (zero disk I/O fast-path)', async () => {
    let read = 0;
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: { ...ON, enabled: false },
      readUsage: async () => { read++; return usage({ weeklyRemaining: 1 }); },
    });
    expect(read).toBe(0);
    expect(d.swapped).toBe(false);
  });

  it('does NOT read usage for a non-codex framework', async () => {
    let read = 0;
    await resolveCodexLaunchModelWithUsage({
      framework: 'claude-code',
      requestedModel: 'opus',
      config: ON,
      readUsage: async () => { read++; return usage({ weeklyRemaining: 1 }); },
    });
    expect(read).toBe(0);
  });

  it('does NOT read usage when no fallbackModel is set', async () => {
    let read = 0;
    await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: { enabled: true },
      readUsage: async () => { read++; return null; },
    });
    expect(read).toBe(0);
  });

  it('never throws and resolves to the requested model when the read fails', async () => {
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: ON,
      readUsage: async () => { throw new Error('disk gone'); },
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe('gpt-5.5');
  });
});
