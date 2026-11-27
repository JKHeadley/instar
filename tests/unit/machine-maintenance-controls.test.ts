/**
 * Operator controls (machine-self-maintenance Part F, CMT-1203): Skip once and Change window.
 * Both sides of each decision: a valid window is at least 2 hours, an invalid one is refused
 * and changes nothing; a Skip holds until skipUntil and no longer; a skipped machine opens no
 * night, a night already open runs on; a new window applies from the next night while an open
 * night keeps its T-0; every change is recorded with who and when, in one host record that
 * every agent on the machine reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DEFAULT_MACHINE_MAINTENANCE as D, SKIP_MS, isSkipped, validWindow, withControls } from '../../src/monitoring/machineMaintenance/planner.js';
import { CONTROLS_HISTORY_KEPT, HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import type { MachineSignals } from '../../src/monitoring/machineMaintenance/readings.js';
import type { WorkCensusInputs } from '../../src/monitoring/machineMaintenance/WorkYieldRegistry.js';
import { DrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m, 0, 0).getTime();

describe('planner controls', () => {
  it('a window is two clock times at least 2 hours apart, crossing midnight allowed', () => {
    expect(validWindow({ start: '01:00', end: '03:00' })).toEqual({ start: '01:00', end: '03:00' });
    expect(validWindow({ start: '23:30', end: '1:30' })).toEqual({ start: '23:30', end: '01:30' });
    expect(validWindow({ start: '01:00', end: '02:59' })).toBeNull();
    expect(validWindow({ start: '25:00', end: '03:00' })).toBeNull();
    expect(validWindow({ start: '1am', end: '3am' })).toBeNull();
    expect(validWindow(null)).toBeNull();
  });

  it('the owner window replaces the config window; none or an invalid one keeps the config', () => {
    expect(withControls(D, { skipUntil: null, window: { start: '01:00', end: '04:00' } }).window).toEqual({ start: '01:00', end: '04:00' });
    expect(withControls(D, { skipUntil: null, window: { start: '01:00', end: '02:00' } }).window).toEqual(D.window);
    expect(withControls(D, null).window).toEqual(D.window);
  });

  it('a skip holds until skipUntil, not after', () => {
    expect(isSkipped(100, { skipUntil: 200, window: null })).toBe(true);
    expect(isSkipped(200, { skipUntil: 200, window: null })).toBe(false);
    expect(isSkipped(100, { skipUntil: null, window: null })).toBe(false);
    expect(isSkipped(100, null)).toBe(false);
  });
});

describe('DrainRehearsal controls', () => {
  let dir: string;
  let now: number;
  const t0 = local(11, 4);
  const empty = (): WorkCensusInputs => ({ sessions: [], autonomousRuns: [], localVerifyRunning: [], localVerifyQueued: [], testRuns: [], scriptRuns: [] });
  const signals: MachineSignals = { lastBootAt: t0 - 3 * DAY, inputIdleMs: 300 * MIN, ttyUsers: [], processes: [], onBattery: false, batteryPercent: null, tmuxSessions: [] };
  const store = () => new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => now });
  const make = (agentName = 'echo') => {
    const s = store();
    return new DrainRehearsal({
      agentName, version: '1.0.0', stateDir: path.join(dir, agentName), logPath: path.join(dir, agentName, 'logs', 'machine-drain.jsonl'),
      store: s, controls: () => s.readControls(),
      enabled: () => true, settings: () => D,
      readSignals: async () => signals, census: async () => empty(),
      resumeQueue: () => ({ disabled: null, paused: false, dryRun: true, entries: 0 }),
      coResidentAgents: () => ['echo'], holdsLease: () => true, ownUser: 'me', platform: 'darwin', now: () => now,
    });
  };
  const run = async (r: DrainRehearsal, from: number, to: number, stepMs = MIN) => { for (now = from; now <= to; now += stepMs) await r.tick(); now = to; };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-controls-'));
    fs.mkdirSync(path.join(dir, 'echo'), { recursive: true });
    now = local(10, 12);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance-controls.test.ts' }));

  it('Skip once: no night opens while skipped; the night after skipUntil opens as usual', async () => {
    const r = make();
    const out = r.skip('dashboard');
    expect(out).toMatchObject({ ok: true, controls: { skipUntil: now + SKIP_MS } });
    expect(r.status().controls).toMatchObject({ skipped: true, skipUntil: now + SKIP_MS });
    await run(r, t0 - 71 * MIN, t0 + MIN);
    expect(r.status().lastRehearsal).toBeNull();
    expect(r.status().plan).toBeNull();

    // skipUntil = Nov 13 12:00, so the Nov 14 night is the first one back.
    const after = local(14, 4);
    await run(r, after - 71 * MIN, after + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-restart' });
  });

  it('Unskip clears a skip at once', async () => {
    const r = make();
    r.skip('dashboard');
    expect(r.unskip('dashboard')).toMatchObject({ ok: true, controls: { skipUntil: null } });
    await run(r, t0 - 71 * MIN, t0 + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-restart' });
  });

  it('a skip during an open night lets that night run on (it can only restart less)', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 30 * MIN);
    expect(r.status().plan).not.toBeNull();
    r.skip('dashboard');
    await run(r, t0 - 29 * MIN, t0 + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-restart' });
  });

  it('Change window: the next night uses it; an invalid one is refused and changes nothing', async () => {
    const r = make();
    expect(r.setWindow('dashboard', { start: '01:00', end: '02:00' })).toMatchObject({ ok: false, error: 'window-invalid' });
    expect(store().readControls()).toBeNull();
    expect(r.setWindow('dashboard', { start: '00:30', end: '03:00' })).toMatchObject({ ok: true, effectiveWindow: { start: '00:30', end: '03:00' } });
    expect((r.status().nextWindow as { restartAt: number }).restartAt).toBe(local(11, 1, 30));
    await run(r, local(11, 1, 30) - 71 * MIN, local(11, 1, 30) + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-restart' });
    // Reset returns to the config's window.
    expect(r.setWindow('dashboard', null)).toMatchObject({ ok: true, effectiveWindow: D.window });
  });

  it('a window changed during an open night keeps that night on its T-0', async () => {
    const r = make();
    await run(r, t0 - 71 * MIN, t0 - 30 * MIN);
    const opened = r.status().plan as { originalRestartAt: number };
    expect(opened.originalRestartAt).toBe(t0);
    r.setWindow('dashboard', { start: '05:00', end: '08:00' });
    await run(r, t0 - 29 * MIN, t0 + MIN);
    expect(r.status().lastRehearsal).toMatchObject({ outcome: 'would-restart' });
  });

  it('one host record: a second agent on the machine plans from the same controls, and each change is logged', () => {
    const a = make('echo');
    fs.mkdirSync(path.join(dir, 'bob'), { recursive: true });
    const b = make('bob');
    a.skip('dashboard');
    expect(b.status().controls).toMatchObject({ skipped: true });
    a.setWindow('telegram:7', { start: '02:00', end: '05:00' });
    const c = store().readControls()!;
    expect(c.history.map((h) => [h.action, h.by])).toEqual([['skip', 'dashboard'], ['window', 'telegram:7']]);
    for (let i = 0; i < CONTROLS_HISTORY_KEPT + 5; i++) a.unskip('dashboard');
    expect(store().readControls()!.history).toHaveLength(CONTROLS_HISTORY_KEPT);
  });

  it('a malformed controls file reads as no controls, and plans from the config', () => {
    fs.mkdirSync(path.join(dir, 'host'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'host', 'controls.json'), '{not json');
    const r = make();
    expect(r.status().controls).toMatchObject({ skipped: false, skipUntil: null, window: null });
    expect(r.status().settings).toMatchObject({ window: D.window });
  });
});
