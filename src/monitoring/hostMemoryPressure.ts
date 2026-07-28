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
  const freePages = parsePages('Pages free');
  const activePages = parsePages('Pages active');
  const inactivePages = parsePages('Pages inactive');
  const wiredPages = parsePages('Pages wired down');
  const compressorPages = parsePages('Pages occupied by compressor');
  const purgeablePages = parsePages('Pages purgeable');

  const totalPages = freePages + activePages + inactivePages + wiredPages + compressorPages;
  const totalGB = (totalPages * pageSize) / (1024 ** 3);
  const availablePages = freePages + inactivePages + purgeablePages;
  const freeGB = (availablePages * pageSize) / (1024 ** 3);
  const usedPages = totalPages - availablePages;
  const pressurePercent = totalPages > 0 ? (usedPages / totalPages) * 100 : 0;
  return { pressurePercent, freeGB, totalGB };
}

/** Pure: parse `/proc/meminfo` content → memory reading (Linux MemAvailable). */
export function parseProcMeminfo(content: string): SystemMemoryReading {
  const parseKB = (key: string): number => {
    const match = content.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) : 0;
  };
  const totalKB = parseKB('MemTotal');
  const availableKB = parseKB('MemAvailable') || (parseKB('MemFree') + parseKB('Buffers') + parseKB('Cached'));
  const totalGB = totalKB / (1024 * 1024);
  const freeGB = availableKB / (1024 * 1024);
  const pressurePercent = totalKB > 0 ? ((totalKB - availableKB) / totalKB) * 100 : 0;
  return { pressurePercent, freeGB, totalGB };
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
  return { pressurePercent: totalGB > 0 ? (usedGB / totalGB) * 100 : 0, freeGB: totalGB - usedGB, totalGB };
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
