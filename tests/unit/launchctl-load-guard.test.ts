import { describe, it, expect, afterEach } from 'vitest';
import { launchctlLoadAllowed, macOSAutoStartLoadCommands } from '../../src/commands/setup.js';

/**
 * Track C follow-up (test-hygiene): the real `launchctl bootstrap` is gated so
 * unit tests that write a plist never load a tmpdir-pointed plist into the
 * operator's real launchd (the 2026-05-28 stale-status-78 pollution).
 */
describe('launchctlLoadAllowed (test-hygiene guard)', () => {
  const savedVitest = process.env.VITEST;
  const savedSkip = process.env.INSTAR_SKIP_LAUNCHCTL_LOAD;

  afterEach(() => {
    if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
    if (savedSkip === undefined) delete process.env.INSTAR_SKIP_LAUNCHCTL_LOAD; else process.env.INSTAR_SKIP_LAUNCHCTL_LOAD = savedSkip;
  });

  it('is FALSE under a vitest run (VITEST set) — no real launchd load in tests', () => {
    process.env.VITEST = 'true';
    delete process.env.INSTAR_SKIP_LAUNCHCTL_LOAD;
    expect(launchctlLoadAllowed()).toBe(false);
  });

  it('is FALSE when INSTAR_SKIP_LAUNCHCTL_LOAD is set (explicit opt-out)', () => {
    delete process.env.VITEST;
    process.env.INSTAR_SKIP_LAUNCHCTL_LOAD = '1';
    expect(launchctlLoadAllowed()).toBe(false);
  });

  it('is TRUE in a normal (production) environment — neither flag set', () => {
    delete process.env.VITEST;
    delete process.env.INSTAR_SKIP_LAUNCHCTL_LOAD;
    expect(launchctlLoadAllowed()).toBe(true);
  });

  it('re-enables an explicitly installed service before bootstrap', () => {
    expect(macOSAutoStartLoadCommands(
      'ai.instar.instar-codey',
      '/Users/test/Library/LaunchAgents/ai.instar.instar-codey.plist',
      501,
    )).toEqual([
      ['launchctl', ['bootout', 'gui/501', '/Users/test/Library/LaunchAgents/ai.instar.instar-codey.plist']],
      ['launchctl', ['enable', 'gui/501/ai.instar.instar-codey']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/test/Library/LaunchAgents/ai.instar.instar-codey.plist']],
    ]);
  });
});
