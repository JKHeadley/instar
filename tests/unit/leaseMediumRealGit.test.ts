import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import { GitSyncManager, type GitSyncConfig } from '../../src/core/GitSync.js';
import { selectLeaseMedium } from '../../src/core/leaseMediumSelection.js';
import type { LeaseRecord, MachineRegistry } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

function git(cwd: string, args: string[]): string {
  const readOnly = args.includes('ls-files') || args.includes('ls-tree');
  const options = { cwd, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], operation: 'tests/unit/leaseMediumRealGit.test.ts:git-fixture' };
  return (readOnly ? SafeGitExecutor.readSync(args, options) : SafeGitExecutor.execSync(args, options)).trim();
}

describe('lease medium selection with the real GitLeaseStore commit path', () => {
  let root: string;
  let work: string;
  let bare: string;
  let registryPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-medium-real-git-'));
    work = path.join(root, 'work');
    bare = path.join(root, 'remote.git');
    git(root, ['init', '--bare', '-b', 'main', bare]);
    git(root, ['init', '-b', 'main', work]);
    git(work, ['config', 'user.email', 'test@instar.local']);
    git(work, ['config', 'user.name', 'test']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(work, 'seed.txt'), 'seed');
    git(work, ['add', 'seed.txt']);
    git(work, ['commit', '-m', 'seed']);
    git(work, ['remote', 'add', 'origin', bare]);
    git(work, ['push', '-u', 'origin', 'main']);
    registryPath = path.join(work, '.instar/machines/registry.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const registry: MachineRegistry = { version: 1, machines: { self: { machineId: 'self' } as never } };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  });

  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/leaseMediumRealGit.test.ts:cleanup' }));

  function manager(): GitSyncManager {
    const config: GitSyncConfig = {
      projectDir: work,
      stateDir: path.join(work, '.instar'),
      identityManager: { registryPath, loadRegistry: load, saveRegistry: save, loadRemoteIdentity: () => null } as never,
      securityLog: { append: () => {}, query: () => [], getPath: () => path.join(work, '.instar/security.jsonl') } as never,
      machineId: 'self',
      autoPush: true,
    };
    return new GitSyncManager(config);
  }
  const load = (): MachineRegistry => JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MachineRegistry;
  const save = (registry: MachineRegistry): void => fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  it('keeps an untracked addable registry on git and its first lease write commits it to the bare remote', () => {
    const selected = selectLeaseMedium({ projectDir: work, registryAbsPath: registryPath, hasGitSyncManager: true });
    expect(selected).toEqual({ medium: 'git', reason: 'untracked-addable' });
    const sync = manager();
    const store = new GitLeaseStore({
      machineId: 'self', loadRegistry: load, saveRegistry: save, registryAbsPath: registryPath,
      pullRebase: () => sync.pullRebase(), commitAndPush: (message, paths) => sync.commitAndPush(message, paths),
    });
    const lease: LeaseRecord = {
      holder: 'self', epoch: 1, acquiredAt: new Date(0).toISOString(),
      expiresAt: new Date(60_000).toISOString(), signature: 'test', nonce: 1,
    };
    expect(store.casWrite(lease).ok).toBe(true);
    expect(git(work, ['ls-files', '--error-unmatch', '--', registryPath])).toContain('.instar/machines/registry.json');
    const remoteFiles = git(root, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main']);
    expect(remoteFiles).toContain('.instar/machines/registry.json');
  });

  it('freezes the tracked decision for the process when the registry leaves the index', () => {
    git(work, ['add', registryPath]);
    git(work, ['commit', '-m', 'track registry']);
    git(work, ['push']);
    const bootDecision = selectLeaseMedium({ projectDir: work, registryAbsPath: registryPath, hasGitSyncManager: true });
    expect(bootDecision).toEqual({ medium: 'git', reason: 'tracked' });
    git(work, ['rm', '--cached', registryPath]);
    git(work, ['commit', '-m', 'remove registry from index']);
    expect(bootDecision).toEqual({ medium: 'git', reason: 'tracked' });
    expect(selectLeaseMedium({ projectDir: work, registryAbsPath: registryPath, hasGitSyncManager: true }))
      .toEqual({ medium: 'git', reason: 'untracked-addable' });
  });
});
