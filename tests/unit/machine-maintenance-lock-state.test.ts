/**
 * Honest lock reading (docs/specs/machine-self-maintenance.md, Part A): the decision table on
 * both sides of every row, the policy parser, the probe-to-inputs mapping, and the reader's
 * platform branches and cache. No real helper or sysadminctl runs: the reader's runners are stubs.
 */
import { describe, expect, it } from 'vitest';
import { decideLockState, parsePasswordRequired, type LockReadingInputs } from '../../src/monitoring/machineMaintenance/lockState.js';
import { MachineLockStateReader, inputsFromProbe } from '../../src/core/MachineLockStateReader.js';

const base: LockReadingInputs = {
  flagLocked: false, passwordRequired: 'immediate', screensaverRunning: false, displayAsleep: false,
  lockShieldSeen: false, consoleSession: true, loginDone: true,
};
const at = (over: Partial<LockReadingInputs>) => decideLockState({ ...base, ...over });

describe('decideLockState — the spec table, first matching row wins', () => {
  it('row 1: no console session, login not done, or an unreadable needed input is unknown', () => {
    expect(at({ consoleSession: false })).toMatchObject({ lockState: 'unknown', row: 1 });
    expect(at({ consoleSession: null })).toMatchObject({ lockState: 'unknown', row: 1 });
    expect(at({ loginDone: false })).toMatchObject({ lockState: 'unknown', row: 1 });
    expect(at({ flagLocked: null })).toMatchObject({ lockState: 'unknown', row: 1 });
    expect(at({ lockShieldSeen: null })).toMatchObject({ lockState: 'unknown', row: 1 });
  });

  it('row 2: locked only when flag, shield and an immediate password all agree', () => {
    expect(at({ flagLocked: true, lockShieldSeen: true })).toMatchObject({ lockState: 'locked', row: 2 });
    // The flag alone, the 2026-11-01 reading, is never locked.
    expect(at({ flagLocked: true, lockShieldSeen: false }).lockState).not.toBe('locked');
    expect(at({ flagLocked: true, lockShieldSeen: true, passwordRequired: 'off' }).lockState).not.toBe('locked');
    expect(at({ flagLocked: true, lockShieldSeen: true, passwordRequired: null }).lockState).toBe('unknown');
  });

  it('row 3: flag set, no password, screensaver or display sleep is screensaver-or-display-sleep', () => {
    expect(at({ flagLocked: true, passwordRequired: 'off', screensaverRunning: true })).toMatchObject({ lockState: 'screensaver-or-display-sleep', row: 3 });
    expect(at({ flagLocked: true, passwordRequired: 'off', displayAsleep: true })).toMatchObject({ lockState: 'screensaver-or-display-sleep', row: 3 });
    // Without the screensaver or sleep it does not match row 3.
    expect(at({ flagLocked: true, passwordRequired: 'off' })).toMatchObject({ lockState: 'unknown', row: 5 });
    // A lock shield drawn while no password is required is conflicting evidence: unknown, not resting.
    expect(at({ flagLocked: true, passwordRequired: 'off', screensaverRunning: true, lockShieldSeen: true })).toMatchObject({ lockState: 'unknown', row: 5 });
  });

  it('row 4: flag clear and no shield is unlocked, whatever the policy', () => {
    expect(at({})).toMatchObject({ lockState: 'unlocked', row: 4 });
    expect(at({ passwordRequired: null })).toMatchObject({ lockState: 'unlocked', row: 4 });
    expect(at({ lockShieldSeen: true })).toMatchObject({ lockState: 'unknown', row: 5 });
  });

  it('row 5: a set flag under a delayed policy is unknown, with the reason', () => {
    const v = at({ flagLocked: true, passwordRequired: 'delayed', screensaverRunning: true });
    expect(v).toMatchObject({ lockState: 'unknown', row: 5 });
    expect(v.reason).toMatch(/delayed/);
  });
});

describe('parsePasswordRequired', () => {
  it('reads off, immediate, a delay and nonsense', () => {
    expect(parsePasswordRequired('screenLock is off')).toBe('off');
    expect(parsePasswordRequired('screenLock delay is 0 seconds')).toBe('immediate');
    expect(parsePasswordRequired('screenLock delay is 60 seconds')).toBe('delayed');
    expect(parsePasswordRequired('screenLock is immediate')).toBe('immediate');
    expect(parsePasswordRequired('Error: something')).toBeNull();
  });
});

describe('inputsFromProbe', () => {
  const now = 1_000_000;
  const probe = (lockInputs: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => JSON.stringify({
    screenPermission: false, inputPermission: false, displayCount: 1, sessionActive: true,
    consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: true, ...extra,
    ...(lockInputs ? { lockInputs } : {}),
  });

  it('maps a fresh sample', () => {
    const i = inputsFromProbe(probe({ shieldWindow: false, screensaver: true, displayAsleep: false, sampledAtMs: now - 100 }), 'off', now);
    expect(i).toEqual({ flagLocked: true, passwordRequired: 'off', screensaverRunning: true, displayAsleep: false, lockShieldSeen: false, consoleSession: true, loginDone: true });
    expect(decideLockState(i).lockState).toBe('screensaver-or-display-sleep');
  });

  it('treats a stale or missing lock sample as unreadable, so the verdict is unknown', () => {
    const stale = inputsFromProbe(probe({ shieldWindow: true, screensaver: false, displayAsleep: false, sampledAtMs: now - 60_000 }), 'immediate', now);
    expect(stale.lockShieldSeen).toBeNull();
    expect(decideLockState(stale).lockState).toBe('unknown');
    expect(inputsFromProbe(probe(undefined), 'immediate', now).lockShieldSeen).toBeNull();
  });

  it('a session not on the console is no console session', () => {
    expect(inputsFromProbe(probe(undefined, { onConsole: false }), 'off', now).consoleSession).toBe(false);
  });

  it('garbage and a missing helper read as every input unreadable', () => {
    expect(inputsFromProbe('not json', 'off', now).flagLocked).toBeNull();
    expect(inputsFromProbe(null, 'off', now)).toMatchObject({ flagLocked: null, passwordRequired: 'off' });
  });
});

describe('MachineLockStateReader', () => {
  it('Linux is not-applicable and WSL is unknown, without running anything', async () => {
    let runs = 0;
    const runProbe = async () => { runs++; return null; };
    expect((await new MachineLockStateReader({ platform: 'linux', wsl: false, runProbe }).read()).lockState).toBe('not-applicable');
    expect((await new MachineLockStateReader({ platform: 'linux', wsl: true, runProbe }).read()).lockState).toBe('unknown');
    expect((await new MachineLockStateReader({ platform: 'win32', runProbe }).read()).lockState).toBe('unknown');
    expect(runs).toBe(0);
  });

  it('macOS: reads the probe and the policy, keeps the raw flag beside the verdict, and caches for 5 s', async () => {
    let now = 5_000_000;
    let probes = 0;
    const reader = new MachineLockStateReader({
      platform: 'darwin', now: () => now,
      runProbe: async () => {
        probes++;
        return JSON.stringify({ screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: false, consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: true,
          lockInputs: { shieldWindow: false, screensaver: true, displayAsleep: false, sampledAtMs: now } });
      },
      runPolicy: async () => 'screenLock is off',
    });
    const r = await reader.read();
    expect(r).toMatchObject({ lockState: 'screensaver-or-display-sleep', row: 3, screenLocked: true, platform: 'darwin' });
    await reader.read();
    expect(probes).toBe(1);
    now += 6_000;
    await reader.read();
    expect(probes).toBe(2);
  });

  it('a missing helper is unknown and says why', async () => {
    const r = await new MachineLockStateReader({ platform: 'darwin', runProbe: async () => null, runPolicy: async () => 'screenLock is off' }).read();
    expect(r.lockState).toBe('unknown');
    expect(r.reason).toMatch(/helper unavailable/);
  });

  it('a failing runner never throws out of read', async () => {
    const r = await new MachineLockStateReader({ platform: 'darwin', runProbe: async () => { throw new Error('boom'); }, runPolicy: async () => { throw new Error('boom'); } }).read();
    expect(r.lockState).toBe('unknown');
  });
});
