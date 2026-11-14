/**
 * HostPressureSampler — a single, shared host CPU+memory pressure reading.
 *
 * Extracted (behavior-preserving) from the `SessionReaper` wiring in
 * `server.ts`, which computed pressure inline via `os` + `computePressure`.
 * The CartographerSweepPoller (spec #2, doc-freshness) needs the SAME pressure
 * signal to curtail/skip authoring under load, so the computation is lifted here
 * and both callers share it. There is exactly one definition of "host pressure"
 * in the codebase — the reaper and the sweep cannot drift apart.
 *
 * Behavior contract (must stay byte-identical to the prior reaper inline code):
 *  - freePct  = available memory % from ONE vm_stat / meminfo read per sample.
 *  - loadPerCore = loadavg[0] / cores     (null when cores is 0/unknown) — reported, and
 *    decisive only under cpuSignal 'load'.
 *  - cpuBusyPct = real busy % since the previous sample (null on the first call).
 *  - compressorPct = macOS compressor occupancy (null elsewhere).
 *  - tier = WORST of memory and CPU, via the existing `computePressure`.
 * The CPU thresholds default to the reaper's historical 1.0 / 1.5 per-core so an
 * unconfigured caller reads exactly what the reaper read before this extraction.
 */
import os from 'node:os';
import { computePressure, type PressureReading, type PressureThresholds, type PressureInputs } from './SessionReaper.js';
import { readSystemMemoryPressure, makeDecompressionRateSampler, readKernelMemoryPressureLevel } from './hostMemoryPressure.js';
import { makeHostCpuBusySampler } from './hostCpuBusySampler.js';
import { mergeDefaults } from '../core/mergeDefaults.js';

/** Thresholds. The load-per-core pair mirrors the reaper's historical constants; the rest are the reaper-pressure-signals additions. */
export type HostPressureThresholds = PressureThresholds;

/** The reaper's historical load defaults, plus `cpuSignal: 'busy'` — the measured-CPU default (spec reaper-pressure-signals). */
export const DEFAULT_HOST_PRESSURE_THRESHOLDS: HostPressureThresholds = {
  cpuModerateLoadPerCore: 1.0,
  cpuCriticalLoadPerCore: 1.5,
  cpuSignal: 'busy',
};

/** Raw inputs — exposed for observability/tests. */
export type HostPressureInputs = PressureInputs & {
  /** Epoch ms of the sample these inputs came from (the cached reading's timestamp). */
  sampledAt?: number;
  /** Width of the rate window the busy/decompression figures were measured over. */
  windowMs?: number | null;
};

/**
 * Minimum width of a rate window. The CPU busy % and the decompression rate are DELTAS
 * between consecutive samples, and the two samplers are process-wide — so without this a
 * dashboard polling `GET /sessions/reaper` every second would shrink the reaper's next window
 * to seconds and hand it exactly the burst-prone reading this change exists to remove
 * (cross-model review, both families). Every caller inside the window gets the SAME cached
 * reading; the window only advances when at least this much time has passed.
 */
export const MIN_SAMPLE_WINDOW_MS = 30_000;

/**
 * ONE process-wide CPU sampler and ONE decompression-rate sampler, advanced only by
 * `takeSample`. Both are built by `freshSamplers()`, which PRIMES the CPU sampler on the
 * SAME clock the samples will use: priming establishes the tick BASELINE and nothing more,
 * because a window under `MIN_SAMPLE_WINDOW_MS` reports unknown (memory-only, invariant 3).
 * Both round-2 reviewers found the alternative — publishing the millisecond-wide reading
 * taken just after module load, then caching it 30 s for every decision consumer — to be
 * the exact false `critical` this change exists to remove.
 */
function freshSamplers(
  now: () => number,
  readCpus?: () => ReturnType<typeof os.cpus>,
): { cpuBusy: ReturnType<typeof makeHostCpuBusySampler>; decompressionRate: ReturnType<typeof makeDecompressionRateSampler> } {
  const cpuBusy = makeHostCpuBusySampler(readCpus, { minWindowMs: MIN_SAMPLE_WINDOW_MS, now });
  cpuBusy.sample();
  return { cpuBusy, decompressionRate: makeDecompressionRateSampler() };
}

let cached: { inputs: HostPressureInputs; atMs: number } | null = null;
let memReader: () => ReturnType<typeof readSystemMemoryPressure> = () => readSystemMemoryPressure();
let kernelReader: () => number | null = () => readKernelMemoryPressureLevel();
let samplers = freshSamplers(() => Date.now());

/**
 * Test seam: forget the cached reading, rebuild the samplers (optionally on an injected
 * clock so a test's synthetic timeline is the one the window floor sees), and optionally
 * inject the memory + kernel readers.
 */
export function _resetHostPressureSamplerForTests(
  reader?: () => ReturnType<typeof readSystemMemoryPressure>,
  kernel?: () => number | null,
  now?: () => number,
  readCpus?: () => ReturnType<typeof os.cpus>,
): void {
  cached = null;
  memReader = reader ?? (() => readSystemMemoryPressure());
  kernelReader = kernel ?? (() => readKernelMemoryPressureLevel());
  // A test that injects a clock MUST be able to inject the tick source too: a synthetic
  // 30 s jump against the real `os.cpus()` (whose ticks barely moved) yields an
  // unmeasurable delta, so the window-floor assertion would pass or fail by luck (D6).
  samplers = freshSamplers(now ?? (() => Date.now()), readCpus);
}

function takeSample(nowMs: number): HostPressureInputs {
  // ONE memory read per sample. freePct, compressorPct and the decompression rate are all
  // derived from the same vm_stat snapshot — not three independent spawns that can disagree
  // and block the loop three times over (cross-model review).
  let freePct = 100;
  let compressorPct: number | null = null;
  let decompressionsPerSec: number | null = null;
  try {
    const mem = memReader();
    freePct = Math.max(0, Math.min(100, 100 - mem.pressurePercent));
    compressorPct = mem.compressorPercent == null || !Number.isFinite(mem.compressorPercent) ? null : Math.max(0, Math.min(100, mem.compressorPercent));
    decompressionsPerSec = samplers.decompressionRate.sampleFrom(mem, nowMs);
  } catch {
    // @silent-fallback-ok: readSystemMemoryPressure already falls back + logs; an outright throw here is "unknown"
  }
  // 1-min load ÷ cores: still sampled for observability; decides cpuTier only under cpuSignal 'load'.
  const cores = os.cpus()?.length ?? 0;
  const loadPerCore = cores > 0 ? os.loadavg()[0] / cores : null;
  // Real CPU busy % since the previous sample; null until a full window has elapsed
  // (memory-only tier), never a spike reading taken over a few milliseconds.
  const cpuBusyPct = samplers.cpuBusy.sample(nowMs);
  // The kernel's own compressor-aware verdict (macOS); one fast sysctl per 30 s sample.
  const kernelMemoryPressureLevel = kernelReader();
  const windowMs = cached ? nowMs - cached.atMs : null;
  return { freePct, loadPerCore, cpuBusyPct, compressorPct, decompressionsPerSec, kernelMemoryPressureLevel, sampledAt: nowMs, windowMs };
}

/**
 * Sample the raw inputs from the OS. Pure read; never throws. Cached for MIN_SAMPLE_WINDOW_MS:
 * a caller inside the window gets the last reading (same `sampledAt`), so an observability
 * poll can never narrow a decision consumer's rate window.
 */
export function sampleHostPressureInputs(nowMs: number = Date.now()): HostPressureInputs {
  if (cached && nowMs - cached.atMs < MIN_SAMPLE_WINDOW_MS) return cached.inputs;
  const inputs = takeSample(nowMs);
  cached = { inputs: Object.freeze(inputs), atMs: nowMs };
  return inputs;
}

/**
 * Sample the current host pressure tier. Identical to the reaper's prior inline
 * computation; the reaper's `pressure()` dep now delegates here.
 */
export function sampleHostPressure(
  thresholds: HostPressureThresholds = DEFAULT_HOST_PRESSURE_THRESHOLDS,
): PressureReading {
  const inputs = sampleHostPressureInputs();
  const reading = computePressure(inputs, mergeDefaults(DEFAULT_HOST_PRESSURE_THRESHOLDS, thresholds));
  return { ...reading, inputs: { ...reading.inputs, sampledAt: inputs.sampledAt, windowMs: inputs.windowMs } };
}
