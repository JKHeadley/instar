/**
 * Verifies plannedUpgrade bucket behaviour in rateLimitState.decide.
 * The bucket bypasses watchdog cooldown (same as versionSkew) but counts
 * toward the shared daily cap so a bad signal can't restart-loop forever.
 *
 * Spec: docs/specs/auto-updater-lifeline-coordination.md
 */

import { describe, it, expect } from 'vitest';
import { decide, type RateLimitState } from '../../../src/lifeline/rateLimitState.js';

function makeState(lastRestartAt: string, history: { at: string; bucket: 'watchdog' | 'versionSkew' | 'plannedUpgrade' }[] = []): RateLimitState {
  return {
    lastRestartAt,
    history: history.map(h => ({ at: h.at, reason: 'test', bucket: h.bucket })),
  };
}

describe('rateLimitState.decide — plannedUpgrade bucket', () => {
  it('bypasses watchdog cooldown', () => {
    // 1 minute ago — well within WATCHDOG_COOLDOWN_MS (5 min default).
    const now = 1_000_000_000_000;
    const lastRestartAt = new Date(now - 60_000).toISOString();
    const state = makeState(lastRestartAt);
    const watchdogDecision = decide({ kind: 'ok', state }, 'watchdog', now);
    expect(watchdogDecision.allowed).toBe(false);
    expect(watchdogDecision.reason).toBe('cooldown-active');

    const plannedDecision = decide({ kind: 'ok', state }, 'plannedUpgrade', now);
    expect(plannedDecision.allowed).toBe(true);
  });

  it('counts toward shared hard-skew daily cap (3-per-24h with versionSkew)', () => {
    const now = 1_000_000_000_000;
    const oneHourAgo = new Date(now - 3600_000).toISOString();
    const twoHoursAgo = new Date(now - 2 * 3600_000).toISOString();
    const threeHoursAgo = new Date(now - 3 * 3600_000).toISOString();
    const state = makeState(oneHourAgo, [
      { at: threeHoursAgo, bucket: 'versionSkew' },
      { at: twoHoursAgo, bucket: 'plannedUpgrade' },
      { at: oneHourAgo, bucket: 'plannedUpgrade' },
    ]);

    // Three hard-skew restarts in the last 24h → cap reached.
    const blocked = decide({ kind: 'ok', state }, 'plannedUpgrade', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('version-skew-daily-cap');
  });

  it('allows when no recent hard-skew history', () => {
    const now = 1_000_000_000_000;
    const oneHourAgo = new Date(now - 3600_000).toISOString();
    const state = makeState(oneHourAgo, [
      // Watchdog history doesn't count toward the hard-skew cap.
      { at: oneHourAgo, bucket: 'watchdog' },
      { at: oneHourAgo, bucket: 'watchdog' },
      { at: oneHourAgo, bucket: 'watchdog' },
    ]);

    const decision = decide({ kind: 'ok', state }, 'plannedUpgrade', now);
    expect(decision.allowed).toBe(true);
  });

  it('still bypasses cooldown when prior bucket was watchdog', () => {
    // The cooldown bypass is keyed on the REQUESTING bucket, not the prior
    // restart's bucket. Even if the last restart was a watchdog restart,
    // a plannedUpgrade request should not be cooldown-blocked.
    const now = 1_000_000_000_000;
    const recentRestart = new Date(now - 60_000).toISOString();
    const state = makeState(recentRestart, [
      { at: recentRestart, bucket: 'watchdog' },
    ]);

    const decision = decide({ kind: 'ok', state }, 'plannedUpgrade', now);
    expect(decision.allowed).toBe(true);
  });

  it('versionSkew + plannedUpgrade share the same cap (no bucket-hopping)', () => {
    const now = 1_000_000_000_000;
    const oneHourAgo = new Date(now - 3600_000).toISOString();
    const state = makeState(oneHourAgo, [
      { at: oneHourAgo, bucket: 'plannedUpgrade' },
      { at: oneHourAgo, bucket: 'plannedUpgrade' },
      { at: oneHourAgo, bucket: 'plannedUpgrade' },
    ]);

    // Three plannedUpgrade restarts → a versionSkew request should also be capped.
    const decision = decide({ kind: 'ok', state }, 'versionSkew', now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('version-skew-daily-cap');
  });
});
