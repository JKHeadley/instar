import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateManager } from '../../src/core/StateManager.js';
import {
  formatBuildContextRestoreNote,
  isEligibleBuildContextCwd,
  SessionBuildContextStore,
} from '../../src/core/SessionBuildContextStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SessionBuildContextStore', () => {
  let tmpDir: string;
  let state: StateManager;
  let now = 1_000_000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-build-context-'));
    state = new StateManager(tmpDir);
    now = 1_000_000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/session-build-context-store.test.ts:afterEach',
    });
  });

  it('treats home-only sessions as ineligible and worktree cwd sessions as eligible', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    const trivialSubdir = path.join(home, 'docs');

    expect(isEligibleBuildContextCwd(home, home)).toBe(false);
    expect(isEligibleBuildContextCwd(home, trivialSubdir)).toBe(false);
    expect(isEligibleBuildContextCwd(home, worktree)).toBe(true);
  });

  it('records branch enrichment best-effort and returns a restore note for fresh existing worktrees', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => 'codey/feature\n') as any,
    });

    store.record('agent-topic', home, worktree);
    const restore = store.getRestore('agent-topic');

    expect(restore?.entry).toMatchObject({
      spawnCwd: home,
      currentCwd: worktree,
      branch: 'codey/feature',
      updatedAt: now,
    });
    expect(restore?.note).toContain('[BUILD-CONTEXT RESTORE]');
    expect(restore?.note).toContain(worktree);
    expect(restore?.note).toContain('branch:   codey/feature');
  });

  it('skips stale, missing, and home-only contexts', () => {
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      maxAgeMs: 100,
      execFileSync: vi.fn(() => '') as any,
    });

    store.record('stale', home, worktree);
    now += 101;
    expect(store.getRestore('stale')).toBeNull();

    now = 2_000_000;
    store.record('missing', home, path.join(home, '.worktrees', 'gone'));
    expect(store.getRestore('missing')).toBeNull();

    store.record('home', home, home);
    expect(store.getRestore('home')).toBeNull();
  });

  it('writes through the crash-safe state sidecar path', () => {
    const renameSpy = vi.spyOn(fs, 'renameSync');
    const home = path.join(tmpDir, 'agent-home');
    const worktree = path.join(home, '.worktrees', 'feature');
    fs.mkdirSync(worktree, { recursive: true });

    const store = new SessionBuildContextStore(state, {
      now: () => now,
      execFileSync: vi.fn(() => '') as any,
    });
    store.record('agent-topic', home, worktree);

    const target = path.join(tmpDir, 'state', 'session-build-context.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(renameSpy.mock.calls.some(([, to]) => to === target)).toBe(true);
  });

  it('formats restore notes without a branch line when branch enrichment is absent', () => {
    const note = formatBuildContextRestoreNote({
      spawnCwd: '/agent-home',
      currentCwd: '/agent-home/.worktrees/build',
      updatedAt: now,
    });

    expect(note).toContain('[BUILD-CONTEXT RESTORE]');
    expect(note).not.toContain('branch:');
  });
});
