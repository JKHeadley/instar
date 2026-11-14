/**
 * MachineLoadAssessor — unit tier (trustworthy-machine-load B4, P4).
 * Spec: docs/specs/trustworthy-machine-load-and-mesh-floor.md §4 B4.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MachineLoadAssessor, detectLoadConflicts, readOutcome, gradeLabel, labelFromReferee,
  buildAssessmentState, summarizeLoadAssessmentLog, OUTCOME_WINDOW_MS, MACHINE_MIN_SPACING_MS,
  SAME_CONFLICT_COOLDOWN_MS,
} from '../../src/core/MachineLoadAssessor.js';
import type { MachineCapacity, IntelligenceProvider } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';

function report(over: Partial<MachineLoadReport> = {}): MachineLoadReport {
  return {
    bootId: 'boot-1', seq: 1, sampleAgeMs: 1000, platform: 'darwin', cores: 12, totalMemBytes: 64 * 2 ** 30,
    loadPerCore: 0.5, cpuIdlePct: 60, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 40,
    sessionsActive: 2, sessionsMax: 8, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'ok', uptimeS: 3600,
    ...over,
  };
}
function cap(over: Partial<MachineCapacity> = {}, rep: Partial<MachineLoadReport> = {}): MachineCapacity {
  return {
    machineId: 'm-peer', nickname: 'Mama PC', online: true, clockSkewStatus: 'ok',
    liveness: { state: 'live', evidenceAgeMs: 5000, evidenceAt: new Date().toISOString(), source: 'direct' },
    lastPullRttMs: 80, loadReport: report(rep), loadReportAgeMs: 5000, loadVerdict: rep.verdict ?? 'ok',
    ...over,
  } as MachineCapacity;
}
const unreachable = { state: 'unreachable', shape: 'struggling', lastFailure: 'timeout', evidenceAgeMs: 400_000, evidenceAt: null, source: 'direct' } as const;

function jevReply(choice: string, p: number) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 300 }, answers: { state: { choice, probabilities: { [choice]: p } } } }) }) as unknown as Response);
}

function setup(caps: () => MachineCapacity[], fetchImpl: unknown, extra: Partial<ConstructorParameters<typeof MachineLoadAssessor>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mla-unit-'));
  let t = Date.parse('2026-10-27T15:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const logPath = path.join(dir, 'logs', 'machine-load-assessment.jsonl');
  const a = new MachineLoadAssessor({
    getConfig: () => ({ enabled: true }), readKey: () => 'k', capacities: caps, isAssessor: () => true,
    logPath, fetchImpl: fetchImpl as never, now: clock.now, ...extra,
  });
  const rows = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { a, clock, rows, logPath };
}

describe('detectLoadConflicts — both sides of every boundary', () => {
  it('nothing to ask about on a healthy, reachable machine', () => {
    expect(detectLoadConflicts(cap())).toEqual([]);
  });
  it('own "ok" while requests to it fail (struggling) is a disagreement; silent is not', () => {
    expect(detectLoadConflicts(cap({ liveness: unreachable }))).toEqual(['own-ok-but-unreachable']);
    expect(detectLoadConflicts(cap({ liveness: { ...unreachable, shape: 'silent' } }))).toEqual([]);
    expect(detectLoadConflicts(cap({ liveness: unreachable }, { verdict: 'saturated' }))).toEqual([]);
  });
  it('own "impaired" while answering quickly is a disagreement; answering slowly is not', () => {
    expect(detectLoadConflicts(cap({}, { verdict: 'impaired' }))).toEqual(['own-impaired-but-answering']);
    expect(detectLoadConflicts(cap({ lastPullRttMs: 5000 }, { verdict: 'impaired' }))).toEqual([]);
  });
  it('the 2026-10-27 shape: memory reads available while the OS reports pressure', () => {
    expect(detectLoadConflicts(cap({}, { memAvailablePct: 41, memPressureNative: 'warn' }))).toEqual(['memory-free-but-os-pressure']);
    expect(detectLoadConflicts(cap({}, { memAvailablePct: 20, memPressureNative: 'warn' }))).toEqual([]);
    expect(detectLoadConflicts(cap({}, { memAvailablePct: 10, memPressureNative: 'normal' }))).toEqual(['memory-short-but-os-normal']);
  });
  it('idle CPU with a high load average (the macOS disk-wait inflation)', () => {
    expect(detectLoadConflicts(cap({}, { cpuIdlePct: 55, loadPerCore: 2.1 }))).toEqual(['cpu-idle-but-load-high']);
    expect(detectLoadConflicts(cap({}, { cpuIdlePct: 5, loadPerCore: 2.1 }))).toEqual([]);
  });
  it('a missing or too-old own report asks nothing', () => {
    expect(detectLoadConflicts(cap({ loadReport: undefined, liveness: unreachable }))).toEqual([]);
    expect(detectLoadConflicts(cap({ loadReportAgeMs: 11 * 60_000, liveness: unreachable }))).toEqual([]);
  });
});

describe('outcome and grade', () => {
  it('reads recovered / still-overloaded / timed-out / restarted / unknown', () => {
    expect(readOutcome(cap(), 'boot-1')).toBe('recovered');
    expect(readOutcome(cap({ loadVerdict: 'saturated' }), 'boot-1')).toBe('still-overloaded');
    expect(readOutcome(cap({ liveness: unreachable }), 'boot-1')).toBe('timed-out');
    expect(readOutcome(cap({}, { bootId: 'boot-2' }), 'boot-1')).toBe('restarted');
    expect(readOutcome(undefined, 'boot-1')).toBe('unknown');
  });
  it('healthy_busy is right only on recovery; trouble labels are right only without it', () => {
    expect(gradeLabel('healthy_busy', 'recovered')).toBe('right');
    expect(gradeLabel('healthy_busy', 'timed-out')).toBe('wrong');
    expect(gradeLabel('overloaded', 'still-overloaded')).toBe('right');
    expect(gradeLabel('network_problem', 'recovered')).toBe('wrong');
    expect(gradeLabel('cannot_tell', 'recovered')).toBe('unknown');
    expect(gradeLabel('impaired', 'unknown')).toBe('unknown');
  });
  it('the referee names a label only when exactly one statement is true', () => {
    expect(labelFromReferee({ healthy_busy: false, overloaded: true, impaired: false, network_problem: false })).toBe('overloaded');
    expect(labelFromReferee({ healthy_busy: true, overloaded: true, impaired: false, network_problem: false })).toBe('cannot_tell');
    expect(labelFromReferee({ healthy_busy: false, overloaded: false, impaired: false, network_problem: false })).toBe('cannot_tell');
  });
  it('the state carries numbers and fixed words, nothing else', () => {
    const s = buildAssessmentState(cap({ liveness: unreachable }), ['own-ok-but-unreachable']);
    expect(s).toContain('MACHINE: Mama PC');
    expect(s).toContain('memory available 50%');
    expect(s).toContain('unreachable (struggling)');
    expect(s).toContain('requests to it are failing');
  });
});

describe('MachineLoadAssessor', () => {
  it('labels a disagreement with Jev, then grades it after the outcome window', async () => {
    let c = cap({ liveness: unreachable });
    const fetchImpl = jevReply('overloaded', 0.9);
    const { a, clock, rows } = setup(() => [c], fetchImpl);
    await a.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const check = rows()[0];
    expect(check).toMatchObject({ kind: 'check', machineId: 'm-peer', label: 'overloaded', decidedBy: 'jev', conflicts: ['own-ok-but-unreachable'] });

    c = cap({ liveness: unreachable }); // still failing
    clock.advance(OUTCOME_WINDOW_MS + 1000);
    await a.tick();
    const outcome = rows().find((r) => r.kind === 'outcome');
    expect(outcome).toMatchObject({ id: check.id, outcome: 'timed-out', grade: 'right' });
    expect(a.summary()).toMatchObject({ checks: 1, grades: { right: 1, wrong: 0, unknown: 0 }, accuracy: 1 });
  });

  it('asks the Luna referee when Jev is unsure, and records who decided', async () => {
    const referee: IntelligenceProvider = { evaluate: vi.fn(async () => '{"healthy_busy": true, "overloaded": false, "impaired": false, "network_problem": false}') } as never;
    const { a, rows } = setup(() => [cap({}, { memAvailablePct: 41, memPressureNative: 'warn' })], jevReply('overloaded', 0.55), { referee });
    await a.tick();
    expect(referee.evaluate).toHaveBeenCalledTimes(1);
    expect(rows()[0]).toMatchObject({ jevLabel: 'overloaded', label: 'healthy_busy', decidedBy: 'referee' });
  });

  it('a confident Jev answer never calls the referee; a disabled referee is honoured', async () => {
    const referee: IntelligenceProvider = { evaluate: vi.fn(async () => '{}') } as never;
    const one = setup(() => [cap({}, { verdict: 'impaired' })], jevReply('impaired', 0.95), { referee });
    await one.a.tick();
    expect(referee.evaluate).not.toHaveBeenCalled();
    const two = setup(() => [cap({}, { verdict: 'impaired' })], jevReply('impaired', 0.5), { referee, getConfig: () => ({ enabled: true, referee: { enabled: false } }) });
    await two.a.tick();
    expect(referee.evaluate).not.toHaveBeenCalled();
    expect(two.rows()[0]).toMatchObject({ decidedBy: 'jev' });
  });

  it('asks once per machine within the spacing, and again for the same conflict only after the cooldown', async () => {
    const fetchImpl = jevReply('overloaded', 0.9);
    const { a, clock } = setup(() => [cap({ liveness: unreachable })], fetchImpl);
    await a.tick();
    clock.advance(MACHINE_MIN_SPACING_MS + 1000);
    await a.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.advance(SAME_CONFLICT_COOLDOWN_MS);
    await a.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does nothing when disabled, off the lease holder, or without a key', async () => {
    const fetchImpl = jevReply('overloaded', 0.9);
    await setup(() => [cap({ liveness: unreachable })], fetchImpl, { getConfig: () => ({ enabled: false }) }).a.tick();
    await setup(() => [cap({ liveness: unreachable })], fetchImpl, { isAssessor: () => false }).a.tick();
    const noKey = setup(() => [cap({ liveness: unreachable })], fetchImpl, { readKey: () => null });
    await noKey.a.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(noKey.rows()).toEqual([expect.objectContaining({ kind: 'skipped', reason: 'disabled-no-key' })]);
  });

  it('stops at the daily cap, and a vendor error is a skipped row, never a throw', async () => {
    const fetchImpl = jevReply('overloaded', 0.9);
    const capped = setup(() => [cap({ liveness: unreachable })], fetchImpl, { getConfig: () => ({ enabled: true, maxChecksPerDay: 0 }) });
    await capped.a.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(capped.rows()[0]).toMatchObject({ reason: 'daily-cap' });
    const failing = setup(() => [cap({ liveness: unreachable })], vi.fn(async () => { throw new Error('boom'); }));
    await expect(failing.a.tick()).resolves.toBeUndefined();
    expect(failing.rows()[0]).toMatchObject({ kind: 'skipped', reason: 'http-error' });
  });

  it('a restart closes labels it made before as unknown (seeded from the log, never biased by the restart)', async () => {
    const { a, clock, logPath } = setup(() => [cap({ liveness: unreachable })], jevReply('healthy_busy', 0.9));
    await a.tick();
    clock.advance(OUTCOME_WINDOW_MS + 1000);
    const again = new MachineLoadAssessor({
      getConfig: () => ({ enabled: true }), readKey: () => 'k', capacities: () => [cap()], isAssessor: () => false,
      logPath, now: clock.now,
    });
    await again.tick();
    // A label from before this process started is graded unknown, never right/wrong:
    // the restart itself (a new bootId, peers reading stale until the first pull)
    // would otherwise bias the accuracy.
    expect(summarizeLoadAssessmentLog(logPath, true).grades).toEqual({ right: 0, wrong: 0, unknown: 1 });
    expect(summarizeLoadAssessmentLog(logPath, true).outcomes).toEqual({ unknown: 1 });
  });
});
