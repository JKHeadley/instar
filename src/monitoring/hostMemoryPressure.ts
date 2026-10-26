/**
 * hostMemoryPressure — THE one correct, platform-aware measure of host memory
 * availability across the codebase. Spec: macos-memory-pressure-metric.
 *
 * THE BUG THIS FIXES: `os.freemem()` on macOS returns ONLY "Pages free" — which
 * macOS keeps near-zero (it uses the rest for cache/compressor/purgeable), so
 * `os.freemem()/totalmem()` reads ~0.1-0.4% on a healthy machine and falsely
 * registers as "critical" memory pressure. That false-critical made the
 * SessionReaper over-reap AND permanently blocked the ResumeQueueDrainer's
 * "machine calm" gate (it can never reach a 'normal' tier), so reaped sessions
 * never revived — silently. The CORRECT macOS available memory is
 * free + inactive (reclaimable) + purgeable, exactly what `vm_stat` exposes and
 * what MemoryPressureMonitor already computed for HealthChecker — this lifts that
 * calculation into one shared, injectable, unit-tested helper.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';

const PAGE_SIZE_BYTES = 16384; // macOS Apple Silicon default; overridden by vm_stat's own page size

export interface SystemMemoryReading {
  /** Used memory as a percentage (0-100). The inverse of available. */
  pressurePercent: number;
  freeGB: number;
  totalGB: number;
  /**
   * macOS only: pages held by the memory compressor as a percentage of total pages
   * (0-100), `null` where the platform exposes no such figure. The distress signal the
   * available-memory figure cannot see: on 2026-10-25 a laptop reported 42.8% available
   * while holding 35 GB (27%) compressed and spending ~26% of all CPU in `sys` to do it
   * (spec reaper-pressure-signals §2b).
   */
  compressorPercent: number | null;
  /**
   * macOS only: the cumulative `Decompressions` counter from vm_stat, `null` elsewhere.
   * Occupancy says how much is parked in the compressor; decompressions per second say
   * whether the machine is actually paying to get it back out (thrash). The gate review
   * noted that retained compressed pages alone are not strain.
   */
  decompressions: number | null;
  /** vm_stat page size in bytes (macOS); null elsewhere. Lets a rate be expressed in bytes. */
  pageSizeBytes: number | null;
}

/** Injectable IO so the parsers + reader unit-test without a real OS. */
export interface MemReadDeps {
  platform?: string;
  vmStat?: () => string;
  procMeminfo?: () => string;
  memoryUsage?: () => { rss: number };
  totalmem?: () => number;
}

/** Pure: parse `vm_stat` output → memory reading. Available = free + inactive + purgeable. */
export function parseVmStat(output: string): SystemMemoryReading {
  const pageSizeMatch = output.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : PAGE_SIZE_BYTES;
  const parsePages = (label: string): number => {
    const match = output.match(new RegExp(`${label}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  };
  // A label ABSENT from the output is unknown, not zero — invariant 5 (review finding).
  const parsePagesOrNull = (label: string): number | null => {
    const match = output.match(new RegExp(`${label}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : null;
  };
  const freePages = parsePages('Pages free');
  const activePages = parsePages('Pages active');
  const inactivePages = parsePages('Pages inactive');
  const wiredPages = parsePages('Pages wired down');
  const compressorPages = parsePages('Pages occupied by compressor');
  const purgeablePages = parsePages('Pages purgeable');

  const totalPages = freePages + activePages + inactivePages + wiredPages + compressorPages;
  if (totalPages === 0) {
    throw new Error('vm_stat output contained no total memory pages');
  }
  const totalGB = (totalPages * pageSize) / (1024 ** 3);
  const availablePages = freePages + inactivePages + purgeablePages;
  const freeGB = (availablePages * pageSize) / (1024 ** 3);
  const usedPages = totalPages - availablePages;
  const pressurePercent = (usedPages / totalPages) * 100;
  const compressorPagesOrNull = parsePagesOrNull('Pages occupied by compressor');
  const compressorPercent = compressorPagesOrNull == null ? null : (compressorPagesOrNull / totalPages) * 100;
  const decompressions = parsePagesOrNull('Decompressions');
  return { pressurePercent, freeGB, totalGB, compressorPercent, decompressions, pageSizeBytes: pageSize };
}

/** Pure: parse `/proc/meminfo` content → memory reading (Linux MemAvailable). */
export function parseProcMeminfo(content: string): SystemMemoryReading {
  const parseKB = (key: string): number => {
    const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  };
  const totalKB = parseKB('MemTotal');
  if (totalKB === 0) {
    throw new Error('/proc/meminfo contained no total memory');
  }
  const availableKB = parseKB('MemAvailable') || (parseKB('MemFree') + parseKB('Buffers') + parseKB('Cached'));
  const totalGB = totalKB / (1024 * 1024);
  const freeGB = availableKB / (1024 * 1024);
  const pressurePercent = ((totalKB - availableKB) / totalKB) * 100;
  return { pressurePercent, freeGB, totalGB, compressorPercent: null, decompressions: null, pageSizeBytes: null };
}

/** Read host memory pressure, platform-aware. Bounded + never throws (fallback on any error). */
export function readSystemMemoryPressure(deps: MemReadDeps = {}): SystemMemoryReading {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'darwin') {
      // The real vm_stat read funnels through withSyncOp so the in-flight sync-op
      // marker sees this blocking call (tmux-event-loop-resilience-spec). The
      // injected `vmStat` (tests) is a pure stub and needs no funnel.
      const out = deps.vmStat ? deps.vmStat() : withSyncOp(() => spawnSync('vm_stat', [], { encoding: 'utf-8', timeout: 5000 }).stdout ?? '');
      if (out) return parseVmStat(out);
    } else if (platform === 'linux') {
      const content = deps.procMeminfo ? deps.procMeminfo() : fs.readFileSync('/proc/meminfo', 'utf-8');
      if (content) return parseProcMeminfo(content);
    }
  } catch (err) {
    // @silent-fallback-ok — a vm_stat/proc read failure falls back to the rough
    // process.memoryUsage estimate below; an observability metric, never a gate
    // that should wedge on a transient read error. NOT silent: the fallback is
    // logged (No Silent Degradation — advisory degradation must be visible) so a
    // genuinely-broken vm_stat surfaces instead of hiding behind a server-RSS
    // estimate. The fallback biases toward LOW pressure (server RSS ≪ host RAM),
    // the safe direction for a reaper (less aggressive) + revival (more available).
    console.warn(`[hostMemoryPressure] ${platform} memory read failed; using rough RSS estimate: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fallback (other platforms or a read error): rough RSS-based estimate.
  const totalGB = (deps.totalmem ? deps.totalmem() : os.totalmem()) / (1024 ** 3);
  const usedGB = (deps.memoryUsage ? deps.memoryUsage() : process.memoryUsage()).rss / (1024 ** 3);
  return { pressurePercent: totalGB > 0 ? (usedGB / totalGB) * 100 : 0, freeGB: totalGB - usedGB, totalGB, compressorPercent: null, decompressions: null, pageSizeBytes: null };
}

/**
 * Compressor occupancy as a percentage of total memory, or `null` where unmeasurable
 * (non-macOS, a failed read). Explicitly unknown, never a fabricated 0.
 */
export function hostCompressorPct(deps: MemReadDeps = {}): number | null {
  const r = readSystemMemoryPressure(deps);
  return r.compressorPercent == null || !Number.isFinite(r.compressorPercent) ? null : Math.max(0, Math.min(100, r.compressorPercent));
}

/**
 * Decompressions per second since the previous call — the ACTIVITY half of compressor
 * strain (occupancy is the other half; both are needed before "thrash" is claimed).
 * `null` on the first call, off-macOS, or on a counter reset. A stateful sampler like the
 * CPU one: the window is the caller's SAMPLE window (in production the shared 30 s one).
 */
export function makeDecompressionRateSampler(
  read: () => SystemMemoryReading = () => readSystemMemoryPressure(),
  now: () => number = () => Date.now(),
): { sample: (nowMs?: number) => number | null; sampleFrom: (reading: SystemMemoryReading, nowMs?: number) => number | null } {
  let prev: { count: number; atMs: number } | null = null;
  // The clock is the CALLER's sample clock when given (the cached-window arithmetic in
  // HostPressureSampler), so two calls in the same wall-clock millisecond cannot read as a
  // zero-length interval (review finding 2).
  const sampleFrom = (reading: SystemMemoryReading, nowMs?: number): number | null => {
    const count = reading.decompressions;
    const atMs = nowMs ?? now();
    if (count == null || !Number.isFinite(count)) { prev = null; return null; }
    const last = prev;
    prev = { count, atMs };
    if (!last) return null;
    const dCount = count - last.count;
    const dSec = (atMs - last.atMs) / 1000;
    if (dCount < 0 || !(dSec > 0)) return null;
    return dCount / dSec;
  };
  return {
    sample(nowMs?: number): number | null {
      let reading: SystemMemoryReading;
      // @silent-fallback-ok — an unreadable vm_stat is UNKNOWN, not zero: `null` propagates as
      // `decompressionsPerSec: null`, which grades nothing (the compressor readings are
      // observability only) and is reported as null on `pressure.inputs`. `readSystemMemoryPressure`
      // already logs and degrades on its own read failures, so reporting again here would double-count.
      try { reading = read(); } catch { return null; }
      return sampleFrom(reading, nowMs);
    },
    /** Derive the rate from a reading the caller already took — ONE vm_stat per sample, not three. */
    sampleFrom,
  };
}

/**
 * The kernel's OWN compressor-aware memory-pressure verdict on macOS:
 * `sysctl kern.memorystatus_vm_pressure_level` → 1 normal, 2 warn, 4 critical. `null` off
 * macOS or when unreadable. This is the GRADE for the compressor tier (spec
 * reaper-pressure-signals §3b): a healthy Studio measured 35% occupancy and 10k-94k
 * decompressions/s with this level at 1, which is why hand-made thresholds on those raw
 * numbers were withdrawn — they do not discriminate. The raw numbers are reported beside it
 * as the auditable observables.
 */
export function readKernelMemoryPressureLevel(deps: { platform?: string; sysctl?: () => string } = {}): number | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return null;
  try {
    const out = deps.sysctl ? deps.sysctl() : withSyncOp(() => spawnSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf-8', timeout: 2000 }).stdout ?? '');
    const n = parseInt(String(out).trim(), 10);
    return n === 1 || n === 2 || n === 4 ? n : null;
  } catch {
    return null; // @silent-fallback-ok: unknown, never a fabricated "normal"
  }
}

/**
 * Free/available host memory as a percentage (0-100) — the CORRECTED replacement
 * for `os.freemem()/os.totalmem()*100`. Use this for any memory-pressure tier
 * decision so macOS is read truthfully (free+inactive+purgeable), not as raw
 * free pages.
 */
export function hostFreeMemPct(deps: MemReadDeps = {}): number {
  const pct = 100 - readSystemMemoryPressure(deps).pressurePercent;
  return Math.max(0, Math.min(100, pct));
}
