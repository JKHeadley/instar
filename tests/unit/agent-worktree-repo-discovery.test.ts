// safe-git-allow: test fixture cleanup uses fs.rmSync on mkdtemp dirs only.
/**
 * Resolving the instar repo by ASKING THE WORKTREES instead of guessing.
 *
 * The observed failure, on a real agent, 2026-08-14:
 *   GET /worktrees/agent-reaper → enumerationOk: false, enumerationFailures: 98,
 *   "git -C <agent home> worktree list --porcelain → fatal: not a git repository"
 *   …while 45 worktrees and 27 GB sat under that agent home.
 *
 * Two independent blind spots produced it, and BOTH are the same mistake — a
 * path assumed rather than resolved:
 *   · the reaper was wired to `config.projectDir`, which is the agent home and
 *     is not a git repo at all;
 *   · `resolveDetectorInstarRepo` guessed at `~/Documents/Projects/instar` and
 *     `~/instar`, neither of which exists on that machine, so it returned null
 *     and the detector's `if (repo)` guard silently skipped every tick.
 *
 * The answer was on disk the whole time: a linked worktree's `.git` is a FILE
 * naming its owning repo. These tests pin that the worktrees are believed, and
 * — just as importantly — that a malformed or non-worktree entry names nothing
 * rather than producing a confident wrong path.
 *
 * This is the same defect class the reaper's own header records for 2026-07-29
 * ("reclaimable: 0 against 73 worktrees"). That fix made the failure VISIBLE;
 * this one makes resolution actually work.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverInstarRepoFromWorktrees,
  parseWorktreeGitPointer,
  resolveDetectorInstarRepo,
} from '../../src/core/AgentWorktreeDetector.js';

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtdisc-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Create a worktree-shaped dir whose `.git` FILE points at `repo`. */
const makeWorktree = (root: string, slug: string, repo: string): void => {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.git'),
    `gitdir: ${path.join(repo, '.git', 'worktrees', slug)}\n`,
    'utf8',
  );
};

describe('parseWorktreeGitPointer', () => {
  it('reads the owning repo out of a real pointer', () => {
    const p = `gitdir: ${path.join('/Users/x/.instar/agents/echo/.dev/instar', '.git', 'worktrees', 'my-slug')}\n`;
    expect(parseWorktreeGitPointer(p)).toBe('/Users/x/.instar/agents/echo/.dev/instar');
  });

  it('a trailing newline and leading spaces do not change the answer', () => {
    const p = `  gitdir:   ${path.join('/repo', '.git', 'worktrees', 's')}   \n\n`;
    expect(parseWorktreeGitPointer(p)).toBe('/repo');
  });

  // ── Naming nothing is the correct answer for anything unrecognised. A
  //    confident wrong repo path is what produced the 98 failures.
  it('CONTROL: content with no gitdir line names nothing', () => {
    expect(parseWorktreeGitPointer('ref: refs/heads/main\n')).toBeNull();
  });

  it('CONTROL: a gitdir that is not a worktree pointer names nothing', () => {
    // A plain submodule/alternate gitdir has no /.git/worktrees/ segment.
    expect(parseWorktreeGitPointer('gitdir: /repo/.git/modules/sub\n')).toBeNull();
  });

  it('CONTROL: empty content names nothing', () => {
    expect(parseWorktreeGitPointer('')).toBeNull();
  });
});

describe('discoverInstarRepoFromWorktrees', () => {
  it('finds the repo that the worktrees actually belong to', () => {
    const roots = path.join(tmp, '.worktrees');
    const repo = path.join(tmp, '.dev', 'instar');
    makeWorktree(roots, 'alpha', repo);
    makeWorktree(roots, 'beta', repo);
    expect(discoverInstarRepoFromWorktrees([roots])).toEqual([repo]);
  });

  /**
   * NOT a hypothetical. On the agent that surfaced this, `.worktrees/` holds
   * worktrees of TWO legitimate clones of the same upstream — 29 owned by
   * `<home>/.build/instar` and 17 by `<home>/.dev/instar`. Both are returned,
   * most-owned first, and the caller decides. A single-repo consumer therefore
   * gets the LARGEST coherent set instead of an arbitrary one — which is an
   * improvement over enumerating nothing, and still not full coverage.
   */
  it('several owning repos are all returned, most-owned first', () => {
    const roots = path.join(tmp, '.worktrees');
    const bigger = path.join(tmp, 'build-repo');
    const smaller = path.join(tmp, 'dev-repo');
    makeWorktree(roots, 'a', bigger);
    makeWorktree(roots, 'b', bigger);
    makeWorktree(roots, 'c', smaller);
    const found = discoverInstarRepoFromWorktrees([roots]);
    expect(found[0], 'the most-owned repo leads').toBe(bigger);
    expect(found, 'the smaller repo is NOT dropped — it is the caller\'s to use').toContain(smaller);
    expect(found).toHaveLength(2);
  });

  it('reads across several agent roots', () => {
    const r1 = path.join(tmp, 'agentA', '.worktrees');
    const r2 = path.join(tmp, 'agentB', '.worktrees');
    const repo = path.join(tmp, 'shared-repo');
    makeWorktree(r1, 'a', repo);
    makeWorktree(r2, 'b', repo);
    expect(discoverInstarRepoFromWorktrees([r1, r2])).toEqual([repo]);
  });

  it('CONTROL: no roots, missing roots, and empty roots all yield nothing', () => {
    expect(discoverInstarRepoFromWorktrees([])).toEqual([]);
    expect(discoverInstarRepoFromWorktrees([path.join(tmp, 'does-not-exist')])).toEqual([]);
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(discoverInstarRepoFromWorktrees([empty])).toEqual([]);
  });

  it('CONTROL: a full clone under .worktrees is skipped — its .git is a DIRECTORY', () => {
    // A clone sitting in the worktrees area is not a worktree OF anything, and
    // must not be mistaken for a pointer to itself.
    const roots = path.join(tmp, '.worktrees');
    fs.mkdirSync(path.join(roots, 'a-clone', '.git'), { recursive: true });
    expect(discoverInstarRepoFromWorktrees([roots])).toEqual([]);
  });

  it('CONTROL: a malformed pointer is skipped without throwing, and the good one still wins', () => {
    const roots = path.join(tmp, '.worktrees');
    const repo = path.join(tmp, 'good-repo');
    fs.mkdirSync(path.join(roots, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(roots, 'broken', '.git'), 'total nonsense\n', 'utf8');
    makeWorktree(roots, 'ok', repo);
    expect(discoverInstarRepoFromWorktrees([roots])).toEqual([repo]);
  });

  it('CONTROL: a directory with no .git at all is skipped', () => {
    const roots = path.join(tmp, '.worktrees');
    fs.mkdirSync(path.join(roots, 'just-a-folder'), { recursive: true });
    expect(discoverInstarRepoFromWorktrees([roots])).toEqual([]);
  });

  /**
   * The hazard my own first version shipped, caught by isolating the variable
   * rather than by reading the code.
   *
   * The first draft defaulted the discovery roots to `enumerateSafeRoots()`,
   * which enumerates EVERY agent home on the machine. Run on the real box, the
   * agent asking the question (echo) resolved to a DIFFERENT agent's repo —
   * whichever owned the most worktrees — because the vote was taken across all
   * of them. That is a confident wrong path, strictly worse than the null this
   * change removes: null makes a consumer skip, a wrong repo makes it act.
   */
  it('resolution takes NO worktree candidate unless the caller names its own root', () => {
    const roots = path.join(tmp, 'someone-elses', '.worktrees');
    makeWorktree(roots, 'a', path.join(tmp, 'someone-elses-repo'));
    // No worktreeRoots passed and a cwd that is not a checkout: the pre-existing
    // chain applies and finds nothing. Crucially it does NOT go hunting.
    const resolved = resolveDetectorInstarRepo({
      cwd: tmp,
      configPath: path.join(tmp, 'no-such-config.json'),
      fallbackChain: [],
    });
    expect(resolved, 'must not resolve to a repo the caller never named').toBeNull();
  });

  it('is bounded — it stops inspecting after the cap', () => {
    // 45 worktrees is a real number on the agent that surfaced this; the walk
    // must not grow without limit as that number does.
    const roots = path.join(tmp, '.worktrees');
    const repo = path.join(tmp, 'repo');
    for (let i = 0; i < 12; i++) makeWorktree(roots, `w${i}`, repo);
    expect(discoverInstarRepoFromWorktrees([roots], { maxWorktrees: 3 })).toEqual([repo]);
    expect(discoverInstarRepoFromWorktrees([roots], { maxWorktrees: 0 })).toEqual([]);
  });
});
