// safe-git-allow: test fixture setup builds a sandbox repository and bare remote with git directly.
/**
 * EVO-029 (docs/specs/safe-git-read-surface-hardening.md, section 8).
 *
 * `instar wakeup --force` used to try a commit + push of the lease that never
 * ran (SafeGitExecutor.run misrouted its pre-verb `-c`) and then printed
 * "Lease claimed + pushed". The commit and push are removed: the claim is saved
 * locally only, and the printed line says what really happens next.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimLeaseForSelf,
  forceClaimLine,
  leaseKeptInGit,
  leaseObserveOnly,
} from '../../src/commands/machine.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sanitizedGitEnv } from '../helpers/git-test-env.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: sanitizedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

let root: string;
let home: string;
let bare: string;
let stateDir: string;
let registryPath: string;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evo029-lease-')));
  home = path.join(root, 'home');
  bare = path.join(root, 'remote.git');
  stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const mgr = new MachineIdentityManager(stateDir);
  await mgr.generateIdentity({ name: 'mini', role: 'standby' });
  const reg = mgr.loadRegistry();
  reg.lease = { holder: 'm_peer', epoch: 5, acquiredAt: '2026-05-28T00:00:00Z', expiresAt: '2026-05-28T01:00:00Z', nonce: 3, signature: 'old' } as never;
  mgr.saveRegistry(reg);
  registryPath = mgr.registryPath;

  fs.mkdirSync(bare);
  git(bare, 'init', '-q', '--bare', '--initial-branch=main');
  git(home, 'init', '-q', '--initial-branch=main');
  git(home, 'config', 'user.email', 't@t.com');
  git(home, 'config', 'user.name', 'T');
  git(home, 'config', 'commit.gpgsign', 'false');
  git(home, 'add', path.relative(home, registryPath));
  git(home, 'commit', '-q', '-m', 'registry');
  git(home, 'remote', 'add', 'origin', bare);
  git(home, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/machine-claim-lease-local-only.test.ts:afterEach' });
});

describe('claimLeaseForSelf saves the claim locally and makes no commit or push', () => {
  it('writes the +1 epoch to the local registry, leaves HEAD and the remote unchanged', async () => {
    const mgr = new MachineIdentityManager(stateDir);
    const selfId = mgr.loadIdentity().machineId;
    const key = fs.readFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'utf-8');
    const headBefore = git(home, 'rev-parse', 'HEAD');
    const remoteBefore = git(bare, 'rev-parse', 'main');

    await claimLeaseForSelf(mgr, selfId, key, { stateDir, projectDir: home });

    const reg = mgr.loadRegistry();
    expect(reg.lease.holder).toBe(selfId);
    expect(reg.lease.epoch).toBe(6);
    expect(git(home, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(bare, 'rev-parse', 'main')).toBe(remoteBefore);
    // The change is a working-tree modification only.
    expect(git(home, 'status', '--porcelain')).toContain('registry.json');
  });
});

describe('the force-wakeup line says what happens next', () => {
  it('reads the lease medium the way the server does', () => {
    expect(leaseKeptInGit(home, true, registryPath)).toBe(true);
    expect(leaseKeptInGit(home, false, registryPath)).toBe(false); // git backup off
    const noGit = fs.mkdtempSync(path.join(root, 'nogit-'));
    expect(leaseKeptInGit(noGit, true, path.join(noGit, 'registry.json'))).toBe(false);
    // A git-ignored registry keeps the lease on the local store.
    git(home, 'rm', '-q', '--cached', path.relative(home, registryPath));
    fs.writeFileSync(path.join(home, '.gitignore'), '.instar/machines/registry.json\n');
    expect(leaseKeptInGit(home, true, registryPath)).toBe(false);
  });

  it('treats an instar source tree as not git-kept (GitSyncManager refuses one)', () => {
    // SourceTreeGuard's marker layer: this file marks an instar source checkout.
    fs.writeFileSync(path.join(home, '.instar-source-tree'), '');
    expect(leaseKeptInGit(home, true, registryPath)).toBe(false);
  });

  it('follows the coordinator rule for observe-only machines', () => {
    expect(leaseObserveOnly(undefined)).toBe(false);
    expect(leaseObserveOnly({ telegramPolling: false })).toBe(true);
    expect(leaseObserveOnly({ telegramPolling: false, leaseSelfHeal: { leaseRole: 'active' } })).toBe(false);
    expect(leaseObserveOnly({ leaseSelfHeal: { leaseRole: 'observe-only' } })).toBe(true);
    expect(leaseObserveOnly({ leaseSelfHeal: { leaseRole: 'deferential' } })).toBe(false);
  });

  it('has one plain line per outlook, and none claims a push', () => {
    const lines = (['git', 'not-git', 'observe-only', 'unknown'] as const).map((o) => forceClaimLine(o));
    expect(new Set(lines).size).toBe(4);
    for (const line of lines) expect(line).not.toMatch(/pushed/i);
    expect(forceClaimLine('git')).toContain('expected to be shared through git');
    expect(forceClaimLine('not-git')).toContain('the other machine is not told');
    expect(forceClaimLine('observe-only')).toContain('only observe the lease');
    expect(forceClaimLine('unknown')).toContain('Could not tell');
  });
});
