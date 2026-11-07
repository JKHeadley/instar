/**
 * machineResourceProfile — how big a machine is, how busy it is for its size, and
 * whether it can carry heavy work (docs/specs/resource-aware-placement.md §1).
 *
 * Pure functions over a MachineCapacity row (the same row GET /pool serves). No
 * I/O, no clock beyond what the row already carries.
 *
 * Operator direction (Justin, topic 134088, 2026-11-06): "Heavy Work should not go
 * on the mini. Let's be intelligent about what machines we use based on the machine
 * resource profile and it's current load."
 *
 * Signal vs. authority: `inferWorkWeight` is a brittle pattern match and is
 * SIGNAL-ONLY — it labels a preview and nothing may refuse, move or skip work on
 * its word. The size floor and headroom read measured state (hardware size, the
 * machine's own quorum load verdict) and the operator's per-machine override.
 */

import type { MachineCapacity } from './types.js';
import { LOAD_REPORT_MAX_AGE_MS } from './machineLoadReport.js';

/** How much a piece of work asks of a machine. Absent = `standard`. */
export type WorkWeight = 'light' | 'standard' | 'heavy';
export const WORK_WEIGHTS: readonly WorkWeight[] = ['light', 'standard', 'heavy'];

export function isWorkWeight(v: unknown): v is WorkWeight {
  return typeof v === 'string' && (WORK_WEIGHTS as readonly string[]).includes(v);
}

/**
 * The size a machine needs to be trusted with heavy work, and the per-core load
 * above which a big machine is too busy to take more. Code constants by design
 * (spec Frontloaded Decision 1): the per-machine override is the operator lever.
 */
export const HEAVY_WORK_FLOOR = { minCores: 12, minMemGiB: 32, maxLoadPerCore: 1.0 } as const;

/** A machine's own setting (`multiMachine.placement.heavyWork`), advertised in its load report. */
export type HeavyWorkOverride = 'auto' | 'allow' | 'deny';

export function isHeavyWorkOverride(v: unknown): v is HeavyWorkOverride {
  return v === 'auto' || v === 'allow' || v === 'deny';
}

const GIB = 1024 ** 3;

export interface MachineResourceProfile {
  cores: number | null;
  memGiB: number | null;
  /** Where the size came from. `unknown` = neither the registry hardware nor a load report carries it. */
  source: 'hardware' | 'load-report' | 'unknown';
  /** The machine's own advertised override; null = auto (or older code that cannot advertise it). */
  override: 'allow' | 'deny' | null;
  heavyCapable: boolean;
  reason: 'override-allow' | 'override-deny' | 'meets-floor' | 'below-floor' | 'size-unknown';
}

function posNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Size + override + heavy capability. Unknown size is never heavy-capable (spec Frontloaded Decision 2). */
export function profileOf(m: MachineCapacity): MachineResourceProfile {
  const hwCores = posNum(m.hardware?.cpuCores);
  const hwMem = posNum(m.hardware?.totalMemBytes);
  const rCores = posNum(m.loadReport?.cores);
  const rMem = posNum(m.loadReport?.totalMemBytes);
  const cores = hwCores ?? rCores;
  const memBytes = hwMem ?? rMem;
  const source: MachineResourceProfile['source'] =
    hwCores !== null && hwMem !== null ? 'hardware' : cores !== null && memBytes !== null ? 'load-report' : 'unknown';
  const memGiB = memBytes !== null ? memBytes / GIB : null;
  const raw = m.loadReport?.heavyWork;
  const override = raw === 'allow' || raw === 'deny' ? raw : null;
  const base = { cores, memGiB: memGiB !== null ? Math.round(memGiB * 10) / 10 : null, source, override };
  if (override === 'allow') return { ...base, heavyCapable: true, reason: 'override-allow' };
  if (override === 'deny') return { ...base, heavyCapable: false, reason: 'override-deny' };
  if (cores === null || memGiB === null) return { ...base, heavyCapable: false, reason: 'size-unknown' };
  const meets = cores >= HEAVY_WORK_FLOOR.minCores && memGiB >= HEAVY_WORK_FLOOR.minMemGiB;
  return { ...base, heavyCapable: meets, reason: meets ? 'meets-floor' : 'below-floor' };
}

/** Core count from the best size evidence, or null. */
export function coresOf(m: MachineCapacity): number | null {
  return posNum(m.hardware?.cpuCores) ?? posNum(m.loadReport?.cores);
}

/** The per-core load term is expressed at this many cores, so it stays on the raw-load scale. */
export const LOAD_REFERENCE_CORES = 8;

/** Each heavy item placed in the last PENDING_HEAVY_TTL_MS adds this much per-core load. */
export const PENDING_HEAVY_PER_CORE = 0.5;
export const PENDING_HEAVY_TTL_MS = 3 * 60_000;

/**
 * The row's raw load average, only when it is a finite number >= 0 AND the beat that
 * carried it was received within LOAD_REPORT_MAX_AGE_MS (`routerReceivedAt` is the
 * receipt time of the observation `loadAvg` came from; a coarse beat replaces the
 * observation and drops `loadAvg`). `online` alone does not prove freshness.
 */
function validLoadAvg(m: MachineCapacity, nowMs: number): number | null {
  if (!m.online || typeof m.loadAvg !== 'number' || !Number.isFinite(m.loadAvg) || m.loadAvg < 0) return null;
  // In MachinePoolRegistry rows `loadAvg` and `routerReceivedAt` come from the same
  // observation, so a present receipt older than the window is the stale case. A row
  // with no receipt stamp at all is not a registry observation (a synthetic/caller-
  // built row) and keeps today's reading.
  if (m.routerReceivedAt === undefined) return m.loadAvg;
  const at = typeof m.routerReceivedAt === 'string' ? Date.parse(m.routerReceivedAt) : NaN;
  if (!Number.isFinite(at) || nowMs - at > LOAD_REPORT_MAX_AGE_MS) return null;
  return m.loadAvg;
}

/**
 * Per-core load from FRESH evidence only (never from a stale report): the fresh
 * report's own `loadPerCore`, else `loadAvg / cores` on an online row with a valid
 * load average. Null = not measurable now.
 */
export function freshLoadPerCore(m: MachineCapacity, nowMs: number = Date.now()): number | null {
  const r = m.loadReport;
  const fresh = typeof m.loadReportAgeMs === 'number' && m.loadReportAgeMs <= LOAD_REPORT_MAX_AGE_MS;
  if (r && fresh && typeof r.loadPerCore === 'number' && Number.isFinite(r.loadPerCore) && r.loadPerCore >= 0) {
    return r.loadPerCore;
  }
  const cores = coresOf(m);
  const la = validLoadAvg(m, nowMs);
  if (cores !== null && la !== null) return la / cores;
  return null;
}

/**
 * The load term placement scores with. Per-core load × LOAD_REFERENCE_CORES when
 * measurable (equal to the raw load average of an 8-core machine, so the other
 * weights keep today's relative influence); else a valid raw load average when the
 * core count is unknown (today's value); else null = unmeasured.
 */
export function placementLoad(m: MachineCapacity, pendingHeavy = 0, nowMs: number = Date.now()): number | null {
  const pc = freshLoadPerCore(m, nowMs);
  const extra = Math.max(0, pendingHeavy) * PENDING_HEAVY_PER_CORE;
  if (pc !== null) return (pc + extra) * LOAD_REFERENCE_CORES;
  if (coresOf(m) === null) {
    const la = validLoadAvg(m, nowMs);
    if (la !== null) return la + extra * LOAD_REFERENCE_CORES;
  }
  return null;
}

export type HeavyHeadroom = 'headroom' | 'busy' | 'load-unknown';

/**
 * Can this machine take MORE heavy work right now? `busy` on its own fresh
 * saturated/impaired verdict, or fresh per-core load (plus pending heavy items)
 * above the floor's limit. `load-unknown` when no fresh per-core load exists —
 * never treated as idle.
 */
export function heavyHeadroom(m: MachineCapacity, pendingHeavy = 0, nowMs: number = Date.now()): HeavyHeadroom {
  if (m.loadVerdict === 'saturated' || m.loadVerdict === 'impaired') return 'busy';
  const pc = freshLoadPerCore(m, nowMs);
  if (pc === null) return 'load-unknown';
  return pc + Math.max(0, pendingHeavy) * PENDING_HEAVY_PER_CORE > HEAVY_WORK_FLOOR.maxLoadPerCore ? 'busy' : 'headroom';
}

/** One machine's fit for a heavy item, with the reason in plain tokens. */
export interface MachineFit {
  eligible: boolean;
  reason: 'fits' | 'machine-too-small' | 'machine-busy' | 'load-unknown';
  profile: MachineResourceProfile;
  headroom: HeavyHeadroom;
  loadPerCore: number | null;
}

/**
 * Effective pending heavy items on a machine: the larger of what the decider has
 * reserved and what the machine itself advertises (only from a fresh report).
 */
export function effectivePending(m: MachineCapacity, deciderReserved = 0): number {
  const fresh = typeof m.loadReportAgeMs === 'number' && m.loadReportAgeMs <= LOAD_REPORT_MAX_AGE_MS;
  const adv = fresh && typeof m.loadReport?.heavyPending === 'number' ? m.loadReport.heavyPending : 0;
  return Math.max(0, deciderReserved, adv);
}

/** Fit for a heavy item: heavy-capable AND fresh headroom. Light/standard work is never filtered by size. */
export function heavyFit(m: MachineCapacity, pendingHeavy = 0, nowMs: number = Date.now()): MachineFit {
  const profile = profileOf(m);
  const headroom = heavyHeadroom(m, pendingHeavy, nowMs);
  const loadPerCore = freshLoadPerCore(m, nowMs);
  if (!profile.heavyCapable) return { eligible: false, reason: 'machine-too-small', profile, headroom, loadPerCore };
  if (headroom === 'busy') return { eligible: false, reason: 'machine-busy', profile, headroom, loadPerCore };
  if (headroom === 'load-unknown') return { eligible: false, reason: 'load-unknown', profile, headroom, loadPerCore };
  return { eligible: true, reason: 'fits', profile, headroom, loadPerCore };
}

/**
 * In-memory record of heavy work this process placed recently (spec §1 "Pending
 * heavy work"). Bounded: entries expire after PENDING_HEAVY_TTL_MS and the list is
 * capped. Machine-local by design (a short correction to a hardware reading).
 */
export class PendingHeavyWork {
  private entries: Array<{ machineId: string; at: number; token: number }> = [];
  private seq = 0;
  constructor(private readonly now: () => number = Date.now, private readonly cap = 200) {}
  /** Reserve one heavy item on a machine; returns a token for `release`. */
  record(machineId: string): number {
    this.prune();
    const at = this.now();
    const token = ++this.seq;
    this.entries.push({ machineId, at, token });
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    return token;
  }
  /** Drop a reservation after a DEFINITE failure (a timeout is not definite: keep it to expire). */
  release(token: number): void {
    this.entries = this.entries.filter((e) => e.token !== token);
  }
  count(machineId: string): number {
    this.prune();
    return this.entries.filter((e) => e.machineId === machineId).length;
  }
  private prune(): void {
    const cutoff = this.now() - PENDING_HEAVY_TTL_MS;
    if (this.entries.length && this.entries[0].at < cutoff) this.entries = this.entries.filter((e) => e.at >= cutoff);
  }
}

const HEAVY_PATTERNS: Array<[RegExp, string]> = [
  [/\bxcodebuild\b/, 'xcodebuild'],
  [/\bsimctl\b/, 'simctl'],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::all|:integration|:e2e)?\b(?!\s+\S*\.(?:test|spec)\.)/, 'package test run'],
  [/\b(?:npm|pnpm|yarn)\s+run\s+build\b|\bpnpm\s+build\b/, 'package build'],
  [/\btsc\s+(?:-b|--build)\b/, 'tsc --build'],
  [/\bcargo\s+build\b/, 'cargo build'],
  [/\bgradlew?\b/, 'gradle'],
];

/**
 * A guess at a command's weight. SIGNAL-ONLY: shown in the placement preview; no
 * caller may refuse, move or skip work because of it.
 */
export function inferWorkWeight(command: string): { weight: WorkWeight; matched: string | null } {
  const c = typeof command === 'string' ? command.slice(0, 2000) : '';
  for (const [re, label] of HEAVY_PATTERNS) {
    if (re.test(c)) return { weight: 'heavy', matched: label };
  }
  // vitest with no named test file runs the whole suite; naming files is a targeted run.
  if (/\bvitest\b/.test(c) && !/\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(c)) return { weight: 'heavy', matched: 'vitest (whole suite)' };
  return { weight: 'standard', matched: null };
}

/**
 * This machine's heavy-job gate input (spec §5): its own profile, or null when the
 * gate must not apply — no other online heavy-capable machine is known, so skipping
 * would leave the job nowhere to run (single-machine survivability).
 */
export function selfHeavyJobProfile(
  capacities: MachineCapacity[],
  selfMachineId: string | null,
  selfOverride: unknown,
): { heavyCapable: boolean; reason: string; cores: number | null; memGiB: number | null } | null {
  if (!selfMachineId) return null;
  const self = capacities.find((c) => c.machineId === selfMachineId);
  if (!self) return null;
  const withOverride: MachineCapacity = isHeavyWorkOverride(selfOverride) && selfOverride !== 'auto' && self.loadReport
    ? { ...self, loadReport: { ...self.loadReport, heavyWork: selfOverride } }
    : self;
  const prof = profileOf(withOverride);
  if (prof.heavyCapable) return { heavyCapable: true, reason: prof.reason, cores: prof.cores, memGiB: prof.memGiB };
  const otherCapable = capacities.some((c) => c.machineId !== selfMachineId && c.online && profileOf(c).heavyCapable);
  if (!otherCapable) return null;
  return { heavyCapable: false, reason: prof.reason, cores: prof.cores, memGiB: prof.memGiB };
}
