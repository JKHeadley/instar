/**
 * cpuStarvation — a tiny shared helper for "is this machine so oversubscribed
 * that a live process can't get scheduled?"
 *
 * The signal is `loadavg[0] / cpuCount`. Above ~1.5 the run-queue is longer
 * than the core count, so a perfectly-alive event loop can stall for many
 * seconds simply because it isn't getting CPU time. Two watchers need to tell
 * this apart from a genuine fault, or they take a destructive action that makes
 * things worse:
 *   - SleepWakeDetector: a short heartbeat drift under CPU starvation is NOT a
 *     real sleep/wake (it suppresses the wake — see SleepWakeDetector).
 *   - ServerSupervisor: a server that can't answer /health under CPU starvation
 *     is NOT dead — restarting it doesn't cure the starvation (the fresh server
 *     is starved too), it just drops the in-flight message and loops.
 *
 * SleepWakeDetector keeps its own injectable providers for unit testing; this
 * module is the canonical default ratio + computation that other callers
 * (ServerSupervisor) share so the fleet uses one definition of "CPU-starved."
 */

import os from 'node:os';

/** Above this loadavg[0]/cpuCount ratio the machine is treated as CPU-starved. */
export const DEFAULT_MAX_LOAD_RATIO = 1.5;

/**
 * 1-minute load average divided by CPU count. Returns 0 on any error (so a
 * failure to read system load never trips a starvation branch). Providers are
 * injectable for tests.
 */
export function cpuLoadRatio(
  loadAvg1?: number,
  cpuCount?: number,
): number {
  try {
    const load = loadAvg1 ?? os.loadavg()[0];
    const cpus = cpuCount ?? os.cpus().length;
    if (!Number.isFinite(load) || !Number.isFinite(cpus) || cpus < 1) return 0;
    return load / cpus;
  } catch {
    return 0;
  }
}

/** True when the machine is CPU-starved (load ratio strictly above maxRatio). */
export function isCpuStarved(
  maxRatio: number = DEFAULT_MAX_LOAD_RATIO,
  loadAvg1?: number,
  cpuCount?: number,
): boolean {
  return cpuLoadRatio(loadAvg1, cpuCount) > maxRatio;
}
