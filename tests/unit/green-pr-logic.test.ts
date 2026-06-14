/**
 * Tier-1 tests for greenPrLogic — the pure decision helpers
 * (green-pr-automerge-enforcement). Both sides of every boundary.
 */

import { describe, it, expect } from 'vitest';
import {
  holdReasonOf,
  classifyCandidate,
  headInNamespace,
  selectOldest,
  debounceHoldRelease,
  applyOutcome,
  maybeRearm,
  episodeEligible,
  freshBreaker,
  feedBreaker,
  breakerBlocking,
  validateTimeoutInvariant,
  type PrSummary,
  type Episode,
  type BreakerConfig,
} from '../../src/monitoring/greenPrLogic.js';

const basePr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: 100,
  title: 'feat: a thing',
  labels: [],
  isDraft: false,
  headRefName: 'echo/feature',
  headRefOid: 'abc123',
  mergeable: 'MERGEABLE',
  statusRollup: 'SUCCESS',
  ...over,
});

describe('holdReasonOf', () => {
  it('returns null for a normal PR', () => {
    expect(holdReasonOf(basePr())).toBeNull();
  });
  it('detects draft', () => {
    expect(holdReasonOf(basePr({ isDraft: true }))).toBe('draft');
  });
  it('detects a [HOLD title prefix case-insensitively and trims leading whitespace', () => {
    expect(holdReasonOf(basePr({ title: '[HOLD] later' }))).toBe('hold-title');
    expect(holdReasonOf(basePr({ title: '  [hold: stopping] x' }))).toBe('hold-title');
  });
  it('detects hold / do-not-merge labels case-insensitively', () => {
    expect(holdReasonOf(basePr({ labels: ['HOLD'] }))).toBe('hold-label');
    expect(holdReasonOf(basePr({ labels: ['Do-Not-Merge'] }))).toBe('hold-label');
  });
});

describe('headInNamespace', () => {
  it('accepts the agent prefix and rejects others', () => {
    expect(headInNamespace('echo/feature', 'echo')).toBe(true);
    expect(headInNamespace('echo/feature', 'echo/')).toBe(true);
    expect(headInNamespace('someoneelse/feature', 'echo')).toBe(false);
    expect(headInNamespace('echo-impostor/x', 'echo')).toBe(false); // prefix must be echo/
  });
});

describe('classifyCandidate', () => {
  it('accepts a clean green agent PR', () => {
    expect(classifyCandidate(basePr(), 'echo')).toEqual({ eligible: true });
  });
  it('skips a non-namespace branch', () => {
    expect(classifyCandidate(basePr({ headRefName: 'dawn/x' }), 'echo').skip).toBe('not-agent-namespace');
  });
  it('skips a held PR', () => {
    const v = classifyCandidate(basePr({ labels: ['hold'] }), 'echo');
    expect(v.skip).toBe('held');
    expect(v.hold).toBe('hold-label');
  });
  it('skips a conflicting PR', () => {
    expect(classifyCandidate(basePr({ mergeable: 'CONFLICTING' }), 'echo').skip).toBe('not-mergeable');
  });
  it('skips an unsettled / red PR', () => {
    expect(classifyCandidate(basePr({ statusRollup: 'PENDING' }), 'echo').skip).toBe('not-settled-green');
    expect(classifyCandidate(basePr({ statusRollup: 'FAILURE' }), 'echo').skip).toBe('not-settled-green');
  });
});

describe('selectOldest', () => {
  it('returns the lowest PR number', () => {
    const got = selectOldest([basePr({ number: 50 }), basePr({ number: 12 }), basePr({ number: 88 })]);
    expect(got?.number).toBe(12);
  });
  it('returns null for an empty set', () => {
    expect(selectOldest([])).toBeNull();
  });
});

describe('debounceHoldRelease', () => {
  const TICK = 600_000;
  it('keeps a still-held PR ineligible and zeroes the absence counter', () => {
    const r = debounceHoldRelease({ absentTicks: 1, firstHeldAt: 0 }, true, 1000, 2, TICK);
    expect(r.resumeEligible).toBe(false);
    expect(r.mem?.absentTicks).toBe(0);
  });
  it('requires BOTH enough absent ticks AND elapsed time before resuming', () => {
    // First absence: 1 tick, time not elapsed → observing
    let r = debounceHoldRelease({ absentTicks: 0, firstHeldAt: 0 }, false, 1000, 2, TICK);
    expect(r.transition).toBe('observing-release');
    expect(r.resumeEligible).toBe(false);
    // Second absence but elapsed time still short → still observing (tick met, time not)
    r = debounceHoldRelease({ absentTicks: 1, firstHeldAt: 1000 }, false, 2000, 2, TICK);
    expect(r.resumeEligible).toBe(false);
    // Second absence AND elapsed → released
    r = debounceHoldRelease({ absentTicks: 1, firstHeldAt: 0 }, false, TICK + 1, 2, TICK);
    expect(r.transition).toBe('released');
    expect(r.resumeEligible).toBe(true);
  });
  it('a never-held PR is immediately eligible', () => {
    const r = debounceHoldRelease(undefined, false, 1000, 2, TICK);
    expect(r.resumeEligible).toBe(true);
    expect(r.transition).toBe('not-held');
  });
});

describe('applyOutcome — failure ladder', () => {
  const cfg = { maxAttempts: 3, maxRearmEpisodes: 3, backoffBaseMs: 1000 };
  const ep0: Episode = { pr: 1, headRefOid: 'h', attempts: 0, rearmEpisodes: 0, state: 'active' };

  it('a merged outcome is terminal and never feeds the breaker', () => {
    const r = applyOutcome(ep0, 'merged', 0, cfg);
    expect(r.terminal).toBe(true);
    expect(r.feedsBreaker).toBe(false);
  });
  it('already-merged / closed are success-noops', () => {
    expect(applyOutcome(ep0, 'already-merged', 0, cfg).feedsBreaker).toBe(false);
    expect(applyOutcome(ep0, 'closed-by-other', 0, cfg).feedsBreaker).toBe(false);
  });
  it('a refusal advances attempts with backoff and feeds the breaker', () => {
    const r = applyOutcome(ep0, 'refused:red-checks', 1000, cfg);
    expect(r.ep.attempts).toBe(1);
    expect(r.feedsBreaker).toBe(true);
    expect(r.ep.nextEligibleAt).toBe(1000 + 1000);
  });
  it('gives up at maxAttempts', () => {
    let ep = ep0;
    for (let i = 0; i < 3; i++) ep = applyOutcome(ep, 'error:x', i * 10, cfg).ep;
    expect(ep.state).toBe('gave-up');
  });
});

describe('maybeRearm', () => {
  const cfg = { maxAttempts: 3, maxRearmEpisodes: 2, backoffBaseMs: 1000 };
  it('re-arms a gave-up episode on a new head sha', () => {
    const ep: Episode = { pr: 1, headRefOid: 'old', attempts: 3, rearmEpisodes: 0, state: 'gave-up' };
    const re = maybeRearm(ep, 'new', cfg);
    expect(re?.state).toBe('active');
    expect(re?.attempts).toBe(0);
    expect(re?.rearmEpisodes).toBe(1);
  });
  it('does not re-arm on the same head', () => {
    const ep: Episode = { pr: 1, headRefOid: 'same', attempts: 3, rearmEpisodes: 0, state: 'gave-up' };
    expect(maybeRearm(ep, 'same', cfg)?.state).toBe('gave-up');
  });
  it('returns null when re-arm episodes are exhausted', () => {
    const ep: Episode = { pr: 1, headRefOid: 'old', attempts: 3, rearmEpisodes: 2, state: 'gave-up' };
    expect(maybeRearm(ep, 'new', cfg)).toBeNull();
  });
});

describe('episodeEligible', () => {
  it('a fresh PR (no episode) is eligible', () => {
    expect(episodeEligible(undefined, 0)).toBe(true);
  });
  it('a gave-up episode is not eligible', () => {
    expect(episodeEligible({ pr: 1, headRefOid: 'h', attempts: 3, rearmEpisodes: 0, state: 'gave-up' }, 0)).toBe(false);
  });
  it('honors the backoff window', () => {
    const ep: Episode = { pr: 1, headRefOid: 'h', attempts: 1, rearmEpisodes: 0, state: 'active', nextEligibleAt: 5000 };
    expect(episodeEligible(ep, 4000)).toBe(false);
    expect(episodeEligible(ep, 6000)).toBe(true);
  });
});

describe('circuit breaker', () => {
  const cfg: BreakerConfig = { busySkipBreakerThreshold: 3, deadlineKillBreakerThreshold: 3, breakerThreshold: 3, breakerCooldownMs: 60_000 };

  it('opens after N consecutive busy-skips', () => {
    let b = freshBreaker();
    for (let i = 0; i < 3; i++) b = feedBreaker(b, 'busy-skip', i, cfg);
    expect(b.open).toBe(true);
  });
  it('opens after N consecutive deadline-kills (separate counter)', () => {
    let b = freshBreaker();
    for (let i = 0; i < 3; i++) b = feedBreaker(b, 'deadline-kill', i, cfg);
    expect(b.open).toBe(true);
  });
  it('reset clears all counters and closes the breaker', () => {
    let b = freshBreaker();
    b = feedBreaker(b, 'busy-skip', 0, cfg);
    b = feedBreaker(b, 'reset', 0, cfg);
    expect(b.consecutiveBusySkips).toBe(0);
    expect(b.open).toBe(false);
  });
  it('blocks while open within cooldown, frees after cooldown', () => {
    let b = freshBreaker();
    for (let i = 0; i < 3; i++) b = feedBreaker(b, 'tick-failed', 1000, cfg);
    expect(breakerBlocking(b, 1000, cfg.breakerCooldownMs)).toBe(true);
    expect(breakerBlocking(b, 1000 + 60_001, cfg.breakerCooldownMs)).toBe(false);
  });
});

describe('validateTimeoutInvariant (B24)', () => {
  it('accepts a sane combination', () => {
    expect(validateTimeoutInvariant(3, 600_000, 1_500_000, 60_000).ok).toBe(true);
  });
  it('rejects a combination where the busy-skip budget cannot outlast a merge', () => {
    const r = validateTimeoutInvariant(2, 600_000, 1_500_000, 60_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/must exceed/);
  });
});
