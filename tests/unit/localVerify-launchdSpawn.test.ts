import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LaunchdNoFallbackError, buildPlist, parseExit, spawnViaLaunchd, sweepStale, launchdLabelPrefix, type LaunchdSpawnSeams } from '../../src/localVerify/launchdSpawn.js';

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'lv-launchd-')); }

/** A fake launchd: bootstrap "starts" the job by writing its pid file (or not). */
function fakeSeams(o: { startWritesPid?: boolean; bootstrapFails?: boolean; bootoutFails?: boolean; printOut?: string; alive?: () => boolean; list?: string | (() => string) } = {}) {
  const calls: string[][] = [];
  let tick: (() => void) | null = null;
  const s: LaunchdSpawnSeams = {
    launchctl(args) {
      calls.push(args);
      if (args[0] === 'bootstrap') {
        if (o.bootstrapFails) throw new Error('Bootstrap failed: 5: Input/output error');
        const xml = fs.readFileSync(args[2], 'utf8');
        const pidFile = /<string>-c<\/string><string>[^<]*<\/string><string>([^<]+)<\/string>/.exec(xml)![1];
        if (o.startWritesPid !== false) fs.writeFileSync(pidFile, '4242\n');
        return '';
      }
      if (args[0] === 'print') return o.printOut ?? '\tlast exit code = 0\n';
      if (args[0] === 'bootout' && o.bootoutFails) throw new Error('Boot-out failed: 5');
      if (args[0] === 'list') return typeof o.list === 'function' ? o.list() : (o.list ?? '');
      return '';
    },
    sleepSync: () => {},
    isAlive: o.alive ?? (() => false),
    uid: () => 501,
    now: (() => { let t = 1_000; return () => (t += 500); })(),
    every: (_ms, fn) => { tick = fn; return { stop: () => { tick = null; } }; },
  };
  return { s, calls, fire: () => tick?.() };
}

describe('launchdSpawn', () => {
  it('builds an Interactive plist that records the pid and execs the command, XML-escaped', () => {
    const x = buildPlist({ label: 'L', programArgs: ['/bin/sh', '-c', 'a && b', 'p<id>'], env: { K: 'v&w' }, logFile: '/log', cwd: '/w' });
    expect(x).toContain('<key>ProcessType</key><string>Interactive</string>');
    expect(x).toContain('<string>a &amp;&amp; b</string>');
    expect(x).toContain('<string>p&lt;id&gt;</string>');
    expect(x).toContain('<key>K</key><string>v&amp;w</string>');
    expect(x).toContain('<key>StandardOutPath</key><string>/log</string>');
  });

  it('parses exit status, a known signal and an unknown outcome', () => {
    expect(parseExit('\tlast exit code = 3\n')).toEqual({ status: 3, signal: null });
    expect(parseExit('\tlast terminating signal = Killed: 9\n')).toEqual({ status: null, signal: 'SIGKILL' });
    expect(parseExit('\tlast terminating signal = Terminated: 15\n\tlast exit code = 0')).toEqual({ status: null, signal: 'SIGTERM' });
    expect(parseExit('')).toEqual({ status: null, signal: null });
  });

  it('returns the recorded pid, then resolves with the exit status and boots the job out', async () => {
    const dir = tmp();
    const f = fakeSeams({ printOut: '\tlast exit code = 1\n' });
    const h = spawnViaLaunchd({ command: 'nice', args: ['-n', '10', 'node', 'x.js'], env: { PATH: '/bin', DROP: undefined }, logFile: '/l' },
      { dir, labelPrefix: 'ai.instar.lv-run.t', cwd: '/w', seams: f.s });
    expect(h.pid).toBe(4242);
    const plist = fs.readdirSync(dir).find((n) => n.endsWith('.plist'))!;
    const xml = fs.readFileSync(path.join(dir, plist), 'utf8');
    expect(xml).toContain('<string>nice</string><string>-n</string><string>10</string><string>node</string>');
    expect(xml).not.toContain('DROP');
    f.fire();
    await expect(h.exited).resolves.toEqual({ status: 1, signal: null });
    expect(f.calls.some((c) => c[0] === 'bootout')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps watching while the process is alive', async () => {
    let alive = true;
    const f = fakeSeams({ alive: () => alive });
    const h = spawnViaLaunchd({ command: 'c', args: [], env: {}, logFile: '/l' }, { dir: tmp(), labelPrefix: 'p', cwd: '/', seams: f.s });
    let done = false;
    void h.exited.then(() => { done = true; });
    f.fire(); await Promise.resolve();
    expect(done).toBe(false);
    alive = false; f.fire();
    await h.exited;
    expect(done).toBe(true);
  });

  it('throws (so the caller uses the plain spawn) when bootstrap fails, leaving no plist', () => {
    const dir = tmp();
    const f = fakeSeams({ bootstrapFails: true });
    expect(() => spawnViaLaunchd({ command: 'c', args: [], env: {}, logFile: '/l' }, { dir, labelPrefix: 'p', cwd: '/', seams: f.s })).toThrow(/bootstrap failed/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('throws and boots the job out when no pid is recorded in time', () => {
    const dir = tmp();
    const f = fakeSeams({ startWritesPid: false });
    expect(() => spawnViaLaunchd({ command: 'c', args: [], env: {}, logFile: '/l' }, { dir, labelPrefix: 'p', cwd: '/', seams: f.s, pidWaitMs: 1000 })).toThrow(/no pid/);
    expect(f.calls.some((c) => c[0] === 'bootout')).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('no pid and the job cannot be stopped (still listed): refuses the plain-spawn fallback', () => {
    const dir = tmp();
    const label = { v: '' };
    const f = fakeSeams({ startWritesPid: false, bootoutFails: true, list: () => `123\t0\t${label.v}\n` });
    const orig = f.s.launchctl;
    f.s.launchctl = (args) => { if (args[0] === 'bootstrap') label.v = String(args[2]).split('/').pop()!.replace(/\.plist$/, ''); return orig(args); };
    expect(() => spawnViaLaunchd({ command: 'c', args: [], env: {}, logFile: '/l' }, { dir, labelPrefix: 'p', cwd: '/', seams: f.s, pidWaitMs: 1000 })).toThrow(LaunchdNoFallbackError);
  });

  it('no pid and the boot-out fails but the job is gone: an ordinary error (fallback allowed)', () => {
    const dir = tmp();
    const f = fakeSeams({ startWritesPid: false, bootoutFails: true, list: '' });
    let err: unknown;
    try { spawnViaLaunchd({ command: 'c', args: [], env: {}, logFile: '/l' }, { dir, labelPrefix: 'p', cwd: '/', seams: f.s, pidWaitMs: 1000 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LaunchdNoFallbackError);
  });

  it('sweeps only this prefix and only jobs that are not running', () => {
    const dir = tmp();
    const f = fakeSeams({ list: 'PID\tStatus\tLabel\n-\t0\tpre.1\n77\t0\tpre.2\n-\t0\tother.1\n-\t0\tpreX.1\n' });
    expect(sweepStale('pre', dir, f.s)).toBe(1);
    expect(f.calls.filter((c) => c[0] === 'bootout')).toEqual([['bootout', 'gui/501/pre.1']]);
  });

  it('removes leftover plist/pid files of this prefix with no launchd job, never a live job\'s files', () => {
    const dir = tmp();
    for (const f of ['pre.9.plist', 'pre.9.pid', 'pre.2.plist', 'pre.2.pid', 'other.1.plist']) fs.writeFileSync(path.join(dir, f), 'x');
    const f = fakeSeams({ list: 'PID\tStatus\tLabel\n77\t0\tpre.2\n' });
    sweepStale('pre', dir, f.s);
    expect(fs.readdirSync(dir).sort()).toEqual(['other.1.plist', 'pre.2.pid', 'pre.2.plist']);
  });

  it('gives each agent home its own label prefix', () => {
    expect(launchdLabelPrefix('/a/.instar')).not.toBe(launchdLabelPrefix('/b/.instar'));
    expect(launchdLabelPrefix('/a/.instar')).toMatch(/^ai\.instar\.lv-run\.[0-9a-f]{10}$/);
  });
});
