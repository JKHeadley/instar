import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { GitSyncManager, type GitSyncConfig } from '../../src/core/GitSync.js';
import { generateSigningKeyPair } from '../../src/core/MachineIdentity.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression test for the commit-signing bug (verified live on a real
 * two-machine mesh, 2026-05-28): configureCommitSigning enabled
 * commit.gpgsign against a key git's SSH signer couldn't load (no `.pub`
 * sibling, PKCS#8 PEM format) → EVERY commit failed ("Couldn't load public
 * key …: No such file or directory") and the standby could never sync.
 *
 * The invariant under test: after configureCommitSigning, a commit ALWAYS
 * succeeds — signing is enabled only when a real test-sign works, otherwise it
 * is explicitly disabled (commit verification is a no-op today, so unsigned is
 * safe; broken signing is not).
 */

function git(cwd: string, args: string[]): string {
  return SafeGitExecutor.run(args, {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    operation: 'tests/unit/git-sync-commit-signing.test.ts:git',
  }).trim();
}

// ssh-keygen is not git; SafeGitExecutor doesn't cover it, and this is a test
// fixture (generate a real OpenSSH key), not production destructive I/O.
function sshKeygen(args: string[]): void {
  // eslint-disable-next-line no-restricted-syntax
  execFileSync('ssh-keygen', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function mkDeps() {
  return {
    identityManager: { loadRegistry: () => ({ machines: {} }), registryPath: '/tmp/r.json' } as any,
    securityLog: { append: () => {}, query: () => [], getPath: () => '/tmp/s.jsonl' } as any,
  };
}

describe('GitSync.configureCommitSigning — commits never break (signing regression)', () => {
  let root: string;
  let work: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsign-'));
    work = path.join(root, 'work');
    fs.mkdirSync(path.join(work, '.instar', 'machine'), { recursive: true });
    git(root, ['init', '-b', 'main', work]);
    git(work, ['config', 'user.email', 'test@instar.local']);
    git(work, ['config', 'user.name', 'test']);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/git-sync-commit-signing.test.ts:afterEach' });
  });

  function manager(): GitSyncManager {
    const { identityManager, securityLog } = mkDeps();
    const cfg: GitSyncConfig = {
      projectDir: work,
      stateDir: path.join(work, '.instar'),
      identityManager,
      securityLog,
      machineId: 'm_test',
      autoPush: false, // no remote in this test; we only assert the commit lands
    };
    return new GitSyncManager(cfg);
  }

  function commitSucceeds(mgr: GitSyncManager): boolean {
    const f = path.join(work, '.instar', 'lease.json');
    fs.writeFileSync(f, `{"epoch":${Date.now() % 1000}}`);
    return mgr.commitAndPush('chore(mesh): lease epoch', [f]);
  }

  it('with the codebase PEM key (ssh-keygen cannot load it): disables signing, commit still lands', () => {
    const keys = generateSigningKeyPair(); // PKCS#8 PEM — the format the codebase generates
    fs.writeFileSync(path.join(work, '.instar', 'machine', 'signing-key.pem'), keys.privateKey, { mode: 0o600 });

    const mgr = manager();
    mgr.configureCommitSigning();

    // Signing must be explicitly OFF (never left in a broken on-state).
    expect(git(work, ['config', '--get', 'commit.gpgsign'])).toBe('false');
    // The core guarantee: the commit lands.
    expect(commitSucceeds(mgr)).toBe(true);
  });

  it('with a git-loadable OpenSSH key: enables signing and the commit lands signed', () => {
    // A real OpenSSH ed25519 key that ssh-keygen CAN sign with.
    const keyPath = path.join(work, '.instar', 'machine', 'signing-key.pem');
    sshKeygen(['-t', 'ed25519', '-N', '', '-C', 'mesh', '-f', keyPath]);

    const mgr = manager();
    mgr.configureCommitSigning();

    expect(git(work, ['config', '--get', 'commit.gpgsign'])).toBe('true');
    expect(git(work, ['config', '--get', 'gpg.format'])).toBe('ssh');
    expect(fs.existsSync(`${keyPath}.pub`)).toBe(true);
    expect(commitSucceeds(mgr)).toBe(true);
    // The HEAD commit is actually signed.
    const verify = git(work, ['log', '--format=%G?', '-1']);
    expect(['G', 'U', 'E', 'N']).toContain(verify); // signed (G/U) — never an error that aborts commit
  });

  it('missing signing key throws (operator must pair first)', () => {
    const mgr = manager();
    expect(() => mgr.configureCommitSigning()).toThrow(/signing key not found/i);
  });
});
