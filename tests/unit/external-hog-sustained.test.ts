import { describe, it, expect } from 'vitest';
import {
  advanceSustained, isSustained, candidateSignature, EMPTY_SUSTAINED_STATE, type SustainedState,
} from '../../src/monitoring/ExternalHogSustained.js';

/**
 * ExternalHogSustained — the N-window sustained-CPU confirmation (CMT-1901 §1). The anti-spike
 * guard: a kill must not fire on a single-window CPU spike. These tests prove the streak climbs
 * only on CONSECUTIVE presence, resets on any absence (the safe direction), stays bounded, and
 * fails closed on a bad N.
 */

const SIG = candidateSignature(9000, 'S9000');
const N = 3;

/** Feed a sequence of per-tick candidate-signature sets; return the final tick + state. */
function run(seq: string[][]): { state: SustainedState; last: ReturnType<typeof advanceSustained> } {
  let state = EMPTY_SUSTAINED_STATE;
  let last = advanceSustained(state, []); // harmless init
  for (const sigs of seq) { last = advanceSustained(state, sigs); state = last.nextState; }
  return { state, last };
}

describe('candidateSignature', () => {
  it('is pid + start-time (defeats pid reuse)', () => {
    expect(candidateSignature(9000, 'S9000')).toBe('9000 S9000');
  });
});

describe('advanceSustained — the streak climbs only on consecutive presence', () => {
  it('a single window over threshold is NOT sustained at N=3', () => {
    const { last } = run([[SIG]]);
    expect(last.streakOf(SIG)).toBe(1);
    expect(isSustained(last, SIG, N)).toBe(false);
  });
  it('N consecutive windows qualifies exactly at the Nth', () => {
    const { last } = run([[SIG], [SIG], [SIG]]);
    expect(last.streakOf(SIG)).toBe(3);
    expect(isSustained(last, SIG, N)).toBe(true);
  });
  it('an absence mid-run RESETS the streak (a one-window dip forces re-accumulation)', () => {
    // present, present, ABSENT (spike gone this window), present → streak is only 1 again.
    const { last } = run([[SIG], [SIG], [], [SIG]]);
    expect(last.streakOf(SIG)).toBe(1);
    expect(isSustained(last, SIG, N)).toBe(false);
  });
  it('a failed/empty parse (empty set) resets EVERY streak (fail toward not-sustained)', () => {
    const { last } = run([[SIG], [SIG], []]);
    expect(last.streakOf(SIG)).toBe(0);
    expect(isSustained(last, SIG, N)).toBe(false);
  });
});

describe('advanceSustained — bounded + robust', () => {
  it('the streak map holds ONLY this tick\'s signatures (bounded; churned pids drop)', () => {
    const a = candidateSignature(1, 'A');
    const b = candidateSignature(2, 'B');
    const { state } = run([[a, b], [b]]); // a dropped on tick 2
    expect(state.streaks.has(a)).toBe(false);
    expect(state.streaks.get(b)).toBe(2);
    expect(state.streaks.size).toBe(1);
  });
  it('a duplicate signature in one tick increments only once', () => {
    const { last } = run([[SIG, SIG, SIG]]);
    expect(last.streakOf(SIG)).toBe(1);
  });
  it('a malformed signature (empty string) is ignored, never counted', () => {
    const t = advanceSustained(EMPTY_SUSTAINED_STATE, ['', SIG]);
    expect(t.streakOf('')).toBe(0);
    expect(t.streakOf(SIG)).toBe(1);
  });
});

describe('isSustained — a bad N fails CLOSED (never sustained)', () => {
  it('N <= 0 or non-finite never qualifies even a long streak', () => {
    const { last } = run([[SIG], [SIG], [SIG], [SIG]]);
    expect(isSustained(last, SIG, 0)).toBe(false);
    expect(isSustained(last, SIG, -1)).toBe(false);
    expect(isSustained(last, SIG, Number.NaN)).toBe(false);
    expect(isSustained(last, SIG, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSustained(last, SIG, 4)).toBe(true); // sanity: a valid N over the streak qualifies
  });
});
