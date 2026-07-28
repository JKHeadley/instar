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
  /** Auto-heal recoverFn behaviour: true=success, false=failed respawn, 'throw'=error. */
  recoverResult?: boolean | 'throw';
} = {}) {
  const sessions = [...(opts.sessions ?? [])];
  let nudgeAccepted = opts.nudgeAccept ?? true;
  const captured: Captured[] = [];
  const recoverCalls: string[] = [];
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
    // Auto-heal respawn primitive (only consulted when cfg.autoRecover is on).
    recoverFn: async (sessionName: string) => {
      recoverCalls.push(sessionName);
      if (opts.recoverResult === 'throw') throw new Error('respawn boom');
      return opts.recoverResult ?? true;
    },
    now: () => now,
    setTimer: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return { ref: () => {}, unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (_handle: ReturnType<typeof setTimeout>) => {},
    captured,
    recoverCalls,
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
        { sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }, // 35 min idle, threshold 30 min default (HONEST-PROGRESS-MESSAGING A4)
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
        { sessionName: 'agent-1', lastOutputAt: now - 5 * 60_000 }, // 5 min idle, < 30 min
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
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000, paused: true }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('skips sessions with another recovery in flight', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000, recoveryInFlight: true }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('report() is idempotent', () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.report('agent-1', now - 35 * 60_000);
    sentinel.report('agent-1', now - 25 * 60_000);
    expect(sentinel.listActive().length).toBe(1);
  });
});

describe('ActiveWorkSilenceSentinel — recovery + escalation', () => {
  it('recovers when nudge produces output advance', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
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
    expect(deps.captured.some(c => /Want me to check/i.test(c.text))).toBe(false);
  });

  it('escalates when nudge fails to advance output', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
      recoveredAfterNudge: false,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    deps.drainTimers();
    const states = sentinel.listActive();
    expect(states[0].status).toBe('escalated');
    const esc = deps.captured.find(c => /Want me to check/i.test(c.text));
    expect(esc).toBeDefined();
  });

  it('escalates immediately if nudge cannot be delivered', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({
      now,
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
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
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
      nudgeAccept: false,
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    await new Promise(r => setImmediate(r));
    const esc = deps.captured.find(c => /Want me to check/i.test(c.text));
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
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
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
      sessions: [{ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 }],
    });
    const sentinel = new ActiveWorkSilenceSentinel(deps);
    sentinel.tick();
    sentinel.stop();
    expect(sentinel.listActive().length).toBe(0);
  });
});

describe('ActiveWorkSilenceSentinel — auto-heal ladder (dark)', () => {
  // runRecovery() chains several awaits; flush microtasks so it settles.
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const baseSession = (now: number): SessionRegistryEntry => ({ sessionName: 'agent-1', lastOutputAt: now - 35 * 60_000 });

  it('autoRecover OFF (default): a failed nudge asks the user, never respawns', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [baseSession(now)], nudgeAccept: false });
    const sentinel = new ActiveWorkSilenceSentinel(deps); // no config → autoRecover defaults false
    sentinel.tick();
    await flush();
    expect(deps.recoverCalls.length).toBe(0);
    expect(sentinel.listActive()[0].status).toBe('escalated');
    expect(deps.captured.some(c => /Want me to check/i.test(c.text))).toBe(true);
  });

  it('autoRecover ON + respawn succeeds: respawns once, notifies recovery, clears state', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [baseSession(now)], nudgeAccept: false, recoverResult: true });
    const sentinel = new ActiveWorkSilenceSentinel(deps, { autoRecover: true });
    const events: string[] = [];
    sentinel.on('recovering', () => events.push('recovering'));
    sentinel.on('recovered', () => events.push('recovered'));
    sentinel.tick();
    await flush();
    expect(deps.recoverCalls).toEqual(['agent-1']);
    expect(events).toContain('recovering');
    expect(events).toContain('recovered');
    expect(deps.captured.some(c => /auto-recovering it now/i.test(c.text))).toBe(true);
    expect(deps.captured.some(c => /I recovered it/i.test(c.text))).toBe(true);
    // No ask-the-user message on the success path.
    expect(deps.captured.some(c => /Want me to check/i.test(c.text))).toBe(false);
    // State cleared → the freshly respawned session is monitored anew.
    expect(sentinel.isRecoveryActive('agent-1')).toBe(false);
  });

  it('autoRecover ON + respawn fails: falls back to asking, keeps state (no loop)', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [baseSession(now)], nudgeAccept: false, recoverResult: false });
    const sentinel = new ActiveWorkSilenceSentinel(deps, { autoRecover: true });
    const failed: string[] = [];
    sentinel.on('recovery-failed', (n: string) => failed.push(n));
    sentinel.tick();
    await flush();
    expect(deps.recoverCalls).toEqual(['agent-1']);
    expect(failed).toEqual(['agent-1']);
    expect(sentinel.listActive()[0].status).toBe('recovery-failed');
    expect(deps.captured.some(c => /couldn't auto-recover/i.test(c.text))).toBe(true);
    // State NOT cleared — this is the loop-stopper.
    expect(sentinel.isRecoveryActive('agent-1')).toBe(true);
  });

  it('loop cap: a session that stays stuck is respawned at most once', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [baseSession(now)], nudgeAccept: false, recoverResult: false });
    const sentinel = new ActiveWorkSilenceSentinel(deps, { autoRecover: true, maxAutoRecoveries: 1 });
    sentinel.tick();
    await flush();
    // Re-tick repeatedly — the persisted recovery-failed state stops re-detection.
    sentinel.tick(); await flush();
    sentinel.tick(); await flush();
    expect(deps.recoverCalls.length).toBe(1);
  });

  it('autoRecover ON + recoverFn throws: surfaces recover-error, asks the user', async () => {
    const now = 1_000_000_000;
    const deps = makeDeps({ now, sessions: [baseSession(now)], nudgeAccept: false, recoverResult: 'throw' });
    const sentinel = new ActiveWorkSilenceSentinel(deps, { autoRecover: true });
    const errs: string[] = [];
    sentinel.on('recover-error', (e: { sessionName: string }) => errs.push(e.sessionName));
    sentinel.tick();
    await flush();
    expect(errs).toEqual(['agent-1']);
    expect(sentinel.listActive()[0].status).toBe('recovery-failed');
    expect(deps.captured.some(c => /couldn't auto-recover/i.test(c.text))).toBe(true);
  });
});
