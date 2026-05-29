/**
 * Unit tests for ServerSupervisor — preflight self-heal and circuit breaker.
 *
 * Tests:
 * - Preflight detects and aborts stuck git rebase
 * - Preflight skips git heal when no rebase is stuck
 * - shellExec uses SHELL env var instead of hardcoded /bin/sh
 * - Slow retry window is wide enough to not miss retries
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Mock child_process
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] })),
    execFileSync: vi.fn(() => ''),
  };
});

// Mock Config to avoid tmux detection side effects
vi.mock('../../src/core/Config.js', () => ({
  detectTmuxPath: () => '/usr/bin/tmux',
}));

// Mock SleepWakeDetector
vi.mock('../../src/core/SleepWakeDetector.js', () => ({
  SleepWakeDetector: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
  })),
}));

import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  return dir;
}

describe('ServerSupervisor preflight self-heal', () => {
  let tmpDir: string;
  let supervisor: ServerSupervisor;

  beforeEach(() => {
    tmpDir = createTmpDir();
    supervisor = new ServerSupervisor({
      projectDir: tmpDir,
      projectName: 'test-agent',
      port: 9999,
      stateDir: path.join(tmpDir, '.instar'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/server-supervisor-preflight.test.ts:66' }); } catch { /* cleanup */ }
  });

  it('detects and aborts stuck git rebase during preflight', () => {
    const mockExecFileSync = vi.mocked(execFileSync);
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[] | undefined;
      if (cmd === 'git' && argsArr?.[0] === 'status') {
        return 'interactive rebase in progress; onto abc123\n' as any;
      }
      if (cmd === 'git' && argsArr?.[0] === 'rebase' && argsArr?.[1] === '--abort') {
        return '' as any;
      }
      return '' as any;
    });

    // Call preflight via the private method (access for testing)
    const healed = (supervisor as any).preflightSelfHeal();

    expect(healed).toContain('stuck git rebase aborted');

    // Verify git rebase --abort was called
    const abortCalls = mockExecFileSync.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])?.[0] === 'rebase'
    );
    expect(abortCalls.length).toBe(1);
  });

  it('does not abort when no rebase is stuck', () => {
    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const argsArr = args as string[] | undefined;
      if (cmd === 'git' && argsArr?.[0] === 'status') {
        return {
          stdout: 'On branch main\nnothing to commit\n',
          stderr: '', status: 0, signal: null, pid: 0, output: [],
        } as unknown as SpawnSyncReturns<string>;
      }
      return {
        stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [],
      } as unknown as SpawnSyncReturns<string>;
    });

    const healed = (supervisor as any).preflightSelfHeal();

    expect(healed).not.toContain('rebase');

    const abortCalls = mockSpawnSync.mock.calls.filter(
      (call) => call[0] === 'git' && (call[1] as string[])?.[0] === 'rebase'
    );
    expect(abortCalls.length).toBe(0);
  });

  // ── Fleet fix: bind failures must NOT trigger a native-module rebuild ──
  // when better-sqlite3 actually loads fine. A held/duplicate listener.sock or
  // HTTP port (EADDRINUSE) is a bind failure, NOT a native ABI problem — the old
  // code force-rebuilt on >=2 bind failures regardless, producing hundreds of
  // futile CPU-heavy rebuilds across the fleet.
  function seedSqliteCopy(): void {
    const rel = path.join(tmpDir, '.instar', 'shadow-install', 'node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, 'better_sqlite3.node'), 'binary');
    fs.writeFileSync(path.join(tmpDir, '.instar', 'shadow-install', 'node_modules', 'better-sqlite3', 'package.json'), '{"name":"better-sqlite3"}');
  }
  function isRebuildCall(call: any): boolean {
    const args = call[1] as string[] | undefined;
    return Array.isArray(args) && args.includes('rebuild') && args.includes('better-sqlite3');
  }
  // The prebuilt-first attempt is `npm install better-sqlite3[@ver]` (runs
  // prebuild-install). Distinct from the `npm install instar` shadow-restore.
  function isBsqInstallCall(call: any): boolean {
    const args = call[1] as string[] | undefined;
    return Array.isArray(args) && args.includes('install') && args.some((x) => String(x).startsWith('better-sqlite3'));
  }
  function isLoadCheck(call: any): boolean {
    const args = call[1] as string[] | undefined;
    return Array.isArray(args) && args[0] === '-e' && String(args[1] ?? '').includes('require');
  }

  it('does NOT force-rebuild better-sqlite3 on bind failures when the module loads fine', () => {
    seedSqliteCopy();
    (supervisor as any).consecutiveBindFailures = 5; // well past the escalation threshold
    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const a = args as string[] | undefined;
      // The require-load check succeeds → better-sqlite3 is fine.
      if (a?.[0] === '-e') return { stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
      // git status clean, everything else status 0.
      return { stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
    });

    (supervisor as any).preflightSelfHeal();

    const rebuildCalls = mockSpawnSync.mock.calls.filter(isRebuildCall);
    expect(rebuildCalls.length).toBe(0); // the misattribution is gone
    // It still verified the module loads (the load check ran).
    expect(mockSpawnSync.mock.calls.some(isLoadCheck)).toBe(true);
  });

  it('DOES rebuild better-sqlite3 when it actually fails to load (NODE_MODULE_VERSION)', () => {
    seedSqliteCopy();
    (supervisor as any).consecutiveBindFailures = 0; // not a bind-failure scenario at all
    (supervisor as any).findNpmPath = () => '/usr/bin/npm';
    const mockSpawnSync = vi.mocked(spawnSync);
    mockSpawnSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const a = args as string[] | undefined;
      // The require-load check FAILS with an ABI mismatch.
      if (a?.[0] === '-e') {
        return { stdout: '', stderr: 'Error: ... NODE_MODULE_VERSION 115 ... requires 127', status: 1, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
      }
      // npm rebuild + the post-rebuild verify succeed.
      return { stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
    });

    (supervisor as any).preflightSelfHeal();

    const rebuildCalls = mockSpawnSync.mock.calls.filter(isRebuildCall);
    expect(rebuildCalls.length).toBeGreaterThanOrEqual(1); // genuine ABI failure still self-heals
  });

  // ── Fleet fix (2026-05-29, instar-codey sqlite offline 16h): the rebuild must
  // target the SERVER's Node ABI, prefer the prebuilt, and never delete the only
  // binary on a failed compile. ──────────────────────────────────────────────
  function seedServerNode(): string {
    const binDir = path.join(tmpDir, '.instar', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const nodePath = path.join(binDir, 'node');
    fs.writeFileSync(nodePath, '#!/bin/sh\n'); // existence is what matters (checkNode = serverNode)
    return binDir;
  }
  // First `-e require(...)` call = ABI-mismatch DETECTION (fail); later ones =
  // post-rebuild verify. `failVerify` controls whether verify also fails.
  function mockAbiMismatch(failVerify: boolean, onRebuild?: (args: string[]) => void) {
    const mockSpawnSync = vi.mocked(spawnSync);
    let eCalls = 0;
    mockSpawnSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const a = (args as string[] | undefined) ?? [];
      if (a[0] === '-e' && String(a[1] ?? '').includes('require')) {
        eCalls += 1;
        const fail = eCalls === 1 || failVerify; // detection always fails; verify per flag
        return { stdout: '', stderr: fail ? 'NODE_MODULE_VERSION 127 ... requires 141' : '', status: fail ? 1 : 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
      }
      if (Array.isArray(a) && a.includes('rebuild') && a.includes('better-sqlite3') && onRebuild) onRebuild(a);
      return { stdout: '', stderr: '', status: 0, signal: null, pid: 0, output: [] } as unknown as SpawnSyncReturns<string>;
    });
    return mockSpawnSync;
  }

  it('pins the rebuild toolchain PATH to the server Node dir (correct-ABI rebuild)', () => {
    seedSqliteCopy();
    const binDir = seedServerNode();
    (supervisor as any).consecutiveBindFailures = 0;
    (supervisor as any).findNpmPath = () => '/usr/bin/npm';
    const mockSpawnSync = mockAbiMismatch(/*failVerify*/ false); // first attempt heals

    (supervisor as any).preflightSelfHeal();

    const healCall = mockSpawnSync.mock.calls.find(isBsqInstallCall);
    expect(healCall).toBeDefined();
    const env = (healCall![2] as any)?.env as Record<string, string>;
    // Server Node dir must be FIRST on PATH so node-gyp/prebuild-install resolve it.
    expect(env.PATH.split(path.delimiter)[0]).toBe(binDir);
    expect(env.npm_node_execpath).toBe(path.join(binDir, 'node'));
  });

  it('tries the prebuilt (npm install) before compiling from source', () => {
    seedSqliteCopy();
    seedServerNode();
    (supervisor as any).consecutiveBindFailures = 0;
    (supervisor as any).findNpmPath = () => '/usr/bin/npm';
    const mockSpawnSync = mockAbiMismatch(/*failVerify*/ false); // prebuilt attempt verifies OK

    (supervisor as any).preflightSelfHeal();

    const installCalls = mockSpawnSync.mock.calls.filter(isBsqInstallCall);
    const fromSourceCalls = mockSpawnSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('--build-from-source'),
    );
    expect(installCalls.length).toBe(1);     // healed via the prebuilt
    expect(fromSourceCalls.length).toBe(0);  // never fell back to a compile
  });

  it('restores the prior binary if the rebuild cannot produce a loadable module (no-brick)', () => {
    seedSqliteCopy();
    seedServerNode();
    const binaryPath = path.join(tmpDir, '.instar', 'shadow-install', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    (supervisor as any).consecutiveBindFailures = 0;
    (supervisor as any).findNpmPath = () => '/usr/bin/npm';
    // Both attempts "succeed" (status 0) but verify always fails; the
    // from-source attempt DELETES the binary (the real footgun) to prove the
    // restore brings it back.
    mockAbiMismatch(/*failVerify*/ true, (a) => {
      if (a.includes('--build-from-source')) { try { SafeFsExecutor.safeUnlinkSync(binaryPath, { operation: 'test:simulate-bsq-delete' }); } catch { /* ignore */ } }
    });

    (supervisor as any).preflightSelfHeal();

    // The binary must still exist (restored from backup) and the backup cleaned up.
    expect(fs.existsSync(binaryPath)).toBe(true);
    expect(fs.readFileSync(binaryPath, 'utf-8')).toBe('binary');
    expect(fs.existsSync(`${binaryPath}.heal-bak`)).toBe(false);
  });
});

describe('shellExec shell detection', () => {
  it('uses SHELL env var when available', async () => {
    // The shellExec function is module-scoped, so we test it indirectly
    // by verifying the source code uses process.env.SHELL
    const supervisorSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'),
      'utf-8'
    );
    expect(supervisorSource).toContain('process.env.SHELL');
    expect(supervisorSource).not.toMatch(/spawnSync\('\/bin\/sh'/);
  });
});

describe('slow retry window', () => {
  it('uses a 60-second window (not 10s) to avoid missed retries', () => {
    const supervisorSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'),
      'utf-8'
    );
    // Verify the slow retry window is 60_000 (60 seconds), not 10_000
    expect(supervisorSource).toContain('slowElapsed < 60_000');
    expect(supervisorSource).not.toContain('slowElapsed < 10_000');
  });
});

describe('git-terminal-prompt guard on tmux spawn', () => {
  // When the supervisor spawns the server in a new tmux session, git
  // operations performed at startup (auto-pull / git-sync) must NEVER fall
  // through to an interactive terminal prompt — that hangs the bash command
  // behind "Username for 'https://github.com':" and produces a runaway
  // restart loop. The guard is `-e GIT_TERMINAL_PROMPT=0` on the tmux
  // new-session invocation. Source-pattern test (matches the convention of
  // the SHELL-env and slow-retry-window tests above) so we don't have to
  // stub out the full spawn pipeline.
  it('passes -e GIT_TERMINAL_PROMPT=0 to tmux new-session', () => {
    const supervisorSource = fs.readFileSync(
      path.join(process.cwd(), 'src/lifeline/ServerSupervisor.ts'),
      'utf-8'
    );
    expect(supervisorSource).toContain("'-e', 'GIT_TERMINAL_PROMPT=0'");
    // The flag has to live in the new-session args array, not anywhere else.
    const newSessionMatch = supervisorSource.match(
      /'new-session', '-d',[^]+?GIT_TERMINAL_PROMPT=0[^]+?\], \{ stdio: 'ignore' \}/
    );
    expect(newSessionMatch).not.toBeNull();
  });
});
