// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Unit tests for ActiveWorkSilenceSentinel.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect } from 'vitest';
import {
  ActiveWorkSilenceSentinel,
  type SessionRegistryEntry,
} from '../../../src/monitoring/ActiveWorkSilenceSentinel.js';

interface Captured { sessionName: string; text: string; }

function makeDeps(opts: {
  sessions?: SessionRegistryEntry[];
  nudgeAccept?: boolean;
  recoveredAfterNudge?: boolean;
  now?: number;
} = {}) {
  const sessions = [...(opts.sessions ?? [])];
  let nudgeAccepted = opts.nudgeAccept ?? true;
  const captured: Captured[] = [];
  const timers: Array<() => void> = [];
  let now = opts.now ?? 1_000_000_000;
  return {
    listSessions: () => sessions.map(s => ({ ...s })),
    nudgeFn: async (sessionName: string) => {
      if (nudgeAccepted && opts.recoveredAfterNudge) {
        const s = sessions.find(x => x.sessionName === sessionName);
        if (s) s.lastOutputAt = now;
      }
      return nudgeAccepted;
    },
    notifyFn: async (sessionName: string, text: string) => {
      captured.push({ sessionName, text });
    },
    now: () => now,
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
    advanceClock: (ms: number) => { now += ms; },
    setNudgeAccepted: (v: boolean) => { nudgeAccepted = v; },
    setSessions: (s: SessionRegistryEntry[]) => { sessions.splice(0, sessions.length, ...s); },
  };
}

describe('ActiveWorkSilenceSentinel — detection', () => {
  it('tick() detects silence after threshold and reports the session', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [
        { sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }, // 20 min idle, threshold 15 min default
      ],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(true);
  });

  it('skips sessions inside the silence threshold', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [
        { sessionName: 'agent-1', lastOutputAt: now - 5 * 60_000 }, // 5 min idle, < 15 min
      ],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('skips sessions with no output history (lastOutputAt = 0)', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [{ sessionName: 'agent-1', lastOutputAt: 0 }] });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('skips paused sessions', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000, paused: true }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('skips sessions with another recovery in flight', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000, recoveryInFlight: true }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('report() is idempotent', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.report('agent-1', now - 20 * 60_000);
    sentinel.report('agent-1', now - 25 * 60_000);
    expect(sentinel.listActive().length).toBe(1);
  });
});

describe('ActiveWorkSilenceSentinel — recovery + escalation', () => {
  it('recovers when nudge produces output advance', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
      recoveredAfterNudge: true,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    // Allow runNudge to fire
    await new Promise(r => setImmediate(r));
    // The verify timer should be scheduled — drain it
    deps.drainTimers();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
    // No escalation message
    expect(deps.captured.some(c => /Want me to dig in/i.test(c.text))).toBe(false);
  });

  it('escalates when nudge fails to advance output', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
      recoveredAfterNudge: false,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    deps.drainTimers();
    const states = sentinel.listActive();
    expect(states[0].status).toBe('escalated');
    const esc = deps.captured.find(c => /Want me to dig in/i.test(c.text));
    expect(esc).toBeDefined();
  });

  it('escalates immediately if nudge cannot be delivered', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
      nudgeAccept: false,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    expect(sentinel.listActive()[0].status).toBe('escalated');
  });

  it('escalation payload has no jargon (B12 compliance)', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
      nudgeAccept: false,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    const esc = deps.captured.find(c => /Want me to dig in/i.test(c.text));
    expect(esc).toBeDefined();
    const lower = esc!.text.toLowerCase();
    expect(lower).not.toMatch(/\btmux\b/);
    expect(lower).not.toMatch(/\bpid\b/);
    expect(lower).not.toMatch(/\bsentinel\b/);
    expect(lower).not.toMatch(/\bfrozen\b/);
  });

  it('treats vanished session (removed from registry) as recovered', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    // Remove the session before the verify tick runs
    deps.setSessions([]);
    deps.drainTimers();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('stop() clears all state', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 20 * 60_000 }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    sentinel.stop();
    expect(sentinel.listActive().length).toBe(0);
  });
});
