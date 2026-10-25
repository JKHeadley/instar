/**
 * machineLoadReport — one cached, multi-signal load report per machine and the
 * verdict table that turns it into ok / elevated / saturated / impaired / unknown
 * (trustworthy-machine-load-and-mesh-floor spec, Part B1–B2).
 *
 * Why: the pool used to carry ONE raw load average that flickered (a coarse
 * beat replaced it), compared it across machines with different core counts,
 * and scored an unknown load as the best target. A busy machine, an overloaded
 * one and a dead one all looked alike. This report measures several things on
 * their own, keeps a missing measurement `null` (never a substitute), and
 * carries its own identity + age so a receiver can tell a fresh report from a
 * cached one.
 *
 * REPORTING ONLY (P1): nothing here gates, places or moves anything.
 *
 * Sampling is asynchronous and OUTSIDE the heartbeat path: the sampler refreshes
 * every 15 s and caches; readers get the cache in O(1). The old synchronous
 * `vm_stat` read would have inflated the very event-loop lag it sits next to.
 */

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { parseProcMeminfo, parseVmStat } from '../monitoring/hostMemoryPressure.js';

export type LoadVerdict = 'ok' | 'elevated' | 'saturated' | 'impaired' | 'unknown';
export type NativeMemoryPressure = 'normal' | 'warn' | 'critical';
export type LoadPlatform = 'darwin' | 'linux' | 'wsl' | 'other';

/** The per-machine load report carried on every heartbeat (spec B1). */
export interface MachineLoadReport {
  /** Identity: a per-process boot id + monotonic sequence, so a cached copy is recognizable. */
  bootId: string;
  seq: number;
  /** How old the underlying sample was when the report was SENT, ms. */
  sampleAgeMs: number;
  platform: LoadPlatform;
  cores: number | null;
  totalMemBytes: number | null;
  /** 1-min load average divided by cores. */
  loadPerCore: number | null;
  /** CPU idle %, measured from `os.cpus()` deltas between samples (null on the first sample). */
  cpuIdlePct: number | null;
  /** Available memory % (free + inactive + purgeable on macOS; MemAvailable on Linux). */
  memAvailablePct: number | null;
  /** The OS's own memory-pressure level; null when unreadable. */
  memPressureNative: NativeMemoryPressure | null;
  /** Event-loop lag p99 of this machine's agent server, ms; null when the gauge is absent. */
  eventLoopLagP99Ms: number | null;
  sessionsActive: number | null;
  sessionsMax: number | null;
  /** Existing limiter state: are the host LLM-spawn cap / test-runner cap saturated? */
  spawnCapSaturated: boolean | null;
  testRunnerSaturated: boolean | null;
  /** The machine's OWN verdict over its last samples (B2), for the outside view to compare against. */
  verdict: LoadVerdict;
  /** Seconds since this machine's agent server started (B2 boot grace). */
  uptimeS: number;
}

/** A report older than this is `unknown` however fresh the transport contact (B1). */
export const LOAD_REPORT_MAX_AGE_MS = 60_000;
/** Sampler cadence (B1). */
export const LOAD_SAMPLE_INTERVAL_MS = 15_000;
/** Post-boot/wake grace during which lag alone cannot yield impaired/saturated (B2). */
export const LOAD_BOOT_GRACE_MS = 2 * 60_000;
/** Verdict window: a row matches when ≥2 of the last 3 samples meet it (B2). */
export const VERDICT_WINDOW = 3;
export const VERDICT_QUORUM = 2;

export const LOAD_THRESHOLDS = {
  impairedLagMs: 1000,
  impairedMemAvailPct: 5,
  saturatedCpuIdlePct: 10,
  saturatedLoadPerCore: 1.5,
  saturatedLagMs: 300,
  saturatedMemAvailPct: 15,
} as const;

/** The signals one sample contributes to the verdict (a subset of the report). */
export interface LoadSample {
  atMs: number;
  loadPerCore: number | null;
  cpuIdlePct: number | null;
  memAvailablePct: number | null;
  memPressureNative: NativeMemoryPressure | null;
  eventLoopLagP99Ms: number | null;
  sessionsActive: number | null;
  sessionsMax: number | null;
}

// ── Verdict table (B2, pure) ─────────────────────────────────────────────

function quorum(samples: LoadSample[], pred: (s: LoadSample) => boolean): boolean {
  const window = samples.slice(-VERDICT_WINDOW);
  return window.filter(pred).length >= VERDICT_QUORUM;
}

/** The `saturated` pair-signals, each a predicate over one sample. */
const PAIR_SIGNALS: Array<(s: LoadSample) => boolean> = [
  (s) => s.cpuIdlePct !== null && s.cpuIdlePct < LOAD_THRESHOLDS.saturatedCpuIdlePct,
  (s) => s.loadPerCore !== null && s.loadPerCore > LOAD_THRESHOLDS.saturatedLoadPerCore,
  (s) => s.eventLoopLagP99Ms !== null && s.eventLoopLagP99Ms > LOAD_THRESHOLDS.saturatedLagMs,
  (s) => s.memPressureNative === 'warn' || (s.memAvailablePct !== null && s.memAvailablePct < LOAD_THRESHOLDS.saturatedMemAvailPct),
];

/**
 * Derive the verdict from the last samples (oldest first). Rows top to bottom:
 * a known critical signal yields `impaired` even when other signals are missing;
 * `unknown` applies only when no row matched AND a CPU or memory signal is
 * missing. `inGrace` suppresses impaired/saturated caused ONLY by lag.
 */
export function deriveLoadVerdict(samples: LoadSample[], opts: { inGrace: boolean }): LoadVerdict {
  // A row needs 2 of the last 3 samples (B2): ONE sample can never decide, so
  // the awaited boot sample reports `unknown` rather than a one-reading verdict.
  if (samples.length < VERDICT_QUORUM) return 'unknown';
  const lagImpaired = quorum(samples, (s) => s.eventLoopLagP99Ms !== null && s.eventLoopLagP99Ms > LOAD_THRESHOLDS.impairedLagMs);
  const memImpaired = quorum(
    samples,
    (s) => s.memPressureNative === 'critical' || (s.memAvailablePct !== null && s.memAvailablePct < LOAD_THRESHOLDS.impairedMemAvailPct),
  );
  if (memImpaired || (lagImpaired && !opts.inGrace)) return 'impaired';

  const sessionsFull = quorum(
    samples,
    (s) => s.sessionsActive !== null && s.sessionsMax !== null && s.sessionsMax > 0 && s.sessionsActive >= s.sessionsMax - 1,
  );
  const pairHits = PAIR_SIGNALS.map((p, idx) => ({ idx, hit: quorum(samples, p) })).filter((x) => x.hit);
  // In grace, lag (index 2) does not count toward saturated on its own.
  const effectivePairs = opts.inGrace ? pairHits.filter((x) => x.idx !== 2) : pairHits;
  if (sessionsFull || effectivePairs.length >= 2) return 'saturated';
  if (pairHits.length >= 1) return 'elevated';

  const latest = samples[samples.length - 1];
  const cpuPresent = latest.cpuIdlePct !== null || latest.loadPerCore !== null;
  const memPresent = latest.memAvailablePct !== null || latest.memPressureNative !== null;
  return cpuPresent && memPresent ? 'ok' : 'unknown';
}

// ── Receive clamp + freshness (pure) ─────────────────────────────────────

const VERDICTS: ReadonlySet<string> = new Set(['ok', 'elevated', 'saturated', 'impaired', 'unknown']);
const PRESSURES: ReadonlySet<string> = new Set(['normal', 'warn', 'critical']);
const PLATFORMS: ReadonlySet<string> = new Set(['darwin', 'linux', 'wsl', 'other']);

function numOrNull(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Clamp a peer's load report on receive. Every numeric field is range-checked
 * and anything malformed becomes `null` (missing), never a substituted value.
 * Returns null only when the block is not a usable report at all.
 */
export function clampLoadReport(raw: unknown): MachineLoadReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.bootId !== 'string' || r.bootId.length === 0 || r.bootId.length > 64) return null;
  if (typeof r.seq !== 'number' || !Number.isFinite(r.seq) || r.seq < 0) return null;
  const sampleAgeMs = numOrNull(r.sampleAgeMs, 0, 7 * 24 * 3600_000);
  if (sampleAgeMs === null) return null;
  return {
    bootId: r.bootId,
    seq: Math.floor(r.seq),
    sampleAgeMs,
    platform: typeof r.platform === 'string' && PLATFORMS.has(r.platform) ? (r.platform as LoadPlatform) : 'other',
    cores: numOrNull(r.cores, 1, 4096),
    totalMemBytes: numOrNull(r.totalMemBytes, 1, Number.MAX_SAFE_INTEGER),
    loadPerCore: numOrNull(r.loadPerCore, 0, 10_000),
    cpuIdlePct: numOrNull(r.cpuIdlePct, 0, 100),
    memAvailablePct: numOrNull(r.memAvailablePct, 0, 100),
    memPressureNative: typeof r.memPressureNative === 'string' && PRESSURES.has(r.memPressureNative) ? (r.memPressureNative as NativeMemoryPressure) : null,
    eventLoopLagP99Ms: numOrNull(r.eventLoopLagP99Ms, 0, 3600_000),
    sessionsActive: numOrNull(r.sessionsActive, 0, 100_000),
    sessionsMax: numOrNull(r.sessionsMax, 0, 100_000),
    spawnCapSaturated: boolOrNull(r.spawnCapSaturated),
    testRunnerSaturated: boolOrNull(r.testRunnerSaturated),
    verdict: typeof r.verdict === 'string' && VERDICTS.has(r.verdict) ? (r.verdict as LoadVerdict) : 'unknown',
    uptimeS: numOrNull(r.uptimeS, 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}

/**
 * The receiver's evidence age for a report = its sampleAgeMs + time since
 * receipt (transit is folded into the receipt stamp). Past the max age the
 * report is `unknown` — fresh transport contact never renews stale load
 * evidence (B1).
 */
export function loadReportAgeMs(report: MachineLoadReport, receivedAtMs: number, nowMs: number): number {
  return report.sampleAgeMs + Math.max(0, nowMs - receivedAtMs);
}
export function isLoadReportFresh(report: MachineLoadReport, receivedAtMs: number, nowMs: number): boolean {
  return loadReportAgeMs(report, receivedAtMs, nowMs) <= LOAD_REPORT_MAX_AGE_MS;
}

// ── Native memory pressure readers (async, injectable) ───────────────────

/** macOS `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseDarwinPressureLevel(out: string): NativeMemoryPressure | null {
  const m = out.match(/(\d+)\s*$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 1) return 'normal';
  if (n === 2) return 'warn';
  if (n === 4) return 'critical';
  return null;
}

/** Linux/WSL `/proc/pressure/memory`: `some avg10=…` / `full avg10=…` (percent of time stalled). */
export function parseLinuxPressureFile(content: string): NativeMemoryPressure | null {
  const some = content.match(/^some\s+avg10=([\d.]+)/m);
  const full = content.match(/^full\s+avg10=([\d.]+)/m);
  if (!some && !full) return null;
  const fullV = full ? Number(full[1]) : 0;
  const someV = some ? Number(some[1]) : 0;
  if (fullV >= 10) return 'critical';
  if (someV >= 10) return 'warn';
  return 'normal';
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ''));
    });
  });
}

export function detectLoadPlatform(platform: string = process.platform, osRelease: string = os.release()): LoadPlatform {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return /microsoft|wsl/i.test(osRelease) ? 'wsl' : 'linux';
  return 'other';
}

// ── Sampler ──────────────────────────────────────────────────────────────

export interface MachineLoadSamplerDeps {
  platform?: LoadPlatform;
  cpus?: () => Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
  loadavg?: () => number[];
  totalmem?: () => number;
  /** Async available-memory % reader (null when unreadable). Defaults to the platform reader. */
  readMemAvailablePct?: () => Promise<number | null>;
  readNativePressure?: () => Promise<NativeMemoryPressure | null>;
  /** Event-loop lag p99 (ms) from the existing WriteAdmission gauge; null when absent. */
  eventLoopLagP99Ms?: () => number | null;
  sessions?: () => { active: number | null; max: number | null };
  spawnCapSaturated?: () => boolean | null;
  testRunnerSaturated?: () => boolean | null;
  now?: () => number;
  /** Monotonic ms for sample age + uptime. */
  monoNow?: () => number;
  bootId?: string;
  intervalMs?: number;
  log?: (line: string) => void;
}

/**
 * Samples the signals every `intervalMs` (15 s) and caches ONE report. `read()`
 * is O(1) and never samples. The first sample runs at `start()`, before the
 * first heartbeat (B1).
 */
export class MachineLoadSampler {
  private readonly d: Required<Pick<MachineLoadSamplerDeps, 'platform' | 'cpus' | 'loadavg' | 'totalmem' | 'readMemAvailablePct' | 'readNativePressure' | 'eventLoopLagP99Ms' | 'sessions' | 'spawnCapSaturated' | 'testRunnerSaturated' | 'now' | 'monoNow' | 'bootId' | 'intervalMs'>> & { log?: (line: string) => void };
  private samples: LoadSample[] = [];
  private seq = 0;
  private prevCpu: { idle: number; total: number } | null = null;
  private cached: { report: Omit<MachineLoadReport, 'sampleAgeMs' | 'uptimeS'>; sampledMono: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly startedMono: number;
  private graceUntilMono: number;

  constructor(deps: MachineLoadSamplerDeps = {}) {
    const platform = deps.platform ?? detectLoadPlatform();
    const mono = deps.monoNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.d = {
      platform,
      cpus: deps.cpus ?? (() => os.cpus() as ReturnType<NonNullable<MachineLoadSamplerDeps['cpus']>>),
      loadavg: deps.loadavg ?? (() => os.loadavg()),
      totalmem: deps.totalmem ?? (() => os.totalmem()),
      readMemAvailablePct: deps.readMemAvailablePct ?? (() => defaultReadMemAvailablePct(platform)),
      readNativePressure: deps.readNativePressure ?? (() => defaultReadNativePressure(platform)),
      eventLoopLagP99Ms: deps.eventLoopLagP99Ms ?? (() => null),
      sessions: deps.sessions ?? (() => ({ active: null, max: null })),
      spawnCapSaturated: deps.spawnCapSaturated ?? (() => null),
      testRunnerSaturated: deps.testRunnerSaturated ?? (() => null),
      now: deps.now ?? Date.now,
      monoNow: mono,
      bootId: deps.bootId ?? `${process.pid.toString(36)}-${Date.now().toString(36)}`,
      intervalMs: deps.intervalMs ?? LOAD_SAMPLE_INTERVAL_MS,
      log: deps.log,
    };
    this.startedMono = mono();
    this.graceUntilMono = this.startedMono + LOAD_BOOT_GRACE_MS;
  }

  /** Take the first sample now, then on the cadence. Idempotent. */
  async start(): Promise<void> {
    await this.sampleOnce();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sampleOnce(); }, this.d.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-arm the boot grace (call on wake from sleep). */
  noteWake(): void {
    this.graceUntilMono = this.d.monoNow() + LOAD_BOOT_GRACE_MS;
  }

  private cpuIdleDelta(): number | null {
    let idle = 0;
    let total = 0;
    for (const c of this.d.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    const prev = this.prevCpu;
    this.prevCpu = { idle, total };
    if (!prev) return null;
    const dTotal = total - prev.total;
    if (dTotal <= 0) return null;
    return Math.max(0, Math.min(100, ((idle - prev.idle) / dTotal) * 100));
  }

  /** One sample. Never throws; never overlaps itself. */
  sampleOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSample().catch((err) => {
      this.d.log?.(`load sample failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doSample(): Promise<void> {
    const cpus = safe(() => this.d.cpus(), []);
    const cores = cpus.length > 0 ? cpus.length : null;
    const la = safe(() => this.d.loadavg(), [])[0];
    const loadPerCore = cores && typeof la === 'number' && Number.isFinite(la) ? la / cores : null;
    const cpuIdlePct = safe(() => this.cpuIdleDelta(), null);
    const [memAvailablePct, memPressureNative] = await Promise.all([
      this.d.readMemAvailablePct().catch(() => null),
      this.d.readNativePressure().catch(() => null),
    ]);
    const eventLoopLagP99Ms = safe(() => this.d.eventLoopLagP99Ms(), null);
    const sess = safe(() => this.d.sessions(), { active: null, max: null });
    const atMs = this.d.now();
    const sample: LoadSample = {
      atMs,
      loadPerCore,
      cpuIdlePct,
      memAvailablePct: typeof memAvailablePct === 'number' && Number.isFinite(memAvailablePct) ? Math.max(0, Math.min(100, memAvailablePct)) : null,
      memPressureNative,
      eventLoopLagP99Ms: typeof eventLoopLagP99Ms === 'number' && Number.isFinite(eventLoopLagP99Ms) ? eventLoopLagP99Ms : null,
      sessionsActive: sess.active,
      sessionsMax: sess.max,
    };
    this.samples = [...this.samples, sample].slice(-VERDICT_WINDOW);
    const mono = this.d.monoNow();
    const verdict = deriveLoadVerdict(this.samples, { inGrace: mono < this.graceUntilMono });
    this.cached = {
      sampledMono: mono,
      report: {
        bootId: this.d.bootId,
        seq: this.seq++,
        platform: this.d.platform,
        cores,
        totalMemBytes: safe(() => this.d.totalmem(), null),
        loadPerCore,
        cpuIdlePct: sample.cpuIdlePct,
        memAvailablePct: sample.memAvailablePct,
        memPressureNative,
        eventLoopLagP99Ms: sample.eventLoopLagP99Ms,
        sessionsActive: sess.active,
        sessionsMax: sess.max,
        spawnCapSaturated: safe(() => this.d.spawnCapSaturated(), null),
        testRunnerSaturated: safe(() => this.d.testRunnerSaturated(), null),
        verdict,
      },
    };
  }

  /** The cached report with its CURRENT sample age; null before the first sample. O(1). */
  read(): MachineLoadReport | null {
    if (!this.cached) return null;
    const mono = this.d.monoNow();
    return {
      ...this.cached.report,
      sampleAgeMs: Math.max(0, mono - this.cached.sampledMono),
      uptimeS: Math.max(0, Math.floor((mono - this.startedMono) / 1000)),
    };
  }

  /** The machine's own current verdict (`unknown` before the first sample). */
  verdict(): LoadVerdict {
    return this.cached?.report.verdict ?? 'unknown';
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; } // @silent-fallback-ok: a failed signal read is reported as MISSING (null/fallback), the spec's required behavior — never a substituted value
}

async function defaultReadMemAvailablePct(platform: LoadPlatform): Promise<number | null> {
  try {
    if (platform === 'darwin') {
      const out = await execText('vm_stat', [], 5000);
      return 100 - parseVmStat(out).pressurePercent;
    }
    if (platform === 'linux' || platform === 'wsl') {
      const content = await fsp.readFile('/proc/meminfo', 'utf-8');
      return 100 - parseProcMeminfo(content).pressurePercent;
    }
  } catch {
    // @silent-fallback-ok: an unreadable memory signal is reported as null (missing),
    // never the server-RSS estimate the older reader substituted (spec B1).
  }
  return null;
}

async function defaultReadNativePressure(platform: LoadPlatform): Promise<NativeMemoryPressure | null> {
  try {
    if (platform === 'darwin') {
      return parseDarwinPressureLevel(await execText('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], 3000));
    }
    if (platform === 'linux' || platform === 'wsl') {
      return parseLinuxPressureFile(await fsp.readFile('/proc/pressure/memory', 'utf-8'));
    }
  } catch {
    // @silent-fallback-ok: absent/unreadable native pressure is reported as null (missing).
  }
  return null;
}
