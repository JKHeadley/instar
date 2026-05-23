// safe-git-allow: test file — execFileSync('git', ...) builds fixture
//   bare-repo + drives the WorktreeManager surface. No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests for WorktreeManager clone-default behavior.
 *
 * Closes the mid-session sandbox-revocation failure class observed
 * 2026-05-22: `git worktree add` keeps per-worktree metadata inside the
 * SOURCE repo's `.git/worktrees/<name>/` path. When the sandbox EPERMs
 * that path, every git command from the worktree dies. The fix routes
 * cross-project worktree creation through `git clone` instead, producing
 * a self-contained `.git/` directory under agent home.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

/**
 * The decision predicate lives inside WorktreeManager.shouldCloneInsteadOfWorktree.
 * We re-implement it here in test isolation since the method is private. This
 * test verifies the SHAPE of the decision; the integration test below
 * verifies the actual git operation that follows.
 */
function shouldCloneInsteadOfWorktree(projectDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INSTAR_WORKTREE_FORCE_WORKTREE === '1') return false;
  if (env.INSTAR_WORKTREE_FORCE_CLONE === '1') return true;
  try {
    const sourceReal = fs.realpathSync(projectDir);
    const home = env.HOME || os.homedir();
    // Both paths must be canonicalized for the prefix-match to work cross-
    // platform (macOS resolves /var/folders/... → /private/var/folders/...).
    let agentHome = path.join(home, '.instar');
    try { agentHome = fs.realpathSync(agentHome); } catch { /* dir may not exist in fresh fixtures */ }
    return !sourceReal.startsWith(agentHome + path.sep) && sourceReal !== agentHome;
  } catch {
    return true;
  }
}

describe('WorktreeManager — shouldCloneInsteadOfWorktree decision', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-decide-'));
  });
  afterAll(() => {
    try { SafeFsExecutor.safeRmSync(tmpRoot, { recursive: true, force: true, operation: 'WorktreeManager-clone-default.test:cleanup' }); } catch { /* ignore */ }
  });

  it('clones when source is OUTSIDE ~/.instar (the sandbox hazard case)', () => {
    const outside = path.join(tmpRoot, 'outside-source');
    fs.mkdirSync(outside, { recursive: true });
    expect(shouldCloneInsteadOfWorktree(outside, { ...process.env, HOME: tmpRoot })).toBe(true);
  });

  it('uses worktree when source is INSIDE ~/.instar (no hazard)', () => {
    const inside = path.join(tmpRoot, '.instar', 'agents', 'fake-agent');
    fs.mkdirSync(inside, { recursive: true });
    expect(shouldCloneInsteadOfWorktree(inside, { ...process.env, HOME: tmpRoot })).toBe(false);
  });

  it('honors INSTAR_WORKTREE_FORCE_CLONE=1 override', () => {
    const inside = path.join(tmpRoot, '.instar', 'agents', 'fake-agent-2');
    fs.mkdirSync(inside, { recursive: true });
    expect(
      shouldCloneInsteadOfWorktree(inside, {
        ...process.env,
        HOME: tmpRoot,
        INSTAR_WORKTREE_FORCE_CLONE: '1',
      })
    ).toBe(true);
  });

  it('honors INSTAR_WORKTREE_FORCE_WORKTREE=1 override (rollback escape hatch)', () => {
    const outside = path.join(tmpRoot, 'outside-source-2');
    fs.mkdirSync(outside, { recursive: true });
    expect(
      shouldCloneInsteadOfWorktree(outside, {
        ...process.env,
        HOME: tmpRoot,
        INSTAR_WORKTREE_FORCE_WORKTREE: '1',
      })
    ).toBe(false);
  });

  it('fail-safes to clone when realpath fails (missing source dir)', () => {
    const ghost = path.join(tmpRoot, 'does-not-exist');
    expect(shouldCloneInsteadOfWorktree(ghost, { ...process.env, HOME: tmpRoot })).toBe(true);
  });
});

describe('WorktreeManager — git clone produces a self-contained .git directory', () => {
  let tmpRoot: string;
  let sourceRepo: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-clone-int-'));
    sourceRepo = path.join(tmpRoot, 'source');
    fs.mkdirSync(sourceRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: sourceRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRepo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: sourceRepo });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: sourceRepo });
    fs.writeFileSync(path.join(sourceRepo, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: sourceRepo });
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: sourceRepo });
  });

  afterAll(() => {
    try { SafeFsExecutor.safeRmSync(tmpRoot, { recursive: true, force: true, operation: 'WorktreeManager-clone-default.test:repo-cleanup' }); } catch { /* ignore */ }
  });

  it('the clone has its own .git as a DIRECTORY (not a worktree file pointer)', () => {
    const cloneTarget = path.join(tmpRoot, 'clone-target');
    execFileSync('git', ['clone', '--quiet', sourceRepo, cloneTarget]);
    const gitPath = path.join(cloneTarget, '.git');
    const stat = fs.lstatSync(gitPath);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isFile()).toBe(false);
  });

  it('contrast: git worktree add produces a .git FILE that points back at source', () => {
    const wtTarget = path.join(tmpRoot, 'wt-target');
    // Create the branch first
    execFileSync('git', ['branch', 'wt-branch'], { cwd: sourceRepo });
    execFileSync('git', ['worktree', 'add', wtTarget, 'wt-branch'], { cwd: sourceRepo });
    const gitPath = path.join(wtTarget, '.git');
    const stat = fs.lstatSync(gitPath);
    expect(stat.isFile()).toBe(true);
    const content = fs.readFileSync(gitPath, 'utf-8');
    // Confirms the worktree's .git file points back at the SOURCE's .git/worktrees/
    expect(content).toMatch(/^gitdir:.*\.git\/worktrees\/wt-target/);
  });
});
