/**
 * The owner-first governor (docs/specs/local-verify-borrowed-unit-slices.md, E "The governor").
 *
 * Every 2 s it reads the owner's load through an injected seam (OwnerLoadReader) and decides how
 * many workers the next slice may use, or that the current work must stop at once. The reserve is
 * a sampled target; the sandbox's fixed CPU and memory size is the hard ceiling.
 *
 * Decision point (judgment-candidate): floor = the sandbox size; reserveCores the sampled target;
 * host memory pressure, deadline, cancel and pause always stop; battery stops unless the owner
 * turned that off; Windows without a fresh owner signal never runs. Conservative default: stop
 * (an unreadable sample stops).
 *
 * Rule 3.1 rationale (state detection: WindowsOwnerSignalReader, MacOwnerLoadReader; registry row in
 * specs/provider-portability/06-state-detector-registry.md):
 * - Criticality: minor-degradation for the owner, never for a verdict. A wrong "busy" only stops
 *   practice work; a wrong "idle" lets a slice run within the sandbox's fixed CPU/memory ceiling, so
 *   the worst case is a slower minute for the owner, capped by the sandbox size. Shadow results never
 *   reach any verdict.
 * - Frequency: per governor tick (2 s) while work runs; every 30 s during a hold-off.
 * - Stability: Windows signal is our own JSON written by our own script (stable, versioned with this
 *   code); the macOS readers parse long-standing system tool output (very stable).
 * - Fallback: any unreadable, malformed or stale sample is "stop" (fail closed toward the owner), and
 *   the sandbox's fixed size is the hard bound whatever the reader says.
 * - Verdict: deterministic, no canary: a format change can only produce "unreadable" (stop) or a
 *   wrong reading inside the hard ceiling; neither touches a verdict or the owner's files.
 *
 * `decideGovernor` is pure. The readers below are the production seams (never run in tests).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { HELPER_LIMITS } from './helperProtocol.js';

const execFileAsync = promisify(execFile);

export type MemoryPressure = 'normal' | 'warn' | 'critical';

export interface OwnerSample {
  /** Host logical CPUs. */
  ncpu: number;
  /** Busy cores on the whole host (0..ncpu). */
  hostBusyCores: number;
  /** Busy cores used by the sandbox itself (VM process on macOS; the helper scope's cpu.stat on Windows). */
  sandboxBusyCores: number;
  memoryPressure: MemoryPressure | null;
  /** True on battery, false on mains or no battery, null unreadable. */
  onBattery: boolean | null;
  /** Windows only: the owner signal file was fresh. Absent on macOS. */
  signalFresh?: boolean;
}

export interface OwnerLoadReader {
  readonly kind: string;
  /** One sample, or null when it could not be taken (which stops). */
  sample(): Promise<OwnerSample | null>;
}

export type GovernorStop =
  | 'paused' | 'cancelled' | 'deadline' | 'memory-pressure' | 'battery' | 'zero-workers' | 'owner-signal-stale' | 'sample-unreadable';

export interface GovernorDecision {
  ownerCores: number | null;
  workersAllowed: number;
  stop: GovernorStop | null;
}

export interface GovernorCtx {
  cpus: number;
  reserveCores: number;
  stopOnBattery: boolean;
  /** The sandbox's memory ceiling on workers (1 per GB, PRACTICE-PHASE DEFAULT). */
  workerCeiling: number;
  now: number;
  deadlineAt: number | null;
  cancelled: boolean;
  paused: boolean;
}

/**
 * Workers allowed = min(cpus, ncpu − reserveCores − ownerCores, memory ceiling), floored at 0,
 * where ownerCores = host busy cores − the sandbox's own busy cores (so the sandbox's load never
 * counts as the owner's, and on Windows Echo's own load does).
 */
export function decideGovernor(s: OwnerSample | null, c: GovernorCtx): GovernorDecision {
  if (c.paused) return { ownerCores: null, workersAllowed: 0, stop: 'paused' };
  if (c.cancelled) return { ownerCores: null, workersAllowed: 0, stop: 'cancelled' };
  if (c.deadlineAt !== null && c.now >= c.deadlineAt) return { ownerCores: null, workersAllowed: 0, stop: 'deadline' };
  if (!s) return { ownerCores: null, workersAllowed: 0, stop: 'sample-unreadable' };
  if (s.signalFresh === false) return { ownerCores: null, workersAllowed: 0, stop: 'owner-signal-stale' };
  const ownerCores = Math.max(0, s.hostBusyCores - s.sandboxBusyCores);
  // Unknown pressure stops (conservative default), like warn or worse.
  if (s.memoryPressure !== 'normal') return { ownerCores, workersAllowed: 0, stop: 'memory-pressure' };
  if (c.stopOnBattery && s.onBattery !== false) return { ownerCores, workersAllowed: 0, stop: 'battery' };
  const byCores = Math.floor(s.ncpu - c.reserveCores - ownerCores);
  const workersAllowed = Math.max(0, Math.min(c.cpus, byCores, c.workerCeiling));
  if (workersAllowed === 0) return { ownerCores, workersAllowed: 0, stop: 'zero-workers' };
  return { ownerCores, workersAllowed, stop: null };
}

/** Stops that also stop the sandbox itself (memory is only returned by stopping the VM). */
export function stopsSandbox(stop: GovernorStop | null): boolean {
  return stop === 'memory-pressure' || stop === 'battery' || stop === 'paused';
}

/**
 * The memory-pressure hold-off: after a pressure stop the helper answers `owner-busy` and does not
 * boot the sandbox until memory has stayed normal for the hold-off. 5 min, doubling on each further
 * pressure stop within the hour, capped at 1 h.
 */
export class PressureHoldOff {
  private stops: number[] = [];
  private normalSince: number | null = null;
  private holdMs = 0;

  noteStop(now: number): void {
    this.stops = [...this.stops.filter((t) => now - t < HELPER_LIMITS.holdOffWindowMs), now];
    this.holdMs = Math.min(HELPER_LIMITS.holdOffMaxMs, HELPER_LIMITS.holdOffStartMs * 2 ** (this.stops.length - 1));
    this.normalSince = null;
  }

  noteSample(pressure: MemoryPressure | null, now: number): void {
    if (pressure === 'normal') { if (this.normalSince === null) this.normalSince = now; }
    else this.normalSince = null;
  }

  /** True while the helper must not boot the sandbox. */
  holding(now: number): boolean {
    if (this.stops.length === 0) return false;
    if (this.normalSince === null) return true;
    return now - this.normalSince < this.holdMs;
  }

  currentHoldMs(): number { return this.holdMs; }
  stopsInWindow(now: number): number { return this.stops.filter((t) => now - t < HELPER_LIMITS.holdOffWindowMs).length; }
}

// ── Windows owner signal (spec E "Windows") ──────────────────────────────

export interface OwnerSignal {
  writtenAtMs: number;
  ncpu: number;
  cpuPercent: number;
  availableMemMb: number;
  totalMemMb: number;
  onBattery: boolean;
  /** Free bytes on the Windows drive holding the helper distro's virtual disk; absent = unknown. */
  helperDriveFreeBytes?: number;
}

export type OwnerSignalRead =
  | { ok: true; signal: OwnerSignal; fresh: boolean }
  | { ok: false; reason: 'missing' | 'malformed' | 'forged-owner' | 'stale' };

/**
 * Parse the owner-signal file written by `scripts/helper/windows-owner-signal.ps1` into Echo's own
 * distro. Fresh = written within 10 s (and not from the future beyond 2 s). `stat` guards against
 * a forged writer: the file must belong to this process's user and not be writable by others.
 */
export function parseOwnerSignal(text: string | null, stat: { uid: number; mode: number } | null, ctx: { now: number; uid: number | null }): OwnerSignalRead {
  if (text === null || stat === null) return { ok: false, reason: 'missing' };
  if ((ctx.uid !== null && stat.uid !== ctx.uid) || (stat.mode & 0o022) !== 0) return { ok: false, reason: 'forged-owner' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'malformed' }; }
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.writer !== 'instar-owner-signal') return { ok: false, reason: 'malformed' };
  const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (!num(r.writtenAtMs, 0, Number.MAX_SAFE_INTEGER) || !num(r.ncpu, 1, 4096) || !num(r.cpuPercent, 0, 100)
    || !num(r.availableMemMb, 0, 1e9) || !num(r.totalMemMb, 1, 1e9) || typeof r.onBattery !== 'boolean') return { ok: false, reason: 'malformed' };
  if (r.helperDriveFreeBytes !== undefined && !num(r.helperDriveFreeBytes, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'malformed' };
  const signal: OwnerSignal = { writtenAtMs: r.writtenAtMs, ncpu: r.ncpu, cpuPercent: r.cpuPercent, availableMemMb: r.availableMemMb, totalMemMb: r.totalMemMb, onBattery: r.onBattery,
    ...(typeof r.helperDriveFreeBytes === 'number' ? { helperDriveFreeBytes: r.helperDriveFreeBytes } : {}) };
  const age = ctx.now - signal.writtenAtMs;
  const fresh = age <= HELPER_LIMITS.windowsSignalStaleMs && age >= -2_000;
  if (!fresh) return { ok: false, reason: 'stale' };
  return { ok: true, signal, fresh };
}

/**
 * Windows memory pressure from available memory: under 10% free warns, under 5% is critical.
 * PRACTICE-PHASE DEFAULT: Windows has no single pressure level like macOS's; the 20-run report
 * re-checks it against the owner's own account.
 */
export function windowsPressure(s: OwnerSignal): MemoryPressure {
  const free = s.availableMemMb / s.totalMemMb;
  return free < 0.05 ? 'critical' : free < 0.10 ? 'warn' : 'normal';
}

/** Windows (helper service in Echo's distro): the owner-signal file plus the helper scope's own CPU. */
export class WindowsOwnerSignalReader implements OwnerLoadReader {
  readonly kind = 'windows-owner-signal';
  constructor(private readonly o: { signalPath: string; sandboxBusyCores: () => Promise<number | null>; now?: () => number }) {}

  async sample(): Promise<OwnerSample | null> {
    const now = (this.o.now ?? Date.now)();
    let text: string | null = null;
    let st: { uid: number; mode: number } | null = null;
    try { const s = await fs.promises.stat(this.o.signalPath); st = { uid: s.uid, mode: s.mode }; text = await fs.promises.readFile(this.o.signalPath, 'utf-8'); } catch { text = null; } // @silent-fallback-ok: a missing signal means the helper does not run
    const read = parseOwnerSignal(text, st, { now, uid: typeof process.getuid === 'function' ? process.getuid() : null });
    if (!read.ok) return read.reason === 'stale' || read.reason === 'missing'
      ? { ncpu: 1, hostBusyCores: 0, sandboxBusyCores: 0, memoryPressure: null, onBattery: null, signalFresh: false }
      : null;
    const sandbox = await this.o.sandboxBusyCores();
    if (sandbox === null) return null;
    const s = read.signal;
    return {
      ncpu: s.ncpu, hostBusyCores: (s.cpuPercent / 100) * s.ncpu, sandboxBusyCores: sandbox,
      memoryPressure: windowsPressure(s), onBattery: s.onBattery, signalFresh: true,
    };
  }
}

/** macOS: host CPU from os.cpus() deltas, the Virtualization XPC process's CPU, kernel pressure level, power source. */
export class MacOwnerLoadReader implements OwnerLoadReader {
  readonly kind = 'macos-host-stats';
  private prev: { idle: number; total: number; at: number } | null = null;
  private readonly cpus: () => os.CpuInfo[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: { exec?: (cmd: string, args: string[]) => Promise<string>; cpus?: () => os.CpuInfo[]; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.cpus = o.cpus ?? (() => os.cpus());
    this.now = o.now ?? (() => Date.now());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  }

  private async run(cmd: string, args: string[]): Promise<string | null> {
    try {
      if (this.o.exec) return await this.o.exec(cmd, args);
      const r = await execFileAsync(cmd, args, { timeout: 1_500, maxBuffer: 1024 * 1024 });
      return r.stdout;
    } catch { return null; } // @silent-fallback-ok: an unreadable figure makes the whole sample unreadable, which stops
  }

  private snapshot(): { idle: number; total: number; at: number; n: number } {
    let idle = 0;
    let total = 0;
    const cpus = this.cpus();
    for (const c of cpus) { idle += c.times.idle; total += c.times.idle + c.times.user + c.times.sys + c.times.nice + c.times.irq; }
    return { idle, total, at: this.now(), n: cpus.length };
  }

  /**
   * Host busy cores NOW: when there is no recent snapshot (the first sample after a start, or the
   * last one is older than 10 s), take a priming snapshot and measure over the next second, so the
   * first sample is a real reading and never an average since minutes ago.
   */
  private async hostBusyCores(): Promise<number | null> {
    if (!this.prev || this.now() - this.prev.at > 10_000) {
      this.prev = this.snapshot();
      await this.sleep(1_000);
    }
    const cur = this.snapshot();
    const prev = this.prev;
    this.prev = cur;
    if (cur.total <= prev.total) return null;
    return (1 - (cur.idle - prev.idle) / (cur.total - prev.total)) * cur.n;
  }

  async sample(): Promise<OwnerSample | null> {
    const host = await this.hostBusyCores();
    const [ps, level, batt] = await Promise.all([
      this.run('ps', ['-A', '-o', '%cpu=,comm=']),
      this.run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      this.run('pmset', ['-g', 'batt']),
    ]);
    if (host === null || ps === null || level === null) return null;
    return {
      ncpu: this.cpus().length,
      hostBusyCores: host,
      sandboxBusyCores: parseVirtualizationCpu(ps),
      memoryPressure: parseMacPressureLevel(level),
      onBattery: batt === null ? null : parsePmsetBattery(batt),
    };
  }
}

/** Busy cores of Apple's Virtualization VM processes, from `ps -A -o %cpu=,comm=`. */
export function parseVirtualizationCpu(ps: string): number {
  let pct = 0;
  for (const line of ps.split('\n')) {
    const m = /^\s*([0-9.]+)\s+(.*)$/.exec(line);
    if (m && /com\.apple\.Virtualization\.VirtualMachine/.test(m[2])) pct += Number(m[1]) || 0;
  }
  return pct / 100;
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseMacPressureLevel(s: string): MemoryPressure | null {
  const n = Number(s.trim());
  return n === 1 ? 'normal' : n === 2 ? 'warn' : n === 4 ? 'critical' : null;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'" vs "'AC Power'". */
export function parsePmsetBattery(s: string): boolean | null {
  if (/'Battery Power'/.test(s)) return true;
  if (/'AC Power'/.test(s)) return false;
  return null;
}

/**
 * Windows host-disk margin (B2): the free space of the Windows drive that holds the helper distro's
 * virtual disk, from a fresh owner signal. Statting from inside Echo's distro would measure Echo's
 * own sparse virtual disk instead, so a signal without the figure (or a stale one) is unknown,
 * which refuses (`host-disk-low`).
 */
export function helperDriveFreeBytesFromSignal(read: OwnerSignalRead): number | null {
  return read.ok && typeof read.signal.helperDriveFreeBytes === 'number' ? read.signal.helperDriveFreeBytes : null;
}

export async function windowsHelperDriveFreeBytes(signalPath: string, now: () => number = Date.now): Promise<number | null> {
  let text: string | null = null;
  let st: { uid: number; mode: number } | null = null;
  try { const s = await fs.promises.stat(signalPath); st = { uid: s.uid, mode: s.mode }; text = await fs.promises.readFile(signalPath, 'utf-8'); } catch { text = null; } // @silent-fallback-ok: no signal is unknown free space, which refuses
  return helperDriveFreeBytesFromSignal(parseOwnerSignal(text, st, { now: now(), uid: typeof process.getuid === 'function' ? process.getuid() : null }));
}
