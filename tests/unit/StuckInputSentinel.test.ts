/**
 * Behavior tests for StuckInputSentinel — the persistent recovery loop that
 * complements verifyInjection (PR #159) by surviving server restarts.
 *
 * The in-process verifyInjection schedule (500/1500/3500/6500ms) dies when
 * the server process dies. These tests prove the sentinel is decoupled from
 * the injection moment: it observes a stuck prompt purely from pane
 * captures, holds state in memory across ticks, and fires escalating
 * recovery actions after the prompt persists past minTicksBeforeFire.
 *
 * Mocks: SessionManager is stubbed; fireStuckInputRecovery is a vi.fn() so
 * we can count calls and assert escalation order. We do NOT mock the file
 * system — the events log is gated with `noPersist: true` to keep tests
 * disk-free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StuckInputSentinel } from '../../src/core/StuckInputSentinel.js';
import os from 'node:os';

type StubManager = {
  listRunningSessions: ReturnType<typeof vi.fn>;
  tmuxSessionExists: ReturnType<typeof vi.fn>;
  captureOutput: ReturnType<typeof vi.fn>;
  fireStuckInputRecovery: ReturnType<typeof vi.fn>;
};

function buildStubManager(panes: Record<string, string | (() => string)>): StubManager {
  return {
    listRunningSessions: vi.fn(() => Object.keys(panes).map(name => ({ tmuxSession: name }))),
    tmuxSessionExists: vi.fn((name: string) => name in panes),
    captureOutput: vi.fn((name: string) => {
      const p = panes[name];
      return typeof p === 'function' ? p() : p;
    }),
    fireStuckInputRecovery: vi.fn(),
  };
}

function buildSentinel(manager: StubManager, opts: Partial<ConstructorParameters<typeof StuckInputSentinel>[1]> = {}) {
  return new StuckInputSentinel(manager as any, {
    stateDir: os.tmpdir(),
    noPersist: true,
    minTicksBeforeFire: 2,
    maxAttempts: 4,
    ...opts,
  });
}

const STUCK_PANE_IDLE = [
  '────────────────────────────────────────',
  '❯ [telegram:7195] hello there friend',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const STUCK_PANE_DIFFERENT_TEXT = [
  '────────────────────────────────────────',
  '❯ [telegram:7195] a completely different message',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

const WORKING_PANE = [
  '✻ Brewed for 14m 11s',
  '────────────────────────────────────────',
  '❯ [telegram:7195] hello there friend',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on · esc to interrupt · ctrl+t to hide tasks',
].join('\n');

const EMPTY_PROMPT_PANE = [
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

describe('StuckInputSentinel — extractPromptText', () => {
  const sentinel = buildSentinel(buildStubManager({}));

  it('returns the text after ❯ on the prompt line', () => {
    expect(sentinel.extractPromptText(STUCK_PANE_IDLE)).toBe('[telegram:7195] hello there friend');
  });

  it('returns null when the prompt is empty', () => {
    expect(sentinel.extractPromptText(EMPTY_PROMPT_PANE)).toBeNull();
  });

  it('returns null when there is no ❯ in the pane', () => {
    expect(sentinel.extractPromptText('just some text\nno prompt here\n')).toBeNull();
  });

  it('returns the wrapped line when prompt line is empty but next is content', () => {
    const wrapped = ['❯ ', 'wrapped content here', '──────'].join('\n');
    expect(sentinel.extractPromptText(wrapped)).toBe('wrapped content here');
  });

  it('does not return the box-border separator as wrapped content', () => {
    const wrapped = ['❯ ', '────────────────', '  ⏵⏵ bypass'].join('\n');
    expect(sentinel.extractPromptText(wrapped)).toBeNull();
  });
});

describe('StuckInputSentinel — isPaneActivelyWorking', () => {
  const sentinel = buildSentinel(buildStubManager({}));

  it('flags panes with "esc to interrupt" as working', () => {
    expect(sentinel.isPaneActivelyWorking(WORKING_PANE)).toBe(true);
  });

  it('flags panes with "ctrl+t to hide tasks" as working', () => {
    const multiTask = ['❯ hello', '  ⏵⏵ bypass · ctrl+t to hide tasks'].join('\n');
    expect(sentinel.isPaneActivelyWorking(multiTask)).toBe(true);
  });

  it('does NOT flag the idle pane as working', () => {
    expect(sentinel.isPaneActivelyWorking(STUCK_PANE_IDLE)).toBe(false);
  });

  it('does NOT flag a stale "Brewed for…" past-tense marker as working — live reproduction case', () => {
    // Past-tense churn markers stick around in the pane after the agent finishes
    // its turn. The footer activity hints ("esc to interrupt", "ctrl+t to hide
    // tasks") are the precise tell for "actually working." Live repro: 2026-05-11
    // echo-qalatra had a stale "✻ Brewed for 14m 11s" line above a stuck message;
    // the sentinel MUST treat this as idle and proceed to recovery.
    const stale = ['✻ Brewed for 14m 11s', '────────', '❯ hello', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');
    expect(sentinel.isPaneActivelyWorking(stale)).toBe(false);
  });

  it('does NOT flag a "✶ Running…" line in isolation as working when no footer hint is present', () => {
    // Belt-and-suspenders: even if a present-tense spinner line is in the pane,
    // we rely on the footer for the working signal. (If Claude Code is actually
    // working, the footer will say "esc to interrupt".)
    const presentTenseNoFooter = ['✶ Running Phase 1a checks', '❯ hello'].join('\n');
    expect(sentinel.isPaneActivelyWorking(presentTenseNoFooter)).toBe(false);
  });
});

describe('StuckInputSentinel — tick lifecycle', () => {
  beforeEach(() => {
    // No fake timers — we drive ticks manually via .tick().
  });

  it('does NOT fire on the first observation of stuck text', () => {
    const mgr = buildStubManager({ 'echo-A': STUCK_PANE_IDLE });
    const sentinel = buildSentinel(mgr);

    sentinel.tick();

    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
    const rec = sentinel.getRecordForTest('echo-A');
    expect(rec?.consecutiveTicks).toBe(1);
    expect(rec?.attempts).toBe(0);
  });

  it('fires the first recovery action on the SECOND consecutive observation (minTicksBeforeFire=2)', () => {
    const mgr = buildStubManager({ 'echo-A': STUCK_PANE_IDLE });
    const sentinel = buildSentinel(mgr);

    sentinel.tick(); // first sighting — no fire
    sentinel.tick(); // second sighting — fire attempt 0

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledWith('echo-A', 0);
    expect(sentinel.getRecordForTest('echo-A')?.attempts).toBe(1);
  });

  it('escalates across ticks: Enter (0) → Enter (1) → C-m (2) → Enter-sleep-Enter (3)', () => {
    const mgr = buildStubManager({ 'echo-A': STUCK_PANE_IDLE });
    const sentinel = buildSentinel(mgr);

    sentinel.tick(); // tick 1 — observation, no fire
    sentinel.tick(); // tick 2 — fire attempt 0
    sentinel.tick(); // tick 3 — fire attempt 1
    sentinel.tick(); // tick 4 — fire attempt 2
    sentinel.tick(); // tick 5 — fire attempt 3

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
    expect(mgr.fireStuckInputRecovery.mock.calls.map(c => c[1])).toEqual([0, 1, 2, 3]);
  });

  it('stops firing after maxAttempts even if the pane remains stuck', () => {
    const mgr = buildStubManager({ 'echo-A': STUCK_PANE_IDLE });
    const sentinel = buildSentinel(mgr);

    for (let i = 0; i < 10; i++) sentinel.tick();

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(4);
    expect(sentinel.getRecordForTest('echo-A')?.exhausted).toBe(true);
  });

  it('refuses to fire while the pane shows Claude Code is actively working', () => {
    const mgr = buildStubManager({ 'echo-A': WORKING_PANE });
    const sentinel = buildSentinel(mgr);

    for (let i = 0; i < 5; i++) sentinel.tick();

    expect(mgr.fireStuckInputRecovery).not.toHaveBeenCalled();
    expect(sentinel.getRecordForTest('echo-A')).toBeUndefined();
  });

  it('resets state when the prompt text changes (new content = fresh event)', () => {
    let currentPane = STUCK_PANE_IDLE;
    const mgr = buildStubManager({ 'echo-A': () => currentPane });
    const sentinel = buildSentinel(mgr);

    sentinel.tick(); // sight A
    sentinel.tick(); // fire 0 for A
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);

    currentPane = STUCK_PANE_DIFFERENT_TEXT;
    sentinel.tick(); // new content → state reset, no fire

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(1);
    const rec = sentinel.getRecordForTest('echo-A');
    expect(rec?.attempts).toBe(0);
    expect(rec?.consecutiveTicks).toBe(1);

    sentinel.tick(); // second observation of new content → fire 0
    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(2);
    expect(mgr.fireStuckInputRecovery.mock.calls[1]).toEqual(['echo-A', 0]);
  });

  it('drops the record when the prompt clears between ticks', () => {
    let currentPane: string = STUCK_PANE_IDLE;
    const mgr = buildStubManager({ 'echo-A': () => currentPane });
    const sentinel = buildSentinel(mgr);

    sentinel.tick();
    sentinel.tick(); // fire 0

    currentPane = EMPTY_PROMPT_PANE;
    sentinel.tick(); // prompt clear → drop record

    expect(sentinel.getRecordForTest('echo-A')).toBeUndefined();
  });

  it('garbage-collects records for sessions that disappear from listRunningSessions', () => {
    const panes: Record<string, string> = { 'echo-A': STUCK_PANE_IDLE };
    const mgr = buildStubManager(panes);
    const sentinel = buildSentinel(mgr);

    sentinel.tick();
    expect(sentinel.getRecordForTest('echo-A')).toBeDefined();

    // Session disappears (killed or completed).
    delete panes['echo-A'];
    sentinel.tick();

    expect(sentinel.getRecordForTest('echo-A')).toBeUndefined();
  });

  it('tracks multiple stuck sessions independently', () => {
    const mgr = buildStubManager({
      'echo-A': STUCK_PANE_IDLE,
      'echo-B': STUCK_PANE_DIFFERENT_TEXT,
    });
    const sentinel = buildSentinel(mgr);

    sentinel.tick();
    sentinel.tick();

    expect(mgr.fireStuckInputRecovery).toHaveBeenCalledTimes(2);
    const sessionsFired = mgr.fireStuckInputRecovery.mock.calls.map(c => c[0]).sort();
    expect(sessionsFired).toEqual(['echo-A', 'echo-B']);
  });
});

describe('StuckInputSentinel — start/stop lifecycle', () => {
  it('start() and stop() do not throw and are idempotent', () => {
    const mgr = buildStubManager({});
    const sentinel = buildSentinel(mgr, { tickMs: 10_000 });
    expect(() => sentinel.start()).not.toThrow();
    expect(() => sentinel.start()).not.toThrow(); // idempotent
    expect(() => sentinel.stop()).not.toThrow();
    expect(() => sentinel.stop()).not.toThrow(); // idempotent
  });
});

describe('StuckInputSentinel — actionForAttempt', () => {
  it('matches SessionManager.fireStuckInputRecovery escalation', () => {
    expect(StuckInputSentinel.actionForAttempt(0)).toBe('Enter');
    expect(StuckInputSentinel.actionForAttempt(1)).toBe('Enter');
    expect(StuckInputSentinel.actionForAttempt(2)).toBe('C-m');
    expect(StuckInputSentinel.actionForAttempt(3)).toBe('Enter-sleep-Enter');
    expect(StuckInputSentinel.actionForAttempt(99)).toBe('Enter-sleep-Enter');
  });
});
