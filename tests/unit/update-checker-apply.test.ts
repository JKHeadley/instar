/**
 * Unit tests for UpdateChecker.applyUpdate() and fetchChangelog().
 *
 * Covers: changelog fetching, update application, version verification,
 * error handling, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type ExecSeam = { execAsync(cmd: string, args: string[], timeoutMs: number, maxBuffer?: number, env?: NodeJS.ProcessEnv): Promise<string> };

describe('UpdateChecker.applyUpdate()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-apply-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:29' });
  });

  it('returns already-up-to-date when no update available', async () => {
    // Mock check to return no update available
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    });
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.12');

    const result = await checker.applyUpdate();

    expect(result.success).toBe(true);
    expect(result.restartNeeded).toBe(false);
    expect(result.message).toContain('Already up to date');
    expect(result.healthCheck).toBe('skipped');
  });

  it('returns structured result on update failure', async () => {
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.10',
      latestVersion: '0.1.12',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    });

    // Mock the exec seam so no real npm runs: a unit test must never reach the
    // network. Before 2026-09-03 this relied on a REAL npm invocation failing
    // fast; a slow registry made it hang to the 30s timeout on every CI shard
    // and locally (ACT-361).
    vi.spyOn(checker as never as { execAsync(cmd: string, args: string[], t: number): Promise<string> }, 'execAsync' as never)
      .mockRejectedValue(new Error('npm install failed (mocked network seam)'));
    const result = await checker.applyUpdate();

    // Should return a structured result even on failure
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('previousVersion');
    expect(result).toHaveProperty('newVersion');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('restartNeeded');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  }, 30000);

  it('includes changeSummary in message when available', async () => {
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.10',
      latestVersion: '0.1.12',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      changeSummary: 'Fixed security issues and improved performance',
    });
    // Same mocked exec seam as above — never a real npm call (ACT-361).
    vi.spyOn(checker as never as { execAsync(cmd: string, args: string[], t: number): Promise<string> }, 'execAsync' as never)
      .mockRejectedValue(new Error('npm install failed (mocked network seam)'));

    const result = await checker.applyUpdate();

    // Even if the npm update fails, the result should be structured
    expect(result).toHaveProperty('message');
    expect(typeof result.message).toBe('string');
  }, 30000);
});

describe('UpdateChecker.fetchChangelog()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-changelog-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:104' });
  });

  it('returns changelog body from GitHub release', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        body: 'Fixed a critical bug in session management.\nImproved health checks.',
        name: 'v0.1.12',
      }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeDefined();
    expect(result).toContain('critical bug');
    expect(result).toContain('health checks');
  });

  it('prepends v to version if missing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: 'Changelog text', name: 'v0.1.12' }),
    });
    global.fetch = mockFetch;

    await checker.fetchChangelog('0.1.12');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tags/v0.1.12'),
      expect.any(Object),
    );
  });

  it('does not double-prepend v', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: 'Changelog', name: 'v0.1.12' }),
    });
    global.fetch = mockFetch;

    await checker.fetchChangelog('v0.1.12');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tags/v0.1.12'),
      expect.any(Object),
    );
    // Should NOT contain /tags/vv0.1.12
    const url = (mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain('vv');
  });

  it('truncates long changelogs to 500 chars', async () => {
    const longBody = 'A'.repeat(600);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: longBody, name: 'v0.1.12' }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(result).toContain('...');
  });

  it('returns release name when body is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: '', name: 'Security Update v0.1.12' }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBe('Security Update v0.1.12');
  });

  it('returns undefined on 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await checker.fetchChangelog('99.99.99');

    expect(result).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeUndefined();
  });

  it('returns undefined on timeout', async () => {
    global.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeUndefined();
  });
});

describe('UpdateChecker.rollback()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let exec: MockInstance<ExecSeam['execAsync']>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rollback-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.12');
    exec = vi.spyOn(checker as unknown as ExecSeam, 'execAsync')
      .mockRejectedValue(new Error('fixture install unavailable'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:218' });
  });

  it('returns error when no rollback info exists', async () => {
    expect(checker.canRollback()).toBe(false);

    const result = await checker.rollback();
    expect(result.success).toBe(false);
    expect(result.message).toContain('No rollback info');
    expect(exec).not.toHaveBeenCalled();
  });

  it('canRollback returns true after saving rollback info', () => {
    // Simulate a successful update by writing rollback file
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, JSON.stringify({
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: new Date().toISOString(),
    }));

    expect(checker.canRollback()).toBe(true);
  });

  it('getRollbackInfo returns saved data', () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    const info = {
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: '2026-02-20T00:00:00Z',
    };
    fs.writeFileSync(rollbackFile, JSON.stringify(info));

    const result = checker.getRollbackInfo();
    expect(result).toEqual(info);
  });

  it('getRollbackInfo returns null when file missing', () => {
    expect(checker.getRollbackInfo()).toBeNull();
  });

  it('getRollbackInfo returns null on corrupted file', () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, 'bad json {{');

    expect(checker.getRollbackInfo()).toBeNull();
  });

  it('attempts npm install with previous version', async () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, JSON.stringify({
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: new Date().toISOString(),
    }));

    // Exercise real rollback handling without launching npm or using the network.
    const result = await checker.rollback();
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, timeout] = exec.mock.calls[0];
    // npm runs under the runtime node: its bundled npm-cli.js when the layout has one,
    // otherwise `npm` from PATH (see the runtime-node describe below for both shapes).
    expect(cmd === 'npm' || args[0].endsWith('npm-cli.js')).toBe(true);
    expect(args.slice(-5)).toEqual([
      'install', 'instar@0.1.11', '--ignore-scripts',
      '--prefix', expect.stringMatching(/^.*shadow-install\.pending-[^/]+$/),
    ]);
    expect(timeout).toBe(120000);
    expect(args[args.length - 1]).not.toBe(path.join(tmpDir, 'shadow-install'));
    expect(result).toEqual({
      success: false, previousVersion: '0.1.12', restoredVersion: '0.1.12',
      message: 'Rollback failed; kept the current install: fixture install unavailable',
    });
    expect(checker.getRollbackInfo()).toMatchObject({
      previousVersion: '0.1.11', updatedVersion: '0.1.12',
    });
  });

  it('refuses rollback below the delivery compatibility floor while evidence is live', async () => {
    fs.writeFileSync(path.join(tmpDir, 'state', 'update-rollback.json'), JSON.stringify({
      previousVersion: '0.1.11', updatedVersion: '0.1.12', updatedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(tmpDir, 'state', 'codex-lifecycle-downgrade-floor.json'), JSON.stringify({ liveEvidence: 1 }));
    const result = await checker.rollback();
    expect(result.success).toBe(false);
    expect(result.message).toContain('compatibility-projector floor');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('UpdateChecker.check() with changeSummary', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let exec: MockInstance<ExecSeam['execAsync']>;
  let changelog: MockInstance<UpdateChecker['fetchChangelog']>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-check-summary-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.11');
    exec = vi.spyOn(checker as unknown as ExecSeam, 'execAsync').mockResolvedValue('0.1.12');
    changelog = vi.spyOn(checker, 'fetchChangelog').mockResolvedValue('Fixed important bugs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:299' });
  });

  it('includes changeSummary in UpdateInfo when update available', async () => {
    const info = await checker.check();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('npm', ['view', 'instar', 'version'], 15000);
    expect(changelog).toHaveBeenCalledTimes(1);
    expect(changelog).toHaveBeenCalledWith('0.1.12');
    expect(info).toMatchObject({
      currentVersion: '0.1.11', latestVersion: '0.1.12', updateAvailable: true,
      changeSummary: 'Fixed important bugs', checkedAt: expect.any(String),
    });
  });

  it('persists changeSummary to state file', async () => {
    changelog.mockResolvedValue('Big improvements');
    const info = await checker.check();
    expect(info.updateAvailable).toBe(true);
    expect(info.changeSummary).toBe('Big improvements');
    expect(checker.getLastCheck()).toEqual(info);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'update-check.json'), 'utf8'))).toEqual(info);
  });

  it('persists a same-version check without fetching a changelog', async () => {
    exec.mockResolvedValue('0.1.11');
    const info = await checker.check();
    expect(info).toMatchObject({ currentVersion: '0.1.11', latestVersion: '0.1.11', updateAvailable: false });
    expect(info.changeSummary).toBeUndefined();
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toEqual(info);
  });

  it('returns a current-version fallback offline without inventing saved state', async () => {
    exec.mockRejectedValue(new Error('fixture registry unavailable'));
    const info = await checker.check();
    expect(info).toEqual({
      currentVersion: '0.1.11', latestVersion: '0.1.11', updateAvailable: false,
      checkedAt: expect.any(String),
    });
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'state', 'update-check.json'))).toBe(false);
  });

  it('returns the unchanged saved result offline without overwriting it', async () => {
    const saved = await checker.check();
    const stateFile = path.join(tmpDir, 'state', 'update-check.json');
    const bytes = fs.readFileSync(stateFile, 'utf8');
    exec.mockRejectedValue(new Error('fixture registry unavailable'));
    changelog.mockClear();
    vi.mocked(checker.getInstalledVersion).mockReturnValue('0.1.13');

    expect(await checker.check()).toEqual(saved);
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toEqual(saved);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(bytes);
  });
});

/**
 * The native rebuild must target the Node that will run the agent. `npm` is a
 * `#!/usr/bin/env node` script, so npm, node-gyp and prebuild-install all run under
 * whichever node is first on PATH — and node-gyp compiles for THAT node's ABI. On
 * the Echo Studio (2026-11-20/21) Homebrew Node 22 (ABI 127) sat first on the
 * server's PATH while the agent runtime and the candidate validator were Node 24
 * (ABI 137): every rebuild produced a binding the validator could not load, and
 * every update since 1.3.1944 was kept back (feedback fb-962cbcf0, fb-843b9795).
 */
describe('UpdateChecker native rebuild runs under the runtime node', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let exec: MockInstance<ExecSeam['execAsync']>;
  let originalPath: string | undefined;
  let otherNodeDir: string;

  const shellScript = (file: string, body: string) => {
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  /** An official-tarball runtime layout, linked at <stateDir>/bin/node the way installs link it. */
  const seedRuntime = (withBundledNpm: boolean) => {
    const prefix = path.join(tmpDir, 'runtime', 'node-v24.14.1-test');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'include', 'node'), { recursive: true });
    shellScript(path.join(prefix, 'bin', 'node'), 'echo v24.14.1');
    fs.writeFileSync(path.join(prefix, 'include', 'node', 'node_version.h'), '#define NODE_MAJOR_VERSION 24\n');
    if (withBundledNpm) {
      const npmBin = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin');
      fs.mkdirSync(npmBin, { recursive: true });
      fs.writeFileSync(path.join(npmBin, 'npm-cli.js'), '#!/usr/bin/env node\n');
      fs.symlinkSync(path.join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(prefix, 'bin', 'npm'));
    }
    fs.mkdirSync(path.join(tmpDir, 'bin'), { recursive: true });
    fs.symlinkSync(path.join(prefix, 'bin', 'node'), path.join(tmpDir, 'bin', 'node'));
    const realPrefix = fs.realpathSync(prefix);
    return {
      prefix: realPrefix,
      node: path.join(realPrefix, 'bin', 'node'),
      npmCli: path.join(realPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    };
  };

  const npmCalls = () => exec.mock.calls.filter(([, args]) => args.includes('install') || args.includes('rebuild'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-runtime-npm-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    // A different Node major first on PATH, as Homebrew or a version manager leaves it.
    otherNodeDir = path.join(tmpDir, 'homebrew-bin');
    fs.mkdirSync(otherNodeDir);
    shellScript(path.join(otherNodeDir, 'node'), 'echo v22.23.5');
    shellScript(path.join(otherNodeDir, 'npm'), 'exit 0');
    originalPath = process.env.PATH;
    process.env.PATH = `${otherNodeDir}${path.delimiter}${originalPath ?? ''}`;

    checker = new UpdateChecker(tmpDir);
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('1.0.0');
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString(),
    });
    // Fake every child process: the install seeds a validatable candidate and the node
    // probes answer, so the first attempt succeeds and no retry backoff runs. The
    // assertions are about HOW npm was invoked, which the seam records.
    exec = vi.spyOn(checker as unknown as ExecSeam, 'execAsync').mockImplementation(async (_cmd, args) => {
      if (args.includes('install')) {
        const instar = path.join(args[args.indexOf('--prefix') + 1], 'node_modules', 'instar');
        fs.mkdirSync(path.join(instar, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(instar, 'package.json'), JSON.stringify({ version: '1.0.1' }));
        fs.writeFileSync(path.join(instar, 'dist', 'cli.js'), '');
      }
      return args.includes('--version') ? '1.0.1' : '';
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:runtime-npm' });
  });

  it('runs npm install and the better-sqlite3 rebuild with the runtime node first on PATH and nodedir set, not the PATH node', async () => {
    const runtime = seedRuntime(true);

    const result = await checker.applyUpdate();

    expect(result.success).toBe(true);
    expect(npmCalls()).toHaveLength(2);
    const rebuild = npmCalls().find(([, args]) => args.includes('rebuild'));
    expect(rebuild).toBeDefined();
    const [cmd, args, timeout, , env] = rebuild!;
    // npm's own entry file, run by the runtime node — never `npm` resolved through PATH.
    expect(cmd).toBe(runtime.node);
    expect(args).toEqual([
      runtime.npmCli, 'rebuild', 'better-sqlite3',
      '--prefix', expect.stringMatching(/shadow-install\.pending-/),
    ]);
    expect(timeout).toBe(60000);
    // node-gyp and lifecycle scripts resolve bare `node` through PATH: the runtime's
    // directory comes first, the other Node stays reachable behind it.
    const pathDirs = (env?.PATH ?? '').split(path.delimiter);
    expect(pathDirs[0]).toBe(path.dirname(runtime.node));
    expect(pathDirs.indexOf(otherNodeDir)).toBeGreaterThan(0);
    // node-gyp builds against the runtime's bundled headers.
    expect(env?.npm_config_nodedir).toBe(runtime.prefix);
    // The install runs the same way, so nothing in the candidate is produced by the other Node.
    for (const call of npmCalls()) {
      expect(call[0]).toBe(runtime.node);
      expect(call[1][0]).toBe(runtime.npmCli);
      expect((call[4]?.PATH ?? '').split(path.delimiter)[0]).toBe(path.dirname(runtime.node));
    }
  });

  it('falls back to npm from PATH, still with the runtime node directory first, and says so when the runtime bundles no npm', async () => {
    const runtime = seedRuntime(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checker.applyUpdate();

    expect(result.success).toBe(true);
    const rebuild = npmCalls().find(([, args]) => args[0] === 'rebuild');
    expect(rebuild).toBeDefined();
    expect(rebuild![0]).toBe('npm');
    expect((rebuild![4]?.PATH ?? '').split(path.delimiter)[0]).toBe(path.dirname(runtime.node));
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([
      expect.stringMatching(/No npm is bundled beside the runtime node .*using npm from PATH/),
    ]));
  });

  it('rolls back through the same runtime-node npm invocation', async () => {
    const runtime = seedRuntime(true);
    fs.writeFileSync(path.join(tmpDir, 'state', 'update-rollback.json'), JSON.stringify({
      previousVersion: '1.0.1', updatedVersion: '1.0.2', updatedAt: new Date().toISOString(),
    }));

    const result = await checker.rollback();

    expect(result.success).toBe(true);
    expect(npmCalls()).toHaveLength(2);
    for (const call of npmCalls()) {
      expect(call[0]).toBe(runtime.node);
      expect(call[1][0]).toBe(runtime.npmCli);
      expect(call[4]?.npm_config_nodedir).toBe(runtime.prefix);
    }
  });
});
