/**
 * Tier 1 (unit) tests for HostPressureSampler (cartographer-doc-freshness spec #2).
 * The sampler was EXTRACTED from the SessionReaper's inline pressure() — these
 * tests pin the behavior-preserving contract: the shared sampler must produce the
 * SAME tier the reaper's own computePressure would, for the same inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  sampleHostPressure,
  sampleHostPressureInputs,
  DEFAULT_HOST_PRESSURE_THRESHOLDS,
  _resetHostPressureSamplerForTests,
  MIN_SAMPLE_WINDOW_MS,
} from '../../src/monitoring/HostPressureSampler.js';
import { computePressure } from '../../src/monitoring/SessionReaper.js';

describe('HostPressureSampler', () => {
  it('inputs are well-formed (freePct in [0,100], loadPerCore null or finite >= 0)', () => {
    const { freePct, loadPerCore } = sampleHostPressureInputs();
    expect(freePct).toBeGreaterThanOrEqual(0);
    expect(freePct).toBeLessThanOrEqual(100);
    if (loadPerCore != null) {
      expect(Number.isFinite(loadPerCore)).toBe(true);
      expect(loadPerCore).toBeGreaterThanOrEqual(0);
    }
  });

  it('is behavior-preserving: sampleHostPressure === computePressure over the SAME cached reading', () => {
    const thresholds = DEFAULT_HOST_PRESSURE_THRESHOLDS;
    // The 30 s cache makes this a REAL check rather than a tautology: both calls land inside
    // one window, so they see the identical inputs, and the assertion fails if
    // sampleHostPressure ever stops delegating to computePressure.
    const viaSampler = sampleHostPressure(thresholds);
    const inputs = sampleHostPressureInputs();
    const viaCompute = computePressure(inputs, thresholds);
    expect(viaSampler.tier).toBe(viaCompute.tier);
    expect(viaSampler.inputs?.memTier).toBe(viaCompute.inputs?.memTier);
    expect(viaSampler.inputs?.cpuTier).toBe(viaCompute.inputs?.cpuTier);
  });

  it("honors custom LOAD thresholds under cpuSignal 'load' (the rollback lever)", () => {
    // computePressure is the authority; assert the sampler delegates to it with our thresholds.
    // Since reaper-pressure-signals the DEFAULT signal is sampled busy %, under which a bare
    // loadPerCore decides nothing — so this legacy-threshold check names the 'load' signal.
    const lowCritical = { cpuModerateLoadPerCore: 0.0001, cpuCriticalLoadPerCore: 0.0002, cpuSignal: 'load' as const };
    const inputs = { freePct: 100, loadPerCore: 5 };
    expect(computePressure(inputs, lowCritical).tier).toBe('critical');
    // and under the default signal the same load reading is NOT a verdict
    expect(computePressure(inputs, { cpuModerateLoadPerCore: 0.0001, cpuCriticalLoadPerCore: 0.0002 }).tier).toBe('normal');
  });

  it('defaults match the reaper historical load thresholds (1.0 / 1.5) and select the busy signal', () => {
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuModerateLoadPerCore).toBe(1.0);
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuCriticalLoadPerCore).toBe(1.5);
    expect(DEFAULT_HOST_PRESSURE_THRESHOLDS.cpuSignal).toBe('busy');
  });
});

describe('HostPressureSampler — one memory read per sample, cached for a minimum window', () => {
  const reading = (decompressions: number) => ({ pressurePercent: 57.2, freeGB: 50, totalGB: 128, compressorPercent: 27.3, decompressions, pageSizeBytes: 16384 });

  it('reads memory ONCE per sample and derives freePct, compressorPct and the decompression rate from it', () => {
    let reads = 0;
    let d = 1000;
    const t0 = 1_800_000_000_000;
    _resetHostPressureSamplerForTests(() => { reads += 1; return reading(d); }, () => 1, () => t0);
    const a = sampleHostPressureInputs(t0);
    expect(reads).toBe(1);
    expect(a.kernelMemoryPressureLevel).toBe(1);
    expect(a.freePct).toBeCloseTo(42.8, 1);
    expect(a.compressorPct).toBeCloseTo(27.3, 1);
    expect(a.decompressionsPerSec).toBeNull(); // first sample: no previous counter
    d += 3000;
    const b = sampleHostPressureInputs(t0 + MIN_SAMPLE_WINDOW_MS);
    expect(reads).toBe(2);
    expect(b.decompressionsPerSec).not.toBeNull();
  });

  it('a caller inside the window gets the SAME cached reading — an observability poll cannot shrink a decision consumer\'s window', () => {
    let reads = 0;
    const t0 = 1_800_000_000_000;
    _resetHostPressureSamplerForTests(() => { reads += 1; return reading(1); }, () => 1, () => t0);
    const first = sampleHostPressureInputs(t0);
    // a dashboard polling every second for the next 29 s
    for (let i = 1; i < 30; i++) {
      const again = sampleHostPressureInputs(t0 + i * 1000);
      expect(again).toBe(first);           // identical object, same sampledAt
      expect(again.sampledAt).toBe(t0);
    }
    expect(reads).toBe(1);
    // the reaper's tick at +30 s gets a FRESH sample whose window is the full 30 s
    const next = sampleHostPressureInputs(t0 + MIN_SAMPLE_WINDOW_MS);
    expect(next.sampledAt).toBe(t0 + MIN_SAMPLE_WINDOW_MS);
    expect(next.windowMs).toBe(MIN_SAMPLE_WINDOW_MS);
    expect(reads).toBe(2);
  });

  it('a memory read that throws yields unknown compressor inputs and a 100% free fallback, never a crash', () => {
    _resetHostPressureSamplerForTests(() => { throw new Error('vm_stat exploded'); }, () => null, () => 1_800_000_000_000);
    const r = sampleHostPressureInputs(1_800_000_000_000);
    expect(r.compressorPct).toBeNull();
    expect(r.decompressionsPerSec).toBeNull();
    expect(r.freePct).toBe(100);
    expect(r.kernelMemoryPressureLevel).toBeNull();
  });

  it('CPU is UNKNOWN until a full window has elapsed, then a real average — never a millisecond spike', () => {
    // Both round-2 reviewers: priming must establish the baseline only. A window of
    // milliseconds taken at process startup, then cached 30 s for every decision consumer,
    // is the false `critical` this change removes. The TICK source is injected alongside the
    // clock — a synthetic 30 s jump against real os.cpus() ticks is unmeasurable, so without
    // this seam the assertion would pass or fail by luck.
    const t0 = 1_800_000_000_000;
    let ticks = 0;
    const readCpus = () => {
      ticks += 1;
      // each read advances 100 ticks, 40 of them idle → 60% busy
      return [{ times: { user: 60 * ticks, nice: 0, sys: 0, idle: 40 * ticks, irq: 0 } }] as never;
    };
    _resetHostPressureSamplerForTests(() => reading(1), () => 1, () => t0, readCpus);
    const first = sampleHostPressureInputs(t0 + 5); // 5 ms after the baseline
    expect(first.cpuBusyPct).toBeNull();            // unknown ⇒ memory-only (invariant 3)
    const later = sampleHostPressureInputs(t0 + 5 + MIN_SAMPLE_WINDOW_MS);
    expect(later.cpuBusyPct).not.toBeNull();        // a real average over the full window
    expect(later.cpuBusyPct!).toBeCloseTo(60, 5);
  });

  it('the cached reading is frozen — one consumer cannot poison the window for the others', () => {
    const t0 = 1_800_000_000_000;
    _resetHostPressureSamplerForTests(() => reading(1), () => 1, () => t0);
    const a = sampleHostPressureInputs(t0);
    expect(() => { (a as { freePct: number }).freePct = -999; }).toThrow();
    expect(sampleHostPressureInputs(t0 + 1).freePct).toBe(a.freePct);
  });
});
