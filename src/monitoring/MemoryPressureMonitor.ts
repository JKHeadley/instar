/**
 * MemoryPressureMonitor - Detect and respond to system memory pressure.
 *
 * Platform-aware: uses macOS `vm_stat` or Linux `/proc/meminfo`.
 * EventEmitter pattern consistent with Instar conventions.
 *
 * Thresholds:
 *   - normal   (< 60%): all operations allowed
 *   - warning  (60-75%): log trend, notify
 *   - elevated (75-90%): restrict session spawning
 *   - critical (90%+): block all spawns, alert
 *
 * Includes trend tracking via ring buffer + linear regression.
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

export type MemoryPressureState = 'normal' | 'warning' | 'elevated' | 'critical';

export type MemoryTrend = 'rising' | 'stable' | 'falling';

export interface MemoryState {
  pressurePercent: number;
  freeGB: number;
  totalGB: number;
  state: MemoryPressureState;
  trend: MemoryTrend;
  ratePerMin: number;
  lastChecked: string;
  stateChangedAt: string;
  platform: string;
}

export interface MemoryPressureMonitorConfig {
  /** Thresholds (percent). Defaults: warning=60, elevated=75, critical=90 */
  thresholds?: {
    warning?: number;
    elevated?: number;
    critical?: number;
  };
  /** Base check interval in ms. Default: 30000 */
  checkIntervalMs?: number;
}

interface PressureReading {
  timestamp: number;
  pressurePercent: number;
}

const DEFAULT_THRESHOLDS = {
  warning: 60,
  elevated: 75,
  critical: 90,
};

const RING_BUFFER_SIZE = 20;
const TREND_WINDOW = 6;
const PAGE_SIZE_BYTES = 16384; // macOS Apple Silicon

// Adaptive intervals
const INTERVALS: Record<MemoryPressureState, number> = {
  normal: 30_000,
  warning: 15_000,
  elevated: 10_000,
  critical: 5_000,
};

export class MemoryPressureMonitor extends EventEmitter {
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private currentState: MemoryPressureState = 'normal';
  private stateChangedAt: string = new Date().toISOString();
  private lastChecked: string = new Date().toISOString();
  private lastPressurePercent = 0;
  private lastFreeGB = 0;
  private lastTotalGB = 0;
  private ringBuffer: PressureReading[] = [];
  private currentTrend: MemoryTrend = 'stable';
  private currentRatePerMin = 0;
  private thresholds: typeof DEFAULT_THRESHOLDS;
  private baseIntervalMs: number;

  constructor(config: MemoryPressureMonitorConfig = {}) {
    super();
    this.thresholds = {
      ...DEFAULT_THRESHOLDS,
      ...config.thresholds,
    };
    this.baseIntervalMs = config.checkIntervalMs ?? 30_000;
  }

  start(): void {
    if (this.timeout) return;

    this.check();
    this.scheduleNext();
    console.log(`[MemoryPressureMonitor] Started (platform: ${process.platform}, thresholds: ${JSON.stringify(this.thresholds)})`);
  }

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  getState(): MemoryState {
    return {
      pressurePercent: this.lastPressurePercent,
      freeGB: this.lastFreeGB,
      totalGB: this.lastTotalGB,
      state: this.currentState,
      trend: this.currentTrend,
      ratePerMin: this.currentRatePerMin,
      lastChecked: this.lastChecked,
      stateChangedAt: this.stateChangedAt,
      platform: process.platform,
    };
  }

  /**
   * Can a new session be spawned?
   */
  canSpawnSession(): { allowed: boolean; reason?: string } {
    switch (this.currentState) {
      case 'normal':
      case 'warning':
        return { allowed: true };

      case 'elevated':
        return {
          allowed: false,
          reason: `Memory pressure elevated (${this.lastPressurePercent.toFixed(1)}%) — session spawn blocked`,
        };

      case 'critical':
        return {
          allowed: false,
          reason: `Memory pressure critical (${this.lastPressurePercent.toFixed(1)}%) — all spawns blocked`,
        };
    }
  }

  private scheduleNext(): void {
    const intervalMs = INTERVALS[this.currentState] || this.baseIntervalMs;
    this.timeout = setTimeout(() => {
      this.check();
      this.scheduleNext();
    }, intervalMs);
    this.timeout.unref(); // Don't prevent process exit
  }

  private check(): void {
    try {
      const { pressurePercent, freeGB, totalGB } = this.readSystemMemory();

      this.lastPressurePercent = pressurePercent;
      this.lastFreeGB = freeGB;
      this.lastTotalGB = totalGB;
      this.lastChecked = new Date().toISOString();

      // Ring buffer
      this.ringBuffer.push({ timestamp: Date.now(), pressurePercent });
      if (this.ringBuffer.length > RING_BUFFER_SIZE) {
        this.ringBuffer.shift();
      }

      // Trend
      const { trend, ratePerMin } = this.detectTrend();
      this.currentTrend = trend;
      this.currentRatePerMin = ratePerMin;

      const newState = this.classifyState(pressurePercent);
      if (newState !== this.currentState) {
        const from = this.currentState;
        this.currentState = newState;
        this.stateChangedAt = new Date().toISOString();

        console.log(`[MemoryPressureMonitor] ${from} -> ${newState} (${pressurePercent.toFixed(1)}%, ${freeGB.toFixed(1)}GB free, trend: ${trend})`);
        this.emit('stateChange', { from, to: newState, state: this.getState() });
      }
    } catch (error) {
      console.error('[MemoryPressureMonitor] Check failed:', error);
    }
  }

  private classifyState(pressurePercent: number): MemoryPressureState {
    if (pressurePercent >= this.thresholds.critical) return 'critical';
    if (pressurePercent >= this.thresholds.elevated) return 'elevated';
    if (pressurePercent >= this.thresholds.warning) return 'warning';
    return 'normal';
  }

  /**
   * Read system memory — platform-aware.
   */
  private readSystemMemory(): { pressurePercent: number; freeGB: number; totalGB: number } {
    if (process.platform === 'darwin') {
      return this.parseVmStat();
    } else if (process.platform === 'linux') {
      return this.parseProcMeminfo();
    } else {
      // Fallback: use Node's process.memoryUsage (very rough)
      const mem = process.memoryUsage();
      const totalGB = require('os').totalmem() / (1024 ** 3);
      const usedGB = mem.rss / (1024 ** 3);
      return {
        pressurePercent: (usedGB / totalGB) * 100,
        freeGB: totalGB - usedGB,
        totalGB,
      };
    }
  }

  /**
   * macOS: parse vm_stat
   */
  private parseVmStat(): { pressurePercent: number; freeGB: number; totalGB: number } {
    const output = execSync('vm_stat', { encoding: 'utf-8', timeout: 5000 });

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
    const totalBytes = totalPages * pageSize;
    const totalGB = totalBytes / (1024 ** 3);

    const availablePages = freePages + inactivePages + purgeablePages;
    const availableBytes = availablePages * pageSize;
    const freeGB = availableBytes / (1024 ** 3);

    const usedPages = totalPages - availablePages;
    const pressurePercent = totalPages > 0 ? (usedPages / totalPages) * 100 : 0;

    return { pressurePercent, freeGB, totalGB };
  }

  /**
   * Linux: parse /proc/meminfo
   */
  private parseProcMeminfo(): { pressurePercent: number; freeGB: number; totalGB: number } {
    const content = fs.readFileSync('/proc/meminfo', 'utf-8');

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

  /**
   * Linear regression over recent readings.
   */
  private detectTrend(): { trend: MemoryTrend; ratePerMin: number } {
    if (this.ringBuffer.length < 3) {
      return { trend: 'stable', ratePerMin: 0 };
    }

    const readings = this.ringBuffer.slice(-TREND_WINDOW);
    const n = readings.length;

    const firstTs = readings[0].timestamp;
    const xs = readings.map(r => (r.timestamp - firstTs) / 1000);
    const ys = readings.map(r => r.pressurePercent);

    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sumX2 = xs.reduce((a, x) => a + x * x, 0);

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return { trend: 'stable', ratePerMin: 0 };

    const slope = (n * sumXY - sumX * sumY) / denom;
    const ratePerMin = slope * 60;

    let trend: MemoryTrend;
    if (ratePerMin > 0.5) trend = 'rising';
    else if (ratePerMin < -0.5) trend = 'falling';
    else trend = 'stable';

    return { trend, ratePerMin };
  }
}
