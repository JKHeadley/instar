// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Unit tests for SocketDisconnectSentinel.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect } from 'vitest';
import {
  SocketDisconnectSentinel,
  detectSocketDisconnect,
  SOCKET_DISCONNECT_PATTERNS,
} from '../../../src/monitoring/SocketDisconnectSentinel.js';

describe('detectSocketDisconnect', () => {
  it('matches Claude Code\'s canonical "socket connection closed unexpectedly"', () => {
    expect(detectSocketDisconnect('foo\nsocket connection closed unexpectedly\nbar')).toBe(true);
  });

  it('matches ECONNRESET variant near claude', () => {
    expect(detectSocketDisconnect('Error: ECONNRESET from claude-code stream')).toBe(true);
  });

  it('matches generic "connection closed unexpectedly"', () => {
    expect(detectSocketDisconnect('the connection was closed unexpectedly here')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(detectSocketDisconnect('all systems normal; processing message')).toBe(false);
  });

  it('empty/undefined input is false (no throw)', () => {
    expect(detectSocketDisconnect('')).toBe(false);
    expect(detectSocketDisconnect(undefined as unknown as string)).toBe(false);
  });

  it('has at least one canonical pattern in the exported list', () => {
    expect(SOCKET_DISCONNECT_PATTERNS.length).toBeGreaterThan(0);
  });
});

interface Captured { sessionName: string; text: string; }

function makeDeps(opts: {
  recentOutput?: string | (() => string);
  resumeAccept?: boolean;
  notifyCapture?: Captured[];
  recoveredAfter?: number; // attempts before output flips
} = {}) {
  let attemptCount = 0;
  let nudgeAccepted = opts.resumeAccept ?? true;
  let currentOutput = typeof opts.recentOutput === 'function' ? opts.recentOutput() : (opts.recentOutput ?? 'socket connection closed unexpectedly');
  const captured: Captured[] = opts.notifyCapture ?? [];
  const timers: Array<() => void> = [];
  return {
    getRecentOutput: (_sessionName: string) => {
      if (opts.recoveredAfter !== undefined && attemptCount >= opts.recoveredAfter) {
        return 'normal output — no disconnect string';
      }
      return currentOutput;
    },
    resumeFn: async (_sessionName: string) => {
      attemptCount++;
      return nudgeAccepted;
    },
    notifyFn: async (sessionName: string, text: string) => {
      captured.push({ sessionName, text });
    },
    setTimer: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return { ref: () => {}, unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (_handle: ReturnType<typeof setTimeout>) => {},
    captured,
    drainTimers: () => {
      while (timers.length > 0) {
        const fn = timers.shift();
        if (fn) fn();
      }
    },
    setNudgeAccepted: (v: boolean) => { nudgeAccepted = v; },
    setOutput: (s: string) => { currentOutput = s; },
  };
}

describe('SocketDisconnectSentinel — lifecycle', () => {
  it('report() creates state, sends first user notice, and schedules an attempt', () => {
    const deps = makeDeps();
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.report('agent-1');
    expect(sentinel.isRecoveryActive('agent-1')).toBe(true);
    expect(deps.captured.length).toBe(1);
    expect(deps.captured[0].text).toMatch(/lost its connection/i);
  });

  it('report() is idempotent — second call within recovery is a no-op', () => {
    const deps = makeDeps();
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.report('agent-1');
    sentinel.report('agent-1');
    expect(deps.captured.length).toBe(1);
  });

  it('scanSession() triggers report when output contains a disconnect pattern', () => {
    const deps = makeDeps({ recentOutput: 'oops: socket connection closed unexpectedly' });
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.scanSession('agent-1');
    expect(sentinel.isRecoveryActive('agent-1')).toBe(true);
  });

  it('scanSession() no-ops when output is clean', () => {
    const deps = makeDeps({ recentOutput: 'all good' });
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.scanSession('agent-1');
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('recovers when output clears within verify window', async () => {
    const deps = makeDeps({ recoveredAfter: 1 });
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.report('agent-1');
    // First drain: backoff timer fires runAttempt → resumeFn (attemptCount=1) → schedules verify
    deps.drainTimers();
    // Allow the async runAttempt to schedule the verify timer
    await new Promise(r => setImmediate(r));
    deps.drainTimers();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
    expect(deps.captured.some(c => /reconnected and back to work/i.test(c.text))).toBe(true);
  });

  it('escalates after maxAttempts when output never clears', async () => {
    const deps = makeDeps({ /* output never clears */ });
    const sentinel = new SocketDisconnectSentinel(deps, { maxAttempts: 2, backoffScheduleMs: [10, 10] });
    sentinel.report('agent-1');
    // Drain enough cycles to hit maxAttempts.
    for (let i = 0; i < 6; i++) {
      deps.drainTimers();
      await new Promise(r => setImmediate(r));
    }
    const states = sentinel.listActive();
    expect(states[0].status).toBe('escalated');
    const escalation = deps.captured.find(c => /Want me to dig in/i.test(c.text));
    expect(escalation).toBeDefined();
  });

  it('escalation payload has no jargon (B12 compliance)', async () => {
    const deps = makeDeps();
    const sentinel = new SocketDisconnectSentinel(deps, { maxAttempts: 1, backoffScheduleMs: [10] });
    sentinel.report('agent-1');
    for (let i = 0; i < 4; i++) {
      deps.drainTimers();
      await new Promise(r => setImmediate(r));
    }
    const escalation = deps.captured.find(c => /Want me to dig in/i.test(c.text));
    expect(escalation).toBeDefined();
    const lower = (escalation!.text).toLowerCase();
    expect(lower).not.toMatch(/\bpid\b/);
    expect(lower).not.toMatch(/\btmux\b/);
    expect(lower).not.toMatch(/\bsocket\b/);
    expect(lower).not.toMatch(/\bwebsocket\b/);
    expect(lower).not.toMatch(/\bECONNRESET\b/i);
  });

  it('escalates immediately if nudge cannot be delivered', async () => {
    const deps = makeDeps({ resumeAccept: false });
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.report('agent-1');
    deps.drainTimers();
    await new Promise(r => setImmediate(r));
    const states = sentinel.listActive();
    expect(states[0].status).toBe('escalated');
  });

  it('shutdown() clears all state and timers', () => {
    const deps = makeDeps();
    const sentinel = new SocketDisconnectSentinel(deps);
    sentinel.report('agent-1');
    sentinel.report('agent-2');
    sentinel.shutdown();
    expect(sentinel.listActive().length).toBe(0);
  });
});
