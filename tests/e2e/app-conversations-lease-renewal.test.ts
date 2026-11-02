/**
 * Real elapsed time, the production enrollment decision: a non-development agent with NO
 * Telegram and native app conversations on resolves its lease renewal dependencies exactly as
 * server boot does (`leaseRenewalDependencies(config)` → `enrollLeaseRenewalDependency`), and
 * after the 60-second lease window the real coordinator still holds the lease at epoch 1 — so
 * the app conversation service's ownership check (`holdsLease`) admits a message.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';
import { leaseRenewalDependencies } from '../../src/server/leaseRenewalDependencies.js';
import type { InstarConfig } from '../../src/core/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);

describe('Telegram-free app agent keeps its serving lease (real timers)', () => {
  it('holds the lease past the lease window at an unchanged epoch', async () => {
    const config = { messaging: [], mobilePairing: { enabled: true, native: { enabled: true } } } as unknown as InstarConfig;
    const deps = leaseRenewalDependencies(config);
    expect(deps).toEqual(['app-conversations']);
    const lease = await originLeaseDependencyFixture({ dependency: deps[0] });
    cleanup.push(lease.close);
    expect(lease.config.developmentAgent).toBeUndefined();
    expect(lease.config.multiMachine.leaseSelfHeal.resilientRenew.enabled).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    expect(lease.coordinator.holdsLease()).toBe(true);
    expect(lease.lc.currentEpoch()).toBe(1);
  }, 90_000);
});
