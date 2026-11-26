/**
 * Regression tests for the silently-undelivered stuck prompt.
 *
 * Live incident (2026-10-20, indra on the laptop): the operator's message was
 * pasted into a claude-code session and never submitted. Instar detected it
 * ("Injection stuck … Auto-recovering"), reported the degradation
 * "Recovered without user intervention", and the message then sat at the prompt
 * for 28 minutes. Nothing was ever recovered and nobody was ever told.
 *
 * Two defects produced that:
 *
 *  1. Stage B fences a recovery keypress behind the durable delivery row that
 *     authorized the original injection — but those rows are prepared for
 *     codex-cli ONLY. For every other framework the fence could never be
 *     satisfied, so `fireStuckInputRecovery` returned
 *     `refused/missing-durable-delivery-evidence` without sending anything. One
 *     agent's event log held 75,001 consecutive such refusals, every one at
 *     attempt 0 — the ladder never advanced, never exhausted, and never
 *     escalated, re-asking the same impossible keypress every 10 seconds.
 *
 *  2. A refusal consumed no rung, so the sentinel had no budget that could run
 *     out, and every terminal path ended in `exhausted = true` plus one row in
 *     a JSONL file with no alarm attached.
 *
 * These tests pin: a refusal is counted, the wedge reaches a terminal state, the
 * operator is told exactly once, and a recovery that works raises nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StuckInputSentinel } from '../../src/core/StuckInputSentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const SESS = 'echo-topic-127648';
// A live claude-code pane with an inbound message stranded at the prompt and NO
// activity indicator — copied in shape from the indra capture.
const STUCK_PANE = [
  '⚠ Your login expires in 2 days · run /login to renew',
  '────────────────────────────────────────',
  '❯ [slack:C0CAPHMTL85 from U0APWL48281] checking in',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

function buildStubManager(fireResult: { status: 'attempted' | 'refused' | 'effect-unknown'; reason?: string }) {
  return {
    listRunningSessions: vi.fn(() => [{ tmuxSession: SESS, framework: 'claude-code' }]),
    tmuxSessionExists: vi.fn((n: string) => n === SESS),
    captureOutput: vi.fn(() => STUCK_PANE),
    // The ghost-text gate reads an ANSI capture; undimmed text classifies as
    // real input, which is what an injected message is.
    captureOutputAnsi: vi.fn(() => STUCK_PANE),
    fireStuckInputRecovery: vi.fn().mockReturnValue(fireResult),
    getStrandedDraftMarker: vi.fn(() => undefined),
    clearStrandedDraftMarker: vi.fn(),
    strandedDraftMarkerSessions: vi.fn(() => [] as string[]),
    markStrandedDraftExhausted: vi.fn(),
    isMarkerStuckAtPrompt: vi.fn(() => true),
  };
}

describe('StuckInputSentinel — an undelivered prompt is announced, not just logged', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-undelivered-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true, operation: 'tests/unit/stuck-input-undelivered-alarm.test.ts',
    });
  });

  function sentinel(manager: unknown, onUndeliverable?: (info: unknown) => void) {
    return new StuckInputSentinel(manager as never, {
      stateDir, noPersist: true, minTicksBeforeFire: 2, maxAttempts: 4,
      onUndeliverable: onUndeliverable as never,
    });
  }

  it('a persistently REFUSED keypress reaches a terminal state instead of retrying forever', () => {
    const manager = buildStubManager({ status: 'refused', reason: 'missing-durable-delivery-evidence' });
    const s = sentinel(manager);
    // 40 ticks is four minutes of real time at the default cadence. Before the
    // fix this produced 39 refusals and no terminal state (the 75,001-row loop).
    for (let i = 0; i < 40; i++) s.tick();
    expect(manager.fireStuckInputRecovery.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('tells the operator exactly ONCE per wedge when recovery is refused', () => {
    const manager = buildStubManager({ status: 'refused', reason: 'missing-durable-delivery-evidence' });
    const raised: unknown[] = [];
    const s = sentinel(manager, info => raised.push(info));
    for (let i = 0; i < 40; i++) s.tick();
    expect(raised).toHaveLength(1);
    const info = raised[0] as { tmuxSession: string; reason: string; promptText: string };
    expect(info.tmuxSession).toBe(SESS);
    expect(info.reason).toContain('missing-durable-delivery-evidence');
    expect(info.promptText).toContain('checking in');
  });

  it('tells the operator exactly ONCE when the whole keypress ladder is spent and the prompt has not moved', () => {
    const manager = buildStubManager({ status: 'attempted' });
    const raised: unknown[] = [];
    const s = sentinel(manager, info => raised.push(info));
    for (let i = 0; i < 40; i++) s.tick();
    expect(manager.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
    expect(raised).toHaveLength(1);
    expect((raised[0] as { reason: string }).reason).toContain('ladder exhausted');
  });

  it('raises NOTHING when the prompt clears — a recovery that works is silent', () => {
    const manager = buildStubManager({ status: 'attempted' });
    const raised: unknown[] = [];
    // Pane goes back to an empty prompt after the first keypress.
    let fired = 0;
    manager.fireStuckInputRecovery = vi.fn(() => { fired += 1; return { status: 'attempted' as const }; });
    manager.captureOutput = vi.fn(() => (fired > 0
      ? '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
      : STUCK_PANE));
    const s = sentinel(manager, info => raised.push(info));
    for (let i = 0; i < 20; i++) s.tick();
    expect(fired).toBe(1);
    expect(raised).toHaveLength(0);
  });

  it('a throwing consumer cannot take the tick loop down', () => {
    const manager = buildStubManager({ status: 'refused', reason: 'missing-durable-delivery-evidence' });
    const s = sentinel(manager, () => { throw new Error('consumer exploded'); });
    expect(() => { for (let i = 0; i < 10; i++) s.tick(); }).not.toThrow();
  });
});

describe('SessionManager.fireStuckInputRecovery — the Stage B fence only applies where its evidence can exist', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-stageb-fence-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true, force: true, operation: 'tests/unit/stuck-input-undelivered-alarm.test.ts',
    });
  });

  function manager(stageBActive: boolean): SessionManager {
    const state = new StateManager(path.join(tmpDir, 'state'));
    const config: SessionManagerConfig = {
      // A path that cannot exist, so the keypress attempt fails locally rather
      // than touching a real tmux server. What matters here is whether the
      // recovery was ATTEMPTED at all, not whether tmux was reachable.
      tmuxPath: path.join(tmpDir, 'no-such-tmux'),
      claudePath: path.join(tmpDir, 'no-such-claude'),
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    };
    return new SessionManager(config, state, {
      stageBActivation: {
        configured: stageBActive ? 'active' : null,
        pendingActivation: false,
        active: stageBActive,
        reason: stageBActive ? 'test-active' : 'unconfigured-dark',
        artifactDigest: null,
      },
    } as never);
  }

  it('an untracked framework (no durable delivery row) is no longer refused outright', () => {
    // The regression: with Stage B active and no stranded-draft marker — the
    // normal state of EVERY claude-code session — this returned
    // refused/missing-durable-delivery-evidence and sent nothing, forever.
    const result = manager(true).fireStuckInputRecovery('echo-no-marker', 0);
    expect(result.reason).not.toBe('missing-durable-delivery-evidence');
  });

  it('Stage B dark behaves the same way (no regression on the legacy path)', () => {
    const result = manager(false).fireStuckInputRecovery('echo-no-marker', 0);
    expect(result.reason).not.toBe('missing-durable-delivery-evidence');
  });
});

describe('wiring integrity — the alarm is connected to something real', () => {
  const SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('server.ts hands the sentinel an onUndeliverable consumer', () => {
    // A signal with no consumer is the "shipped inert" failure: the sentinel
    // would compute the terminal verdict and drop it, which is the behaviour
    // this whole change exists to end.
    expect(SERVER_SRC).toContain('onUndeliverable:');
  });

  it('that consumer raises an attention item for the wedge', () => {
    expect(SERVER_SRC).toContain('stuck-input-undelivered:');
    expect(SERVER_SRC).toMatch(/sourceContext:\s*'stuck-input-sentinel'/);
  });

  it('and tells the conversation itself on the deterministic send path', () => {
    // sendToTopic, never the LLM-gated reply path — that gate fails closed
    // under exactly the pressure that produces a wedge, which would turn the
    // one message that explains the silence into more silence.
    const block = SERVER_SRC.slice(SERVER_SRC.indexOf('onUndeliverable:'));
    expect(block.slice(0, 2000)).toContain('sendToTopic');
  });
});
