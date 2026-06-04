/**
 * ResourceSampler — Phase B of the per-agent ResourceLedger.
 *
 * A background poller (mirrors TokenLedgerPoller) that, on a cadence, samples:
 *   (a) the agent's OWN server process — CPU% via a process.cpuUsage() delta
 *       over the tick interval, and RSS + V8 heapUsed via process.memoryUsage();
 *   (b) the agent's spawned session processes — by their tracked pane PIDs, via
 *       ONE batched `ps -o %cpu=,rss= -p <pid>,<pid>,...` call (tolerating dead
 *       PIDs), so the resource tracker is itself cheap (a single child process
 *       per tick, no per-PID fork storm);
 * and records each plus an `aggregate` (server + all sessions) into the
 * ResourceLedger. After recording it prunes samples beyond the retention window.
 *
 * Discipline (read-only observability, identical to TokenLedgerPoller):
 *   - Strictly off the hot path. A sampling error NEVER throws or crashes — every
 *     OS call and DB write is guarded; a failed tick just records nothing and the
 *     next tick retries.
 *   - It never gates, throttles, or reaches back into any runtime flow. It only
 *     reads `ps`/`process.*` and writes the ledger.
 *   - The timer is unref()'d so it can never keep the process alive on its own,
 *     and backs off while the agent is idle (no running sessions) to keep the
 *     idle CPU floor low (Responsible Resource Usage).
 *
 * Spec: docs/specs/per-agent-resource-ledger.md.
 */
import { execFile } from 'node:child_process';
import type { ResourceLedger, ResourceSampleInput } from './ResourceLedger.js';

export interface ResourceSamplerOptions {
  ledger: ResourceLedger;
  /** Returns the live session pane PIDs to sample, keyed by session id. Called
   *  each tick; an error/empty result just means "no sessions this tick". */
  getSessionPids: () => Array<{ id: string; pid: number }>;
  /** Active sampling cadence (ms). Defaults to 60_000. */
  intervalMs?: number;
  /** Idle sampling cadence (ms) — used when getSessionPids() is empty. Default 5min. */
  idleIntervalMs?: number;
  /** Retention window (ms) — samples older than this are pruned each tick. Default 7d. */
  retentionMs?: number;
  /** Test seam: read this process's CPU usage (microseconds). Defaults to process.cpuUsage. */
  cpuUsageFn?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  /** Test seam: read this process's memory. Defaults to process.memoryUsage. */
  memoryUsageFn?: () => NodeJS.MemoryUsage;
  /** Test seam: monotonic clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Test seam: sample a batch of OS pids. Defaults to a batched `ps` call. */
  samplePidsFn?: (pids: number[]) => Promise<Map<number, { cpuPercent: number; rssBytes: number }>>;
  /** Optional error sink (defaults to a single console.warn). */
  onError?: (err: unknown) => void;
}

export class ResourceSampler {
  private readonly ledger: ResourceLedger;
  private readonly getSessionPids: () => Array<{ id: string; pid: number }>;
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly retentionMs: number;
  private readonly cpuUsageFn: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  private readonly memoryUsageFn: () => NodeJS.MemoryUsage;
  private readonly now: () => number;
  private readonly samplePidsFn: (
    pids: number[],
  ) => Promise<Map<number, { cpuPercent: number; rssBytes: number }>>;
  private readonly onError: (err: unknown) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = false;
  private closed = false;

  // CPU% for the OWN process is a delta: (cpuMicros now - last) / (wallMs * 1000).
  private lastCpu: NodeJS.CpuUsage | null = null;
  private lastCpuAtMs: number | null = null;

  constructor(opts: ResourceSamplerOptions) {
    this.ledger = opts.ledger;
    this.getSessionPids = opts.getSessionPids;
    this.intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 60_000;
    this.idleIntervalMs =
      opts.idleIntervalMs && opts.idleIntervalMs > 0 ? opts.idleIntervalMs : 5 * 60_000;
    this.retentionMs =
      opts.retentionMs && opts.retentionMs > 0 ? opts.retentionMs : 7 * 24 * 60 * 60 * 1000;
    this.cpuUsageFn = opts.cpuUsageFn ?? ((prev) => process.cpuUsage(prev));
    this.memoryUsageFn = opts.memoryUsageFn ?? (() => process.memoryUsage());
    this.now = opts.now ?? (() => Date.now());
    this.samplePidsFn = opts.samplePidsFn ?? ((pids) => samplePidsViaPs(pids));
    this.onError =
      opts.onError ?? ((err) => console.warn('[resource-ledger] sample error:', err));
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    // Prime the CPU baseline so the first real tick has a delta to compare.
    try {
      this.lastCpu = this.cpuUsageFn();
      this.lastCpuAtMs = this.now();
    } catch {
      // @silent-fallback-ok: priming the CPU baseline is best-effort. If cpuUsage
      // is unavailable we leave the baseline null so the first real tick reports
      // 0% rather than crashing the sampler at start.
      this.lastCpu = null;
      this.lastCpuAtMs = null;
    }
    this.schedule(this.intervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Self-rescheduling timer (NOT setInterval) so the cadence can adapt to
   *  idle/active each tick and a slow tick can't stack. unref()'d. */
  private schedule(delayMs: number): void {
    if (!this.started || this.closed) return;
    const t = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  /** Run one sampling pass. Public for tests. Never throws. */
  async tick(): Promise<void> {
    if (this.running) {
      // A previous tick is still in flight (slow `ps`); skip and reschedule.
      this.schedule(this.intervalMs);
      return;
    }
    this.running = true;
    let nextDelay = this.intervalMs;
    try {
      const ts = this.now();
      const samples: ResourceSampleInput[] = [];

      // (a) Own server process — CPU% from the cpuUsage delta over wall time.
      const ownCpuPercent = this.computeOwnCpuPercent(ts);
      let ownRss = 0;
      let ownHeap: number | null = null;
      try {
        const mem = this.memoryUsageFn();
        ownRss = mem.rss;
        ownHeap = mem.heapUsed;
      } catch {
        /* memoryUsage failed — record zero rather than skip the whole tick */
      }
      let aggCpu = ownCpuPercent;
      let aggRss = ownRss;
      samples.push({
        ts,
        source: 'agent-server',
        pid: process.pid,
        cpuPercent: ownCpuPercent,
        rssBytes: ownRss,
        heapUsedBytes: ownHeap,
      });

      // (b) Spawned session processes — one batched ps call for ALL pids.
      let sessions: Array<{ id: string; pid: number }> = [];
      try {
        sessions = this.getSessionPids() ?? [];
      } catch {
        sessions = [];
      }
      if (sessions.length > 0) {
        const pids = sessions
          .map((s) => s.pid)
          .filter((p) => Number.isInteger(p) && p > 0);
        let measured = new Map<number, { cpuPercent: number; rssBytes: number }>();
        if (pids.length > 0) {
          try {
            measured = await this.samplePidsFn(pids);
          } catch {
            measured = new Map();
          }
        }
        for (const s of sessions) {
          const m = measured.get(s.pid);
          if (!m) continue; // dead/unmeasurable pid — tolerate, skip
          aggCpu += m.cpuPercent;
          aggRss += m.rssBytes;
          samples.push({
            ts,
            source: `session:${s.id}`,
            pid: s.pid,
            cpuPercent: m.cpuPercent,
            rssBytes: m.rssBytes,
            heapUsedBytes: null, // heapUsed is only knowable for our own V8
          });
        }
      } else {
        // No running sessions → idle. Back off the cadence to keep the idle
        // CPU floor low (Responsible Resource Usage).
        nextDelay = this.idleIntervalMs;
      }

      // Aggregate = server + all sampled sessions.
      samples.push({
        ts,
        source: 'aggregate',
        pid: 0,
        cpuPercent: +aggCpu.toFixed(2),
        rssBytes: aggRss,
        heapUsedBytes: null,
      });

      this.ledger.recordSamples(samples);

      // Bounded retention — prune off the same cadence (cheap single DELETE).
      try {
        this.ledger.pruneOlderThan(ts - this.retentionMs);
      } catch {
        /* swallow */
      }
    } catch (err) {
      // @silent-fallback-ok: a sampling error NEVER crashes the poller — log once
      // and keep going; the next tick retries. Observability must not break the
      // observed path.
      try { this.onError(err); } catch { /* ignore */ }
    } finally {
      this.running = false;
      this.schedule(nextDelay);
    }
  }

  /**
   * CPU% for THIS process over the interval since the last tick: the
   * (user+system) microseconds consumed divided by the wall-clock microseconds
   * elapsed, ×100. One fully-busy core reads ~100. Returns 0 when there's no
   * prior baseline yet (first tick) or the clock didn't advance.
   */
  private computeOwnCpuPercent(nowMs: number): number {
    let cpu: NodeJS.CpuUsage;
    try {
      cpu = this.cpuUsageFn();
    } catch {
      // @silent-fallback-ok: a CPU reading we can't take degrades to 0% for this
      // tick (read-only observability); it must never throw into the sample loop.
      return 0;
    }
    const prev = this.lastCpu;
    const prevAt = this.lastCpuAtMs;
    this.lastCpu = cpu;
    this.lastCpuAtMs = nowMs;
    if (!prev || prevAt == null) return 0;
    const wallMs = nowMs - prevAt;
    if (wallMs <= 0) return 0;
    const cpuMicros = cpu.user + cpu.system - (prev.user + prev.system);
    const wallMicros = wallMs * 1000;
    const pct = (cpuMicros / wallMicros) * 100;
    return pct > 0 && Number.isFinite(pct) ? +pct.toFixed(2) : 0;
  }
}

/**
 * Batch-sample OS pids with ONE `ps` call. macOS + Linux both support
 * `ps -o %cpu=,rss= -p <pid>[,<pid>...]`; the `=` suffix suppresses headers so
 * the output is just rows of "<cpu> <rss>" aligned with `-p` order... except
 * `ps` reorders by pid, so we ask for pid too and key the result map by pid.
 * rss is reported in KiB → bytes. Dead pids are simply absent from the output
 * (no error). Returns an empty map on any failure (fail-open).
 */
function samplePidsViaPs(
  pids: number[],
): Promise<Map<number, { cpuPercent: number; rssBytes: number }>> {
  return new Promise((resolve) => {
    const out = new Map<number, { cpuPercent: number; rssBytes: number }>();
    if (pids.length === 0) {
      resolve(out);
      return;
    }
    const pidList = pids.join(',');
    execFile(
      'ps',
      ['-o', 'pid=,%cpu=,rss=', '-p', pidList],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        // `ps` exits non-zero when ALL pids are dead; that's not an error for us.
        if (!stdout) {
          resolve(out);
          return;
        }
        for (const line of stdout.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)$/);
          if (!m) continue;
          const pid = Number(m[1]);
          const cpuPercent = Number(m[2]);
          const rssKib = Number(m[3]);
          if (!Number.isFinite(pid)) continue;
          out.set(pid, {
            cpuPercent: Number.isFinite(cpuPercent) && cpuPercent > 0 ? cpuPercent : 0,
            rssBytes: Number.isFinite(rssKib) && rssKib > 0 ? rssKib * 1024 : 0,
          });
        }
        void err; // already tolerated
        resolve(out);
      },
    );
  });
}
