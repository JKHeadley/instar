import { describe, expect, it } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

describe('assisted subscription re-login config migration parity', () => {
  it('backfills a fleet-dark, approval-shaped, dry-run-first block', () => {
    const config: Record<string, unknown> = {};
    applyDefaults(config, getMigrationDefaults());
    expect((config.subscriptionPool as any).assistedRelogin).toEqual({
      enabled: false,
      mode: 'approval',
      dryRun: true,
      tickMs: 30_000,
      maxAttempts: 3,
      retryBaseMs: 5_000,
      allowedScopes: ['user:profile'],
    });
  });

  it('preserves an operator promotion while adding missing tunables', () => {
    const config: Record<string, any> = {
      subscriptionPool: { assistedRelogin: { enabled: true, mode: 'approval', dryRun: false } },
    };
    applyDefaults(config, getMigrationDefaults());
    expect(config.subscriptionPool.assistedRelogin).toMatchObject({
      enabled: true, mode: 'approval', dryRun: false, tickMs: 30_000, maxAttempts: 3,
    });
  });
});
