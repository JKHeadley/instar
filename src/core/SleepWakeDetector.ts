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
 * ## Recurring-drift guard for the MODERATE-load band (2026-06-15)
 *
 * The load guard (`maxLoadRatio`, default 1.5) and the consecutive-drift burst floor
 * together miss one real cascade: a host oversubscribed only MODERATELY — load just
 * above 1.0/core but below `maxLoadRatio` — stalls its event loop for tens of seconds
 * *intermittently*, ~every couple of minutes. Because on-time ticks fall between those
 * drifts, the consecutive counter resets (so the burst floor never trips), and because
 * the 1-minute `loadavg[0]` sits below 1.5, the load guard never trips either. Each
 * isolated drift then emits a FALSE wake, and the ~2-minute cadence outlasts the
 * `minWakeIntervalMs` cooldown — the 2026-06-15 multi-machine cascade (loadRatio ~1.1/core,
 * `Wake detected after ~33s sleep` roughly every 2 minutes while the host was in use).
 *
 * The recurring-drift guard closes that band: a SHORT drift within `recentDriftWindowMs`
 * of a PRIOR short drift, while `loadRatio > recentDriftLoadFloor`, is recurring
 * starvation and is suppressed — generalizing the burst floor from *consecutive* ticks
 * to *recent* ticks. A genuine isolated sleep (no recent prior drift) and any drift on a
 * lightly-loaded host (ratio <= the floor) are unaffected and still emit; long sleeps are
 * always exempt. Set `recentDriftWindowMs: 0` to disable.
 *
 * Suppressed events are NOT added to `wakeHistory`, so `getCumulativeSleepMsBetween`
 * (the wake-reaper's sleep-credit source) only ever counts genuine sleep.
 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { readSyncOpMarker } from './InFlightSyncOpMarker.js';

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
   * A SHORT drift within this window (ms) of a PRIOR short drift, while
   * `loadRatio > recentDriftLoadFloor`, is treated as recurring CPU starvation and
   * suppressed — closing the moderate-load band (above the floor, below `maxLoadRatio`)
   * where intermittent drifts dodge BOTH the load guard and the consecutive burst floor.
   * Default: 300000 (5 min). Set 0 to disable.
   */
  recentDriftWindowMs?: number;
  /**
   * `loadavg[0] / cpuCount` above which the recurring-drift guard applies. At or below
   * this the host is not oversubscribed, so a recurring short drift is trusted as a real
   * brief sleep and still emits. Default: 1.0.
   */
  recentDriftLoadFloor?: number;
  /** Injectable system-load source (testing). Default: os.loadavg. */
  loadAvgProvider?: () => number[];
  /** Injectable CPU-count source (testing). Default: os.cpus().length. */
  cpuCountProvider?: () => number;
  /** Injectable wall-clock source (testing). Default: Date.now. */
  nowProvider?: () => number;
  /**
   * Fraction of a drift gap during which THIS process must have consumed CPU for the
   * drift to be classified as an event-loop BLOCK (a wedge/stall) rather than sleep.
   *
   * This is the per-PROCESS signal the load heuristics can't provide: a suspended
   * (sleeping) process burns ~0 CPU during the gap, while a blocked event loop burns
   * CPU for most of it. One Node thread blocking for 14s doesn't move a 16-core
   * `loadavg` above `maxLoadRatio`, so the load guards emit a FALSE "sleep" — but the
   * process's own CPU usage exposes it definitively. Applies to LONG drifts too: a
   * multi-minute CPU-busy drift is the event-loop wedge, never sleep. Default: 0.5.
   * Set 0 to disable.
   */
  cpuBlockBusyRatio?: number;
  /**
   * Injectable cumulative-process-CPU source in MICROSECONDS (testing). Default sums
   * `process.cpuUsage()` user + system. Used to compute CPU burned across a drift gap.
   */
  cpuUsageProvider?: () => number;
  /**
   * Injectable in-flight-sync-op marker reader (testing). Default reads the process-wide
   * `InFlightSyncOpMarker` singleton. Reports whether ANY synchronous subprocess/blocking
   * op (tmux, /bin/sleep, tunnel, any sync spawn) is in flight on the event loop RIGHT NOW.
   * This is the PRIMARY discriminator for the ~0-CPU I/O-WAIT block the CPU check above
   * cannot see: a sync-spawn wait burns ~0 CPU in the parent → cpuBusyRatio ≈ 0 → the drift
   * would otherwise fall through to a FALSE wake. `stale` (older than 2× the per-op timeout)
   * means the marker leaked — it is ignored so a real multi-minute sleep that began mid-op
   * re-classifies as a wake once the TTL expires (the both-directions safety).
   */
  syncOpMarkerProvider?: () => { inFlight: boolean; depth: number; stale: boolean };
  /**
   * Gate (B): when true, a ~0-CPU drift while a sync subprocess op is in flight (and not
   * stale) is classified as an event-loop BLOCK (a `stall`) rather than a sleep wake.
   * Resolved server-side from `monitoring.tmuxResilience.inFlightMarker.enabled` via the
   * dev-agent gate. Default `false` ⇒ the marker branch is inert and behavior is byte-for-byte
   * today's (D6 observable-equivalence when off).
   */
  inFlightMarkerEnabled?: boolean;
}

export interface WakeEvent {
  sleepDurationSeconds: number;
  timestamp: string;
}

export type WakeSuppressionReason = 'cpu-starvation' | 'cooldown' | 'event-loop-block';

/**
 * Emitted when a drift is PROVEN to be an event-loop block (this process burned CPU
 * through the gap), not sleep. Signal-only so wedge watchers can see a real stall that
 * the detector would otherwise have mislabeled as a wake. No consumer = harmless.
 */
export interface StallEvent {
  /** Drift duration in seconds (how long the loop was blocked). */
  stallSeconds: number;
  /** Fraction of the gap this process spent on CPU (≈1 = fully CPU-bound block). */
  cpuBusyRatio: number;
  timestamp: string;
}

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
  private recentDriftWindowMs: number;
  private recentDriftLoadFloor: number;
  /** Wall-clock (ms) of the most recent SHORT drift, emitted or suppressed. Drives the
   *  recurring-drift guard: a fresh short drift within `recentDriftWindowMs` of this,
   *  under elevated load, is recurring starvation. Null until the first short drift. */
  private lastShortDriftAtMs: number | null = null;
  /** Count of BACK-TO-BACK drift ticks (reset by any on-time tick). A real sleep is
   *  ONE isolated drift; sustained CPU starvation produces consecutive drifts. The
   *  Nth+ consecutive drift is a storm, not a sleep, and is suppressed regardless of
   *  the (lagging, fluctuating) 1-min load ratio — the gap maxLoadRatio alone missed
   *  (2026-06-07: tunnel-restart storm from 10-42s drifts firing whenever loadRatio
   *  momentarily dipped below maxLoadRatio). */
  private consecutiveDrifts = 0;
  private loadAvgProvider: () => number[];
  private cpuCountProvider: () => number;
  private now: () => number;
  private cpuBlockBusyRatio: number;
  private cpuUsageProvider: () => number;
  /** Gate (B) flag — when false the in-flight-marker branch is inert (today's behavior). */
  private inFlightMarkerEnabled: boolean;
  /** In-flight-sync-op marker reader — the ~0-CPU I/O-wait block discriminator. */
  private syncOpMarker: () => { inFlight: boolean; depth: number; stale: boolean };
  /** Cumulative process CPU (µs) sampled at the previous tick — drives the per-process
   *  CPU-busy-through-the-gap discriminator that separates a real sleep from a block. */
  private lastCpuMicros = 0;
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
    this.recentDriftWindowMs = config.recentDriftWindowMs ?? 300000;
    this.recentDriftLoadFloor = config.recentDriftLoadFloor ?? 1.0;
    this.loadAvgProvider = config.loadAvgProvider ?? (() => os.loadavg());
    this.cpuCountProvider = config.cpuCountProvider ?? (() => os.cpus().length);
    this.now = config.nowProvider ?? (() => Date.now());
    this.cpuBlockBusyRatio = config.cpuBlockBusyRatio ?? 0.5;
    this.cpuUsageProvider =
      config.cpuUsageProvider ?? (() => { const c = process.cpuUsage(); return c.user + c.system; });
    this.inFlightMarkerEnabled = config.inFlightMarkerEnabled ?? false;
    this.syncOpMarker =
      config.syncOpMarkerProvider ??
      (() => {
        const m = readSyncOpMarker();
        return { inFlight: m.inFlight, depth: m.depth, stale: m.stale };
      });
    this.lastTick = this.now();
    this.lastCpuMicros = this.readCpuMicros();
  }

  start(): void {
    if (this.interval) return;
    this.lastTick = this.now();
    this.lastCpuMicros = this.readCpuMicros();

    this.interval = setInterval(() => {
      const now = this.now();
      const elapsed = now - this.lastTick;
      this.lastTick = now;
      // CPU burned by THIS process across the gap — the per-process sleep-vs-block signal.
      const cpuNowMicros = this.readCpuMicros();
      const cpuBusyRatio = elapsed > 0 ? ((cpuNowMicros - this.lastCpuMicros) / 1000) / elapsed : 0;
      this.lastCpuMicros = cpuNowMicros;

      if (elapsed <= this.driftThresholdMs) { this.consecutiveDrifts = 0; return; } // on-time tick → not starving

      const sleepDuration = Math.round((elapsed - this.checkIntervalMs) / 1000);
      const isLongSleep = sleepDuration >= this.longSleepFloorSeconds;
      const loadRatio = this.currentLoadRatio();
      this.consecutiveDrifts += 1;
      // Record every SHORT drift's time (emitted or suppressed) so the recurring-drift
      // guard below can measure recurrence; capture the prior value first for the check.
      const prevShortDriftAtMs = this.lastShortDriftAtMs;
      if (!isLongSleep) this.lastShortDriftAtMs = now;

      // Per-process CPU check — the DEFINITIVE sleep-vs-block discriminator, ahead of the
      // load heuristics. A suspended (sleeping) process burns ~0 CPU during the gap; a
      // blocked event loop burns CPU through most of it. So a high busy ratio means the
      // loop was BLOCKED and the machine did NOT sleep — regardless of duration (a
      // multi-minute CPU-busy drift is the event-loop WEDGE, not sleep) and regardless of
      // the system loadavg (one blocked Node thread doesn't move a 16-core average). Emit a
      // `stall` signal for the wedge watchers; never a `wake`. (2026-06-21: fixes the
      // misdiagnosis where 11-18s event-loop blocks on a caffeinated host — where sleep is
      // physically impossible — were logged as "Wake detected after ~Ns sleep".)
      if (this.cpuBlockBusyRatio > 0 && cpuBusyRatio >= this.cpuBlockBusyRatio) {
        this.recordSuppression('event-loop-block', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Drift ~${sleepDuration}s but this process burned ` +
            `${Math.round(cpuBusyRatio * 100)}% CPU through the gap — event-loop BLOCK, not ` +
            `sleep (the machine did not sleep). Emitting stall, suppressing wake.`,
        );
        this.emit('stall', {
          stallSeconds: sleepDuration,
          cpuBusyRatio,
          timestamp: new Date(now).toISOString(),
        } as StallEvent);
        return;
      }

      // In-flight-sync-op marker — the PRIMARY discriminator for the ~0-CPU I/O-WAIT block
      // the CPU check above cannot see. A synchronous subprocess wait (tmux/tunnel/sleep)
      // burns ~0 CPU in the parent, so cpuBusyRatio ≈ 0 and this drift would otherwise fall
      // through to the load guards / a FALSE wake. If a sync subprocess op is in flight
      // (depth>0) and NOT stale, the loop is BLOCKED waiting on that op — an event-loop
      // BLOCK, not sleep. Runs AFTER the CPU check (a CPU-spinning block still labels via the
      // accurate CPU path above) and BEFORE the burst/load/recurring/cooldown guards (so a
      // marked I/O block never reaches emit('wake')). A STALE marker (older than 2×timeout —
      // a leaked depth) is ignored so a real multi-minute sleep that began mid-op
      // re-classifies as a wake once the TTL expires (the both-directions safety; depth>0
      // alone would permanently mislabel a real sleep and starve the wake-reaper of sleep
      // credit). Gated behind monitoring.tmuxResilience.inFlightMarker.enabled — when off the
      // branch is skipped and behavior is byte-for-byte today's.
      if (this.inFlightMarkerEnabled) {
        const marker = this.readMarkerSafely();
        if (marker.inFlight && !marker.stale) {
          this.recordSuppression('event-loop-block', sleepDuration, loadRatio, now);
          console.warn(
            `[SleepWakeDetector] Drift ~${sleepDuration}s while ${marker.depth} sync subprocess ` +
              `op(s) in flight (cpuBusyRatio ${Math.round(cpuBusyRatio * 100)}% — I/O-wait block, ` +
              `~0 CPU) — event-loop BLOCK, not sleep. Emitting stall, suppressing wake.`,
          );
          this.emit('stall', {
            stallSeconds: sleepDuration,
            cpuBusyRatio,
            timestamp: new Date(now).toISOString(),
          } as StallEvent);
          return;
        }
      }

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

      // Short drift under heavy CPU load = event-loop starvation, not sleep.
      if (!isLongSleep && loadRatio > this.maxLoadRatio) {
        this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Drift ~${sleepDuration}s under load ratio ${loadRatio.toFixed(2)} ` +
            `(> ${this.maxLoadRatio}) — treating as CPU starvation, suppressing wake`,
        );
        return;
      }

      // Recurring short drift under MODERATE load (the band the two guards above miss):
      // a short drift within recentDriftWindowMs of a PRIOR short drift, while load is
      // above recentDriftLoadFloor (oversubscribed) but below maxLoadRatio, is recurring
      // CPU starvation — the 2026-06-15 cascade where loadRatio sat ~1.1/core (under the
      // 1.5 hard guard) yet the loop stalled every ~2min, and on-time ticks between the
      // drifts reset the consecutive counter so the burst floor never tripped. A genuine
      // isolated sleep (no recent prior drift) and any drift on a lightly-loaded host
      // (ratio <= floor) still emit; long sleeps are exempt (handled above).
      if (
        !isLongSleep &&
        this.recentDriftWindowMs > 0 &&
        loadRatio > this.recentDriftLoadFloor &&
        prevShortDriftAtMs !== null &&
        now - prevShortDriftAtMs < this.recentDriftWindowMs
      ) {
        this.recordSuppression('cpu-starvation', sleepDuration, loadRatio, now);
        console.warn(
          `[SleepWakeDetector] Recurring short drift ~${sleepDuration}s within ` +
            `${this.recentDriftWindowMs}ms of a prior short drift at load ratio ` +
            `${loadRatio.toFixed(2)} (> ${this.recentDriftLoadFloor}) — recurring CPU ` +
            `starvation, suppressing wake`,
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

  /** Read cumulative process CPU (µs) defensively. A provider error (or a non-finite
   *  reading) yields the prior value, so the gap delta becomes 0 → no block signal →
   *  the tick falls through to the load guards. That is the safe direction: a CPU-read
   *  failure can never crash the tick (it runs inside setInterval) nor force a false
   *  block classification — it just disables this one discriminator for that tick. */
  private readCpuMicros(): number {
    try {
      const v = this.cpuUsageProvider();
      return Number.isFinite(v) ? v : this.lastCpuMicros;
    } catch {
      return this.lastCpuMicros;
    }
  }

  /** Read the in-flight-sync-op marker defensively. A provider error yields a safe "no op
   *  in flight" reading, so a marker-read failure can NEVER crash the tick (it runs inside
   *  setInterval) nor force a false BLOCK classification — it just disables this one
   *  discriminator for that tick (the drift falls through to the CPU + load guards). Mirrors
   *  readCpuMicros()'s fail-safe direction. */
  private readMarkerSafely(): { inFlight: boolean; depth: number; stale: boolean } {
    try {
      return this.syncOpMarker();
    } catch {
      return { inFlight: false, depth: 0, stale: false };
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
      'event-loop-block': 0,
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
