// safe-git-allow: test file — direct execFileSync + fs operations are for
//   bare-repo fixture setup/teardown.

/**
 * Verifies the clone-instead-of-worktree isolation path for cross-project
 * worktrees. The critical guarantee: a worktree created via `createWorktree`
 * with a source repo OUTSIDE agent home must survive its parent repo's
 * `.git/` becoming inaccessible mid-session. Replicates the 2026-05-22
 * topic-intent-layer incident (sandbox revocation cascade).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorktree,
  inspectWorktreeHealth,
  shouldCloneInsteadOfWorktree,
} from '../../src/core/InstarWorktreeManager.js';

function makeTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function initBareSource(dir: string): void {
  execFileSync('git', ['init', '--initial-branch=main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'fixture@instar.local'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Fixture'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'remote.origin.url', 'git@github.com:instar-ai/instar.git'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'pipe' });
}

function makeAgentHome(name: string): { agentHome: string; instarHome: string } {
  const instarHome = makeTmp('iwm-clone-home');
  const agentHome = path.join(instarHome, 'agents', name);
  fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(agentHome, '.instar', 'AGENT.md'), '# fixture-agent\n');
  return { agentHome, instarHome };
}

describe('shouldCloneInsteadOfWorktree', () => {
  it('returns true when source is outside agent home', () => {
    const outside = makeTmp('outside-source');
    const { agentHome } = makeAgentHome('a');
    expect(shouldCloneInsteadOfWorktree(outside, agentHome)).toBe(true);
  });

  it('returns false when source is INSIDE agent home', () => {
    const { agentHome } = makeAgentHome('b');
    const inside = path.join(agentHome, 'source');
    fs.mkdirSync(inside, { recursive: true });
    expect(shouldCloneInsteadOfWorktree(inside, agentHome)).toBe(false);
  });

  it('respects INSTAR_WORKTREE_FORCE_CLONE=1', () => {
    const { agentHome, instarHome } = makeAgentHome('c');
    const inside = path.join(instarHome, 'source');
    fs.mkdirSync(inside, { recursive: true });
    process.env.INSTAR_WORKTREE_FORCE_CLONE = '1';
    try {
      expect(shouldCloneInsteadOfWorktree(inside, agentHome)).toBe(true);
    } finally {
      delete process.env.INSTAR_WORKTREE_FORCE_CLONE;
    }
  });

  it('respects INSTAR_WORKTREE_FORCE_WORKTREE=1 (rollback escape hatch)', () => {
    const outside = makeTmp('outside-source-2');
    const { agentHome } = makeAgentHome('d');
    process.env.INSTAR_WORKTREE_FORCE_WORKTREE = '1';
    try {
      expect(shouldCloneInsteadOfWorktree(outside, agentHome)).toBe(false);
    } finally {
      delete process.env.INSTAR_WORKTREE_FORCE_WORKTREE;
    }
  });
});

describe('createWorktree — clone isolation (source outside agent home)', () => {
  let source: string;
  let agentHome: string;
  let instarHome: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    source = makeTmp('iwm-clone-src');
    initBareSource(source);
    const home = makeAgentHome('echo-fixture');
    agentHome = home.agentHome;
    instarHome = home.instarHome;
    envBackup = { ...process.env };
    // Force INSTAR_AGENT_HOME so the agent-home resolver doesn't walk cwd.
    process.env.INSTAR_AGENT_HOME = agentHome;
    process.env.HOME = instarHome.replace(/\/agents\/.*$/, '');
  });

  afterEach(() => {
    process.env = envBackup;
    try { fs.rmSync(source, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(instarHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('produces a worktree with a real .git directory (NOT a pointer file)', async () => {
    const result = await createWorktree({
      branch: 'feat/isolation-test',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { ...process.env, INSTAR_AGENT_HOME: agentHome },
        instarHome,
        registryLookup: () => new Set(['echo-fixture']),
      },
      resolveInstarRepoOpts: { env: { ...process.env, INSTAR_REPO: source } },
      baseBranch: 'main',
    });
    const gitMarker = path.join(result.worktreePath, '.git');
    const lst = fs.lstatSync(gitMarker);
    expect(lst.isDirectory()).toBe(true);
    expect(lst.isFile()).toBe(false);
  });

  it('survives parent .git/ becoming inaccessible (sandbox-revocation simulation)', async () => {
    const result = await createWorktree({
      branch: 'feat/survive-parent-delete',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { ...process.env, INSTAR_AGENT_HOME: agentHome },
        instarHome,
        registryLookup: () => new Set(['echo-fixture']),
      },
      resolveInstarRepoOpts: { env: { ...process.env, INSTAR_REPO: source } },
      baseBranch: 'main',
    });
    // Simulate sandbox revocation by removing parent .git/objects/. The
    // worktree's --no-hardlinks clone has its own object copies, so git ops
    // must still resolve.
    const parentObjects = path.join(source, '.git', 'objects');
    fs.rmSync(parentObjects, { recursive: true, force: true });
    expect(() => {
      execFileSync('git', ['-C', result.worktreePath, 'log', '--oneline', '-1'], { stdio: 'pipe' });
    }).not.toThrow();
  });

  it('emits an OK health entry for clone-isolated worktrees', async () => {
    await createWorktree({
      branch: 'feat/health-ok',
      shareNodeModules: false,
      resolveAgentHomeOpts: {
        env: { ...process.env, INSTAR_AGENT_HOME: agentHome },
        instarHome,
        registryLookup: () => new Set(['echo-fixture']),
      },
      resolveInstarRepoOpts: { env: { ...process.env, INSTAR_REPO: source } },
      baseBranch: 'main',
    });
    const entries = inspectWorktreeHealth(agentHome);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const ours = entries.find((e) => e.slug === 'feat-health-ok');
    expect(ours).toBeDefined();
    expect(ours!.status).toBe('ok');
  });
});

describe('inspectWorktreeHealth', () => {
  let agentHome: string;
  let instarHome: string;

  beforeEach(() => {
    const home = makeAgentHome('inspect-fixture');
    agentHome = home.agentHome;
    instarHome = home.instarHome;
    fs.mkdirSync(path.join(agentHome, '.worktrees'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(agentHome, '.worktrees'), 0o700);
  });

  afterEach(() => {
    try { fs.rmSync(instarHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('classifies a detached-no-git worktree directory', () => {
    fs.mkdirSync(path.join(agentHome, '.worktrees', 'orphan'));
    const r = inspectWorktreeHealth(agentHome);
    expect(r).toEqual([
      expect.objectContaining({ slug: 'orphan', status: 'detached-no-git' }),
    ]);
  });

  it('classifies a broken-pointer worktree (gitdir target missing)', () => {
    const wt = path.join(agentHome, '.worktrees', 'broken');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /nonexistent/path/that/does/not/exist\n');
    const r = inspectWorktreeHealth(agentHome);
    expect(r).toEqual([
      expect.objectContaining({ slug: 'broken', status: 'broken-pointer', parentReachable: false }),
    ]);
  });

  it('returns empty list when .worktrees directory does not exist', () => {
    const home2 = makeAgentHome('no-worktrees');
    expect(inspectWorktreeHealth(home2.agentHome)).toEqual([]);
  });

  it('skips dotfiles (e.g. .ledger.jsonl)', () => {
    fs.writeFileSync(path.join(agentHome, '.worktrees', '.ledger.jsonl'), '{}\n');
    const r = inspectWorktreeHealth(agentHome);
    expect(r).toEqual([]);
  });
});
