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
  detectAupRejection,
  classifyWedgeTail,
  signatureIsTail,
  CONTEXT_WEDGE_PATTERNS,
  AUP_WEDGE_PATTERNS,
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

// ── AUP-rejection family (signature 2, 2026-06-05 EXO incident) ──────────────

// Verbatim shape of the wedged pane captured during the incident: every
// injected message produces a fresh copy of the same rejection.
const AUP_ERROR_LINE =
  '⏺ API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.';

const AUP_WEDGE_TAIL = [
  '❯ [telegram:19437 "🎯 EXO 3.0" from Justin (uid:7812716706)] did you get my last 3 messages?',
  AUP_ERROR_LINE,
  '✻ Churned for 8s · 1 shell still running',
  '❯ [telegram:19437 "🎯 EXO 3.0" from Unknown] did you get my last 3 messages?',
  AUP_ERROR_LINE,
  '✻ Cogitated for 8s · 1 shell still running',
].join('\n');

// A benign ONE-OFF rejection: single occurrence, session idle after it.
const AUP_ONE_OFF_TAIL = [
  '❯ [telegram:42] some message',
  AUP_ERROR_LINE,
  '✻ Worked for 22s',
].join('\n');

describe('detectAupRejection', () => {
  it('matches the canonical AUP rejection', () => {
    expect(detectAupRejection(AUP_ERROR_LINE)).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(detectAupRejection('all systems normal; processing message')).toBe(false);
  });

  it('empty is false (no throw)', () => {
    expect(detectAupRejection('')).toBe(false);
  });

  it('exports at least one pattern', () => {
    expect(AUP_WEDGE_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('classifyWedgeTail — family discrimination', () => {
  it('classifies the repeated AUP loop as aup-rejection', () => {
    expect(classifyWedgeTail(AUP_WEDGE_TAIL)).toBe('aup-rejection');
  });

  it('a benign ONE-OFF AUP rejection is NOT a wedge (single occurrence)', () => {
    expect(classifyWedgeTail(AUP_ONE_OFF_TAIL)).toBeNull();
    expect(signatureIsTail(AUP_ONE_OFF_TAIL)).toBe(false);
  });

  it('classifies the thinking-block 400 as thinking-block-400', () => {
    expect(classifyWedgeTail(WEDGE_TAIL)).toBe('thinking-block-400');
  });

  it('AUP loop scrolled out of the tail is not a wedge (session progressed)', () => {
    const progressed =
      AUP_WEDGE_TAIL +
      '\n' +
      Array.from({ length: 20 }, (_, i) => `working line ${i}: doing real work now`).join('\n');
    expect(classifyWedgeTail(progressed)).toBeNull();
  });

  it('signatureIsTail back-compat: true for the AUP loop tail', () => {
    expect(signatureIsTail(AUP_WEDGE_TAIL)).toBe(true);
  });
});

describe('ContextWedgeSentinel — AUP wedge lifecycle', () => {
  it('scanSession detects the AUP loop and tags kind on the event', () => {
    const deps = makeDeps({ output: AUP_WEDGE_TAIL });
    const s = new ContextWedgeSentinel(deps);
    let detected: { sessionName: string; kind?: string } | null = null;
    s.on('detected', (e) => { detected = e; });
    s.scanSession('echo-exo-3-0');
    expect(detected).not.toBeNull();
    expect(detected!.kind).toBe('aup-rejection');
  });

  it('scanSession ignores the benign one-off AUP rejection', () => {
    const deps = makeDeps({ output: AUP_ONE_OFF_TAIL });
    const s = new ContextWedgeSentinel(deps);
    let detected = false;
    s.on('detected', () => { detected = true; });
    s.scanSession('echo-exo-3-0');
    expect(detected).toBe(false);
  });

  it('recovered event carries the aup-rejection kind (audit detail)', async () => {
    const deps = makeDeps({ output: AUP_WEDGE_TAIL, outcome: 'respawned' });
    const s = new ContextWedgeSentinel(deps);
    let recovered: { sessionName: string; kind?: string } | null = null;
    s.on('recovered', (e) => { recovered = e; });
    s.scanSession('echo-exo-3-0');
    await deps.drainTimers();
    expect(recovered).not.toBeNull();
    expect(recovered!.kind).toBe('aup-rejection');
  });

  it('escalation message names the policy-rejection cause for AUP wedges', async () => {
    const deps = makeDeps({ output: AUP_WEDGE_TAIL, outcome: 'detect-only' });
    const s = new ContextWedgeSentinel(deps);
    s.scanSession('echo-exo-3-0');
    await deps.drainTimers();
    expect(deps.captured).toHaveLength(1);
    expect(deps.captured[0].text).toMatch(/policy-rejection/i);
  });

  it('escalation message keeps the stuck-context wording for thinking-block wedges', async () => {
    const deps = makeDeps({ output: WEDGE_TAIL, outcome: 'detect-only' });
    const s = new ContextWedgeSentinel(deps);
    s.scanSession('echo-wedged');
    await deps.drainTimers();
    expect(deps.captured).toHaveLength(1);
    expect(deps.captured[0].text).toMatch(/stuck-context/i);
  });
});
