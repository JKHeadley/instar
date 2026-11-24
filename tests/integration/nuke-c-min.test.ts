// safe-git-allow: test-tmpdir-cleanup — afterEach removes this test's own mkdtemp sandbox HOME only.
/**
 * Sandboxed integration tests for `instar nuke --here` — project-local install teardown.
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

describe('C-min real filesystem and Git integration', () => {
  it.each([false, true])('preserves bytes, directory contents, external links and index (git=%s)', async withGit => {
    const dir = project(); seedKept(dir);
    const target = path.join(sandbox.home, 'external');
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'data'), 'outside');
    fs.symlinkSync(target, path.join(dir, '.claude/hooks/link'));
    fs.symlinkSync(path.join(target, 'absent'), path.join(dir, '.codex/dangling'));
    if (withGit) {
      git(dir, 'init', '-q'); git(dir, 'add', ...keptNames); git(dir, 'commit', '-qm', 'seed');
      fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'staged'); git(dir, 'add', 'CLAUDE.md');
      fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'unstaged');
    }
    const before = snapshot(dir);
    const index = withGit ? fs.readFileSync(path.join(dir, '.git/index')) : undefined;
    await nukeHere({ dir, skipConfirm: true });
    expect(snapshot(dir)).toEqual(before);
    if (index) expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(index);
    expect(fs.readFileSync(path.join(target, 'data'), 'utf8')).toBe('outside');
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(false);
    expect(logs.filter(l => l.includes(reviewNotice))).toHaveLength(2);
  });
  it('keeps the pre-teardown scope refusal', async () => {
    const dir = project(); seedKept(dir);
    const before = snapshot(dir);
    vi.spyOn(SafeFsExecutor, 'checkScope').mockReturnValue({ allowed: false, canonical: dir, reason: 'fixture refusal', error: new Error('fixture refusal') });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(nukeHere({ dir, skipConfirm: true })).rejects.toThrow('exit');
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, '.instar'))).toBe(true);
  });
  it('pushes the existing commit only to a local bare remote', async () => {
    const dir = agent();
    const remote = path.join(sandbox.home, 'remote.git');
    git(sandbox.home, 'init', '--bare', remote);
    fs.writeFileSync(path.join(dir, 'tracked'), 'committed');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/\n');
    git(dir, 'add', 'tracked', '.gitignore'); git(dir, 'commit', '-qm', 'existing');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-u', 'origin', 'HEAD');
    fs.writeFileSync(path.join(dir, 'tracked'), 'second committed');
    git(dir, 'add', 'tracked'); git(dir, 'commit', '-qm', 'existing unpushed');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    const branch = git(dir, 'branch', '--show-current').trim();
    fs.writeFileSync(path.join(dir, 'tracked'), 'staged'); git(dir, 'add', 'tracked');
    fs.writeFileSync(path.join(dir, 'tracked'), 'unstaged');
    fs.writeFileSync(path.join(dir, 'untracked'), 'untracked');
    await nukeAgent('zz-cmin', { skipConfirm: true });
    expect(git(remote, 'rev-parse', branch).trim()).toBe(head);
    expect(git(remote, 'show', `${branch}:tracked`)).toBe('second committed');
    expect(git(remote, 'ls-tree', '-r', '--name-only', branch)).not.toContain('untracked');
    expect(git(remote, 'rev-list', '--count', branch).trim()).toBe('2');
    expect(fs.existsSync(dir)).toBe(false);
    expect(logs.join('\n')).toContain('Git push succeeded. Uncommitted changes are NOT in the backup.');
  });
});
