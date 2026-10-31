/**
 * QueuePaceTuner (docs/specs/queue-pace.md §3): every step rule on both sides — flags, step-up
 * after 2 worker evaluations, fresh re-check before each extra tick (quota margin, projected cap,
 * ownership, worker evidence), minGap, schedule exclusion, daily maximum, durable reservation
 * before the call, outcome read from the service-written row, cooldown, and fail-closed state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QueuePaceTuner, nearScheduledTick, resolveTunerConfig, localDay, COOLDOWN_MS, type TriagePort } from '../../src/monitoring/QueuePaceTuner.js';
import { QueuePaceTickLog, type QueueEvaluation } from '../../src/monitoring/QueuePaceLedger.js';
import { HOUR_MS, INITIAL_HYSTERESIS, INITIAL_NOTICE, TIME_EXHAUSTED } from '../../src/monitoring/QueuePace.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** A local time 7.5 minutes past the hour (never within ±2 min of a 15-minute tick). */
function localAt(h: number, m = 7, s = 30): number { const d = new Date(2026, 9, 30, h, m, s); return d.getTime(); }

describe('QueuePaceTuner', () => {
  let dir: string;
  let now: number;
  let ev: QueueEvaluation | null;
  let ticks: QueuePaceTickLog;
  let triage: TriagePort & { calls: number; answer: { status: number; body: Record<string, unknown> }; used: number | null; callsToday: number | null };
  let serving: boolean;
  let cfg: Record<string, unknown>;

  const worker = (at: number, n = 2): QueueEvaluation => ({ queue: 'feedback.triage', at, hysteresis: { ...INITIAL_HYSTERESIS, shown: 'falling-behind' },
    raw: { verdict: 'falling-behind' }, bottleneck: { kind: 'worker', matched: ['worker'], detail: '', count: null, history: {} }, workerEvaluations: n, notice: INITIAL_NOTICE });
  const holding = (at: number): QueueEvaluation => ({ ...worker(at, 0), raw: { verdict: 'holding' }, bottleneck: null });
  const evidence = () => { for (const m of [1, 16, 31, 46]) ticks.append({ source: 'triage', kind: 'tick', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 40, at: now - m * 60_000 }); };
  const audit = () => { const f = path.join(dir, 'logs', 'queue-pace-tuner.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const stateFile = () => path.join(dir, 'state', 'queue-pace', 'tuner.json');
  const mk = () => new QueuePaceTuner({ stateDir: dir, config: () => cfg, ledger: { evaluation: () => ev }, ticks, triage: () => triage, ownerServing: () => serving, clock: () => now });
  /** A tuner whose state file exists (the normal case after its first day). */
  const seeded = (over: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ day: localDay(now), extraRunsToday: 0, nextEligibleAt: 0, cooldownUntil: null, steppedUp: false, lastEvalAt: 0, pending: null, ...over }));
    return mk();
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'qp-tuner-'));
    now = localAt(10);
    ticks = new QueuePaceTickLog(path.join(dir, 'logs', 'queue-pace-ticks.jsonl'), () => true, () => now);
    serving = true;
    cfg = { developmentAgent: true, queuePace: { tuner: { enabled: true, dryRun: false } } };
    triage = {
      calls: 0, answer: { status: 202, body: { runId: 'run-1', accepted: true } }, used: 40, callsToday: 10,
      acceptTick() { this.calls++; return this.answer; },
      async quotaStatus() { return { usedPercent: this.used, pauseThreshold: 75 }; },
      callsUsedToday() { return this.callsToday; },
      maxCallsPerDay() { return 10_000; },
    };
    ev = worker(now - 60_000);
    evidence();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/queue-pace-tuner.test.ts:cleanup' }));

  it('config: tuner off by default, dry-run by default, ceilings clamp', () => {
    expect(resolveTunerConfig({})).toEqual({ enabled: false, dryRun: true, minGapMinutes: 10, maxExtraRunsPerDay: 12 });
    expect(resolveTunerConfig({ queuePace: { tuner: { minGapMinutes: 1, maxExtraRunsPerDay: 99 } } })).toMatchObject({ minGapMinutes: 10, maxExtraRunsPerDay: 12 });
  });

  it('is off without its own flag, even on a development agent', async () => {
    cfg = { developmentAgent: true };
    expect(await seeded().pump()).toBe('off');
    expect(triage.calls).toBe(0);
  });

  it('is off when the queue-pace gate is off, even with the tuner flag', async () => {
    cfg = { developmentAgent: false, queuePace: { tuner: { enabled: true, dryRun: false } } };
    expect(await seeded().pump()).toBe('off');
  });

  it('missing state fails closed: the day is spent and the cooldown runs to next day + 6 h', async () => {
    const t = mk();
    expect(await t.pump()).toBe('fail-closed');
    expect(triage.calls).toBe(0);
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    expect(s.extraRunsToday).toBe(12);
    expect(s.cooldownUntil).toBeGreaterThan(now + COOLDOWN_MS);
    ev = worker(now + 1);
    expect(await t.pump()).not.toBe('ticked');
    expect(triage.calls).toBe(0);
  });

  it('corrupt state also fails closed', async () => {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), '{not json');
    expect(await mk().pump()).toBe('fail-closed');
  });

  it('steps up only after 2 consecutive worker evaluations', async () => {
    ev = worker(now - 60_000, 1);
    const t = seeded();
    expect(await t.pump()).toBe('idle');
    ev = worker(now - 30_000, 2);
    expect(await t.pump()).toBe('ticked');
    expect(triage.calls).toBe(1);
  });

  it('dry-run reserves and logs would-tick but never calls the service', async () => {
    cfg = { developmentAgent: true, queuePace: { tuner: { enabled: true } } };
    expect(await seeded().pump()).toBe('would-tick');
    expect(triage.calls).toBe(0);
    expect(audit().map((r) => r.kind)).toEqual(expect.arrayContaining(['reserve', 'would-tick']));
  });

  it('the reservation is durable before the call (a crash in the call still counts it spent)', async () => {
    triage.acceptTick = () => { throw new Error('crash'); };
    const t = seeded();
    await t.pump();
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).extraRunsToday).toBe(1);
  });

  it('min gap: a second extra tick waits 10 minutes; schedule exclusion ±2 min', async () => {
    const t = seeded();
    expect(await t.pump()).toBe('ticked');
    ticks.append({ source: 'triage', kind: 'tick', runId: 'run-1', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 30 });
    now += 60_000;
    expect(await t.pump()).toBe('waiting');
    now = localAt(10, 29, 0); // within 2 min of :30
    expect(nearScheduledTick(now)).toBe(true);
    evidence();
    expect(await t.pump()).toBe('near-schedule');
    now = localAt(10, 22, 30);
    expect(nearScheduledTick(now)).toBe(false);
    evidence();
    triage.answer = { status: 202, body: { runId: 'run-2' } };
    expect(await t.pump()).toBe('ticked');
  });

  it('at most maxExtraRunsPerDay a day; the audit rebuilds a lower state count', async () => {
    const t = seeded({ extraRunsToday: 12 });
    expect(await t.pump()).toBe('at-max');
    // State says 0 but the audit holds 3 reservations today: the higher count wins.
    const day = localDay(now);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'queue-pace-tuner.jsonl'), [1, 2, 3].map(() => JSON.stringify({ kind: 'reserve', day })).join('\n') + '\n');
    const t2 = seeded({ extraRunsToday: 0, steppedUp: true, lastEvalAt: now });
    cfg = { developmentAgent: true, queuePace: { tuner: { enabled: true, dryRun: false, maxExtraRunsPerDay: 3 } } };
    expect(await t2.pump()).toBe('at-max');
  });

  it('a dark agent (tuner never on) writes no tuner audit file at all', async () => {
    cfg = { developmentAgent: false };
    const t = mk();
    for (let i = 0; i < 3; i++) { expect(await t.pump()).toBe('off'); now += 60_000; }
    expect(fs.existsSync(path.join(dir, 'logs', 'queue-pace-tuner.jsonl'))).toBe(false);
  });

  it('the audit is read once per day (not every pass) and rows older than 30 days are dropped on that read', async () => {
    const day = localDay(now);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const old = JSON.stringify({ at: now - 40 * 24 * HOUR_MS, kind: 'outcome' });
    fs.writeFileSync(path.join(dir, 'logs', 'queue-pace-tuner.jsonl'), [old, JSON.stringify({ at: now - 60_000, kind: 'reserve', day })].join('\n') + '\n');
    const t = seeded({ steppedUp: true, lastEvalAt: now });
    await t.pump();
    const after = audit();
    expect(after.some((r) => r.at === now - 40 * 24 * HOUR_MS)).toBe(false);
    expect(after.filter((r) => r.kind === 'reserve' && r.day === day).length).toBeGreaterThanOrEqual(1);
    // A later pass the same day does not re-read: an injected row is not counted until tomorrow.
    fs.appendFileSync(path.join(dir, 'logs', 'queue-pace-tuner.jsonl'), Array.from({ length: 20 }, () => JSON.stringify({ kind: 'reserve', day })).join('\n') + '\n');
    now += 11 * 60_000;
    expect(await t.pump()).not.toBe('at-max');
  });

  it('the counter resets on a new local day', async () => {
    const t = seeded({ day: '2026-10-29', extraRunsToday: 12 });
    expect(await t.pump()).toBe('ticked');
  });

  it('quota margin: 10 points under the pause threshold (below 65%) or step down', async () => {
    triage.used = 64.9;
    expect(await seeded().pump()).toBe('ticked');
    triage.used = 65;
    triage.answer = { status: 202, body: { runId: 'run-2' } };
    const t = seeded({ steppedUp: true, lastEvalAt: now });
    expect(await t.pump()).toBe('step-down');
    triage.used = null;
    expect(await seeded({ steppedUp: true, lastEvalAt: now }).pump()).toBe('step-down');
  });

  it('a projected call cap steps down (no tuning against an operator-owned limit)', async () => {
    triage.callsToday = 9_999;
    expect(await seeded().pump()).toBe('step-down');
    expect(triage.calls).toBe(0);
  });

  it('owner not serving steps down', async () => {
    serving = false;
    expect(await seeded().pump()).toBe('step-down');
  });

  it('stale worker evidence at the re-check steps down', async () => {
    ticks = new QueuePaceTickLog(path.join(dir, 'logs', 'fresh-ticks.jsonl'), () => true, () => now);
    expect(await seeded().pump()).toBe('step-down');
  });

  it('tick-in-flight / rate-limited skip without a step-down; not-canonical-owner steps down', async () => {
    triage.answer = { status: 409, body: { error: 'tick-in-flight' } };
    const t = seeded();
    expect(await t.pump()).toBe('skipped-busy');
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).cooldownUntil).toBeNull();
    triage.answer = { status: 409, body: { error: 'not-canonical-owner' } };
    now += 11 * 60_000;
    evidence();
    expect(await t.pump()).toBe('step-down');
  });

  it('the outcome comes from the service-written tick row: a quota pause steps down', async () => {
    const t = seeded();
    expect(await t.pump()).toBe('ticked');
    now += 30_000;
    expect(await t.pump()).toBe('pending');
    ticks.append({ source: 'triage', kind: 'tick', runId: 'run-1', decided: 0, calls: 0, stopReason: 'quota-pause', queueDepthAfter: 40 });
    expect(await t.pump()).toBe('step-down');
    expect(audit().some((r) => r.kind === 'outcome' && r.stopReason === 'quota-pause')).toBe(true);
  });

  it('a non-worker evaluation steps down with a 6 h cooldown; step-up waits it out', async () => {
    const t = seeded();
    expect(await t.pump()).toBe('ticked');
    ticks.append({ source: 'triage', kind: 'tick', runId: 'run-1', decided: 2, calls: 1, stopReason: TIME_EXHAUSTED, queueDepthAfter: 30 });
    now += 20 * 60_000;
    ev = holding(now - 1);
    expect(await t.pump()).toBe('step-down');
    now += HOUR_MS;
    ev = worker(now - 1, 3);
    expect(await t.pump()).toBe('cooldown');
    now += COOLDOWN_MS;
    ev = worker(now - 1, 3);
    evidence();
    triage.answer = { status: 202, body: { runId: 'run-3' } };
    expect(await t.pump()).toBe('ticked');
  });

  it('records flag changes in the audit (the graduation trail)', async () => {
    cfg = { developmentAgent: true, queuePace: { tuner: { enabled: true } } };
    const t = seeded();
    await t.pump();
    cfg = { developmentAgent: true, queuePace: { tuner: { enabled: true, dryRun: false } } };
    await t.pump();
    const configs = audit().filter((r) => r.kind === 'config');
    expect(configs.map((r) => r.dryRun)).toEqual([true, false]);
  });

  it('view reports state for the route and notices', async () => {
    const t = seeded();
    await t.pump();
    expect(t.view()).toMatchObject({ enabled: true, dryRun: false, extraRunsToday: 1, state: 'speeding-up', atMax: false });
    expect(t.extraTicksAllowed()).toBe(11);
  });
});
