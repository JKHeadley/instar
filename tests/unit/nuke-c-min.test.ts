// safe-git-allow: test-tmpdir-cleanup — afterEach removes this test's own mkdtemp sandbox HOME only.
/**
 * Unit tests for `instar nuke --here` — project-local install teardown.
 *
 * Tier 1 (unit): exercises the decision functions and the filesystem
 * half of nukeHere against a tmpdir.
 *
 * SANDBOX (docs/specs/nuke-teardown-narrowing.md Testing): tmux answers "no
 * server running" and launchctl/systemctl answer "not loaded" from a mock of
 * `node:child_process` (git still runs for real, in tmp dirs); ./setup.js,
 * SecretManager, AgentRegistry and standaloneAgentsDir are mocked; HOME is a
 * temp folder; the project name starts with `zz-`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const sandbox = vi.hoisted(() => ({ home: '', confirm: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ confirm: sandbox.confirm }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const fail = (msg: string, status: number) => Object.assign(new Error(msg), { stderr: Buffer.from(msg + '\n'), status });
  const fake = (cmd: string, args: string[] = [], opts?: unknown) => {
    if (cmd === 'tmux') throw fail('no server running on /private/tmp/tmux-501/default', 1);
    if (cmd === 'launchctl') throw fail('Could not find service "x" in domain for user gui: 501', 113);
    if (cmd === 'systemctl') {
      const out = 'LoadState=not-found\nActiveState=inactive\nWorkingDirectory=\nExecStart=\nNeedDaemonReload=no\n';
      return (opts as { encoding?: string } | undefined)?.encoding ? out : Buffer.from(out);
    }
    if (cmd === 'plutil') throw new Error('sandbox: plutil must not run');
    return (real.execFileSync as unknown as (...a: unknown[]) => unknown)(cmd, args, opts);
  };
  return { ...real, default: { ...real, execFileSync: fake }, execFileSync: fake };
});
vi.mock('../../src/commands/setup.js', () => ({ uninstallAutoStart: vi.fn(() => false) }));
vi.mock('../../src/core/SecretManager.js', () => ({
  SecretManager: class { initialize() {} backupFromConfig() {} },
  SECRET_KEYS: {},
}));
vi.mock('../../src/core/AgentRegistry.js', () => ({ unregisterAgent: vi.fn() }));
vi.mock('../../src/core/Config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/Config.js')>();
  return { ...real, standaloneAgentsDir: () => path.join(sandbox.home, '.instar', 'agents') };
});


import { nukeHere, nukeAgent } from '../../src/commands/nuke.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { git, install, seedKept, snapshot, keptNames, reviewNotice, backupNotice } from '../helpers/nuke-c-min.js';

let saved: NodeJS.ProcessEnv;
let logs: string[];
beforeEach(() => {
  saved = { ...process.env };
  sandbox.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-cmin-')));
  process.env.HOME = sandbox.home;
  process.env.INSTAR_AUDIT_LOG_DIR = path.join(sandbox.home, 'audit');
  delete process.env.INSTAR_TEST_REGISTRY_DIR;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
  sandbox.confirm.mockReset().mockResolvedValue(true);
  vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error(logs.join('\n')); }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(sandbox.home, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
});
function project(): string {
  const dir = path.join(sandbox.home, 'project');
  install(dir);
  return dir;
}
function agent(): string {
  const dir = path.join(sandbox.home, '.instar/agents/zz-cmin');
  install(dir);
  git(dir, 'init', '-q');
  return dir;
}

describe('C-min project preservation', () => {
  it.each(['no-git', 'untracked', 'clean', 'staged', 'unstaged', 'git-error'])('keeps all eight paths byte-identical: %s', async mode => {
    const dir = project();
    seedKept(dir);
    if (mode !== 'no-git') git(dir, 'init', '-q');
    if (['clean', 'staged', 'unstaged'].includes(mode)) {
      git(dir, 'add', ...keptNames); git(dir, 'commit', '-qm', 'existing');
      if (mode !== 'clean') {
        for (const name of keptNames) fs.appendFileSync(path.join(dir, ['.claude', '.codex'].includes(name) ? `${name}/hooks/user` : name), 'dirty');
        if (mode === 'staged') git(dir, 'add', ...keptNames);
      }
    }
    const before = snapshot(dir);
    const index = path.join(dir, '.git/index');
    const indexBefore = fs.existsSync(index) ? fs.readFileSync(index) : undefined;
    const reads = vi.spyOn(SafeGitExecutor, 'readSync');
    if (mode === 'git-error') reads.mockImplementation(() => { throw new Error('git unavailable'); });
    const writes = vi.spyOn(SafeGitExecutor, 'execSync');
    const deletes = vi.spyOn(SafeFsExecutor, 'safeRmSync');
    await nukeHere({ dir, skipConfirm: true });
    expect(snapshot(dir)).toEqual(before);
    if (indexBefore) expect(fs.readFileSync(index)).toEqual(indexBefore);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(deletes.mock.calls.map(([p]) => p)).toEqual([path.join(dir, '.instar')]);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(false);
    expect(logs.filter(l => l.includes(reviewNotice))).toHaveLength(2);
    for (const name of keptNames) expect(logs.filter(l => l === `  - ${name}`)).toHaveLength(2);
  });
  it.each([false, true])('keeps ordinary and dangling links without touching targets (dangling=%s)', async dangling => {
    const dir = project();
    const outside = path.join(sandbox.home, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'user'), 'outside bytes');
    for (const name of keptNames) fs.symlinkSync(dangling ? path.join(outside, 'missing') : outside, path.join(dir, name));
    const before = snapshot(dir);
    await nukeHere({ dir, skipConfirm: true });
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(outside, 'user'), 'utf8')).toBe('outside bytes');
    for (const name of keptNames) expect(logs.filter(l => l === `  - ${name}`)).toHaveLength(2);
  });
  it('does not create missing kept paths', async () => {
    const dir = project();
    await nukeHere({ dir, skipConfirm: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('reports unknown metadata without writing or refusing', async () => {
    const dir = project(); seedKept(dir);
    const before = snapshot(dir);
    const original = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...args: unknown[]) => {
      if (p === path.join(dir, 'CLAUDE.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (original as Function)(p, ...args);
    }) as typeof fs.lstatSync);
    await nukeHere({ dir, skipConfirm: true });
    spy.mockRestore();
    expect(snapshot(dir)).toEqual(before);
    expect(logs.filter(l => l.includes('CLAUDE.md (presence unknown; left untouched)'))).toHaveLength(2);
  });
  it('repeats the kept notice after a deletion failure', async () => {
    const dir = project(); seedKept(dir);
    const before = snapshot(dir);
    vi.spyOn(SafeFsExecutor, 'safeRmSync').mockImplementation(() => { throw new Error('delete denied'); });
    await expect(nukeHere({ dir, skipConfirm: true })).rejects.toThrow('delete denied');
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(true);
    expect(logs.filter(l => l.includes(reviewNotice))).toHaveLength(2);
    expect(logs.join('\n')).toContain('was NOT fully removed');
    expect(logs.join('\n')).not.toContain('has been removed');
  });
  it('prints kept paths and review offer before confirmation; cancel preserves everything', async () => {
    const dir = project(); seedKept(dir);
    sandbox.confirm.mockImplementation(async () => {
      expect(logs.join('\n')).toContain(reviewNotice);
      for (const name of keptNames) expect(logs).toContain(`  - ${name}`);
      return false;
    });
    const before = snapshot(dir);
    await nukeHere({ dir });
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(true);
  });
});

describe('C-min existing commits only', () => {
  it.each(['success', 'failure', 'status-error'])('does not stage/commit; preserves push arguments and nonfatal policy: %s', async outcome => {
    const dir = agent();
    const read = vi.spyOn(SafeGitExecutor, 'readSync').mockImplementation(args => {
      if (args[0] === 'remote') return 'origin\n';
      if (outcome === 'status-error') throw new Error('status unavailable');
      return ' M dirty\nA  staged\n?? untracked\n';
    });
    const write = vi.spyOn(SafeGitExecutor, 'execSync').mockImplementation(() => {
      if (outcome === 'failure') throw new Error('push unavailable');
      return '';
    });
    await nukeAgent('zz-cmin', { skipConfirm: true });
    expect(read).toHaveBeenCalledWith(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'], expect.objectContaining({ cwd: dir }));
    expect(write.mock.calls).toEqual([[['push'], { cwd: dir, stdio: 'pipe', timeout: 30_000, operation: 'src/commands/nuke.ts:160' }]]);
    expect(logs.join('\n')).toContain(backupNotice);
    expect(logs.join('\n')).toContain(outcome === 'status-error' ? 'Could not check for uncommitted changes' : 'Uncommitted changes are present.');
    const wording = outcome === 'failure' ? 'Could not push existing commits' : 'Git push succeeded';
    expect(logs.at(-2)).toContain(`${wording}. Uncommitted changes are NOT in the backup.`);
    expect(logs.join('\n')).not.toMatch(/final backup|cloud backup|snapshot/);
    if (outcome === 'failure') expect(logs.join('\n')).not.toContain('Git push succeeded');
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('always prints backup limits even without Git and with confirmation skipped', async () => {
    const dir = path.join(sandbox.home, '.instar/agents/zz-cmin'); install(dir);
    const read = vi.spyOn(SafeGitExecutor, 'readSync');
    const write = vi.spyOn(SafeGitExecutor, 'execSync');
    await nukeAgent('zz-cmin', { skipConfirm: true });
    expect(logs.join('\n')).toContain(backupNotice);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
  });
  it('warns on untracked-only changes despite config; cancellation leaves stale index bytes unchanged', async () => {
    const dir = agent();
    fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n');
    git(dir, 'add', '.gitignore'); git(dir, 'commit', '-qm', 'seed');
    git(dir, 'config', 'status.showUntrackedFiles', 'no');
    fs.utimesSync(path.join(dir, '.gitignore'), new Date(0), new Date(0));
    fs.writeFileSync(path.join(dir, 'untracked'), 'not backed up');
    const index = fs.readFileSync(path.join(dir, '.git/index'));
    sandbox.confirm.mockImplementation(async () => {
      expect(logs.join('\n')).toContain(backupNotice);
      expect(logs.join('\n')).toContain('Uncommitted changes are present.');
      return false;
    });
    await nukeAgent('zz-cmin');
    expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(index);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
