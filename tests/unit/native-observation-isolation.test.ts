/** Safe fixture validation only: never starts AgentServer or the real desktop helper. */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateNativeObservation } from '../fixtures/native-observation/isolation.js';
import { DesktopLockedController } from '../../src/core/DesktopLockedController.js';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('native observer boot fixture isolation', () => {
  it('installs temporary home and inert dispatch before real controller construction, independent of real-helper opt-in', async () => {
    const originalHome = os.homedir();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-isolation-unit-'));
    const isolation = isolateNativeObservation(home);
    let controller: DesktopLockedController | undefined;
    vi.stubEnv('INSTAR_REAL_DESKTOP_HELPER_TESTS', '1');
    try {
      expect(os.homedir()).toBe(home);
      const host = new MacDesktopHost();
      controller = new DesktopLockedController({ host, agentId: 'isolated',
        settings: () => ({ enabled: false, browserBox: false, chime: false }), saveSettings: () => {},
        readPolicy: async () => ({ status: 'unknown' } as never), tunnelFirstTierActive: () => false, raiseSecurity: () => true });
      host.setLockedRoot(controller.root);
      expect(controller.root).toBe(isolation.root);
      expect((host as any).lockedRoot).toBe(isolation.root);
      expect((host as any).packagedBinary()).toBe(isolation.helper);
      // GET /desktop/locked/status probes first; the inert reply must parse, or the route answers 503.
      await expect(host.probe()).resolves.toMatchObject({ screenPermission: false, inputPermission: false, displayCount: 0 });
      await controller.sweep(true); // actual reportGuardFailures + read, only against the temporary store
      await host.startRelockGuard('12345678-1234-1234-1234-123456789abc.0');
      await vi.waitFor(() => expect(host.getRelockGuardObservation().entries[0].exit).toBe('exited'), { timeout: 10_000 });
      expect(host.getRelockGuardObservation().entries[0].exitCode).toBe(0);
      expect(isolation.attemptedRealPaths).toEqual([]);
    } finally {
      controller?.stop();
      isolation.restore();
      vi.unstubAllEnvs();
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'isolation unit cleanup' });
    }
    expect(os.homedir()).toBe(originalHome);
  });

  it('the production-boot test establishes isolation before calling boot and asserts both real roots', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../e2e/desktop-locked-lifecycle.test.ts'), 'utf8');
    const test = source.slice(source.indexOf("('wires native actor diagnostics"));
    expect(test.indexOf('isolateNativeObservation(dir)')).toBeLessThan(test.indexOf('await boot(true, dir)'));
    expect(test).toContain('expect(controller.root).toBe(isolation.root)');
    expect(test).toContain('expect((host as any).lockedRoot).toBe(isolation.root)');
    expect(test).not.toContain('(host as any).binary =');
  });
});
