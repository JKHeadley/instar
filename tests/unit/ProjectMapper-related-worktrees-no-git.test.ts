/**
 * Related-worktree details are read from git's files, not by running git. The map runs on
 * the server's event loop at boot, and two git processes per worktree blocked it for 17-59s
 * on an agent with about 500 worktrees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectMapper } from '../../src/core/ProjectMapper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

const OPERATION = 'tests/unit/ProjectMapper-related-worktrees-no-git.test.ts:git';
const git = (cwd: string, ...args: string[]): string =>
  String(SafeGitExecutor.execSync(args, { cwd, encoding: 'utf-8', stdio: 'pipe', operation: OPERATION })).trim();
const gitRead = (cwd: string, ...args: string[]): string =>
  String(SafeGitExecutor.readSync(args, { cwd, encoding: 'utf-8', stdio: 'pipe', operation: OPERATION })).trim();

describe('ProjectMapper related worktrees without running git', () => {
  let root: string;
  let project: string;
  let state: string;
  let worktrees: string;
  let repo: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projmap-nogit-')));
    project = path.join(root, 'project');
    state = path.join(root, 'state');
    worktrees = path.join(root, 'worktrees');
    repo = path.join(root, 'repo');
    for (const dir of [project, state, worktrees, repo]) fs.mkdirSync(dir, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/ProjectMapper-related-worktrees-no-git.test.ts:cleanup' });
  });

  const related = () => new ProjectMapper({ projectDir: project, stateDir: state, relatedWorktreeRoots: [worktrees] }).generate().relatedWorktrees ?? [];
  const named = (name: string) => related().find((w) => w.name === name);

  it('reports the same branch and remote git reports for a linked worktree', () => {
    git(repo, 'remote', 'add', 'origin', 'https://example.test/origin.git');
    const dir = path.join(worktrees, 'linked');
    git(repo, 'worktree', 'add', '-b', 'feature/a-b', dir);
    expect(named('linked')).toMatchObject({
      gitBranch: gitRead(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
      gitRemote: gitRead(dir, 'remote', 'get-url', 'origin'),
    });
    expect(named('linked')?.gitBranch).toBe('feature/a-b');
  });

  it('prefers the JKHeadley remote over origin, as before', () => {
    git(repo, 'remote', 'add', 'origin', 'https://example.test/origin.git');
    git(repo, 'remote', 'add', 'JKHeadley', 'https://example.test/jk.git');
    git(repo, 'worktree', 'add', '-b', 'pref', path.join(worktrees, 'pref'));
    expect(named('pref')?.gitRemote).toBe('https://example.test/jk.git');
  });

  it('reports HEAD for a detached worktree, as rev-parse does', () => {
    const dir = path.join(worktrees, 'detached');
    git(repo, 'worktree', 'add', '--detach', dir);
    expect(gitRead(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(named('detached')?.gitBranch).toBe('HEAD');
  });

  it('reads a plain clone, whose .git is a directory', () => {
    git(repo, 'remote', 'add', 'origin', 'https://example.test/plain.git');
    git(root, 'clone', '-q', repo, path.join(worktrees, 'plain'));
    const dir = path.join(worktrees, 'plain');
    expect(named('plain')).toMatchObject({ gitBranch: 'main', gitRemote: gitRead(dir, 'remote', 'get-url', 'origin') });
  });

  it('strips the quotes git writes around a URL containing a # character', () => {
    git(repo, 'remote', 'add', 'origin', 'https://example.test/a#b.git');
    const dir = path.join(worktrees, 'quoted');
    git(repo, 'worktree', 'add', '-b', 'quoted', dir);
    expect(named('quoted')?.gitRemote).toBe(gitRead(dir, 'remote', 'get-url', 'origin'));
  });

  it('does not report a reftable placeholder as a branch', () => {
    const dir = path.join(worktrees, 'reftable');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    expect(named('reftable')?.gitBranch).toBeNull();
  });

  it('reports no remote when the repository has none', () => {
    git(repo, 'worktree', 'add', '-b', 'none', path.join(worktrees, 'none'));
    expect(named('none')).toMatchObject({ gitBranch: 'none', gitRemote: null });
  });

  it('survives an unreadable .git pointer without dropping the entry', () => {
    const dir = path.join(worktrees, 'broken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), 'not a pointer');
    expect(named('broken')).toMatchObject({ gitBranch: null, gitRemote: null });
  });

  it('runs no git process per worktree', () => {
    for (let n = 0; n < 5; n += 1) git(repo, 'worktree', 'add', '-b', `w${n}`, path.join(worktrees, `w${n}`));
    const read = vi.spyOn(SafeGitExecutor, 'readSync');
    expect(related()).toHaveLength(5);
    const perWorktree = read.mock.calls.filter(([, opts]) => String((opts as { operation?: string }).operation).includes(':related-'));
    expect(perWorktree).toHaveLength(0);
  });
});
