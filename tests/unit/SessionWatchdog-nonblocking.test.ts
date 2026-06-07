/**
 * SessionWatchdog non-blocking process scans (2026-06-07 incident).
 *
 * The watchdog polls every 30s over EVERY running session, several ps/pgrep
 * probes each. With synchronous `spawnSync` those probes blocked the single
 * Node event loop for each subprocess's full duration; under load the cumulative
 * stall made the server miss its own /health window → false "server temporarily
 * down" + a restart loop. The scans are now async (execFile) and the poll yields
 * the loop between sessions. These tests pin both properties.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

function mockSessionManager(overrides?: Record<string, unknown>) {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    captureOutput: vi.fn().mockReturnValue(null),
    sendKey: vi.fn().mockReturnValue(true),
    isSessionAlive: vi.fn().mockReturnValue(true),
    ...overrides,
  } as any;
}

function config() {
  return {
    stateDir: '/tmp/test-watchdog-nonblocking',
    sessions: { tmuxPath: 'tmux' },
    monitoring: { watchdog: { enabled: true, stuckCommandSec: 180, pollIntervalMs: 30_000 } },
  } as any;
}

describe('SessionWatchdog — non-blocking process scans', () => {
  let watchdog: SessionWatchdog;

  beforeEach(() => {
    watchdog = new SessionWatchdog(config(), mockSessionManager(), {} as any);
  });
  afterEach(() => watchdog.stop());

  it('getChildProcesses is async (returns a Promise, does not block the loop)', async () => {
    const p = (watchdog as any).getChildProcesses(999999); // a pid that does not exist
    expect(typeof p.then).toBe('function'); // a Promise — the ps probe runs off the loop
    const result = await p;
    expect(Array.isArray(result)).toBe(true); // no children for a dead pid
  });

  it('getClaudePid is async and tolerates a missing session (returns null)', async () => {
    const p = (watchdog as any).getClaudePid('no-such-tmux-session-xyz');
    expect(typeof p.then).toBe('function');
    expect(await p).toBeNull();
  });

  it('the event loop stays live while a scan runs (a timer fires during an in-flight probe)', async () => {
    // Kick off a real (async) child-process probe and prove a 0ms timer still
    // fires before it resolves — i.e. the probe did not monopolize the loop.
    let timerFired = false;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => { timerFired = true; resolve(); }, 0),
    );
    const probe = (watchdog as any).getChildProcesses(999998);
    await Promise.race([timer, probe]); // the timer must win (probe yields the loop)
    expect(timerFired).toBe(true);
    await probe; // drain
  });
});

describe('SessionWatchdog — non-blocking wiring guards (regression)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'monitoring', 'SessionWatchdog.ts'),
    'utf-8',
  );

  it('does not use synchronous spawnSync for process scans', () => {
    expect(src).not.toMatch(/spawnSync\(/); // no synchronous spawn CALL (comments may mention the old one)
    expect(src).not.toMatch(/from 'node:child_process'[^\n]*spawnSync/); // not imported either
    expect(src).toContain('execFileAsync'); // async exec helper
  });

  it('the scanning helpers are async', () => {
    expect(src).toMatch(/private async getFrameworkPid\(/);
    expect(src).toMatch(/private async getChildProcesses\(/);
    expect(src).toMatch(/private async hasActivePipelineSibling\(/);
  });

  it('poll yields the event loop between sessions', () => {
    const pollBody = src.slice(src.indexOf('private async poll('), src.indexOf('private async poll(') + 900);
    expect(pollBody).toContain('setImmediate');
  });
});
