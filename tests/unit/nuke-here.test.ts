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

const sandbox = vi.hoisted(() => ({ home: '' }));

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

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['HOME', 'INSTAR_TEST_REGISTRY_DIR']) savedEnv[k] = process.env[k];
  sandbox.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-nuke-here-home-')));
  process.env.HOME = sandbox.home;
  delete process.env.INSTAR_TEST_REGISTRY_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  SafeFsExecutor.safeRmSync(sandbox.home, { recursive: true, force: true, operation: 'tests/unit/nuke-here.test.ts:cleanup' });
});

import {
  nukeHere,
  classifyShadowFile,
  isInstarSourceRepo,
} from '../../src/commands/nuke.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpRm(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/nuke-here.test.ts:tmpRm',
  });
}

function gitInit(dir: string): void {
  SafeGitExecutor.execSync(['init', '-q'], { cwd: dir, stdio: 'pipe', operation: 'tests/unit/nuke-here.test.ts:gitInit' });
  SafeGitExecutor.execSync(['config', 'user.email', 't@instar.test'], { cwd: dir, stdio: 'pipe', operation: 'tests/unit/nuke-here.test.ts:gitConfigEmail' });
  SafeGitExecutor.execSync(['config', 'user.name', 'fixture'], { cwd: dir, stdio: 'pipe', operation: 'tests/unit/nuke-here.test.ts:gitConfigName' });
}

function gitCommitAll(dir: string, msg: string): void {
  SafeGitExecutor.execSync(['add', '-A'], { cwd: dir, stdio: 'pipe', operation: 'tests/unit/nuke-here.test.ts:gitAdd' });
  SafeGitExecutor.execSync(['commit', '-q', '-m', msg], { cwd: dir, stdio: 'pipe', operation: 'tests/unit/nuke-here.test.ts:gitCommit' });
}

function seedInstall(dir: string, projectName = 'zz-testproj'): void {
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.instar', 'config.json'),
    JSON.stringify({ projectName, port: 4040, authToken: 'x' }),
  );
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
}

describe('isInstarSourceRepo', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('nuke-here-src-'); });
  afterEach(() => { tmpRm(tmp); });

  it('returns false for a plain project directory', () => {
    expect(isInstarSourceRepo(tmp)).toBe(false);
  });

  it('returns false when package.json exists but name is not "instar"', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'something-else' }));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'cli.ts'), '');
    expect(isInstarSourceRepo(tmp)).toBe(false);
  });

  it('returns false when name is "instar" but src/cli.ts is absent', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'instar' }));
    expect(isInstarSourceRepo(tmp)).toBe(false);
  });

  it('returns true only when BOTH conditions hold', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'instar' }));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'cli.ts'), '');
    expect(isInstarSourceRepo(tmp)).toBe(true);
  });
});

describe('classifyShadowFile', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('nuke-here-shadow-'); });
  afterEach(() => { tmpRm(tmp); });

  it('returns "delete" when there is no .git directory', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# instar-created\n');
    expect(classifyShadowFile(tmp, 'CLAUDE.md', false)).toBe('delete');
  });

  it('returns "delete" when the file is untracked in a git repo', () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'seed\n');
    gitCommitAll(tmp, 'seed');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# instar-created\n');
    expect(classifyShadowFile(tmp, 'CLAUDE.md', true)).toBe('delete');
  });

  it('returns "keep" when the file is tracked at HEAD with no working-tree diff', () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing project context\n');
    gitCommitAll(tmp, 'add CLAUDE.md');
    expect(classifyShadowFile(tmp, 'CLAUDE.md', true)).toBe('keep');
  });

  it('returns "restore" when the tracked file has a working-tree diff (instar modified)', () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n');
    gitCommitAll(tmp, 'add CLAUDE.md');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n\n## instar additions\n');
    expect(classifyShadowFile(tmp, 'CLAUDE.md', true)).toBe('restore');
  });
});

describe('nukeHere — filesystem teardown', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('nuke-here-fs-'); });
  afterEach(() => { tmpRm(tmp); });

  it('exits non-zero when .instar/config.json is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(nukeHere({ dir: tmp, skipConfirm: true })).rejects.toThrow(/exit:1/);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('refuses to run inside the instar source repo', async () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'instar' }));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'cli.ts'), '');
    seedInstall(tmp);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(nukeHere({ dir: tmp, skipConfirm: true })).rejects.toThrow(/exit:1/);
      // .instar/ must NOT be removed by the refusal path
      expect(fs.existsSync(path.join(tmp, '.instar', 'config.json'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('removes always-remove artifacts in a non-git project', async () => {
    seedInstall(tmp);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# instar-created\n');
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, '.instar'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false);
  });

  it('keeps a pre-existing git-tracked CLAUDE.md', async () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n');
    gitCommitAll(tmp, 'seed');
    seedInstall(tmp);
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, '.instar'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')).toBe('# pre-existing\n');
  });

  it('restores a git-tracked CLAUDE.md that instar modified', async () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n');
    gitCommitAll(tmp, 'seed');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# pre-existing\n\n## instar appended\n');
    seedInstall(tmp);
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf-8')).toBe('# pre-existing\n');
  });

  it('deletes an untracked CLAUDE.md (instar created)', async () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'seed\n');
    gitCommitAll(tmp, 'seed');
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# instar-created\n');
    seedInstall(tmp);
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(false);
  });

  it('deletes an instar-created .gitignore in a non-git project', async () => {
    seedInstall(tmp);
    fs.writeFileSync(path.join(tmp, '.gitignore'), '.instar/state/\n');
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(false);
  });

  it('keeps a pre-existing git-tracked .gitignore', async () => {
    gitInit(tmp);
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/\n');
    gitCommitAll(tmp, 'seed');
    seedInstall(tmp);
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, '.gitignore'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf-8')).toBe('node_modules/\n');
  });

  it('leaves NO .instar/ directory behind (audit-log carryover regression)', async () => {
    // Repro: pre-fix, the SafeFsExecutor audit log inside .instar/audit/
    // got recreated AFTER nuke deleted .instar/ because subsequent destructive
    // ops wrote audit entries to the now-absent .instar/audit/ path. The fix
    // reorders teardown so .instar is LAST and suppresses audit logging
    // during its delete. This test pins that behavior.
    seedInstall(tmp);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# instar-created\n');
    fs.writeFileSync(path.join(tmp, 'GEMINI.md'), '# instar-created\n');
    await nukeHere({ dir: tmp, skipConfirm: true });
    expect(fs.existsSync(path.join(tmp, '.instar'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, '.instar', 'audit'))).toBe(false);
  });
});

