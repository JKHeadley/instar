/**
 * computePressure after reaper-pressure-signals: the seven invariants of
 * docs/specs/reaper-pressure-signals.md §4, plus the exact 2026-10-25 input vector as a
 * named regression — the reading that cried `critical` at 36-44% idle and had no view of
 * 35 GB in the compressor.
 */
import { describe, it, expect } from 'vitest';
import { computePressure } from '../../src/monitoring/SessionReaper.js';
import { parseVmStat, hostCompressorPct, makeDecompressionRateSampler, readKernelMemoryPressureLevel } from '../../src/monitoring/hostMemoryPressure.js';

const LOAD = { cpuModerateLoadPerCore: 1.0, cpuCriticalLoadPerCore: 1.5 };

/** Justin's laptop, 2026-10-25 ~20:00 PDT, as the reaper and `top` both saw it. */
const LAPTOP_2026_10_25 = { freePct: 42.8, loadPerCore: 9.4, cpuBusyPct: 100 - 40.7, compressorPct: 35 / 128 * 100 };

describe('computePressure — CPU from real busy %, not the load average', () => {
  // Invariant 1 — the measured case does not grade critical on CPU.
  it('REGRESSION 2026-10-25: 36-44% idle is not critical, even with loadPerCore 9.4 present', () => {
    const r = computePressure(LAPTOP_2026_10_25, LOAD);
    expect(r.inputs?.cpuTier).toBe('normal');
    expect(r.inputs?.loadPerCore).toBe(9.4); // still reported, no longer decisive
    expect(r.inputs?.cpuSignal).toBe('busy');
  });

  // Invariant 2 — a genuinely pegged CPU still grades critical.
  it('95% busy is critical; 80% is moderate; 50% is normal', () => {
    expect(computePressure({ freePct: 50, loadPerCore: 0.2, cpuBusyPct: 95 }, LOAD).inputs?.cpuTier).toBe('critical');
    expect(computePressure({ freePct: 50, loadPerCore: 0.2, cpuBusyPct: 80 }, LOAD).inputs?.cpuTier).toBe('moderate');
    expect(computePressure({ freePct: 50, loadPerCore: 0.2, cpuBusyPct: 50 }, LOAD).inputs?.cpuTier).toBe('normal');
  });

  // Invariant 3 — unknown CPU is memory-only and does NOT consult loadPerCore.
  it('cpuBusyPct null → cpuTier normal, tier from memory alone, loadPerCore ignored', () => {
    const r = computePressure({ freePct: 50, loadPerCore: 9.4, cpuBusyPct: null }, LOAD);
    expect(r.inputs?.cpuTier).toBe('normal');
    expect(r.tier).toBe('normal');
    const r2 = computePressure({ freePct: 3, loadPerCore: 9.4, cpuBusyPct: null }, LOAD);
    expect(r2.tier).toBe('critical'); // memory decided it
    expect(r2.inputs?.memTier).toBe('critical');
  });

  it('an omitted cpuBusyPct (older caller) behaves as unknown', () => {
    expect(computePressure({ freePct: 50, loadPerCore: 9.4 }, LOAD).inputs?.cpuTier).toBe('normal');
  });

  // Invariant 7 — the rollback lever reproduces the old grading exactly.
  it("cpuSignal: 'load' reproduces the 2026-10-25 reading (9.4/core → critical)", () => {
    const r = computePressure(LAPTOP_2026_10_25, { ...LOAD, cpuSignal: 'load' });
    expect(r.inputs?.cpuTier).toBe('critical');
    expect(r.inputs?.cpuSignal).toBe('load');
  });

  it('busy thresholds are configurable', () => {
    const r = computePressure({ freePct: 50, loadPerCore: 0, cpuBusyPct: 60 }, { ...LOAD, cpuModerateBusyPct: 50, cpuCriticalBusyPct: 59 });
    expect(r.inputs?.cpuTier).toBe('critical');
  });
});

describe('computePressure — the compressor readings are OBSERVABLES and grade NOTHING', () => {
  const healthyStudio = { freePct: 46, loadPerCore: 1.36, cpuBusyPct: 31, compressorPct: 35.3, decompressionsPerSec: 94_090, kernelMemoryPressureLevel: 1 };

  it('MEASURED: a healthy Studio at 35% occupancy and 94k decompressions/s grades normal — and so would ANY compressor reading', () => {
    // Three drafts graded these numbers (occupancy; occupancy AND activity; the kernel's own
    // level). Round-2 review measured each one against real machines: a healthy Studio reads
    // 35% at level 1, and `kern.memorystatus_level` reads 59 there while the 2026-10-25
    // laptop computes to ~67 — so no candidate separated the strained machine from the
    // healthy one. The grade was withdrawn; the readings stayed.
    const r = computePressure(healthyStudio, LOAD);
    expect(r.inputs?.memTier).toBe('normal');
    expect(r.inputs?.compressorPct).toBeCloseTo(35.3, 1);   // reported
    expect(r.inputs?.decompressionsPerSec).toBe(94_090);    // reported
    expect(r.inputs?.kernelMemoryPressureLevel).toBe(1);    // reported
  });

  it('NO compressor reading can change memTier — not occupancy, not activity, not the kernel level', () => {
    const base = { freePct: 46, loadPerCore: 0, cpuBusyPct: 10 };
    const baseline = computePressure(base, LOAD).inputs?.memTier;
    for (const extra of [
      { compressorPct: 99 },
      { decompressionsPerSec: 10_000_000 },
      { kernelMemoryPressureLevel: 2 },
      { kernelMemoryPressureLevel: 4 },
      { compressorPct: 99, decompressionsPerSec: 10_000_000, kernelMemoryPressureLevel: 4 },
    ]) {
      expect(computePressure({ ...base, ...extra }, LOAD).inputs?.memTier).toBe(baseline);
    }
  });

  it('the memory tier is the available-memory tier, exactly as before this change', () => {
    expect(computePressure({ freePct: 2, loadPerCore: 0, cpuBusyPct: 10, kernelMemoryPressureLevel: 1 }, LOAD).inputs?.memTier).toBe('critical');
    expect(computePressure({ freePct: 9, loadPerCore: 0, cpuBusyPct: 10, kernelMemoryPressureLevel: 4 }, LOAD).inputs?.memTier).toBe('moderate');
    expect(computePressure({ freePct: 46, loadPerCore: 0, cpuBusyPct: 10, kernelMemoryPressureLevel: 4 }, LOAD).inputs?.memTier).toBe('normal');
  });

  it('REGRESSION 2026-10-25 laptop: the readings are surfaced, the tier is untouched', () => {
    const r = computePressure(LAPTOP_2026_10_25, LOAD);
    expect(r.inputs?.compressorPct).toBeCloseTo(27.34, 1);
    expect(r.inputs?.kernelMemoryPressureLevel).toBeNull(); // never sampled that night
    expect(r.inputs?.memTier).toBe('normal');               // honest: no memory signal fired
  });

  it('an unmeasurable compressor is null, never a fabricated 0 — and still grades nothing', () => {
    const r = computePressure({ freePct: 42.8, loadPerCore: 0.1, cpuBusyPct: 10, compressorPct: null, kernelMemoryPressureLevel: null }, LOAD);
    expect(r.inputs?.compressorPct).toBeNull();
    expect(r.inputs?.kernelMemoryPressureLevel).toBeNull();
    expect(r.inputs?.memTier).toBe('normal');
  });
});

describe('vm_stat exposes the compressor', () => {
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              614537.
Pages active:                           2444206.
Pages inactive:                         2377162.
Pages speculative:                       123937.
Pages throttled:                              0.
Pages wired down:                        483848.
Pages purgeable:                          82265.
Pages occupied by compressor:           2200000.
Decompressions:                        91234567.
`;
  it('parseVmStat reports compressorPercent, decompressions and the page size from the real 2026-10-25 shape', () => {
    const r = parseVmStat(VM_STAT);
    const total = 614537 + 2444206 + 2377162 + 483848 + 2200000;
    expect(r.compressorPercent).toBeCloseTo((2200000 / total) * 100, 6);
    expect(r.decompressions).toBe(91234567);
    expect(r.pageSizeBytes).toBe(16384);
  });
  it('an ABSENT label is null, never a fabricated 0', () => {
    const noCompressor = VM_STAT.replace(/Pages occupied by compressor:.*\n/, '').replace(/Decompressions:.*\n/, '');
    const r = parseVmStat(noCompressor);
    expect(r.compressorPercent).toBeNull();
    expect(r.decompressions).toBeNull();
  });
  it('hostCompressorPct is null off-macOS, never a fabricated 0', () => {
    expect(hostCompressorPct({ platform: 'linux', procMeminfo: () => 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n' })).toBeNull();
  });
  it('the decompression-rate sampler uses the SAMPLE clock: null first, then a rate, null on a counter reset', () => {
    let d = 1000;
    const reading = () => ({ pressurePercent: 50, freeGB: 1, totalGB: 2, compressorPercent: 10, decompressions: d, pageSizeBytes: 16384 });
    const sampler = makeDecompressionRateSampler(reading);
    const t0 = 1_800_000_000_000;
    expect(sampler.sample(t0)).toBeNull();
    d += 250;
    expect(sampler.sample(t0 + 10_000)!).toBeCloseTo(25, 6); // 250 over 10 s — the caller's clock, not Date.now()
    d = 10; // reset
    expect(sampler.sample(t0 + 20_000)).toBeNull();
  });
  it('readKernelMemoryPressureLevel maps 1/2/4, is null off-macOS and on garbage', () => {
    expect(readKernelMemoryPressureLevel({ platform: 'darwin', sysctl: () => '1\n' })).toBe(1);
    expect(readKernelMemoryPressureLevel({ platform: 'darwin', sysctl: () => '4' })).toBe(4);
    expect(readKernelMemoryPressureLevel({ platform: 'darwin', sysctl: () => 'nope' })).toBeNull();
    expect(readKernelMemoryPressureLevel({ platform: 'linux' })).toBeNull();
  });
});
