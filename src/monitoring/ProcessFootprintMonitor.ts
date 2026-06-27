/**
 * ProcessFootprintMonitor — the per-machine process-footprint measurement that
 * was MISSING when steady-state process accumulation (multiple full agent stacks
 * + their heavy MCP servers — a whole Chromium, an Electron) climbed unwatched
 * until the host hit a kernel limit and panicked (2026-06-26, os_refcnt overflow).
 *
 * The host spawn-cap bounds INSTANTANEOUS spawn bursts; the idle-session reapers
 * bound idle SESSIONS. Neither MEASURES the slow climb of the total process count.
 * This monitor does exactly that and nothing more: on an interval it counts the
 * instar-relevant processes on this machine, classifies them (agent CLIs vs MCP
 * servers vs other node), keeps a bounded rolling window so a TREND is visible,
 * and — only when explicitly enabled — raises ONE de-duplicated heads-up when the
 * count crosses a threshold. It is OBSERVE-ONLY: it never kills, throttles, or
 * gates anything (the reapers own reclamation). Ships DARK by default.
 *
 * Pure core: all process input is injected (`listProcesses`) so the classifier and
 * trend logic are unit-testable without scanning the real host.
 */

import { execFileSync } from 'node:child_process';
import { MCP_PROCESS_SIGNATURES } from './mcpProcessSignatures.js';
import { withSyncOp } from '../core/InFlightSyncOpMarker.js';

/** A live process as seen by the scanner (only the fields we classify on). */
export interface FootprintProcess {
  pid: number;
  /** Full command line (argv joined) — matched against signatures/patterns. */
  command: string;
  /** Resident set size in bytes (0 if unknown). */
  rssBytes: number;
}

export type FootprintKind = 'agent-cli' | 'mcp' | 'other-node';

/** One point-in-time footprint reading. */
export interface FootprintSample {
  ts: number;
  /** Total instar-relevant processes counted. */
  total: number;
  byKind: Record<FootprintKind, number>;
  /** Summed RSS of the counted processes. */
  rssBytes: number;
}

export interface ProcessFootprintMonitorConfig {
  /** Master switch — DARK by default. When false, start() is a no-op. */
  enabled: boolean;
  sampleIntervalMs: number;
  /** Ring-buffer size (how many samples of history to keep for the trend). */
  windowSamples: number;
  /**
   * Total-process count at/above which a heads-up is raised. 0 disables the alert
   * regardless of `alertEnabled`. The alert is observe-only (one attention item).
   */
  alertThreshold: number;
  /** Alert is opt-in even when the monitor is enabled (measure first). */
  alertEnabled: boolean;
}

export const DEFAULT_PROCESS_FOOTPRINT_MONITOR_CONFIG: ProcessFootprintMonitorConfig = {
  enabled: false, // DARK by default (observe-only, but no reason to sample on the fleet yet)
  sampleIntervalMs: 5 * 60 * 1000,
  windowSamples: 288, // 24h at 5-min cadence
  alertThreshold: 220, // the panic snapshot showed ~280 node refs; warn well before
  alertEnabled: false, // opt-in: measure before paging
};

export interface ProcessFootprintMonitorDeps {
  /** Returns the instar-relevant processes on this machine. Injected for tests. */
  listProcesses: () => FootprintProcess[];
  now?: () => number;
  /** Observe-only heads-up sink (the attention queue). Absent ⇒ alert is inert. */
  emitAttention?: (item: { id: string; title: string; body: string }) => void;
}

/**
 * Production scanner: enumerate the host's processes via `ps`. Returns [] on any
 * failure (fail-safe — a missing reading must never crash the monitor). The scan
 * is off-hot-path (the monitor samples on a multi-minute interval, ships dark) and
 * funnels through withSyncOp so the in-flight marker sees the blocking spawn.
 */
export function defaultListProcesses(): FootprintProcess[] {
  let out: string;
  try {
    // lint-allow-blocking-scan: off-hot-path (multi-minute sampling interval, dark
    // by default), bounded 15s timeout — same posture as the AgentWorktreeReaper's
    // lsof scan. The monitor only READS process metadata; it never kills or gates.
    out = withSyncOp(() => execFileSync('ps', ['-A', '-o', 'pid=,rss=,command='], {
      encoding: 'utf-8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
    }));
  } catch {
    return []; // @silent-fallback-ok — no ps reading ⇒ no sample (keeps last)
  }
  const procs: FootprintProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), rssBytes: Number(m[2]) * 1024 /* ps rss is KB */, command: m[3] });
  }
  return procs;
}

/** Classify a single process. Returns null for processes we don't count. */
export function classifyFootprintProcess(p: FootprintProcess): FootprintKind | null {
  const cmd = (p.command || '').toLowerCase();
  if (!cmd) return null;
  // MCP servers — the heavy, mostly-idle ones (Chromium for Playwright, Electron,
  // mcp-remote bridges). Matched via the SAME allow-listed signatures the reaper uses.
  for (const sig of MCP_PROCESS_SIGNATURES) {
    if (sig.commandIncludesAll.every((needle) => cmd.includes(needle.toLowerCase()))) {
      return 'mcp';
    }
  }
  // Agent CLIs — the per-session reasoning processes.
  if (/\b(claude|codex|gemini)\b/.test(cmd) && !cmd.includes('grep')) return 'agent-cli';
  // Other instar node processes (servers, lifelines, MCP wrappers not matched above).
  if (/\bnode\b/.test(cmd) || cmd.includes('/.instar/') || cmd.includes('instar/dist')) return 'other-node';
  return null;
}

/** Build a footprint sample from a process list (pure). */
export function buildFootprintSample(procs: FootprintProcess[], ts: number): FootprintSample {
  const byKind: Record<FootprintKind, number> = { 'agent-cli': 0, mcp: 0, 'other-node': 0 };
  let total = 0;
  let rssBytes = 0;
  for (const p of procs) {
    const kind = classifyFootprintProcess(p);
    if (!kind) continue;
    byKind[kind]++;
    total++;
    rssBytes += Math.max(0, p.rssBytes || 0);
  }
  return { ts, total, byKind, rssBytes };
}

export interface FootprintStatus {
  enabled: boolean;
  latest: FootprintSample | null;
  /** Direction over the window: rising if the latest exceeds the window median by
   *  a margin, falling if below, else stable. Coarse on purpose. */
  trend: 'rising' | 'stable' | 'falling' | 'insufficient-data';
  windowSize: number;
  alertThreshold: number;
  alertEnabled: boolean;
  /** True while the most recent sample is at/over the threshold. */
  overThreshold: boolean;
  samples: FootprintSample[];
}

export class ProcessFootprintMonitor {
  private readonly cfg: ProcessFootprintMonitorConfig;
  private readonly deps: ProcessFootprintMonitorDeps;
  private readonly now: () => number;
  private ring: FootprintSample[] = [];
  private timer?: NodeJS.Timeout;
  /** Per-episode alert latch: one heads-up per threshold-crossing episode. */
  private alerted = false;

  constructor(deps: ProcessFootprintMonitorDeps, cfg?: Partial<ProcessFootprintMonitorConfig>) {
    this.deps = deps;
    this.cfg = { ...DEFAULT_PROCESS_FOOTPRINT_MONITOR_CONFIG, ...(cfg ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || !this.cfg.enabled) return;
    this.sample(); // one immediate reading
    this.timer = setInterval(() => this.sample(), this.cfg.sampleIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Take one reading (also callable directly in tests). Returns the sample. */
  sample(): FootprintSample {
    let procs: FootprintProcess[];
    try { procs = this.deps.listProcesses(); }
    catch { return this.ring[this.ring.length - 1] ?? buildFootprintSample([], this.now()); } // fail-safe: keep last
    const s = buildFootprintSample(procs, this.now());
    this.ring.push(s);
    while (this.ring.length > this.cfg.windowSamples) this.ring.shift();
    this.maybeAlert(s);
    return s;
  }

  private maybeAlert(s: FootprintSample): void {
    if (!this.cfg.alertEnabled || this.cfg.alertThreshold <= 0) return;
    if (s.total >= this.cfg.alertThreshold) {
      if (!this.alerted && this.deps.emitAttention) {
        this.alerted = true; // one per episode
        this.deps.emitAttention({
          id: 'process-footprint:over-threshold',
          title: `Process footprint high (${s.total} processes)`,
          body: `This machine is running ${s.total} instar-relevant processes ` +
            `(${s.byKind['agent-cli']} agent CLIs, ${s.byKind.mcp} MCP servers, ` +
            `${s.byKind['other-node']} other node) — at/over the ${this.cfg.alertThreshold} ` +
            `heads-up threshold. Steady-state process accumulation is the footprint that ` +
            `preceded the resource-exhaustion panic; consider offloading idle MCP servers ` +
            `or consolidating agent stacks.`,
        });
      }
    } else if (s.total < this.cfg.alertThreshold * 0.9) {
      this.alerted = false; // re-arm with hysteresis once it recovers
    }
  }

  private computeTrend(): FootprintStatus['trend'] {
    if (this.ring.length < 4) return 'insufficient-data';
    const totals = this.ring.map((s) => s.total).slice().sort((a, b) => a - b);
    const median = totals[Math.floor(totals.length / 2)];
    const latest = this.ring[this.ring.length - 1].total;
    const margin = Math.max(2, Math.ceil(median * 0.15));
    if (latest >= median + margin) return 'rising';
    if (latest <= median - margin) return 'falling';
    return 'stable';
  }

  status(): FootprintStatus {
    return {
      enabled: this.cfg.enabled,
      latest: this.ring[this.ring.length - 1] ?? null,
      trend: this.computeTrend(),
      windowSize: this.ring.length,
      alertThreshold: this.cfg.alertThreshold,
      alertEnabled: this.cfg.alertEnabled,
      overThreshold: (this.ring[this.ring.length - 1]?.total ?? 0) >= this.cfg.alertThreshold && this.cfg.alertThreshold > 0,
      samples: this.ring.slice(),
    };
  }
}
