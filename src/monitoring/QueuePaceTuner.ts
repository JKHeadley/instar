/**
 * QueuePaceTuner — bounded extra triage ticks for `feedback.triage` only (docs/specs/queue-pace.md §3).
 *
 * It speeds the worker up by asking the triage service for one extra tick IN-PROCESS through
 * `acceptTick()` only (never `tick()`, never a job trigger, never a schedule rewrite), and only
 * when the worker itself is the measured limit. It never raises a cap, a batch envelope, a
 * daily spend or any operator-approved limit; nothing is queued and nothing is retried.
 *
 * Bounds, all binding in this file: an explicit flag `queuePace.tuner.enabled` (default false,
 * NOT dev-gated) plus `dryRun` (default true); step-up after 2 consecutive worker evaluations;
 * a fresh eligibility re-check before EVERY extra tick (worker evidence, no refusal, live quota
 * margin, projected call cap, the ownership predicate, the flags); at most one extra tick per
 * `minGapMinutes`, never within ±2 min of a scheduled `*\/15` tick, at most `maxExtraRunsPerDay`
 * per local day reserved DURABLY before the call; a 6 h cooldown after a step-down; and missing
 * or unreadable state fails closed (the day's budget treated as spent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { governor } from './selfaction/governor.js';
import type { DerivedTarget } from './selfaction/types.js';
import {
  HOUR_MS, TRIAGE_SCHEDULE_MINUTES, evaluateBottleneck, projectDailyCalls, workerEvidence,
} from './QueuePace.js';
import { isQueuePaceEnabled, queuePaceConfig, writeAtomic as writeAtomicText, type QueuePaceLedger, type QueuePaceTickLog, type TunerView } from './QueuePaceLedger.js';

export const TUNER_DEFAULTS = { minGapMinutes: 10, maxExtraRunsPerDay: 12 } as const;
export const COOLDOWN_MS = 6 * HOUR_MS;
/** Account quota must be this many points below the triage pause threshold (75 → below 65%). */
export const QUOTA_MARGIN_POINTS = 10;
/** No extra tick within this distance of a scheduled tick (a service tick is capped at 110 s). */
export const SCHEDULE_EXCLUSION_MS = 2 * 60_000;
export const STEP_UP_EVALUATIONS = 2;
/** A reserved tick whose result row never appears is closed as unknown (still counted spent). */
export const PENDING_OUTCOME_MS = 10 * 60_000;

const STEP_DOWN_STOPS = new Set(['quota-pause', 'quota-unreadable-pause', 'call-cap-reached']);

/* @self-action-controller: queue-pace-extra-run */
const extraRunGovernor = governor.for('queue-pace-extra-run');
function deriveTargetKey(queue: 'feedback.triage'): DerivedTarget { return { key: `queue-pace-extra-run:${queue}`, classId: 'queue-pace-extra-run', keyIsVolatile: false }; }

export interface TunerConfig { enabled: boolean; dryRun: boolean; minGapMinutes: number; maxExtraRunsPerDay: number }

export function resolveTunerConfig(config: unknown): TunerConfig {
  const t = queuePaceConfig(config).tuner ?? {};
  const int = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d; };
  return {
    enabled: t.enabled === true,
    dryRun: t.dryRun !== false,
    minGapMinutes: int(t.minGapMinutes, TUNER_DEFAULTS.minGapMinutes, 10, 24 * 60),
    maxExtraRunsPerDay: int(t.maxExtraRunsPerDay, TUNER_DEFAULTS.maxExtraRunsPerDay, 0, TUNER_DEFAULTS.maxExtraRunsPerDay),
  };
}

export interface TunerState {
  /** Local day (YYYY-MM-DD) the counter belongs to. */
  day: string;
  extraRunsToday: number;
  nextEligibleAt: number;
  cooldownUntil: number | null;
  steppedUp: boolean;
  lastEvalAt: number;
  pending: { runId: string; at: number } | null;
}

export function localDay(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nextLocalMidnight(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** True within ±2 minutes of a scheduled triage tick (cron `*\/15`, local minutes). */
export function nearScheduledTick(t: number, minutes: readonly number[] = TRIAGE_SCHEDULE_MINUTES, windowMs = SCHEDULE_EXCLUSION_MS): boolean {
  const d = new Date(t);
  const msIntoHour = (d.getMinutes() * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  for (const m of [...minutes, 60]) {
    if (Math.abs(msIntoHour - m * 60_000) <= windowMs) return true;
  }
  return false;
}

export interface TriagePort {
  acceptTick(): { status: number; body: Record<string, unknown> };
  quotaStatus(): Promise<{ usedPercent: number | null; pauseThreshold: number }>;
  callsUsedToday(): number | null;
  maxCallsPerDay(): number;
}

export interface QueuePaceTunerOptions {
  stateDir: string;
  config: () => unknown;
  ledger: Pick<QueuePaceLedger, 'evaluation'>;
  ticks: QueuePaceTickLog;
  triage: () => TriagePort | null;
  /** operated host AND holding the serving lease AND not restore-pending. */
  ownerServing: () => boolean;
  clock?: () => number;
}

/** Tuner audit rows older than this are dropped on the daily read. */
const AUDIT_RETENTION_DAYS = 30;

export type TunerDecision =
  | 'off' | 'fail-closed' | 'idle' | 'cooldown' | 'waiting' | 'near-schedule' | 'at-max'
  | 'step-down' | 'would-tick' | 'ticked' | 'skipped-busy' | 'pending';

export class QueuePaceTuner {
  private readonly stateFile: string;
  private readonly auditFile: string;
  private readonly now: () => number;
  private busy = false;
  private lastDecision: TunerDecision = 'off';
  private lastFlags: string | null = null;

  constructor(private readonly opts: QueuePaceTunerOptions) {
    this.now = opts.clock ?? Date.now;
    this.stateFile = path.join(opts.stateDir, 'state', 'queue-pace', 'tuner.json');
    this.auditFile = path.join(opts.stateDir, 'logs', 'queue-pace-tuner.jsonl');
  }

  config(): TunerConfig { return resolveTunerConfig(this.opts.config()); }

  private audit(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      const fd = fs.openSync(this.auditFile, 'a');
      try { fs.writeSync(fd, JSON.stringify({ at: this.now(), ...row }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) { // @silent-fallback-ok: the audit is evidence; the durable state file still binds the counter
      console.warn('[queue-pace-tuner] audit append failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Reserved extra ticks recorded today in the audit (the counter is rebuilt from here when state returns).
   *  The file is read once per local day (then the count is kept in memory and bumped on each
   *  reserve); on that daily read, rows older than AUDIT_RETENTION_DAYS are dropped. */
  private auditDayCache: { day: string; count: number } | null = null;
  private auditCountToday(day: string): number {
    if (this.auditDayCache?.day === day) return this.auditDayCache.count;
    let text = '';
    try { text = fs.readFileSync(this.auditFile, 'utf8'); } catch { this.auditDayCache = { day, count: 0 }; return 0; } // @silent-fallback-ok: no audit yet → nothing reserved
    let n = 0;
    const keep: string[] = [];
    const cutoff = this.now() - AUDIT_RETENTION_DAYS * 24 * HOUR_MS;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as { kind?: string; day?: string; at?: number };
        if (r.kind === 'reserve' && r.day === day) n++;
        if (typeof r.at !== 'number' || r.at >= cutoff || (r.kind === 'reserve' && r.day === day)) keep.push(line);
      } catch { /* @silent-fallback-ok: torn line dropped on rotation */ }
    }
    if (keep.length < text.split('\n').filter(Boolean).length) {
      try { writeAtomicText(this.auditFile, keep.join('\n') + (keep.length ? '\n' : '')); } catch { /* @silent-fallback-ok: rotation retried next day */ }
    }
    this.auditDayCache = { day, count: n };
    return n;
  }

  /** Read state; null when missing or unreadable (the caller fails closed). */
  readState(): TunerState | null {
    let raw: string;
    try { raw = fs.readFileSync(this.stateFile, 'utf8'); } catch { return null; } // @silent-fallback-ok: missing state → fail closed
    try {
      const s = JSON.parse(raw) as TunerState;
      if (typeof s.day !== 'string' || typeof s.extraRunsToday !== 'number') return null;
      return s;
    } catch { return null; } // @silent-fallback-ok: corrupt state → fail closed
  }

  private writeState(s: TunerState): void {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(s)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.stateFile);
  }

  /** Read-only state for the route, the ledger notices and the Pace card. */
  view(): TunerView {
    const cfg = this.config();
    const s = this.readState();
    const now = this.now();
    const extra = s && s.day === localDay(now) ? s.extraRunsToday : 0;
    const state = !cfg.enabled || !isQueuePaceEnabled(this.opts.config()) ? 'off'
      : !s ? 'fail-closed'
        : s.cooldownUntil !== null && now < s.cooldownUntil && !s.steppedUp ? 'cooldown'
          : s.steppedUp ? (cfg.dryRun ? 'speeding-up-dry-run' : 'speeding-up') : 'idle';
    return { state, extraRunsToday: extra, cooldownUntil: s?.cooldownUntil ?? null, enabled: cfg.enabled, dryRun: cfg.dryRun, atMax: extra >= cfg.maxExtraRunsPerDay };
  }

  /** Extra ticks the tuner may still add today (the projected-cap input). */
  extraTicksAllowed(): number {
    const cfg = this.config();
    if (!cfg.enabled) return 0;
    const v = this.view();
    return Math.max(0, cfg.maxExtraRunsPerDay - v.extraRunsToday);
  }

  lastDecisionMade(): TunerDecision { return this.lastDecision; }

  private stepDown(s: TunerState, reason: string, now: number): TunerDecision {
    const was = s.steppedUp;
    s.steppedUp = false;
    s.cooldownUntil = now + COOLDOWN_MS;
    this.writeState(s);
    this.audit({ kind: 'step-down', reason, wasSteppedUp: was, cooldownUntil: s.cooldownUntil });
    return 'step-down';
  }

  /** One pass (called about once a minute). Single-flight. */
  async pump(): Promise<TunerDecision> {
    if (this.busy) return this.lastDecision;
    this.busy = true;
    // The enable / dry-run decisions are recorded in the tuner audit (spec: graduation trail).
    const cfg = this.config();
    const flags = JSON.stringify({ enabled: cfg.enabled, dryRun: cfg.dryRun, gate: isQueuePaceEnabled(this.opts.config()) });
    if (flags !== this.lastFlags) {
      // Nothing is written on an agent where the tuner was never on (dark fleet agents stay file-free).
      const wasOn = this.lastFlags !== null && (JSON.parse(this.lastFlags) as { enabled?: boolean }).enabled === true;
      if (cfg.enabled || wasOn) this.audit({ kind: 'config', ...JSON.parse(flags), maxExtraRunsPerDay: cfg.maxExtraRunsPerDay, minGapMinutes: cfg.minGapMinutes });
      this.lastFlags = flags;
    }
    try { this.lastDecision = await this.pumpInner(); } catch (error) { // @silent-fallback-ok: logged; a failed pass never ticks
      console.warn('[queue-pace-tuner] pass failed:', error instanceof Error ? error.message : error);
      this.lastDecision = 'idle';
    } finally { this.busy = false; }
    return this.lastDecision;
  }

  private async pumpInner(): Promise<TunerDecision> {
    const cfg = this.config();
    if (!cfg.enabled || !isQueuePaceEnabled(this.opts.config())) return 'off';
    const now = this.now();
    const today = localDay(now);
    let s = this.readState();
    if (!s) {
      // Losing or deleting state can never grant extra ticks: today's budget is spent and the
      // cooldown runs until the next local day plus the cooldown.
      s = { day: today, extraRunsToday: Math.max(cfg.maxExtraRunsPerDay, this.auditCountToday(today)), nextEligibleAt: nextLocalMidnight(now) + COOLDOWN_MS,
        cooldownUntil: nextLocalMidnight(now) + COOLDOWN_MS, steppedUp: false, lastEvalAt: now, pending: null };
      this.writeState(s);
      this.audit({ kind: 'fail-closed', reason: 'state-missing-or-unreadable', until: s.cooldownUntil });
      return 'fail-closed';
    }
    if (s.day !== today) { s.day = today; s.extraRunsToday = 0; }
    s.extraRunsToday = Math.max(s.extraRunsToday, this.auditCountToday(today));

    // The previous extra tick's outcome comes from the service-written tick row, never the call's return.
    if (s.pending) {
      const row = this.opts.ticks.byRunId(s.pending.runId);
      if (row) {
        this.audit({ kind: 'outcome', runId: s.pending.runId, stopReason: row.stopReason ?? null, decided: row.decided ?? null, calls: row.calls ?? null });
        const stop = row.stopReason ?? null;
        s.pending = null;
        if (stop && STEP_DOWN_STOPS.has(stop)) return this.stepDown(s, `tick-${stop}`, now);
      } else if (now - s.pending.at > PENDING_OUTCOME_MS) {
        this.audit({ kind: 'outcome', runId: s.pending.runId, stopReason: null, unknown: true });
        s.pending = null;
      } else {
        this.writeState(s);
        return 'pending';
      }
    }

    // The hourly evaluation drives step-up / step-down.
    const ev = this.opts.ledger.evaluation('feedback.triage');
    if (ev && ev.at > s.lastEvalAt) {
      s.lastEvalAt = ev.at;
      const worker = ev.raw.verdict === 'falling-behind' && ev.bottleneck?.kind === 'worker';
      if (!worker) {
        if (s.steppedUp) return this.stepDown(s, `evaluation-${ev.raw.verdict}${ev.bottleneck ? `-${ev.bottleneck.kind}` : ''}`, now);
      } else if (!s.steppedUp && ev.workerEvaluations >= STEP_UP_EVALUATIONS && (s.cooldownUntil === null || now >= s.cooldownUntil)) {
        s.steppedUp = true;
        this.audit({ kind: 'step-up', workerEvaluations: ev.workerEvaluations, bottleneck: ev.bottleneck?.matched ?? [] });
      }
    }
    if (!s.steppedUp) { this.writeState(s); return s.cooldownUntil !== null && now < s.cooldownUntil ? 'cooldown' : 'idle'; }
    if (now < s.nextEligibleAt) { this.writeState(s); return 'waiting'; }
    if (s.extraRunsToday >= cfg.maxExtraRunsPerDay) { this.writeState(s); return 'at-max'; }
    if (nearScheduledTick(now)) { this.writeState(s); return 'near-schedule'; }

    // Fresh eligibility re-check immediately before the extra tick: this is the safety check.
    const triage = this.opts.triage();
    if (!triage) return this.stepDown(s, 'triage-unavailable', now);
    let serving = false;
    try { serving = this.opts.ownerServing(); } catch { serving = false; } // @silent-fallback-ok: an unreadable ownership predicate never ticks
    if (!serving) return this.stepDown(s, 'owner-not-serving', now);
    const ticks = this.opts.ticks.since(now - 7 * 24 * HOUR_MS);
    const quota = await triage.quotaStatus().catch(() => ({ usedPercent: null, pauseThreshold: 75 }));
    if (quota.usedPercent === null || !(quota.usedPercent < quota.pauseThreshold - QUOTA_MARGIN_POINTS)) {
      return this.stepDown(s, quota.usedPercent === null ? 'quota-unreadable' : 'quota-margin-lost', now);
    }
    const remaining = cfg.maxExtraRunsPerDay - s.extraRunsToday;
    const projection = projectDailyCalls({ callsUsedToday: triage.callsUsedToday(), maxCallsPerDay: triage.maxCallsPerDay(), ticks, now, extraTicksAllowed: remaining });
    if (!projection.ok) return this.stepDown(s, 'projection-unavailable', now);
    if (projection.reachesCap) return this.stepDown(s, 'call-cap-projected', now);
    const fresh = evaluateBottleneck({ queue: 'feedback.triage', now, ticks, projection });
    const evidence = workerEvidence(ticks, now);
    if (fresh.kind !== 'worker' || !evidence.matched) return this.stepDown(s, `recheck-${fresh.kind}`, now);

    // Durable reservation BEFORE the call: a crash after this point counts the tick as spent.
    // The governor is asked before anything is reserved; a non-allow verdict (only possible once the
    // class is set to enforce) skips this tick. A governor error keeps the observe-only behaviour.
    let verdict: { outcome: string; reason?: string } | null = null;
    try { verdict = await extraRunGovernor.admit(deriveTargetKey('feedback.triage'), { incarnation: today }) as { outcome: string; reason?: string }; } catch { /* @silent-fallback-ok: governor error → observe-only class proceeds */ }
    if (verdict && verdict.outcome !== 'allow') {
      this.writeState(s);
      this.audit({ kind: 'governor-held', outcome: verdict.outcome, reason: verdict.reason ?? null });
      return 'waiting';
    }
    s.extraRunsToday += 1;
    if (this.auditDayCache?.day === today) this.auditDayCache.count = Math.max(this.auditDayCache.count + 1, s.extraRunsToday);
    s.nextEligibleAt = now + cfg.minGapMinutes * 60_000;
    this.writeState(s);
    this.audit({ kind: 'reserve', day: today, dryRun: cfg.dryRun, extraRunsToday: s.extraRunsToday, quotaUsedPercent: quota.usedPercent,
      projectedCalls: projection.projected, maxCallsPerDay: projection.maxCallsPerDay, evidence: { considered: evidence.considered, exhausted: evidence.exhausted } });
    if (cfg.dryRun) { this.audit({ kind: 'would-tick' }); return 'would-tick'; }

    const answer = triage.acceptTick();
    const error = typeof answer.body.error === 'string' ? answer.body.error : null;
    if (answer.status === 202 && typeof answer.body.runId === 'string') {
      s.pending = { runId: answer.body.runId, at: now };
      this.writeState(s);
      this.audit({ kind: 'accepted', runId: answer.body.runId });
      return 'ticked';
    }
    this.audit({ kind: 'refused', status: answer.status, error });
    if (error === 'not-canonical-owner') return this.stepDown(s, 'not-canonical-owner', now);
    // tick-in-flight / rate-limited: the scheduled tick is simply running — skip, no step-down, no cooldown.
    return 'skipped-busy';
  }
}
