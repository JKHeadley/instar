/**
 * W26 lane 1 — the stop that does not stop (UNIT tier).
 *
 * `SessionManager.killSession(sessionId)` resolves its argument through the
 * state store BY ID. The emergency-stop path handed it a TMUX NAME, so the
 * lookup missed and it returned `false` silently while every caller reported
 * "killed". `killSessionByTmuxName` is the single shared resolution helper both
 * emergency-stop call sites now use; this tier tests the resolution and the
 * outcome plumbing in isolation.
 *
 * MUST-FAIL ARM 1 (tmux-name-vs-session-id resolution): the helper must resolve
 * the tmux name to the session ID and call killSession with the ID, not the
 * name. The `toHaveBeenCalledWith(<id>)` + killed-record assertions go red the
 * moment the resolution is reverted to passing the name straight through.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Mock child_process so no real tmux is required — kill-session is a no-op.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn(),
  execSync: vi.fn().mockReturnValue(''),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig, Session } from '../../src/core/types.js';

const RUNNING_ID = 'sess-1-uuid';
const RUNNING_TMUX = 'echo-worker-1';

function runningSession(): Session {
  return {
    id: RUNNING_ID,
    name: 'echo-worker',
    status: 'running',
    tmuxSession: RUNNING_TMUX,
    startedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('SessionManager.killSessionByTmuxName — tmux-name → session-id resolution', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-by-tmux-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
      framework: 'claude-code',
    };
    manager = new SessionManager(config, state);
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'session-manager-kill-by-tmux-name:cleanup' });
  });

  // ── MUST-FAIL ARM 1 ──────────────────────────────────────────────────────
  it('resolves the tmux name to the session ID and calls killSession WITH THE ID (not the name)', () => {
    state.saveSession(runningSession());
    const killSpy = vi.spyOn(manager, 'killSession');

    const result = manager.killSessionByTmuxName(RUNNING_TMUX);

    expect(result).toBe(true);
    // The exact defect: passing the tmux NAME straight through. The kill must be
    // dispatched by the resolved session ID.
    expect(killSpy).toHaveBeenCalledWith(RUNNING_ID);
    expect(killSpy).not.toHaveBeenCalledWith(RUNNING_TMUX);
    // And the record is actually marked killed (a name passed straight through
    // would have missed getSession() and left it 'running').
    expect(state.getSession(RUNNING_ID)!.status).toBe('killed');
  });

  it('a tmux name with no running session returns false (a miss is a failed kill, never silent success)', () => {
    // No session saved for this name.
    state.saveSession({ ...runningSession(), id: 'other', tmuxSession: 'some-other-worker' });
    const killSpy = vi.spyOn(manager, 'killSession');

    const result = manager.killSessionByTmuxName(RUNNING_TMUX);

    expect(result).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('only resolves RUNNING records — a killed/completed record with that tmux name is not re-killed', () => {
    state.saveSession({ ...runningSession(), status: 'killed' });
    const killSpy = vi.spyOn(manager, 'killSession');

    expect(manager.killSessionByTmuxName(RUNNING_TMUX)).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });

  // ── Outcome plumbing: a resolved name whose kill FAILS returns false ──────
  it('propagates a false outcome — when the underlying kill returns false, the helper returns false', () => {
    state.saveSession(runningSession());
    // The name resolves, but the kill itself does not land.
    const killSpy = vi.spyOn(manager, 'killSession').mockReturnValue(false);

    const result = manager.killSessionByTmuxName(RUNNING_TMUX);

    expect(killSpy).toHaveBeenCalledWith(RUNNING_ID); // resolution happened
    expect(result).toBe(false);                        // ...but the outcome is not swallowed into success
  });

  it('an empty tmux name returns false without touching killSession', () => {
    const killSpy = vi.spyOn(manager, 'killSession');
    expect(manager.killSessionByTmuxName('')).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
