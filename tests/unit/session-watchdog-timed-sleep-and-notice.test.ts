/**
 * The watchdog's two silent-gate fixes (2026-10-19, fb-62fe1e1f-0cf):
 *  - a `sleep N` that has not yet run N is a wait, not a stuck command;
 *  - the session whose command was interrupted is told, once per process.
 * Before, the watchdog SIGINT'd the sleeps inside a session's own poll loops
 * and Monitor watches, the loops ended, and the session kept reporting them as
 * armed because nothing told it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyProtectedWait, timedSleepDurationMs, EscalationLevel, type InterventionEvent } from '../../src/monitoring/SessionWatchdog.js';
import { formatWatchdogSessionNotice, formatWatchdogUserMessage } from '../../src/monitoring/watchdog-notifications.js';

describe('timed sleep floor', () => {
  it.each([
    ['sleep 300', 300_000], ['/bin/sleep 300', 300_000], ['sleep 5m', 300_000], ['sleep 1h 30m', 5_400_000],
    ['sleep 0.5', 500], ['sleep 2d', 172_800_000], ['sleep 10500', 10_500_000],
  ])('parses %s', (command, ms) => expect(timedSleepDurationMs(command)).toBe(ms));

  it.each(['sleep', 'sleep infinity', 'sleep -n 5', 'sleepy 5', 'node sleep 5', 'sleep 5x', 'sleep 0'])('refuses %s', (command) => {
    expect(timedSleepDurationMs(command)).toBeNull();
  });

  it('protects a sleep while it is within its own stated length (plus one minute)', () => {
    expect(classifyProtectedWait('sleep 300', '', 240_000)).toEqual({ protected: true, reason: 'timed-sleep' });
    expect(classifyProtectedWait('sleep 300', '', 360_000)).toEqual({ protected: true, reason: 'timed-sleep' });
  });

  it('a sleep past its length plus slack goes back to the judge', () => {
    expect(classifyProtectedWait('sleep 300', '', 361_000)).toEqual({ protected: false });
  });

  it('the two-hour protected-wait bound still applies to a very long sleep', () => {
    expect(classifyProtectedWait('sleep 10500', '', 2 * 3_600_000)).toEqual({ protected: true, reason: 'timed-sleep' }); // the bound is exclusive
    expect(classifyProtectedWait('sleep 10500', '', 2 * 3_600_000 + 1)).toEqual({ protected: false });
    expect(classifyProtectedWait('sleep 10500', '', 3_600_000)).toEqual({ protected: true, reason: 'timed-sleep' });
  });

  it('an unbounded or non-sleep command is not protected by this rule', () => {
    expect(classifyProtectedWait('sleep infinity', '', 60_000)).toEqual({ protected: false });
    expect(classifyProtectedWait('ugrep -r foo .', '', 60_000)).toEqual({ protected: false });
  });
});

function event(over: Partial<InterventionEvent>): InterventionEvent {
  return {
    sessionName: 'echo-coordinator', level: EscalationLevel.CtrlC, action: 'SIGINT 70244 (targeted)', stuckCommand: 'sleep 300',
    stuckPid: 70244, stuckParentPid: 66158, processRole: 'user-command', effectScope: 'target-process', timestamp: 1,
    principal: 'session-watchdog', reason: 'stuck-command-judge', operatorInitiated: false, ...over,
  };
}

describe('session notice', () => {
  it('names the command and pid, and says the wait is no longer running', () => {
    const text = formatWatchdogSessionNotice(event({}))!;
    expect(text).toContain('`sleep 300`');
    expect(text).toContain('pid 70244');
    expect(text).toContain('no longer running');
    expect(text).toContain('do not report it as running');
  });

  it('only on the first signal to a process, never on retries, later levels or a session kill', () => {
    expect(formatWatchdogSessionNotice(event({ action: 'Retry 1: SIGINT 70244 (targeted)' }))).toBeNull();
    expect(formatWatchdogSessionNotice(event({ level: EscalationLevel.SigTerm }))).toBeNull();
    expect(formatWatchdogSessionNotice(event({ level: EscalationLevel.KillSession, effectScope: 'session-via-reap-authority' }))).toBeNull();
  });

  it('the user-facing message for a first signal stays silent (unchanged)', () => {
    expect(formatWatchdogUserMessage(event({}))).toBeNull();
  });

  it('a long command is cut to an identifying length', () => {
    const text = formatWatchdogSessionNotice(event({ stuckCommand: `bash -c ${'x'.repeat(500)}` }))!;
    expect(text.length).toBeLessThan(500);
  });

  it('server wiring: every intervention is offered to the session notice, injected first-party, deduped per process', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf8');
    const at = src.indexOf("watchdog.on('intervention'");
    expect(at).toBeGreaterThan(0);
    const handler = src.slice(at - 600, at + 900);
    expect(handler).toContain('formatWatchdogSessionNotice(event)');
    expect(handler).toContain("sessionManager.injectMessage(event.sessionName, sessionNotice, { firstParty: { source: 'watchdog-intervention-notice' } })");
    expect(handler).toContain('`${event.sessionName}:${event.stuckPid}`');
  });
});
