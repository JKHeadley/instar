/**
 * Disk Steward — pure decision logic (spec docs/specs/disk-steward.md §3.2–§3.5).
 * No I/O: thresholds, the growth forecast, level transitions with hysteresis,
 * and the post schedule. Everything here is a SIGNAL: it decides when to clean
 * and when to speak, never what may be deleted.
 */
import { mediaDiskFloorBytes } from '../../core/AppMediaStore.js';

export const GiB = 1024 ** 3;

export interface DiskStewardThresholdConfig {
  warnPercent: number;
  warnMinGiB: number;
  escalatePercent: number;
  escalateMinGiB: number;
  forecastEscalateDays: number;
}

export const DEFAULT_THRESHOLDS: DiskStewardThresholdConfig = {
  warnPercent: 15, warnMinGiB: 100, escalatePercent: 10, escalateMinGiB: 60, forecastEscalateDays: 3,
};

export interface Thresholds { warnBelow: number; escalateBelow: number; floor: number; margin: number }

/** §3.3: absolute minimums apply, but never more than 30% / 20% of the disk. */
export function thresholdsFor(total: number, cfg: DiskStewardThresholdConfig = DEFAULT_THRESHOLDS): Thresholds {
  const warnBelow = Math.min(Math.max((cfg.warnPercent / 100) * total, cfg.warnMinGiB * GiB), 0.3 * total);
  const escalateBelow = Math.min(Math.max((cfg.escalatePercent / 100) * total, cfg.escalateMinGiB * GiB), 0.2 * total);
  return { warnBelow, escalateBelow, floor: mediaDiskFloorBytes(total), margin: 0.02 * total };
}

export interface Sample { t: number; free: number; total: number; recovered?: number }

export type Fit = { kind: 'insufficient' } | { kind: 'fit'; slopePerDay: number; daysToFloor: number | null };
export interface Forecast { fit24h: Fit; fit7d: Fit; daysToFloor: number | null }

const DAY = 86_400_000;

/** Least squares over `adjusted = free − Σ recovered` (§3.2). */
function fitWindow(samples: readonly Sample[], now: number, windowMs: number, minN: number, minSpanMs: number, floor: number, free: number): Fit {
  let cum = 0;
  const pts: Array<[number, number]> = [];
  for (const s of samples) {
    cum += s.recovered ?? 0;
    if (s.t >= now - windowMs && s.t <= now) pts.push([s.t, s.free - cum]);
  }
  if (pts.length < minN) return { kind: 'insufficient' };
  const span = pts[pts.length - 1][0] - pts[0][0];
  if (span < minSpanMs) return { kind: 'insufficient' };
  const n = pts.length;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0; let den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  if (den === 0) return { kind: 'insufficient' };
  const slopePerDay = (num / den) * DAY;
  const daysToFloor = slopePerDay < 0 ? Math.max(0, (free - floor) / -slopePerDay) : null;
  return { kind: 'fit', slopePerDay, daysToFloor };
}

export function forecast(samples: readonly Sample[], now: number, floor: number, free: number): Forecast {
  const fit24h = fitWindow(samples, now, DAY, 12, 6 * 3_600_000, floor, free);
  const fit7d = fitWindow(samples, now, 7 * DAY, 48, 2 * DAY, floor, free);
  const days = [fit24h, fit7d].flatMap((f) => (f.kind === 'fit' && f.daysToFloor !== null ? [f.daysToFloor] : []));
  return { fit24h, fit7d, daysToFloor: days.length ? Math.min(...days) : null };
}

export type Level = 'ok' | 'warn' | 'escalate';
const RANK: Record<Level, number> = { ok: 0, warn: 1, escalate: 2 };

export interface LevelState { level: Level; critical: boolean; leaveStreak: number }

/** The raw (entering) predicates for one reading. */
export function rawLevel(free: number, th: Thresholds, daysToFloor: number | null, cfg: DiskStewardThresholdConfig = DEFAULT_THRESHOLDS): { level: Level; critical: boolean } {
  const soon = daysToFloor !== null && daysToFloor < cfg.forecastEscalateDays;
  const level: Level = free < th.escalateBelow || (free < th.warnBelow && soon) ? 'escalate' : free < th.warnBelow ? 'warn' : 'ok';
  // A disk above the warn line is never urgent on the forecast alone (§3.3).
  const critical = free < th.floor || (free < th.warnBelow && daysToFloor !== null && daysToFloor < 1);
  return { level, critical };
}

/** Whether a reading is clear of a level by its leaving margin (§3.3, per branch). */
function clearOf(level: Level, free: number, th: Thresholds, daysToFloor: number | null, cfg: DiskStewardThresholdConfig): boolean {
  const roomy = free >= th.warnBelow + th.margin;
  if (level === 'warn') return roomy;
  if (level === 'escalate') {
    return free >= th.escalateBelow + th.margin && (daysToFloor === null || daysToFloor >= cfg.forecastEscalateDays || roomy);
  }
  return true;
}
function clearOfCritical(free: number, th: Thresholds, daysToFloor: number | null): boolean {
  return free >= th.floor + th.margin && (daysToFloor === null || daysToFloor >= 1);
}

/**
 * One step of the level machine. Entering a higher level (or critical) takes one
 * reading; leaving takes two consecutive readings clear by the margin.
 */
export function stepLevel(prev: LevelState, free: number, th: Thresholds, daysToFloor: number | null, cfg: DiskStewardThresholdConfig = DEFAULT_THRESHOLDS): LevelState & { rose: boolean; criticalEntered: boolean; ended: boolean } {
  const raw = rawLevel(free, th, daysToFloor, cfg);
  let level = prev.level;
  let critical = prev.critical;
  let leaveStreak = prev.leaveStreak;
  let rose = false;
  let criticalEntered = false;
  if (RANK[raw.level] > RANK[level]) { level = raw.level; rose = true; leaveStreak = 0; }
  if (raw.critical && !critical) { critical = true; criticalEntered = true; leaveStreak = 0; }
  const wasActive = prev.level !== 'ok' || prev.critical;
  if (!rose && !criticalEntered) {
    const clear = clearOf(level, free, th, daysToFloor, cfg) && (!critical || clearOfCritical(free, th, daysToFloor));
    if ((level !== 'ok' || critical) && clear) {
      leaveStreak += 1;
      if (leaveStreak >= 2) { level = raw.level; critical = raw.critical; leaveStreak = 0; }
    } else if (!clear) {
      leaveStreak = 0;
    }
  }
  const ended = wasActive && level === 'ok' && !critical;
  return { level, critical, leaveStreak, rose, criticalEntered, ended };
}

/** §3.4 step 2: the heal worked only when clear of the warn line and of critical. */
export function healCleared(free: number, th: Thresholds, daysToFloor: number | null): boolean {
  return free >= th.warnBelow + th.margin && clearOfCritical(free, th, daysToFloor);
}

export interface CadenceState {
  lastPostAt: number | null;
  /** Repeat stage within the episode (0 = the rising post). */
  stage: number;
  /** Doubling factor for the warn repeat while nothing is clearable. */
  warnBackoff: number;
}

const HOUR = 3_600_000;

/** Repeat interval for the current level (§3.5). */
export function repeatInterval(level: Level, critical: boolean, warnBackoff: number): number {
  if (critical) return 2 * HOUR;
  if (level === 'escalate') return 6 * HOUR;
  return Math.min(24 * HOUR * Math.max(1, warnBackoff), 7 * 24 * HOUR);
}

/** Whether a repeat post is due now (the rising post and recovery are handled by the caller). */
export function repeatDue(c: CadenceState, level: Level, critical: boolean, now: number): boolean {
  if (level === 'ok' && !critical) return false;
  if (c.lastPostAt === null) return true;
  return now - c.lastPostAt >= repeatInterval(level, critical, c.warnBackoff);
}

/** Minimum 1 h between posts, except a rise to escalate or critical (§3.5). */
export function gapAllows(c: CadenceState, now: number, urgentRise: boolean): boolean {
  return urgentRise || c.lastPostAt === null || now - c.lastPostAt >= HOUR;
}

/** Failed-send backoff: 15 min → 30 → 60 → 120 → 240 → 360 (§3.4). */
export function sendRetryDelay(failures: number): number {
  const steps = [15, 30, 60, 120, 240, 360];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1] * 60_000;
}
