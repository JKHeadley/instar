/**
 * WorktreeManager — topic worktrees when the project IS an instar source checkout.
 *
 * Regression: the instar-dev agent's home is an instar git checkout, so
 * createBinding's `git branch` tripped SourceTreeGuard and every topic-bound
 * `POST /sessions/spawn` failed. The fix creates branch + worktree in one
 * `git worktree add` (the guard's worktree-manager carve-out) based on
 * origin/main. The guard itself is unchanged: a plain `git branch` against the
 * same checkout is still refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError, isInstarSourceTree } from '../../src/core/SourceTreeGuard.js';

let h: HarnessHandle;
/** Turn the fixture into an instar source tree (marker layer). Fixture git writes go before this. */
const markAsInstarSource = (): void => fs.writeFileSync(path.join(h.projectDir, '.instar-source-tree'), '');

const git = (args: string[], op: string): string =>
  SafeGitExecutor.readSync(['-C', h.projectDir, ...args], { encoding: 'utf-8', operation: op }).trim();

beforeEach(async () => {
  h = await createTwoSessionHarness();
  // A second commit on the local checkout's HEAD, and an origin/main ref at the
  // first commit, so the test can tell which base a new branch came from.
  const first = git(['rev-parse', 'HEAD'], 'tests:first');
  fs.writeFileSync(path.join(h.projectDir, 'local.md'), 'local only\n');
  SafeGitExecutor.execSync(['-C', h.projectDir, 'add', 'local.md'], { operation: 'tests:add' });
  SafeGitExecutor.execSync(['-C', h.projectDir, 'commit', '-q', '-m', 'local'], { operation: 'tests:commit' });
  SafeGitExecutor.execSync(['-C', h.projectDir, 'update-ref', 'refs/remotes/origin/main', first], { operation: 'tests:origin-main' });
});
afterEach(() => { h.cleanup(); });

describe('topic worktree from an instar source checkout', () => {
  it('the fixture really is guarded: a plain `git branch` is refused', () => {
    markAsInstarSource();
    expect(isInstarSourceTree(h.projectDir)).toBe(true);
    expect(() => SafeGitExecutor.execSync(['-C', h.projectDir, 'branch', 'topic/x'], { operation: 'tests:guard-still-on' }))
      .toThrow(SourceTreeGuardError);
  });

  it('a topic spawn creates its worktree off origin/main under the state dir', async () => {
    const originMain = git(['rev-parse', 'refs/remotes/origin/main'], 'tests:origin');
    markAsInstarSource();
    const s = await h.spawn({ topicId: 10000001001, mode: 'dev', slug: 'bug' });
    expect(s.cwd!.startsWith(path.join(h.stateDir, 'worktrees'))).toBe(true);
    expect(fs.existsSync(path.join(s.cwd!, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(s.cwd!, 'local.md'))).toBe(false);
    const wtHead = SafeGitExecutor.readSync(['-C', s.cwd!, 'rev-parse', 'HEAD'], { encoding: 'utf-8', operation: 'tests:wt-head' }).trim();
    expect(wtHead).toBe(originMain);
    const branch = SafeGitExecutor.readSync(['-C', s.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', operation: 'tests:wt-branch' }).trim();
    expect(branch).toBe('topic/10000001001-bug');
  });

  it('reuses an existing topic branch instead of recreating it', async () => {
    SafeGitExecutor.execSync(['-C', h.projectDir, 'update-ref', 'refs/heads/topic/77-bug', 'HEAD'], { operation: 'tests:pre-branch' });
    markAsInstarSource();
    const s = await h.spawn({ topicId: 77, mode: 'dev', slug: 'bug' });
    expect(fs.existsSync(path.join(s.cwd!, 'local.md'))).toBe(true);
  });

  it('falls back to HEAD when there is no origin/main', async () => {
    SafeGitExecutor.execSync(['-C', h.projectDir, 'update-ref', '-d', 'refs/remotes/origin/main'], { operation: 'tests:drop-origin' });
    markAsInstarSource();
    const s = await h.spawn({ topicId: 88, mode: 'dev', slug: 'bug' });
    expect(fs.existsSync(path.join(s.cwd!, 'local.md'))).toBe(true);
  });
});
