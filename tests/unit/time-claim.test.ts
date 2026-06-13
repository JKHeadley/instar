import { describe, it, expect } from 'vitest';
import {
  extractTimeClaims,
  detectTimeClaimContradiction,
  type TimeClaimClock,
} from '../../src/core/time-claim.js';

/**
 * time-claim detector — decision table over the founding incident shapes
 * (2026-06-12 topic 13481: "~7h elapsed" reported on a run whose live clock
 * read 1h 35m) plus both sides of every boundary (Testing Integrity:
 * semantic correctness on realistic inputs).
 */

// A 24h run, 1h54m in (the real clock at the founding correction).
const RUN: TimeClaimClock = {
  elapsedSeconds: 6868, // 1h 54m
  remainingSeconds: 79532, // 22h 5m
  percentElapsed: 8,
};

describe('extractTimeClaims — anchored claim extraction', () => {
  it('extracts "Xh elapsed" and fractional "X.Y hours in:"', () => {
    const claims = extractTimeClaims('AUTONOMOUS PROGRESS (24h run, ~7h elapsed / 24h total)');
    expect(claims).toHaveLength(1);
    expect(claims[0].kind).toBe('elapsed');
    expect(claims[0].value).toBe(7 * 3600);

    const frac = extractTimeClaims('Simple version, ~7.5 hours in: the goal...');
    expect(frac).toHaveLength(1);
    expect(frac[0].value).toBe(7.5 * 3600);
  });

  it('extracts "Xh Ym" composites and minutes-only claims', () => {
    expect(extractTimeClaims('1h 54m elapsed so far')[0].value).toBe(6868 - 28); // 1h54m = 6840
    expect(extractTimeClaims('(iteration 1, ~45m elapsed / 4h)')[0]).toMatchObject({
      kind: 'elapsed',
      value: 45 * 60,
    });
  });

  it('extracts remaining claims ("left", "remaining", "on the clock")', () => {
    const claims = extractTimeClaims('about 2h 40m left; 22h 5m remaining; ~1h on the clock');
    expect(claims.filter((c) => c.kind === 'remaining')).toHaveLength(3);
  });

  it('extracts percent claims anchored to an explicit TIME noun', () => {
    const claims = extractTimeClaims('we are 8% through the run, 8% elapsed');
    expect(claims.filter((c) => c.kind === 'percent')).toHaveLength(2);
    expect(claims[0].value).toBe(8);
  });

  it('does NOT match TASK-progress percentages (complete/done/bare-through/bare-in)', () => {
    // Comparing task progress against wall-clock percent fires on the NORMAL
    // state — these must never be parsed as time claims (second-pass concern 1).
    expect(extractTimeClaims('Phase 2 is 80% complete; run continues')).toHaveLength(0);
    expect(extractTimeClaims('the migration is 90% done')).toHaveLength(0);
    expect(extractTimeClaims('unit suite passes 100% in CI')).toHaveLength(0);
    expect(extractTimeClaims('coverage now 85% in the new module')).toHaveLength(0);
    expect(extractTimeClaims('we are 8% through.')).toHaveLength(0);
  });

  it('does NOT match unanchored durations or future-tense "in X hours"', () => {
    expect(extractTimeClaims('the full regression took 3h to run')).toHaveLength(0);
    expect(extractTimeClaims('in 2 hours I will re-check CI')).toHaveLength(0);
    expect(extractTimeClaims('the build is 3h in CI now')).toHaveLength(0);
    expect(extractTimeClaims('a 24h run with 5h account windows')).toHaveLength(0);
  });

  it('does NOT match a QUOTED claim (a correction citing the wrong number)', () => {
    expect(extractTimeClaims('my "~7h elapsed" line was flat wrong')).toHaveLength(0);
    expect(extractTimeClaims("the '~7.5 hours in' claim was a guess")).toHaveLength(0);
  });

  it('degrades to empty on non-string/empty input', () => {
    expect(extractTimeClaims('')).toHaveLength(0);
    expect(extractTimeClaims(undefined as unknown as string)).toHaveLength(0);
  });
});

describe('detectTimeClaimContradiction — both decision sides', () => {
  it('FIRES on the founding incident: "~7h elapsed" against a 1h54m clock', () => {
    const r = detectTimeClaimContradiction(
      'AUTONOMOUS PROGRESS (24h run, ~7h elapsed / 24h total)',
      [RUN],
    );
    expect(r.detected).toBe(true);
    expect(r.match).toContain('7h elapsed');
    expect(r.match).toContain('1h 54m elapsed');
  });

  it('PASSES an accurate report quoting the real clock', () => {
    const r = detectTimeClaimContradiction(
      'Run status: 1h 54m elapsed, 22h 5m remaining, 8% through the run.',
      [RUN],
    );
    expect(r.detected).toBe(false);
  });

  it('PASSES claims within tolerance (20% / 15-minute floor)', () => {
    // 2h claimed vs 1h54m actual → 6m off, inside the floor.
    expect(detectTimeClaimContradiction('about 2h elapsed', [RUN]).detected).toBe(false);
    // 22h left vs 22h5m actual.
    expect(detectTimeClaimContradiction('roughly 22h left', [RUN]).detected).toBe(false);
  });

  it('FIRES on a grossly wrong remaining claim', () => {
    const r = detectTimeClaimContradiction('only 3h left on the clock', [RUN]);
    expect(r.detected).toBe(true);
    expect(r.match).toContain('remaining');
  });

  it('FIRES on a grossly wrong percent claim, passes within 15 points', () => {
    expect(detectTimeClaimContradiction('about 60% through the run', [RUN]).detected).toBe(true);
    expect(detectTimeClaimContradiction('about 20% through the run', [RUN]).detected).toBe(false);
  });

  it('never fires with no clocks (nothing to contradict)', () => {
    expect(detectTimeClaimContradiction('~7h elapsed', []).detected).toBe(false);
  });

  it('skips remaining/percent claims against an unbounded clock', () => {
    const unbounded: TimeClaimClock = {
      elapsedSeconds: 6868,
      remainingSeconds: null,
      percentElapsed: null,
    };
    expect(
      detectTimeClaimContradiction('about 3h left, 90% through the run', [unbounded]).detected,
    ).toBe(false);
    // ...but elapsed claims still verify.
    expect(detectTimeClaimContradiction('~7h elapsed', [unbounded]).detected).toBe(true);
  });

  it('a claim consistent with ANY of several clocks passes (lenient multi-clock)', () => {
    const other: TimeClaimClock = { elapsedSeconds: 7 * 3600, remainingSeconds: 3600, percentElapsed: 88 };
    expect(detectTimeClaimContradiction('~7h elapsed', [RUN, other]).detected).toBe(false);
  });
});
