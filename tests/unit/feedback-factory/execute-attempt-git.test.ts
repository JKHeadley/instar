// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test fixture setup — builds throwaway repos for the trusted-git assertions.
/**
 * Trusted git in the executor's own attempt clones (docs/specs/feedback-triage-and-execution.md §4
 * step 8): real git against throwaway repos. A clone is created at the base SHA; a commit in the
 * publish clone runs no hook and no repository-config helper (a planted pre-commit/commit-msg/
 * post-commit hook, a planted hooksPath and a planted fsmonitor never run); the push is argv-pinned
 * (explicit https remote, --no-verify, hooks off, credential helper reset). The SafeGitExecutor
 * carve-out admits only the enumerated verbs, only inside `.worktrees/feedback-*-a<n>[-publish|-base]`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor, isFeedbackAttemptClonePath } from '../../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../../src/core/SourceTreeGuard.js';
import { SafeAttemptGit } from '../../../src/feedback-factory/execute/executorPorts.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'execute-attempt-git.test.ts' }); });

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function rawGit(cwd: string, args: string[]): string {
  // Fixture setup only (the code under test goes through SafeGitExecutor).
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
}

/** An instar-shaped source repo (SourceTreeGuard recognises it) with one commit. */
function sourceRepo(): { root: string; src: string; sha: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-git-')));
  dirs.push(root);
  const src = path.join(root, 'source');
  fs.mkdirSync(src);
  rawGit(src, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(src, '.instar-source-tree'), '');
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"instar"}\n');
  fs.mkdirSync(path.join(src, 'src'));
  fs.writeFileSync(path.join(src, 'src', 'a.ts'), 'export const a = 1;\n');
  rawGit(src, ['add', '-A']);
  rawGit(src, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  return { root, src, sha: rawGit(src, ['rev-parse', 'HEAD']).trim() };
}

describe('the SafeGitExecutor carve-out for attempt clones', () => {
  it('matches only feedback attempt clone directories under .worktrees', () => {
    expect(isFeedbackAttemptClonePath('/h/.worktrees/feedback-x-1234abcd-a1')).toBe(true);
    expect(isFeedbackAttemptClonePath('/h/.worktrees/feedback-x-1234abcd-a2-publish/src')).toBe(true);
    expect(isFeedbackAttemptClonePath('/h/.worktrees/feedback-x-a3-base')).toBe(true);
    expect(isFeedbackAttemptClonePath('/h/.worktrees/feedback-x-a1-tmp')).toBe(false);
    expect(isFeedbackAttemptClonePath('/h/.worktrees/other-branch')).toBe(false);
    expect(isFeedbackAttemptClonePath('/h/feedback-x-a1')).toBe(false);
    expect(isFeedbackAttemptClonePath('/h')).toBe(false);
  });

  it('without the opt-in an instar clone is protected; with it only the enumerated verbs run; elsewhere it never applies', async () => {
    const { root, src, sha } = sourceRepo();
    const dest = path.join(root, '.worktrees', 'feedback-x-1234abcd-a1-publish');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await new SafeAttemptGit().createClone(src, dest, sha);
    expect(() => SafeGitExecutor.execSync(['add', '-A'], { cwd: dest, operation: 't' })).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['add', '-A'], { cwd: dest, operation: 't', feedbackAttemptCloneOk: true })).not.toThrow();
    expect(() => SafeGitExecutor.execSync(['reset', '--hard'], { cwd: dest, operation: 't', feedbackAttemptCloneOk: true })).toThrow(SourceTreeGuardError);
    expect(() => SafeGitExecutor.execSync(['checkout', '-b', 'x'], { cwd: dest, operation: 't', feedbackAttemptCloneOk: true })).toThrow(SourceTreeGuardError);
    // The agent's own checkout (the source) never qualifies.
    expect(() => SafeGitExecutor.execSync(['add', '-A'], { cwd: src, operation: 't', feedbackAttemptCloneOk: true })).toThrow(SourceTreeGuardError);
  });
});

describe('SafeAttemptGit', () => {
  it('createClone: a standalone clone detached at the base SHA, refusing an existing destination', async () => {
    const { root, src, sha } = sourceRepo();
    const dest = path.join(root, '.worktrees', 'feedback-x-1234abcd-a1');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const git = new SafeAttemptGit();
    await git.createClone(src, dest, sha);
    expect(fs.readFileSync(path.join(dest, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect(rawGit(dest, ['rev-parse', 'HEAD']).trim()).toBe(sha);
    await expect(git.createClone(src, dest, sha)).rejects.toThrow(/exists/);
    await expect(git.createClone(src, `${dest}-x`, 'not-a-sha')).rejects.toThrow(/invalid base sha/);
  });

  it('commit in the publish clone runs no planted hook or repository-config helper; the push argv is pinned', async () => {
    const { root, src, sha } = sourceRepo();
    const pub = path.join(root, '.worktrees', 'feedback-x-1234abcd-a1-publish');
    fs.mkdirSync(path.dirname(pub), { recursive: true });
    const git = new SafeAttemptGit();
    await git.createClone(src, pub, sha);
    const marker = path.join(root, 'HOOK-RAN');
    const hook = `#!/bin/sh\necho ran >> ${marker}\n`;
    for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'prepare-commit-msg']) {
      fs.writeFileSync(path.join(pub, '.git', 'hooks', name), hook, { mode: 0o755 });
    }
    const altHooks = path.join(root, 'alt-hooks');
    fs.mkdirSync(altHooks);
    fs.writeFileSync(path.join(altHooks, 'pre-commit'), hook, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'fsmon.sh'), hook, { mode: 0o755 });
    fs.appendFileSync(path.join(pub, '.git', 'config'), `[core]\n\thooksPath = ${altHooks}\n\tfsmonitor = ${path.join(root, 'fsmon.sh')}\n`);
    fs.writeFileSync(path.join(pub, 'src', 'a.ts'), 'export const a = 2;\n');

    const real = SafeGitExecutor.execSync.bind(SafeGitExecutor);
    let pushArgs: readonly string[] | null = null;
    vi.spyOn(SafeGitExecutor, 'execSync').mockImplementation((args, opts) => {
      if (args.includes('push')) { pushArgs = args; return ''; }
      return real(args, opts);
    });
    const head = await git.commitAndPush(pub, { branch: 'feedback/item-a1', message: 'fix(feedback): x\n\nbody\n', remoteUrl: 'https://github.com/owner/repo.git',
      authorName: 'Echo', authorEmail: 'echo@example.com', credentialHelper: '!gh auth git-credential' });
    expect(fs.existsSync(marker)).toBe(false);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(rawGit(pub, ['log', '-1', '--format=%an <%ae>|%s']).trim()).toBe('Echo <echo@example.com>|fix(feedback): x');
    expect(rawGit(pub, ['show', '--stat', '--format=', 'HEAD'])).toContain('src/a.ts');
    expect(pushArgs).not.toBeNull();
    const a = pushArgs!.join(' ');
    expect(a).toContain('core.hooksPath=/dev/null');
    expect(a).toContain('core.fsmonitor=false');
    expect(a).toContain('push --no-verify --quiet https://github.com/owner/repo.git HEAD:refs/heads/feedback/item-a1');
    expect(pushArgs!.indexOf('credential.helper=')).toBeGreaterThan(-1);
    expect(a).toContain('credential.helper=!gh auth git-credential');
  });

  it('refuses a non-feedback branch or a non-https GitHub remote', async () => {
    const git = new SafeAttemptGit();
    await expect(git.commitAndPush('/nowhere', { branch: 'main', message: 'm', remoteUrl: 'https://github.com/o/r.git', authorName: 'a', authorEmail: 'e', credentialHelper: null })).rejects.toThrow(/invalid feedback branch/);
    await expect(git.commitAndPush('/nowhere', { branch: 'feedback/x-a1', message: 'm', remoteUrl: '/tmp/local.git', authorName: 'a', authorEmail: 'e', credentialHelper: null })).rejects.toThrow(/explicit https GitHub URL/);
  });
});
