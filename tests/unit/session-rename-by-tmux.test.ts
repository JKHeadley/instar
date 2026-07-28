// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup only.
/**
 * SessionManager.renameSessionByTmux — UNIFIED-SESSION-LIFECYCLE bonus
 * (session label follows topic rename). The CRITICAL property: update the
 * display `name` ONLY. tmuxSession and id MUST NEVER change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
  execFile: vi.fn().mockImplementation(
    (_c: string, _args: string[], _opts: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
      if (typeof _opts === 'function') cb = _opts as typeof cb;
      if (cb) cb(null, { stdout: '' });
    },
  ),
}));

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session, SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager.renameSessionByTmux (bonus — label follows topic rename)', () => {
  let tmp: string;
  let state: StateManager;
  let mgr: SessionManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    state = new StateManager(path.join(tmp, 'state'));
    const cfg: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: tmp,
      maxSessions: 5, protectedSessions: [], completionPatterns: [],
    };
    mgr = new SessionManager(cfg, state);
  });

  afterEach(() => {
    mgr.stopMonitoring();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function seed(name: string, tmux: string): Session {
    const s: Session = {
      id: 'id-' + tmux, name, status: 'running', tmuxSession: tmux,
      startedAt: new Date().toISOString(), prompt: 'p',
    } as Session;
    state.saveSession(s);
    return s;
  }

  it('updates ONLY the display name — never tmuxSession or id', () => {
    seed('old name', 'project-foo');
    expect(mgr.renameSessionByTmux('project-foo', 'My Renamed Topic')).toBe(true);
    const after = state.getSession('id-project-foo')!;
    expect(after.name).toBe('My Renamed Topic');
    expect(after.tmuxSession).toBe('project-foo');
    expect(after.id).toBe('id-project-foo');
  });

  it('is a no-op when the new name is unchanged (idempotent)', () => {
    seed('same', 'project-bar');
    expect(mgr.renameSessionByTmux('project-bar', 'same')).toBe(false);
    expect(state.getSession('id-project-bar')!.name).toBe('same');
  });

  it('is a no-op for an unknown tmuxSession (does not throw)', () => {
    expect(mgr.renameSessionByTmux('does-not-exist', 'Whatever')).toBe(false);
  });

  it('rejects an empty / whitespace-only / non-string new name', () => {
    seed('original', 'project-baz');
    expect(mgr.renameSessionByTmux('project-baz', '')).toBe(false);
    expect(mgr.renameSessionByTmux('project-baz', '   ')).toBe(false);
    // Non-string at runtime (defensive).
    expect(mgr.renameSessionByTmux('project-baz', null as unknown as string)).toBe(false);
    expect(state.getSession('id-project-baz')!.name).toBe('original');
  });

  it('trims surrounding whitespace from the new name', () => {
    seed('original', 'project-trim');
    expect(mgr.renameSessionByTmux('project-trim', '  Trimmed Name  ')).toBe(true);
    expect(state.getSession('id-project-trim')!.name).toBe('Trimmed Name');
  });
});
