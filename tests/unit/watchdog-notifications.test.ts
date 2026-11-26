/**
 * Tests for user-facing watchdog notifications.
 *
 * Principle: routine auto-recovery (Ctrl+C, SIGTERM) is internal diagnostics.
 * The user only hears about it when gentle recovery fails and we had to
 * force-kill. Messages that do go out are plain English — no "SIGKILL",
 * "escalation level", raw command paths, or "watchdog" jargon.
 */
import { describe, it, expect } from 'vitest';
import { formatWatchdogUserMessage } from '../../src/monitoring/watchdog-notifications.js';
import { EscalationLevel } from '../../src/monitoring/SessionWatchdog.js';

function event(level: EscalationLevel) {
  return {
    sessionName: 'test-session',
    level,
    action: 'raw action',
    stuckCommand: '/opt/homebrew/bin/uv tool uvx workspace-mcp --tool-tier complete',
    stuckPid: 1234,
    timestamp: Date.now(),
  };
}

describe('formatWatchdogUserMessage', () => {
  it('returns null for Monitoring level (no-op)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.Monitoring))).toBeNull();
  });

  it('returns null for Ctrl+C level (routine, silent to user)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.CtrlC))).toBeNull();
  });

  it('returns null for SIGTERM level (routine, silent to user)', () => {
    expect(formatWatchdogUserMessage(event(EscalationLevel.SigTerm))).toBeNull();
  });

  it('returns a plain-English message for SIGKILL level', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.SigKill));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/stuck/i);
    expect(msg).toMatch(/force/i);
  });

  it('returns a plain-English message for KillSession level', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.KillSession));
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/stuck/i);
    expect(msg).toMatch(/fresh|new/i);
  });

  it('SIGKILL message contains no jargon', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.SigKill))!;
    expect(msg).not.toMatch(/SIGKILL|SIGTERM|Ctrl\+C|escalation|watchdog/i);
    // No raw command path
    expect(msg).not.toContain('workspace-mcp');
    expect(msg).not.toContain('/opt/homebrew');
    expect(msg).not.toContain('uvx');
  });

  it('KillSession message contains no jargon', () => {
    const msg = formatWatchdogUserMessage(event(EscalationLevel.KillSession))!;
    expect(msg).not.toMatch(/SIGKILL|SIGTERM|Ctrl\+C|escalation|watchdog/i);
    expect(msg).not.toContain('workspace-mcp');
    expect(msg).not.toContain('/opt/homebrew');
  });
});

/**
 * Interrupting a test run is not routine, however gently it is done: a Ctrl+C
 * discards everything the run had completed, and the harness that launched it
 * can still report a clean exit — so without this the person who asked for the
 * run never learns it was cut short (2026-10-20: a full suite was interrupted
 * at 61 minutes and reported as finished).
 */
describe('a test run interrupted by the watchdog is announced', () => {
  function testRunEvent(over: Record<string, unknown> = {}) {
    return {
      ...event(EscalationLevel.CtrlC),
      stuckCommand: 'npm test',
      stuckCommandKind: 'test-runner' as const,
      stuckElapsedMs: 61 * 60_000,
      stuckRetryCount: 0,
      ...over,
    };
  }

  it('speaks at Ctrl+C level, which is silent for every other command', () => {
    const msg = formatWatchdogUserMessage(testRunEvent());
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/test run/i);
    expect(msg).toMatch(/61 minutes/);
    expect(msg).toMatch(/run again/i);
  });

  it('says plainly that the work is gone, rather than implying recovery', () => {
    const msg = formatWatchdogUserMessage(testRunEvent())!;
    expect(msg).toMatch(/nothing it had finished is kept/i);
    expect(msg).not.toMatch(/recovered|picking back up/i);
  });

  it('names a wrapper honestly when the runner was below another command', () => {
    const msg = formatWatchdogUserMessage(testRunEvent({
      stuckCommand: '/usr/bin/git push origin HEAD',
      stuckCommandKind: 'test-runner-ancestor' as const,
    }))!;
    expect(msg).toMatch(/running tests/i);
    expect(msg).not.toContain('git push');
  });

  it('speaks once per episode, not once per escalation step', () => {
    expect(formatWatchdogUserMessage(testRunEvent({ stuckRetryCount: 1 }))).toBeNull();
    expect(formatWatchdogUserMessage(testRunEvent({ level: EscalationLevel.SigTerm }))).toBeNull();
  });

  it('leaves an ordinary stuck command silent at Ctrl+C', () => {
    expect(formatWatchdogUserMessage(testRunEvent({ stuckCommandKind: undefined }))).toBeNull();
  });

  it('carries no jargon and no raw command', () => {
    const msg = formatWatchdogUserMessage(testRunEvent())!;
    expect(msg).not.toMatch(/SIGINT|SIGKILL|Ctrl\+C|escalation|watchdog|npm test/i);
  });

  it('reports at least a minute for a run interrupted sooner than that', () => {
    const msg = formatWatchdogUserMessage(testRunEvent({ stuckElapsedMs: 4_000 }))!;
    expect(msg).toMatch(/1 minutes/);
  });
});
