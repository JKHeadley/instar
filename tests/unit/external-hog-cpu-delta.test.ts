import { describe, it, expect } from 'vitest';
import {
  computeCoreEquivalents,
  meetsThreshold,
  isUnknown,
  monotonicNowMs,
  CPU_DELTA_UNKNOWN,
  type CpuSample,
} from '../../src/monitoring/ExternalHogCpuDelta.js';

/**
 * ExternalHogCpuDelta — the monotonic-clock CPU-delta core (CMT-1901, §1).
 * The signal is Δcputime/Δwall in core-equivalents, on a MONOTONIC clock, failing CLOSED
 * (→ UNKNOWN, never a kill) on any implausible interval.
 */
const WINDOW = 30_000; // ms — the intended sampling window

const s = (cpu: number, wall: number): CpuSample => ({ cumulativeCpuSeconds: cpu, monotonicWallMs: wall });

describe('computeCoreEquivalents — core-equivalents math', () => {
  it('a process consuming ~2 CPU-sec per wall-sec reads ~2 cores', () => {
    // 60 CPU-sec over a 30s window = 2.0 core-equivalents (the anchor hog's ~2.2 shape).
    const v = computeCoreEquivalents(s(100, 0), s(160, 30_000), { intendedWindowMs: WINDOW });
    expect(isUnknown(v)).toBe(false);
    expect(v).toBeCloseTo(2.0, 5);
  });
  it('an idle process (no cputime accrued) reads 0 cores', () => {
    const v = computeCoreEquivalents(s(500, 0), s(500, 30_000), { intendedWindowMs: WINDOW });
    expect(v).toBe(0);
  });
  it('a full single core reads 1.0 (sampled over a full window)', () => {
    const v = computeCoreEquivalents(s(0, 0), s(30, 30_000), { intendedWindowMs: WINDOW });
    expect(v).toBeCloseTo(1.0, 5);
  });
});

describe('computeCoreEquivalents — FAILS CLOSED (→ UNKNOWN) on implausible intervals', () => {
  it('non-positive Δwall (clock went backward / same instant) → UNKNOWN', () => {
    expect(computeCoreEquivalents(s(0, 1000), s(60, 1000), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
    expect(computeCoreEquivalents(s(0, 2000), s(60, 1000), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
  });
  it('implausibly-large Δwall (a sleep slipped through — hours across a 30s window) → UNKNOWN', () => {
    // This is THE sleep/wake case: Δwall = 3h while cputime barely moved would read ~0 and
    // mask a hog; the guard rejects the interval as not-the-window-we-think-it-is.
    const threeHoursMs = 3 * 60 * 60 * 1000;
    expect(computeCoreEquivalents(s(100, 0), s(101, threeHoursMs), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
  });
  it('an implausibly-SMALL Δwall (sub-window; ps quantization inflates the ratio) → UNKNOWN', () => {
    // The dangerous FALSE-HIGH direction: an idle process sampled over 200ms, where a single
    // 1-second `ps time=` quantization tick reads 1/0.2 = 5 cores. Must fail CLOSED, not report
    // a false sustained hog. (round-11 second-pass fix — symmetric lower bound.)
    const v = computeCoreEquivalents(s(0, 0), s(1, 200), { intendedWindowMs: WINDOW });
    expect(v).toBe(CPU_DELTA_UNKNOWN);
    expect(meetsThreshold(v, 1.5)).toBe(false);
  });
  it('a DECREASING cumulative counter (pid reuse under the same key) → UNKNOWN', () => {
    expect(computeCoreEquivalents(s(500, 0), s(10, 30_000), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
  });
  it('a non-finite input (NaN/Infinity leaked from a fact source) → UNKNOWN', () => {
    expect(computeCoreEquivalents(s(NaN, 0), s(60, 30_000), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
    expect(computeCoreEquivalents(s(0, 0), s(Infinity, 30_000), { intendedWindowMs: WINDOW })).toBe(CPU_DELTA_UNKNOWN);
  });
  it('a NON-POSITIVE window fails CLOSED → UNKNOWN (round-11: ≤0 window must not skip the guards)', () => {
    // The cross-module bug the sampler review found: a ≤0 window would otherwise skip BOTH
    // plausibility guards and let a tiny-Δwall quantization tick inflate the ratio.
    expect(computeCoreEquivalents(s(0, 0), s(1, 50), { intendedWindowMs: 0 })).toBe(CPU_DELTA_UNKNOWN);
    expect(computeCoreEquivalents(s(0, 0), s(1, 50), { intendedWindowMs: -1 })).toBe(CPU_DELTA_UNKNOWN);
  });
  it('a slightly-long Δwall WITHIN the implausible factor still computes (jitter tolerance)', () => {
    // 30s window, Δwall = 90s (3× < the default 4× factor) — accepted, just a slower tick.
    const v = computeCoreEquivalents(s(0, 0), s(90, 90_000), { intendedWindowMs: WINDOW });
    expect(isUnknown(v)).toBe(false);
    expect(v).toBeCloseTo(1.0, 5);
  });
});

describe('meetsThreshold — UNKNOWN is never a hog (fail closed)', () => {
  it('a 2-core reading meets the 1.5 threshold', () => {
    expect(meetsThreshold(2.0, 1.5)).toBe(true);
  });
  it('a 0.4-core reading does NOT meet the 1.5 threshold', () => {
    expect(meetsThreshold(0.4, 1.5)).toBe(false);
  });
  it('UNKNOWN never meets the threshold (→ not a confirmed hog → alert-never-kill)', () => {
    expect(meetsThreshold(CPU_DELTA_UNKNOWN, 1.5)).toBe(false);
    expect(meetsThreshold(CPU_DELTA_UNKNOWN, 0)).toBe(false);
  });
});

describe('monotonicNowMs — monotonic clock', () => {
  it('is non-decreasing across successive reads', () => {
    const a = monotonicNowMs();
    const b = monotonicNowMs();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });
});
