import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { repairMissingSubscriptionEmails } from '../../src/core/SubscriptionAccountEmailRepair.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'subscription-email-repair-test' });
  }
});

function legacyPool() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-email-repair-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'subscription-pool.json'), JSON.stringify({
    version: 1,
    lastModified: new Date(0).toISOString(),
    accounts: [{
      id: 'legacy', nickname: 'Legacy', provider: 'anthropic', framework: 'claude-code',
      configHome: '/slot/legacy', status: 'active', enrolledAt: new Date(0).toISOString(), version: 1,
    }],
  }));
  return { dir, pool: new SubscriptionPool({ stateDir: dir }) };
}

describe('repairMissingSubscriptionEmails', () => {
  it('backfills a legacy gap from its own credential oracle', async () => {
    const { dir, pool } = legacyPool();
    const result = await repairMissingSubscriptionEmails(pool, {
      resolveSlotTenant: async (slot) => slot === '/slot/legacy'
        ? { email: 'Owner@Example.com' }
        : { unavailable: true, reason: 'wrong slot' },
    }, { tenantOf: () => 'legacy', version: 1 });
    expect(result).toEqual({ scanned: 1, repaired: ['legacy'], unresolved: [] });
    expect(pool.get('legacy')?.email).toBe('Owner@Example.com');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf8')).accounts[0].email)
      .toBe('Owner@Example.com');
  });

  it('leaves an unresolved gap quarantined and reports it honestly', async () => {
    const { pool } = legacyPool();
    const result = await repairMissingSubscriptionEmails(pool, {
      resolveSlotTenant: async () => ({ unavailable: true, reason: 'not signed in' }),
    }, { tenantOf: () => 'legacy', version: 1 });
    expect(result.unresolved).toEqual([{ accountId: 'legacy', reason: 'identity-oracle-unavailable' }]);
    expect(pool.get('legacy')).toBeNull();
    expect(pool.listEmailGaps()).toHaveLength(1);
  });

  it('refuses repair without an independent slot-to-account binding', async () => {
    const { pool } = legacyPool();
    const result = await repairMissingSubscriptionEmails(
      pool,
      { resolveSlotTenant: async () => ({ email: 'owner@example.com' }) },
      { tenantOf: () => null, version: 1 },
    );
    expect(result.unresolved).toEqual([{ accountId: 'legacy', reason: 'account-binding-unproven' }]);
    expect(pool.listEmailGaps()).toHaveLength(1);
  });

  it('refuses when the binding epoch changes during the provider probe', async () => {
    const { pool } = legacyPool();
    let epoch = 1;
    const result = await repairMissingSubscriptionEmails(
      pool,
      {
        resolveSlotTenant: async () => {
          epoch = 2;
          return { email: 'owner@example.com' };
        },
      },
      { tenantOf: () => 'legacy', get version() { return epoch; } },
    );
    expect(result.unresolved).toEqual([{ accountId: 'legacy', reason: 'account-binding-changed' }]);
    expect(pool.listEmailGaps()).toHaveLength(1);
  });

  it('settles at the whole-sweep deadline and prevents a late identity commit', async () => {
    const { pool } = legacyPool();
    const startedAt = Date.now();
    const result = await repairMissingSubscriptionEmails(
      pool,
      {
        resolveSlotTenant: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { email: 'owner@example.com' };
        },
      },
      { tenantOf: () => 'legacy', version: 1 },
      { timeoutMs: 15 },
    );
    expect(Date.now() - startedAt).toBeLessThan(60);
    expect(result.unresolved).toEqual([{ accountId: 'legacy', reason: 'reconciliation-timeout' }]);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(pool.listEmailGaps()).toHaveLength(1);
  });
});
