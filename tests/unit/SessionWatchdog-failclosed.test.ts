/**
 * Regression tests for the SessionWatchdog stuck-command FAIL-CLOSED fix.
 *
 * Historical bug (2026-06-09): `isCommandStuck` fail-OPENED — when the LLM
 * "stuck vs legitimate" judge was unavailable (no provider) or errored
 * (rate-limited / circuit-open / timeout, common under load), it returned
 * `true` (= stuck → send Ctrl+C). So under load the watchdog interrupted EVERY
 * command running past the 3-minute threshold — legitimate builds, test suites,
 * `docs-coverage.mjs --check` — producing "Interrupted · What should Claude do
 * instead?" out of nowhere.
 *
 * Fix: a destructive Ctrl+C must fail CLOSED. When the judge can't run, do NOT
 * interrupt below a deterministic hard ceiling; only escalate once a command has
 * run past `hardCeilingMs` (so a genuinely hung command — e.g. `crontab -`
 * waiting on stdin — is still recovered without any LLM).
 *
 * Both sides of every boundary are pinned below.
 */
import { describe, it, expect } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

function config(hardCeilingSec?: number) {
  return {
    stateDir: '/tmp/test-watchdog-failclosed',
    sessions: { tmuxPath: 'tmux' },
    monitoring: {
      watchdog: {
        enabled: true,
        stuckCommandSec: 180,
        ...(hardCeilingSec !== undefined ? { hardCeilingSec } : {}),
      },
    },
  } as any;
}

function makeWatchdog(hardCeilingSec?: number): any {
  return new SessionWatchdog(config(hardCeilingSec), {} as any, {} as any);
}

const isCommandStuck = (wd: any, cmd: string, elapsedMs: number, out = '') =>
  wd.isCommandStuck(cmd, elapsedMs, out) as Promise<boolean>;

const MIN = 60_000;

describe('SessionWatchdog — stuck-command fail-closed', () => {
  describe('LLM judge UNAVAILABLE (intelligence = null)', () => {
    it('does NOT interrupt below the hard ceiling (the fix — was fail-open)', async () => {
      const wd = makeWatchdog(30 * 60); // 30-min ceiling
      wd.intelligence = null;
      expect(await isCommandStuck(wd, 'npm test', 4 * MIN)).toBe(false);
      expect(await isCommandStuck(wd, 'node scripts/docs-coverage.mjs --check', 10 * MIN)).toBe(false);
    });

    it('DOES interrupt past the hard ceiling (deterministic recovery of a hung command)', async () => {
      const wd = makeWatchdog(30 * 60);
      wd.intelligence = null;
      expect(await isCommandStuck(wd, 'crontab -', 31 * MIN)).toBe(true);
    });

    it('never interrupts when the hard ceiling is disabled (0) — pure fail-closed', async () => {
      const wd = makeWatchdog(0);
      wd.intelligence = null;
      expect(await isCommandStuck(wd, 'crontab -', 6 * 60 * MIN)).toBe(false); // 6 hours
    });
  });

  describe('LLM judge ERRORS (rate-limited / circuit-open / timeout)', () => {
    const throwing = { evaluate: async () => { throw new Error('rate limited'); } };

    it('does NOT interrupt below the hard ceiling (the fix — was fail-open)', async () => {
      const wd = makeWatchdog(30 * 60);
      wd.intelligence = throwing;
      expect(await isCommandStuck(wd, 'npm test', 4 * MIN)).toBe(false);
    });

    it('DOES interrupt past the hard ceiling', async () => {
      const wd = makeWatchdog(30 * 60);
      wd.intelligence = throwing;
      expect(await isCommandStuck(wd, 'some-hung-cmd', 45 * MIN)).toBe(true);
    });
  });

  describe('LLM judge AVAILABLE — verdict is honored unchanged', () => {
    it('returns false when the LLM says "legitimate"', async () => {
      const wd = makeWatchdog();
      wd.intelligence = { evaluate: async () => 'legitimate' };
      expect(await isCommandStuck(wd, 'npm test', 4 * MIN)).toBe(false);
    });

    it('returns true when the LLM says "stuck"', async () => {
      const wd = makeWatchdog();
      wd.intelligence = { evaluate: async () => 'stuck' };
      expect(await isCommandStuck(wd, 'cat', 4 * MIN)).toBe(true);
    });
  });

  describe('hardCeilingExceeded helper', () => {
    it('is false below, true above, and false when disabled (0)', () => {
      const wd = makeWatchdog(30 * 60);
      expect(wd.hardCeilingExceeded(29 * MIN)).toBe(false);
      expect(wd.hardCeilingExceeded(31 * MIN)).toBe(true);
      const wdDisabled = makeWatchdog(0);
      expect(wdDisabled.hardCeilingExceeded(10 * 60 * MIN)).toBe(false);
    });
  });
});
