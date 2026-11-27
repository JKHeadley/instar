import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopGuardObservation } from '../../src/core/DesktopGuardObservation.js';
import { MacDesktopHost, DEFAULT_MAC_DESKTOP_HELPER } from '../../src/core/MacDesktopHost.js';
import { DesktopLockedController } from '../../src/core/DesktopLockedController.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const KEY = '12345678-1234-1234-1234-123456789abc.0';
const remove = (p: string) => SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'observer test cleanup' });

describe('bounded guard history', () => {
  it('records intent, preserves every lifetime entry, and makes overflow sticky', () => {
    const o = new DesktopGuardObservation();
    for (let i = 0; i < 128; i++) expect(o.intent(KEY)).toBe(`${o.snapshot().instanceId}:${i + 1}`);
    const before = o.snapshot();
    expect(before.entries.every(e => e.spawn === 'intent')).toBe(true);
    expect(o.intent(KEY)).toBeNull();
    expect(o.snapshot()).toMatchObject({ complete: false, reason: 'capacity-exceeded', sequence: 128 });
    expect(o.snapshot().entries).toEqual(before.entries);
    o.update(before.entries[0].attemptId, { exit: 'exited' });
    expect(o.intent(KEY)).toBeNull();
    expect(o.snapshot().complete).toBe(false);
  });
  it('returns detached snapshots and distinct host instances', () => {
    const a = new DesktopGuardObservation(), b = new DesktopGuardObservation();
    a.intent(KEY); const snap = a.snapshot(); snap.entries[0].spawn = 'error';
    expect(a.snapshot().entries[0].spawn).toBe('intent');
    expect(a.snapshot().instanceId).not.toBe(b.snapshot().instanceId);
    a.update('unknown', {}); expect(a.snapshot().complete).toBe(false);
  });
  it('does not lose a synchronous pre-spawn failure', async () => {
    const host = new MacDesktopHost(); host.setLockedRoot('/test/locked');
    vi.spyOn(host as any, 'trustedBinary').mockImplementation(() => {
      expect(host.getRelockGuardObservation().entries[0].spawn).toBe('intent');
      throw new Error('unavailable');
    });
    await expect(host.startRelockGuard(KEY)).rejects.toThrow('unavailable');
    expect(host.getRelockGuardObservation().entries[0]).toMatchObject({ spawn: 'error', exit: 'pending' });
  });
  it('retains an asynchronous spawn failure as an unmatched actor', async () => {
    const host = new MacDesktopHost(); host.setLockedRoot('/test/locked');
    const binary = vi.spyOn(host as any, 'trustedBinary').mockReturnValue('/nonexistent/observer-inert-child');
    try {
      await host.startRelockGuard(KEY);
      await vi.waitFor(() => expect(host.getRelockGuardObservation().entries[0].spawn).toBe('error'), { timeout: 10_000 });
      expect(host.getRelockGuardObservation().entries[0]).toMatchObject({ pid: null, exit: 'pending' });
    } finally { binary.mockRestore(); }
  });
  it.skipIf(process.platform !== 'darwin')('executes an inert child through the real spawn funnel and observes exact exit', async () => {
    const dir = path.dirname(DEFAULT_MAC_DESKTOP_HELPER);
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, `observer-inert-${process.pid}-${Date.now()}`);
    fs.writeFileSync(helper, `#!${process.execPath}\nif (!process.env.INSTAR_GUARD_OBSERVATION) process.exit(2);\n`, { mode: 0o700 });
    const cleanup = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-observer-'));
    try {
      const host = new MacDesktopHost(helper); host.setLockedRoot(cleanup);
      await host.startRelockGuard(KEY);
      await vi.waitFor(() => expect(host.getRelockGuardObservation().entries[0].exit).toBe('exited'), { timeout: 10_000 });
      expect(host.getRelockGuardObservation().entries[0]).toMatchObject({ key: KEY, spawn: 'spawned', exitCode: 0, signal: null });
      expect(host.getRelockGuardObservation().entries[0].pid).toBeGreaterThan(0);
      // Even a lost observer must still dispatch the existing safety child.
      (host as any).guardObservation.fail('injected-failure');
      const marker = path.join(cleanup, 'ran');
      fs.writeFileSync(helper, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');\n`, { mode: 0o700 });
      await host.startRelockGuard(KEY);
      await vi.waitFor(() => expect(fs.existsSync(marker)).toBe(true), { timeout: 10_000 });
      expect(host.getRelockGuardObservation().complete).toBe(false);
    } finally { fs.renameSync(helper, path.join(cleanup, 'helper')); remove(cleanup); }
  });
  it('wires real controller status to the injected host and reports absent/read failure as unknown', async () => {
    const host = new MacDesktopHost();
    const controller = Object.create(DesktopLockedController.prototype) as any;
    controller.deps = { host, settings: () => ({ enabled: false }) };
    controller.read = async () => ({ markers: {}, attempts: {}, loginSession: 'login' });
    controller.active = () => false; controller.enableRefusal = () => 'off';
    controller.passwordReadiness = () => ({}); controller.browserBoxShown = () => false; controller.browserBoxRefusal = () => 'off';
    expect((await controller.status()).guardObservation.instanceId).toBe(host.getRelockGuardObservation().instanceId);
    controller.deps.host = {};
    expect((await controller.status()).guardObservation).toMatchObject({ available: false, complete: false });
    controller.deps.host = { getRelockGuardObservation: () => { throw new Error('failed'); } };
    expect((await controller.status()).guardObservation.reason).toBe('observer-unreadable');
  });
});
