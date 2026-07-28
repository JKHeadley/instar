// Wiring test for the settled-throttle backstop in SessionWatchdog.
//
// Regression for the 2026-05-30 incident: the old checkRateLimited gated on
// "no active child processes" + "at a prompt" + a 20-line window, so a busy dev
// session stuck on a 429 was never detected and hung until the 15-min silence
// fallback. The replacement uses the settled-output signal (throttle string in
// a widened window + pane byte-identical across polls). This verifies the
// watchdog emits 'rate-limited' for a genuinely-stuck session, stays quiet for
// a working/transient one, and never inspects the process tree.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';
import { RATE_LIMIT_SETTLED_CAPTURE_LINES } from '../../src/monitoring/rateLimitDetection.js';

function createMockSessionManager(overrides?: Record<string, unknown>) {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    captureOutput: vi.fn().mockReturnValue(null),
    sendKey: vi.fn().mockReturnValue(true),
    isSessionAlive: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any;
}

function createConfig(settleMs: number) {
  return {
    stateDir: '/tmp/test-watchdog-rl',
    sessions: { tmuxPath: 'tmux' },
    monitoring: {
      watchdog: {
        enabled: true,
        stuckCommandSec: 180,
        pollIntervalMs: 30_000,
        rateLimitSettleMs: settleMs,
      },
    },
  } as any;
}

// The exact stuck-pane shape: throttle line pushed up by the input box + footer
// + trailing blank rows — what made the old 20-line window miss it.
const STUCK_THROTTLE_PANE = [
  '  ⎿  Loaded CLAUDE.md',
  '  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
  '✻ Churned for 7m 43s',
  '',
  '─'.repeat(80),
  '❯ ',
  '─'.repeat(80),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
  ...Array(14).fill(''),
].join('\n');

// Same session a moment later — actively working again (spinner animates,
// throttle scrolled away).
const WORKING_PANE = [
  '⏺ Continuing where I left off.',
  '✽ Sock-hopping… (2m 24s · ↓ 7.5k tokens · thinking with xhigh effort)',
  '❯ ',
].join('\n');

describe('SessionWatchdog settled-throttle backstop', () => {
  let watchdog: SessionWatchdog;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let emitted: string[];

  function setup(settleMs = 0) {
    sessionManager = createMockSessionManager();
    watchdog = new SessionWatchdog(createConfig(settleMs), sessionManager, {} as any);
    emitted = [];
    watchdog.on('rate-limited', (s: string) => emitted.push(s));
  }

  beforeEach(() => setup());
  afterEach(() => watchdog.stop());

  it('emits rate-limited once the throttled pane is settled across two polls', () => {
    sessionManager.captureOutput.mockReturnValue(STUCK_THROTTLE_PANE);
    watchdog.checkRateLimited('sess');      // poll 1 → waiting (starts settle clock)
    expect(emitted).toEqual([]);
    watchdog.checkRateLimited('sess');      // poll 2 → settled (settleMs=0) → emit
    expect(emitted).toEqual(['sess']);
  });

  it('captures with the WIDENED window, not the default 20 lines', () => {
    sessionManager.captureOutput.mockReturnValue(STUCK_THROTTLE_PANE);
    watchdog.checkRateLimited('sess');
    expect(sessionManager.captureOutput).toHaveBeenCalledWith('sess', RATE_LIMIT_SETTLED_CAPTURE_LINES);
  });

  it('never inspects the process tree (busy session with a background shell still recovers)', () => {
    const getPid = vi.fn();
    const getChildren = vi.fn();
    (watchdog as any).getClaudePid = getPid;
    (watchdog as any).getChildProcesses = getChildren;
    sessionManager.captureOutput.mockReturnValue(STUCK_THROTTLE_PANE);
    watchdog.checkRateLimited('sess');
    watchdog.checkRateLimited('sess');
    expect(emitted).toEqual(['sess']);
    expect(getPid).not.toHaveBeenCalled();
    expect(getChildren).not.toHaveBeenCalled();
  });

  it('does NOT emit on the first sighting alone (must settle first)', () => {
    sessionManager.captureOutput.mockReturnValue(STUCK_THROTTLE_PANE);
    watchdog.checkRateLimited('sess');
    expect(emitted).toEqual([]);
  });

  it('does NOT emit if the pane changes between polls (session was working)', () => {
    sessionManager.captureOutput
      .mockReturnValueOnce(STUCK_THROTTLE_PANE)
      .mockReturnValueOnce(WORKING_PANE);   // pane moved on → no throttle → reset
    watchdog.checkRateLimited('sess');
    watchdog.checkRateLimited('sess');
    expect(emitted).toEqual([]);
  });

  it('does NOT emit and clears tracking when the throttle is gone', () => {
    sessionManager.captureOutput.mockReturnValue(WORKING_PANE);
    watchdog.checkRateLimited('sess');
    watchdog.checkRateLimited('sess');
    expect(emitted).toEqual([]);
  });

  it('does NOT emit when captureOutput returns null', () => {
    sessionManager.captureOutput.mockReturnValue(null);
    watchdog.checkRateLimited('sess');
    watchdog.checkRateLimited('sess');
    expect(emitted).toEqual([]);
  });

  it('respects the emit cooldown — a still-stuck pane does not re-emit every poll', () => {
    sessionManager.captureOutput.mockReturnValue(STUCK_THROTTLE_PANE);
    watchdog.checkRateLimited('sess');  // waiting
    watchdog.checkRateLimited('sess');  // settled → emit
    watchdog.checkRateLimited('sess');  // still stuck, within 60s cooldown → no 2nd emit
    expect(emitted).toEqual(['sess']);
  });
});
