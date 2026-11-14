/**
 * Wedge detection, dry-run (docs/specs/machine-self-maintenance.md, Part E; CMT-1202).
 *
 * Samples the evidence families on this machine, forms wedge candidates under the
 * window rules in `wedgeWindow.ts`, asks the judge once per candidate, and records
 * what the ladder WOULD have done. It restarts nothing, closes nothing, dismisses
 * nothing and stops no work: no rung exists in this build, and the dependencies
 * below are reads plus two injected calls (the judge and the dry-run notice), each
 * bounded here and gated by the caller.
 *
 * On a shared login only the host maintainer samples and calls the judge
 * (HostMaintenanceStore heartbeat, 10-minute takeover). Its durable state (judge
 * budget, episodes, `forcedDueAt`) lives in the host store so a takeover inherits it.
 * The window itself is in memory: a takeover or a restart starts it fresh, which the
 * gap rule would do anyway.
 *
 * Bounds: one sample at a time; at most one every 2 minutes (every 10 while nothing
 * is positive); each probe has a hard timeout; at most one judge call per wedge
 * condition and `JUDGE_MAX_PER_DAY` per 24 hours; at most one notice per condition,
 * one ordinary and one breaker notice per 24 hours, and the notice is off unless its
 * own flag is on.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { HostMaintenanceStore, WedgeMaintainerClaim } from './HostMaintenanceStore.js';
import type { ProbeResult, ProbeRunner } from './readings.js';
import { consoleSessionFromOwner, readF1, readF2, readF4, type FamilyReading, type LoadReading, type WedgePlatform } from './wedgeEvidence.js';
import {
  CANDIDATE_FAMILIES, JUDGE_ACTIONS, currentCandidate, emptyWindow, isFresh, nextSampleDelay, observe, recentlyRestarted, rungsFor, singleFamilyRun,
  WEDGE_FRESH_MS, WEDGE_MAX_GAP_MS, WEDGE_MIN_OBSERVATIONS, WEDGE_RECENT_BOOT_MS, WEDGE_SAMPLE_IDLE_MS, WEDGE_SAMPLE_POSITIVE_MS, WEDGE_SINGLE_FAMILY_MS, WEDGE_WINDOW_MS,
  type CandidateFamily, type JudgeAction, type Sample, type WindowState,
} from './wedgeWindow.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const JUDGE_MAX_PER_DAY = 6;
export const CANDIDATE_BREAKER_PER_DAY = 3;
const PS_TIMEOUT_MS = 5_000;
const F1_TIMEOUT_MS = 10_000;
const MAX_EPISODES = 20;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** A boot time this much later than the recorded one is a new boot. */
const NEW_BOOT_SLACK_MS = 60_000;

export interface WedgeSettings {
  /** `machineMaintenance.wedgeRestart.dryRun`. Default true. Nothing acts either way in this build. */
  dryRun: boolean;
  /** `machineMaintenance.wedgeRestart.dryRunNotice`. Default false: rung 7's real notice. */
  dryRunNotice: boolean;
}

export function normalizeWedgeSettings(raw: unknown): WedgeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { dryRun: r.dryRun !== false, dryRunNotice: r.dryRunNotice === true };
}

/** What the judge sees: structured evidence only. Never window titles, dialog text or command output. */
export interface WedgeJudgeEvidence {
  pair: string;
  families: Record<string, { result: string; reason: string; ageMinutes: number | null }>;
  windowMinutes: number;
  observations: number;
  uptimeHours: number | null;
  recentlyRestarted: boolean | null;
  sessionsCount: number | null;
  blockers: string[];
}

export type JudgeAnswer = { action: JudgeAction; reason: string } | null;

export interface WedgeNoticeInput {
  episodeId: string;
  machineId: string;
  pair: string;
  reasons: string[];
  proposal: JudgeAction | null;
  recentlyRestarted: boolean | null;
  critical: boolean;
  forcedDueAt: number | null;
}

export type WedgeNoticeOutcome = 'sent' | 'held-by-governor' | 'no-channel' | 'failed' | 'duplicate';

export interface WedgeMonitorDeps {
  agentName: string;
  machineId: () => string;
  platform: WedgePlatform;
  logPath: string;
  store: HostMaintenanceStore;
  /** The feature gate, read live. */
  enabled: () => boolean;
  settings: () => WedgeSettings;
  probe: ProbeRunner;
  readBootAt: () => Promise<number | null>;
  /** The honest lock reading on macOS; null where it is not read. */
  lockState?: () => Promise<string | null>;
  /** macOS: whether the shipped wedge canary can run here (installed, not a test that did not opt in). */
  canaryAvailable?: () => boolean;
  /** macOS: this agent's OS user, compared with the console owner for F1 eligibility. */
  ownUser?: string;
  loadReading: () => LoadReading | null;
  /** Session spawns that failed for system reasons in the last 30 minutes; null when not counted. */
  spawnSystemFailures30m: () => number | null;
  sessionsCount: () => number | null;
  /** The T-0 of the next restart window after `now`. */
  nextWindowRestartAt: (now: number) => number;
  /** The judge (bounded, attributed, provenance-enrolled by the caller). Null: no provider here. */
  judge: ((evidence: WedgeJudgeEvidence) => Promise<JudgeAnswer>) | null;
  /** The dry-run operator notice. Called only when its flag is on. */
  raiseNotice: ((input: WedgeNoticeInput) => Promise<WedgeNoticeOutcome>) | null;
  now?: () => number;
  log?: (line: string) => void;
}

interface EpisodeRecord {
  id: string;
  pair: string;
  openedAt: number;
}

/**
 * One wedge condition: opened by the first candidate after the evidence was last
 * clear, closed only by a real negative observation of one of its families or by a
 * new boot. A server restart or a maintainer takeover starts a fresh window and so
 * a fresh episode, but it is the SAME condition: no second judge call, no second
 * notice. That is what keeps the notice count flat under sustained pressure.
 */
interface WedgeCondition {
  pair: string;
  openedAt: number;
  judgedAt: number | null;
  proposal: JudgeAction | null;
  verdictSource: 'judge' | 'fallback' | null;
  notice: WedgeNoticeOutcome | 'disabled' | 'rate-limited' | 'pending' | null;
  critical: boolean;
}

/** The sampler's durable state, kept in the host store so a takeover inherits it. */
export interface WedgeDurable {
  version: 1;
  bootAt: number | null;
  forcedDueAt: number | null;
  forcedDueReason: string | null;
  f1PassedThisBoot: boolean;
  uninterruptibleCounts: number[];
  judgeCalls: number[];
  /** When each condition opened (7 days kept). Three in 24 h trips the breaker: flapping. */
  candidatesOpened: number[];
  episodes: EpisodeRecord[];
  condition: WedgeCondition | null;
  noticesSent: { normal: number[]; critical: number[] };
  singleFamilyRecorded: string | null;
}

function emptyDurable(): WedgeDurable {
  return {
    version: 1, bootAt: null, forcedDueAt: null, forcedDueReason: null, f1PassedThisBoot: false, uninterruptibleCounts: [],
    judgeCalls: [], candidatesOpened: [], episodes: [], condition: null, noticesSent: { normal: [], critical: [] }, singleFamilyRecorded: null,
  };
}

function validDurable(raw: unknown): raw is WedgeDurable {
  const d = raw as WedgeDurable | null;
  return !!d && d.version === 1 && Array.isArray(d.judgeCalls) && Array.isArray(d.candidatesOpened) && Array.isArray(d.episodes)
    && Array.isArray(d.uninterruptibleCounts) && !!d.noticesSent && Array.isArray(d.noticesSent.normal) && Array.isArray(d.noticesSent.critical);
}

interface HostWedgeFile { durable: WedgeDurable; snapshot: Record<string, unknown>; writtenAt: number; agent: string }

/** Bounds on everything a sample awaits, so a sample always completes and `sampling` resets. */
export const WEDGE_PROBE_GUARD_MS = 2_000;
export const WEDGE_READ_BOUND_MS = 10_000;
export const WEDGE_JUDGE_BOUND_MS = 120_000;
export const WEDGE_NOTICE_BOUND_MS = 60_000;

/** Settles with `fallback` if `p` has not settled within `ms`. Never rejects. */
export function bounded<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
    timer.unref?.();
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } },
    );
  });
}

const NOT_SAMPLED: FamilyReading = { result: 'unknown', reason: 'not-sampled-yet' };

export class WedgeMonitor {
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private sampling = false;
  private role: 'maintainer' | 'observer' | 'unknown' | 'off' = 'unknown';
  private maintainer: string | null = null;
  private generation: number | null = null;
  private durable: WedgeDurable = emptyDurable();
  private window: WindowState = emptyWindow();
  private families: Record<CandidateFamily | 'F3', FamilyReading & { at: number | null }>;
  private lastSample: Sample | null = null;
  private nextSampleAt = 0;
  private lastVerdict: Record<string, unknown> | null = null;
  private samples = 0;
  private lastError: string | null = null;
  private lastTickAt: number | null = null;

  constructor(private readonly deps: WedgeMonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.families = this.freshFamilies();
  }

  private freshFamilies(): WedgeMonitor['families'] {
    const f3: FamilyReading = this.deps.platform === 'linux'
      ? { result: 'not-covered', reason: 'not-applicable-on-linux' }
      : { result: 'not-covered', reason: 'dialog-probe-not-built' };
    return { F1: { ...NOT_SAMPLED, at: null }, F2: { ...NOT_SAMPLED, at: null }, F4: { ...NOT_SAMPLED, at: null }, F3: { ...f3, at: null } };
  }

  /** Heartbeat every 60 s; samples when due. */
  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.first = setTimeout(() => { void this.tick(); }, 45_000);
    this.first.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      this.lastTickAt = this.now();
      if (!this.deps.enabled()) { this.role = 'off'; return; }
      const claim: WedgeMaintainerClaim = this.deps.store.claimWedgeMaintainer(this.deps.agentName);
      if (claim === null) { this.role = 'unknown'; this.maintainer = null; return; }
      if (!claim.self) {
        // Another agent on this login samples. Drop any window this agent held: it must not bridge a gap later.
        if (this.role === 'maintainer') { this.window = emptyWindow(); this.families = this.freshFamilies(); this.lastSample = null; }
        this.role = 'observer';
        this.maintainer = claim.maintainer;
        this.generation = null;
        return;
      }
      if (this.role !== 'maintainer' || claim.tookOver || this.generation !== claim.generation) {
        const host = this.deps.store.readWedgeState<HostWedgeFile>();
        this.durable = host && validDurable(host.durable) ? host.durable : emptyDurable();
        this.window = emptyWindow();
        this.nextSampleAt = 0;
      }
      this.role = 'maintainer';
      this.maintainer = claim.maintainer;
      this.generation = claim.generation;
      if (this.now() < this.nextSampleAt) return;
      await this.sample();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`wedge tick failed: ${this.lastError}`);
    } finally {
      this.sampling = false;
    }
  }

  /**
   * Every probe is bounded here as well as in the runner: a child stuck in the kernel
   * never calls back, and a sample that never completes would stop the heartbeat. A
   * probe that does not answer in time is a timed-out result: evidence, not missing.
   */
  private async runProbe(name: Parameters<ProbeRunner>[0], timeoutMs: number): Promise<ProbeResult> {
    let started: Promise<ProbeResult>;
    try {
      started = this.deps.probe(name, timeoutMs);
    } catch {
      // @silent-fallback-ok — a probe that could not even start reads as unreadable, never as healthy.
      return { ok: false, stdout: null, ms: 0, timedOut: false, code: 'probe-error' };
    }
    const timedOut: ProbeResult = { ok: false, stdout: null, ms: timeoutMs + WEDGE_PROBE_GUARD_MS, timedOut: true, code: 'no-exit' };
    return bounded(started.catch(() => ({ ok: false, stdout: null, ms: 0, timedOut: false, code: 'probe-error' } as ProbeResult)), timeoutMs + WEDGE_PROBE_GUARD_MS, timedOut);
  }

  private async sample(): Promise<void> {
    const platform = this.deps.platform;
    const bootAt = await bounded(this.deps.readBootAt(), WEDGE_READ_BOUND_MS, null);
    const now = this.now();
    if (bootAt !== null && (this.durable.bootAt === null || bootAt > this.durable.bootAt + NEW_BOOT_SLACK_MS)) {
      const wasKnown = this.durable.bootAt !== null;
      // Any boot clears the forced-due mark and the per-boot readings.
      this.durable = { ...this.durable, bootAt, forcedDueAt: null, forcedDueReason: null, f1PassedThisBoot: false, uninterruptibleCounts: [], singleFamilyRecorded: null, condition: null };
      if (wasKnown) { this.window = emptyWindow(); this.audit({ type: 'wedge-new-boot', bootAt }); }
    }

    const mac = platform === 'darwin';
    let canary = false;
    try { canary = mac && this.deps.canaryAvailable?.() === true; } catch { canary = false; } // @silent-fallback-ok — no canary: F1 reads unknown with that reason
    const f1Name = platform === 'linux' ? 'userUnitProbe' as const : platform === 'wsl' ? 'interopProbe' as const : canary ? 'guiCanary' as const : null;
    const [ps, f1Probe, tasklist, lockState, consoleOwner, kernelZone] = await Promise.all([
      this.runProbe('processStates', PS_TIMEOUT_MS),
      f1Name ? this.runProbe(f1Name, F1_TIMEOUT_MS) : Promise.resolve(null),
      platform === 'wsl' ? this.runProbe('windowsTasks', F1_TIMEOUT_MS) : Promise.resolve(null),
      mac && this.deps.lockState ? bounded(this.deps.lockState(), WEDGE_READ_BOUND_MS, null) : Promise.resolve(null),
      canary ? this.runProbe('consoleOwner', PS_TIMEOUT_MS) : Promise.resolve(null),
      mac ? this.runProbe('kernelZone', PS_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    const at = this.now();

    const consoleSession = mac ? consoleSessionFromOwner(consoleOwner, this.deps.ownUser) : null;
    const f1 = readF1({ platform, probe: f1Probe, passedSinceBoot: this.durable.f1PassedThisBoot, lockState, consoleSession });
    if (f1.passed) this.durable.f1PassedThisBoot = true;
    const f2 = readF2({ platform, ps, priorCounts: this.durable.uninterruptibleCounts, tasklist, kernelZone });
    if (f2.count !== null) this.durable.uninterruptibleCounts = [...this.durable.uninterruptibleCounts, f2.count].slice(-3);
    const f4 = readF4({ load: this.deps.loadReading(), spawnSystemFailures30m: this.deps.spawnSystemFailures30m() });

    const previous = this.lastSample;
    this.families = { F1: { ...f1.reading, at }, F2: { ...f2.reading, at }, F4: { ...f4, at }, F3: this.families.F3 };
    const sample: Sample = { at, results: { F1: f1.reading.result, F2: f2.reading.result, F4: f4.result } };
    this.lastSample = sample;
    this.samples += 1;
    this.window = observe(this.window, sample);
    if (!previous || CANDIDATE_FAMILIES.some((f) => previous.results[f] !== sample.results[f])) {
      this.audit({ type: 'wedge-sample', results: sample.results, reasons: { F1: f1.reading.reason, F2: f2.reading.reason, F4: f4.reason } });
    }
    this.nextSampleAt = at + nextSampleDelay(sample);
    const cond = this.durable.condition;
    if (cond && cond.pair.split('+').some((f) => sample.results[f as CandidateFamily] === 'negative')) {
      this.audit({ type: 'wedge-cleared', pair: cond.pair, openedAt: cond.openedAt, results: sample.results });
      this.durable.condition = null;
    }

    await this.considerCandidate(at, bootAt);
    this.considerSingleFamily(at);
    this.publish();
  }

  private prune(at: number): void {
    this.durable.judgeCalls = this.durable.judgeCalls.filter((t) => at - t < DAY);
    this.durable.candidatesOpened = this.durable.candidatesOpened.filter((t) => at - t < 7 * DAY);
  }

  private bringForward(at: number, reason: string): void {
    if (this.durable.forcedDueAt !== null) return;
    this.durable.forcedDueAt = this.deps.nextWindowRestartAt(at);
    this.durable.forcedDueReason = reason;
  }

  private async considerCandidate(at: number, bootAt: number | null): Promise<void> {
    const candidate = currentCandidate(this.window);
    if (!candidate) return;
    const machineId = this.deps.machineId();
    const id = `${machineId}:${candidate.pair}:${candidate.startAt}`;
    this.prune(at);
    const recent = recentlyRestarted(at, bootAt);
    if (!this.durable.episodes.some((e) => e.id === id)) {
      this.durable.episodes = [...this.durable.episodes, { id, pair: candidate.pair, openedAt: at }].slice(-MAX_EPISODES);
      const newCondition = this.durable.condition === null;
      if (newCondition) {
        this.durable.condition = { pair: candidate.pair, openedAt: at, judgedAt: null, proposal: null, verdictSource: null, notice: null, critical: false };
        this.durable.candidatesOpened.push(at);
        // Dry-run: a confirmed candidate reaches the operator rung at once and brings the restart forward.
        this.bringForward(at, `two-family candidate ${candidate.pair}`);
      }
      this.audit({ type: 'wedge-candidate', episodeId: id, pair: candidate.pair, startAt: candidate.startAt, observations: candidate.observations, newCondition, recentlyRestarted: recent, forcedDueAt: this.durable.forcedDueAt });
    }
    const condition = this.durable.condition;
    if (!condition || condition.judgedAt !== null) return;
    const run = this.window.pairs[candidate.pair];
    if (!run || !isFresh(run, at)) return;

    const critical = this.durable.candidatesOpened.filter((t) => at - t < DAY).length >= CANDIDATE_BREAKER_PER_DAY;
    // Unknown boot time caps like a recent restart: a restart that may have just happened is not proposed again.
    const capped = recent !== false;
    let answer: JudgeAnswer = null;
    let fallbackReason: string | null = null;
    if (!this.deps.judge) fallbackReason = 'no-provider';
    else if (this.durable.judgeCalls.length >= JUDGE_MAX_PER_DAY) fallbackReason = 'judge-daily-cap';
    else {
      // Spend the call and close the condition to further calls, durably, BEFORE awaiting it:
      // a crash or takeover mid-call must not ask the judge a second time.
      this.durable.judgeCalls.push(at);
      condition.judgedAt = at;
      this.publish();
      try {
        const evidence = this.evidence(candidate.pair, candidate.observations, candidate.lastObsAt - candidate.startAt, at, bootAt, recent);
        const raw = await bounded<{ answer: JudgeAnswer } | 'error' | 'timeout'>(
          this.deps.judge(evidence).then((a) => ({ answer: a }), () => 'error' as const), WEDGE_JUDGE_BOUND_MS, 'timeout');
        if (raw === 'timeout') fallbackReason = 'judge-timeout';
        else if (raw === 'error') fallbackReason = 'judge-error';
        else {
          answer = raw.answer;
          if (!answer || !JUDGE_ACTIONS.includes(answer.action)) { answer = null; fallbackReason = 'unparseable'; }
        }
      } catch {
        // @silent-fallback-ok — model unavailable: no forced restart; the deterministic fallback is recorded instead.
        fallbackReason = 'judge-error';
      }
    }
    const proposal = answer?.action ?? null;
    const plan = rungsFor(proposal, capped);
    condition.judgedAt = at;
    condition.proposal = proposal;
    condition.verdictSource = answer ? 'judge' : 'fallback';
    condition.critical = critical;
    // Durable before the notice is awaited too: a crash mid-send must not send a second one.
    condition.notice = 'pending';
    this.publish();
    condition.notice = await this.sendNotice(at, { episodeId: id, machineId, pair: candidate.pair, proposal, recent, critical });
    this.lastVerdict = {
      episodeId: id, at, pair: candidate.pair, source: condition.verdictSource, proposal, judgeReason: answer?.reason ?? null, fallbackReason,
      cappedAtNotice: capped, cappedBecause: recent === true ? 'recently-restarted' : recent === null ? 'boot-time-unknown' : null,
      bootTime: bootAt === null ? 'unknown' : bootAt, recentlyRestarted: recent, critical,
      wouldRunRungs: plan.rungs, wouldRunIfStillUp: plan.conditional,
      ranRungs: [], ranReason: 'dry-run: no rung exists in this build',
      floor: { met: false, reasons: ['enrolment-not-built'] },
      forcedDueAt: this.durable.forcedDueAt, notice: condition.notice,
    };
    this.audit({ type: 'wedge-verdict', ...this.lastVerdict });
  }

  /**
   * Rung 7, real only when its own flag is on. One per condition (above), and at most
   * one ordinary and one breaker notice per 24 hours across conditions, so a flapping
   * machine cannot page the operator per flap.
   */
  private async sendNotice(at: number, c: { episodeId: string; machineId: string; pair: string; proposal: JudgeAction | null; recent: boolean | null; critical: boolean }): Promise<WedgeCondition['notice']> {
    const settings = this.deps.settings();
    if (!settings.dryRunNotice || !this.deps.raiseNotice) return 'disabled';
    const sent = this.durable.noticesSent;
    sent.normal = sent.normal.filter((t) => at - t < DAY);
    sent.critical = sent.critical.filter((t) => at - t < DAY);
    if ((c.critical ? sent.critical : sent.normal).length > 0) return 'rate-limited';
    let outcome: WedgeNoticeOutcome;
    try {
      outcome = await bounded<WedgeNoticeOutcome>(this.deps.raiseNotice({
        episodeId: c.episodeId, machineId: c.machineId, pair: c.pair,
        reasons: c.pair.split('+').map((f) => this.families[f as CandidateFamily]?.reason ?? 'unknown'),
        proposal: c.proposal, recentlyRestarted: c.recent, critical: c.critical, forcedDueAt: this.durable.forcedDueAt,
      }), WEDGE_NOTICE_BOUND_MS, 'failed');
    } catch {
      // @silent-fallback-ok — recorded as failed in the verdict row; nothing half-sent is retried here.
      outcome = 'failed';
    }
    if (outcome === 'sent') (c.critical ? sent.critical : sent.normal).push(at);
    return outcome;
  }

  private considerSingleFamily(at: number): void {
    const sf = singleFamilyRun(this.window);
    if (!sf) return;
    const key = `${sf.family}:${sf.run.startAt}`;
    if (this.durable.singleFamilyRecorded === key) return;
    this.durable.singleFamilyRecorded = key;
    this.bringForward(at, `${sf.family} positive for 2 hours`);
    this.audit({ type: 'wedge-single-family', family: sf.family, startAt: sf.run.startAt, observations: sf.run.observations, forcedDueAt: this.durable.forcedDueAt });
  }

  private evidence(pair: string, observations: number, spanMs: number, at: number, bootAt: number | null, recent: boolean | null): WedgeJudgeEvidence {
    const families: WedgeJudgeEvidence['families'] = {};
    for (const f of ['F1', 'F2', 'F3', 'F4'] as const) {
      const r = this.families[f];
      families[f] = { result: r.result, reason: r.reason, ageMinutes: r.at === null ? null : Math.round((at - r.at) / MIN) };
    }
    return {
      pair, families, observations,
      windowMinutes: Math.round(spanMs / MIN),
      uptimeHours: bootAt === null ? null : Math.round(((at - bootAt) / 3_600_000) * 10) / 10,
      recentlyRestarted: recent,
      sessionsCount: this.deps.sessionsCount(),
      blockers: ['enrolment-not-built'],
    };
  }

  private publish(): void {
    if (this.role !== 'maintainer' || this.generation === null) return;
    const file: HostWedgeFile = { durable: this.durable, snapshot: this.localSnapshot(), writtenAt: this.now(), agent: this.deps.agentName };
    if (!this.deps.store.writeWedgeState(this.deps.agentName, this.generation, file)) {
      this.deps.log?.('wedge state not published: this agent is no longer the maintainer');
    }
  }

  private localSnapshot(): Record<string, unknown> {
    const at = this.now();
    const candidate = currentCandidate(this.window);
    const candidates24h = this.durable.candidatesOpened.filter((t) => at - t < DAY).length;
    return {
      platform: this.deps.platform,
      lastSampleAt: this.lastSample?.at ?? null,
      nextSampleAt: this.nextSampleAt || null,
      samples: this.samples,
      families: this.families,
      window: {
        pairs: Object.entries(this.window.pairs).map(([pair, run]) => ({ pair, ...run })),
        singles: Object.entries(this.window.singles).map(([family, run]) => ({ family, ...run })),
      },
      candidate: candidate ? {
        episodeId: `${this.deps.machineId()}:${candidate.pair}:${candidate.startAt}`, ...candidate,
        fresh: isFresh(this.window.pairs[candidate.pair]!, at),
        recentlyRestarted: recentlyRestarted(at, this.durable.bootAt),
      } : null,
      condition: this.durable.condition,
      lastVerdict: this.lastVerdict,
      forcedDueAt: this.durable.forcedDueAt,
      forcedDueReason: this.durable.forcedDueReason,
      bootAt: this.durable.bootAt,
      f1PassedThisBoot: this.durable.f1PassedThisBoot,
      brakes: {
        candidates24h,
        breaker: candidates24h >= CANDIDATE_BREAKER_PER_DAY ? 'critical' : 'normal',
        judgeCalls24h: this.durable.judgeCalls.filter((t) => at - t < DAY).length,
        judgeMaxPerDay: JUDGE_MAX_PER_DAY,
        oneJudgeCallPerCondition: true,
        noticesSent24h: { normal: this.durable.noticesSent.normal.filter((t) => at - t < DAY).length, critical: this.durable.noticesSent.critical.filter((t) => at - t < DAY).length },
      },
      episodes: this.durable.episodes.slice(-5),
    };
  }

  /** `forcedDueAt` for the scheduled-restart planner: the next window is due early. */
  forcedDueAt(): number | null {
    if (this.role === 'maintainer') return this.durable.forcedDueAt;
    const host = this.deps.store.readWedgeState<HostWedgeFile>();
    return host && validDurable(host.durable) ? host.durable.forcedDueAt : null;
  }

  status(): Record<string, unknown> {
    const settings = this.deps.settings();
    const base = {
      enabled: this.deps.enabled(),
      dryRun: settings.dryRun,
      actuation: 'not-built',
      canRestart: false,
      canStopWork: false,
      noticeEnabled: settings.dryRunNotice,
      role: this.role,
      maintainer: this.maintainer,
      rules: {
        windowMinutes: WEDGE_WINDOW_MS / MIN, minObservations: WEDGE_MIN_OBSERVATIONS, maxGapMinutes: WEDGE_MAX_GAP_MS / MIN,
        freshMinutes: WEDGE_FRESH_MS / MIN, singleFamilyMinutes: WEDGE_SINGLE_FAMILY_MS / MIN, recentBootHours: WEDGE_RECENT_BOOT_MS / 3_600_000,
        sampleEveryMinutes: WEDGE_SAMPLE_IDLE_MS / MIN, sampleEveryMinutesWhenPositive: WEDGE_SAMPLE_POSITIVE_MS / MIN,
      },
      limits: [
        'F1 on macOS runs the shipped canary app only; the capture half (one helper frame) and the desktop-grant failure count are not wired.',
        'The macOS canary app is signed with the release identity when one is configured, and is not notarized.',
        'F3 (stuck dialog) is not built; it never forms a candidate in any build.',
        'Enrolment is not built, so the maintainer is whichever gated agent on this login claims first.',
      ],
      auditPath: this.deps.logPath,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
    if (this.role === 'maintainer') return { ...base, snapshotFrom: this.deps.agentName, snapshotAgeMs: 0, ...this.localSnapshot() };
    // An observer shows the maintainer's published state, labelled with its source and age. Absent means unknown.
    const host = this.role === 'observer' ? this.deps.store.readWedgeState<HostWedgeFile>() : null;
    if (host && host.snapshot && typeof host.writtenAt === 'number') {
      return { ...base, snapshotFrom: host.agent ?? null, snapshotAgeMs: Math.max(0, this.now() - host.writtenAt), ...host.snapshot };
    }
    return { ...base, snapshotFrom: null, snapshotAgeMs: null, lastSampleAt: null, families: null, candidate: null, condition: null, lastVerdict: null, forcedDueAt: null };
  }

  private audit(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      try {
        if (fs.statSync(this.deps.logPath).size > MAX_LOG_BYTES) fs.renameSync(this.deps.logPath, `${this.deps.logPath}.1`);
      } catch { /* @silent-fallback-ok — no log yet */ }
      fs.appendFileSync(this.deps.logPath, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), agent: this.deps.agentName, machineId: this.deps.machineId(), feature: 'wedge', dryRun: true, ...row })}\n`);
    } catch (err) {
      this.deps.log?.(`wedge audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let active: WedgeMonitor | null = null;
export function setActiveWedgeMonitor(m: WedgeMonitor | null): void { active = m; }
export function getActiveWedgeMonitor(): WedgeMonitor | null { return active; }
