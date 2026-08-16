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
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import { DegradationReporter } from './DegradationReporter.js';
const DEFAULT_THRESHOLDS = {
    warning: 60,
    elevated: 75,
    critical: 90,
};
const RING_BUFFER_SIZE = 20;
const TREND_WINDOW = 6;
const PAGE_SIZE_BYTES = 16384; // macOS Apple Silicon
// Adaptive intervals
const INTERVALS = {
    normal: 30_000,
    warning: 15_000,
    elevated: 10_000,
    critical: 5_000,
};
export class MemoryPressureMonitor extends EventEmitter {
    timeout = null;
    currentState = 'normal';
    stateChangedAt = new Date().toISOString();
    lastChecked = new Date().toISOString();
    lastPressurePercent = 0;
    lastFreeGB = 0;
    lastTotalGB = 0;
    ringBuffer = [];
    currentTrend = 'stable';
    currentRatePerMin = 0;
    thresholds;
    baseIntervalMs;
    stateDir = null;
    constructor(config = {}) {
        super();
        this.stateDir = config.stateDir ?? null;
        // Load persisted thresholds first, then overlay any explicit config.
        // Priority: explicit config > persisted file > defaults
        const persisted = this.loadPersistedThresholds();
        this.thresholds = {
            ...DEFAULT_THRESHOLDS,
            ...persisted,
            ...config.thresholds,
        };
        this.baseIntervalMs = config.checkIntervalMs ?? 30_000;
    }
    start() {
        if (this.timeout)
            return;
        this.check();
        this.scheduleNext();
        console.log(`[MemoryPressureMonitor] Started (platform: ${process.platform}, thresholds: ${JSON.stringify(this.thresholds)})`);
    }
    stop() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
    }
    /**
     * Update thresholds at runtime (e.g., when a user asks to adjust warning levels).
     * Re-classifies current state immediately after update.
     * Persists to disk so changes survive server restarts.
     */
    updateThresholds(thresholds) {
        const before = { ...this.thresholds };
        this.thresholds = { ...this.thresholds, ...thresholds };
        console.log(`[MemoryPressureMonitor] Thresholds updated: ${JSON.stringify(before)} -> ${JSON.stringify(this.thresholds)}`);
        // Persist to disk so changes survive server restarts
        this.persistThresholds();
        // Re-classify current state with new thresholds
        const newState = this.classifyState(this.lastPressurePercent);
        if (newState !== this.currentState) {
            const from = this.currentState;
            this.currentState = newState;
            this.stateChangedAt = new Date().toISOString();
            console.log(`[MemoryPressureMonitor] State reclassified: ${from} -> ${newState} (${this.lastPressurePercent.toFixed(1)}%)`);
            this.emit('stateChange', { from, to: newState, state: this.getState() });
        }
    }
    get thresholdsFilePath() {
        if (!this.stateDir)
            return null;
        return `${this.stateDir}/state/memory-thresholds.json`;
    }
    persistThresholds() {
        const filePath = this.thresholdsFilePath;
        if (!filePath)
            return;
        try {
            const dir = filePath.replace(/\/[^/]+$/, '');
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify({
                ...this.thresholds,
                updatedAt: new Date().toISOString(),
            }, null, 2) + '\n');
        }
        catch (err) {
            DegradationReporter.getInstance().report({
                feature: 'MemoryPressureMonitor.persistThresholds',
                primary: 'Persist updated memory thresholds to disk',
                fallback: 'Thresholds active in-memory only, will revert to defaults on restart',
                reason: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'Custom memory thresholds will not survive a server restart',
            });
            console.error(`[MemoryPressureMonitor] Failed to persist thresholds:`, err);
        }
    }
    loadPersistedThresholds() {
        const filePath = this.thresholdsFilePath;
        if (!filePath || !fs.existsSync(filePath))
            return {};
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const result = {};
            if (typeof data.warning === 'number')
                result.warning = data.warning;
            if (typeof data.elevated === 'number')
                result.elevated = data.elevated;
            if (typeof data.critical === 'number')
                result.critical = data.critical;
            if (Object.keys(result).length > 0) {
                console.log(`[MemoryPressureMonitor] Loaded persisted thresholds: ${JSON.stringify(result)}`);
            }
            return result;
        }
        catch {
            // @silent-fallback-ok — persisted thresholds may be corrupt; falling back to defaults is safe
            return {};
        }
    }
    /**
     * Get current thresholds.
     */
    getThresholds() {
        return { ...this.thresholds };
    }
    getState() {
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
    canSpawnSession() {
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
    scheduleNext() {
        const intervalMs = INTERVALS[this.currentState] || this.baseIntervalMs;
        this.timeout = setTimeout(() => {
            this.check();
            this.scheduleNext();
        }, intervalMs);
        this.timeout.unref(); // Don't prevent process exit
    }
    check() {
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
        }
        catch (error) {
            console.error('[MemoryPressureMonitor] Check failed:', error);
        }
    }
    classifyState(pressurePercent) {
        if (pressurePercent >= this.thresholds.critical)
            return 'critical';
        if (pressurePercent >= this.thresholds.elevated)
            return 'elevated';
        if (pressurePercent >= this.thresholds.warning)
            return 'warning';
        return 'normal';
    }
    /**
     * Read system memory — platform-aware.
     */
    readSystemMemory() {
        if (process.platform === 'darwin') {
            return this.parseVmStat();
        }
        else if (process.platform === 'linux') {
            return this.parseProcMeminfo();
        }
        else {
            // Fallback: use Node's process.memoryUsage (very rough)
            const mem = process.memoryUsage();
            const totalGB = os.totalmem() / (1024 ** 3);
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
    parseVmStat() {
        const output = spawnSync('vm_stat', [], { encoding: 'utf-8', timeout: 5000 }).stdout ?? '';
        const pageSizeMatch = output.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : PAGE_SIZE_BYTES;
        const parsePages = (label) => {
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
    parseProcMeminfo() {
        const content = fs.readFileSync('/proc/meminfo', 'utf-8');
        const parseKB = (key) => {
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
    detectTrend() {
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
        if (denom === 0)
            return { trend: 'stable', ratePerMin: 0 };
        const slope = (n * sumXY - sumX * sumY) / denom;
        const ratePerMin = slope * 60;
        let trend;
        if (ratePerMin > 0.5)
            trend = 'rising';
        else if (ratePerMin < -0.5)
            trend = 'falling';
        else
            trend = 'stable';
        return { trend, ratePerMin };
    }
}
//# sourceMappingURL=MemoryPressureMonitor.js.map