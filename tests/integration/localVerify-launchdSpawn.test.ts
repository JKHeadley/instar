/**
 * Real launchd (macOS only): the run child starts as an Interactive job, leads its own
 * process group, gets a normal scheduling priority (31, not the 20 a session-descended
 * process gets), appends to the log, and reports its exit status.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnViaLaunchd } from '../../src/localVerify/launchdSpawn.js';

const mac = process.platform === 'darwin' && !process.env.CI;

describe.skipIf(!mac)('launchdSpawn on real launchd', () => {
  it('runs the command as an Interactive job and reports its exit status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-launchd-int-'));
    const log = path.join(dir, 'run.log');
    fs.writeFileSync(log, 'before\n');
    const script = path.join(dir, 'child.sh');
    fs.writeFileSync(script, '#!/bin/sh\necho "pgid=$(ps -o pgid= -p $$ | tr -d " ") pid=$$ pri=$(ps -o pri= -p $$ | tr -d " ") v=$V"\nexit 7\n', { mode: 0o755 });
    const h = spawnViaLaunchd({ command: '/bin/sh', args: [script], env: { PATH: '/usr/bin:/bin', V: 'ok' }, logFile: log },
      { dir: path.join(dir, 'jobs'), labelPrefix: `ai.instar.lv-run.test${process.pid}`, cwd: dir, pollMs: 100 });
    expect(h.pid).toBeGreaterThan(0);
    await expect(h.exited).resolves.toEqual({ status: 7, signal: null });
    const out = fs.readFileSync(log, 'utf8');
    expect(out.startsWith('before\n')).toBe(true);
    const m = /pgid=(\d+) pid=(\d+) pri=(\d+) v=ok/.exec(out);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    expect(Number(m![3])).toBeGreaterThanOrEqual(31);
    expect(fs.readdirSync(path.join(dir, 'jobs'))).toEqual([]);
    expect(execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' })).not.toContain(`lv-run.test${process.pid}`);
  }, 30_000);

  it('reports a signal when the process group is killed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-launchd-int-'));
    const h = spawnViaLaunchd({ command: '/bin/sleep', args: ['30'], env: { PATH: '/bin' }, logFile: path.join(dir, 'l') },
      { dir: path.join(dir, 'jobs'), labelPrefix: `ai.instar.lv-run.testk${process.pid}`, cwd: dir, pollMs: 100 });
    process.kill(-h.pid, 'SIGKILL');
    await expect(h.exited).resolves.toEqual({ status: null, signal: 'SIGKILL' });
  }, 30_000);
});
