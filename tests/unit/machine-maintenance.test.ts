/**
 * Unit: machine self-maintenance, watch-only (docs/specs/machine-self-maintenance.md).
 * Planner arithmetic, the host drain record, the readings, and the nightly rehearsal
 * driven tick by tick with a fake clock. Real files, fake readings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  DEFAULT_MACHINE_MAINTENANCE as D, DELAYS, DRAIN_PHASES, currentPhase, isDue, isFinalNight, normalizeSettings, stepDelays, windowFor,
} from '../../src/monitoring/machineMaintenance/planner.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import {
  foreignTmuxSessions, parseBootTime, parseHidIdleMs, parsePmsetBattery, parseWhoIdle, readOwnerPresent, readSafetyHolds, readMachineSignals, makeReadOnlyRunner, type MachineSignals,
} from '../../src/monitoring/machineMaintenance/readings.js';
import { WORK_YIELD_REGISTRY, discoverWork, type WorkCensusInputs } from '../../src/monitoring/machineMaintenance/WorkYieldRegistry.js';
import { DrainRehearsal, percentile, readHostCensus } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m, 0, 0).getTime();

describe('planner', () => {
  it('commits T-0 an hour after the window opens, machine-local', () => {
    const w = windowFor(local(10, 12), D.window);
    expect(w.start).toBe(local(11, 3));
    expect(w.restartAt).toBe(local(11, 4));
    expect(w.end).toBe(local(11, 6));
  });

  it('stays on the window in progress, and moves on once it ends', () => {
    expect(windowFor(local(11, 5), D.window).restartAt).toBe(local(11, 4));
    expect(windowFor(local(11, 6), D.window).restartAt).toBe(local(12, 4));
  });

  it('handles a window crossing midnight, from either side of it', () => {
    const cross = { start: '23:00', end: '02:00' };
    expect(windowFor(local(11, 1), cross).restartAt).toBe(local(11, 0));
    expect(windowFor(local(11, 12), cross).restartAt).toBe(local(12, 0));
  });

  it('is due at the cadence and final one day before the maximum, each on both sides', () => {
    const boot = local(1, 0);
    expect(isDue(boot + 7 * DAY - 1, boot, D)).toBe(false);
    expect(isDue(boot + 7 * DAY, boot, D)).toBe(true);
    expect(isFinalNight(boot + 9 * DAY - 1, boot, D)).toBe(false);
    expect(isFinalNight(boot + 9 * DAY, boot, D)).toBe(true);
  });

  it('falls back on out-of-range settings instead of throwing', () => {
    expect(normalizeSettings({ cadenceDays: 1 }).cadenceDays).toBe(7);
    expect(normalizeSettings({ cadenceDays: 12 }).maxIntervalDays).toBe(13);
    expect(normalizeSettings({ window: { start: '03:00', end: '04:00' } }).window).toEqual(D.window);
    expect(normalizeSettings({ window: { start: 'x', end: '04:00' } }).window).toEqual(D.window);
    expect(normalizeSettings(null)).toEqual(D);
  });

  it('runs the drain sequence at its offsets, and phases shift with T-0', () => {
    expect(DRAIN_PHASES.map((p) => p.offsetMinutes)).toEqual([70, 60, 45, 20, 10, 5, 2, 0]);
    const t0 = local(11, 4);
    expect(currentPhase(t0 - 71 * MIN, t0)).toBeNull();
    expect(currentPhase(t0 - 70 * MIN, t0)).toBe('reserve');
    expect(currentPhase(t0 - 19 * MIN, t0)).toBe('checkpoint');
    expect(currentPhase(t0, t0)).toBe('restart');
    expect(currentPhase(t0, t0 + 25 * MIN)).toBe('move');
  });

  const base = { restartAt: local(11, 4), originalRestartAt: local(11, 4), windowEnd: local(11, 6), used: {}, active: [] as string[], final: false, maxEpisodeDelayMinutes: 120 };

  it('holds T-0 five minutes for an active delay and does nothing without one', () => {
    expect(stepDelays(base).outcome).toBe('clear');
    const held = stepDelays({ ...base, active: ['D1'] });
    expect(held.outcome).toBe('hold');
    expect(held.restartAt).toBe(base.restartAt + 5 * MIN);
    expect(held.used.D1).toBe(5);
  });

  it('refuses a delay outside the closed list, so an agent cannot add one', () => {
    const r = stepDelays({ ...base, active: ['D9', 'custom'] });
    expect(r.outcome).toBe('clear');
    expect(r.refused).toEqual(['D9', 'custom']);
    expect(r.restartAt).toBe(base.restartAt);
  });

  it('holds each delay up to its maximum and rolls just past it', () => {
    expect(stepDelays({ ...base, active: ['D1'], used: { D1: 55 } }).outcome).toBe('hold');
    const rolled = stepDelays({ ...base, active: ['D1'], used: { D1: 60 } });
    expect(rolled.outcome).toBe('roll');
    expect(rolled.rollBecause).toBe('D1');
  });

  it('lets a proceed-at-maximum delay stop holding instead of rolling', () => {
    expect(stepDelays({ ...base, active: ['D4'], used: { D4: 30 } }).outcome).toBe('clear');
    expect(stepDelays({ ...base, active: ['D5'], used: { D5: 30 } }).outcome).toBe('clear');
  });

  it('enforces the total ceiling and the window end across stacked delays, with a rolling delay winning', () => {
    const ceiling = stepDelays({ ...base, restartAt: base.restartAt + 120 * MIN, windowEnd: local(11, 9), active: ['D4', 'D2'], used: { D2: 10 } });
    expect(ceiling.outcome).toBe('roll');
    expect(ceiling.rollBecause).toBe('D2');
    const onlyProceeds = stepDelays({ ...base, restartAt: base.restartAt + 120 * MIN, windowEnd: local(11, 9), active: ['D4'] });
    expect(onlyProceeds.outcome).toBe('clear');
    const windowEnd = stepDelays({ ...base, restartAt: local(11, 6), active: ['D1'] });
    expect(windowEnd.outcome).toBe('roll');
  });

  it('on the final night proceeds through D1, D2, D3, D6 and D7 at their maximum', () => {
    for (const id of ['D1', 'D2', 'D3', 'D6', 'D7'] as const) {
      const r = stepDelays({ ...base, final: true, active: [id], used: { [id]: DELAYS[id].maxMinutes } });
      expect(r.outcome, id).toBe('clear');
      expect(stepDelays({ ...base, final: false, active: [id], used: { [id]: DELAYS[id].maxMinutes } }).outcome, id).toBe('roll');
    }
  });
});

describe('HostMaintenanceStore', () => {
  let dir: string;
  let now = 0;
  const input = { openedBy: 'a', restartAt: 1_000_000, windowEnd: 2_000_000, final: false, maxEpisodeDelayMinutes: 120 };
  const make = () => new HostMaintenanceStore({ dir, now: () => now });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-store-')); now = 1000; });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance.test.ts' }));

  it('opens one episode that a second agent joins, and any store can read it with no lock', () => {
    const first = make().reserve(input)!;
    const second = make().reserve({ ...input, openedBy: 'b' })!;
    expect(first.opened).toBe(true);
    expect(second.opened).toBe(false);
    expect(second.plan.episodeId).toBe(first.plan.episodeId);
    expect(make().readPlan()?.watchOnly).toBe(true);
  });

  it('refuses a stale generation or another episode', () => {
    const { plan } = make().reserve(input)!;
    expect(make().update(plan.episodeId, plan.generation + 1, (p) => p)).toBeNull();
    expect(make().update('other', plan.generation, (p) => p)).toBeNull();
    expect(make().update(plan.episodeId, plan.generation, (p) => ({ ...p, holds: ['S3'] }))?.holds).toEqual(['S3']);
  });

  it('cannot be made to write a record that is not watch-only', () => {
    const { plan } = make().reserve(input)!;
    make().update(plan.episodeId, plan.generation, (p) => ({ ...p, watchOnly: false as unknown as true }));
    expect(make().readPlan()?.watchOnly).toBe(true);
  });

  it('ignores an expired, closed or malformed record, and bumps the generation after it', () => {
    const { plan } = make().reserve(input)!;
    now = plan.expiresAt;
    expect(make().readPlan()).toBeNull();
    const next = make().reserve({ ...input, restartAt: now + 1000 })!;
    expect(next.opened).toBe(true);
    expect(next.plan.generation).toBe(plan.generation + 1);
    fs.writeFileSync(path.join(dir, 'plan.json'), '{nope');
    expect(make().readPlan()).toBeNull();
  });

  it('reads back only acks of this exact episode and generation, and refuses an unsafe agent name', () => {
    const store = make();
    const ack = { episodeId: 'e1', generation: 2, bootTime: 1, state: 'draining' as const, delaysClaimed: [], yields: {}, version: 'v', at: 1 };
    expect(store.writeAck('../evil', ack)).toBe(false);
    store.writeAck('echo', ack);
    store.writeAck('old', { ...ack, generation: 1 });
    expect(Object.keys(store.readAcks('e1', 2))).toEqual(['echo']);
  });
});

describe('readings', () => {
  const signals = (over: Partial<MachineSignals> = {}): MachineSignals => ({
    lastBootAt: 1, inputIdleMs: 60 * MIN, ttyUsers: [], processes: [], onBattery: false, batteryPercent: null, tmuxSessions: [], ...over,
  });
  const active = (s: MachineSignals, id: string) => readSafetyHolds(s, 'me').find((h) => h.id === id)!.active;

  it('parses the real macOS and Linux shapes', () => {
    expect(parseBootTime('{ sec = 1793568452, usec = 748413 } Sun Nov  1 13:27:32 2026')).toBe(1793568452000);
    expect(parseHidIdleMs('    | |     "HIDIdleTime" = 4703936395208')).toBe(4703936);
    expect(parseWhoIdle('dabombstudio     console      Nov  1 13:31 01:27      170')).toEqual([{ user: 'dabombstudio', idleMs: 87 * MIN }]);
    expect(parseWhoIdle('sam tty1 2026-11-01 13:31   .   170')).toEqual([{ user: 'sam', idleMs: 0 }]);
    expect(parsePmsetBattery("Now drawing from 'AC Power'")).toEqual({ onBattery: false, percent: null });
    expect(parsePmsetBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 42%; discharging")).toEqual({ onBattery: true, percent: 42 });
  });

  it('S1 and S2 read a named operation and not its neighbours', () => {
    expect(active(signals({ processes: ['/usr/sbin/softwareupdate --install --all'] }), 'S1')).toBe(true);
    expect(active(signals({ processes: ['/usr/bin/dpkg --configure -a'] }), 'S1')).toBe(true);
    expect(active(signals({ processes: ['/usr/sbin/softwareupdated', 'vim dpkg.txt', 'softwareupdate --list'] }), 'S1')).toBe(false);
    expect(active(signals({ processes: ['/sbin/fsck_apfs -y /dev/disk3'] }), 'S2')).toBe(true);
    expect(active(signals({ processes: ['diskutil repairVolume disk3'] }), 'S2')).toBe(true);
    expect(active(signals({ processes: ['diskutil list'] }), 'S2')).toBe(false);
  });

  it('S3 needs a person now, and an idle login is no hold', () => {
    expect(active(signals({ inputIdleMs: 4 * MIN }), 'S3')).toBe(true);
    expect(active(signals({ inputIdleMs: 6 * MIN }), 'S3')).toBe(false);
    expect(active(signals({ ttyUsers: [{ user: 'other', idleMs: 14 * MIN }] }), 'S3')).toBe(true);
    expect(active(signals({ ttyUsers: [{ user: 'other', idleMs: 16 * MIN }] }), 'S3')).toBe(false);
    expect(active(signals({ ttyUsers: [{ user: 'me', idleMs: 0 }] }), 'S3')).toBe(false);
  });

  it('S4 needs battery power under half', () => {
    expect(active(signals({ onBattery: true, batteryPercent: 49 }), 'S4')).toBe(true);
    expect(active(signals({ onBattery: true, batteryPercent: 50 }), 'S4')).toBe(false);
    expect(active(signals({ onBattery: false, batteryPercent: 10 }), 'S4')).toBe(false);
  });

  it('an unreadable source is no hold, and marks every hold unproven', () => {
    const holds = readSafetyHolds(signals({ inputIdleMs: null, processes: null, onBattery: null }), 'me');
    expect(holds.every((h) => !h.active && !h.provenLive)).toBe(true);
  });

  it('D1 reads unreadable presence as present on a Mac, and uses ttys on Linux', () => {
    expect(readOwnerPresent(signals({ inputIdleMs: 14 * MIN }), 'me', 'darwin').active).toBe(true);
    expect(readOwnerPresent(signals({ inputIdleMs: 16 * MIN }), 'me', 'darwin').active).toBe(false);
    expect(readOwnerPresent(signals({ inputIdleMs: null }), 'me', 'darwin').active).toBe(true);
    expect(readOwnerPresent(signals({ inputIdleMs: null }), 'me', 'linux').active).toBe(false);
    expect(readOwnerPresent(signals({ inputIdleMs: null, ttyUsers: [{ user: 'me', idleMs: 0 }] }), 'me', 'linux').active).toBe(true);
  });

  it('finds tmux sessions that belong to no agent, leaving out agents and arm sessions', () => {
    expect(foreignTmuxSessions(['echo-x', 'groky-server', 'desk-runner', 'instar-codex-arm-1', 'mine'], ['mine'], ['echo', 'groky'])).toEqual(['desk-runner']);
    expect(foreignTmuxSessions(null, [], [])).toBeNull();
  });

  it('runs only named calls, with no way to pass arguments', async () => {
    const run = makeReadOnlyRunner();
    await expect(run('killServer' as never)).rejects.toThrow(/not a read-only call/);
    expect(run.length).toBe(1);
  });

  it('survives every source failing', async () => {
    const s = await readMachineSignals(async () => null, 'darwin');
    expect(s).toMatchObject({ inputIdleMs: null, processes: null, tmuxSessions: null, ttyUsers: [] });
  });

  it('reads the census, without lifeline rows or stale entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-'));
    const file = path.join(dir, 'registry.json');
    const fresh = new Date(1000 * MIN).toISOString();
    fs.writeFileSync(file, JSON.stringify([
      { name: 'echo', status: 'running', lastHeartbeat: fresh }, { name: 'echo-lifeline', status: 'running', lastHeartbeat: fresh },
      { name: 'dead', status: 'stopped', lastHeartbeat: fresh }, { name: 'old', status: 'running', lastHeartbeat: new Date(MIN).toISOString() },
    ]));
    expect(readHostCensus(file, 1000 * MIN)).toEqual(['echo']);
    expect(readHostCensus(path.join(dir, 'none.json'), 0)).toEqual([]);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance.test.ts' });
  });
});

describe('WorkYieldRegistry', () => {
  it('finds each declared kind from its reading', () => {
    const kinds = discoverWork({
      sessions: [{ name: 's', tmuxSession: 't1', topicId: 7, atBoundary: false }, { name: 'j', tmuxSession: 't2', jobSlug: 'daily', atBoundary: null }],
      autonomousRuns: [{ topic: '7' }],
      localVerifyRunning: [{ pr: 1, headSha: 'a' }],
      localVerifyQueued: [{ pr: 2 }],
      testRuns: [{ pid: 9, acquiredAt: 1, lane: 'suite' }, { pid: 8, acquiredAt: 1, lane: 'targeted' }],
      scriptRuns: ['r1'],
    }).map((w) => w.kind).sort();
    expect(kinds).toEqual(WORK_YIELD_REGISTRY.map((e) => e.kind).sort());
  });
});

describe('DrainRehearsal', () => {
  let dir: string;
  let now: number;
  let signals: MachineSignals;
  let census: WorkCensusInputs;
  let boundaryReads: boolean[];
  let agents: string[];
  const t0 = local(11, 4);
  const empty = (): WorkCensusInputs => ({ sessions: [], autonomousRuns: [], localVerifyRunning: [], localVerifyQueued: [], testRuns: [], scriptRuns: [] });

  const make = (agentName = 'echo') => new DrainRehearsal({
    agentName, version: '1.0.0', stateDir: path.join(dir, agentName), logPath: path.join(dir, agentName, 'logs', 'machine-drain.jsonl'),
    store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => now }),
    enabled: () => true,
    settings: () => D,
    readSignals: async () => signals,
    census: async ({ readBoundaries }) => { boundaryReads.push(readBoundaries); return census; },
    resumeQueue: () => ({ disabled: null, paused: false, dryRun: true, entries: 0 }),
    coResidentAgents: () => agents,
    holdsLease: () => true,
    ownUser: 'me',
    platform: 'darwin',
    now: () => now,
  });
  const rows = (agent = 'echo') => fs.readFileSync(path.join(dir, agent, 'logs', 'machine-drain.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const run = async (r: DrainRehearsal, from: number, to: number, stepMs = MIN) => { for (now = from; now <= to; now += stepMs) await r.tick(); now = to; };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rehearsal-'));
    fs.mkdirSync(path.join(dir, 'echo'), { recursive: true });
    signals = { lastBootAt: t0 - 3 * DAY, inputIdleMs: 300 * MIN, ttyUsers: [], processes: [], onBattery: false, batteryPercent: null, tmuxSessions: [] };
    census = empty();
    boundaryReads = [];
    agents = ['echo'];
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance.test.ts' }));

  it('runs every phase on a quiet night, due or not, and closes would-restart', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + MIN);
    const phases = rows().filter((x) => x.type === 'phase').map((x) => x.phase);
    expect(phases).toEqual(DRAIN_PHASES.map((p) => p.id));
    const night = r.status().lastRehearsal as { outcome: string; due: boolean };
    expect(night).toMatchObject({ outcome: 'would-restart', due: false });
    expect(rows().every((x) => x.watchOnly === true)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'echo', 'state', 'machine-maintenance-rehearsal.json'))).toBe(false);
  });

  it('does nothing and reads no pane outside the window', async () => {
    const r = make();
    await run(r, local(10, 12), local(10, 14), 20 * MIN);
    expect(r.status().plan).toBeNull();
    expect(boundaryReads.every((b) => b === false)).toBe(true);
    expect(r.status().delays).toHaveLength(7);
  });

  it('reads panes only from T-20', async () => {
    const r = make();
    await run(r, t0 - 40 * MIN, t0 - 25 * MIN);
    expect(boundaryReads.every((b) => b === false)).toBe(true);
    now = t0 - 20 * MIN;
    await r.tick();
    expect(boundaryReads.at(-1)).toBe(true);
  });

  it('measures a session from T-20 to the prompt, and censors one that never gets there', async () => {
    census.sessions = [
      { name: 'quick', tmuxSession: 'q', topicId: 1, atBoundary: false },
      { name: 'stuck', tmuxSession: 's', topicId: 2, atBoundary: false },
    ];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 13 * MIN);
    census.sessions = [{ ...census.sessions[0], atBoundary: true }, census.sessions[1]];
    await run(r, t0 - 12 * MIN, t0 + MIN);
    const stats = (r.status().lastRehearsal as { kinds: Array<Record<string, unknown>> }).kinds.find((k) => k.kind === 'session')!;
    expect(stats).toMatchObject({ count: 2, censored: 1, vanished: 0, medianSeconds: 540 });
  });

  it('does not sample a session already at rest, so idle sessions cannot flatter the gate', async () => {
    census.sessions = [{ name: 'idle', tmuxSession: 'i', topicId: 1, atBoundary: true }];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + MIN);
    const night = r.status().lastRehearsal as { kinds: Array<Record<string, unknown>>; samples: Record<string, number[]> };
    expect(night.kinds[0]).toMatchObject({ count: 0, alreadyAtRest: 1 });
    expect(night.samples.session).toEqual([]);
  });

  it('treats a session that disappears as vanished, not yielded, and one prompt read as not enough', async () => {
    census.sessions = [{ name: 'a', tmuxSession: 'a', topicId: 1, atBoundary: false }, { name: 'b', tmuxSession: 'b', topicId: 2, atBoundary: false }];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 15 * MIN);
    census.sessions = [{ name: 'b', tmuxSession: 'b', topicId: 2, atBoundary: true }];
    now = t0 - 14 * MIN; await r.tick();
    census.sessions = [{ name: 'b', tmuxSession: 'b', topicId: 2, atBoundary: false }];
    await run(r, t0 - 13 * MIN, t0 + MIN);
    const stats = (r.status().lastRehearsal as { kinds: Array<Record<string, unknown>> }).kinds.find((k) => k.kind === 'session')!;
    expect(stats).toMatchObject({ count: 2, vanished: 1, censored: 1, medianSeconds: null });
  });

  it('measures nothing from a phase that fired late, and does not count that night', async () => {
    census.sessions = [{ name: 'a', tmuxSession: 'a', topicId: 1, atBoundary: false }];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 25 * MIN);
    await run(r, t0 - 8 * MIN, t0 + MIN); // asleep across T-20
    const night = r.status().lastRehearsal as { kinds: unknown[]; phasesLate: string[] };
    expect(night.phasesLate).toContain('checkpoint');
    expect(night.kinds).toEqual([]);
    expect(r.evidence()).toMatchObject({ nights: 0, nightsRecorded: 1 });
  });

  it('reads an unreadable tmux as not read, never as clear, and does not count that night', async () => {
    signals.tmuxSessions = null;
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + MIN);
    expect((r.status().delays as Array<{ id: string; active: unknown }>).find((d) => d.id === 'D2')!.active).toBeNull();
    expect(r.evidence()).toMatchObject({ nights: 0, nightsRecorded: 1 });
  });

  it('stops reading panes after T-0 while a delay holds the night open', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 21 * MIN);
    signals.inputIdleMs = 10 * MIN; // D1 without S3, late enough to hold past T-0
    await run(r, t0 - 20 * MIN, t0 + 2 * MIN);
    expect(r.status().plan).not.toBeNull();
    expect(boundaryReads.at(-1)).toBe(false);
  });

  it('ignores a stale ack, so an agent that went quiet reads as silent and loses its claims', async () => {
    agents = ['echo', 'groky'];
    const store = new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => now });
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 30 * MIN);
    const plan = store.readPlan()!;
    store.writeAck('groky', { episodeId: plan.episodeId, generation: plan.generation, bootTime: 1, state: 'draining', delaysClaimed: ['D2'], yields: {}, version: 'v', at: now });
    await run(r, t0 - 29 * MIN, t0 + 40 * MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-roll', rollBecause: 'D3' });
  });

  it('writes one row per episode even if a crash replays the close', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + MIN);
    const first = r.status().lastRehearsal as { episodeId: string };
    fs.writeFileSync(path.join(dir, 'echo', 'state', 'machine-maintenance-rehearsal.json'), JSON.stringify({ episodeId: first.episodeId, generation: 1, originalRestartAt: t0, windowEnd: local(11, 6), phasesDone: [], tracked: {}, alreadyAtRest: {}, phasesLate: [], undeclared: [], holdsSeen: [], due: false, final: false, openedLate: false, undeclaredUnread: false }));
    const again = make();
    now = local(11, 7);
    await again.tick();
    expect(again.evidence().nightsRecorded).toBe(1);
  });

  it('counts work that ends as reaching its yield point, and asks each kind at its own offset', async () => {
    census.testRuns = [{ pid: 5, acquiredAt: 1, lane: 'suite' }];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 8 * MIN);
    census.testRuns = [];
    await run(r, t0 - 7 * MIN, t0 + MIN);
    const stats = (r.status().lastRehearsal as { kinds: Array<Record<string, unknown>> }).kinds.find((k) => k.kind === 'test-suite')!;
    expect(stats).toMatchObject({ count: 1, censored: 0, medianSeconds: 180 });
  });

  it('still measures yields on a night that rolls, because phases keep the original clock', async () => {
    signals.inputIdleMs = 2 * MIN; // owner present all night: D1, and S3
    census.sessions = [{ name: 's', tmuxSession: 't', topicId: 1, atBoundary: true }];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + MIN);
    const night = r.status().lastRehearsal as { outcome: string; rollBecause: string; kinds: unknown[] };
    expect(night.outcome).toBe('would-roll');
    expect(night.rollBecause).toBe('D1');
    expect(night.kinds).toHaveLength(1);
    expect(rows().filter((x) => x.type === 'phase').map((x) => x.phase)).toContain('checkpoint');
  });

  it('closes would-hold under a safety hold that lasts to T-0, naming it', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 10 * MIN);
    signals.onBattery = true; signals.batteryPercent = 20;
    await run(r, t0 - 9 * MIN, t0 + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-hold', holds: ['S4'] });
  });

  it('treats a silent co-resident agent as D3 from T-5, and rolls at its maximum', async () => {
    agents = ['echo', 'groky'];
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + 40 * MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-roll', rollBecause: 'D3' });
  });

  it('names undeclared work as D2, and what a final night would end', async () => {
    signals.tmuxSessions = ['desk-runner'];
    signals.lastBootAt = t0 - 9 * DAY - 2 * 60 * MIN;
    const r = make();
    await run(r, t0 - 71 * MIN, t0 + 70 * MIN);
    const night = r.status().lastRehearsal as Record<string, unknown>;
    expect(night).toMatchObject({ final: true, undeclared: ['desk-runner'], wouldEndOnFinalNight: ['desk-runner'], outcome: 'would-restart' });
  });

  it('lets two co-resident agents share one record, and the second finishes after the first closes', async () => {
    fs.mkdirSync(path.join(dir, 'groky'), { recursive: true });
    agents = ['echo', 'groky'];
    const a = make('echo');
    const b = make('groky');
    for (now = t0 - 71 * MIN; now <= t0 + 2 * MIN; now += MIN) { await a.tick(); await b.tick(); }
    expect((a.status().lastRehearsal as { episodeId: string }).episodeId).toBe((b.status().lastRehearsal as { episodeId: string }).episodeId);
    expect((b.status().lastRehearsal as { outcome: string }).outcome).toBe('would-restart');
  });

  it('picks the night up after a server restart without repeating a phase', async () => {
    const before = make();
    await run(before, t0 - 71 * MIN, t0 - 30 * MIN);
    const after = make();
    await run(after, t0 - 29 * MIN, t0 + MIN);
    const phases = rows().filter((x) => x.type === 'phase').map((x) => x.phase);
    expect(phases).toEqual(DRAIN_PHASES.map((p) => p.id));
  });

  it('skips the night when a server comes up after T-20', async () => {
    const r = make();
    await run(r, t0 - 15 * MIN, t0 + 5 * MIN);
    expect(r.status().lastRehearsal).toBeNull();
    expect(r.status().plan).toBeNull();
  });

  it('closes an abandoned night at the window end', async () => {
    const before = make();
    await run(before, t0 - 71 * MIN, t0 - 30 * MIN);
    const after = make();
    now = local(11, 7);
    await after.tick();
    expect(after.status().lastRehearsal).not.toBeNull();
    expect(after.status().plan).toBeNull();
  });

  it('survives a reading that throws, and reports it', async () => {
    const r = make();
    const broken = new DrainRehearsal({ ...(r as unknown as { deps: ConstructorParameters<typeof DrainRehearsal>[0] }).deps, readSignals: async () => { throw new Error('boom'); } });
    now = local(10, 12);
    await broken.tick();
    expect(broken.status().lastError).toBe('boom');
  });

  it('stops ticking when the off switch is set, with no restart', async () => {
    const r = new DrainRehearsal({ ...(make() as unknown as { deps: ConstructorParameters<typeof DrainRehearsal>[0] }).deps, enabled: () => false });
    await run(r, t0 - 71 * MIN, t0 + MIN);
    expect(r.status()).toMatchObject({ enabled: false, plan: null, lastRehearsal: null });
  });

  it('holds the evidence gate shut until 14 nights, and counts a censored run as over the limit', async () => {
    const r = make();
    let n = 0;
    const night = (over: object) => ({ episodeId: `e${n++}`, closedAt: 1, phasesLate: [], undeclaredUnread: false, due: false, final: false, openedLate: false, outcome: 'would-restart', rollBecause: null, delayMinutesUsed: {}, holds: [], kinds: [], samples: {}, undeclared: [], wouldEndOnFinalNight: [], ...over });
    const set = (rowsIn: object[]) => { (r as unknown as { nights: object[] }).nights = rowsIn; };
    const quick = { kinds: [{ kind: 'session', class: 'stop-at-boundary', count: 3, censored: 0, vanished: 0, alreadyAtRest: 0, medianSeconds: 60, p95Seconds: 60 }], samples: { session: [60, 60, 60] } };
    set(Array.from({ length: 13 }, () => night(quick)));
    expect(r.evidence().met).toBe(false);
    set(Array.from({ length: 14 }, () => night(quick)));
    expect(r.evidence()).toMatchObject({ met: true, boundaryP95Seconds: 60 });
    set(Array.from({ length: 14 }, () => night({ ...quick, undeclared: ['desk'] })));
    expect(r.evidence()).toMatchObject({ met: false, undeclaredLast7: ['desk'] });
    const censored = { kinds: [{ kind: 'session', class: 'stop-at-boundary', count: 1, censored: 1, vanished: 0, alreadyAtRest: 0, medianSeconds: null, p95Seconds: null }], samples: {} };
    set(Array.from({ length: 14 }, () => night(censored)));
    expect(r.evidence()).toMatchObject({ met: false, boundaryP95Seconds: 'over the limit' });
  });

  it('percentile is nearest-rank', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
  });
});
