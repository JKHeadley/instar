// Unit tests for SessionManager.paneShowsActiveWork + isSessionActivelyWorking
// — the "is this session mid-turn?" signal the recovery sentinels consult
// before taking a disruptive action (re-inject / recovery Enter).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

function createMockState(): StateManager {
  return {
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => null),
    saveSession: vi.fn(),
    removeSession: vi.fn(),
    getJobState: vi.fn().mockReturnValue(null),
    saveJobState: vi.fn(),
    getValue: vi.fn().mockReturnValue(undefined),
    setValue: vi.fn(),
  } as unknown as StateManager;
}

function makeSM(): SessionManager {
  const cfg = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/bin/claude',
    projectDir: '/tmp/test-project',
    maxSessions: 5,
    protectedSessions: [],
    completionPatterns: [],
  } as SessionManagerConfig;
  return new SessionManager(cfg, createMockState());
}

describe('SessionManager.paneShowsActiveWork', () => {
  it('true when the pane shows the mid-turn footer', () => {
    const sm = makeSM();
    expect(sm.paneShowsActiveWork('✻ Thinking… (8s · esc to interrupt)')).toBe(true);
  });
  it('false for an idle prompt or empty pane', () => {
    const sm = makeSM();
    expect(sm.paneShowsActiveWork('> ')).toBe(false);
    expect(sm.paneShowsActiveWork('')).toBe(false);
    expect(sm.paneShowsActiveWork(null)).toBe(false);
  });
});

describe('SessionManager.isSessionActivelyWorking', () => {
  afterEach(() => vi.restoreAllMocks());

  it('true when the pane footer shows an in-flight turn (no child process needed)', () => {
    const sm = makeSM();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockReturnValue('… 3.2k tokens · esc to interrupt');
    const procs = vi.spyOn(sm, 'hasActiveProcesses').mockReturnValue(false);
    expect(sm.isSessionActivelyWorking('s1')).toBe(true);
    // Footer alone is sufficient — this is the extended-think case.
    expect(procs).not.toHaveBeenCalled();
  });

  it('true when idle at prompt but a tool/child process is running', () => {
    const sm = makeSM();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockReturnValue('> (no footer)');
    vi.spyOn(sm, 'hasActiveProcesses').mockReturnValue(true);
    expect(sm.isSessionActivelyWorking('s1')).toBe(true);
  });

  it('false when idle at prompt with no footer and no child process', () => {
    const sm = makeSM();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockReturnValue('> ');
    vi.spyOn(sm, 'hasActiveProcesses').mockReturnValue(false);
    expect(sm.isSessionActivelyWorking('s1')).toBe(false);
  });

  it('false when the session does not exist', () => {
    const sm = makeSM();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(false);
    const cap = vi.spyOn(sm, 'captureOutput');
    expect(sm.isSessionActivelyWorking('gone')).toBe(false);
    expect(cap).not.toHaveBeenCalled();
  });

  it('never throws — a capture failure resolves to false', () => {
    const sm = makeSM();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockImplementation(() => { throw new Error('tmux gone'); });
    expect(() => sm.isSessionActivelyWorking('s1')).not.toThrow();
    expect(sm.isSessionActivelyWorking('s1')).toBe(false);
  });
});
