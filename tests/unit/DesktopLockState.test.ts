import { describe, expect, it } from 'vitest';
import { classifyDesktopLock, isLockedClass, parseScreenLockPolicy, type DesktopLockInputs, type DesktopLockSample } from '../../src/core/DesktopLockState.js';

const NOW = 1_000_000;
const inputs = (over: Partial<DesktopLockInputs> = {}): DesktopLockInputs => ({
  shieldWindow: false, secureInputOwner: 'none', displayAsleep: false, screensaver: false,
  onlineDisplays: 1, thisUser: 'echo', consoleUser: 'echo', osMajor: 26, sampledAtMs: NOW, ...over,
});
const sample = (flag: boolean, over: Partial<DesktopLockInputs> = {}, rest: Partial<DesktopLockSample> = {}): DesktopLockSample => ({
  screenLocked: flag, onConsole: true, loginDone: true, lockInputs: inputs(over), ...rest,
});

describe('classifyDesktopLock', () => {
  it('reads the ordinary lock only when the flag and the shield agree', () => {
    expect(classifyDesktopLock(sample(true, { shieldWindow: true }), 'on', NOW)).toBe('locked-in-session');
    expect(classifyDesktopLock(sample(true), 'on', NOW)).toBe('unknown');
    expect(classifyDesktopLock(sample(false, { shieldWindow: true }), 'on', NOW)).toBe('unknown');
  });

  it('reads an awake, shieldless, flag-false session as unlocked', () => {
    expect(classifyDesktopLock(sample(false), 'on', NOW)).toBe('unlocked');
  });

  it('never reads a sleeping display as unlocked when a password may be needed', () => {
    for (const policy of ['on', 'delayed', 'unreadable', 'pending'] as const) {
      expect(classifyDesktopLock(sample(false, { displayAsleep: true }), policy, NOW)).toBe('locked-by-policy');
    }
    expect(classifyDesktopLock(sample(false, { displayAsleep: true }), 'off', NOW)).toBe('screensaver-or-sleep');
    expect(classifyDesktopLock(sample(true, { displayAsleep: true }), 'off', NOW)).toBe('locked-by-policy');
    expect(classifyDesktopLock(sample(false, { screensaver: true }), 'off', NOW)).toBe('screensaver-or-sleep');
  });

  it('names who else holds the console', () => {
    expect(classifyDesktopLock(sample(false, { consoleUser: 'mia' }), 'on', NOW)).toBe('other-user-on-console');
    expect(classifyDesktopLock(sample(false, { consoleUser: 'loginwindow' }), 'on', NOW)).toBe('login-window-switched');
    expect(classifyDesktopLock(sample(false, {}, { onConsole: false }), 'on', NOW)).toBe('login-window-switched');
    expect(classifyDesktopLock(sample(false, { consoleUser: undefined }), 'on', NOW)).toBe('login-window-switched');
  });

  it('answers unknown for a stale or partial sample, before the table', () => {
    expect(classifyDesktopLock(sample(false, { sampledAtMs: NOW - 2_001 }), 'on', NOW)).toBe('unknown');
    expect(classifyDesktopLock({ screenLocked: false, onConsole: true, loginDone: true }, 'on', NOW)).toBe('unknown');
    expect(classifyDesktopLock(sample(false, {}, { screenLocked: undefined }), 'on', NOW)).toBe('unknown');
  });

  it('treats only the locked states as locked-class', () => {
    expect(['locked-in-session', 'locked-by-policy', 'unknown'].every(s => isLockedClass(s as never))).toBe(true);
    expect(['unlocked', 'screensaver-or-sleep', 'login-window-switched'].some(s => isLockedClass(s as never))).toBe(false);
  });
});

describe('parseScreenLockPolicy', () => {
  it('reads the sysadminctl forms and never guesses', () => {
    expect(parseScreenLockPolicy('screenLock is off')).toBe('off');
    expect(parseScreenLockPolicy('screenLock delay is 0 seconds')).toBe('on');
    expect(parseScreenLockPolicy('screenLock delay is 300 seconds')).toBe('delayed');
    expect(parseScreenLockPolicy('Error')).toBe('unreadable');
  });
});
