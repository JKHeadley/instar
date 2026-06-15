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
  /**
   * Number of BACK-TO-BACK drift ticks at/above which a drift is treated as a CPU-
   * starvation burst and suppressed — regardless of duration or the (lagging) load
   * ratio. A genuine sleep is a single isolated drift (the next tick is on-time, which
   * resets the counter); sustained starvation produces consecutive drifts. Default: 2
   * (the 2nd consecutive drift is already a storm). Set 0 to disable.
   */
  driftBurstSuppressFloor?: number;
  /**
   * If ANOTHER drift was recorded within this window (ms), a new SHORT drift is treated
   * as CPU starvation and suppressed — even when it is NOT back-to-back. This catches the
   * gap `driftBurstSuppressFloor` misses: a repeating ~2-minute false-sleep cycle, where
   * many on-time ticks BETWEEN the drifts reset `consecutiveDrifts` to 0, so each drift
   * looks "isolated" and never reaches the burst floor. A healthy host does not genuinely
   * sleep-and-wake repeatedly every couple of minutes; repeated short drifts are the
   * starvation signature. Long sleeps (>= longSleepFloorSeconds) are exempt. Default:
   * 300000 (5 min). Set 0 to disable. (2026-06-15: sustained-saturation false-wake cascade.)
   */
  recentDriftWindowMs?: number;
  /**
   * If the host saw inbound user/mesh activity within this window (ms) of a drift, the
   * host was demonstrably awake during that window, so a SHORT "sleep" drift overlapping
   * recent activity is far more likely starvation than a real suspend — suppress it.
   * Requires `recentActivityAt`; absent ⇒ this signal is a no-op. Long sleeps are exempt.
   * Default: 120000 (2 min). Set 0 to disable.
   */
  activeHostWindowMs?: number;
  /**
   * Injectable provider of the wall-clock ms of the most recent inbound activity (a user
   * message, a mesh event), or null if unknown. Feeds the active-host signal above.
   * Absent ⇒ the active-host signal is a strict no-op (back-compat).
   */
  recentActivityAt?: () => number | null;
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
  private driftBurstSuppressFloor: number;
  /** Count of BACK-TO-BACK drift ticks (reset by any on-time tick). A real sleep is
   *  ONE isolated drift; sustained CPU starvation produces consecutive drifts. The
   *  Nth+ consecutive drift is a storm, not a sleep, and is suppressed regardless of
   *  the (lagging, fluctuating) 1-min load ratio — the gap maxLoadRatio alone missed
   *  (2026-06-07: tunnel-restart storm from 10-42s drifts firing whenever loadRatio
   *  momentarily dipped below maxLoadRatio). */
  private consecutiveDrifts = 0;
  /** Wall-clock ms of the most recent drift (consecutive OR not), or null. Feeds the
   *  recent-drift suppressor that catches the non-back-to-back ~2min false-sleep cycle. */
  private lastDriftAtMs: number | null = null;
  private recentDriftWindowMs: number;
  private activeHostWindowMs: number;
  private recentActivityAt: (() => number | null) | null;
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
    this.driftBurstSuppressFloor = config.driftBurstSuppressFloor ?? 2;
    // ON by default (300000) — this is the FIX for the false-wake-under-load cascade, not a
    // new opt-in feature; shipping it disabled would leave the harmful detector bug in place.
    // The fail-safe direction (suppress-on-doubt) + the long-sleep exemption (>=300s always
    // emits) bound the risk; set to 0 to revert to exact pre-fix behavior (the rollback lever).
    this.recentDriftWindowMs = config.recentDriftWindowMs ?? 300000;
    this.activeHostWindowMs = config.activeHostWindowMs ?? 120000;
    this.recentActivityAt = config.recentActivityAt ?? null;
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

      if (elapsed <= this.driftThresholdMs) { this.consecutiveDrifts = 0; return; } // on-time tick → not starving

      const sleepDuration = Math.round((elapsed - this.checkIntervalMs) / 1000);
      const isLongSleep = sleepDuration >= this.longSleepFloorSeconds;
      const loadRatio = this.currentLoadRatio();
      this.consecutiveDrifts += 1;
      // Age of the PREVIOUS drift (computed before we stamp this one). A repeating
      // false-sleep cycle is ~minutes apart — not back-to-back — so the consecutive
      // counter resets between drifts and never catches it; this timestamp does.
      const driftAgoMs = this.lastDriftAtMs !== null ? now - this.lastDriftAtMs : Infinity;
      this.lastDriftAtMs = now;

      // Consecutive-drift burst = sustained CPU starvation, not sleep. A genuine sleep
      // is ONE isolated drift (the next on-time tick resets the counter); the 2nd+
      // back-to-back SHORT drift is a storm. Suppress it regardless of the (lagging,
      // fluctuating) load ratio — this catches the drifts maxLoadRatio missed when the
      // 1-min average momentarily dipped below the threshold (2026-06-07 tunnel-restart
      // storm). A genuine LONG sleep (>= longSleepFloorSeconds) is exempt — it always
      // emits (real-sleep recovery is essential), and the FIRST short drift still falls
      // through to the checks below, so an isolated real wake is unaffected.
      if (!isLongSleep && this.driftBurstSuppressFloor > 0 && this.consecutiveDrifts >= this.driftBurstSuppressFloor) {
        this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Drift ~${sleepDuration}s — consecutive drift #${this.consecutiveDrifts} ` +
            `(>= ${this.driftBurstSuppressFloor}) = starvation burst, suppressing wake`,
        );
        return;
      }

      // Recent-drift memory: another drift within the window (even NOT back-to-back) =
      // a repeating starvation cycle, not genuine sleep. This is the suppressor the
      // consecutive-burst floor misses, because many on-time ticks between the ~2-min-apart
      // drifts reset consecutiveDrifts to 0 (so each looks isolated). A real host does not
      // sleep-and-wake repeatedly every few minutes. Long sleeps stay exempt.
      if (!isLongSleep && this.recentDriftWindowMs > 0 && driftAgoMs < this.recentDriftWindowMs) {
        this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Drift ~${sleepDuration}s — prior drift ${Math.round(driftAgoMs / 1000)}s ago ` +
            `(< ${Math.round(this.recentDriftWindowMs / 1000)}s) = repeating starvation cycle, suppressing wake`,
        );
        return;
      }

      // Active-host signal: inbound activity within the window means the host was awake
      // during it, so a SHORT "sleep" drift overlapping recent activity is starvation, not
      // a real suspend. No-op when no recentActivityAt provider is wired. Long sleeps exempt.
      if (!isLongSleep && this.activeHostWindowMs > 0 && this.recentActivityAt) {
        const lastActivityAt = this.recentActivityAt();
        if (lastActivityAt !== null && now - lastActivityAt < this.activeHostWindowMs) {
          this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
          console.warn(
            `[SleepWakeDetector] Drift ~${sleepDuration}s — host active ${Math.round((now - lastActivityAt) / 1000)}s ago ` +
              `(< ${Math.round(this.activeHostWindowMs / 1000)}s) = awake under load, suppressing wake`,
          );
          return;
        }
      }

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
