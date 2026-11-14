/**
 * macOS wedge evidence (machine-self-maintenance Part E): the F1 canary app opened
 * through LaunchServices and the F2 data.kalloc.1024 kernel-zone reading.
 *
 * Both sides of every boundary: canary exit 0 is negative, a nonzero exit or a timeout
 * is positive only once the canary has passed this boot and never while locked or with
 * no console session; the kernel zone counts only strictly over 4 GiB, and an unread
 * zone is unread, never zero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import {
  PROBE_EXIT_GRACE_MS, WEDGE_CANARY_APP, makeProbeRunner, wedgeCanaryAvailable, type ExecLike, type ProbeResult, type ReadingName,
} from '../../src/monitoring/machineMaintenance/readings.js';
import {
  KALLOC_1024_LIMIT_BYTES, consoleSessionFromOwner, launchServicesError, parseKallocZone, readF1, readF2, readKallocZone,
} from '../../src/monitoring/machineMaintenance/wedgeEvidence.js';
import { WedgeMonitor } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';

const MIN = 60_000;
const ok = (stdout: string, ms = 40): ProbeResult => ({ ok: true, stdout, ms, timedOut: false, code: null });
const timedOut = (ms = 10_000): ProbeResult => ({ ok: false, stdout: null, ms, timedOut: true, code: null });
const exited = (code: number, stderr: string | null): ProbeResult => ({ ok: false, stdout: null, ms: 2100, timedOut: false, code, stderr });

/** Measured on the Studio, macOS 26.5, unprivileged: the byte columns read 0K. */
const ZPRINT_USER = [
  '                            elem         cur         max        cur         max         cur  alloc  alloc    ',
  'zone name                   size        size        size      #elts       #elts       inuse   size  count    ',
  '-------------------------------------------------------------------------------------------------------------',
  'data.kalloc.1024            1024          0K          0K          0           0      332120     0K      0   ',
].join('\n');
/** The same zone read as root a moment later. */
const ZPRINT_ROOT = 'data.kalloc.1024            1024     333072K     333072K     333072      333072      332121    16K     16  C\n';
const zone = (inUse: number) => `data.kalloc.1024            1024          0K          0K          0           0      ${inUse}     0K      0\n`;

describe('F1 canary classification (macOS)', () => {
  it('exit 0 is negative and records a pass this boot', () => {
    const r = readF1({ platform: 'darwin', probe: ok(''), passedSinceBoot: false, consoleSession: true, lockState: 'unlocked' });
    expect(r).toMatchObject({ reading: { result: 'negative', reason: 'canary-passed' }, passed: true });
  });

  it('a pass while locked still counts as a pass: the path worked', () => {
    expect(readF1({ platform: 'darwin', probe: ok(''), passedSinceBoot: false, lockState: 'locked' })).toMatchObject({ reading: { result: 'negative' }, passed: true });
  });

  it('a nonzero exit (-600) after a pass this boot is positive and names the LaunchServices error, never its text', () => {
    const r = readF1({ platform: 'darwin', probe: exited(1, 'LSOpenURLsWithRole() failed with error -600 for the file /x/InstarWedgeCanary.app.\n'), passedSinceBoot: true, consoleSession: true, lockState: 'unlocked' });
    expect(r.passed).toBe(false);
    expect(r.reading).toMatchObject({ result: 'positive', reason: 'canary-failed', detail: { code: '1', launchServicesError: -600 } });
    expect(JSON.stringify(r.reading)).not.toContain('/x/');
  });

  it('a timeout after a pass this boot is positive', () => {
    expect(readF1({ platform: 'darwin', probe: timedOut(), passedSinceBoot: true, consoleSession: true }).reading).toMatchObject({ result: 'positive', reason: 'canary-timed-out' });
  });

  it('eligibility: never passed this boot, locked, or no console session make a failure ineligible, never positive', () => {
    const fail = exited(1, 'error -600');
    expect(readF1({ platform: 'darwin', probe: fail, passedSinceBoot: false, consoleSession: true }).reading).toMatchObject({ result: 'ineligible', reason: 'canary-failed-never-passed-this-boot' });
    expect(readF1({ platform: 'darwin', probe: fail, passedSinceBoot: true, consoleSession: true, lockState: 'locked' }).reading).toMatchObject({ result: 'ineligible', reason: 'canary-failed-screen-locked' });
    expect(readF1({ platform: 'darwin', probe: timedOut(), passedSinceBoot: true, consoleSession: false }).reading).toMatchObject({ result: 'ineligible', reason: 'canary-timed-out-no-console-session' });
  });

  it('an unread console session or an unknown lock does not block: on a wedged machine reads fail first', () => {
    expect(readF1({ platform: 'darwin', probe: timedOut(), passedSinceBoot: true, consoleSession: null, lockState: 'unknown' }).reading.result).toBe('positive');
    expect(readF1({ platform: 'darwin', probe: timedOut(), passedSinceBoot: true, consoleSession: null, lockState: null }).reading.result).toBe('positive');
  });

  it('a missing open binary is unknown, not positive', () => {
    expect(readF1({ platform: 'darwin', probe: { ok: false, stdout: null, ms: 1, timedOut: false, code: 'ENOENT' }, passedSinceBoot: true }).reading).toMatchObject({ result: 'unknown', reason: 'canary-missing' });
  });

  it('Linux and WSL keep their reasons unchanged', () => {
    expect(readF1({ platform: 'linux', probe: ok(''), passedSinceBoot: false }).reading.reason).toBe('probe-passed');
    expect(readF1({ platform: 'wsl', probe: timedOut(), passedSinceBoot: true, consoleSession: false, lockState: 'locked' }).reading).toMatchObject({ result: 'positive', reason: 'probe-timed-out' });
  });

  it('console owner: own user is a session; root (login window) or another person is not; unread is null', () => {
    expect(consoleSessionFromOwner(ok('me\n'), 'me')).toBe(true);
    expect(consoleSessionFromOwner(ok('root\n'), 'me')).toBe(false);
    expect(consoleSessionFromOwner(ok('someone\n'), 'me')).toBe(false);
    expect(consoleSessionFromOwner(timedOut(), 'me')).toBeNull();
    expect(consoleSessionFromOwner(ok(''), 'me')).toBeNull();
    expect(consoleSessionFromOwner(ok('me'), undefined)).toBeNull();
  });

  it('launchServicesError parses -600 and -1712 and nothing else', () => {
    expect(launchServicesError('_LSOpenURLsWithCompletionHandler() failed with error -1712.')).toBe(-1712);
    expect(launchServicesError('failed with error -600 for the file')).toBe(-600);
    expect(launchServicesError('no number')).toBeNull();
    expect(launchServicesError(null)).toBeNull();
  });
});

describe('F2 kernel zone (macOS)', () => {
  it('parses the unprivileged row as in-use x element size, and the root row the same way', () => {
    expect(parseKallocZone(ZPRINT_USER)).toEqual({ inUseBytes: 332120 * 1024, elemSize: 1024, inUse: 332120 });
    expect(parseKallocZone(ZPRINT_ROOT)).toEqual({ inUseBytes: 332121 * 1024, elemSize: 1024, inUse: 332121 });
  });

  it('a missing or garbled row is unread, never zero', () => {
    expect(parseKallocZone('zone name\n---\n')).toBeNull();
    expect(parseKallocZone('data.kalloc.1024 x y z w v q\n')).toBeNull();
    expect(readKallocZone(ok('nothing here'))).toEqual({ overLimit: null, inUseBytes: null, reason: 'zone-row-unparseable' });
    expect(readKallocZone(timedOut())).toMatchObject({ overLimit: null, reason: 'zprint-timed-out' });
    expect(readKallocZone({ ok: false, stdout: null, ms: 3, timedOut: false, code: 1 })).toMatchObject({ overLimit: null, reason: 'zprint-failed' });
    expect(readKallocZone(null)).toMatchObject({ overLimit: null, reason: 'not-read-on-platform' });
  });

  it('the 4 GiB boundary: exactly 4 GiB is under; one element more is over', () => {
    const atLimit = KALLOC_1024_LIMIT_BYTES / 1024;
    expect(readKallocZone(ok(zone(atLimit)))).toMatchObject({ overLimit: false, inUseBytes: KALLOC_1024_LIMIT_BYTES });
    expect(readKallocZone(ok(zone(atLimit + 1)))).toMatchObject({ overLimit: true, inUseBytes: KALLOC_1024_LIMIT_BYTES + 1024 });
  });

  it('over 4 GiB makes F2 positive even when the process table answers flat or is unreadable', () => {
    const over = ok(zone(KALLOC_1024_LIMIT_BYTES / 1024 + 1));
    expect(readF2({ platform: 'darwin', ps: ok('S\n'), priorCounts: [], kernelZone: over })).toMatchObject({ reading: { result: 'positive', reason: 'kernel-zone-over-limit' }, count: 0 });
    expect(readF2({ platform: 'darwin', ps: { ok: false, stdout: null, ms: 1, timedOut: false, code: 'EPERM' }, priorCounts: [], kernelZone: over }).reading.result).toBe('positive');
  });

  it('under the line, or unread, F2 stays as the process table says, with the zone named in the detail', () => {
    const under = readF2({ platform: 'darwin', ps: ok('S\n'), priorCounts: [], kernelZone: ok(ZPRINT_USER) }).reading;
    expect(under).toMatchObject({ result: 'negative', detail: { kernelZoneRead: true, kallocInUseBytes: 332120 * 1024, kernelZoneReason: 'read-unprivileged' } });
    const unread = readF2({ platform: 'darwin', ps: ok('S\n'), priorCounts: [], kernelZone: timedOut() }).reading;
    expect(unread).toMatchObject({ result: 'negative', detail: { kernelZoneRead: false, kallocInUseBytes: null, kernelZoneReason: 'zprint-timed-out' } });
  });

  it('Linux ignores any zone reading', () => {
    expect(readF2({ platform: 'linux', ps: ok('S\n'), priorCounts: [], kernelZone: ok(zone(KALLOC_1024_LIMIT_BYTES)) }).reading).toMatchObject({ result: 'negative', detail: { kernelZoneRead: false } });
  });
});

describe('canary availability and the runner', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-canary-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-wedge-mac-canary.test.ts' }));

  it('only on macOS, only with the bundle executable present, and never in a test that did not opt in', () => {
    const app = path.join(dir, 'InstarWedgeCanary.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'InstarWedgeCanary'), '');
    expect(wedgeCanaryAvailable('linux', {}, app)).toBe(false);
    expect(wedgeCanaryAvailable('darwin', { VITEST: 'true' }, app)).toBe(false);
    expect(wedgeCanaryAvailable('darwin', { VITEST: 'true', INSTAR_REAL_WEDGE_CANARY_TESTS: '1' }, app)).toBe(true);
    expect(wedgeCanaryAvailable('darwin', {}, app)).toBe(true);
    expect(wedgeCanaryAvailable('darwin', {}, path.join(dir, 'Missing.app'))).toBe(false);
  });

  it('the canary resolves to the dist/native bundle', () => {
    expect(WEDGE_CANARY_APP.endsWith(path.join('dist', 'native', 'InstarWedgeCanary.app'))).toBe(true);
  });

  it('runs `open -g -j <canary>`, keeps stderr for the error number, and SIGKILLs at the timeout', async () => {
    let seen: { command: string; args: string[]; signal: string } | null = null;
    const run = makeProbeRunner((command, args, options, cb) => {
      seen = { command, args, signal: options.killSignal };
      cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '_LSOpenURLsWithCompletionHandler() failed with error -600.\n');
      return undefined;
    });
    const r = await run('guiCanary', 10_000);
    expect(seen).toEqual({ command: '/usr/bin/open', args: ['-g', '-j', WEDGE_CANARY_APP], signal: 'SIGKILL' });
    expect(r).toMatchObject({ ok: false, timedOut: false, code: 1 });
    expect(launchServicesError(r.stderr)).toBe(-600);
  });

  it('a canary `open` that never exits settles at timeout plus grace, and no second one starts while it is out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let spawned = 0;
      const run = makeProbeRunner(() => { spawned += 1; return undefined; });
      let result: ProbeResult | null = null;
      void run('guiCanary', 10_000).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(10_000 + PROBE_EXIT_GRACE_MS + 1);
      expect(result).toMatchObject({ ok: false, timedOut: true, code: 'no-exit' });
      expect(await run('guiCanary', 10_000)).toMatchObject({ timedOut: true, code: 'previous-still-running' });
      expect(spawned).toBe(1);
      // F1 classifies it as a timeout: positive once the canary has passed this boot.
      expect(readF1({ platform: 'darwin', probe: result, passedSinceBoot: true, consoleSession: true }).reading.result).toBe('positive');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WedgeMonitor on macOS', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-canary-mon-')); clock = Date.parse('2026-11-03T12:00:00Z'); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-wedge-mac-canary.test.ts' }));

  function make(probe: (name: ReadingName) => ProbeResult, over: { canary?: boolean; lock?: string | null } = {}): { m: WedgeMonitor; calls: ReadingName[] } {
    const calls: ReadingName[] = [];
    const bootAt = clock - 3 * 24 * 60 * MIN;
    const m = new WedgeMonitor({
      agentName: 'echo', machineId: () => 'm_mac', platform: 'darwin',
      logPath: path.join(dir, 'logs', 'machine-maintenance.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      enabled: () => true, settings: () => ({ dryRun: true, dryRunNotice: false }),
      probe: async (name) => { calls.push(name); return probe(name); },
      readBootAt: async () => bootAt,
      lockState: async () => over.lock ?? 'unlocked',
      canaryAvailable: () => over.canary ?? true,
      ownUser: 'me',
      loadReading: () => null, spawnSystemFailures30m: () => null, sessionsCount: () => 0,
      nextWindowRestartAt: (now) => now + 60 * MIN, judge: null, raiseNotice: null, now: () => clock,
    });
    return { m, calls };
  }

  it('runs the canary, the console owner and the kernel zone; a pass then a failure goes negative then positive', async () => {
    let canary: ProbeResult = ok('');
    const { m, calls } = make((name) => (name === 'guiCanary' ? canary : name === 'consoleOwner' ? ok('me\n') : name === 'kernelZone' ? ok(ZPRINT_USER) : ok('S\n')));
    await m.tick();
    let st = m.status() as any;
    expect(calls.sort()).toEqual(['consoleOwner', 'guiCanary', 'kernelZone', 'processStates']);
    expect(st.families.F1).toMatchObject({ result: 'negative', reason: 'canary-passed' });
    expect(st.f1PassedThisBoot).toBe(true);
    expect(st.families.F2.detail).toMatchObject({ kernelZoneRead: true, kallocInUseBytes: 332120 * 1024 });
    canary = exited(1, 'failed with error -600');
    clock += 10 * MIN;
    await m.tick();
    st = m.status() as any;
    expect(st.families.F1).toMatchObject({ result: 'positive', reason: 'canary-failed', detail: { launchServicesError: -600 } });
    expect(st.limits.join(' ')).not.toMatch(/F1 is unread on macOS/);
  });

  it('a first-ever failure this boot is ineligible; with no canary installed nothing is launched and F1 is unknown', async () => {
    const failing = make((name) => (name === 'guiCanary' ? timedOut() : name === 'consoleOwner' ? ok('me') : ok('S\n')));
    await failing.m.tick();
    expect((failing.m.status() as any).families.F1).toMatchObject({ result: 'ineligible', reason: 'canary-timed-out-never-passed-this-boot' });
    const none = make(() => ok('S\n'), { canary: false });
    await none.m.tick();
    expect(none.calls).not.toContain('guiCanary');
    expect((none.m.status() as any).families.F1).toMatchObject({ result: 'unknown', reason: 'canary-not-installed' });
  });

  it('the login window owns the console: a failure is ineligible', async () => {
    let canary: ProbeResult = ok('');
    let owner = 'me';
    const { m } = make((name) => (name === 'guiCanary' ? canary : name === 'consoleOwner' ? ok(owner) : ok('S\n')));
    await m.tick();
    canary = timedOut();
    owner = 'root';
    clock += 10 * MIN;
    await m.tick();
    expect((m.status() as any).families.F1).toMatchObject({ result: 'ineligible', reason: 'canary-timed-out-no-console-session' });
  });
});
