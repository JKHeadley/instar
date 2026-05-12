/**
 * Unit tests for ProjectRoundWorktrees.
 *
 * Covers:
 *   - pathFor produces the spec'd path shape
 *   - allocate() creates a worktree under `.worktrees/<project>/<round>/<item>`
 *   - allocate() refuses when path exists (default), allows with refuseExisting:false
 *   - ensureExcludeEntry idempotent
 *   - prune() doesn't throw on empty namespace
 *   - remove() is a no-op when path missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRoundWorktrees } from '../../src/core/ProjectRoundWorktrees.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

function makeRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
  SafeGitExecutor.run(['init', '-q'], { cwd: d, operation: 'wt-test:init' });
  SafeGitExecutor.run(['config', 'user.email', 't@t'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['config', 'user.name', 't'], { cwd: d, operation: 'cfg' });
  fs.writeFileSync(path.join(d, 'README'), 'x');
  SafeGitExecutor.run(['add', '.'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['commit', '-m', 'init', '-q'], { cwd: d, operation: 'cfg' });
  return d;
}

describe('ProjectRoundWorktrees', () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'wt-test:after' }); } catch { /* ignore */ } });

  it('pathFor produces <repo>/.worktrees/<project>/<round>/<item>', () => {
    const p = ProjectRoundWorktrees.pathFor({ targetRepoPath: '/r', projectId: 'p', roundIndex: 2, itemId: 'i' });
    expect(p).toBe(path.join('/r', '.worktrees', 'p', '2', 'i'));
  });

  it('allocate creates the worktree under .worktrees/', () => {
    const r = ProjectRoundWorktrees.allocate({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' });
    expect(r.created).toBe(true);
    expect(fs.existsSync(r.worktreePath)).toBe(true);
    expect(r.worktreePath).toBe(path.join(repo, '.worktrees', 'p', '0', 'item-a'));
  });

  it('allocate refuses by default when path exists', () => {
    ProjectRoundWorktrees.allocate({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' });
    expect(() =>
      ProjectRoundWorktrees.allocate({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' })
    ).toThrow(/already exists/);
  });

  it('allocate with refuseExisting:false returns existing path', () => {
    ProjectRoundWorktrees.allocate({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' });
    const r = ProjectRoundWorktrees.allocate(
      { targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' },
      { refuseExisting: false }
    );
    expect(r.created).toBe(false);
    expect(fs.existsSync(r.worktreePath)).toBe(true);
  });

  it('ensureExcludeEntry is idempotent', () => {
    ProjectRoundWorktrees.ensureExcludeEntry(repo);
    const before = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    ProjectRoundWorktrees.ensureExcludeEntry(repo);
    const after = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
    // Single appearance of .worktrees/ entry.
    expect(after).toBe(before);
    expect((after.match(/\.worktrees\//g) ?? []).length).toBe(1);
  });

  it('prune does not throw on empty namespace', () => {
    expect(() => ProjectRoundWorktrees.prune(repo)).not.toThrow();
  });

  it('remove is a no-op when path missing', () => {
    expect(() =>
      ProjectRoundWorktrees.remove({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'gone' })
    ).not.toThrow();
  });

  it('remove cleans up an allocated worktree', () => {
    const r = ProjectRoundWorktrees.allocate({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' });
    expect(fs.existsSync(r.worktreePath)).toBe(true);
    ProjectRoundWorktrees.remove({ targetRepoPath: repo, projectId: 'p', roundIndex: 0, itemId: 'item-a' });
    expect(fs.existsSync(r.worktreePath)).toBe(false);
  });
});
