import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeGitExecutor, SafeGitExecutorError } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';
import { reportLeaseMediumSelection, selectLeaseMedium } from '../../src/core/leaseMediumSelection.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

const dirs: string[] = [];
function repo(): { dir: string; registry: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-medium-'));
  dirs.push(dir);
  SafeGitExecutor.execSync(['init', '-q'], { cwd: dir, stdio: 'ignore', operation: 'tests/unit/leaseMediumSelection.test.ts:init-repo' });
  SafeGitExecutor.execSync(['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore', operation: 'tests/unit/leaseMediumSelection.test.ts:config-email' });
  SafeGitExecutor.execSync(['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore', operation: 'tests/unit/leaseMediumSelection.test.ts:config-name' });
  const registry = path.join(dir, '.instar/machines/registry.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, '{}');
  return { dir, registry };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/leaseMediumSelection.test.ts:cleanup' });
  DegradationReporter.resetForTesting();
});

describe('selectLeaseMedium', () => {
  it('selects git for a tracked registry, including one matching an ignore rule', () => {
    const { dir, registry } = repo();
    SafeGitExecutor.execSync(['add', registry], { cwd: dir, stdio: 'ignore', operation: 'tests/unit/leaseMediumSelection.test.ts:add-registry' });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/machines/\n');
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true }))
      .toEqual({ medium: 'git', reason: 'tracked' });
  });

  it('selects local for an ignored untracked registry', () => {
    const { dir, registry } = repo();
    fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/machines/\n');
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true }))
      .toEqual({ medium: 'local', reason: 'ignored' });
  });

  it('selects git for an untracked addable registry and uses projectDir as cwd', () => {
    const { dir, registry } = repo();
    const old = process.cwd();
    process.chdir(os.tmpdir());
    try {
      expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true }))
        .toEqual({ medium: 'git', reason: 'untracked-addable' });
    } finally { process.chdir(old); }
  });

  it('returns passive reasons when there is no manager or the switch is off', () => {
    const { dir, registry } = repo();
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: false }))
      .toEqual({ medium: 'local', reason: 'no-git-sync-manager' });
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true, mediumCheckEnabled: false }))
      .toEqual({ medium: 'unchecked', reason: 'switch-off' });
  });

  it('maps a missing registry and every specified check error while retaining git', () => {
    const { dir, registry } = repo();
    SafeFsExecutor.safeUnlinkSync(registry, { operation: 'tests/unit/leaseMediumSelection.test.ts:remove-registry' });
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true }).reason)
      .toBe('check-error:registry-missing');
    fs.writeFileSync(registry, '{}');
    const cases: Array<[unknown, string]> = [
      [new SafeGitExecutorError('no'), 'check-error:refused'],
      [new SourceTreeGuardError(dir, dir, 'test'), 'check-error:refused'],
      [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'check-error:timeout'],
      [Object.assign(new Error('exit'), { status: 7 }), 'check-error:git-exit-7'],
      [Object.assign(new Error('signal'), { signal: 'SIGTERM' }), 'check-error:signal-SIGTERM'],
      [Object.assign(new Error('spawn'), { code: 'ENOENT' }), 'check-error:spawn-error'],
    ];
    for (const [error, reason] of cases) {
      expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true, readGit: () => { throw error; } }))
        .toEqual({ medium: 'git', reason });
    }
  });

  it('maps an error from the ignored query and invokes both reads with a 2s timeout', () => {
    const { dir, registry } = repo();
    const calls: Array<{ args: readonly string[]; cwd: string; timeout: number }> = [];
    const readGit = (args: readonly string[], opts: { cwd: string; timeout: number }) => {
      calls.push({ args, cwd: opts.cwd, timeout: opts.timeout });
      if (calls.length === 1) throw Object.assign(new Error('untracked'), { status: 1 });
      throw Object.assign(new Error('boom'), { status: 9 });
    };
    expect(selectLeaseMedium({ projectDir: dir, registryAbsPath: registry, hasGitSyncManager: true, readGit }).reason)
      .toBe('check-error:git-exit-9');
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.cwd === dir && call.timeout === 2_000)).toBe(true);
  });

  it('reports ignored exactly once with peers, but only logs without peers', () => {
    const reporter = DegradationReporter.getInstance();
    const logs: string[] = [];
    reportLeaseMediumSelection({ medium: 'local', reason: 'ignored' }, 0, reporter, (m) => logs.push(m));
    expect(reporter.getEvents()).toHaveLength(0);
    expect(logs[0]).toContain('git-ignored');
    reportLeaseMediumSelection({ medium: 'local', reason: 'ignored' }, 2, reporter);
    const events = reporter.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].reason).toContain('local store plus the network (a supported mode)');
    expect(events[0].reason).toContain('tracking the file and restarting');
  });

  it('reports one check-error degradation naming its mapped kind and restart re-check', () => {
    const reporter = DegradationReporter.getInstance();
    reportLeaseMediumSelection({ medium: 'git', reason: 'check-error:timeout' }, 1, reporter);
    const events = reporter.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: 'multiMachine.leaseMedium', fallback: "GitLeaseStore (today's behavior)" });
    expect(events[0].reason).toContain('timeout');
    expect(events[0].reason).toContain('will be re-checked at the next restart');
  });
});
