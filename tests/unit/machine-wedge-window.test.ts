/**
 * Wedge candidate window rules (machine-self-maintenance Part E), both sides of every
 * boundary: 20-minute window, 3 observations, same two families at every observation,
 * a negative resets, a missing sample neither counts nor resets, a gap over 6 minutes
 * restarts, freshness within 6 minutes, the 2-hour single-family rule, and the 6-hour
 * recently-restarted mark.
 */
import { describe, expect, it } from 'vitest';
import {
  currentCandidate, emptyWindow, isFresh, nextSampleDelay, observe, recentlyRestarted, rungsFor, singleFamilyRun,
  WEDGE_FRESH_MS, WEDGE_MAX_GAP_MS, WEDGE_RECENT_BOOT_MS, WEDGE_SAMPLE_IDLE_MS, WEDGE_SAMPLE_POSITIVE_MS, WEDGE_SINGLE_FAMILY_MS, WEDGE_WINDOW_MS,
  type FamilyResult, type Sample, type WindowState,
} from '../../src/monitoring/machineMaintenance/wedgeWindow.js';

const MIN = 60_000;
const T0 = 1_000_000_000;

function s(at: number, F1: FamilyResult, F2: FamilyResult, F4: FamilyResult): Sample {
  return { at, results: { F1, F2, F4 } };
}

function feed(samples: Sample[], start: WindowState = emptyWindow()): WindowState {
  return samples.reduce(observe, start);
}

/** Two families (F2, F4) positive at each offset in minutes; F1 unread. */
function pairAt(minutes: number[]): Sample[] {
  return minutes.map((m) => s(T0 + m * MIN, 'unknown', 'positive', 'positive'));
}

describe('constants match the spec', () => {
  it('20 min window, 6 min gap and freshness, 2 h single family, 6 h recent boot, 10/2 min sampling', () => {
    expect([WEDGE_WINDOW_MS, WEDGE_MAX_GAP_MS, WEDGE_FRESH_MS, WEDGE_SINGLE_FAMILY_MS, WEDGE_RECENT_BOOT_MS, WEDGE_SAMPLE_IDLE_MS, WEDGE_SAMPLE_POSITIVE_MS])
      .toEqual([20 * MIN, 6 * MIN, 6 * MIN, 120 * MIN, 360 * MIN, 10 * MIN, 2 * MIN]);
  });
});

describe('the 20-minute window', () => {
  it('19 minutes 59 s of evidence is no candidate; 20 minutes is', () => {
    const almost = feed([s(T0, 'unknown', 'positive', 'positive'), s(T0 + 5 * MIN, 'unknown', 'positive', 'positive'), s(T0 + 10 * MIN, 'unknown', 'positive', 'positive'), s(T0 + 15 * MIN, 'unknown', 'positive', 'positive'), s(T0 + 20 * MIN - 1000, 'unknown', 'positive', 'positive')]);
    expect(currentCandidate(almost)).toBeNull();
    const full = feed(pairAt([0, 5, 10, 15, 20]));
    expect(currentCandidate(full)).toMatchObject({ pair: 'F2+F4', startAt: T0, observations: 5 });
  });
});

describe('at least 3 observations', () => {
  it('2 observations 20 minutes apart are no candidate (and the gap restarts anyway); 3 within the gap rule are', () => {
    // Two observations spanning 20 minutes would need a gap over 6 minutes, which restarts the window.
    expect(currentCandidate(feed(pairAt([0, 20])))).toBeNull();
    // Exactly 3 observations cannot span 20 minutes with gaps of at most 6, so the minimum real candidate has 5.
    expect(currentCandidate(feed(pairAt([0, 6, 12])))).toBeNull();
  });

  it('observation count is checked separately from the span', () => {
    const state: WindowState = { pairs: { 'F2+F4': { startAt: T0, lastObsAt: T0 + 20 * MIN, observations: 2 } }, singles: {} };
    expect(currentCandidate(state)).toBeNull();
    const three: WindowState = { pairs: { 'F2+F4': { startAt: T0, lastObsAt: T0 + 20 * MIN, observations: 3 } }, singles: {} };
    expect(currentCandidate(three)).not.toBeNull();
  });
});

describe('same two families at every observation', () => {
  it('alternating single families form no pair candidate', () => {
    const alternating = feed([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((m, i) =>
      s(T0 + m * MIN, 'unknown', i % 2 === 0 ? 'positive' : 'unknown', i % 2 === 0 ? 'unknown' : 'positive')));
    expect(currentCandidate(alternating)).toBeNull();
  });

  it('a pair that is positive throughout is a candidate even when a third family comes and goes', () => {
    const state = feed([0, 5, 10, 15, 20].map((m, i) => s(T0 + m * MIN, i % 2 ? 'positive' : 'unknown', 'positive', 'positive')));
    expect(currentCandidate(state)?.pair).toBe('F2+F4');
  });
});

describe('a negative observation resets', () => {
  it('a negative of either family of the pair resets it; a negative of a third family does not', () => {
    const reset = feed([...pairAt([0, 5, 10]), s(T0 + 12 * MIN, 'unknown', 'negative', 'positive'), ...pairAt([15, 20])]);
    expect(currentCandidate(reset)).toBeNull();
    expect(reset.pairs['F2+F4']).toMatchObject({ startAt: T0 + 15 * MIN, observations: 2 });

    const third = feed([...pairAt([0, 5, 10]), s(T0 + 12 * MIN, 'negative', 'positive', 'positive'), ...pairAt([15, 20])]);
    expect(currentCandidate(third)).toMatchObject({ pair: 'F2+F4', startAt: T0 });
  });
});

describe('a missing sample neither counts nor resets', () => {
  it('unknown or ineligible for one family of the pair keeps the run, without counting', () => {
    const state = feed([...pairAt([0, 5]), s(T0 + 7 * MIN, 'unknown', 'unknown', 'positive'), s(T0 + 9 * MIN, 'unknown', 'ineligible', 'positive'), ...pairAt([10, 15, 20])]);
    expect(currentCandidate(state)).toMatchObject({ startAt: T0, observations: 5 });
  });
});

describe('a gap over 6 minutes restarts the window', () => {
  it('exactly 6 minutes between observations continues; 6 minutes and 1 ms restarts', () => {
    const atLimit = feed(pairAt([0, 6, 12, 18, 24]));
    expect(currentCandidate(atLimit)).toMatchObject({ startAt: T0, observations: 5 });

    const over = feed([s(T0, 'unknown', 'positive', 'positive'), s(T0 + 6 * MIN + 1, 'unknown', 'positive', 'positive')]);
    expect(over.pairs['F2+F4']).toMatchObject({ startAt: T0 + 6 * MIN + 1, observations: 1 });
  });

  it('missing samples do not bridge a gap: the gap is measured between observations', () => {
    const state = feed([...pairAt([0, 2]), s(T0 + 4 * MIN, 'unknown', 'unknown', 'unknown'), s(T0 + 6 * MIN, 'unknown', 'unknown', 'unknown'), ...pairAt([9])]);
    expect(state.pairs['F2+F4']).toMatchObject({ startAt: T0 + 9 * MIN, observations: 1 });
  });
});

describe('freshness for the judge', () => {
  it('both families observed positive within the last 6 minutes: fresh at exactly 6, stale after', () => {
    const run = { startAt: T0, lastObsAt: T0 + 20 * MIN, observations: 5 };
    expect(isFresh(run, T0 + 26 * MIN)).toBe(true);
    expect(isFresh(run, T0 + 26 * MIN + 1)).toBe(false);
  });
});

describe('the single-family 2-hour rule', () => {
  const single = (minutes: number[]) => feed(minutes.map((m) => s(T0 + m * MIN, 'unknown', 'positive', 'negative')));
  const every5 = (until: number) => Array.from({ length: Math.floor(until / 5) + 1 }, (_, i) => i * 5);

  it('one family for 1 h 59 min is nothing; for 2 h it is recorded, and it never forms a candidate', () => {
    expect(singleFamilyRun(single([...every5(115), 119]))).toBeNull();
    const two = single(every5(120));
    expect(singleFamilyRun(two)).toMatchObject({ family: 'F2' });
    expect(currentCandidate(two)).toBeNull();
  });

  it('a negative of that family resets it; a gap over 6 minutes restarts it', () => {
    const negative = feed([...every5(60).map((m) => s(T0 + m * MIN, 'unknown', 'positive', 'unknown')), s(T0 + 62 * MIN, 'unknown', 'negative', 'unknown'), ...every5(60).map((m) => s(T0 + (65 + m) * MIN, 'unknown', 'positive', 'unknown'))]);
    expect(singleFamilyRun(negative)).toBeNull();
    const gap = single([...every5(60), ...every5(60).map((m) => m + 67)]);
    expect(singleFamilyRun(gap)).toBeNull();
  });
});

describe('recently restarted', () => {
  it('under 6 h of uptime is recent; exactly 6 h is not; an unknown boot time stays unknown', () => {
    expect(recentlyRestarted(T0, T0 - 6 * 60 * MIN + 1)).toBe(true);
    expect(recentlyRestarted(T0, T0 - 6 * 60 * MIN)).toBe(false);
    expect(recentlyRestarted(T0, null)).toBeNull();
  });
});

describe('sampling cadence', () => {
  it('10 minutes while nothing is positive; 2 once any candidate family is', () => {
    expect(nextSampleDelay(null)).toBe(10 * MIN);
    expect(nextSampleDelay(s(T0, 'negative', 'unknown', 'negative'))).toBe(10 * MIN);
    expect(nextSampleDelay(s(T0, 'negative', 'positive', 'negative'))).toBe(2 * MIN);
  });
});

describe('rungs recorded, never run', () => {
  it('maps each proposal to its would-run rungs; a recent restart caps at the notice; no proposal is the gentle fallback', () => {
    expect(rungsFor('leave', false).rungs).toEqual([]);
    expect(rungsFor('gentle', false).rungs).toEqual([1, 2, 3]);
    expect(rungsFor('restart-next-window', false).rungs).toEqual([1, 2, 3]);
    expect(rungsFor('restart-now', false)).toEqual({ rungs: [1, 2, 3, 4, 5], conditional: [6] });
    expect(rungsFor('restart-now', true)).toEqual({ rungs: [], conditional: [] });
    expect(rungsFor(null, false).rungs).toEqual([1, 2, 3]);
  });
});
