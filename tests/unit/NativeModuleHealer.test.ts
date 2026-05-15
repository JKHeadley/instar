/**
 * Unit tests for NativeModuleHealer — in-line self-heal for
 * better-sqlite3 NODE_MODULE_VERSION mismatch. PROP-399.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { NativeModuleHealer } from '../../src/memory/NativeModuleHealer.js';

describe('NativeModuleHealer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-healer-test-'));
    NativeModuleHealer.resetForTesting();
    NativeModuleHealer.configure({ stateDir: tmpDir });
  });

  describe('isNodeModuleVersionError', () => {
    it('detects canonical NODE_MODULE_VERSION error message', () => {
      const err = new Error(
        "The module '/x/better_sqlite3.node' was compiled against a different " +
          'Node.js version using NODE_MODULE_VERSION 108. ' +
          'This version of Node.js requires NODE_MODULE_VERSION 115.'
      );
      expect(NativeModuleHealer.isNodeModuleVersionError(err)).toBe(true);
    });

    it('detects short-form mismatch message', () => {
      const err = new Error('NODE_MODULE_VERSION mismatch');
      expect(NativeModuleHealer.isNodeModuleVersionError(err)).toBe(true);
    });

    it('detects lowercase variant', () => {
      const err = new Error('node_module_version mismatch detected');
      expect(NativeModuleHealer.isNodeModuleVersionError(err)).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(NativeModuleHealer.isNodeModuleVersionError(new Error('ENOENT'))).toBe(false);
      expect(NativeModuleHealer.isNodeModuleVersionError(new Error('SQLITE_BUSY'))).toBe(false);
    });

    it('handles non-Error throws', () => {
      expect(NativeModuleHealer.isNodeModuleVersionError('NODE_MODULE_VERSION blah')).toBe(true);
      expect(NativeModuleHealer.isNodeModuleVersionError('some other string')).toBe(false);
      expect(NativeModuleHealer.isNodeModuleVersionError(null)).toBe(false);
      expect(NativeModuleHealer.isNodeModuleVersionError(undefined)).toBe(false);
    });
  });

  describe('openWithHeal', () => {
    it('passes through when opener succeeds on first try', async () => {
      const opener = vi.fn(() => 'opened');
      const result = await NativeModuleHealer.openWithHeal('TestComponent', opener);
      expect(result).toBe('opened');
      expect(opener).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-NODE_MODULE_VERSION errors without attempting heal', async () => {
      const opener = vi.fn(() => {
        throw new Error('ENOENT: no such file');
      });
      await expect(
        NativeModuleHealer.openWithHeal('TestComponent', opener)
      ).rejects.toThrow(/ENOENT/);
      expect(opener).toHaveBeenCalledTimes(1);
      // No heal log entry expected since the error isn't a NODE_MODULE_VERSION one
      const logPath = path.join(tmpDir, 'native-module-heals.jsonl');
      expect(fs.existsSync(logPath)).toBe(false);
    });

    it('attempts heal on NODE_MODULE_VERSION error and logs the event', async () => {
      // Mock healBetterSqlite3 to simulate a failed rebuild (so we don't actually
      // shell out to npm in the test). The test verifies the failure path is wired
      // up: heal attempted, heal event logged, original error surfaced.
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3')
        .mockResolvedValue(false);

      const opener = vi.fn(() => {
        throw new Error('NODE_MODULE_VERSION mismatch — was 108 expected 115');
      });

      await expect(
        NativeModuleHealer.openWithHeal('TestComponent', opener)
      ).rejects.toThrow(/NODE_MODULE_VERSION mismatch/);

      expect(healSpy).toHaveBeenCalledTimes(1);
      expect(opener).toHaveBeenCalledTimes(1);

      healSpy.mockRestore();
    });

    it('retries opener once after successful heal', async () => {
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3')
        .mockResolvedValue(true);

      let calls = 0;
      const opener = vi.fn(() => {
        calls++;
        if (calls === 1) {
          throw new Error('NODE_MODULE_VERSION mismatch');
        }
        return 'opened-on-retry';
      });

      const result = await NativeModuleHealer.openWithHeal('TestComponent', opener);
      expect(result).toBe('opened-on-retry');
      expect(opener).toHaveBeenCalledTimes(2);
      expect(healSpy).toHaveBeenCalledTimes(1);

      healSpy.mockRestore();
    });

    it('does not retry more than once per process', async () => {
      // The mock must set the healAttempted flag itself, since openWithHeal
      // uses that flag (not call count) to decide whether to skip the heal
      // on subsequent invocations.
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3')
        .mockImplementation(async () => {
          (NativeModuleHealer as any).healAttempted = true;
          (NativeModuleHealer as any).lastResult = {
            component: 'TestComponent',
            timestamp: new Date().toISOString(),
            success: false,
            nodeVersion: process.version,
            errorTail: 'mocked failure',
          };
          return false;
        });

      const opener = vi.fn(() => {
        throw new Error('NODE_MODULE_VERSION mismatch');
      });

      // First call attempts heal
      await expect(
        NativeModuleHealer.openWithHeal('TestComponent', opener)
      ).rejects.toThrow(/NODE_MODULE_VERSION/);

      // Second call must NOT attempt heal again — same process
      await expect(
        NativeModuleHealer.openWithHeal('TestComponent', opener)
      ).rejects.toThrow(/NODE_MODULE_VERSION/);

      // healBetterSqlite3 should have been called only once across both opens
      expect(healSpy).toHaveBeenCalledTimes(1);

      healSpy.mockRestore();
    });

    it('handles async openers', async () => {
      const opener = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'async-opened';
      });
      const result = await NativeModuleHealer.openWithHeal('TestComponent', opener);
      expect(result).toBe('async-opened');
    });
  });

  describe('logHealEvent (via failed heal)', () => {
    it('writes a JSONL line to the configured stateDir', async () => {
      // Force a failed heal so we exercise the logging path without an
      // actual npm rebuild. The healer's findBetterSqlite3InstallPrefix
      // path is the simplest way: it'll likely succeed (we're running in
      // a real project tree), but findNpmPath might too. To make the test
      // deterministic, spy on the internal method.
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3')
        .mockImplementation(async function (this: any, component: string) {
          // Manually trigger the logging side-effect we want to verify.
          (NativeModuleHealer as any).healAttempted = true;
          const event = {
            component,
            timestamp: new Date().toISOString(),
            success: false,
            nodeVersion: process.version,
            errorTail: 'simulated failure',
          };
          (NativeModuleHealer as any).logHealEvent(event);
          (NativeModuleHealer as any).lastResult = event;
          return false;
        });

      const opener = () => {
        throw new Error('NODE_MODULE_VERSION mismatch');
      };

      await expect(
        NativeModuleHealer.openWithHeal('TestComponent', opener)
      ).rejects.toThrow();

      const logPath = path.join(tmpDir, 'native-module-heals.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);
      const line = fs.readFileSync(logPath, 'utf-8').trim();
      const parsed = JSON.parse(line);
      expect(parsed.component).toBe('TestComponent');
      expect(parsed.success).toBe(false);
      expect(parsed.nodeVersion).toBe(process.version);

      healSpy.mockRestore();
    });
  });

  describe('openWithHealSync', () => {
    it('passes through when opener succeeds on first try', () => {
      const opener = vi.fn(() => 'opened');
      const result = NativeModuleHealer.openWithHealSync('TestComponent', opener);
      expect(result).toBe('opened');
      expect(opener).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-NODE_MODULE_VERSION errors without attempting heal', () => {
      const opener = () => {
        throw new Error('SQLITE_BUSY');
      };
      expect(() => NativeModuleHealer.openWithHealSync('TestComponent', opener)).toThrow(
        'SQLITE_BUSY',
      );
    });

    it('attempts heal on NODE_MODULE_VERSION error and rethrows on failed rebuild', () => {
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3Sync')
        .mockImplementation((_c: string): boolean => {
          (NativeModuleHealer as any).healAttempted = true;
          (NativeModuleHealer as any).lastResult = {
            component: 'TestComponent',
            timestamp: new Date().toISOString(),
            success: false,
            nodeVersion: process.version,
            errorTail: 'simulated failure',
          };
          return false;
        });

      const opener = () => {
        throw new Error('NODE_MODULE_VERSION mismatch');
      };

      expect(() => NativeModuleHealer.openWithHealSync('TestComponent', opener)).toThrow(
        /in-line heal failed/,
      );

      healSpy.mockRestore();
    });

    it('retries opener once after successful heal', () => {
      const healSpy = vi
        .spyOn(NativeModuleHealer, 'healBetterSqlite3Sync')
        .mockImplementation((_c: string): boolean => {
          (NativeModuleHealer as any).healAttempted = true;
          (NativeModuleHealer as any).lastResult = {
            component: 'TestComponent',
            timestamp: new Date().toISOString(),
            success: true,
            nodeVersion: process.version,
          };
          return true;
        });

      let tries = 0;
      const opener = () => {
        tries += 1;
        if (tries === 1) throw new Error('NODE_MODULE_VERSION mismatch');
        return 'second-try-ok';
      };

      const result = NativeModuleHealer.openWithHealSync('TestComponent', opener);
      expect(result).toBe('second-try-ok');
      expect(tries).toBe(2);

      healSpy.mockRestore();
    });

    it('does not retry more than once per process when heal already attempted', () => {
      // Simulate a previous heal that already happened (and failed)
      (NativeModuleHealer as any).healAttempted = true;
      (NativeModuleHealer as any).lastResult = {
        component: 'EarlierComponent',
        timestamp: new Date().toISOString(),
        success: false,
        nodeVersion: process.version,
        errorTail: 'earlier failure',
      };

      const opener = vi.fn(() => {
        throw new Error('NODE_MODULE_VERSION mismatch');
      });

      expect(() => NativeModuleHealer.openWithHealSync('TestComponent', opener)).toThrow(
        /heal previously attempted and failed/,
      );

      // Opener was tried exactly once — the prior heal attempt blocks the retry
      expect(opener).toHaveBeenCalledTimes(1);
    });
  });
});
