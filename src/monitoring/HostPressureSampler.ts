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
 *  - freePct  = freemem / totalmem * 100  (100 when totalmem is 0).
 *  - loadPerCore = loadavg[0] / cores     (null when cores is 0/unknown).
 *  - tier = WORST of memory and CPU, via the existing `computePressure`.
 * The CPU thresholds default to the reaper's historical 1.0 / 1.5 per-core so an
 * unconfigured caller reads exactly what the reaper read before this extraction.
 */
import os from 'node:os';
import { computePressure, type PressureReading } from './SessionReaper.js';

/** Per-core load thresholds. Defaults mirror the reaper's historical constants. */
export interface HostPressureThresholds {
  cpuModerateLoadPerCore: number;
  cpuCriticalLoadPerCore: number;
}

/** The reaper's historical defaults — an unconfigured caller is byte-identical to the old inline code. */
export const DEFAULT_HOST_PRESSURE_THRESHOLDS: HostPressureThresholds = {
  cpuModerateLoadPerCore: 1.0,
  cpuCriticalLoadPerCore: 1.5,
};

/** Raw inputs (free memory %, 1-min load per core) — exposed for observability/tests. */
export interface HostPressureInputs {
  freePct: number;
  loadPerCore: number | null;
}

/** Sample the raw inputs from the OS. Pure read; never throws. */
export function sampleHostPressureInputs(): HostPressureInputs {
  const total = os.totalmem();
  const freePct = total > 0 ? (os.freemem() / total) * 100 : 100;
  // CPU pressure: 1-min load average ÷ core count. cores unknown ⇒ memory-only.
  const cores = os.cpus()?.length ?? 0;
  const loadPerCore = cores > 0 ? os.loadavg()[0] / cores : null;
  return { freePct, loadPerCore };
}

/**
 * Sample the current host pressure tier. Identical to the reaper's prior inline
 * computation; the reaper's `pressure()` dep now delegates here.
 */
export function sampleHostPressure(
  thresholds: HostPressureThresholds = DEFAULT_HOST_PRESSURE_THRESHOLDS,
): PressureReading {
  return computePressure(sampleHostPressureInputs(), {
    cpuModerateLoadPerCore: thresholds.cpuModerateLoadPerCore,
    cpuCriticalLoadPerCore: thresholds.cpuCriticalLoadPerCore,
  });
}
