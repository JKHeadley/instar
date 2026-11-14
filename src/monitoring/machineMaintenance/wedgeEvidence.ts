/**
 * Wedge evidence families (docs/specs/machine-self-maintenance.md, Part E), read
 * from probe results. Pure: the probes run elsewhere.
 *
 * A family that cannot be read on a platform is `unknown`, never `negative`: a
 * negative resets the window, and an unread source must not clear real evidence.
 * A probe that timed out is a completed result of its family.
 *
 * | Family | macOS | Linux | Windows + WSL |
 * | F1 GUI path | shipped canary app via `open -g -j` (capture half not wired) | `systemd-run --user` no-op | `cmd.exe /c exit` through interop |
 * | F2 process table | `ps` timed, fork failure, uninterruptible count rising, data.kalloc.1024 over 4 GiB | `ps` timed, fork failure, rising | same plus `tasklist.exe` timed |
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

/** The spec's F2 line on macOS: data.kalloc.1024 over 4 GiB. */
export const KALLOC_1024_LIMIT_BYTES = 4 * 1024 ** 3;

/**
 * The data.kalloc.1024 zone from `zprint -L data.kalloc.1024`, in bytes in use.
 * Columns: name, elem size, cur size, max size, cur #elts, max #elts, cur inuse,
 * alloc size, alloc count. Without root the byte columns read `0K`, but the in-use
 * element count and the element size are real, so in-use bytes = inuse x elem size
 * (measured on macOS 26.5: within 0.3% of root's cur size, and never above it).
 * Null when the row is missing or does not parse: unread, never zero.
 */
export function parseKallocZone(zprintOutput: string): { inUseBytes: number; elemSize: number; inUse: number } | null {
  for (const line of zprintOutput.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'data.kalloc.1024' || fields.length < 7) continue;
    const elemSize = Number(fields[1]);
    const inUse = Number(fields[6]);
    if (!Number.isSafeInteger(elemSize) || !Number.isSafeInteger(inUse) || elemSize <= 0 || inUse < 0) return null;
    return { inUseBytes: elemSize * inUse, elemSize, inUse };
  }
  return null;
}

/** The kalloc reading for F2: over the limit, under it, or unread with a fixed reason. */
export function readKallocZone(probe: ProbeResult | null | undefined): { overLimit: boolean | null; inUseBytes: number | null; reason: string } {
  if (!probe) return { overLimit: null, inUseBytes: null, reason: 'not-read-on-platform' };
  // A slow or failed zprint is not itself F2 evidence (the spec names only ps); it is unread.
  if (probe.timedOut) return { overLimit: null, inUseBytes: null, reason: 'zprint-timed-out' };
  if (!probe.ok) return { overLimit: null, inUseBytes: null, reason: probe.code === 'ENOENT' ? 'zprint-missing' : 'zprint-failed' };
  const zone = parseKallocZone(probe.stdout ?? '');
  if (!zone) return { overLimit: null, inUseBytes: null, reason: 'zone-row-unparseable' };
  return { overLimit: zone.inUseBytes > KALLOC_1024_LIMIT_BYTES, inUseBytes: zone.inUseBytes, reason: 'read-unprivileged' };
}

/**
 * Whether this user has the console, from `stat -f %Su /dev/console`. `root` is the
 * login window (no one logged in); another name is another person's session. Null
 * when unread. Only a definite `false` makes F1 ineligible: an unread console is not
 * evidence of no session, and on a wedged machine reads fail first.
 */
export function consoleSessionFromOwner(probe: ProbeResult | null | undefined, ownUser: string | null | undefined): boolean | null {
  if (!probe || !probe.ok || !ownUser) return null;
  const owner = (probe.stdout ?? '').trim();
  if (!owner) return null;
  return owner === ownUser;
}

/** The LaunchServices error number `open` printed (e.g. -600, -1712), never its text. */
export function launchServicesError(stderr: string | null | undefined): number | null {
  const m = /error (-?\d+)/.exec(stderr ?? '');
  return m ? Number(m[1]) : null;
}

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
  /** macOS only: `zprint -L data.kalloc.1024`. */
  kernelZone?: ProbeResult | null;
}): { reading: FamilyReading; count: number | null } {
  const { ps, platform } = input;
  if (ps.timedOut) return { reading: { result: 'positive', reason: 'ps-timed-out', detail: { psMs: ps.ms } }, count: null };
  if (!ps.ok && typeof ps.code === 'string' && FORK_FAILURE_CODES.has(ps.code)) {
    return { reading: { result: 'positive', reason: 'fork-failure', detail: { code: ps.code } }, count: null };
  }
  const kalloc = platform === 'darwin' ? readKallocZone(input.kernelZone) : null;
  const kallocDetail: Record<string, number | boolean | string | null> = kalloc
    ? { kernelZoneRead: kalloc.inUseBytes !== null, kallocInUseBytes: kalloc.inUseBytes, kernelZoneReason: kalloc.reason }
    : { kernelZoneRead: false };
  // The kernel zone is its own reading of the same family: over the line is positive even
  // when the process table is unreadable this time.
  if (kalloc?.overLimit === true) {
    const zoneCount = ps.ok ? uninterruptibleCount(ps.stdout ?? '', platform) : null;
    return { reading: { result: 'positive', reason: 'kernel-zone-over-limit', detail: { ...kallocDetail, kallocLimitBytes: KALLOC_1024_LIMIT_BYTES, psMs: ps.ok ? ps.ms : null } }, count: zoneCount };
  }
  if (!ps.ok) {
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
      // On macOS the kernel-zone reading rides along; unread is named (kernelZoneRead false), never counted.
      detail: { uninterruptible: count, psMs: ps.ms, ...kallocDetail, tasklistMs: input.tasklist?.ok ? input.tasklist.ms : null },
    },
    count,
  };
}

/**
 * F1. `passedSinceBoot` is whether this same probe has passed since boot; until it
 * has, a failure is `ineligible` (a machine where the probe never works is not wedged).
 *
 * macOS: the probe is `open -g -j` of the shipped canary (exit 0 negative; a nonzero
 * exit such as -600, or a timeout, is the failure). A failure is also ineligible while
 * `lockState` is `locked` or `consoleSession` is false (the login window or another
 * person's session). An unread console session does not block: on a wedged machine
 * reads fail first. A pass always counts, locked or not: the path worked. The capture
 * half (helper frame) is not wired.
 */
export function readF1(input: {
  platform: WedgePlatform;
  probe: ProbeResult | null;
  passedSinceBoot: boolean;
  lockState?: string | null;
  /** macOS: this user owns the console. Null when unread. */
  consoleSession?: boolean | null;
}): { reading: FamilyReading; passed: boolean } {
  const { platform, probe } = input;
  const mac = platform === 'darwin';
  if (mac && !probe) {
    // No canary to run here (not built into this install, or a test that did not opt in).
    const locked = input.lockState === 'locked';
    return { reading: { result: locked ? 'ineligible' : 'unknown', reason: locked ? 'screen-locked' : 'canary-not-installed' }, passed: false };
  }
  if (platform === 'other' || !probe) return { reading: { result: 'unknown', reason: 'no-probe-on-platform' }, passed: false };
  const kind = mac ? 'canary' : 'probe';
  if (probe.ok) return { reading: { result: 'negative', reason: `${kind}-passed`, detail: { probeMs: probe.ms } }, passed: true };
  if (probe.code === 'ENOENT') return { reading: { result: 'unknown', reason: `${kind}-missing` }, passed: false };
  const reason = probe.timedOut ? `${kind}-timed-out` : `${kind}-failed`;
  const lsError = mac ? launchServicesError(probe.stderr) : null;
  const detail = { probeMs: probe.ms, code: probe.code === null ? null : String(probe.code), ...(mac ? { launchServicesError: lsError } : {}) };
  if (mac && input.consoleSession === false) return { reading: { result: 'ineligible', reason: `${reason}-no-console-session`, detail }, passed: false };
  if (mac && input.lockState === 'locked') return { reading: { result: 'ineligible', reason: `${reason}-screen-locked`, detail }, passed: false };
  if (!input.passedSinceBoot) return { reading: { result: 'ineligible', reason: `${reason}-never-passed-this-boot`, detail: mac ? detail : { probeMs: probe.ms } }, passed: false };
  return { reading: { result: 'positive', reason, detail }, passed: false };
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
