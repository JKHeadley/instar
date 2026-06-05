// safe-git-allow: test file — direct execFileSync and fs.rmSync are for
//   per-test bare-repo + tmpdir fixture setup/teardown only. The code
//   under test (InstarWorktreeManager) is what would route through
//   SafeGitExecutor / SafeFsExecutor when applicable.

/**
 * Unit tests for InstarWorktreeManager — agent-home resolution, instar-repo
 * validation, slug/branch validation, path-containment guards, and the
 * O_NOFOLLOW + fstat protection on the audit ledger.
 *
 * The createWorktree end-to-end happy-path lives in the integration suite
 * because it needs a real bare git repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
  appendLedgerEntry,
  defaultSlugFor,
  ensureHuskyHooksActive,
  hasRunnableHookShim,
  resolveAgentHome,
  resolveBaseBranch,
  resolveInstarRepo,
  validateBranchName,
  validateSlug,
  worktreeDedupeKey,
  type LedgerEntry,
} from '../../src/core/InstarWorktreeManager.js';

// ── Setup helpers ────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeAgentHome(opts: {
  instarHomeRoot?: string;
  agentName: string;
  withAgentMd?: boolean;
}): { instarHome: string; agentHome: string; agentName: string } {
  const instarHome = opts.instarHomeRoot ?? makeTmpDir('iwm-home');
  const agentHome = path.join(instarHome, 'agents', opts.agentName);
  fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
  if (opts.withAgentMd) {
    fs.writeFileSync(path.join(agentHome, '.instar', 'AGENT.md'), '# Agent\n');
  }
  return { instarHome, agentHome, agentName: opts.agentName };
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Agent home resolution ────────────────────────────────────────────────

describe('resolveAgentHome', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-test'); });
  afterEach(() => cleanup(tmp));

  it('prefers INSTAR_AGENT_HOME env var when set', () => {
    const { instarHome, agentHome, agentName } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'agent-one',
      withAgentMd: false, // env var means CWD walk-up is not consulted
    });
    const result = resolveAgentHome({
      env: { INSTAR_AGENT_HOME: agentHome },
      instarHome,
      registryLookup: () => new Set([agentName]),
    });
    expect(result.agentHome).toBe(fs.realpathSync(agentHome));
    expect(result.agentName).toBe('agent-one');
  });

  it('falls back to CWD walk-up when env var is absent', () => {
    const { instarHome, agentHome, agentName } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'walker',
      withAgentMd: true,
    });
    // CWD several levels below the agent home; walk-up should find .instar/AGENT.md.
    const cwd = path.join(agentHome, 'sub', 'sub', 'sub');
    fs.mkdirSync(cwd, { recursive: true });
    const result = resolveAgentHome({
      env: {},
      cwd,
      instarHome,
      registryLookup: () => new Set([agentName]),
    });
    expect(result.agentHome).toBe(fs.realpathSync(agentHome));
    expect(result.agentName).toBe('walker');
  });

  it('refuses a planted .instar/AGENT.md outside the agents root', () => {
    const { instarHome } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'real-agent',
      withAgentMd: true,
    });
    // Plant a hostile AGENT.md outside agents root.
    const hostile = path.join(tmp, 'hostile-cwd');
    fs.mkdirSync(path.join(hostile, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(hostile, '.instar', 'AGENT.md'), '# Hostile\n');
    expect(() =>
      resolveAgentHome({
        env: {},
        cwd: hostile,
        instarHome,
        registryLookup: () => new Set(['real-agent']),
      }),
    ).toThrow(/not under the instar agents root/);
  });

  it('refuses when CWD has no AGENT.md and env var is missing', () => {
    const { instarHome } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'real-agent',
      withAgentMd: true,
    });
    const orphan = path.join(tmp, 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    expect(() =>
      resolveAgentHome({
        env: {},
        cwd: orphan,
        instarHome,
        registryLookup: () => new Set(['real-agent']),
      }),
    ).toThrow(/no .instar\/AGENT.md found/);
  });

  it('refuses when the resolved path is not directly under <instarHome>/agents/<name>', () => {
    const { instarHome, agentHome } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'real-agent',
      withAgentMd: false,
    });
    const nested = path.join(agentHome, 'nested-not-an-agent-home');
    fs.mkdirSync(nested);
    expect(() =>
      resolveAgentHome({
        env: { INSTAR_AGENT_HOME: nested },
        instarHome,
        registryLookup: () => new Set(['real-agent']),
      }),
    ).toThrow(/not a direct child of/);
  });

  it('refuses when the agent is not in the registry', () => {
    const { instarHome, agentHome } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'unregistered',
      withAgentMd: false,
    });
    expect(() =>
      resolveAgentHome({
        env: { INSTAR_AGENT_HOME: agentHome },
        instarHome,
        registryLookup: () => new Set(['some-other-agent']),
      }),
    ).toThrow(/not present in the instar registry/);
  });

  it('refuses when the agent-name segment violates the name pattern', () => {
    const { instarHome } = makeAgentHome({
      instarHomeRoot: tmp,
      agentName: 'fine-name',
      withAgentMd: false,
    });
    // Manually create a hostile name with shell metacharacters.
    const bad = path.join(instarHome, 'agents', 'b@d-name');
    fs.mkdirSync(bad, { recursive: true });
    expect(() =>
      resolveAgentHome({
        env: { INSTAR_AGENT_HOME: bad },
        instarHome,
        registryLookup: () => new Set(['b@d-name']),
      }),
    ).toThrow(/violates expected pattern/);
  });
});

// ── Instar repo resolution ───────────────────────────────────────────────

describe('resolveInstarRepo', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-repo'); });
  afterEach(() => cleanup(tmp));

  function makeRepo(opts: { remote?: string; hooksOutside?: boolean; sourceSignature?: boolean } = {}): string {
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    if (opts.remote) {
      execFileSync('git', ['config', 'remote.origin.url', opts.remote], { cwd: repo, stdio: 'pipe' });
    }
    if (opts.hooksOutside) {
      execFileSync('git', ['config', 'core.hooksPath', '/tmp/hostile-hooks'], { cwd: repo, stdio: 'pipe' });
    }
    if (opts.sourceSignature) {
      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'instar' }));
      fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'core', 'GitSync.ts'), '');
      fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{}');
    }
    return repo;
  }

  it('rejects a candidate that is not a git repo', () => {
    const notRepo = fs.mkdtempSync(path.join(tmp, 'notrepo-'));
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    expect(() =>
      resolveInstarRepo({
        env: { INSTAR_REPO: notRepo },
        cwd: elsewhere,
        fallbackChain: [],
        urlAllowlist: ['git@github.com:instar-ai/instar.git'],
      }),
    ).toThrow(/no candidate passed integrity validation/);
  });

  it('rejects when remote.origin.url is unset', () => {
    const repo = makeRepo();
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    expect(() =>
      resolveInstarRepo({
        env: { INSTAR_REPO: repo },
        cwd: elsewhere,
        fallbackChain: [],
        urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
      }),
    ).toThrow(/remote.origin.url unset/);
  });

  it('rejects when remote.origin.url is not in the allowlist', () => {
    const repo = makeRepo({ remote: 'git@github.com:attacker/evil.git' });
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    expect(() =>
      resolveInstarRepo({
        env: { INSTAR_REPO: repo },
        cwd: elsewhere,
        fallbackChain: [],
        urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
      }),
    ).toThrow(/not in worktree\.repoUrlAllowlist/);
  });

  it('rejects when core.hooksPath resolves outside the repo', () => {
    const repo = makeRepo({
      remote: 'git@github.com:instar-ai/instar.git',
      hooksOutside: true,
    });
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    expect(() =>
      resolveInstarRepo({
        env: { INSTAR_REPO: repo },
        cwd: elsewhere,
        fallbackChain: [],
        urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
      }),
    ).toThrow(/core.hooksPath .* resolves outside the repo/);
  });

  it('accepts a repo with allowlisted origin and sane hooksPath', () => {
    const repo = makeRepo({ remote: 'git@github.com:instar-ai/instar.git' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.repoPath).toBe(fs.realpathSync(repo));
    expect(result.remoteUrl).toBe('git@github.com:instar-ai/instar.git');
  });

  it('accepts a fork origin when a second remote is allowlisted (fleet worktree convention)', () => {
    // Fleet agents fork instar (origin = instar-<name>.git, NOT allowlisted) and keep
    // a canonical remote (e.g. upstream → instar-ai/instar.git) that the worktree builds
    // against. An origin-only check rejected every agent's own checkout; the all-remotes
    // check accepts it via the canonical remote.
    const repo = makeRepo({ remote: 'https://github.com/owner/instar-echo.git' });
    execFileSync('git', ['remote', 'add', 'upstream', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.repoPath).toBe(fs.realpathSync(repo));
    expect(result.remoteUrl).toBe('git@github.com:instar-ai/instar.git');
  });

  it('honors operator-supplied urlAllowlist additions', () => {
    const repo = makeRepo({ remote: 'git@example.com:fork/instar.git' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: ['git@example.com:fork/instar.git'],
    });
    expect(result.remoteUrl).toBe('git@example.com:fork/instar.git');
  });

  it('accepts a fork origin via second remote even when the repo IS the instar source tree (the guard-safe enumeration)', () => {
    // The live #777 regression: agent homes ARE the instar source tree, and
    // SafeGitExecutor's source-tree guard only passes a narrow verb set there
    // (`remote` is not in it). The old `git remote -v` enumeration threw
    // inside tryGit, was swallowed as {ok:false}, and the any-remote check
    // silently no-oped — every agent's own checkout was rejected and agents
    // fell back to raw `git worktree add` (which skips identity + husky
    // wiring). The enumeration must therefore use read-only `config
    // --get-regexp`, which the guard allows. sourceSignature:true makes the
    // fixture trip the guard exactly like a real agent home.
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['remote', 'add', 'upstream', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.remoteUrl).toBe('git@github.com:instar-ai/instar.git');
  });

  it('accepts a fork-fetch/canonical-push origin via its allowlisted pushurl (the live Echo agent-home shape)', () => {
    // remote.origin.url = personal fork (fetch), remote.origin.pushurl =
    // canonical instar (push). `git remote -v` surfaced the push url only
    // incidentally; the config enumeration must cover `pushurl` explicitly.
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['config', 'remote.origin.pushurl', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.remoteUrl).toBe('git@github.com:instar-ai/instar.git');
  });

  it('reports remoteName + remoteFetchesCanonical for a fetch-url match (safe base)', () => {
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['remote', 'add', 'upstream', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.remoteName).toBe('upstream');
    expect(result.remoteFetchesCanonical).toBe(true);
  });

  it('reports remoteFetchesCanonical=false for a pushurl-only match (trusted, but refs are the fork)', () => {
    // The live Echo agent-home shape: origin FETCHES the personal fork and
    // PUSHES to canonical. Trust is proven by the pushurl, but origin's refs
    // are the fork's backup-sync — never a safe base for code worktrees.
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['config', 'remote.origin.pushurl', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.remoteName).toBe('origin');
    expect(result.remoteFetchesCanonical).toBe(false);
  });

  it('prefers a fetch-url match over an earlier pushurl match (refs beat trust-only)', () => {
    // origin matches via pushurl; a second remote matches via its FETCH url.
    // The fetch remote must win remoteName — its refs are usable as a base.
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['config', 'remote.origin.pushurl', 'git@github.com:instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/instar-ai/instar.git'], { cwd: repo, stdio: 'pipe' });
    const result = resolveInstarRepo({
      env: { INSTAR_REPO: repo },
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });
    expect(result.remoteName).toBe('upstream');
    expect(result.remoteFetchesCanonical).toBe(true);
  });

  it('still rejects a source-tree repo when NO remote url or pushurl is allowlisted', () => {
    const repo = makeRepo({
      remote: 'https://github.com/owner/instar-echo.git',
      sourceSignature: true,
    });
    execFileSync('git', ['config', 'remote.origin.pushurl', 'git@example.com:attacker/evil.git'], { cwd: repo, stdio: 'pipe' });
    // cwd must be a non-repo: otherwise candidate discovery falls through to
    // the test process's own (valid) instar checkout and resolves THAT.
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    expect(() =>
      resolveInstarRepo({
        env: { INSTAR_REPO: repo },
        cwd: elsewhere,
        fallbackChain: [],
        urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
      }),
    ).toThrow(/not in worktree.repoUrlAllowlist/);
  });

  it('discovers a valid instar repo from cwd before hardcoded fallbacks', () => {
    const repo = makeRepo({
      remote: 'git@github.com:instar-ai/instar.git',
      sourceSignature: true,
    });
    const subdir = path.join(repo, 'src', 'core');

    const result = resolveInstarRepo({
      env: {},
      cwd: subdir,
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });

    expect(result.repoPath).toBe(fs.realpathSync(repo));
    expect(result.remoteUrl).toBe('git@github.com:instar-ai/instar.git');
  });

  it('discovers a valid instar repo from INSTAR_AGENT_HOME when cwd is elsewhere', () => {
    const repo = makeRepo({
      remote: 'git@github.com:instar-ai/instar.git',
      sourceSignature: true,
    });
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));

    const result = resolveInstarRepo({
      env: { INSTAR_AGENT_HOME: repo },
      cwd: elsewhere,
      fallbackChain: [],
      urlAllowlist: DEFAULT_INSTAR_REPO_URL_ALLOWLIST,
    });

    expect(result.repoPath).toBe(fs.realpathSync(repo));
  });
});

// ── Slug and branch validation ───────────────────────────────────────────

describe('resolveBaseBranch (task #82 — canonical-remote-preferred base)', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-base'); });
  afterEach(() => cleanup(tmp));

  /** A repo with a local main commit and fabricated remote-tracking refs. */
  function makeRepoWithRemoteRefs(remoteRefs: string[]): string {
    const repo = fs.mkdtempSync(path.join(tmp, 'base-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@e.st'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo, stdio: 'pipe' });
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    execFileSync('git', ['add', 'f'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init', '-q'], { cwd: repo, stdio: 'pipe' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    for (const ref of remoteRefs) {
      execFileSync('git', ['update-ref', ref, sha], { cwd: repo, stdio: 'pipe' });
    }
    return repo;
  }

  it('explicit override always wins', async () => {
    const repo = makeRepoWithRemoteRefs([]);
    await expect(resolveBaseBranch(repo, 'JKHeadley/main', 'upstream')).resolves.toBe('JKHeadley/main');
  });

  it('prefers the allowlisted remote main over origin/HEAD (the fork-backup trap)', async () => {
    // origin/HEAD points at the fork's backup branch; upstream/main is
    // canonical. The base must be upstream/main.
    const repo = makeRepoWithRemoteRefs([
      'refs/remotes/origin/main',
      'refs/remotes/upstream/main',
    ]);
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'pipe' });
    await expect(resolveBaseBranch(repo, undefined, 'upstream')).resolves.toBe('upstream/main');
  });

  it('falls back to origin/HEAD when the preferred remote has no refs', async () => {
    const repo = makeRepoWithRemoteRefs(['refs/remotes/origin/main']);
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repo, stdio: 'pipe' });
    await expect(resolveBaseBranch(repo, undefined, 'upstream')).resolves.toBe('origin/main');
  });

  it('without a preferred remote, behavior is unchanged (origin/HEAD → local main)', async () => {
    const repo = makeRepoWithRemoteRefs([]);
    await expect(resolveBaseBranch(repo)).resolves.toBe('main');
  });
});

describe('ensureHuskyHooksActive (task #82 — loud on a non-code base)', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-husky'); });
  afterEach(() => cleanup(tmp));

  it('throws an actionable error when the worktree lacks package.json (garbage-base shape)', () => {
    // The live failure: a worktree branched from the fork's backup-sync
    // branch has agent-home files but no package.json. The old silent early
    // return made it look fine while running ZERO commit-time checks.
    const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
    fs.writeFileSync(path.join(wt, 'MEMORY.md'), 'backup-sync content');
    expect(() => ensureHuskyHooksActive(wt)).toThrow(/does not look like the instar code tree/);
    expect(() => ensureHuskyHooksActive(wt)).toThrow(/--base/);
  });

  it('throws when package.json exists but the tracked pre-commit hook is missing', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'wt-'));
    fs.writeFileSync(path.join(wt, 'package.json'), '{}');
    expect(() => ensureHuskyHooksActive(wt)).toThrow(/\.husky\/pre-commit/);
  });
});

describe('validateSlug', () => {
  it('accepts well-formed slugs', () => {
    expect(() => validateSlug('spec-foo', new Set())).not.toThrow();
    expect(() => validateSlug('feature.x_2', new Set())).not.toThrow();
  });

  it('refuses path-traversal attempts', () => {
    expect(() => validateSlug('..', new Set())).toThrow(/empty or relative/);
    expect(() => validateSlug('../escape', new Set())).toThrow(/must match/);
    expect(() => validateSlug('a/b', new Set())).toThrow(/must match/);
  });

  it('refuses shell metacharacters and leading dashes', () => {
    expect(() => validateSlug('foo;bar', new Set())).toThrow(/must match/);
    // Leading-dash check fires first and produces its own error class —
    // either branch refuses, which is the invariant the spec cares about.
    expect(() => validateSlug('-rm', new Set())).toThrow(/leading dash|must match/);
    expect(() => validateSlug('foo bar', new Set())).toThrow(/must match/);
    expect(() => validateSlug('foo\0bar', new Set())).toThrow(/must match/);
  });

  it('refuses case-insensitive collisions with existing slugs', () => {
    expect(() => validateSlug('Foo-Bar', new Set(['foo-bar']))).toThrow(/collision/);
  });

  it('defaultSlugFor swaps slashes for hyphens', () => {
    expect(defaultSlugFor('spec/agent-worktree')).toBe('spec-agent-worktree');
    expect(defaultSlugFor('feature/sub/deep')).toBe('feature-sub-deep');
  });
});

describe('validateBranchName', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-branch'); });
  afterEach(() => cleanup(tmp));

  function makeRepo(): string {
    const repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    return repo;
  }

  it('accepts a well-formed branch', () => {
    const repo = makeRepo();
    expect(() => validateBranchName('spec/foo', repo)).not.toThrow();
  });

  it('refuses leading dashes (would be eaten as a git flag)', () => {
    const repo = makeRepo();
    expect(() => validateBranchName('--upload-pack=evil', repo)).toThrow(/leading dash forbidden/);
  });

  it('refuses NUL bytes', () => {
    const repo = makeRepo();
    expect(() => validateBranchName('foo\0bar', repo)).toThrow(/NUL/);
  });

  it('refuses names rejected by git check-ref-format (..)', () => {
    const repo = makeRepo();
    expect(() => validateBranchName('foo..bar', repo)).toThrow(/refused by git check-ref-format/);
  });
});

// ── Audit ledger O_NOFOLLOW + fstat ──────────────────────────────────────

describe('appendLedgerEntry', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-ledger'); });
  afterEach(() => cleanup(tmp));

  function entry(): LedgerEntry {
    return {
      ts: '2026-05-19T00:00:00Z',
      agent: 'echo',
      branch: 'spec/foo',
      slug: 'spec-foo',
      worktreePath: '/some/path',
      instarRepo: '/some/repo',
      instarRepoSha: 'abc1234',
      shareNodeModules: true,
    };
  }

  it('writes a local ledger line and an audit mirror', () => {
    const worktrees = path.join(tmp, '.worktrees');
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(worktrees, { mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true });
    appendLedgerEntry(worktrees, stateDir, entry());
    const local = fs.readFileSync(path.join(worktrees, '.ledger.jsonl'), 'utf-8');
    const mirror = fs.readFileSync(
      path.join(stateDir, 'audit', 'worktree-ops.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(local.trim())).toMatchObject({ agent: 'echo', slug: 'spec-foo' });
    expect(JSON.parse(mirror.trim())).toMatchObject({ agent: 'echo', slug: 'spec-foo' });
  });

  it('refuses to append when the ledger file is a symlink (O_NOFOLLOW)', () => {
    const worktrees = path.join(tmp, '.worktrees');
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(worktrees, { mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true });
    const decoy = path.join(tmp, 'decoy.txt');
    fs.writeFileSync(decoy, 'this is the decoy\n');
    fs.symlinkSync(decoy, path.join(worktrees, '.ledger.jsonl'));
    expect(() => appendLedgerEntry(worktrees, stateDir, entry())).toThrow(
      /symlink|ELOOP|refused/,
    );
    // Decoy must not have been written to.
    expect(fs.readFileSync(decoy, 'utf-8')).toBe('this is the decoy\n');
  });

  it('refuses to append when an existing ledger has group/other-readable mode', () => {
    const worktrees = path.join(tmp, '.worktrees');
    const stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(worktrees, { mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(worktrees, '.ledger.jsonl');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644); // group + other can read — refused
    expect(() => appendLedgerEntry(worktrees, stateDir, entry())).toThrow(
      /grants group\/other access/,
    );
  });
});

// ── Detector dedupe key (referenced by Layer 4 spec) ─────────────────────

describe('worktreeDedupeKey', () => {
  it('is deterministic per path', () => {
    expect(worktreeDedupeKey('/a/b')).toBe(worktreeDedupeKey('/a/b'));
    expect(worktreeDedupeKey('/a/b')).not.toBe(worktreeDedupeKey('/a/c'));
  });

  it('uses the documented prefix so the Layer 4 detector can produce it', () => {
    expect(worktreeDedupeKey('/x').startsWith('worktree-misplaced:')).toBe(true);
  });
});

describe('hasRunnableHookShim', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir('iwm-husky'); });
  afterEach(() => cleanup(tmp));

  it('requires the generated hook shim to exist and be executable', () => {
    const hook = path.join(tmp, '.husky', '_', 'pre-commit');
    expect(hasRunnableHookShim(hook)).toBe(false);

    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/usr/bin/env sh\nexit 0\n');
    fs.chmodSync(hook, 0o644);
    expect(hasRunnableHookShim(hook)).toBe(false);

    fs.chmodSync(hook, 0o755);
    expect(hasRunnableHookShim(hook)).toBe(true);
  });
});
