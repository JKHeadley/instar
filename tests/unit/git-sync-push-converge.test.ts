import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitSyncManager, type GitSyncConfig } from '../../src/core/GitSync.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Bug #5 — a standby's sync push must converge even when the awake machine's
 * lease churn left the remote AHEAD at sync time. The sync push path now
 * commits + rebases + re-pushes (commitAndPushWithRebaseRetry) so the standby
 * lands its state within one sync instead of stalling a full cycle. This proves
 * the integrated pull→commit→push path lands the standby's change on a remote
 * that was ahead when the sync began.
 */

function git(cwd: string, args: string[]): string {
  return SafeGitExecutor.run(args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    operation: 'tests/unit/git-sync-push-converge.test.ts:git',
  }).trim();
}

describe('GitSync.sync — standby state converges to a remote that was ahead', () => {
  let root: string, bare: string, A: string, B: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-converge-'));
    bare = path.join(root, 'mesh.git');
    A = path.join(root, 'A');
    B = path.join(root, 'B');
    git(root, ['init', '--bare', '-b', 'main', bare]);

    git(root, ['init', '-b', 'main', A]);
    git(A, ['config', 'user.email', 'a@i']); git(A, ['config', 'user.name', 'A']); git(A, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(A, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(A, '.instar', 'shared.json'), '{"a":0}');
    git(A, ['add', '.']); git(A, ['commit', '-m', 'seed']);
    git(A, ['remote', 'add', 'origin', bare]); git(A, ['push', '-u', 'origin', 'main']);

    git(root, ['clone', bare, B]);
    git(B, ['config', 'user.email', 'b@i']); git(B, ['config', 'user.name', 'B']); git(B, ['config', 'commit.gpgsign', 'false']);

    // Awake machine A advances the remote (lease churn) AFTER B last synced.
    fs.writeFileSync(path.join(A, '.instar', 'lease.json'), '{"epoch":7}');
    git(A, ['add', '.']); git(A, ['commit', '-m', 'lease epoch 7']); git(A, ['push']);

    // Standby B has a local UNCOMMITTED state change to push.
    fs.writeFileSync(path.join(B, '.instar', 'b-state.json'), '{"b":1}');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/git-sync-push-converge.test.ts:afterEach' });
  });

  it('lands B’s change on the remote and pulls A’s ahead-of-B commit', async () => {
    const regPath = path.join(B, '.instar', 'registry.json'); // unused by this test path
    const cfg: GitSyncConfig = {
      projectDir: B,
      stateDir: path.join(B, '.instar'),
      identityManager: {
        loadRegistry: () => ({ machines: {} }),
        saveRegistry: () => {},
        loadRemoteIdentity: () => null,
        registryPath: regPath,
      } as any,
      securityLog: { append: () => {}, query: () => [], getPath: () => '/tmp/s.jsonl' } as any,
      machineId: 'B',
      autoPush: true,
    };
    const mgr = new GitSyncManager(cfg);

    const prev = process.cwd();
    process.chdir(B);
    let result;
    try {
      result = await mgr.sync();
    } finally {
      process.chdir(prev);
    }

    // B pulled A's lease-epoch commit...
    expect(result.pulled).toBe(true);
    expect(fs.existsSync(path.join(B, '.instar', 'lease.json'))).toBe(true);
    // ...and pushed its own state to the remote.
    expect(result.pushed).toBe(true);
    const remoteFiles = git(root, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']);
    expect(remoteFiles).toContain('.instar/b-state.json');
    expect(remoteFiles).toContain('.instar/lease.json');
  });
});
