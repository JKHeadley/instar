/**
 * Detects macOS/Linux sleep/wake events via timer drift.
 *
 * When the system sleeps, setInterval timers stop. On wake, the
 * time elapsed between ticks will be much larger than expected.
 * We detect this drift and fire a callback.
 *
 * Ported from Dawn's infrastructure — battle-tested in production.
 *
 * ## CPU-starvation guard (2026-05-28)
 *
 * Timer drift has TWO causes, not one:
 *   1. Real sleep — the OS suspends the process; the wall clock jumps forward.
 *   2. CPU starvation — the machine is so oversubscribed (load >> cores) that the
 *      event loop can't service the `checkIntervalMs` timer on time. The wall
 *      clock advances normally, but the callback fires seconds late.
 *
 * The original detector could not tell these apart, so on a heavily-loaded box
 * (e.g. many concurrent agent sessions) it fired hundreds of false "wake" events
 * — each triggering expensive wake-recovery (tunnel restart, re-registration,
 * failure-counter resets) that piled MORE load on, a self-reinforcing storm.
 *
 * The guard distinguishes the two:
 *   - A **long** drift (>= `longSleepFloorSeconds`) is unambiguously real sleep —
 *     a live machine never starves its own event loop for minutes (a watchdog
 *     would declare it dead first). Always emitted, regardless of load.
 *   - A **short** drift under high system load (`loadavg[0] / cpuCount >
 *     maxLoadRatio`) is treated as CPU starvation and SUPPRESSED — no `wake`.
 *   - A short drift under normal load is a brief real sleep — emitted.
 * On top of classification, a `minWakeIntervalMs` cooldown caps the emit rate so
 * even a misclassified burst can't trigger a recovery storm.
 *
 * Suppressed events are NOT added to `wakeHistory`, so `getCumulativeSleepMsBetween`
 * (the wake-reaper's sleep-credit source) only ever counts genuine sleep.
 */

import { EventEmitter } from 'node:events';
import os from 'node:os';

export interface SleepWakeDetectorConfig {
  /** How often to check for drift (ms). Default: 2000 */
  checkIntervalMs?: number;
  /** How much drift (ms) indicates a sleep event. Default: 10000 */
  driftThresholdMs?: number;
  /**
   * Above this `loadavg[0] / cpuCount` ratio, a SHORT drift is classified as CPU
   * starvation and suppressed rather than emitted as a wake. Default: 1.5.
   * Set to `Infinity` to disable the load guard (always trust the drift).
   */
  maxLoadRatio?: number;
  /**
   * A drift at least this long (seconds) is always treated as real sleep,
   * regardless of load — a live event loop never starves for this long.
   * Default: 300 (5 minutes).
   */
  longSleepFloorSeconds?: number;
  /**
   * Minimum gap (ms) between EMITTED wake events. A short drift that would emit
   * within this cooldown of the previous emitted wake is suppressed, bounding
   * recovery storms. Long sleeps bypass the cooldown. Default: 60000 (1 min).
   */
  minWakeIntervalMs?: number;
  /** Injectable system-load source (testing). Default: os.loadavg. */
  loadAvgProvider?: () => number[];
  /** Injectable CPU-count source (testing). Default: os.cpus().length. */
  cpuCountProvider?: () => number;
  /** Injectable wall-clock source (testing). Default: Date.now. */
  nowProvider?: () => number;
}

export interface WakeEvent {
  sleepDurationSeconds: number;
  timestamp: string;
}

export type WakeSuppressionReason = 'cpu-starvation' | 'cooldown';

export interface SuppressedWakeEvent {
  reason: WakeSuppressionReason;
  driftSeconds: number;
  loadRatio: number;
  timestamp: string;
}

export interface SleepWakeStats {
  wakeCount: number;
  totalSleepSeconds: number;
  longestSleepSeconds: number;
  /** Drifts classified as CPU starvation / rate-limited and NOT emitted. */
  suppressedCount: number;
  suppressedByReason: Record<WakeSuppressionReason, number>;
  /** ISO timestamp of the most recent suppression, or null. */
  lastSuppressedAt: string | null;
}

export class SleepWakeDetector extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTick: number;
  private lastEmittedWakeAtMs: number | null = null;
  private checkIntervalMs: number;
  private driftThresholdMs: number;
  private maxLoadRatio: number;
  private longSleepFloorSeconds: number;
  private minWakeIntervalMs: number;
  private loadAvgProvider: () => number[];
  private cpuCountProvider: () => number;
  private now: () => number;
  private wakeHistory: WakeEvent[] = [];
  private suppressionHistory: SuppressedWakeEvent[] = [];

  constructor(config: SleepWakeDetectorConfig = {}) {
    super();
    this.checkIntervalMs = config.checkIntervalMs ?? 2000;
    this.driftThresholdMs = config.driftThresholdMs ?? 10000;
    this.maxLoadRatio = config.maxLoadRatio ?? 1.5;
    this.longSleepFloorSeconds = config.longSleepFloorSeconds ?? 300;
    this.minWakeIntervalMs = config.minWakeIntervalMs ?? 60000;
    this.loadAvgProvider = config.loadAvgProvider ?? (() => os.loadavg());
    this.cpuCountProvider = config.cpuCountProvider ?? (() => os.cpus().length);
    this.now = config.nowProvider ?? (() => Date.now());
    this.lastTick = this.now();
  }

  start(): void {
    if (this.interval) return;
    this.lastTick = this.now();

    this.interval = setInterval(() => {
      const now = this.now();
      const elapsed = now - this.lastTick;
      this.lastTick = now;

      if (elapsed <= this.driftThresholdMs) return;

      const sleepDuration = Math.round((elapsed - this.checkIntervalMs) / 1000);
      const isLongSleep = sleepDuration >= this.longSleepFloorSeconds;
      const loadRatio = this.currentLoadRatio();

      // Short drift under heavy CPU load = event-loop starvation, not sleep.
      if (!isLongSleep && loadRatio > this.maxLoadRatio) {
        this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Drift ~${sleepDuration}s under load ratio ${loadRatio.toFixed(2)} ` +
            `(> ${this.maxLoadRatio}) — treating as CPU starvation, suppressing wake`,
        );
        return;
      }

      // Rate-limit emitted wakes so even a misclassified burst can't storm
      // recovery. Long sleeps bypass the cooldown — recovery there is essential.
      if (
        !isLongSleep &&
        this.lastEmittedWakeAtMs !== null &&
        now - this.lastEmittedWakeAtMs < this.minWakeIntervalMs
      ) {
        this.recordSuppression('cooldown', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Wake within cooldown ` +
            `(${now - this.lastEmittedWakeAtMs}ms < ${this.minWakeIntervalMs}ms) — suppressing duplicate recovery`,
        );
        return;
      }

      console.log(`[SleepWakeDetector] Wake detected after ~${sleepDuration}s sleep`);
      const event: WakeEvent = { sleepDurationSeconds: sleepDuration, timestamp: new Date(now).toISOString() };
      this.wakeHistory.push(event);
      if (this.wakeHistory.length > 100) this.wakeHistory.shift();
      this.lastEmittedWakeAtMs = now;
      this.emit('wake', event);
    }, this.checkIntervalMs);
    this.interval.unref(); // Don't prevent process exit in CLI contexts
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Current `loadavg[0] / cpuCount` ratio. Returns 0 when load is unavailable
   *  (e.g. Windows reports [0,0,0]), which disables the starvation guard there. */
  private currentLoadRatio(): number {
    let cpuCount = 1;
    try {
      cpuCount = Math.max(1, this.cpuCountProvider());
    } catch {
      cpuCount = 1;
    }
    let load1 = 0;
    try {
      load1 = this.loadAvgProvider()[0] ?? 0;
    } catch {
      load1 = 0;
    }
    if (!Number.isFinite(load1) || load1 <= 0) return 0;
    return load1 / cpuCount;
  }

  private recordSuppression(
    reason: WakeSuppressionReason,
    driftSeconds: number,
    loadRatio: number,
    nowMs: number,
  ): void {
    this.suppressionHistory.push({
      reason,
      driftSeconds,
      loadRatio: Math.round(loadRatio * 100) / 100,
      timestamp: new Date(nowMs).toISOString(),
    });
    if (this.suppressionHistory.length > 100) this.suppressionHistory.shift();
  }

  /**
   * Cumulative wall-time-asleep during the half-open window [startMs, endMs).
   * Used by the wake-reaper (UNIFIED-SESSION-LIFECYCLE §P0 #9 / SE-8) to subtract
   * sleep that overlapped a job run rather than relying on the single last
   * `sleepDurationSeconds` event — a run that started before multiple sleeps was
   * previously credited only the last sleep's duration and reaped early.
   *
   * Each wake event's sleep window is approximated as
   *   [wakeTimestamp − sleepDurationSeconds, wakeTimestamp].
   * Returns the sum of overlap with the query window in milliseconds. Returns 0
   * when the history is empty or no event overlaps.
   *
   * Only EMITTED wakes are in `wakeHistory`; suppressed CPU-starvation drifts are
   * deliberately excluded so starvation is never credited as real sleep.
   */
  getCumulativeSleepMsBetween(startMs: number, endMs: number): number {
    if (endMs <= startMs) return 0;
    let total = 0;
    for (const e of this.wakeHistory) {
      const wakeMs = new Date(e.timestamp).getTime();
      const sleepStartMs = wakeMs - e.sleepDurationSeconds * 1000;
      const overlapStart = Math.max(startMs, sleepStartMs);
      const overlapEnd = Math.min(endMs, wakeMs);
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }
    return total;
  }

  /** Get wake event stats for telemetry reporting. */
  getStats(sinceMs?: number): SleepWakeStats {
    const since = sinceMs ?? 0;
    const relevant = this.wakeHistory.filter(e => new Date(e.timestamp).getTime() >= since);
    const suppressed = this.suppressionHistory.filter(e => new Date(e.timestamp).getTime() >= since);
    const suppressedByReason: Record<WakeSuppressionReason, number> = {
      'cpu-starvation': 0,
      cooldown: 0,
    };
    for (const e of suppressed) suppressedByReason[e.reason]++;
    return {
      wakeCount: relevant.length,
      totalSleepSeconds: relevant.reduce((sum, e) => sum + e.sleepDurationSeconds, 0),
      longestSleepSeconds: relevant.length > 0 ? Math.max(...relevant.map(e => e.sleepDurationSeconds)) : 0,
      suppressedCount: suppressed.length,
      suppressedByReason,
      lastSuppressedAt: suppressed.length > 0 ? suppressed[suppressed.length - 1].timestamp : null,
    };
  }
}
