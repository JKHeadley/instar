// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test fixture setup — builds throwaway repos for the carve-out assertions.
/**
 * The `localVerifyCloneOk` SafeGitExecutor carve-out (spec
 * local-verify-merge-authority.md §2 step 1), against real git. The verifier's
 * bare clone and run worktree live inside an instar-shaped agent home, so
 * SourceTreeGuard refuses writes there by default. With the opt-in, only the
 * enumerated verbs run, only when every target's realpath is inside THIS
 * agent's verifyRoot, and only when git — with GIT_DIR / GIT_WORK_TREE /
 * GIT_CEILING_DIRECTORIES pinned — resolves its repository inside verifyRoot.
 * The reviewer's repro (a damaged repo.git with only HEAD, under a home that is
 * itself a checkout) must never let git search upward into the home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor, isLocalVerifyClonePath, isWellFormedLocalVerifyRoot, type SafeGitOptions } from '../../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../../src/core/SourceTreeGuard.js';
import { isLocalVerifyTempPath, localVerifyTempRoot, removeScopedTree } from '../../../src/localVerify/orchestratorSeams.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'safeGitCarveOut.test.ts' }); });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function rawGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}

/** An instar-shaped agent home (itself a checkout) with base on main and head on a branch. */
function agentHome(name = 'agent', root?: string): { root: string; home: string; base: string; head: string; verify: string; bare: string } {
  const r = root ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-carve-')));
  if (!root) dirs.push(r);
  const home = path.join(r, name);
  fs.mkdirSync(home);
  rawGit(home, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(home, '.instar-source-tree'), '');
  fs.writeFileSync(path.join(home, 'package.json'), '{"name":"instar"}\n');
  fs.writeFileSync(path.join(home, '.gitignore'), '.worktrees/\n');
  fs.mkdirSync(path.join(home, 'src'));
  fs.writeFileSync(path.join(home, 'src', 'a.ts'), 'export const a = 1;\n');
  rawGit(home, ['add', '-A']);
  rawGit(home, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  const base = rawGit(home, ['rev-parse', 'HEAD']).trim();
  rawGit(home, ['checkout', '-qb', 'feature']);
  fs.writeFileSync(path.join(home, 'src', 'b.ts'), 'export const b = 2;\n');
  rawGit(home, ['add', '-A']);
  rawGit(home, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'head']);
  const head = rawGit(home, ['rev-parse', 'HEAD']).trim();
  rawGit(home, ['checkout', '-q', 'main']);
  const verify = path.join(home, '.worktrees', '.verify');
  fs.mkdirSync(verify, { recursive: true });
  return { root: r, home, base, head, verify, bare: path.join(verify, 'repo.git') };
}

/** Bare-clone step options: cwd = verifyRoot, GIT_DIR = the bare clone. */
const bareOpts = (verify: string, bare: string, cwd = verify): SafeGitOptions => ({
  cwd, operation: 't', localVerifyCloneOk: { verifyRoot: verify, gitDir: bare },
});

function initBare(verify: string, bare: string, home: string): void {
  SafeGitExecutor.execSync(['init', '--bare', '-q', bare], bareOpts(verify, bare));
  fs.writeFileSync(path.join(bare, 'config'), `[core]\n\tbare = true\n[remote "origin"]\n\turl = ${home}\n[user]\n\tname = local-verify\n\temail = noreply@local\n`);
}

describe('isLocalVerifyClonePath (anchored to one verifyRoot)', () => {
  it('admits the root and below only, by realpath', () => {
    const { verify, home, root } = agentHome();
    expect(isLocalVerifyClonePath(verify, verify)).toBe(true);
    expect(isLocalVerifyClonePath(path.join(verify, 'runs', 'abc', 'src'), verify)).toBe(true); // not yet created
    expect(isLocalVerifyClonePath(home, verify)).toBe(false);
    expect(isLocalVerifyClonePath(path.join(verify, '..', 'other'), verify)).toBe(false);
    expect(isLocalVerifyClonePath(`${verify}-evil`, verify)).toBe(false);
    // A symlink inside the root pointing out of it is judged by its realpath.
    fs.symlinkSync(home, path.join(verify, 'escape'));
    expect(isLocalVerifyClonePath(path.join(verify, 'escape'), verify)).toBe(false);
    // Another agent's .verify, and an arbitrary /tmp/x/.worktrees/.verify, are not this root.
    const other = agentHome('other-agent', root);
    expect(isLocalVerifyClonePath(other.verify, verify)).toBe(false);
    expect(isLocalVerifyClonePath('/tmp/x/.worktrees/.verify', verify)).toBe(false);
    expect(isLocalVerifyClonePath(verify, 'relative/root')).toBe(false);
  });
});

describe('isWellFormedLocalVerifyRoot (second-pass hardening)', () => {
  it('admits only <…>/.worktrees/.verify as a real directory (or not yet created)', () => {
    const { verify, home } = agentHome();
    expect(isWellFormedLocalVerifyRoot(verify)).toBe(true);
    expect(isWellFormedLocalVerifyRoot(path.join(home, 'x', '.worktrees', '.verify'))).toBe(true); // absent: created later
    expect(isWellFormedLocalVerifyRoot(home)).toBe(false);
    expect(isWellFormedLocalVerifyRoot(path.join(home, '.worktrees'))).toBe(false);
    expect(isWellFormedLocalVerifyRoot(path.join(home, '.worktrees', 'verify'))).toBe(false);
  });

  it('a .verify that is a symlink (here, to the agent home) is refused, so nothing in the home is exempted', () => {
    const { home, root } = agentHome('linked');
    // A well-named root whose .verify entry is a symlink to the agent home.
    const verify = path.join(home, 'nested', '.worktrees', '.verify');
    fs.mkdirSync(path.dirname(verify), { recursive: true });
    fs.symlinkSync(home, verify);
    expect(isWellFormedLocalVerifyRoot(verify)).toBe(false);
    expect(isLocalVerifyClonePath(path.join(home, 'src', 'a.ts'), verify)).toBe(false);
    expect(isLocalVerifyClonePath(path.join(verify, 'repo.git'), verify)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe('localVerifyCloneOk', () => {
  it('runs the whole verify git sequence with the repository pinned', () => {
    const { home, base, head, verify, bare } = agentHome();
    // Without the opt-in the agent home's subtree is protected.
    expect(() => SafeGitExecutor.execSync(['init', '--bare', '-q', bare], { cwd: verify, operation: 't' })).toThrow(SourceTreeGuardError);
    initBare(verify, bare, home);
    const o = bareOpts(verify, bare);
    SafeGitExecutor.run(['fetch', '--no-tags', 'origin', head, base], o);
    SafeGitExecutor.run(['update-ref', 'refs/heads/main', base], o);
    const tree = SafeGitExecutor.run(['merge-tree', '--write-tree', base, head], o).split('\n')[0].trim();
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    const commit = SafeGitExecutor.run(['commit-tree', tree, '-p', base, '-p', head, '-m', 'm'], o).trim();
    const run = path.join(verify, 'runs', head.slice(0, 12));
    SafeGitExecutor.run(['worktree', 'add', '--detach', run, commit], o);
    expect(fs.readFileSync(path.join(run, 'src', 'b.ts'), 'utf8')).toContain('b = 2');
    const adminDir = fs.readFileSync(path.join(run, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
    const wt: SafeGitOptions = { cwd: run, operation: 't', localVerifyCloneOk: { verifyRoot: verify, gitDir: adminDir, workTree: run } };
    expect(SafeGitExecutor.run(['status', '--porcelain'], wt).trim()).toBe('');
    expect(SafeGitExecutor.run(['ls-tree', '-r', '--name-only', commit], o)).toContain('src/b.ts');
    expect(SafeGitExecutor.run(['diff', '--name-status', '--no-renames', base, head], o)).toContain('A\tsrc/b.ts');
    expect(SafeGitExecutor.run(['show', `${head}:src/b.ts`], o)).toContain('b = 2');
    SafeGitExecutor.run(['worktree', 'remove', run], o);
    expect(fs.existsSync(run)).toBe(false);
    // The home's own main never moved.
    expect(rawGit(home, ['rev-parse', 'main']).trim()).toBe(base);
  });

  it("the reviewer's repro: a damaged repo.git (only HEAD) is refused and git never reaches the home", () => {
    const { home, base, head, verify, bare } = agentHome();
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    const o = bareOpts(verify, bare);
    expect(() => SafeGitExecutor.execSync(['update-ref', 'refs/heads/main', head], o)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['checkout', '--detach', head], o)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['worktree', 'prune'], o)).toThrow(SourceTreeGuardError);
    // Also from a cwd inside the damaged clone itself.
    const inside = bareOpts(verify, bare, bare);
    expect(() => SafeGitExecutor.execSync(['update-ref', 'refs/heads/main', head], inside)).toThrow(SourceTreeGuardError);
    expect(rawGit(home, ['rev-parse', 'main']).trim()).toBe(base);
    expect(rawGit(home, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
  });

  it('refuses a verb outside the enumerated set, and worktree remove --force', () => {
    const { home, base, head, verify, bare } = agentHome();
    initBare(verify, bare, home);
    const o = bareOpts(verify, bare);
    SafeGitExecutor.run(['fetch', '--no-tags', 'origin', head, base], o);
    const run = path.join(verify, 'runs', 'x');
    SafeGitExecutor.run(['worktree', 'add', '--detach', run, head], o);
    const adminDir = fs.readFileSync(path.join(run, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
    const wt: SafeGitOptions = { cwd: run, operation: 't', localVerifyCloneOk: { verifyRoot: verify, gitDir: adminDir, workTree: run } };
    expect(() => SafeGitExecutor.execSync(['reset', '--hard'], wt)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['push', 'origin', 'HEAD:main'], wt)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['add', '-A'], wt)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['config', 'core.hooksPath', '/tmp/evil'], wt)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.run(['worktree', 'remove', '--force', run], o)).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.run(['worktree', 'remove', '-f', run], o)).toThrow(SourceTreeGuardError);
  });

  it('refuses targets and git dirs outside THIS root: the home, another agent, /tmp/x/.worktrees/.verify', () => {
    const { root, home, verify, base, bare } = agentHome();
    initBare(verify, bare, home);
    // The agent's own checkout never qualifies (as cwd or as the pinned git dir).
    expect(() => SafeGitExecutor.execSync(['update-ref', 'refs/heads/x', base], bareOpts(verify, bare, home))).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['update-ref', 'refs/heads/x', base], bareOpts(verify, path.join(home, '.git')))).toThrow(SourceTreeGuardError);
    // A target mixing the root and the home is refused.
    expect(() => SafeGitExecutor.execSync(['-C', home, 'update-ref', 'refs/heads/y', base], bareOpts(verify, bare))).toThrow(SourceTreeGuardError);
    // Another agent's .verify under this agent's root option is refused.
    const other = agentHome('other-agent', root);
    initBare(other.verify, other.bare, other.home);
    expect(() => SafeGitExecutor.execSync(['update-ref', 'refs/heads/z', other.base], bareOpts(verify, other.bare, other.verify))).toThrow(SourceTreeGuardError);
    // A worktree add whose destination is outside the root is refused.
    expect(() => SafeGitExecutor.run(['worktree', 'add', '--detach', path.join(home, 'outside'), base], bareOpts(verify, bare)))
      .toThrow(SourceTreeGuardError);
    // A look-alike path elsewhere is not this root.
    expect(isLocalVerifyClonePath('/tmp/x/.worktrees/.verify/repo.git', verify)).toBe(false);
    expect(rawGit(home, ['rev-parse', 'main']).trim()).toBe(base);
    expect(() => rawGit(home, ['rev-parse', '--verify', '-q', 'refs/heads/x'])).toThrow();
  });

  it('a relative worktree path resolves against the invocation cwd', () => {
    const { home, base, head, verify, bare } = agentHome();
    initBare(verify, bare, home);
    const o = bareOpts(verify, bare);
    SafeGitExecutor.run(['fetch', '--no-tags', 'origin', head, base], o);
    // cwd = verifyRoot: "runs/rel" is inside the root and is admitted.
    SafeGitExecutor.run(['worktree', 'add', '--detach', 'runs/rel', head], o);
    expect(fs.existsSync(path.join(verify, 'runs', 'rel', 'src', 'b.ts'))).toBe(true);
    // "../../escape" from the root lands in the home and is refused.
    expect(() => SafeGitExecutor.run(['worktree', 'add', '--detach', '../../escape', head], o)).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(path.join(home, 'escape'))).toBe(false);
  });
});

describe('removeScopedTree (anchored)', () => {
  it("deletes inside this agent's root and lv- temp dirs only", async () => {
    const { root, home, verify } = agentHome();
    const inside = path.join(verify, 'runs', 'dead');
    fs.mkdirSync(inside, { recursive: true });
    await removeScopedTree(inside, verify);
    expect(fs.existsSync(inside)).toBe(false);
    const tmp = fs.mkdtempSync(path.join(localVerifyTempRoot(), 'lv-tmp-'));
    expect(isLocalVerifyTempPath(tmp)).toBe(true);
    await removeScopedTree(tmp, verify);
    expect(fs.existsSync(tmp)).toBe(false);
    await expect(removeScopedTree(path.join(home, 'src'), verify)).rejects.toThrow(/refuses/);
    const other = agentHome('other-agent', root);
    const otherRun = path.join(other.verify, 'runs', 'x');
    fs.mkdirSync(otherRun, { recursive: true });
    await expect(removeScopedTree(otherRun, verify)).rejects.toThrow(/refuses/);
    expect(fs.existsSync(otherRun)).toBe(true);
    expect(isLocalVerifyTempPath(localVerifyTempRoot())).toBe(false);
    expect(isLocalVerifyTempPath(path.join(localVerifyTempRoot(), 'other'))).toBe(false);
  });

  it('the per-run temp root is short enough that a test socket under it stays inside the 104-character limit', () => {
    const root = localVerifyTempRoot();
    // A real failing socket path was <TMPDIR>/lv-tmp-XXXXXX/instar-origin-store-XXXXXX/origin-notice.sock.
    const sock = path.join(root, 'lv-tmp-XXXXXX', 'instar-origin-store-XXXXXX', 'origin-notice.sock');
    if (process.platform !== 'win32') expect(sock.length).toBeLessThan(104);
  });

  it("SafeFsExecutor's scope option admits only the named root", () => {
    const { root, verify } = agentHome();
    const other = agentHome('other-agent', root);
    const mine = path.join(verify, 'runs', 'm');
    const theirs = path.join(other.verify, 'runs', 't');
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(theirs, { recursive: true });
    expect(() => SafeFsExecutor.safeRmSync(theirs, { recursive: true, force: true, operation: 't', localVerifyScopeOk: { verifyRoot: verify } })).toThrow(SourceTreeGuardError);
    SafeFsExecutor.safeRmSync(mine, { recursive: true, force: true, operation: 't', localVerifyScopeOk: { verifyRoot: verify } });
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(theirs)).toBe(true);
  });
});
