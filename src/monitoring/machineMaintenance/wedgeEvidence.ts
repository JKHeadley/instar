/**
 * Wedge evidence families (docs/specs/machine-self-maintenance.md, Part E), read
 * from probe results. Pure: the probes run elsewhere.
 *
 * A family that cannot be read on a platform is `unknown`, never `negative`: a
 * negative resets the window, and an unread source must not clear real evidence.
 * A probe that timed out is a completed result of its family.
 *
 * | Family | macOS | Linux | Windows + WSL |
 * | F1 GUI path | canary app (not shipped) + capture (not wired): unknown | `systemd-run --user` no-op | `cmd.exe /c exit` through interop |
 * | F2 process table | `ps` timed, fork failure, uninterruptible count rising | same | same plus `tasklist.exe` timed |
 * | F3 stuck dialog | not covered in this build | not applicable | not covered |
 * | F4 agent symptoms | impaired verdict or event-loop lag while CPU idle >= 30%; spawn failures | same | same |
 */

import type { ProbeResult } from './readings.js';
import type { FamilyResult } from './wedgeWindow.js';

export type WedgePlatform = 'darwin' | 'linux' | 'wsl' | 'other';

export interface FamilyReading {
  result: FamilyResult;
  /** A short fixed reason. Never window titles, dialog text or command output. */
  reason: string;
  /** Measured parts, numbers and booleans only. */
  detail?: Record<string, number | boolean | string | null>;
}

/** The uninterruptible-sleep state letter: `U` on macOS, `D` on Linux. */
export function uninterruptibleCount(psStat: string, platform: WedgePlatform): number {
  const letter = platform === 'darwin' ? 'U' : 'D';
  let n = 0;
  for (const line of psStat.split('\n')) if (line.trim().startsWith(letter)) n += 1;
  return n;
}

/** Strictly rising over the last three readings. */
export function risingOverThree(counts: number[]): boolean {
  if (counts.length < 3) return false;
  const [a, b, c] = counts.slice(-3);
  return a < b && b < c;
}

const FORK_FAILURE_CODES = new Set(['EAGAIN', 'ENOMEM']);

/**
 * F2. `priorCounts` are earlier uninterruptible counts this boot, oldest first; the
 * caller appends the returned count after this reading.
 */
export function readF2(input: {
  platform: WedgePlatform;
  ps: ProbeResult;
  priorCounts: number[];
  /** WSL only: the Windows process table, timed. */
  tasklist?: ProbeResult | null;
}): { reading: FamilyReading; count: number | null } {
  const { ps, platform } = input;
  if (ps.timedOut) return { reading: { result: 'positive', reason: 'ps-timed-out', detail: { psMs: ps.ms } }, count: null };
  if (!ps.ok) {
    if (typeof ps.code === 'string' && FORK_FAILURE_CODES.has(ps.code)) {
      return { reading: { result: 'positive', reason: 'fork-failure', detail: { code: ps.code } }, count: null };
    }
    return { reading: { result: 'unknown', reason: 'ps-unreadable', detail: { code: ps.code === null ? null : String(ps.code) } }, count: null };
  }
  const count = uninterruptibleCount(ps.stdout ?? '', platform);
  const counts = [...input.priorCounts, count];
  if (risingOverThree(counts)) {
    return { reading: { result: 'positive', reason: 'uninterruptible-rising', detail: { uninterruptible: count, psMs: ps.ms } }, count };
  }
  if (platform === 'wsl' && input.tasklist?.timedOut) {
    return { reading: { result: 'positive', reason: 'tasklist-timed-out', detail: { tasklistMs: input.tasklist.ms } }, count };
  }
  return {
    reading: {
      result: 'negative',
      reason: 'process-table-answers',
      // The kernel-zone reading (data.kalloc.1024) is not wired in this build; its absence is named, not counted.
      detail: { uninterruptible: count, psMs: ps.ms, kernelZoneRead: false, tasklistMs: input.tasklist?.ok ? input.tasklist.ms : null },
    },
    count,
  };
}

/**
 * F1. `passedSinceBoot` is whether this same probe has passed since boot; until it
 * has, a failure is `ineligible` (a machine where the probe never works is not wedged).
 * `lockState` is the honest lock reading; locked or no console session makes F1
 * ineligible on macOS.
 */
export function readF1(input: {
  platform: WedgePlatform;
  probe: ProbeResult | null;
  passedSinceBoot: boolean;
  lockState?: string | null;
}): { reading: FamilyReading; passed: boolean } {
  const { platform, probe } = input;
  if (platform === 'darwin') {
    // The spec's canary is a shipped, signed no-UI app, and the capture half needs the
    // desktop helper. Neither is wired in this build, so F1 is unread on macOS.
    const ineligible = input.lockState === 'locked';
    return { reading: { result: ineligible ? 'ineligible' : 'unknown', reason: ineligible ? 'screen-locked' : 'canary-not-shipped' }, passed: false };
  }
  if (platform === 'other' || !probe) return { reading: { result: 'unknown', reason: 'no-probe-on-platform' }, passed: false };
  if (probe.ok) return { reading: { result: 'negative', reason: 'probe-passed', detail: { probeMs: probe.ms } }, passed: true };
  if (probe.code === 'ENOENT') return { reading: { result: 'unknown', reason: 'probe-missing' }, passed: false };
  const reason = probe.timedOut ? 'probe-timed-out' : 'probe-failed';
  if (!input.passedSinceBoot) return { reading: { result: 'ineligible', reason: `${reason}-never-passed-this-boot`, detail: { probeMs: probe.ms } }, passed: false };
  return { reading: { result: 'positive', reason, detail: { probeMs: probe.ms, code: probe.code === null ? null : String(probe.code) } }, passed: false };
}

export interface LoadReading {
  verdict: string;
  cpuIdlePct: number | null;
  eventLoopLagP99Ms: number | null;
  sampleAgeMs: number;
}

export const F4_MIN_IDLE_PCT = 30;
export const F4_LAG_MS = 1000;
export const F4_SPAWN_FAILURES = 2;
export const F4_REPORT_MAX_AGE_MS = 60_000;

/** F4. A stale or missing load report is unknown, unless spawn failures alone are positive. */
export function readF4(input: { load: LoadReading | null; spawnSystemFailures30m: number | null }): FamilyReading {
  const spawn = input.spawnSystemFailures30m;
  if (spawn !== null && spawn >= F4_SPAWN_FAILURES) return { result: 'positive', reason: 'spawn-failures', detail: { spawnFailures30m: spawn } };
  const load = input.load;
  if (!load || load.sampleAgeMs > F4_REPORT_MAX_AGE_MS) return { result: 'unknown', reason: load ? 'load-report-stale' : 'no-load-report' };
  if (load.cpuIdlePct === null) return { result: 'unknown', reason: 'cpu-idle-unread' };
  const idle = load.cpuIdlePct >= F4_MIN_IDLE_PCT;
  const detail = { verdict: load.verdict, cpuIdlePct: load.cpuIdlePct, lagP99Ms: load.eventLoopLagP99Ms, spawnFailures30m: spawn };
  if (idle && load.verdict === 'impaired') return { result: 'positive', reason: 'impaired-while-idle', detail };
  if (idle && load.eventLoopLagP99Ms !== null && load.eventLoopLagP99Ms >= F4_LAG_MS) return { result: 'positive', reason: 'lag-while-idle', detail };
  return { result: 'negative', reason: idle ? 'agent-healthy' : 'cpu-busy-not-wedged', detail };
}
