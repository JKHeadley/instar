// safe-git-allow: test file — no git calls.
// safe-fs-allow: test file — no fs mutations.

/**
 * Unit tests for ContextWedgeSentinel.
 *
 * Spec: docs/specs/context-wedge-sentinel.md
 */

import { describe, it, expect } from 'vitest';
import {
  ContextWedgeSentinel,
  detectContextWedge,
  signatureIsTail,
  CONTEXT_WEDGE_PATTERNS,
  type WedgeRecoveryOutcome,
} from '../../../src/monitoring/ContextWedgeSentinel.js';

const WEDGE_TAIL = [
  '⏺ Bash(grep -n "Multi-machine mesh" src/cli.ts)',
  '  ⎿  Cancelled: parallel tool call Bash(rm -rf ...) errored',
  '  ⎿  API Error: 400 messages.9.content.20: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.',
  '✻ Cooked for 0s',
].join('\n');

describe('detectContextWedge', () => {
  it('matches the canonical thinking-block 400', () => {
    expect(detectContextWedge(WEDGE_TAIL)).toBe(true);
  });

  it('matches the redacted_thinking variant', () => {
    expect(detectContextWedge('`redacted_thinking` blocks in this message cannot be modified')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(detectContextWedge('all systems normal; processing message')).toBe(false);
  });

  it('empty/undefined is false (no throw)', () => {
    expect(detectContextWedge('')).toBe(false);
    expect(detectContextWedge(undefined as unknown as string)).toBe(false);
  });

  it('exports at least one pattern', () => {
    expect(CONTEXT_WEDGE_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('signatureIsTail', () => {
  it('true when the signature is in the last lines', () => {
    expect(signatureIsTail(WEDGE_TAIL)).toBe(true);
  });

  it('false when the signature scrolled out of the tail (session progressed)', () => {
    const progressed =
      WEDGE_TAIL +
      '\n' +
      Array.from({ length: 20 }, (_, i) => `working line ${i}: doing real work now`).join('\n');
    expect(detectContextWedge(progressed)).toBe(true); // still present somewhere
    expect(signatureIsTail(progressed)).toBe(false); // but not the live tail
  });
});

interface Captured { sessionName: string; text: string; }

function makeDeps(opts: {
  output?: string | (() => string);
  outcome?: WedgeRecoveryOutcome;
  notifyCapture?: Captured[];
} = {}) {
  const captured: Captured[] = opts.notifyCapture ?? [];
  const timers: Array<() => void> = [];
  let recoverCalls = 0;
  return {
    getRecentOutput: (_s: string) =>
      typeof opts.output === 'function' ? opts.output() : (opts.output ?? WEDGE_TAIL),
    recoverFn: async (_s: string): Promise<WedgeRecoveryOutcome> => {
      recoverCalls++;
      return opts.outcome ?? 'detect-only';
    },
    notifyFn: async (sessionName: string, text: string) => {
      captured.push({ sessionName, text });
    },
    setTimer: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return { ref: () => {}, unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (_h: ReturnType<typeof setTimeout>) => {},
    captured,
    get recoverCalls() { return recoverCalls; },
    drainTimers: async () => {
      while (timers.length > 0) {
        const fn = timers.shift();
        if (fn) { fn(); await Promise.resolve(); await Promise.resolve(); }
      }
    },
  };
}

describe('ContextWedgeSentinel — detection gating', () => {
  it('scanSession does NOT report when the signature is not the tail (discussing the bug)', () => {
    // A session merely discussing the error: signature present but buried, then
    // 20 lines of real work as the tail.
    const discussing =
      'Let me explain the bug: blocks in the latest assistant message cannot be modified.\n' +
      Array.from({ length: 20 }, (_, i) => `line ${i}: now writing the fix`).join('\n');
    const deps = makeDeps({ output: discussing });
    const s = new ContextWedgeSentinel(deps);
    s.scanSession('echo-discuss');
    expect(s.listActive()).toHaveLength(0);
  });

  it('scanSession reports when the signature IS the live tail', () => {
    const deps = makeDeps({ output: WEDGE_TAIL });
    const s = new ContextWedgeSentinel(deps);
    s.scanSession('echo-wedged');
    expect(s.listActive()).toHaveLength(1);
    expect(s.listActive()[0].status).toBe('confirming');
  });

  it('report is idempotent for an already-tracked session', () => {
    const deps = makeDeps();
    const s = new ContextWedgeSentinel(deps);
    s.report('echo-wedged');
    s.report('echo-wedged');
    expect(s.listActive()).toHaveLength(1);
  });
});

describe('ContextWedgeSentinel — confirm window', () => {
  it('false-alarm: signature gone from tail at confirm → cleared, no recovery', async () => {
    let out = WEDGE_TAIL;
    const deps = makeDeps({ output: () => out, outcome: 'respawned' });
    const s = new ContextWedgeSentinel(deps);
    let falseAlarm = false;
    s.on('false-alarm', () => { falseAlarm = true; });
    s.scanSession('echo-transient');
    // Session progressed during the confirm window — error scrolled out.
    out = 'normal prompt — back to work\n> ready';
    await deps.drainTimers();
    expect(falseAlarm).toBe(true);
    expect(deps.recoverCalls).toBe(0);
    expect(s.listActive()).toHaveLength(0);
  });

  it('confirmed wedge still showing tail → recoverFn invoked', async () => {
    const deps = makeDeps({ output: WEDGE_TAIL, outcome: 'detect-only' });
    const s = new ContextWedgeSentinel(deps);
    s.scanSession('echo-wedged');
    await deps.drainTimers();
    expect(deps.recoverCalls).toBe(1);
  });
});

describe('ContextWedgeSentinel — recovery outcomes', () => {
  it("'respawned' → recovered, state cleared, no escalation", async () => {
    const deps = makeDeps({ outcome: 'respawned' });
    const s = new ContextWedgeSentinel(deps);
    let recovered = false;
    s.on('recovered', () => { recovered = true; });
    s.report('echo-wedged');
    await deps.drainTimers();
    expect(recovered).toBe(true);
    expect(deps.captured).toHaveLength(0);
    expect(s.listActive()).toHaveLength(0);
  });

  it("'dry-run' → dry-run event, no escalation, state retained", async () => {
    const deps = makeDeps({ outcome: 'dry-run' });
    const s = new ContextWedgeSentinel(deps);
    let dryRun = false;
    s.on('dry-run', () => { dryRun = true; });
    s.report('echo-wedged');
    await deps.drainTimers();
    expect(dryRun).toBe(true);
    expect(deps.captured).toHaveLength(0);
    expect(s.listActive()).toHaveLength(1); // retained so it isn't re-confirmed
  });

  it("'detect-only' → escalates (the session is dead, auto-recovery off)", async () => {
    const deps = makeDeps({ outcome: 'detect-only' });
    const s = new ContextWedgeSentinel(deps);
    let escalated: { outcome: WedgeRecoveryOutcome } | null = null;
    s.on('escalated', (e) => { escalated = e; });
    s.report('echo-wedged');
    await deps.drainTimers();
    expect(escalated).not.toBeNull();
    expect(escalated!.outcome).toBe('detect-only');
    expect(deps.captured).toHaveLength(1);
    expect(deps.captured[0].text).toMatch(/restart/i);
  });

  it("'failed' → escalates with a recovery-failed message", async () => {
    const deps = makeDeps({ outcome: 'failed' });
    const s = new ContextWedgeSentinel(deps);
    s.report('echo-wedged');
    await deps.drainTimers();
    expect(deps.captured).toHaveLength(1);
    expect(deps.captured[0].text).toMatch(/did not clear/i);
  });

  it('recoverFn throwing is treated as failed (no crash)', async () => {
    const deps = makeDeps();
    deps.recoverFn = async () => { throw new Error('boom'); };
    const s = new ContextWedgeSentinel(deps);
    let recoveryError = false;
    s.on('recovery-error', () => { recoveryError = true; });
    s.report('echo-wedged');
    await deps.drainTimers();
    expect(recoveryError).toBe(true);
    expect(deps.captured).toHaveLength(1); // escalated as failed
  });
});

describe('ContextWedgeSentinel — isRecoveryActive (SessionReaper veto)', () => {
  it('true while confirming, false after recovery', async () => {
    const deps = makeDeps({ outcome: 'respawned' });
    const s = new ContextWedgeSentinel(deps);
    s.report('echo-wedged');
    expect(s.isRecoveryActive('echo-wedged')).toBe(true);
    await deps.drainTimers();
    expect(s.isRecoveryActive('echo-wedged')).toBe(false);
  });
});
