/**
 * Unit tests — ServerSupervisor agent hard-sleep mechanism (Stage B slice 2).
 *
 * The handshake mirrors restart-requested.json: a sleep-request stops the server
 * and enters `slept` (the health loop then suppresses auto-respawn); a wake-request
 * respawns it. THE safety-critical invariant: a slept server is NOT treated as
 * crashed (no auto-respawn), and a genuine crash while NOT slept still recovers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as childProcess from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] })), execFileSync: vi.fn(() => '') };
});
vi.mock('../../src/core/Config.js', () => ({ detectTmuxPath: () => '/usr/bin/tmux' }));
vi.mock('../../src/core/SleepWakeDetector.js', () => ({
  SleepWakeDetector: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn(), on: vi.fn() })),
}));

import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-sleep-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  return dir;
}

describe('ServerSupervisor — agent hard-sleep', () => {
  let dir: string;
  let stateDir: string;
  let sup: ServerSupervisor;

  beforeEach(() => {
    dir = tmp();
    stateDir = path.join(dir, '.instar');
    sup = new ServerSupervisor({ projectDir: dir, projectName: 'test-agent', port: 0, stateDir });
    (childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>).mockClear();
  });
  afterEach(() => {
    if (fs.existsSync(dir)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ServerSupervisor-sleep-wake.test.ts' });
  });

  const flag = (name: string, body: object = {}) =>
    fs.writeFileSync(path.join(stateDir, 'state', name), JSON.stringify(body));
  const exists = (name: string) => fs.existsSync(path.join(stateDir, 'state', name));

  it('checkSleepRequest stops the server + enters slept + writes the slept-marker', () => {
    flag('sleep-requested.json', { reason: 'deep-idle 30m', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    (sup as any).checkSleepRequest();
    expect((sup as any).slept).toBe(true);
    expect(exists('slept-marker.json')).toBe(true);
    expect(exists('sleep-requested.json')).toBe(false); // consumed
    // killed the tmux server session
    const calls = (childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => Array.isArray(c[1]) && c[1][0] === 'kill-session')).toBe(true);
  });

  it('no sleep-request → no-op (server NOT slept, no marker)', () => {
    (sup as any).checkSleepRequest();
    expect((sup as any).slept).toBe(false);
    expect(exists('slept-marker.json')).toBe(false);
  });

  it('an EXPIRED sleep-request is ignored (consumed, but does not sleep)', () => {
    flag('sleep-requested.json', { reason: 'stale', expiresAt: new Date(Date.now() - 1000).toISOString() });
    (sup as any).checkSleepRequest();
    expect((sup as any).slept).toBe(false);
    expect(exists('slept-marker.json')).toBe(false);
    expect(exists('sleep-requested.json')).toBe(false); // still consumed
  });

  it('checkWakeRequest (while slept) respawns the server + clears slept + marker', () => {
    const spawnSpy = vi.spyOn(sup as any, 'spawnServer').mockReturnValue(true);
    // put it to sleep first
    flag('sleep-requested.json', {});
    (sup as any).checkSleepRequest();
    expect((sup as any).slept).toBe(true);
    // now wake
    flag('wake-requested.json', {});
    (sup as any).checkWakeRequest();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect((sup as any).slept).toBe(false);
    expect(exists('slept-marker.json')).toBe(false);
    expect(exists('wake-requested.json')).toBe(false); // consumed
  });

  it('checkWakeRequest is a no-op when NOT slept (never spuriously respawns)', () => {
    const spawnSpy = vi.spyOn(sup as any, 'spawnServer').mockReturnValue(true);
    flag('wake-requested.json', {});
    (sup as any).checkWakeRequest();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect((sup as any).slept).toBe(false);
  });

  it('sleeping is idempotent: a second checkSleepRequest while already slept is a no-op', () => {
    flag('sleep-requested.json', {});
    (sup as any).checkSleepRequest();
    const killCountAfterFirst = (childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    flag('sleep-requested.json', {});
    (sup as any).checkSleepRequest(); // slept===true → early return, flag untouched by this method
    expect((childProcess.execFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(killCountAfterFirst);
  });

  it('sleptMarkerPresent reflects the marker on disk (boot-time stay-asleep signal)', () => {
    expect((sup as any).sleptMarkerPresent()).toBe(false);
    flag('slept-marker.json', { sleptAt: new Date().toISOString() });
    expect((sup as any).sleptMarkerPresent()).toBe(true);
  });

  it('wakeFromSleep clears slept + marker (operator escape hatch — /lifeline restart)', () => {
    flag('sleep-requested.json', {});
    (sup as any).checkSleepRequest();
    expect((sup as any).slept).toBe(true);
    expect(exists('slept-marker.json')).toBe(true);
    // an explicit operator restart must clear the state so the server actually comes up
    sup.wakeFromSleep();
    expect((sup as any).slept).toBe(false);
    expect(exists('slept-marker.json')).toBe(false);
  });

  it('wakeFromSleep also clears a marker present without in-memory slept (post-reboot)', () => {
    flag('slept-marker.json', { sleptAt: new Date().toISOString() });
    expect((sup as any).slept).toBe(false); // fresh instance, not yet booted into slept
    sup.wakeFromSleep();
    expect(exists('slept-marker.json')).toBe(false);
  });
});
