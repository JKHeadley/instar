import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROLE_RESTART_MIN_INTERVAL_MS as GAP, decideRoleRestart, readLastRoleRestart, requestRoleRestart, withdrawRoleRestart } from '../../src/core/roleFollowRestart.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const base = { applies: true, bootAwake: false, nowAwake: true, lastRestartAtMs: null, nowMs: 10 * GAP };

describe('decideRoleRestart', () => {
  it('a standby that took the lease restarts', () => expect(decideRoleRestart(base)).toBe('restart'));
  it('a machine that lost the lease restarts, so its jobs stop', () =>
    expect(decideRoleRestart({ ...base, bootAwake: true, nowAwake: false })).toBe('restart'));
  it('back to the boot role needs no restart', () => expect(decideRoleRestart({ ...base, nowAwake: false })).toBe('same-as-boot'));
  it('scheduler disabled: never', () => expect(decideRoleRestart({ ...base, applies: false })).toBe('not-applicable'));
  it('a recent role restart holds, so a flapping lease cannot loop', () => {
    expect(decideRoleRestart({ ...base, lastRestartAtMs: base.nowMs - GAP + 1 })).toBe('too-soon');
    expect(decideRoleRestart({ ...base, lastRestartAtMs: base.nowMs - GAP })).toBe('restart');
  });
});

describe('requestRoleRestart', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/roleFollowRestart.test.ts:cleanup' }); });

  it('stamps the time and writes a planned restart, and the stamp reads back across a restart', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-restart-'));
    dirs.push(stateDir);
    expect(readLastRoleRestart(stateDir)).toBeNull();
    requestRoleRestart({ stateDir, now: () => 5_000 }, true);
    expect(readLastRoleRestart(stateDir)).toBe(5_000);
    const flag = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'restart-requested.json'), 'utf-8'));
    expect(flag).toMatchObject({ requestedBy: 'role-change', plannedRestart: true });
  });
  it('a failed request leaves no stamp, so the retry is not held back', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-restart-'));
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state'));
    fs.mkdirSync(path.join(stateDir, 'state', 'restart-requested.json')); // a directory: the rename must fail
    expect(() => requestRoleRestart({ stateDir, now: () => 5_000 }, true)).toThrow();
    expect(readLastRoleRestart(stateDir)).toBeNull();
  });
  it('an unreadable stamp reads as none', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-restart-'));
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state'));
    fs.writeFileSync(path.join(stateDir, 'state', 'role-restart.json'), 'nonsense');
    expect(readLastRoleRestart(stateDir)).toBeNull();
  });
});

describe('withdrawRoleRestart', () => {
  const dirs: string[] = [];
  const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'role-withdraw-')); dirs.push(d); return d; };
  const flagOf = (d: string): string => path.join(d, 'state', 'restart-requested.json');
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/roleFollowRestart.test.ts:withdraw' }); });

  it('a waiting role restart is withdrawn when the role is back to what it was at boot', () => {
    const d = mk();
    requestRoleRestart({ stateDir: d }, false);
    expect(fs.existsSync(flagOf(d))).toBe(true);
    expect(withdrawRoleRestart({ stateDir: d })).toBe(true);
    expect(fs.existsSync(flagOf(d))).toBe(false);
    // The time of the request stays, so a lease that keeps moving is still held to one restart per interval.
    expect(readLastRoleRestart(d)).not.toBeNull();
    expect(withdrawRoleRestart({ stateDir: d })).toBe(false);
  });

  it('a request written by an update is left alone', () => {
    const d = mk();
    fs.mkdirSync(path.join(d, 'state'), { recursive: true });
    const update = JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: 'auto-updater', targetVersion: '9.9.9', plannedRestart: true, pid: process.pid });
    fs.writeFileSync(flagOf(d), update);
    expect(withdrawRoleRestart({ stateDir: d })).toBe(false);
    expect(fs.readFileSync(flagOf(d), 'utf-8')).toBe(update);
  });

  it('a role request written by another process is left alone', () => {
    const d = mk();
    requestRoleRestart({ stateDir: d }, true);
    expect(withdrawRoleRestart({ stateDir: d }, process.pid + 1)).toBe(false);
    expect(fs.existsSync(flagOf(d))).toBe(true);
  });

  it('no request, or an unreadable one, withdraws nothing', () => {
    const d = mk();
    expect(withdrawRoleRestart({ stateDir: d })).toBe(false);
    fs.mkdirSync(path.join(d, 'state'), { recursive: true });
    fs.writeFileSync(flagOf(d), '{not json');
    expect(withdrawRoleRestart({ stateDir: d })).toBe(false);
    expect(fs.existsSync(flagOf(d))).toBe(true);
  });
});
