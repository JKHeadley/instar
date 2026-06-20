/**
 * B2 (multimachine-lease-poll-robustness, Decision 8) — lease flap circuit-breaker.
 * Proves: trips above the flip threshold, latches to a DETERMINISTIC role
 * (preferred→awake / other→standby, never a mid-flap snapshot), auto-resets after
 * a calm window, exhausts (stays latched) above the latch-per-hour cap, and prunes
 * its rolling windows.
 */

import { describe, it, expect } from 'vitest';
import { ChurnBreaker } from '../../src/core/churnBreaker.js';

const CFG = { maxFlipsPerWindow: 4, windowMs: 600_000, maxLatchesPerHour: 3 };

function flap(b: ChurnBreaker, n: number) {
  let v = { latched: false } as ReturnType<ChurnBreaker['recordFlip']>;
  for (let i = 0; i < n; i++) v = b.recordFlip();
  return v;
}

describe('B2 ChurnBreaker — deterministic lease flap circuit-breaker', () => {
  it('does NOT latch at or below the flip threshold', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => t);
    const v = flap(b, 4); // == threshold, not ">"
    expect(v.latched).toBe(false);
    expect(b.latchedRole(true)).toBeNull();
  });

  it('latches once flips EXCEED the threshold within the window', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => { t += 1000; return t; }); // 1s between flips
    const v = flap(b, 5); // 5 > 4
    expect(v.latched).toBe(true);
    expect(v.flipsInWindow).toBe(5);
  });

  it('latches to a DETERMINISTIC role: preferred→awake, other→standby (not a snapshot)', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => { t += 1000; return t; });
    flap(b, 5);
    expect(b.latchedRole(true)).toBe('awake');   // the preferred machine
    expect(b.latchedRole(false)).toBe('standby'); // every other machine
  });

  it('auto-resets after a calm windowMs with no new flips', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => t);
    for (let i = 0; i < 5; i++) { t += 1000; b.recordFlip(); }
    expect(b.tick().latched).toBe(true);
    t += CFG.windowMs; // a full calm window elapses
    expect(b.tick().latched).toBe(false); // un-latched
    expect(b.latchedRole(false)).toBeNull();
  });

  it('EXHAUSTS (stays latched, no auto-reset) above maxLatchesPerHour', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => t);
    // Drive 4 latch episodes (cap is 3) within an hour, each separated by a calm reset.
    for (let episode = 0; episode < 4; episode++) {
      for (let i = 0; i < 5; i++) { t += 1000; b.recordFlip(); }
      t += CFG.windowMs; // calm window → would auto-reset (until exhausted)
      b.tick();
    }
    const v = b.tick();
    expect(v.exhausted).toBe(true);
    expect(v.latched).toBe(true); // exhausted → stays latched even after a calm window
    // Another calm window must NOT clear an exhausted breaker.
    t += CFG.windowMs;
    expect(b.tick().latched).toBe(true);
  });

  it('two machines flapping reach COMPLEMENTARY resting roles (exactly-one-awake) — the core B2 invariant', () => {
    // Each machine runs its own breaker. The preferred-awake machine and the
    // other machine, both tripped by the same flap, must latch to opposite roles
    // → exactly one awake, never both-awake (dual-poll) or both-standby (silence).
    let t = 1000;
    const clock = () => { t += 1000; return t; };
    const preferred = new ChurnBreaker(CFG, clock);
    const other = new ChurnBreaker(CFG, clock);
    flap(preferred, 5);
    flap(other, 5);
    expect(preferred.latchedRole(true)).toBe('awake');   // this machine IS preferred
    expect(other.latchedRole(false)).toBe('standby');    // this machine is NOT preferred
    // Complementary: exactly one 'awake' across the pair.
    const awakeCount = [preferred.latchedRole(true), other.latchedRole(false)].filter((r) => r === 'awake').length;
    expect(awakeCount).toBe(1);
  });

  it('prunes old flips out of the window (a slow drip never trips it)', () => {
    let t = 1000;
    const b = new ChurnBreaker(CFG, () => t);
    for (let i = 0; i < 10; i++) { t += CFG.windowMs; b.recordFlip(); } // one flip per full window
    const v = b.tick();
    expect(v.flipsInWindow).toBeLessThanOrEqual(1);
    expect(v.latched).toBe(false);
  });
});
