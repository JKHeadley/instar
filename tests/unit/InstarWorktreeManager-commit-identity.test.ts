// safe-git-allow: test file — fs.rmSync is for per-test tmpdir cleanup;
//   execFileSync builds throwaway repo fixtures only.

/**
 * W26 item 0(a) — the worktree commit identity must be RESOLVED, never minted.
 *
 * `setLocalGitIdentity` used to stamp `<agent>@instar.local` unconditionally.
 * That address is linked to no GitHub account, so it trips
 * `require_extra_approval_for_unattributed_changes` on the protected branch and
 * turns every release into a human approval — measured on the Window 25 release
 * PR, where it was one of the four human actions the window needed.
 *
 * Substituting a different hardcoded domain would have swapped one invented
 * identity for another. The contract these tests pin is the three-rung resolver:
 *
 *   1. `git.commitIdentity` in the agent config, if usable;
 *   2. else the agent repo's own user.name / user.email;
 *   3. else REFUSE — never mint.
 *
 * Rung 3 is the load-bearing arm and is the must-fail control: silently
 * inventing an identity nobody configured is a critical action reporting
 * success while its effect (an attributable commit) never happens.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCommitIdentity } from '../../src/core/InstarWorktreeManager.js';

let tmp: string;
let repo: string;
let stateDir: string;

/** A git env with author/committer overrides stripped, so the fixture's own
 *  config is what the resolver reads. */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_AUTHOR_') || k.startsWith('GIT_COMMITTER_')) delete env[k];
  }
  return env;
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

/** `git config --unset-all` exits 5 when the key is simply absent, which is
 *  the normal case in a fresh fixture. Only the unset is tolerant. */
function gitUnset(key: string): void {
  try {
    git(['config', '--local', '--unset-all', key]);
  } catch {
    // @silent-fallback-ok — "already absent" is the desired post-state.
  }
}

function writeConfig(value: unknown): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(value));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-identity-'));
  repo = path.join(tmp, 'repo');
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(repo, { recursive: true });
  // `-c init.defaultBranch` keeps the fixture quiet across git versions.
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', repo], {
    stdio: 'ignore',
    env: cleanGitEnv(),
  });
  // A fixture repo inherits nothing: unset any identity the global config
  // would otherwise supply, so rung 2 is genuinely empty until a test sets it.
  gitUnset('user.name');
  gitUnset('user.email');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveCommitIdentity — rung 1: configured identity wins', () => {
  it('returns exactly the configured name and email', () => {
    writeConfig({ git: { commitIdentity: { name: 'Echo', email: 'echo@sagemindai.io' } } });
    git(['config', 'user.name', 'Should Not Win']);
    git(['config', 'user.email', 'should-not-win@example.com']);

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });

  it('trims surrounding whitespace rather than stamping it into git config', () => {
    writeConfig({ git: { commitIdentity: { name: '  Echo  ', email: '  echo@sagemindai.io  ' } } });

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });
});

describe('resolveCommitIdentity — rung 2: inherit the agent repo', () => {
  it('uses the repo identity when no config identity exists', () => {
    writeConfig({ git: {} });
    git(['config', 'user.name', 'Echo']);
    git(['config', 'user.email', 'echo@sagemindai.io']);

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });

  it('falls through to rung 2 when the config file is absent entirely', () => {
    git(['config', 'user.name', 'Echo']);
    git(['config', 'user.email', 'echo@sagemindai.io']);

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });

  // A malformed config must not be stamped, and must not short-circuit the
  // resolver either: a half-written identity is not a usable one.
  it.each([
    ['missing email', { name: 'Echo' }],
    ['missing name', { email: 'echo@sagemindai.io' }],
    ['empty email', { name: 'Echo', email: '' }],
    ['whitespace-only name', { name: '   ', email: 'echo@sagemindai.io' }],
    ['wrong types', { name: 42, email: ['echo@sagemindai.io'] }],
  ])('falls through to rung 2 when the config identity is unusable (%s)', (_label, bad) => {
    writeConfig({ git: { commitIdentity: bad } });
    git(['config', 'user.name', 'Echo']);
    git(['config', 'user.email', 'echo@sagemindai.io']);

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });

  it('falls through to rung 2 when config.json is not valid JSON', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
    git(['config', 'user.name', 'Echo']);
    git(['config', 'user.email', 'echo@sagemindai.io']);

    expect(resolveCommitIdentity(repo, stateDir)).toEqual({
      name: 'Echo',
      email: 'echo@sagemindai.io',
    });
  });
});

describe('resolveCommitIdentity — rung 3: MUST-FAIL control, refuse rather than mint', () => {
  it('returns null when neither the config nor the repo supplies an identity', () => {
    expect(resolveCommitIdentity(repo, stateDir)).toBeNull();
  });

  it('returns null when the repo has a name but no email', () => {
    git(['config', 'user.name', 'Echo']);

    expect(resolveCommitIdentity(repo, stateDir)).toBeNull();
  });

  it('returns null when the repo has an email but no name', () => {
    git(['config', 'user.email', 'echo@sagemindai.io']);

    expect(resolveCommitIdentity(repo, stateDir)).toBeNull();
  });

  // The regression this whole item exists for: no invented address, from any
  // domain, may ever come back out of the resolver.
  it('never invents an address when nothing is configured', () => {
    const resolved = resolveCommitIdentity(repo, stateDir);

    expect(resolved).toBeNull();
    expect(JSON.stringify(resolved)).not.toContain('instar.local');
    expect(JSON.stringify(resolved)).not.toContain('@');
  });

  it('is not rescued by GIT_AUTHOR_* / GIT_COMMITTER_* in the environment', () => {
    // Those variables override git at COMMIT time, not in `git config` reads,
    // so they must not make an unconfigured repo look configured.
    const saved = { ...process.env };
    try {
      process.env.GIT_AUTHOR_NAME = 'Someone Else';
      process.env.GIT_AUTHOR_EMAIL = 'someone@example.com';
      process.env.GIT_COMMITTER_NAME = 'Someone Else';
      process.env.GIT_COMMITTER_EMAIL = 'someone@example.com';

      expect(resolveCommitIdentity(repo, stateDir)).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});
