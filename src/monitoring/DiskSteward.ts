/**
 * DiskSteward — every machine watches its own free space (spec docs/specs/disk-steward.md §3).
 *
 * Runs in every agent server process on every machine (standbys included; it is
 * not a scheduled job). Each tick: measure (one statfs), fit growth, step the
 * level machine, run the heal-then-decide cycle when a post may be due, and —
 * on the lease holder only — deliver every machine's due post. Standbys never
 * send; the holder reads their due posts and acknowledges them back.
 *
 * Signals only decide when to clean and when to speak. What may be deleted is
 * fixed in the prune child (two tool caches) and never widened here.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  thresholdsFor, forecast, stepLevel, healCleared, repeatDue, gapAllows, sendRetryDelay,
  type Sample, type LevelState, type CadenceState, type Level, type DiskStewardThresholdConfig, type Forecast, type Thresholds,
} from './diskSteward/levels.js';
import type { PruneChildResult, WorktreePlan } from './diskStewardMain.js';
import type { PruneRequest, RunRecord } from './diskSteward/pruneRunner.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETENTION_MS = 8 * DAY;
const MAX_SAMPLES = 768;

export interface DuePost {
  postId: string;
  machineId: string;
  machineName: string;
  kind: 'alert' | 'recovery' | 'manual';
  level: Level;
  critical: boolean;
  episodeStart: number;
  stage: number;
  createdAt: number;
  free: number;
  total: number;
  change24h: number | null;
  daysToFloor: number | null;
  cleared: Array<{ category: string; bytes: number }>;
  cacheReclaimableBytes: number;
  worktrees?: WorktreePlan;
  reaperArmed: boolean | null;
  biggest?: Array<{ name: string; bytes: number }>;
  sizesAt?: number;
  sizesPartial?: boolean;
  pruneEnabled: boolean;
  cleanupNotHelping: boolean;
  failures: number;
  nextAttemptAt: number;
}

export type SendOutcome = 'posted' | 'failed';

export interface PeerHandle {
  machineId: string;
  /** The peer's GET /disk-steward body, or an error string. */
  status(): Promise<{ ok: true; body: DiskStewardStatus } | { ok: false; error: string }>;
  ack(postId: string, outcome: SendOutcome): Promise<boolean>;
}

export interface DiskStewardDeps {
  machineId: string;
  machineName: () => string;
  agentHome: string;
  stateFile: string;
  now: () => number;
  statfs: () => { free: number; total: number } | null;
  isHolder: () => boolean;
  runner: {
    start(req: PruneRequest): { record: RunRecord; done: Promise<PruneChildResult | null> } | null;
    running(): RunRecord | null;
  };
  pruneEnabled: () => boolean;
  pruneDryRun: () => boolean;
  reaperArmed: () => boolean | null;
  thresholds: () => DiskStewardThresholdConfig;
  pruneMinIntervalMs: () => number;
  peers: () => Promise<PeerHandle[]>;
  send: (post: DuePost) => Promise<SendOutcome>;
  log: (event: Record<string, unknown>) => void;
  degrade: (feature: string, message: string) => void;
  evidence?: (kind: 'fired' | 'error', reason: string) => void;
  /** Optional: an APFS local-snapshot check, true when snapshots exist. */
  hasLocalSnapshots?: () => Promise<boolean>;
}

interface PersistedState {
  v: 1;
  samples: Sample[];
  level: LevelState;
  episodeStart: number | null;
  episodePosted: boolean;
  criticalFirstDone: boolean;
  cadence: CadenceState;
  lastPruneAt: number | null;
  lastPrune: PruneSummary | null;
  breaker: number;
  due: DuePost | null;
  lastPost: { at: number; postId: string; level: Level; critical: boolean } | null;
  sizes?: { at: number; partial: boolean; folders: Array<{ name: string; bytes: number }> };
  worktrees?: WorktreePlan;
  lastMeasureFailedAt?: number | null;
  /** When this episode's last cycle healed the disk without a post. */
  healedAt?: number | null;
}

export interface PruneSummary {
  runId: string;
  at: number;
  trigger: 'auto' | 'manual';
  dryRun: boolean;
  bytesFreed: number;
  observedRecovered: number | null;
  categories: PruneChildResult['categories'];
}

export interface DiskStewardStatus {
  machine: { id: string; name: string };
  level: Level;
  critical: boolean;
  measured: boolean;
  measuredAt: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  thresholds: Thresholds | null;
  forecast: { daysToFloor: number | null; fit24h: Forecast['fit24h'] | null; fit7d: Forecast['fit7d'] | null };
  duePost: DuePost | null;
  lastPost: PersistedState['lastPost'];
  prune: { enabled: boolean; dryRun: boolean; lastRun: PruneSummary | null; running: RunRecord | null; breaker: number };
  sizes: PersistedState['sizes'] | null;
  worktrees: WorktreePlan | null;
}

function emptyState(): PersistedState {
  return {
    v: 1, samples: [], level: { level: 'ok', critical: false, leaveStreak: 0 },
    episodeStart: null, episodePosted: false, criticalFirstDone: false,
    cadence: { lastPostAt: null, stage: 0, warnBackoff: 1 },
    lastPruneAt: null, lastPrune: null, breaker: 0, due: null, lastPost: null,
  };
}

export class DiskSteward {
  private state: PersistedState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleRunning = false;
  private pendingCycle: Promise<unknown> | null = null;
  private ticking = false;
  private lastForecast: Forecast | null = null;
  private lastThresholds: Thresholds | null = null;
  private stateWriteFailed = false;
  private sendFailureReported = false;

  constructor(private readonly deps: DiskStewardDeps) {
    this.state = this.load();
  }

  // ── persistence ──────────────────────────────────────────────────────────

  private load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.deps.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && parsed.v === 1 && Array.isArray(parsed.samples) && parsed.level && parsed.cadence) return parsed;
      this.deps.log({ event: 'state-replaced', reason: 'unrecognized shape' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log({ event: 'state-replaced', reason: e instanceof Error ? e.message : String(e) });
    }
    return emptyState();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.stateFile);
      this.stateWriteFailed = false;
    } catch (e) {
      // A full disk: keep the state in memory and carry on (spec §3.1).
      if (!this.stateWriteFailed) this.deps.log({ event: 'state-write-failed', detail: e instanceof Error ? e.message : String(e) });
      this.stateWriteFailed = true;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start(intervalMs: number, firstDelayMs = 120_000): void {
    if (this.timer) return;
    // @silent-fallback-ok — a failed tick is written to the steward audit (tick-failed) and the next interval retries.
    const run = () => { void this.tick().catch((e) => this.deps.log({ event: 'tick-failed', detail: e instanceof Error ? e.message : String(e) })); };
    this.firstTimer = setTimeout(run, firstDelayMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  // ── the tick ─────────────────────────────────────────────────────────────

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now();
      const m = this.deps.statfs();
      if (!m) {
        if (!this.state.lastMeasureFailedAt) this.deps.degrade('DiskSteward.measure', 'Could not read free disk space on this machine; the disk watcher is skipping its checks until it can.');
        this.state.lastMeasureFailedAt = now;
        return;
      }
      this.state.lastMeasureFailedAt = null;
      this.addSample({ t: now, free: m.free, total: m.total });
      const th = thresholdsFor(m.total, this.deps.thresholds());
      const fc = forecast(this.state.samples, now, th.floor, m.free);
      this.lastForecast = fc;
      this.lastThresholds = th;
      const prevLevel = this.state.level.level;
      const step = stepLevel(this.state.level, m.free, th, fc.daysToFloor, this.deps.thresholds());
      this.state.level = { level: step.level, critical: step.critical, leaveStreak: step.leaveStreak };

      const episodeActive = step.level !== 'ok' || step.critical;
      if ((step.rose || step.criticalEntered) && this.state.episodeStart === null) {
        this.state.episodeStart = now;
        this.state.episodePosted = false;
        this.state.criticalFirstDone = false;
        this.state.cadence = { lastPostAt: this.state.cadence.lastPostAt, stage: 0, warnBackoff: 1 };
        this.state.breaker = 0;
        this.state.healedAt = null;
      }
      if (step.ended) {
        if (this.state.episodePosted) this.queueRecovery(now, m.free, m.total);
        this.state.episodeStart = null;
        this.state.episodePosted = false;
        this.state.criticalFirstDone = false;
        this.state.breaker = 0;
        this.state.cadence.warnBackoff = 1;
        this.state.healedAt = null;
      }

      if (episodeActive && !this.cycleRunning && !this.state.due) {
        const firstCritical = step.criticalEntered && !this.state.criticalFirstDone;
        const urgentRise = (step.rose && step.level === 'escalate') || firstCritical;
        const rising = step.rose || firstCritical;
        const repeat = !rising && this.state.episodePosted && repeatDue(this.state.cadence, step.level, step.critical, now);
        // Healed without a post, but still in the episode once the cleanup interval has passed: try again.
        const unposted = !rising && !this.state.episodePosted && !!this.state.healedAt && now - this.state.healedAt >= this.deps.pruneMinIntervalMs();
        if ((rising || repeat || unposted) && gapAllows(this.state.cadence, now, urgentRise)) {
          if (firstCritical) this.state.criticalFirstDone = true;
          this.pendingCycle = this.cycle({ firstCritical, prevLevel }).catch((e) => this.deps.log({ event: 'cycle-failed', detail: e instanceof Error ? e.message : String(e) }));
        }
      }

      if (this.deps.isHolder()) await this.deliver(now);
    } finally {
      this.persist();
      this.ticking = false;
    }
  }

  private addSample(s: Sample): void {
    const cutoff = s.t - RETENTION_MS;
    this.state.samples = this.state.samples.filter((x) => x.t >= cutoff);
    this.state.samples.push(s);
    if (this.state.samples.length > MAX_SAMPLES) this.state.samples = this.state.samples.slice(-MAX_SAMPLES);
  }

  private change24h(now: number, free: number): number | null {
    const old = this.state.samples.find((x) => x.t >= now - DAY);
    if (!old || now - old.t < 6 * HOUR) return null;
    const recovered = this.state.samples.filter((x) => x.t > old.t).reduce((a, x) => a + (x.recovered ?? 0), 0);
    return (free - recovered) - old.free;
  }

  // ── heal, then decide ────────────────────────────────────────────────────

  /** Spec §3.4. Never throws to the caller. */
  async cycle(opts: { firstCritical: boolean; prevLevel: Level; manual?: { dryRun: boolean; requestedBy?: PruneRequest['requestedBy']; post: boolean } }): Promise<{ runId: string | null }> {
    if (this.cycleRunning) return { runId: null };
    this.cycleRunning = true;
    try {
      const now = this.deps.now();
      const th = this.lastThresholds;
      const free0 = this.state.samples.at(-1)?.free ?? null;
      const enabled = this.deps.pruneEnabled();
      const dueForPrune = this.state.lastPruneAt === null || now - this.state.lastPruneAt >= this.deps.pruneMinIntervalMs() || opts.firstCritical;
      const belowWarn = th !== null && free0 !== null && free0 < th.warnBelow;
      const breakerTripped = this.state.breaker >= 3;
      const wantsMeasure = !this.state.sizes || now - this.state.sizes.at > 6 * HOUR;
      let dryRun: boolean;
      let trigger: 'auto' | 'manual';
      if (opts.manual) { dryRun = opts.manual.dryRun; trigger = 'manual'; }
      else { dryRun = !(enabled && !this.deps.pruneDryRun() && dueForPrune && belowWarn && !breakerTripped); trigger = 'auto'; }
      if (!opts.manual && dryRun && !wantsMeasure && this.state.lastPrune && now - this.state.lastPrune.at < 6 * HOUR) {
        // A recent plan is fresh enough: post from it without another child run.
        this.queueAlert(now, opts.firstCritical);
        return { runId: null };
      }
      const started = this.deps.runner.start({ trigger, dryRun, measure: wantsMeasure || !!opts.manual, requestedBy: opts.manual?.requestedBy ?? null });
      if (!started) { this.deps.log({ event: 'prune-busy' }); if (!opts.manual) this.queueAlert(now, opts.firstCritical); return { runId: null }; }
      this.deps.evidence?.('fired', `${trigger}${dryRun ? ' dry-run' : ''}`);
      const backstop = new Promise<'timeout'>((r) => { const t = setTimeout(() => r('timeout'), 45 * 60_000); t.unref?.(); });
      const outcome = await Promise.race([started.done, backstop]);
      if (outcome === 'timeout') {
        // §3.4: the post goes out at the latency backstop even if the child still runs.
        if (!opts.manual || opts.manual.post || !opts.manual.dryRun) this.queueAlert(this.deps.now(), opts.firstCritical, opts.manual ? 'manual' : 'alert');
        void started.done.then((r) => { if (r) this.recordPrune(r); });
        return { runId: started.record.runId };
      }
      if (outcome) this.recordPrune(outcome);
      else { this.deps.evidence?.('error', 'prune run left no result'); this.deps.log({ event: 'prune-unrecorded', runId: started.record.runId }); }
      const m = this.deps.statfs();
      const after = m ? m.free : free0;
      if (opts.manual) {
        if (!opts.manual.dryRun || opts.manual.post) this.queueAlert(this.deps.now(), false, 'manual');
        return { runId: started.record.runId };
      }
      if (th && after !== null && healCleared(after, th, this.lastForecast?.daysToFloor ?? null)) {
        this.deps.log({ event: 'healed', freeAfter: after, runId: started.record.runId });
        this.state.healedAt = this.deps.now();
        return { runId: started.record.runId };
      }
      this.queueAlert(this.deps.now(), opts.firstCritical);
      return { runId: started.record.runId };
    } finally {
      this.cycleRunning = false;
      this.persist();
    }
  }

  private recordPrune(r: PruneChildResult): void {
    const observed = r.statfsBefore !== null && r.statfsAfter !== null
      ? Math.max(0, Math.min(r.statfsAfter - r.statfsBefore, r.bytesFreed)) : null;
    const total = this.state.samples.at(-1)?.total ?? 0;
    this.state.lastPrune = {
      runId: r.runId, at: r.finishedAt || this.deps.now(), trigger: r.trigger, dryRun: r.dryRun,
      bytesFreed: r.bytesFreed, observedRecovered: observed, categories: r.categories,
    };
    if (!r.dryRun) {
      this.state.lastPruneAt = this.state.lastPrune.at;
      if (observed && this.state.samples.length) {
        const last = this.state.samples[this.state.samples.length - 1];
        last.recovered = (last.recovered ?? 0) + observed;
      }
      if (r.trigger === 'auto') this.state.breaker = total > 0 && r.bytesFreed < 0.01 * total ? this.state.breaker + 1 : 0;
    }
    if (r.sizes) this.state.sizes = r.sizes;
    if (r.worktrees) this.state.worktrees = r.worktrees;
    if (r.categories.some((c) => c.error)) this.deps.evidence?.('error', 'a cleanup category failed');
  }

  private basePost(now: number, kind: DuePost['kind']): DuePost {
    const last = this.state.samples.at(-1);
    const free = last?.free ?? 0;
    const total = last?.total ?? 0;
    const lp = this.state.lastPrune;
    const cleared = lp && !lp.dryRun ? lp.categories.filter((c) => c.bytesFreed > 0).map((c) => ({ category: c.category, bytes: c.bytesFreed })) : [];
    const cacheReclaimableBytes = lp ? lp.categories.reduce((a, c) => a + Math.max(0, c.plannedBytes - c.bytesFreed), 0) : 0;
    return {
      postId: crypto.randomBytes(8).toString('hex'),
      machineId: this.deps.machineId, machineName: this.deps.machineName(),
      kind, level: this.state.level.level, critical: this.state.level.critical,
      episodeStart: this.state.episodeStart ?? now, stage: this.state.cadence.stage, createdAt: now,
      free, total, change24h: this.change24h(now, free), daysToFloor: this.lastForecast?.daysToFloor ?? null,
      cleared, cacheReclaimableBytes,
      ...(this.state.worktrees ? { worktrees: this.state.worktrees } : {}),
      reaperArmed: this.deps.reaperArmed(),
      ...(this.state.sizes ? { biggest: this.state.sizes.folders.slice(0, 3), sizesAt: this.state.sizes.at, sizesPartial: this.state.sizes.partial } : {}),
      pruneEnabled: this.deps.pruneEnabled(),
      cleanupNotHelping: this.state.breaker >= 3,
      failures: 0, nextAttemptAt: now,
    };
  }

  private queueAlert(now: number, _firstCritical: boolean, kind: DuePost['kind'] = 'alert'): void {
    const post = this.basePost(now, kind);
    if (kind === 'alert' && post.level === 'warn' && !post.critical && post.cacheReclaimableBytes < 0.01 * post.total && this.state.episodePosted) {
      // Nothing clearable and nothing changed: the warn repeat backs off (§3.5).
      this.state.cadence.warnBackoff = Math.min(this.state.cadence.warnBackoff * 2, 7);
    }
    this.state.due = post;
  }

  private queueRecovery(now: number, free: number, total: number): void {
    const post = this.basePost(now, 'recovery');
    post.free = free; post.total = total; post.level = 'ok'; post.critical = false;
    this.state.due = post;
  }

  // ── delivery (holder) ────────────────────────────────────────────────────

  /** Apply a send outcome to this machine's own due post (in-process ack or the route). */
  applyAck(postId: string, outcome: SendOutcome): boolean {
    const due = this.state.due;
    if (!due || due.postId !== postId) return false;
    const now = this.deps.now();
    if (outcome === 'posted') {
      this.state.lastPost = { at: now, postId, level: due.level, critical: due.critical };
      this.state.cadence.lastPostAt = now;
      if (due.kind === 'alert') { this.state.episodePosted = true; this.state.cadence.stage += 1; }
      this.state.due = null;
      this.sendFailureReported = false;
    } else {
      due.failures += 1;
      due.nextAttemptAt = now + sendRetryDelay(due.failures);
      // A critical retry gets the next stage, so the gate's pre-delivery episode
      // reservation cannot answer it with episode-dedup (§3.5).
      if (due.critical) due.stage += 1;
      if (due.failures === 4 && !this.sendFailureReported) {
        this.deps.degrade('DiskSteward.post', `The disk-space notice for ${due.machineName} could not be sent after 4 tries; retrying hourly.`);
        this.sendFailureReported = true;
      }
      if (now - due.createdAt > DAY) {
        this.deps.log({ event: 'post-dropped', postId, machineId: due.machineId, reason: 'unsent after 24 h' });
        // Counts as attempted, so the next cadence post (with current numbers) replaces it.
        if (due.kind === 'alert') this.state.episodePosted = true;
        this.state.cadence.lastPostAt = now;
        this.state.due = null;
      }
    }
    this.persist();
    return true;
  }

  /* @self-action-controller: disk-steward */
  private async deliver(now: number): Promise<void> {
    const own = this.state.due;
    if (own && now >= own.nextAttemptAt) {
      const outcome = await this.safeSend(own);
      this.applyAck(own.postId, outcome);
    }
    let peers: PeerHandle[] = [];
    try { peers = await this.deps.peers(); } catch { peers = []; } // @silent-fallback-ok — no peers this tick; they keep their due posts
    for (const peer of peers) {
      if (peer.machineId === this.deps.machineId) continue;
      const st = await peer.status().catch((e) => ({ ok: false as const, error: String(e) }));
      if (!st.ok) continue; // unreachable: its due post waits on the peer
      const due = st.body.duePost;
      if (!due || due.machineId !== peer.machineId || now < due.nextAttemptAt) continue;
      const outcome = await this.safeSend(due);
      await peer.ack(due.postId, outcome).catch(() => false);
    }
  }

  private async safeSend(post: DuePost): Promise<SendOutcome> {
    try { return await this.deps.send(post); }
    catch (e) { this.deps.log({ event: 'send-failed', postId: post.postId, detail: e instanceof Error ? e.message : String(e) }); return 'failed'; } // @silent-fallback-ok — logged; 'failed' drives the retry backoff
  }

  // ── manual and status ────────────────────────────────────────────────────

  /** POST /disk-steward/prune on this machine. */
  manualPrune(req: { dryRun: boolean; post: boolean; requestedBy?: PruneRequest['requestedBy'] }): { started: boolean; running: RunRecord | null; promise?: Promise<{ runId: string | null }> } {
    const running = this.deps.runner.running();
    if (running || this.cycleRunning) return { started: false, running };
    const promise = this.cycle({ firstCritical: false, prevLevel: this.state.level.level, manual: { dryRun: req.dryRun, post: req.post, requestedBy: req.requestedBy } });
    return { started: true, running: null, promise };
  }

  /** Resolves when the cycle started by the last tick has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pendingCycle) { const p = this.pendingCycle; await p; if (this.pendingCycle === p) this.pendingCycle = null; }
  }

  status(): DiskStewardStatus {
    const last = this.state.samples.at(-1) ?? null;
    return {
      machine: { id: this.deps.machineId, name: this.deps.machineName() },
      level: this.state.level.level,
      critical: this.state.level.critical,
      measured: !!last && !this.state.lastMeasureFailedAt,
      measuredAt: last?.t ?? null,
      freeBytes: last?.free ?? null,
      totalBytes: last?.total ?? null,
      thresholds: this.lastThresholds,
      forecast: { daysToFloor: this.lastForecast?.daysToFloor ?? null, fit24h: this.lastForecast?.fit24h ?? null, fit7d: this.lastForecast?.fit7d ?? null },
      duePost: this.state.due,
      lastPost: this.state.lastPost,
      prune: { enabled: this.deps.pruneEnabled(), dryRun: this.deps.pruneDryRun(), lastRun: this.state.lastPrune, running: this.deps.runner.running(), breaker: this.state.breaker },
      sizes: this.state.sizes ?? null,
      worktrees: this.state.worktrees ?? null,
    };
  }

  /** Collect a run finished while the server was down (boot recovery). */
  adoptRecoveredResult(r: PruneChildResult | null | undefined): void {
    if (r) { this.recordPrune(r); this.persist(); }
  }
}
