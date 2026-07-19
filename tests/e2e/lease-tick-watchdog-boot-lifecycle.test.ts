/** Tier-3 lifecycle proof: the real boot timer must not call startup "recovery". */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

describe('lease-tick watchdog boot lifecycle', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-watchdog-boot-e2e-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'lease-watchdog-boot-e2e' });
  });

  it('stays silent through the first real watchdog callback, then detects a proven stale sample', async () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = {
      machineId,
      signingPublicKey: 'test-signing',
      encryptionPublicKey: 'test-encryption',
      name: 'boot-e2e',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    };
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
    new MachineIdentityManager(stateDir).registerMachine(identity as any, 'awake');

    const coord = new MultiMachineCoordinator(new StateManager(stateDir), {
      stateDir,
      multiMachine: { leaseSelfHeal: { tickWatchdog: { staleFactorMissedTicks: 2 } } } as never,
    });
    coord.start();
    const c = coord as any;
    c.leaseCoordinator = {};
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(c.watchdogReArmTimes).toHaveLength(0);
      expect(report.mock.calls.some(([event]) => event.feature === 'MultiMachine.leaseTick')).toBe(false);

      c.lastTickRunMonoMs = 1;
      c.monoNowMs = () => 1_000_000_000;
      c.runTickWatchdog();
      expect(c.watchdogReArmTimes).toHaveLength(1);
      expect(report.mock.calls.some(([event]) => event.feature === 'MultiMachine.leaseTick')).toBe(true);
    } finally {
      report.mockRestore();
      coord.stop();
    }
  });

  it('recovers once when the main interval is lost before its first callback', async () => {
    const machineId = `m_${crypto.randomBytes(8).toString('hex')}`;
    const identity = {
      machineId,
      signingPublicKey: 'test-signing',
      encryptionPublicKey: 'test-encryption',
      name: 'first-fire-loss-e2e',
      platform: 'test',
      createdAt: new Date().toISOString(),
      capabilities: ['sessions'],
    };
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machine', 'identity.json'), JSON.stringify(identity));
    new MachineIdentityManager(stateDir).registerMachine(identity as any, 'awake');

    const coord = new MultiMachineCoordinator(new StateManager(stateDir), {
      stateDir,
      multiMachine: { leaseSelfHeal: { tickWatchdog: { staleFactorMissedTicks: 2 } } } as never,
    });
    coord.start();
    const c = coord as any;
    c.leaseCoordinator = {};
    clearInterval(c.heartbeatCheckTimer); // deterministic lost-before-first-fire fault
    let monoMs = 1;
    c.heartbeatMonitorArmedMonoMs = monoMs;
    c.monoNowMs = () => monoMs;
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) {
        monoMs += 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
      }
      const leaseReports = () => report.mock.calls.filter(([event]) => event.feature === 'MultiMachine.leaseTick');
      expect(c.watchdogReArmTimes).toHaveLength(1);
      expect(leaseReports()).toHaveLength(1);

      // Recovery re-arms the main interval and resets the episode baseline;
      // subsequent watchdog callbacks cannot amplify the same first-fire loss.
      monoMs += 120_000;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(c.watchdogReArmTimes).toHaveLength(1);
      expect(leaseReports()).toHaveLength(1);
    } finally {
      report.mockRestore();
      coord.stop();
    }
  });
});
