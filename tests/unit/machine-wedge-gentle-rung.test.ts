/**
 * The gentle rung (machine-self-maintenance Part E, CMT-1202): on macOS, when the wedge
 * canary itself is left stopped by LaunchServices, this user's other app launches left
 * stopped in a known app folder are resumed (SIGCONT), before anything as strong as a
 * restart. Mac Studio, 2026-11-16: every GUI launch for ~20 h was spawned and left
 * stopped (STAT T); `kill -CONT` freed each one.
 *
 * Both sides of every boundary: only a stopped process, only this user's, only one
 * launchd started (ppid 1, never a shell job someone suspended), only one at least a
 * minute old, only an app's own executable under /Applications, /System/Applications,
 * CoreServices or ~/Applications, never the canary; only while the canary was left
 * stopped in the same sample; dry-run (the default) lists and resumes nothing; `off`
 * does not even read; each process is resumed at most twice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { parseElapsed, parseStoppedLaunches, type ProbeResult, type ReadingName } from '../../src/monitoring/machineMaintenance/readings.js';
import { GENTLE_MAX_PER_PROCESS, GENTLE_MAX_PER_SAMPLE, WedgeMonitor, normalizeWedgeSettings, type GentleResumeMode } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';

const MIN = 60_000;
const ok = (stdout: string): ProbeResult => ({ ok: true, stdout, ms: 40, timedOut: false, code: null });
const timedOut = (): ProbeResult => ({ ok: false, stdout: null, ms: 5000, timedOut: true, code: null });
const CANARY = '/x/node_modules/instar/dist/native/InstarWedgeCanary.app/Contents/MacOS/InstarWedgeCanary';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const row = (pid: number, exe: string, o: { uid?: number; ppid?: number; stat?: string; etime?: string } = {}) =>
  `${String(pid).padStart(6)} ${String(o.uid ?? 501).padStart(5)} ${String(o.ppid ?? 1).padStart(5)} ${(o.stat ?? 'T').padEnd(4)} ${(o.etime ?? '20:01:07').padStart(11)} ${exe}`;

describe('parseStoppedLaunches', () => {
  it('lists a stopped app launch of this user under a known app folder, with its app name and age', () => {
    const out = [
      row(405, CHROME),
      row(406, '/System/Applications/Calendar.app/Contents/MacOS/Calendar', { etime: '01:30' }),
      row(407, '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', { stat: 'Ts' }),
      row(408, '/Users/me/Applications/Thing.app/Contents/MacOS/Thing', { etime: '2-03:04:05' }),
      row(409, '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'),
    ].join('\n');
    expect(parseStoppedLaunches(out, 501, '/Users/me')).toEqual([
      { pid: 405, app: 'Google Chrome', ageMs: (20 * 3600 + 67) * 1000 },
      { pid: 406, app: 'Calendar', ageMs: 90_000 },
      { pid: 407, app: 'Finder', ageMs: 20 * 3600_000 + 67_000 },
      { pid: 408, app: 'Thing', ageMs: ((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000 },
      { pid: 409, app: 'Terminal', ageMs: 20 * 3600_000 + 67_000 },
    ]);
  });

  it('never lists a running process, another user\'s, a shell job (ppid not 1), a young launch, the canary, or anything outside the known folders', () => {
    const out = [
      row(1, CHROME, { stat: 'S' }),
      row(2, CHROME, { stat: 'R' }),
      row(3, CHROME, { uid: 502 }),
      row(4, CHROME, { ppid: 777 }),
      row(5, CHROME, { etime: '00:59' }),
      row(6, CANARY),
      row(7, '/Applications/InstarWedgeCanary.app/Contents/MacOS/InstarWedgeCanary'),
      row(8, '/usr/local/bin/node'),
      row(9, '/tmp/Evil.app/Contents/MacOS/Evil'),
      row(10, '/Users/other/Applications/Thing.app/Contents/MacOS/Thing'),
      row(11, '/Applications/Google Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper'),
      row(12, '/Applications/Foo.app/Contents/Resources/tool'),
      'garbage line',
      '',
    ].join('\n');
    expect(parseStoppedLaunches(out, 501, '/Users/me')).toEqual([]);
    // No home known: ~/Applications is not a known folder.
    expect(parseStoppedLaunches(row(13, '/Users/me/Applications/Thing.app/Contents/MacOS/Thing'), 501, null)).toEqual([]);
  });

  it('reads ps elapsed times; an unparseable one is null', () => {
    expect(parseElapsed('00:05')).toBe(5000);
    expect(parseElapsed('1:00:00')).toBe(3600_000);
    expect(parseElapsed('3-00:00:00')).toBe(3 * 24 * 3600_000);
    expect(parseElapsed('soon')).toBeNull();
  });
});

describe('gentleResume setting', () => {
  it('defaults to dry-run; only on and off are taken as given', () => {
    expect(normalizeWedgeSettings(undefined).gentleResume).toBe('dry-run');
    expect(normalizeWedgeSettings({ gentleResume: 'on' }).gentleResume).toBe('on');
    expect(normalizeWedgeSettings({ gentleResume: 'off' }).gentleResume).toBe('off');
    expect(normalizeWedgeSettings({ gentleResume: true }).gentleResume).toBe('dry-run');
  });
});

describe('WedgeMonitor gentle rung (macOS)', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-gentle-')); clock = Date.parse('2026-11-16T18:00:00Z'); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-wedge-gentle-rung.test.ts' }));

  function make(o: { mode: GentleResumeMode; canaryTable: () => string; launches: () => ProbeResult; resumer?: boolean; resumeOk?: (pid: number) => boolean }) {
    const calls: ReadingName[] = [];
    const resumed: number[] = [];
    const bootAt = clock - 3 * 24 * 60 * MIN;
    const m = new WedgeMonitor({
      agentName: 'echo', machineId: () => 'm_mac', platform: 'darwin',
      logPath: path.join(dir, 'logs', 'machine-maintenance.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      enabled: () => true, settings: () => ({ dryRun: true, dryRunNotice: false, gentleResume: o.mode }),
      probe: async (name) => {
        calls.push(name);
        if (name === 'guiCanary') return ok('');
        if (name === 'consoleOwner') return ok('me\n');
        if (name === 'canaryProcesses') return ok(o.canaryTable());
        if (name === 'stoppedLaunches') return o.launches();
        return ok('S\n');
      },
      readBootAt: async () => bootAt,
      lockState: async () => 'unlocked',
      canaryAvailable: () => true,
      ownUser: 'me', ownUid: 501, home: '/Users/me',
      endCanary: () => true,
      ...(o.resumer === false ? {} : { resumeStopped: (pid: number) => { resumed.push(pid); return o.resumeOk ? o.resumeOk(pid) : true; } }),
      settle: async () => {},
      loadReading: () => null, spawnSystemFailures30m: () => null, sessionsCount: () => 0,
      nextWindowRestartAt: (now) => now + 60 * MIN, judge: null, raiseNotice: null, now: () => clock,
    });
    return { m, calls, resumed };
  }
  const wedged = () => `51709   501 T    ${CANARY}\n`;
  const launches = () => ok([row(405, CHROME), row(406, '/System/Applications/Calendar.app/Contents/MacOS/Calendar'), row(4, CHROME, { ppid: 777 })].join('\n'));
  const logRows = () => fs.readFileSync(path.join(dir, 'logs', 'machine-maintenance.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('on: the canary left stopped resumes this user\'s stopped launches, records them, and leaves the shell job alone', async () => {
    const { m, resumed } = make({ mode: 'on', canaryTable: wedged, launches });
    await m.tick();
    expect(resumed).toEqual([405, 406]);
    const st = m.status() as any;
    expect(st.gentleResume).toBe('on');
    expect(st.lastGentle).toMatchObject({ mode: 'on', result: 'resumed', found: 2, resumed: [{ pid: 405, app: 'Google Chrome', ageMinutes: 1201 }, { pid: 406, app: 'Calendar' }], failed: [] });
    expect(logRows().some((r) => r.type === 'wedge-gentle' && r.result === 'resumed')).toBe(true);
  });

  it('dry-run (the default) lists what it would resume and sends nothing', async () => {
    const { m, resumed } = make({ mode: 'dry-run', canaryTable: wedged, launches });
    await m.tick();
    expect(resumed).toEqual([]);
    expect((m.status() as any).lastGentle).toMatchObject({ mode: 'dry-run', result: 'would-resume', found: 2, resumed: [{ pid: 405 }, { pid: 406 }] });
  });

  it('off does not even read the table', async () => {
    const { m, calls, resumed } = make({ mode: 'off', canaryTable: wedged, launches });
    await m.tick();
    expect(calls).not.toContain('stoppedLaunches');
    expect(resumed).toEqual([]);
    expect((m.status() as any).lastGentle).toBeNull();
  });

  it('a healthy canary (gone after the launch) runs no gentle rung, even with stopped launches present', async () => {
    const { m, calls, resumed } = make({ mode: 'on', canaryTable: () => '', launches });
    await m.tick();
    expect(calls).not.toContain('stoppedLaunches');
    expect(resumed).toEqual([]);
  });

  it('on with no resumer wired reads as dry-run, never as resumed', async () => {
    const { m } = make({ mode: 'on', canaryTable: wedged, launches, resumer: false });
    await m.tick();
    expect((m.status() as any).lastGentle).toMatchObject({ mode: 'dry-run', result: 'would-resume', reason: 'no-resumer' });
  });

  it('an unread table is unread, and a resume that fails is counted as failed', async () => {
    const unread = make({ mode: 'on', canaryTable: wedged, launches: timedOut });
    await unread.m.tick();
    expect((unread.m.status() as any).lastGentle).toMatchObject({ result: 'unread', reason: 'ps-timed-out', resumed: [] });
    const failing = make({ mode: 'on', canaryTable: wedged, launches, resumeOk: (pid) => pid !== 406 });
    await failing.m.tick();
    expect((failing.m.status() as any).lastGentle).toMatchObject({ result: 'resumed', resumed: [{ pid: 405 }], failed: [{ pid: 406 }] });
  });

  it(`each process is resumed at most ${GENTLE_MAX_PER_PROCESS} times; one stopped again after that is left to the later rungs`, async () => {
    const { m, resumed } = make({ mode: 'on', canaryTable: wedged, launches: () => ok(row(405, CHROME)) });
    for (let i = 0; i < 4; i++) { await m.tick(); clock += 10 * MIN; }
    expect(resumed).toEqual(Array(GENTLE_MAX_PER_PROCESS).fill(405));
    expect((m.status() as any).lastGentle).toMatchObject({ result: 'nothing-resumed', skipped: [{ pid: 405 }] });
  });

  it(`at most ${GENTLE_MAX_PER_SAMPLE} are resumed in one sample`, async () => {
    const many = Array.from({ length: GENTLE_MAX_PER_SAMPLE + 5 }, (_, i) => row(1000 + i, CHROME)).join('\n');
    const { m, resumed } = make({ mode: 'on', canaryTable: wedged, launches: () => ok(many) });
    await m.tick();
    expect(resumed).toHaveLength(GENTLE_MAX_PER_SAMPLE);
    expect((m.status() as any).lastGentle.skipped).toHaveLength(5);
  });
});
