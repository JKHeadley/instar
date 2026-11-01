/**
 * Scheduled restart planner (docs/specs/machine-self-maintenance.md, Part D).
 *
 * Pure: time, window and delay arithmetic only, with no I/O. A scheduled restart
 * is a commitment with a time, and work yields to it. This module answers when
 * that time is, which drain phase is due, and what the closed delay list does to
 * it. Increment 1 uses it on paper only: nothing here can reach a machine.
 */

export interface RestartWindow { start: string; end: string }

export interface MachineMaintenanceSettings {
  cadenceDays: number;
  window: RestartWindow;
  maxIntervalDays: number;
  maxEpisodeDelayMinutes: number;
}

export const DEFAULT_MACHINE_MAINTENANCE: MachineMaintenanceSettings = {
  cadenceDays: 7,
  window: { start: '03:00', end: '06:00' },
  maxIntervalDays: 10,
  maxEpisodeDelayMinutes: 120,
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** T-0 sits this long after the window opens. */
export const RESTART_OFFSET_MINUTES = 60;
export const DELAY_STEP_MINUTES = 5;

function parseClock(s: unknown): { h: number; m: number } | null {
  if (typeof s !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

function windowLengthMinutes(w: RestartWindow): number | null {
  const a = parseClock(w.start);
  const b = parseClock(w.end);
  if (!a || !b) return null;
  const start = a.h * 60 + a.m;
  const end = b.h * 60 + b.m;
  return end > start ? end - start : end + 24 * 60 - start;
}

/** Settings from a live config block. Out-of-range values fall back, never throw. */
export function normalizeSettings(raw: Partial<MachineMaintenanceSettings> | undefined | null): MachineMaintenanceSettings {
  const d = DEFAULT_MACHINE_MAINTENANCE;
  const cadence = Number(raw?.cadenceDays);
  const cadenceDays = Number.isFinite(cadence) && cadence >= 5 && cadence <= 30 ? cadence : d.cadenceDays;
  const interval = Number(raw?.maxIntervalDays);
  const maxIntervalDays = Number.isFinite(interval) && interval >= cadenceDays + 1 ? interval : Math.max(d.maxIntervalDays, cadenceDays + 1);
  const ceiling = Number(raw?.maxEpisodeDelayMinutes);
  const maxEpisodeDelayMinutes = Number.isFinite(ceiling) && ceiling >= 0 ? ceiling : d.maxEpisodeDelayMinutes;
  const candidate = raw?.window;
  const length = candidate ? windowLengthMinutes(candidate) : null;
  // The window must hold T-0, which sits an hour after it opens, plus an hour of slack.
  const window = candidate && length !== null && length >= 120 ? { start: candidate.start, end: candidate.end } : d.window;
  return { cadenceDays, window, maxIntervalDays, maxEpisodeDelayMinutes };
}

export interface PlannedWindow { start: number; end: number; restartAt: number }

/** The window a moment belongs to: the one in progress, else the next, in machine-local time. */
export function windowFor(now: number, window: RestartWindow): PlannedWindow {
  const a = parseClock(window.start) ?? parseClock(DEFAULT_MACHINE_MAINTENANCE.window.start)!;
  const length = windowLengthMinutes(window) ?? 180;
  const at = (dayOffset: number): PlannedWindow => {
    const base = new Date(now);
    base.setDate(base.getDate() + dayOffset);
    base.setHours(a.h, a.m, 0, 0);
    const start = base.getTime();
    return { start, end: start + length * MIN, restartAt: start + RESTART_OFFSET_MINUTES * MIN };
  };
  // A window crossing midnight can have started yesterday.
  for (const offset of [-1, 0, 1]) {
    const w = at(offset);
    if (now < w.end) return w;
  }
  return at(2);
}

export function uptimeDays(now: number, lastBootAt: number): number {
  return (now - lastBootAt) / DAY;
}

export function isDue(now: number, lastBootAt: number, cfg: MachineMaintenanceSettings): boolean {
  return uptimeDays(now, lastBootAt) >= cfg.cadenceDays;
}

/** The final night: the machine has reached the point where the owner gets the question. */
export function isFinalNight(now: number, lastBootAt: number, cfg: MachineMaintenanceSettings): boolean {
  return uptimeDays(now, lastBootAt) >= cfg.maxIntervalDays - 1;
}

export type DrainPhaseId = 'reserve' | 'announce' | 'move' | 'checkpoint' | 'cancel' | 'pause' | 'receipts' | 'restart';

/** The drain sequence. Each phase runs when due and does not wait for the one before. */
export const DRAIN_PHASES: ReadonlyArray<{ id: DrainPhaseId; offsetMinutes: number; wouldDo: string }> = [
  { id: 'reserve', offsetMinutes: 70, wouldDo: 'reserve the episode and claim the slot from pool peers' },
  { id: 'announce', offsetMinutes: 60, wouldDo: 'publish the drain record, take the census, close the gate to new long work, send the notice' },
  { id: 'move', offsetMinutes: 45, wouldDo: 'hand off the serving lease, offer the Local Verify queue, move recent conversations' },
  { id: 'checkpoint', offsetMinutes: 20, wouldDo: 'tell every session to stop at its next boundary, mark autonomous runs and jobs suspended' },
  { id: 'cancel', offsetMinutes: 10, wouldDo: 'cancel Local Verify runs and test suites, close the gate to all automatic work' },
  { id: 'pause', offsetMinutes: 5, wouldDo: 'interrupt sessions not yet at a boundary, end script jobs, read yields back' },
  { id: 'receipts', offsetMinutes: 2, wouldDo: 'enqueue resume entries and check receipts' },
  { id: 'restart', offsetMinutes: 0, wouldDo: 'arm, run the fresh check, restart' },
];

export function phaseTime(restartAt: number, offsetMinutes: number): number {
  return restartAt - offsetMinutes * MIN;
}

/** The latest phase due at `now` for this T-0, or null before the first one. */
export function currentPhase(now: number, restartAt: number): DrainPhaseId | null {
  let found: DrainPhaseId | null = null;
  for (const phase of DRAIN_PHASES) if (now >= phaseTime(restartAt, phase.offsetMinutes)) found = phase.id;
  return found;
}

export type DelayId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7';
export type SafetyHoldId = 'S1' | 'S2' | 'S3' | 'S4';

/** The closed delay list. Anything not here does not move T-0. */
export const DELAYS: Record<DelayId, { label: string; maxMinutes: number; atMax: 'roll' | 'proceed'; passedOnFinalNight: boolean }> = {
  D1: { label: 'Owner at this machine', maxMinutes: 60, atMax: 'roll', passedOnFinalNight: true },
  D2: { label: 'Work with no resume path', maxMinutes: 60, atMax: 'roll', passedOnFinalNight: true },
  D3: { label: 'Agent not answering', maxMinutes: 30, atMax: 'roll', passedOnFinalNight: true },
  D4: { label: 'Short critical step', maxMinutes: 30, atMax: 'proceed', passedOnFinalNight: false },
  D5: { label: 'Lease will not hand off', maxMinutes: 30, atMax: 'proceed', passedOnFinalNight: false },
  D6: { label: 'Another pool machine restarting', maxMinutes: 90, atMax: 'roll', passedOnFinalNight: true },
  D7: { label: 'Unsaved input in an owned browser', maxMinutes: 30, atMax: 'roll', passedOnFinalNight: true },
};

export function isDelayId(v: unknown): v is DelayId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DELAYS, v);
}

export interface DelayStepInput {
  restartAt: number;
  originalRestartAt: number;
  windowEnd: number;
  used: Partial<Record<DelayId, number>>;
  /** Unvalidated: an id outside the closed list is dropped and returned in `refused`. */
  active: readonly string[];
  final: boolean;
  maxEpisodeDelayMinutes: number;
}

export interface DelayStepResult {
  restartAt: number;
  used: Partial<Record<DelayId, number>>;
  /** hold: T-0 moved. clear: nothing holds it. roll: the episode closes for the night. */
  outcome: 'hold' | 'clear' | 'roll';
  holdingDelays: DelayId[];
  rollBecause: DelayId | null;
  refused: string[];
}

/**
 * One five-minute step of the closed delay list. An active delay holds T-0 until
 * it reaches its maximum, which then rolls or proceeds as its row says. Reaching
 * the total ceiling or the window's end does the same with whatever is active,
 * and when several are active, one that rolls wins. On the final night the listed
 * delays proceed at their maximum instead of rolling.
 */
export function stepDelays(input: DelayStepInput): DelayStepResult {
  const refused = input.active.filter((id) => !isDelayId(id));
  const active = [...new Set(input.active.filter(isDelayId))];
  const used = { ...input.used };
  const rolls = (id: DelayId): boolean => DELAYS[id].atMax === 'roll' && !(input.final && DELAYS[id].passedOnFinalNight);

  for (const id of active) used[id] = (used[id] ?? 0) + DELAY_STEP_MINUTES;
  const exhausted = active.filter((id) => (used[id] ?? 0) > DELAYS[id].maxMinutes);
  const holding = active.filter((id) => !exhausted.includes(id));

  const firstRoll = (ids: DelayId[]): DelayId | null => ids.find(rolls) ?? null;
  const roll = (because: DelayId): DelayStepResult => ({ restartAt: input.restartAt, used, outcome: 'roll', holdingDelays: [], rollBecause: because, refused });

  const atMaximum = firstRoll(exhausted);
  if (atMaximum) return roll(atMaximum);
  if (holding.length === 0) return { restartAt: input.restartAt, used, outcome: 'clear', holdingDelays: [], rollBecause: null, refused };

  const next = input.restartAt + DELAY_STEP_MINUTES * MIN;
  const overCeiling = next - input.originalRestartAt > input.maxEpisodeDelayMinutes * MIN;
  if (overCeiling || next > input.windowEnd) {
    const atCeiling = firstRoll(holding);
    if (atCeiling) return roll(atCeiling);
    return { restartAt: input.restartAt, used, outcome: 'clear', holdingDelays: [], rollBecause: null, refused };
  }
  return { restartAt: next, used, outcome: 'hold', holdingDelays: holding, rollBecause: null, refused };
}
