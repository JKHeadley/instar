// safe-git-allow: test file — direct execFileSync and fs.rmSync are for
//   bare-repo fixture setup + tmpdir teardown only. The integration target
//   (InstarWorktreeManager) is the layer that owns the safe-executor
//   contract for production code paths.

/**
 * Integration tests for `instar worktree create` — exercises the manager
 * against a real bare git repo + a real agent home, including the happy
 * path, default node_modules sharing, --no-share-node-modules, idempotency
 * on collision, the prune-before-add behaviour, and the error messages
 * for directory-exists vs stale-metadata cases.
 *
 * Concurrent-invocation safety (two agent homes against the same bare repo)
 * is covered by the file-level non-overlap assertion in the last test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktree,
  DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
} from '../../src/core/InstarWorktreeManager.js';

interface Fixture {
  instarHome: string;
  agentHome: string;
  agentName: string;
  bareRepo: string;
  registryLookup: () => Set<string>;
  repoAllowlist: string[];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture(): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-int-'));
  const agentName = 'integ-agent';
  const instarHome = path.join(tmp, '.instar-root');
  const agentHome = path.join(instarHome, 'agents', agentName);
  fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, '.instar', 'AGENT.md'), '# Agent\n');

  // Bare repo with an initial commit on `main` and origin/HEAD pointing to it.
  const bareRepo = path.join(tmp, 'repo');
  execFileSync('git', ['init', '--initial-branch=main', bareRepo], { stdio: 'pipe' });
  // Seed identity locally so the test commit lands.
  execFileSync('git', ['-C', bareRepo, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'user.email', 'test@example.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });
  // No detached auto-gc/maintenance: one still writing .git/objects after the
  // test made cleanup's rmdir fail with ENOTEMPTY (CI, PR #2097).
  execFileSync('git', ['-C', bareRepo, 'config', 'gc.auto', '0'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'config', 'maintenance.auto', 'false'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepo, 'README.md'), '# Test\n');
  fs.writeFileSync(path.join(bareRepo, 'package.json'), JSON.stringify({
    name: 'instar',
    scripts: { prepare: 'node scripts/fake-husky.mjs' },
  }));
  fs.mkdirSync(path.join(bareRepo, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(bareRepo, 'src', 'core', 'GitSync.ts'), '');
  fs.writeFileSync(path.join(bareRepo, 'tsconfig.json'), '{}');
  fs.mkdirSync(path.join(bareRepo, '.husky'), { recursive: true });
  fs.writeFileSync(path.join(bareRepo, '.husky', 'pre-commit'), 'npm run lint\nnode scripts/instar-dev-precommit.js\n');
  fs.mkdirSync(path.join(bareRepo, '.husky', '_'), { recursive: true });
  fs.writeFileSync(path.join(bareRepo, '.husky', '_', 'pre-commit'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  fs.writeFileSync(path.join(bareRepo, '.husky', '_', 'h'), '#!/usr/bin/env sh\nexit 0\n');
  fs.chmodSync(path.join(bareRepo, '.husky', '_', 'pre-commit'), 0o755);
  fs.chmodSync(path.join(bareRepo, '.husky', '_', 'h'), 0o755);
  execFileSync('git', ['-C', bareRepo, 'config', 'core.hooksPath', '.husky/_'], { stdio: 'pipe' });
  fs.mkdirSync(path.join(bareRepo, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(bareRepo, 'scripts', 'fake-husky.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.mkdirSync('.husky/_', { recursive: true });",
      "fs.writeFileSync('.husky/_/pre-commit', '#!/usr/bin/env sh\\n. \"$(dirname \"$0\")/h\"\\n');",
      "fs.writeFileSync('.husky/_/h', '#!/usr/bin/env sh\\nsh -e \"$(dirname \"$(dirname \"$0\")\")/$(basename \"$0\")\" \"$@\"\\n');",
      "fs.chmodSync('.husky/_/pre-commit', 0o755);",
      "fs.chmodSync('.husky/_/h', 0o755);",
      '',
    ].join('\n'),
  );
  execFileSync('git', ['-C', bareRepo, 'add', 'README.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'add', 'package.json', 'src/core/GitSync.ts', 'tsconfig.json', '.husky/pre-commit', 'scripts/fake-husky.mjs'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'commit', '-m', 'init'], { stdio: 'pipe' });
  // Allowlisted remote URL.
  const fakeRemote = 'git@github.com:instar-ai/instar.git';
  execFileSync('git', ['-C', bareRepo, 'config', 'remote.origin.url', fakeRemote], { stdio: 'pipe' });
  // origin/HEAD shorthand — fetch refs/heads/main into refs/remotes/origin/main
  // so the manager's base-branch resolution has something to point at.
  execFileSync('git', ['-C', bareRepo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { stdio: 'pipe' });
  execFileSync('git', ['-C', bareRepo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { stdio: 'pipe' });

  return {
    instarHome,
    agentHome,
    agentName,
    bareRepo,
    registryLookup: () => new Set([agentName]),
    repoAllowlist: [fakeRemote],
  };
}

function cleanup(fix: Fixture): void {
  fs.rmSync(path.dirname(fix.instarHome), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe('createWorktree (integration)', () => {
  let fix: Fixture;

  beforeEach(() => { fix = makeFixture(); });
  afterEach(() => cleanup(fix));

  it('refuses at the physical directory cap before adding a git worktree', async () => {
    const root = path.join(fix.agentHome, '.worktrees');
    fs.mkdirSync(root);
    for (let i = 0; i < 500; i++) fs.mkdirSync(path.join(root, `old-${i}`));
    await expect(createWorktree({
      branch: 'spec/over-cap',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    })).rejects.toThrow(/worktree-capacity: 500 directories/);
    expect(git(['worktree', 'list', '--porcelain'], fix.bareRepo).match(/^worktree /gm)).toHaveLength(1);
  });

  it('serializes concurrent creates at 499 directories', async () => {
    const root = path.join(fix.agentHome, '.worktrees');
    fs.mkdirSync(root);
    for (let i = 0; i < 499; i++) fs.mkdirSync(path.join(root, `old-${i}`));
    const opts = (branch: string) => ({
      branch,
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });
    const outcomes = await Promise.allSettled([
      createWorktree(opts('spec/race-a')),
      createWorktree(opts('spec/race-b')),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())).toHaveLength(500);
    expect(fs.existsSync(path.join(fix.agentHome, '.instar', 'local', 'worktree-create.lock'))).toBe(false);
  });

  it('refuses a symlinked worktree container before chmod or lock creation', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-outside-'));
    try {
      fs.chmodSync(outside, 0o755);
      fs.symlinkSync(outside, path.join(fix.agentHome, '.worktrees'));
      await expect(createWorktree({
        branch: 'spec/symlinked-container',
        shareNodeModules: false,
        resolveAgentHomeOpts: {
          env: { INSTAR_AGENT_HOME: fix.agentHome },
          instarHome: fix.instarHome,
          registryLookup: fix.registryLookup,
        },
        resolveInstarRepoOpts: {
          env: { INSTAR_REPO: fix.bareRepo },
          fallbackChain: [],
          urlAllowlist: fix.repoAllowlist,
        },
      })).rejects.toThrow(/path-containment/);
      expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(path.join(fix.agentHome, '.instar', 'local', 'worktree-create.lock'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('happy path: places worktree under <agent_home>/.worktrees, sets identity, writes ledger + audit mirror', async () => {
    const result = await createWorktree({
      branch: 'spec/integ-foo',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });

    // Both sides realpath'd — macOS resolves /var/folders → /private/var/folders.
    const expectedPrefix = path.join(fs.realpathSync(fix.agentHome), '.worktrees') + path.sep;
    expect(result.worktreePath.startsWith(expectedPrefix)).toBe(true);
    expect(result.slug).toBe('spec-integ-foo');
    expect(result.createdBranch).toBe(true);
    expect(fs.existsSync(result.worktreePath)).toBe(true);

    // Per-worktree git identity is RESOLVED, not minted; signing config is NOT touched.
    //
    // W26 item 0(a): this used to assert `Instar Agent (<agent>)` /
    // `<agent>@instar.local` — an address linked to no account, which trips
    // GitHub's unattributed-changes rule and turns every release into a human
    // approval. The manager now resolves the identity (config → agent repo →
    // refuse) and hardcodes no domain, so the worktree inherits what the agent
    // repo itself commits as. This fixture's repo is 'Test <test@example.com>'.
    const name = git(['config', 'user.name'], result.worktreePath);
    const email = git(['config', 'user.email'], result.worktreePath);
    expect(name).toBe('Test');
    expect(email).toBe('test@example.com');
    expect(email).not.toContain('instar.local');
    // user.signingkey at the worktree-local scope must be unset (the manager
    // never touches it; the test passes `null` cwd default → empty stdout if absent).
    let signingKey = '';
    try {
      signingKey = git(['config', '--local', '--get', 'user.signingkey'], result.worktreePath);
    } catch {
      signingKey = ''; // unset → exit code 1 → caught here
    }
    expect(signingKey).toBe('');

    // 0700 on .worktrees/
    const mode = fs.statSync(path.join(fix.agentHome, '.worktrees')).mode & 0o777;
    expect(mode).toBe(0o700);

    // Ledger + audit mirror.
    const local = fs.readFileSync(path.join(fix.agentHome, '.worktrees', '.ledger.jsonl'), 'utf-8');
    expect(JSON.parse(local.trim())).toMatchObject({
      agent: fix.agentName,
      branch: 'spec/integ-foo',
      slug: 'spec-integ-foo',
      shareNodeModules: false,
    });
    const mirror = fs.readFileSync(
      path.join(fix.agentHome, '.instar', 'audit', 'worktree-ops.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(mirror.trim())).toMatchObject({ agent: fix.agentName, slug: 'spec-integ-foo' });
  });

  it('activates the Husky pre-commit shim in a newly created worktree', async () => {
    const result = await createWorktree({
      branch: 'spec/husky-shim',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });

    const hookPath = path.join(result.worktreePath, '.husky', '_', 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(git(['config', '--get', 'core.hooksPath'], result.worktreePath)).toBe('.husky/_');
  });

  it('activates hooks when husky exists only in the source repo node_modules (the real prepare script)', async () => {
    // The real package.json prepare script is `husky`, a node_modules binary. A fresh
    // worktree has no node_modules of its own, so hook activation must run after the
    // source repo's node_modules is shared into it.
    const pkgPath = path.join(fix.bareRepo, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'instar', scripts: { prepare: 'husky' } }));
    execFileSync('git', ['-C', fix.bareRepo, 'commit', '-qam', 'prepare: husky'], { stdio: 'pipe' });
    execFileSync('git', ['-C', fix.bareRepo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'], { stdio: 'pipe' });
    const bin = path.join(fix.bareRepo, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'husky'), '#!/bin/sh\nexec node scripts/fake-husky.mjs\n');
    fs.chmodSync(path.join(bin, 'husky'), 0o755);

    // The test runner's own PATH carries this checkout's node_modules/.bin (with a real
    // husky); without removing it, `npm run prepare` would find that one and the test
    // would pass whatever the order of operations.
    const savedPath = process.env.PATH;
    process.env.PATH = (savedPath ?? '').split(path.delimiter).filter((d) => !/node_modules[\\/]\.bin/.test(d)).join(path.delimiter);
    let result: Awaited<ReturnType<typeof createWorktree>>;
    try {
    result = await createWorktree({
      branch: 'spec/husky-from-source-node-modules',
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });
    } finally {
      process.env.PATH = savedPath;
    }

    const hookPath = path.join(result.worktreePath, '.husky', '_', 'pre-commit');
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(git(['config', '--get', 'core.hooksPath'], result.worktreePath)).toBe('.husky/_');
  });

  it('symlinks node_modules by default when the source exists; --no-share-node-modules opts out', async () => {
    // Provide a real node_modules in the bare repo.
    fs.mkdirSync(path.join(fix.bareRepo, 'node_modules', 'a-pkg'), { recursive: true });
    fs.writeFileSync(path.join(fix.bareRepo, 'node_modules', 'a-pkg', 'index.js'), '');

    // Default: symlink.
    const shared = await createWorktree({
      branch: 'feature/shared',
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });
    const sharedNm = path.join(shared.worktreePath, 'node_modules');
    expect(fs.lstatSync(sharedNm).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(sharedNm)).toBe(path.join(fs.realpathSync(fix.bareRepo), 'node_modules'));

    // Opt-out: no symlink.
    const isolated = await createWorktree({
      branch: 'feature/isolated',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });
    expect(fs.existsSync(path.join(isolated.worktreePath, 'node_modules'))).toBe(false);
  });

  it('refuses a second worktree at the same slug without removing partial state', async () => {
    const first = await createWorktree({
      branch: 'spec/collide',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { INSTAR_AGENT_HOME: fix.agentHome },
        instarHome: fix.instarHome,
        registryLookup: fix.registryLookup,
      },
      resolveInstarRepoOpts: {
        env: { INSTAR_REPO: fix.bareRepo },
        fallbackChain: [],
        urlAllowlist: fix.repoAllowlist,
      },
    });
    const sentinel = path.join(first.worktreePath, 'SENTINEL');
    fs.writeFileSync(sentinel, 'first-survivor');

    // Re-running with the same slug (and a different branch to dodge git's
    // branch-already-checked-out refusal): must hit the slug-collision guard
    // and never touch the first worktree.
    await expect(
      createWorktree({
        branch: 'spec/collide-2',
        slug: 'spec-collide',
        shareNodeModules: false,
        resolveAgentHomeOpts: {
          env: { INSTAR_AGENT_HOME: fix.agentHome },
          instarHome: fix.instarHome,
          registryLookup: fix.registryLookup,
        },
        resolveInstarRepoOpts: {
          env: { INSTAR_REPO: fix.bareRepo },
          fallbackChain: [],
          urlAllowlist: fix.repoAllowlist,
        },
      }),
    ).rejects.toThrow(/collision/);

    expect(fs.readFileSync(sentinel, 'utf-8')).toBe('first-survivor');
  });

  it('refuses .worktrees/ that is a symlink (path-containment)', async () => {
    // Pre-plant a symlink at .worktrees/ pointing outside the agent home.
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'iwm-decoy-'));
    fs.symlinkSync(decoy, path.join(fix.agentHome, '.worktrees'));
    try {
      await expect(
        createWorktree({
          branch: 'spec/symlink',
          shareNodeModules: false,
          resolveAgentHomeOpts: {
            env: { INSTAR_AGENT_HOME: fix.agentHome },
            instarHome: fix.instarHome,
            registryLookup: fix.registryLookup,
          },
          resolveInstarRepoOpts: {
            env: { INSTAR_REPO: fix.bareRepo },
            fallbackChain: [],
            urlAllowlist: fix.repoAllowlist,
          },
        }),
      ).rejects.toThrow(/path-containment.*symlink/);
    } finally {
      fs.rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('refuses when the resolved instar repo has no allowlisted remote', async () => {
    // Strip the remote we set up.
    execFileSync('git', ['-C', fix.bareRepo, 'config', '--unset', 'remote.origin.url'], { stdio: 'pipe' });
    await expect(
      createWorktree({
        branch: 'spec/no-remote',
        shareNodeModules: false,
        resolveAgentHomeOpts: {
          env: { INSTAR_AGENT_HOME: fix.agentHome },
          instarHome: fix.instarHome,
          registryLookup: fix.registryLookup,
        },
        resolveInstarRepoOpts: {
          env: { INSTAR_REPO: fix.bareRepo },
          cwd: path.dirname(fix.instarHome),
          fallbackChain: [],
          urlAllowlist: fix.repoAllowlist,
        },
      }),
    ).rejects.toThrow(/integrity validation/);
  });

  it('the default URL allowlist contains exactly the canonical entries', () => {
    // JKHeadley/instar is where instar is developed and released; instar-ai/instar is kept for existing checkouts.
    expect([...DEFAULT_INSTAR_REPO_URL_ALLOWLIST].sort()).toEqual([
      'git@github.com:JKHeadley/instar.git',
      'https://github.com/JKHeadley/instar.git',
      'git@github.com:instar-ai/instar.git',
      'https://github.com/instar-ai/instar.git',
    ].sort());
  });
});
