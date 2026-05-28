/**
 * Detects macOS/Linux sleep/wake events via timer drift.
 *
 * When the system sleeps, setInterval timers stop. On wake, the
 * time elapsed between ticks will be much larger than expected.
 * We detect this drift and fire a callback.
 *
 * Ported from Dawn's infrastructure — battle-tested in production.
 */

import { EventEmitter } from 'node:events';

export interface SleepWakeDetectorConfig {
  /** How often to check for drift (ms). Default: 2000 */
  checkIntervalMs?: number;
  /** How much drift (ms) indicates a sleep event. Default: 10000 */
  driftThresholdMs?: number;
}

export interface WakeEvent {
  sleepDurationSeconds: number;
  timestamp: string;
}

export class SleepWakeDetector extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTick: number = Date.now();
  private checkIntervalMs: number;
  private driftThresholdMs: number;
  private wakeHistory: WakeEvent[] = [];

  constructor(config: SleepWakeDetectorConfig = {}) {
    super();
    this.checkIntervalMs = config.checkIntervalMs ?? 2000;
    this.driftThresholdMs = config.driftThresholdMs ?? 10000;
  }

  start(): void {
    if (this.interval) return;
    this.lastTick = Date.now();

    this.interval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastTick;
      this.lastTick = now;

      if (elapsed > this.driftThresholdMs) {
        const sleepDuration = Math.round((elapsed - this.checkIntervalMs) / 1000);
        console.log(`[SleepWakeDetector] Wake detected after ~${sleepDuration}s sleep`);
        const event: WakeEvent = { sleepDurationSeconds: sleepDuration, timestamp: new Date().toISOString() };
        this.wakeHistory.push(event);
        if (this.wakeHistory.length > 100) this.wakeHistory.shift();
        this.emit('wake', event);
      }
    }, this.checkIntervalMs);
    this.interval.unref(); // Don't prevent process exit in CLI contexts
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
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
  getStats(sinceMs?: number): { wakeCount: number; totalSleepSeconds: number; longestSleepSeconds: number } {
    const since = sinceMs ?? 0;
    const relevant = this.wakeHistory.filter(e => new Date(e.timestamp).getTime() >= since);
    return {
      wakeCount: relevant.length,
      totalSleepSeconds: relevant.reduce((sum, e) => sum + e.sleepDurationSeconds, 0),
      longestSleepSeconds: relevant.length > 0 ? Math.max(...relevant.map(e => e.sleepDurationSeconds)) : 0,
    };
  }
}
