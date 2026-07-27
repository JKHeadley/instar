/**
 * E2E (Tier-3 "feature is alive" + data-flow) for the B3a boot-seed wiring.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §52 (seeding/recovery via the oracle).
 *
 * Proves the loop the inline server.ts wiring closes: the boot-seed guard fires the (non-destructive)
 * seedFromOracle() and the resulting slot↔account map FLOWS THROUGH to the real GET /credentials/locations
 * route — i.e. the rebalancer would actually have slots to balance, instead of a permanently-empty ledger.
 *
 * Both sides of the boundary, end-to-end through the real route:
 *  - dev-gate ON  → boot-seeds → /credentials/locations shows the mapped assignments (mode 'active')
 *  - dev-gate OFF → guard skips the seed → ledger stays never-seeded → assignments: [] (mode 'dark')
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import {
  CredentialLocationLedger,
  shouldBootSeedCredentialLedger,
  type IdentityOracle,
  type LedgerPoolView,
} from '../../src/core/CredentialLocationLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('credential ledger boot-seed — E2E (seed flows to /credentials/locations)', () => {
  let server: TestServer | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir) { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-ledger-boot-seed.test cleanup' }); } catch { /* @silent-fallback-ok */ } dir = undefined; }
  });

  /** Mirror the server.ts boot-seed wiring chain (pool → oracle → ledger → guard → seed → route). */
  async function bootSeeded(enabled: boolean): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-bootseed-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    const homeA = path.join(dir, '.claude-a');
    const homeB = path.join(dir, '.claude-b');
    pool.addFixture({ id: 'acct-a', nickname: 'A', provider: 'anthropic', framework: 'claude-code', configHome: homeA, email: 'a@x.com' });
    pool.addFixture({ id: 'acct-b', nickname: 'B', provider: 'anthropic', framework: 'claude-code', configHome: homeB, email: 'b@x.com' });

    const poolView: LedgerPoolView = { list: () => pool.list().map((a) => ({ id: a.id, email: a.email, configHome: a.configHome, framework: a.framework })) };
    // Oracle maps each slot (configHome) to its real tenant email — the happy path of seeding.
    const emailByHome: Record<string, string> = { [homeA]: 'a@x.com', [homeB]: 'b@x.com' };
    const oracle: IdentityOracle = { async resolveSlotTenant(slot: string) { const email = emailByHome[slot]; return email ? { email } : { unavailable: true }; } };

    const ledger = new CredentialLocationLedger({ stateDir: dir, pool: poolView, oracle });

    // THE WIRING UNDER TEST (identical guard the server.ts boot path uses, awaited here for determinism).
    if (shouldBootSeedCredentialLedger(enabled, ledger.isSeeded())) {
      await ledger.seedFromOracle();
    }

    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 't', stateDir: dir, port: 0, subscriptionPool: { credentialRepointing: { enabled } } },
      startTime: new Date(),
      subscriptionPool: pool,
      credentialRepointing: {
        ledger,
        audit: { response: (b: unknown) => b },
        levers: { forcedBudgetRemaining: () => 10 },
      },
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  const api = (p: string) =>
    fetch(server!.url + p, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

  it('dev-gate ON: boot-seeds and the mapped slots flow to GET /credentials/locations', async () => {
    await bootSeeded(true);
    const r = await api('/credentials/locations');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.mode).toBe('active');
    const byAccount = Object.fromEntries(r.body.assignments.map((a: any) => [a.accountId, a.slot]));
    expect(byAccount['acct-a']).toMatch(/\.claude-a$/);
    expect(byAccount['acct-b']).toMatch(/\.claude-b$/);
    expect(r.body.assignments.filter((a: any) => a.accountId).length).toBe(2);
  });

  it('dev-gate OFF: the guard skips the seed — ledger stays never-seeded (assignments: [])', async () => {
    await bootSeeded(false);
    const r = await api('/credentials/locations');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(r.body.mode).toBe('dark');
    expect(r.body.assignments).toEqual([]);
  });
});
