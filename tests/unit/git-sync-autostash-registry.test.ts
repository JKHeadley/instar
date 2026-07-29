import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitSyncManager, type GitSyncConfig } from '../../src/core/GitSync.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression test for the registry conflict-marker corruption (verified live on
 * a real two-machine mesh, 2026-05-28): `git pull --rebase --autostash` exits 0
 * even when the autostash pop conflicts, leaving machines/registry.json with
 * `<<<<<<< Updated upstream` markers (unparseable JSON) — which the
 * catch-block-only resolver never saw. The fix runs the deterministic registry
 * merge on post-pull unmerged files. This reproduces the EXACT scenario through
 * GitSyncManager.sync() and asserts the registry ends valid + merged.
 */

function git(cwd: string, args: string[]): string {
  return SafeGitExecutor.run(args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    operation: 'tests/unit/git-sync-autostash-registry.test.ts:git',
  }).trim();
}

const REG = '.instar/machines/registry.json';

function reg(machines: Record<string, number>, epoch: number, holder: string) {
  return {
    version: 1,
    machines: Object.fromEntries(Object.entries(machines).map(([id]) => [id, {
      name: id, status: 'active', role: id === holder ? 'awake' : 'standby',
      pairedAt: '2026-05-28T00:00:00Z', lastSeen: '2026-05-28T00:00:00Z',
      syncSequence: epoch, authoredUnderEpoch: epoch,
    }])),
    lease: { holder, epoch, acquiredAt: '2026-05-28T00:00:00Z', expiresAt: '2026-05-28T01:00:00Z', nonce: 1, signature: 'x' },
  };
}

describe('GitSync.sync — autostash-pop registry conflict is resolved, not left as markers', () => {
  let root: string, bare: string, A: string, B: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autostash-reg-'));
    bare = path.join(root, 'mesh.git');
    A = path.join(root, 'A');
    B = path.join(root, 'B');
    git(root, ['init', '--bare', '-b', 'main', bare]);

    // Machine A (awake) seeds the mesh with itself + a lease at epoch 1.
    git(root, ['init', '-b', 'main', A]);
    git(A, ['config', 'user.email', 'a@instar.local']);
    git(A, ['config', 'user.name', 'A']);
    git(A, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(A, '.instar', 'machines'), { recursive: true });
    fs.writeFileSync(path.join(A, REG), JSON.stringify(reg({ A: 1 }, 1, 'A'), null, 2));
    git(A, ['add', '.']);
    git(A, ['commit', '-m', 'seed']);
    git(A, ['remote', 'add', 'origin', bare]);
    git(A, ['push', '-u', 'origin', 'main']);

    // Machine B (standby) clones the mesh.
    git(root, ['clone', bare, B]);
    git(B, ['config', 'user.email', 'b@instar.local']);
    git(B, ['config', 'user.name', 'B']);
    git(B, ['config', 'commit.gpgsign', 'false']);

    // A bumps its lease to epoch 2 and pushes (concurrent change).
    fs.writeFileSync(path.join(A, REG), JSON.stringify(reg({ A: 1 }, 2, 'A'), null, 2));
    git(A, ['commit', '-am', 'lease epoch 2']);
    git(A, ['push']);

    // B has an UNCOMMITTED local registry change (its own standby registration)
    // — this is what autostash stashes, then conflicts on pop.
    fs.writeFileSync(path.join(B, REG), JSON.stringify(reg({ A: 1, B: 1 }, 1, 'A'), null, 2));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/git-sync-autostash-registry.test.ts:afterEach' });
  });

  function fileBackedIdentityManager() {
    const regPath = path.join(B, REG);
    return {
      loadRegistry: () => JSON.parse(fs.readFileSync(regPath, 'utf-8')),
      saveRegistry: (r: unknown) => fs.writeFileSync(regPath, JSON.stringify(r, null, 2)),
      loadRemoteIdentity: () => null,
      registryPath: regPath,
    } as any;
  }

  it('B.sync() resolves the autostash conflict — registry stays valid JSON with both machines', async () => {
    const cfg: GitSyncConfig = {
      projectDir: B,
      stateDir: path.join(B, '.instar'),
      identityManager: fileBackedIdentityManager(),
      securityLog: { append: () => {}, query: () => [], getPath: () => '/tmp/s.jsonl' } as any,
      machineId: 'B',
      autoPush: false,
    };
    const mgr = new GitSyncManager(cfg);
    // GitSync's conflict resolvers run with cwd === projectDir (how the server
    // invokes it); replicate that faithfully for the sync() call.
    const prevCwd = process.cwd();
    process.chdir(B);
    try {
      await mgr.sync();
    } finally {
      process.chdir(prevCwd);
    }

    const raw = fs.readFileSync(path.join(B, REG), 'utf-8');
    // The bug: conflict markers corrupted the file.
    expect(raw).not.toContain('<<<<<<<');
    expect(raw).not.toContain('>>>>>>>');
    // Valid JSON again.
    const parsed = JSON.parse(raw);
    // Deterministic merge: union of machines, higher-epoch lease wins.
    expect(Object.keys(parsed.machines).sort()).toEqual(['A', 'B']);
    expect(parsed.lease.epoch).toBe(2);
    // No unmerged files remain in B's repo.
    expect(git(B, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
  });
});
