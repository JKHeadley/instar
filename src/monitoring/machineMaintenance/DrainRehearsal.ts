/**
 * The watch-only drain (docs/specs/machine-self-maintenance.md, Maturation plan).
 *
 * Every night, due or not, every development agent on a host runs the drain on
 * paper against a real T-0 and writes down what it would have done. It stops
 * nothing, refuses nothing and sends no notice. Its output is the evidence that
 * decides whether the real drain can be trusted: how long each kind of work really
 * takes to reach its own yield point, which delays and holds would have applied,
 * and what work has no declared way to yield.
 *
 * This class has no way to act. Its dependencies are all reads, and
 * `tests/unit/machine-maintenance-watch-only.test.ts` fails the build if that changes.
 *
 * Phases run on the ORIGINAL T-0, not the delayed one. A real drain shifts its
 * phases with T-0, so a delay active from the start rolls the night before
 * anything stops. On paper that would mean a rolled night never reaches T-20 and
 * measures no yield at all, so the delay arithmetic runs alongside, unshifted
 * measurement beside the shifted verdict.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../core/hostSemaphoreCore.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { HostMaintenanceStore, DrainRecord } from './HostMaintenanceStore.js';
import {
  DRAIN_PHASES, DELAYS, DELAY_STEP_MINUTES, currentPhase, isDue, isFinalNight, phaseTime, stepDelays, uptimeDays, windowFor,
  type DelayId, type MachineMaintenanceSettings, type SafetyHoldId,
} from './planner.js';
import { WORK_YIELD_REGISTRY, discoverWork, yieldEntryFor, type WorkCensusInputs, type WorkItem } from './WorkYieldRegistry.js';
import { foreignTmuxSessions, readOwnerPresent, readSafetyHolds, type HoldReading, type MachineSignals } from './readings.js';

const MIN = 60_000;
const OPEN_FROM_MINUTES = 70;
/** Past this there is nothing left to measure, so a server that came up late skips the night. */
const LATEST_OPEN_MINUTES = 20;
const IDLE_REFRESH_MS = 15 * MIN;
const LATE_PHASE_MS = 3 * MIN;
/** An ack older than this is from an agent that has stopped answering. */
const ACK_FRESH_MS = 3 * MIN;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_NIGHTS = 30;
const MAX_LABELS = 20;
const MAX_SAMPLES = 100;
export const ENFORCEMENT_NIGHTS = 14;
export const MIN_SEEN_PER_KIND = 10;
export const BOUNDARY_P95_LIMIT_SECONDS = 15 * 60;

export interface ResumeQueueReading { disabled: string | null; paused: boolean; dryRun: boolean; entries: number }

export interface DrainRehearsalDeps {
  agentName: string;
  version: string;
  stateDir: string;
  logPath: string;
  store: HostMaintenanceStore;
  /** Read live, so the off switch needs no restart. */
  enabled: () => boolean;
  settings: () => MachineMaintenanceSettings;
  readSignals: () => Promise<MachineSignals>;
  census: (opts: { readBoundaries: boolean }) => Promise<WorkCensusInputs>;
  resumeQueue: () => ResumeQueueReading | null;
  coResidentAgents: () => string[];
  holdsLease: () => boolean | null;
  ownUser: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  log?: (line: string) => void;
}

interface TrackedYield {
  kind: string;
  key: string;
  label: string;
  askedAt: number;
  reachedAt: number | null;
  /** Seen at its prompt on the last read. One read proves little, so two in a row count. */
  boundaryAt: number | null;
  /** Session work that disappeared with no boundary seen: reaped, crashed or unlisted. Not a yield. */
  vanished: boolean;
}

interface OpenRehearsal {
  episodeId: string;
  generation: number;
  originalRestartAt: number;
  windowEnd: number;
  due: boolean;
  final: boolean;
  openedLate: boolean;
  phasesDone: string[];
  tracked: Record<string, TrackedYield>;
  /** Sessions already at rest when asked. A yield of nothing, so it is counted and not sampled. */
  alreadyAtRest: Record<string, number>;
  phasesLate: string[];
  undeclared: string[];
  undeclaredUnread: boolean;
  holdsSeen: SafetyHoldId[];
}

export interface KindStats { kind: string; class: string; count: number; censored: number; vanished: number; alreadyAtRest: number; medianSeconds: number | null; p95Seconds: number | null }

export interface NightSummary {
  episodeId: string;
  closedAt: number;
  due: boolean;
  final: boolean;
  openedLate: boolean;
  /** Phases that fired late (the machine slept, or the server was down). Their kinds were not measured. */
  phasesLate: string[];
  undeclaredUnread: boolean;
  outcome: 'would-restart' | 'would-roll' | 'would-hold' | 'unknown';
  rollBecause: DelayId | null;
  delayMinutesUsed: Partial<Record<DelayId, number>>;
  holds: SafetyHoldId[];
  kinds: KindStats[];
  /** Whole-second yield times per kind, censored runs excluded. */
  samples: Record<string, number[]>;
  undeclared: string[];
  /** On a final night, what the default would have ended. */
  wouldEndOnFinalNight: string[];
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export class DrainRehearsal {
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private ticking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private open: OpenRehearsal | null;
  private nights: NightSummary[];
  private signals: MachineSignals | null = null;
  private signalsAt = 0;
  private delays: Array<{ id: DelayId; label: string; active: boolean | null; evidence: string }> = [];
  private holds: HoldReading[] = [];
  private ticks = 0;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: DrainRehearsalDeps) {
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
    this.open = this.readJson<OpenRehearsal>(this.openPath);
    this.nights = this.readJson<NightSummary[]>(this.nightsPath) ?? [];
  }

  private get openPath(): string { return path.join(this.deps.stateDir, 'state', 'machine-maintenance-rehearsal.json'); }
  private get nightsPath(): string { return path.join(this.deps.stateDir, 'state', 'machine-maintenance-nights.json'); }

  start(tickMs = 60_000): void {
    if (this.timer) return;
    this.first = setTimeout(() => { void this.tick(); }, 30_000);
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
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.step();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`tick failed: ${this.lastError}`);
    } finally {
      this.ticks += 1;
      this.lastTickAt = this.now();
      this.ticking = false;
    }
  }

  private async step(): Promise<void> {
    if (!this.deps.enabled()) return;
    const now = this.now();
    const cfg = this.deps.settings();
    if (this.open && now >= this.open.windowEnd) this.finish(null);

    const window = windowFor(now, cfg.window);
    const opensAt = phaseTime(window.restartAt, OPEN_FROM_MINUTES);
    const lastOpen = phaseTime(window.restartAt, LATEST_OPEN_MINUTES);
    const inOpenRange = now >= opensAt && now <= lastOpen;

    if (!this.open && !inOpenRange) {
      if (now - this.signalsAt >= IDLE_REFRESH_MS || !this.signals) await this.refresh(await this.deps.census({ readBoundaries: false }));
      return;
    }

    // Reading a session's boundary reads its pane, so it waits until the answer matters.
    const measuring = now >= phaseTime(window.restartAt, LATEST_OPEN_MINUTES) && now <= (this.open?.originalRestartAt ?? window.restartAt);
    const census = await this.deps.census({ readBoundaries: measuring });
    await this.refresh(census);
    if (!this.open) this.begin(cfg, now, window);
    const open = this.open;
    if (!open) return;

    const work = discoverWork(census);
    this.observeYields(open, work, now);
    for (const phase of DRAIN_PHASES) {
      if (open.phasesDone.includes(phase.id) || now < phaseTime(open.originalRestartAt, phase.offsetMinutes)) continue;
      open.phasesDone.push(phase.id);
      // A phase firing late has no honest ask time, so it measures nothing.
      const late = now - phaseTime(open.originalRestartAt, phase.offsetMinutes) > LATE_PHASE_MS;
      if (late) open.phasesLate.push(phase.id);
      else this.trackAsked(open, work, phase.offsetMinutes, now);
      this.writePhaseRow(open, phase.id, phase.offsetMinutes, phase.wouldDo, census, work, now, late);
    }

    this.recordUndeclaredAndHolds(open);
    this.ack(open, work, now);
    // Another agent on this host may have closed the record already.
    const plan = this.stepDelayLedger(open, now, cfg) ?? this.deps.store.readLatest(open.episodeId);
    this.save(open);
    if (now >= open.originalRestartAt && plan && (plan.outcome !== null || (now >= plan.restartAt && plan.activeDelays.length === 0))) {
      this.finish(plan);
    }
  }

  private begin(cfg: MachineMaintenanceSettings, now: number, window: { end: number; restartAt: number }): void {
    const lastBootAt = this.signals?.lastBootAt ?? null;
    const final = lastBootAt !== null && isFinalNight(now, lastBootAt, cfg);
    const reserved = this.deps.store.reserve({
      openedBy: this.deps.agentName,
      restartAt: window.restartAt,
      windowEnd: window.end,
      final,
      maxEpisodeDelayMinutes: cfg.maxEpisodeDelayMinutes,
    });
    if (!reserved) throw new Error('host maintenance lock unavailable');
    this.open = {
      episodeId: reserved.plan.episodeId,
      generation: reserved.plan.generation,
      originalRestartAt: reserved.plan.originalRestartAt,
      windowEnd: reserved.plan.windowEnd,
      due: lastBootAt !== null && isDue(now, lastBootAt, cfg),
      final: reserved.plan.final,
      openedLate: now > phaseTime(reserved.plan.originalRestartAt, 60),
      phasesDone: [],
      tracked: {},
      alreadyAtRest: {},
      phasesLate: [],
      undeclared: [],
      undeclaredUnread: false,
      holdsSeen: [],
    };
    this.audit({ type: 'opened', episodeId: reserved.plan.episodeId, joined: !reserved.opened, restartAt: reserved.plan.restartAt, due: this.open.due, final: this.open.final, openedLate: this.open.openedLate });
  }

  private trackAsked(open: OpenRehearsal, work: WorkItem[], offsetMinutes: number, now: number): void {
    for (const item of work) {
      if (yieldEntryFor(item.kind)?.askOffsetMinutes !== offsetMinutes || open.tracked[item.key]) continue;
      if (item.atBoundary === true) {
        open.alreadyAtRest[item.kind] = (open.alreadyAtRest[item.kind] ?? 0) + 1;
        continue;
      }
      open.tracked[item.key] = { kind: item.kind, key: item.key, label: item.label, askedAt: now, reachedAt: null, boundaryAt: null, vanished: false };
    }
  }

  /**
   * Work with no boundary reading yields by ending. A session yields by coming to
   * rest at its prompt on two reads running; one that disappears without that may
   * have been reaped or crashed, and proves nothing about how it would have stopped.
   */
  private observeYields(open: OpenRehearsal, work: WorkItem[], now: number): void {
    const live = new Map(work.map((w) => [w.key, w]));
    for (const row of Object.values(open.tracked)) {
      if (row.reachedAt !== null || row.vanished) continue;
      const item = live.get(row.key);
      if (!item) {
        if (row.key.startsWith('session:') || row.key.startsWith('job:')) row.vanished = true;
        else row.reachedAt = now;
      } else if (item.atBoundary === true) {
        if (row.boundaryAt !== null) row.reachedAt = now;
        else row.boundaryAt = now;
      } else {
        row.boundaryAt = null;
      }
    }
  }

  private writePhaseRow(open: OpenRehearsal, phase: string, offsetMinutes: number, wouldDo: string, census: WorkCensusInputs, work: WorkItem[], now: number, late: boolean): void {
    const byKind: Record<string, { count: number; labels: string[] }> = {};
    for (const item of work) {
      const row = (byKind[item.kind] ??= { count: 0, labels: [] });
      row.count += 1;
      if (row.labels.length < MAX_LABELS) row.labels.push(item.label);
    }
    const extra: Record<string, unknown> = {};
    if (phase === 'announce') extra.censusAgents = this.deps.coResidentAgents();
    if (phase === 'move') {
      const autonomous = new Set(census.autonomousRuns.map((r) => r.topic));
      extra.holdsLease = this.deps.holdsLease();
      extra.wouldMove = census.sessions.filter((s) => s.topicId !== undefined && !s.jobSlug && !autonomous.has(String(s.topicId))).slice(0, 6).map((s) => s.topicId);
    }
    if (phase === 'pause') extra.notAtBoundary = work.filter((w) => w.atBoundary === false).map((w) => w.label).slice(0, MAX_LABELS);
    if (phase === 'receipts') {
      const resumable = work.filter((w) => yieldEntryFor(w.kind)?.comesBackVia === 'resume-queue').length;
      const queue = this.deps.resumeQueue();
      extra.wouldEnqueue = resumable;
      extra.resumeQueue = queue;
      extra.resumeQueueCouldHold = queue ? queue.disabled === null && queue.entries + resumable <= 50 : false;
    }
    this.audit({ type: 'phase', episodeId: open.episodeId, phase, offsetMinutes, at: now, late, wouldDo, work: byKind, ...extra });
  }

  private recordUndeclaredAndHolds(open: OpenRehearsal): void {
    const d2 = this.delays.find((d) => d.id === 'D2');
    if (d2?.active === null) open.undeclaredUnread = true;
    for (const name of this.undeclaredWork()) if (!open.undeclared.includes(name)) open.undeclared.push(name);
    for (const hold of this.holds) if (hold.active && !open.holdsSeen.includes(hold.id)) open.holdsSeen.push(hold.id);
  }

  private undeclaredWork(): string[] {
    const d2 = this.delays.find((d) => d.id === 'D2');
    return d2?.active ? d2.evidence.split(', ').filter(Boolean) : [];
  }

  private ack(open: OpenRehearsal, work: WorkItem[], now: number): void {
    const yields: Record<string, number> = {};
    for (const item of work) yields[item.kind] = (yields[item.kind] ?? 0) + 1;
    this.deps.store.writeAck(this.deps.agentName, {
      episodeId: open.episodeId,
      generation: open.generation,
      bootTime: this.signals?.lastBootAt ?? 0,
      state: open.phasesDone.includes('receipts') ? 'ready' : 'draining',
      delaysClaimed: this.delays.filter((d) => d.active === true && (d.id === 'D1' || d.id === 'D2')).map((d) => d.id),
      yields,
      version: this.deps.version,
      at: now,
    });
  }

  private stepDelayLedger(open: OpenRehearsal, now: number, cfg: MachineMaintenanceSettings): DrainRecord | null {
    const plan = this.deps.store.readPlan();
    if (!plan || plan.episodeId !== open.episodeId || plan.outcome !== null) return plan;
    if (now < phaseTime(open.originalRestartAt, 60)) return plan;
    if (plan.lastDelayStepAt !== null && now - plan.lastDelayStepAt < DELAY_STEP_MINUTES * MIN) return plan;

    const acks = Object.fromEntries(Object.entries(this.deps.store.readAcks(open.episodeId, open.generation)).filter(([, a]) => now - a.at < ACK_FRESH_MS));
    const claimed = Object.values(acks).flatMap((a) => a.delaysClaimed);
    const silent = now >= phaseTime(open.originalRestartAt, 5)
      ? this.deps.coResidentAgents().filter((a) => a !== this.deps.agentName && !acks[a])
      : [];
    const d3 = this.delays.find((d) => d.id === 'D3');
    if (d3) { d3.active = silent.length > 0; d3.evidence = silent.join(', ') || 'none'; }
    const active = silent.length > 0 ? [...claimed, 'D3'] : claimed;
    const step = stepDelays({
      restartAt: plan.restartAt,
      originalRestartAt: plan.originalRestartAt,
      windowEnd: plan.windowEnd,
      used: plan.delayMinutesUsed,
      active,
      final: plan.final,
      maxEpisodeDelayMinutes: cfg.maxEpisodeDelayMinutes,
    });
    if (step.refused.length > 0) this.audit({ type: 'delay-refused', episodeId: open.episodeId, refused: step.refused, at: now });
    if (step.outcome !== 'clear') this.audit({ type: 'delay', episodeId: open.episodeId, at: now, outcome: step.outcome, restartAt: step.restartAt, delays: step.holdingDelays, rollBecause: step.rollBecause, used: step.used });
    return this.deps.store.update(open.episodeId, open.generation, (p) => ({
      ...p,
      state: 'quiescing',
      restartAt: step.restartAt,
      activeDelays: step.holdingDelays,
      holds: this.holds.filter((h) => h.active).map((h) => h.id),
      delayMinutesUsed: step.used,
      lastDelayStepAt: now,
      outcome: step.outcome === 'roll' ? 'would-roll' : p.outcome,
      rollBecause: step.rollBecause,
    })) ?? plan;
  }

  private finish(plan: DrainRecord | null): void {
    const open = this.open;
    if (!open) return;
    const now = this.now();
    const latest = plan ?? this.deps.store.readLatest(open.episodeId);
    const censoredAt = Math.min(now, open.originalRestartAt);
    const kinds: KindStats[] = [];
    const samples: Record<string, number[]> = {};
    for (const entry of WORK_YIELD_REGISTRY) {
      const rows = Object.values(open.tracked).filter((r) => r.kind === entry.kind);
      const atRest = open.alreadyAtRest[entry.kind] ?? 0;
      if (rows.length === 0 && atRest === 0) continue;
      const reached = rows.filter((r) => r.reachedAt !== null && r.reachedAt <= censoredAt);
      const seconds = reached.map((r) => Math.round((r.reachedAt! - r.askedAt) / 1000)).sort((a, b) => a - b);
      samples[entry.kind] = seconds.slice(-MAX_SAMPLES);
      const vanished = rows.filter((r) => r.vanished).length;
      kinds.push({ kind: entry.kind, class: entry.class, count: rows.length, censored: rows.length - reached.length - vanished, vanished, alreadyAtRest: atRest, medianSeconds: percentile(seconds, 50), p95Seconds: percentile(seconds, 95) });
    }
    const holdAtT0 = open.holdsSeen.length > 0 && this.holds.some((h) => h.active);
    const outcome: NightSummary['outcome'] = latest === null ? 'unknown'
      : latest.outcome === 'would-roll' ? 'would-roll'
      : holdAtT0 ? 'would-hold'
      : now >= latest.restartAt && latest.activeDelays.length === 0 ? 'would-restart' : 'unknown';
    const silent = this.delays.find((d) => d.id === 'D3');
    const summary: NightSummary = {
      episodeId: open.episodeId,
      closedAt: now,
      due: open.due,
      final: open.final,
      openedLate: open.openedLate,
      phasesLate: open.phasesLate,
      undeclaredUnread: open.undeclaredUnread,
      outcome,
      rollBecause: latest?.rollBecause ?? null,
      delayMinutesUsed: latest?.delayMinutesUsed ?? {},
      holds: open.holdsSeen,
      kinds,
      samples,
      undeclared: open.undeclared,
      wouldEndOnFinalNight: open.final ? [...open.undeclared, ...(silent?.active ? [`agent ${silent.evidence}`] : [])] : [],
    };
    this.nights = [...this.nights.filter((n) => n.episodeId !== summary.episodeId), summary].slice(-MAX_NIGHTS);
    this.writeJson(this.nightsPath, this.nights);
    this.audit({ type: 'closed', ...summary, samples: undefined });
    this.deps.store.update(open.episodeId, open.generation, (p) => ({ ...p, state: 'closed', outcome: p.outcome ?? (outcome === 'unknown' ? null : outcome) }));
    this.open = null;
    try { SafeFsExecutor.safeRmSync(this.openPath, { force: true, operation: 'DrainRehearsal.finish' }); } catch { /* @silent-fallback-ok — a stale file closes at the next window end */ }
  }

  private async refresh(census: WorkCensusInputs): Promise<void> {
    const s = await this.deps.readSignals();
    this.signals = s;
    this.signalsAt = this.now();
    const owner = readOwnerPresent(s, this.deps.ownUser, this.platform);
    const agents = this.deps.coResidentAgents();
    const foreign = foreignTmuxSessions(s.tmuxSessions, census.sessions.map((x) => x.tmuxSession), [this.deps.agentName, ...agents]);
    const noIdentity = census.sessions.filter((x) => x.topicId === undefined && !x.jobSlug).map((x) => x.name);
    const undeclared = [...(foreign ?? []), ...noIdentity];
    const notRead = (reason: string): { active: null; evidence: string } => ({ active: null, evidence: reason });
    const prior = this.delays.find((d) => d.id === 'D3');
    const readings: Record<DelayId, { active: boolean | null; evidence: string }> = {
      D1: owner,
      D2: foreign === null ? notRead('tmux could not be read') : { active: undeclared.length > 0, evidence: undeclared.slice(0, MAX_LABELS).join(', ') || 'none' },
      D3: prior ? { active: prior.active, evidence: prior.evidence } : notRead('read from T-5'),
      D4: notRead('not read in the watch-only build'),
      D5: notRead('a handoff has to be tried to know'),
      D6: notRead('needs the pool claim, not built yet'),
      D7: notRead('needs the browser ledger, not built yet'),
    };
    this.delays = (Object.keys(DELAYS) as DelayId[]).map((id) => ({ id, label: DELAYS[id].label, ...readings[id] }));
    this.holds = readSafetyHolds(s, this.deps.ownUser);
  }

  evidence(): Record<string, unknown> {
    // Only a whole, measured night counts: a closed-unknown, late or blind night is not evidence.
    const whole = this.nights.filter((n) => n.outcome !== 'unknown' && !n.openedLate && (n.phasesLate?.length ?? 0) === 0 && !n.undeclaredUnread);
    const lastSeven = whole.slice(-7);
    const undeclared = [...new Set(lastSeven.flatMap((n) => n.undeclared))];
    const seen: Record<string, number> = {};
    for (const night of whole) for (const k of night.kinds) seen[k.kind] = (seen[k.kind] ?? 0) + k.count;
    const unobserved = WORK_YIELD_REGISTRY.filter((e) => (seen[e.kind] ?? 0) < MIN_SEEN_PER_KIND).map((e) => e.kind);
    const boundary = WORK_YIELD_REGISTRY.filter((e) => e.class === 'stop-at-boundary').map((e) => e.kind);
    const times = whole.flatMap((n) => boundary.flatMap((k) => n.samples[k] ?? [])).sort((a, b) => a - b);
    const censored = whole.reduce((sum, n) => sum + n.kinds.filter((k) => boundary.includes(k.kind)).reduce((c, k) => c + k.censored + (k.vanished ?? 0), 0), 0);
    // A censored or vanished run has no measured stop, so it counts as over the limit, not as absent.
    const withCensored = [...times, ...Array<number>(censored).fill(Number.POSITIVE_INFINITY)];
    const p95 = percentile(withCensored, 95);
    const nightsMet = whole.length >= ENFORCEMENT_NIGHTS;
    return {
      nights: whole.length,
      nightsRecorded: this.nights.length,
      nightsNeeded: ENFORCEMENT_NIGHTS,
      undeclaredLast7: undeclared,
      seenByKind: seen,
      unobservedKinds: unobserved,
      boundaryP95Seconds: p95 === null || Number.isFinite(p95) ? p95 : 'over the limit',
      boundaryP95LimitSeconds: BOUNDARY_P95_LIMIT_SECONDS,
      met: nightsMet && undeclared.length === 0 && p95 !== null && p95 < BOUNDARY_P95_LIMIT_SECONDS,
    };
  }

  status(): Record<string, unknown> {
    const now = this.now();
    const cfg = this.deps.settings();
    const window = windowFor(now, cfg.window);
    const lastBootAt = this.signals?.lastBootAt ?? null;
    const plan = this.deps.store.readPlan();
    return {
      enabled: this.deps.enabled(),
      mode: 'watch-only',
      canRestart: false,
      canStopWork: false,
      settings: cfg,
      lastBootAt,
      uptimeDays: lastBootAt !== null ? Math.round(uptimeDays(now, lastBootAt) * 10) / 10 : null,
      due: lastBootAt !== null ? isDue(now, lastBootAt, cfg) : null,
      finalNight: lastBootAt !== null ? isFinalNight(now, lastBootAt, cfg) : null,
      nextWindow: window,
      phase: plan ? currentPhase(now, plan.originalRestartAt) : null,
      plan,
      readingsAt: this.signalsAt || null,
      delays: this.delays,
      safetyHolds: this.holds,
      declaredKinds: WORK_YIELD_REGISTRY.map((e) => ({ kind: e.kind, class: e.class, comesBackVia: e.comesBackVia })),
      lastRehearsal: this.nights.at(-1) ?? null,
      evidence: this.evidence(),
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
    };
  }

  private save(open: OpenRehearsal): void { this.writeJson(this.openPath, open); }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(value), { operation: 'DrainRehearsal.writeJson' });
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    } catch {
      // @silent-fallback-ok — an absent or unreadable record starts empty; evidence is rebuilt nightly.
      return null;
    }
  }

  private audit(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      try {
        if (fs.statSync(this.deps.logPath).size > MAX_LOG_BYTES) fs.renameSync(this.deps.logPath, `${this.deps.logPath}.1`);
      } catch { /* @silent-fallback-ok — no log yet */ }
      fs.appendFileSync(this.deps.logPath, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), agent: this.deps.agentName, watchOnly: true, ...row })}\n`);
    } catch (err) {
      this.deps.log?.(`audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let active: DrainRehearsal | null = null;
export function setActiveDrainRehearsal(r: DrainRehearsal | null): void { active = r; }
export function getActiveDrainRehearsal(): DrainRehearsal | null { return active; }

/** Running agents on this host from the machine registry, the lifeline rows left out. */
export function readHostCensus(registryPath: string, now: number): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as unknown;
    const rows = (Array.isArray(raw) ? raw : (raw as { entries?: unknown[] }).entries ?? []) as Array<{ name?: string; status?: string; lastHeartbeat?: string }>;
    return rows
      .filter((r) => typeof r.name === 'string' && !r.name.endsWith('-lifeline') && r.status === 'running')
      .filter((r) => { const beat = Date.parse(r.lastHeartbeat ?? ''); return Number.isFinite(beat) && now - beat < 10 * MIN; })
      .map((r) => r.name as string);
  } catch {
    // @silent-fallback-ok — no registry means no co-resident agents can be named.
    return [];
  }
}
