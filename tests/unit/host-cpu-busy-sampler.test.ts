/**
 * hostCpuBusySampler — real CPU busy % from os.cpus() tick deltas.
 * Spec: docs/specs/reaper-pressure-signals.md §3a, invariant 6.
 */
import { describe, it, expect } from 'vitest';
import { snapshotFromCpus, busyPctBetween, makeHostCpuBusySampler } from '../../src/monitoring/hostCpuBusySampler.js';

type Cpu = { times: { user: number; nice: number; sys: number; idle: number; irq: number } };
const cpu = (user: number, sys: number, idle: number): Cpu => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

describe('snapshotFromCpus', () => {
  it('sums ticks across cores', () => {
    expect(snapshotFromCpus([cpu(10, 5, 85), cpu(20, 10, 70)])).toEqual({ total: 200, idle: 155 });
  });
  it('an empty or non-finite table is null, never a fabricated zero', () => {
    expect(snapshotFromCpus([])).toBeNull();
    expect(snapshotFromCpus([{ times: { user: NaN, nice: 0, sys: 0, idle: 0, irq: 0 } }])).toBeNull();
  });
});

describe('busyPctBetween', () => {
  it('is the busy fraction of the interval between two snapshots', () => {
    // 100 ticks elapsed, 40 idle → 60% busy
    expect(busyPctBetween({ total: 1000, idle: 500 }, { total: 1100, idle: 540 })).toBeCloseTo(60, 5);
  });
  it('reports null, not 0% or 100%, when the pair cannot yield a measurement', () => {
    expect(busyPctBetween(null, { total: 1, idle: 1 })).toBeNull();          // no previous snapshot
    expect(busyPctBetween({ total: 100, idle: 50 }, { total: 100, idle: 50 })).toBeNull(); // same tick
    expect(busyPctBetween({ total: 200, idle: 50 }, { total: 100, idle: 50 })).toBeNull(); // counter reset
    expect(busyPctBetween({ total: 100, idle: 50 }, { total: 200, idle: 40 })).toBeNull(); // idle went backwards
    expect(busyPctBetween({ total: 100, idle: 10 }, { total: 200, idle: 200 })).toBeNull(); // idle > total delta
  });
});

describe('makeHostCpuBusySampler', () => {
  /** A sampler on a synthetic clock with a 10 s window floor. */
  const onClock = (readCpus: () => unknown, clock: { ms: number }) =>
    makeHostCpuBusySampler(readCpus as never, { minWindowMs: 10_000, now: () => clock.ms });

  it('reports null on the first call, then a finite 0-100 number once a full window has passed', () => {
    let t = 0;
    const clock = { ms: 0 };
    const sampler = onClock(() => {
      t += 1;
      // each call: +100 ticks total, of which idle advances by 60 → 40% busy
      return [cpu(40 * t, 0, 60 * t)];
    }, clock);
    expect(sampler.sample()).toBeNull(); // no previous snapshot
    clock.ms += 10_000;
    const second = sampler.sample();
    expect(second).not.toBeNull();
    expect(second!).toBeCloseTo(40, 5);
    clock.ms += 10_000;
    expect(sampler.sample()!).toBeCloseTo(40, 5);
  });

  it('a measurable delta over TOO SHORT a window is null — a spike is not an average', () => {
    // The round-2 finding: a reading taken milliseconds after the baseline would otherwise be
    // published and then cached for the whole window.
    let t = 0;
    const clock = { ms: 0 };
    const sampler = onClock(() => {
      t += 1;
      return [cpu(100 * t, 0, 0)]; // 100% busy every interval
    }, clock);
    expect(sampler.sample()).toBeNull();
    clock.ms += 5; // 5 ms later: measurable, but not an average
    expect(sampler.sample()).toBeNull();
    clock.ms += 10_000;
    expect(sampler.sample()!).toBeCloseTo(100, 5); // now the window is wide enough
  });

  it('the window floor is measured from the LAST sample, so a short call does not reset the clock twice', () => {
    let t = 0;
    const clock = { ms: 0 };
    const sampler = onClock(() => { t += 1; return [cpu(50 * t, 0, 50 * t)]; }, clock);
    sampler.sample();            // baseline at 0
    clock.ms = 9_000;
    expect(sampler.sample()).toBeNull();   // 9 s: under the floor
    clock.ms = 18_000;                      // 9 s after THAT sample, still under the floor
    expect(sampler.sample()).toBeNull();
    clock.ms = 30_000;                      // 12 s after the last: wide enough
    expect(sampler.sample()).not.toBeNull();
  });

  it('a read that throws is null, and the next good read measures across the gap', () => {
    let n = 0;
    const clock = { ms: 0 };
    const sampler = onClock(() => {
      n += 1;
      if (n === 2) throw new Error('cpu table unavailable');
      return [cpu(10 * n, 0, 90 * n)];
    }, clock);
    expect(sampler.sample()).toBeNull(); // first call: no previous snapshot
    clock.ms += 10_000;
    expect(sampler.sample()).toBeNull(); // threw: unknown, previous snapshot kept
    clock.ms += 10_000;
    // diffed against the FIRST snapshot (the gap is simply a longer interval)
    expect(sampler.sample()!).toBeCloseTo(10, 5);
  });

  it('defaults to the 30 s floor when no window is given', () => {
    const clock = { ms: 0 };
    let t = 0;
    const sampler = makeHostCpuBusySampler(
      (() => { t += 1; return [cpu(70 * t, 0, 30 * t)]; }) as never,
      { now: () => clock.ms },
    );
    expect(sampler.sample()).toBeNull();
    clock.ms = 29_999;
    expect(sampler.sample()).toBeNull();
    clock.ms = 29_999 + 30_000;
    expect(sampler.sample()).not.toBeNull();
  });
});
