/**
 * WedgeMonitor (machine-self-maintenance Part E, dry-run) and the evidence readers:
 * unknown stays unknown on every platform, the host maintainer is the only sampler,
 * the judge runs once per wedge condition and only when allowed, the notice is off by
 * default and bounded when on, and a restart cannot re-page the operator.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { PROBE_EXIT_GRACE_MS, makeProbeRunner, type ExecLike, type ProbeResult, type ReadingName } from '../../src/monitoring/machineMaintenance/readings.js';
import { readF1, readF2, readF4, risingOverThree, uninterruptibleCount } from '../../src/monitoring/machineMaintenance/wedgeEvidence.js';
import {
  JUDGE_MAX_PER_DAY, WedgeMonitor, normalizeWedgeSettings, type WedgeJudgeEvidence, type WedgeMonitorDeps, type WedgeNoticeInput, type WedgeSettings,
} from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';

const MIN = 60_000;
const ok = (stdout: string, ms = 20): ProbeResult => ({ ok: true, stdout, ms, timedOut: false, code: null });
const timedOut = (ms = 5000): ProbeResult => ({ ok: false, stdout: null, ms, timedOut: true, code: null });
const failed = (code: string | number): ProbeResult => ({ ok: false, stdout: null, ms: 5, timedOut: false, code });

describe('evidence readers', () => {
  it('F2: a timed-out ps and a fork failure are positive; another failure is unknown, not negative', () => {
    expect(readF2({ platform: 'linux', ps: timedOut(), priorCounts: [] }).reading).toMatchObject({ result: 'positive', reason: 'ps-timed-out' });
    expect(readF2({ platform: 'linux', ps: failed('EAGAIN'), priorCounts: [] }).reading).toMatchObject({ result: 'positive', reason: 'fork-failure' });
    expect(readF2({ platform: 'linux', ps: failed('EPERM'), priorCounts: [] }).reading.result).toBe('unknown');
  });

  it('F2: uninterruptible processes rising over three readings is positive; flat or falling is negative', () => {
    expect(uninterruptibleCount('S\nD\nDs\nR+\n', 'linux')).toBe(2);
    expect(uninterruptibleCount('S\nU\nD\n', 'darwin')).toBe(1);
    expect(risingOverThree([1, 2, 3])).toBe(true);
    expect(risingOverThree([1, 2, 2])).toBe(false);
    expect(risingOverThree([2, 3])).toBe(false);
    expect(readF2({ platform: 'linux', ps: ok('D\nD\nD\n'), priorCounts: [1, 2] }).reading.result).toBe('positive');
    expect(readF2({ platform: 'linux', ps: ok('D\nD\n'), priorCounts: [1, 2] }).reading.result).toBe('negative');
  });

  it('F2 on WSL: a timed-out Windows process table is positive', () => {
    expect(readF2({ platform: 'wsl', ps: ok('S\n'), priorCounts: [], tasklist: timedOut() }).reading).toMatchObject({ result: 'positive', reason: 'tasklist-timed-out' });
  });

  it('F1: macOS is unread in this build (unknown), and locked is ineligible, never positive', () => {
    expect(readF1({ platform: 'darwin', probe: null, passedSinceBoot: true }).reading).toMatchObject({ result: 'unknown', reason: 'canary-not-shipped' });
    expect(readF1({ platform: 'darwin', probe: null, passedSinceBoot: true, lockState: 'locked' }).reading.result).toBe('ineligible');
  });

  it('F1 on Linux: a failure before the probe ever passed this boot is ineligible; after it passed, positive; a missing tool is unknown', () => {
    expect(readF1({ platform: 'linux', probe: timedOut(), passedSinceBoot: false }).reading.result).toBe('ineligible');
    expect(readF1({ platform: 'linux', probe: timedOut(), passedSinceBoot: true }).reading).toMatchObject({ result: 'positive', reason: 'probe-timed-out' });
    expect(readF1({ platform: 'linux', probe: failed(1), passedSinceBoot: true }).reading.result).toBe('positive');
    expect(readF1({ platform: 'linux', probe: failed('ENOENT'), passedSinceBoot: true }).reading.result).toBe('unknown');
    expect(readF1({ platform: 'linux', probe: ok(''), passedSinceBoot: false })).toMatchObject({ reading: { result: 'negative' }, passed: true });
    expect(readF1({ platform: 'other', probe: null, passedSinceBoot: false }).reading.result).toBe('unknown');
  });

  it('F4: impaired or lagging while idle is positive; busy is negative; stale or missing is unknown', () => {
    const fresh = { sampleAgeMs: 10_000 };
    expect(readF4({ load: { verdict: 'impaired', cpuIdlePct: 30, eventLoopLagP99Ms: 50, ...fresh }, spawnSystemFailures30m: null }).result).toBe('positive');
    expect(readF4({ load: { verdict: 'impaired', cpuIdlePct: 29, eventLoopLagP99Ms: 50, ...fresh }, spawnSystemFailures30m: null })).toMatchObject({ result: 'negative', reason: 'cpu-busy-not-wedged' });
    expect(readF4({ load: { verdict: 'ok', cpuIdlePct: 80, eventLoopLagP99Ms: 1000, ...fresh }, spawnSystemFailures30m: null }).result).toBe('positive');
    expect(readF4({ load: { verdict: 'ok', cpuIdlePct: 80, eventLoopLagP99Ms: 999, ...fresh }, spawnSystemFailures30m: null }).result).toBe('negative');
    expect(readF4({ load: { verdict: 'impaired', cpuIdlePct: 80, eventLoopLagP99Ms: 50, sampleAgeMs: 60_001 }, spawnSystemFailures30m: null }).result).toBe('unknown');
    expect(readF4({ load: null, spawnSystemFailures30m: null }).result).toBe('unknown');
    expect(readF4({ load: { verdict: 'ok', cpuIdlePct: null, eventLoopLagP99Ms: 0, ...fresh }, spawnSystemFailures30m: null }).result).toBe('unknown');
    expect(readF4({ load: null, spawnSystemFailures30m: 2 }).result).toBe('positive');
    expect(readF4({ load: null, spawnSystemFailures30m: 1 }).result).toBe('unknown');
  });
});

describe('settings', () => {
  it('dry-run defaults true and the notice defaults off; only an explicit false or true changes them', () => {
    expect(normalizeWedgeSettings(undefined)).toEqual({ dryRun: true, dryRunNotice: false });
    expect(normalizeWedgeSettings({ dryRun: 'no', dryRunNotice: 'yes' })).toEqual({ dryRun: true, dryRunNotice: false });
    expect(normalizeWedgeSettings({ dryRun: false, dryRunNotice: true })).toEqual({ dryRun: false, dryRunNotice: true });
  });
});

describe('WedgeMonitor', () => {
  let dir: string;
  let clock: number;
  let judgeCalls: WedgeJudgeEvidence[];
  let notices: WedgeNoticeInput[];
  let psResult: () => ProbeResult;
  let load: () => { verdict: string; cpuIdlePct: number | null; eventLoopLagP99Ms: number | null; sampleAgeMs: number } | null;
  let settings: WedgeSettings;
  let bootAt: number | null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wedge-'));
    clock = Date.parse('2026-11-03T12:00:00Z');
    judgeCalls = [];
    notices = [];
    psResult = () => timedOut();
    load = () => ({ verdict: 'impaired', cpuIdlePct: 70, eventLoopLagP99Ms: 2000, sampleAgeMs: 5000 });
    settings = { dryRun: true, dryRunNotice: false };
    bootAt = clock - 3 * 24 * 60 * MIN;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-wedge-monitor.test.ts' }));

  function make(agent = 'echo', over: Partial<WedgeMonitorDeps> = {}): WedgeMonitor {
    return new WedgeMonitor({
      agentName: agent,
      machineId: () => 'm_test',
      platform: 'linux',
      logPath: path.join(dir, agent, 'logs', 'machine-maintenance.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      enabled: () => true,
      settings: () => settings,
      probe: async (name: ReadingName) => (name === 'processStates' ? psResult() : failed('ENOENT')),
      readBootAt: async () => bootAt,
      loadReading: () => load(),
      spawnSystemFailures30m: () => null,
      sessionsCount: () => 3,
      nextWindowRestartAt: (now) => now + 15 * 60 * MIN,
      judge: async (e) => { judgeCalls.push(e); return { action: 'gentle', reason: 'two families positive' }; },
      raiseNotice: async (n) => { notices.push(n); return 'sent'; },
      now: () => clock,
      ...over,
    });
  }

  /** Tick every 2 minutes for `minutes`. */
  async function run(m: WedgeMonitor, minutes: number): Promise<void> {
    for (let t = 0; t <= minutes; t += 2) { await m.tick(); clock += 2 * MIN; }
  }

  const audit = (agent = 'echo') => {
    const file = path.join(dir, agent, 'logs', 'machine-maintenance.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };

  it('before any sample every family is unknown, never negative or healthy', () => {
    const st = make().status() as any;
    expect(st).toMatchObject({ canRestart: false, canStopWork: false, actuation: 'not-built', dryRun: true, noticeEnabled: false });
    expect(st.families).toBeNull();
  });

  it('two families positive for 20 minutes form one candidate, the judge runs once, its proposal is recorded and nothing runs', async () => {
    const m = make();
    await run(m, 30);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]).toMatchObject({ pair: 'F2+F4', blockers: ['enrolment-not-built'], sessionsCount: 3, recentlyRestarted: false });
    expect(JSON.stringify(judgeCalls[0])).not.toMatch(/stdout|title|dialog/i);
    const st = m.status() as any;
    expect(st.role).toBe('maintainer');
    expect(st.families.F1).toMatchObject({ result: 'unknown', reason: 'probe-missing' });
    expect(st.families.F3.result).toBe('not-covered');
    expect(st.lastVerdict).toMatchObject({ source: 'judge', proposal: 'gentle', wouldRunRungs: [1, 2, 3], ranRungs: [], notice: 'disabled' });
    expect(st.forcedDueAt).not.toBeNull();
    const rows = audit();
    expect(rows.filter((r) => r.type === 'wedge-candidate')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'wedge-verdict')).toHaveLength(1);
    expect(rows.every((r) => r.dryRun === true && r.feature === 'wedge')).toBe(true);
    expect(notices).toHaveLength(0);
  });

  it('the notice is sent once per condition when its flag is on, and not again after a server restart', async () => {
    settings = { dryRun: true, dryRunNotice: true };
    const m = make();
    await run(m, 30);
    expect(notices).toHaveLength(1);
    // A restart: a fresh monitor (fresh window) on the same host store, evidence still positive.
    const again = make();
    await run(again, 60);
    expect(notices).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    expect(audit().filter((r) => r.type === 'wedge-candidate').length).toBeGreaterThanOrEqual(2);
  });

  it('a real negative closes the condition; a later wedge is a new condition, but a second ordinary notice waits 24 hours', async () => {
    settings = { dryRun: true, dryRunNotice: true };
    const m = make();
    await run(m, 30);
    psResult = () => ok('S\n');
    await run(m, 4);
    expect((m.status() as any).condition).toBeNull();
    psResult = () => timedOut();
    await run(m, 30);
    expect(judgeCalls).toHaveLength(2);
    expect(notices).toHaveLength(1);
    expect((m.status() as any).lastVerdict.notice).toBe('rate-limited');
  });

  it('a judge that answers nonsense or throws records the deterministic fallback, never a restart', async () => {
    const m = make('echo', { judge: async () => { throw new Error('provider down'); } });
    await run(m, 30);
    expect((m.status() as any).lastVerdict).toMatchObject({ source: 'fallback', fallbackReason: 'judge-error', proposal: null, wouldRunRungs: [1, 2, 3], ranRungs: [] });
  });

  it('a recent boot caps the outcome at a notice', async () => {
    bootAt = clock - 60 * MIN;
    const m = make('echo', { judge: async () => ({ action: 'restart-now', reason: 'x' }) });
    await run(m, 30);
    expect((m.status() as any).lastVerdict).toMatchObject({ proposal: 'restart-now', cappedAtNotice: true, wouldRunRungs: [], recentlyRestarted: true });
  });

  it('an unknown boot time stays unknown and caps the outcome like a recent restart: no rungs 1–5 recorded', async () => {
    bootAt = null;
    const m = make('echo', { judge: async () => ({ action: 'restart-now', reason: 'x' }) });
    await run(m, 30);
    expect((m.status() as any).lastVerdict).toMatchObject({
      recentlyRestarted: null, bootTime: 'unknown', cappedAtNotice: true, cappedBecause: 'boot-time-unknown', proposal: 'restart-now', wouldRunRungs: [], wouldRunIfStillUp: [],
    });
    const known = make('groky', { judge: async () => ({ action: 'restart-now', reason: 'x' }) });
    expect(known).toBeTruthy(); // the known-boot side is the 'two families positive…' and 'recent boot' cases above
  });

  it('the judge call and the open condition are durable BEFORE the judge is awaited, so a crash or takeover mid-call never asks twice', async () => {
    const hostDir = path.join(dir, 'host');
    let seenMidCall: any = null;
    const m = make('echo', {
      judge: async (e) => {
        judgeCalls.push(e);
        // What a restarted or taking-over agent would read from disk at this instant.
        seenMidCall = JSON.parse(fs.readFileSync(path.join(hostDir, 'wedge-state.json'), 'utf-8')).durable;
        return { action: 'gentle', reason: 'x' };
      },
    });
    await run(m, 30);
    expect(seenMidCall.judgeCalls).toHaveLength(1);
    expect(seenMidCall.condition).toMatchObject({ pair: 'F2+F4', judgedAt: expect.any(Number) });
    // A crash right then: a fresh monitor on the same host store, evidence still positive, never calls the judge again.
    const restarted = make('echo');
    await run(restarted, 40);
    expect(judgeCalls).toHaveLength(1);
  });

  it('one family alone never calls the judge; after 2 hours it marks the next window due early', async () => {
    load = () => ({ verdict: 'ok', cpuIdlePct: 90, eventLoopLagP99Ms: 10, sampleAgeMs: 5000 });
    const m = make();
    await run(m, 118);
    expect((m.status() as any).forcedDueAt).toBeNull();
    await run(m, 4);
    expect(judgeCalls).toHaveLength(0);
    expect((m.status() as any).forcedDueAt).not.toBeNull();
    expect(audit().some((r) => r.type === 'wedge-single-family' && r.family === 'F2')).toBe(true);
  });

  it('only the host maintainer samples; a co-resident agent observes its published state and calls no judge', async () => {
    const a = make('echo');
    const b = make('groky');
    for (let t = 0; t <= 30; t += 2) { await a.tick(); await b.tick(); clock += 2 * MIN; }
    expect(judgeCalls).toHaveLength(1);
    const st = b.status() as any;
    expect(st).toMatchObject({ role: 'observer', maintainer: 'echo', snapshotFrom: 'echo' });
    expect(st.snapshotAgeMs).toBeGreaterThanOrEqual(0);
    expect(st.lastVerdict.proposal).toBe('gentle');
    expect(audit('groky')).toHaveLength(0);
  });

  it('a stale maintainer heartbeat (over 10 minutes) lets another agent take over with the inherited condition', async () => {
    const a = make('echo');
    await run(a, 30);
    clock += 11 * MIN;
    const b = make('groky');
    await run(b, 40);
    expect((b.status() as any).role).toBe('maintainer');
    // Same condition, inherited from the host store: no second judge call.
    expect(judgeCalls).toHaveLength(1);
  });

  it('the judge budget is capped per 24 hours across conditions', async () => {
    const m = make();
    for (let i = 0; i < JUDGE_MAX_PER_DAY + 2; i++) {
      psResult = () => timedOut();
      await run(m, 24);
      psResult = () => ok('S\n');
      await run(m, 2);
    }
    expect(judgeCalls).toHaveLength(JUDGE_MAX_PER_DAY);
    expect(audit().filter((r) => r.type === 'wedge-verdict' && r.fallbackReason === 'judge-daily-cap').length).toBe(2);
  });

  it('a new boot clears the condition and forcedDueAt', async () => {
    const m = make();
    await run(m, 30);
    expect((m.status() as any).forcedDueAt).not.toBeNull();
    bootAt = clock;
    psResult = () => ok('S\n');
    await run(m, 0);
    expect((m.status() as any)).toMatchObject({ forcedDueAt: null, condition: null });
  });

  it('a probe child that never exits (stuck in the kernel) still yields a completed sample, and the next tick runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const spawned: string[] = [];
      const neverExits: ExecLike = (command) => { spawned.push(command); return undefined; }; // never calls back
      const m = make('echo', { probe: makeProbeRunner(neverExits) });
      const first = m.tick();
      await vi.advanceTimersByTimeAsync(10_000 + PROBE_EXIT_GRACE_MS + 50);
      await first;
      let st = m.status() as any;
      expect(st.samples).toBe(1);
      expect(st.families.F2).toMatchObject({ result: 'positive', reason: 'ps-timed-out' });
      // systemd-run timed out too, but it never passed this boot, so it is ineligible rather than positive.
      expect(st.families.F1.result).toBe('ineligible');
      clock += 2 * MIN;
      const second = m.tick();
      await vi.advanceTimersByTimeAsync(10_000 + PROBE_EXIT_GRACE_MS + 50);
      await second;
      st = m.status() as any;
      expect(st.samples).toBe(2);
      expect(st.families.F2).toMatchObject({ result: 'positive', reason: 'ps-timed-out' });
      // The stuck children are still out there, so none is started again: at most one per probe.
      expect(spawned.sort()).toEqual(['ps', 'systemd-run']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the runner settles a never-exiting child within its timeout plus the grace, with SIGKILL asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let signal: string | null = null;
      const run = makeProbeRunner((_c, _a, options) => { signal = options.killSignal; return undefined; });
      let result: ProbeResult | null = null;
      void run('processStates', 1000).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(1000 + PROBE_EXIT_GRACE_MS - 1);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(2);
      expect(result).toMatchObject({ ok: false, timedOut: true, code: 'no-exit' });
      expect(signal).toBe('SIGKILL');
      expect(await run('processStates', 1000)).toMatchObject({ timedOut: true, code: 'previous-still-running' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a probe that never settles at all is still bounded by the monitor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const m = make('echo', { probe: () => new Promise<ProbeResult>(() => undefined) });
      const t = m.tick();
      await vi.advanceTimersByTimeAsync(13_000);
      await t;
      expect((m.status() as any).families.F2).toMatchObject({ result: 'positive', reason: 'ps-timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('dark: a disabled gate samples nothing', async () => {
    const m = make('echo', { enabled: () => false });
    await run(m, 30);
    expect(judgeCalls).toHaveLength(0);
    expect((m.status() as any).role).toBe('off');
    expect(audit()).toHaveLength(0);
  });
});
