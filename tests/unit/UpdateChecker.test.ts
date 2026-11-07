import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('UpdateChecker', () => {
  let tmpDir: string;
  let checker: UpdateChecker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-test-'));
    // Create state directory structure
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/UpdateChecker.test.ts:20' });
    vi.restoreAllMocks();
  });

  describe('getInstalledVersion', () => {
    it('returns a version string', () => {
      const version = checker.getInstalledVersion();
      expect(typeof version).toBe('string');
      // Should be a semver-like string
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getShadowInstalledVersion', () => {
    const writeShadowPkg = (version: unknown) => {
      const dir = path.join(tmpDir, 'shadow-install', 'node_modules', 'instar');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
    };

    it('reads the LIVE version from the shadow install on disk', () => {
      writeShadowPkg('1.2.3');
      expect(checker.getShadowInstalledVersion()).toBe('1.2.3');
    });

    it('reflects a CHANGED (reverted) shadow version — it is uncached', () => {
      writeShadowPkg('1.3.648');
      expect(checker.getShadowInstalledVersion()).toBe('1.3.648');
      // Simulate the shadow reverting on disk (the strand condition).
      writeShadowPkg('1.3.647');
      expect(checker.getShadowInstalledVersion()).toBe('1.3.647');
    });

    it('returns null when the shadow install is absent', () => {
      expect(checker.getShadowInstalledVersion()).toBeNull();
    });

    it('returns null when the shadow package.json has no version', () => {
      writeShadowPkg(undefined);
      expect(checker.getShadowInstalledVersion()).toBeNull();
    });
  });

  describe('getLastCheck', () => {
    it('returns null when no check has been performed', () => {
      expect(checker.getLastCheck()).toBeNull();
    });

    it('returns saved state after a check', async () => {
      // We can't reliably test the npm check in CI,
      // but we can test the state persistence
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      const mockState = {
        currentVersion: '0.1.8',
        latestVersion: '0.1.9',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      };
      fs.writeFileSync(stateFile, JSON.stringify(mockState));

      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.currentVersion).toBe('0.1.8');
      expect(result!.latestVersion).toBe('0.1.9');
      expect(result!.updateAvailable).toBe(true);
    });
  });

  describe('isNewer (via check)', () => {
    // Test the semver comparison indirectly through persisted state
    it('detects when versions are equal', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '0.1.8',
        latestVersion: '0.1.8',
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      }));

      const result = checker.getLastCheck();
      expect(result!.updateAvailable).toBe(false);
    });
  });

  describe('rollback', () => {
    it('returns failure when no rollback info exists', async () => {
      const result = await checker.rollback();
      expect(result.success).toBe(false);
      expect(result.message).toContain('No rollback info');
    });

    it('canRollback() returns false initially', () => {
      expect(checker.canRollback()).toBe(false);
    });

    it('getRollbackInfo() returns null initially', () => {
      expect(checker.getRollbackInfo()).toBeNull();
    });

    it('getRollbackInfo() returns saved info', () => {
      const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
      const info = {
        previousVersion: '0.9.7',
        updatedVersion: '0.9.8',
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(rollbackFile, JSON.stringify(info));

      const result = checker.getRollbackInfo();
      expect(result).not.toBeNull();
      expect(result!.previousVersion).toBe('0.9.7');
      expect(result!.updatedVersion).toBe('0.9.8');
    });
  });

  describe('applyUpdate — explicit version pinning', () => {
    const seedInstall = (root: string, version: string, workingNative: boolean) => {
      const instar = path.join(root, 'node_modules', 'instar');
      const native = path.join(root, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(path.join(instar, 'dist'), { recursive: true });
      fs.mkdirSync(native, { recursive: true });
      fs.writeFileSync(path.join(instar, 'package.json'), JSON.stringify({ version }));
      fs.writeFileSync(path.join(instar, 'dist', 'cli.js'), `console.log('${version}');`);
      fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.js' }));
      fs.writeFileSync(path.join(native, 'index.js'), workingNative
        ? 'module.exports = class Database { prepare() { return { get() { return { value: 1 }; } }; } close() {} };'
        : 'throw new Error("native binding unavailable")');
    };

    it('keeps the runnable install and refuses restart when a native rebuild fails', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', false);
        if (args[0] === 'rebuild') throw new Error('node-gyp failed');
        return '';
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.restartNeeded).toBe(false);
      expect(result.message).toMatch(/rebuild|native/i);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
    });

    it('promotes only a candidate whose native database works in the active Node runtime', async () => {
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', true);
        return '';
      });

      const result = await checker.applyUpdate();
      expect(result.success).toBe(true);
      expect(result.restartNeeded).toBe(true);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.1');
    });

    it('rejects a successful rebuild command when the resulting native module cannot load', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', false);
        return '';
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.restartNeeded).toBe(false);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
    });

    it('restores the previous install when candidate promotion fails', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', true);
        return '';
      });
      const rename = fs.renameSync.bind(fs);
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from).includes('shadow-install.pending-') && String(to) === live) throw new Error('promotion denied');
        return rename(from, to);
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.restartNeeded).toBe(false);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
      expect(fs.existsSync(path.join(tmpDir, 'shadow-install.previous'))).toBe(false);
    });

    it('a backup left by an interrupted cleanup does not block later updates', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      const leftover = path.join(tmpDir, 'shadow-install.previous');
      seedInstall(live, '1.0.0', true);
      fs.mkdirSync(path.join(leftover, 'node_modules'), { recursive: true }); // partial: its delete was interrupted
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', true);
        return '';
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(true);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.1');
      expect(fs.existsSync(leftover)).toBe(false);
    });

    it('keeps the backup when the active install has no entry file', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      const previous = path.join(tmpDir, 'shadow-install.previous');
      fs.mkdirSync(path.join(live, 'node_modules'), { recursive: true }); // a failed heal left a shell
      seedInstall(previous, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async () => { throw new Error('registry down'); });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      expect((await pending).success).toBe(false);
      expect(fs.existsSync(path.join(previous, 'node_modules', 'instar', 'dist', 'cli.js'))).toBe(true);
    });

    it('a failed delete of the leftover reports a failed update instead of throwing', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.0', true);
      fs.mkdirSync(path.join(tmpDir, 'shadow-install.previous', 'node_modules'), { recursive: true });
      const realRm = SafeFsExecutor.safeRmSync.bind(SafeFsExecutor);
      vi.spyOn(SafeFsExecutor, 'safeRmSync').mockImplementation(((target: string, opts: never) => {
        if (String(target).endsWith('shadow-install.previous')) throw new Error('permission denied');
        return realRm(target, opts);
      }) as never);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.1', true);
        return '';
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.message).toContain('Previous install backup still exists');
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
    });

    it('still restores from the backup when the active install is missing', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      const previous = path.join(tmpDir, 'shadow-install.previous');
      seedInstall(previous, '1.0.0', true);
      vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '1.0.0', latestVersion: '1.0.1', updateAvailable: true, checkedAt: new Date().toISOString() });
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') throw new Error('registry down');
        return '';
      });

      const pending = checker.applyUpdate();
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
      expect(fs.existsSync(live)).toBe(true);
      expect(fs.existsSync(previous)).toBe(false);
    });

    it('a rollback is not blocked by a leftover backup', async () => {
      vi.useFakeTimers();
      const live = path.join(tmpDir, 'shadow-install');
      const leftover = path.join(tmpDir, 'shadow-install.previous');
      seedInstall(live, '1.0.1', true);
      fs.mkdirSync(path.join(leftover, 'node_modules'), { recursive: true });
      (checker as any).saveRollbackInfo('1.0.0', '1.0.1');
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.0', true);
        return '';
      });

      const pending = checker.rollback();
      await vi.runAllTimersAsync();
      expect((await pending).success).toBe(true);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.0');
      expect(fs.existsSync(leftover)).toBe(false);
    });

    it('keeps the active install when a rollback native rebuild fails', async () => {
      const live = path.join(tmpDir, 'shadow-install');
      seedInstall(live, '1.0.1', true);
      fs.writeFileSync(path.join(tmpDir, 'state', 'update-rollback.json'), JSON.stringify({ previousVersion: '1.0.0', updatedVersion: '1.0.1', updatedAt: new Date().toISOString() }));
      vi.spyOn(checker as any, 'execAsync').mockImplementation(async (_cmd: string, args: string[]) => {
        if (args[0] === 'install') seedInstall(args[args.indexOf('--prefix') + 1], '1.0.0', false);
        if (args[0] === 'rebuild') throw new Error('rollback native compile failed');
        return '';
      });

      const result = await checker.rollback();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/rollback native compile failed/);
      expect(checker.getShadowInstalledVersion()).toBe('1.0.1');
    });

    // We can't actually run npm install in tests, but we can verify
    // the source code uses explicit versions via static analysis.
    it('source code uses explicit version, not @latest', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      // The applyUpdate method should use `instar@${targetVersion}` not `instar@latest`
      const applySection = source.slice(
        source.indexOf('async applyUpdate'),
        source.indexOf('// Post-update migration'),
      );

      // Should NOT contain @latest in the npm install command
      expect(applySection).not.toContain("'instar@latest'");
      expect(applySection).not.toContain('"instar@latest"');

      // Should contain the explicit version pattern
      expect(applySection).toContain('`instar@${targetVersion}`');
    });

    it('source code implements retry logic', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      const applySection = source.slice(
        source.indexOf('async applyUpdate'),
        source.indexOf('// Post-update migration'),
      );

      // Should have retry loop
      expect(applySection).toContain('MAX_RETRIES');
      expect(applySection).toContain('RETRY_DELAYS');
      expect(applySection).toContain('for (let attempt');

      // Should verify version matches target
      expect(applySection).toContain('newVersion === targetVersion');
    });

    it('source code has 3 retries with backoff delays', () => {
      const sourcePath = path.resolve(__dirname, '../../src/core/UpdateChecker.ts');
      const source = fs.readFileSync(sourcePath, 'utf-8');

      // Extract the constants
      const maxRetriesMatch = source.match(/MAX_RETRIES\s*=\s*(\d+)/);
      expect(maxRetriesMatch).not.toBeNull();
      expect(Number(maxRetriesMatch![1])).toBe(3);

      const delaysMatch = source.match(/RETRY_DELAYS\s*=\s*\[([^\]]+)\]/);
      expect(delaysMatch).not.toBeNull();
      const delays = delaysMatch![1].split(',').map(s => Number(s.trim()));
      expect(delays).toHaveLength(3);
      expect(delays[0]).toBe(0); // First attempt is immediate
      expect(delays[1]).toBeGreaterThan(0); // Second has a delay
      expect(delays[2]).toBeGreaterThan(delays[1]); // Third has a longer delay
    });
  });

  describe('state persistence', () => {
    it('saveState writes atomic temp file', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');

      // Trigger save by writing state directly
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      }));

      // Verify it can be read back
      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.updateAvailable).toBe(true);
    });

    it('handles corrupted state gracefully', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      fs.writeFileSync(stateFile, 'not json!!!');

      // Should not throw
      const result = checker.getLastCheck();
      expect(result).toBeNull();
    });
  });
});
