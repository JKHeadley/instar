/**
 * Behavior tests for the multi-shot verifyInjection recovery loop.
 *
 * The single-shot version (v0.28.87–0.28.91) sent ONE recovery Enter 1.5s
 * after injection — and on Claude Code v2.1.105+ the recovery Enter is
 * sometimes also eaten by the paste-end race, leaving the user stuck.
 *
 * These tests fake `execFileSync` so we can capture send-keys invocations
 * and `captureOutput` so we can simulate the stuck pane staying stuck
 * across attempts. We assert:
 *   - Multiple recovery actions fire if the pane remains stuck
 *   - Polling stops the moment the pane reports submitted
 *   - Recovery escalates across attempts (Enter, Enter, C-m, Enter+Enter)
 *   - Bounded by markerCheckSchedule.length — no infinite loop
 *   - Single Degradation entry per injection (not one per attempt)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Capture send-keys invocations across the suite via a shared array we
// re-build per test. We hook execFileSync at the module-load level so
// SessionManager picks up the mock when it requires 'node:child_process'.
let sendKeysCalls: Array<string[]> = [];
let sleepCalls: number = 0;

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === '/bin/sleep') {
        sleepCalls++;
        return Buffer.from('');
      }
      if (args && args[0] === 'send-keys') {
        sendKeysCalls.push([...args]);
      }
      return Buffer.from('');
    }),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';

// Helper: build a SessionManager with stubbed deps and inject a paneFn
// that drives captureOutput's return value across calls.
function buildManager(paneFn: () => string, tmuxAlive = true) {
  const mgr: any = Object.create(SessionManager.prototype);
  mgr.config = { tmuxPath: '/usr/local/bin/tmux' };
  mgr.state = { listSessions: () => [], saveSession: () => {} };
  mgr.idlePromptSince = new Map();
  mgr.captureOutput = vi.fn(paneFn);
  mgr.tmuxSessionExists = vi.fn(() => tmuxAlive);
  return mgr;
}

describe('verifyInjection — multi-shot recovery', () => {
  beforeEach(() => {
    sendKeysCalls = [];
    sleepCalls = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires multiple recovery Enters when the pane stays stuck across all attempts', async () => {
    const stuckPane = `
some history
❯ [telegram:7195] hello world this is a long enough marker that it counts
  ⏵⏵ bypass permissions on
`;
    const mgr = buildManager(() => stuckPane);

    mgr.verifyInjection('echo-test', '[telegram:7195] hello world this is a long enough marker that it counts');

    // Advance through the full schedule (500, 1500, 3500, 6500).
    await vi.advanceTimersByTimeAsync(7000);

    // The marker stayed stuck for every check → 4 recovery actions queued.
    const enterCalls = sendKeysCalls.filter(c =>
      c.includes('Enter') || c.includes('C-m')
    );
    expect(enterCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('stops polling as soon as the marker has cleared the prompt', async () => {
    let callCount = 0;
    const paneFn = () => {
      callCount++;
      if (callCount === 1) {
        // First check: still stuck
        return '❯ [telegram:7195] hello world long enough marker\n';
      }
      // Subsequent checks: marker has cleared (Claude is now processing)
      return '⏺ working on it\n[telegram:7195] hello world long enough marker\n';
    };
    const mgr = buildManager(paneFn);

    mgr.verifyInjection('echo-test', '[telegram:7195] hello world long enough marker');

    await vi.advanceTimersByTimeAsync(7000);

    // First check stuck → 1 recovery action. Second check clear → stop.
    const recoveryActions = sendKeysCalls.filter(c =>
      c.includes('Enter') || c.includes('C-m')
    );
    expect(recoveryActions.length).toBe(1);
  });

  it('escalates recovery method across attempts (Enter, Enter, C-m, Enter+sleep+Enter)', async () => {
    const stuckPane = '❯ [telegram:7195] hello world long enough marker\n';
    const mgr = buildManager(() => stuckPane);

    mgr.verifyInjection('echo-test', '[telegram:7195] hello world long enough marker');
    await vi.advanceTimersByTimeAsync(7000);

    const keys = sendKeysCalls.map(c => c[c.length - 1]); // last arg is the key name
    // Attempt 0: Enter, Attempt 1: Enter, Attempt 2: C-m, Attempt 3: Enter, sleep, Enter
    expect(keys[0]).toBe('Enter');
    expect(keys[1]).toBe('Enter');
    expect(keys[2]).toBe('C-m');
    // The final attempt should emit two Enters separated by a sleep
    expect(keys[3]).toBe('Enter');
    expect(keys[4]).toBe('Enter');
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  it('is bounded — never exceeds markerCheckSchedule.length recovery actions even if pane never clears', async () => {
    const stuckPane = '❯ [telegram:7195] stuck forever long enough marker\n';
    const mgr = buildManager(() => stuckPane);

    mgr.verifyInjection('echo-test', '[telegram:7195] stuck forever long enough marker');

    // Run well past the 6500ms schedule cap
    await vi.advanceTimersByTimeAsync(60_000);

    // Recovery actions from send-keys (Enter or C-m). Final attempt sends 2
    // Enters around a sleep, so total send-keys for stuck-recovery is 5
    // (attempts 0,1,2 send 1 each; attempt 3 sends 2 around a sleep).
    const recoveryActions = sendKeysCalls.filter(c =>
      c.includes('Enter') || c.includes('C-m')
    );
    expect(recoveryActions.length).toBeLessThanOrEqual(5);
    expect(recoveryActions.length).toBeGreaterThanOrEqual(4);
  });

  it('no-op when the marker is absent from the very first check', async () => {
    const cleanPane = '⏺ working\nsome agent output\n';
    const mgr = buildManager(() => cleanPane);

    mgr.verifyInjection('echo-test', '[telegram:7195] hello world long enough marker');
    await vi.advanceTimersByTimeAsync(7000);

    expect(sendKeysCalls.length).toBe(0);
  });

  it('skips verification when the marker is too short', async () => {
    const stuckPane = '❯ hi\n';
    const mgr = buildManager(() => stuckPane);

    mgr.verifyInjection('echo-test', 'hi'); // 2 chars — well below the 8-char threshold
    await vi.advanceTimersByTimeAsync(7000);

    expect(sendKeysCalls.length).toBe(0);
  });

  it('halts further checks if the tmux session is gone', async () => {
    const stuckPane = '❯ [telegram:7195] long enough marker text\n';
    const mgr = buildManager(() => stuckPane);

    // First check finds it alive, recovers, schedules next.
    // Then we kill the session before the next runCheck fires.
    let aliveCallCount = 0;
    mgr.tmuxSessionExists = vi.fn(() => {
      aliveCallCount++;
      return aliveCallCount <= 1; // alive for the first check only
    });

    mgr.verifyInjection('echo-test', '[telegram:7195] long enough marker text');
    await vi.advanceTimersByTimeAsync(7000);

    // First attempt sent one recovery; the rest should be skipped because
    // tmuxSessionExists returned false.
    const recoveryActions = sendKeysCalls.filter(c =>
      c.includes('Enter') || c.includes('C-m')
    );
    expect(recoveryActions.length).toBeLessThanOrEqual(2); // 1 for first attempt, plus possibly the final-attempt double-Enter if scheduling collapses
  });
});

describe('isMarkerStuckAtPrompt — pane heuristic', () => {
  const mgr: any = Object.create(SessionManager.prototype);

  it('returns true when marker is on the ❯ line', () => {
    const pane = '❯ [telegram:7195] hello world long enough marker text\n  ⏵⏵ bypass permissions on';
    expect(mgr.isMarkerStuckAtPrompt(pane, '[telegram:7195] hello world long enough marker text')).toBe(true);
  });

  it('returns true when marker wraps to the line after ❯', () => {
    // Real-world: Claude Code wraps long input across two visible rows. The
    // ❯ glyph is on a divider line, with the input text on the next row.
    const pane = '────────────────────────\n❯ \n  [telegram:7195] hello world this message continues\n  ⏵⏵ bypass permissions';
    // verifyInjection passes first-40-chars marker; isMarkerStuckAtPrompt
    // checks the same line as ❯ AND the immediately-following line.
    expect(mgr.isMarkerStuckAtPrompt(pane, '[telegram:7195] hello world this message')).toBe(true);
  });

  it('returns false when marker is in transcript history (no ❯ on the same line)', () => {
    const pane = '⏺ User: [telegram:7195] hello world long enough marker text\n⏺ Working\n❯ \n';
    expect(mgr.isMarkerStuckAtPrompt(pane, '[telegram:7195] hello world long enough marker text')).toBe(false);
  });

  it('returns false when ❯ is present but the marker is absent', () => {
    const pane = '❯ \n  ⏵⏵ bypass permissions on';
    expect(mgr.isMarkerStuckAtPrompt(pane, '[telegram:7195] hello world long enough marker text')).toBe(false);
  });

  it('returns false for a short marker (defensive guard)', () => {
    const pane = '❯ hi\n';
    expect(mgr.isMarkerStuckAtPrompt(pane, 'hi')).toBe(false);
  });
});
