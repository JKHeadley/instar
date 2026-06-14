/**
 * E2E (Tier-3 "feature is alive") for WS5.2 Step 6 — census consumer re-routing.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.2.
 *
 * The single most important Step-6 assertion: with the feature flag OFF (always, while it ships
 * dark) EVERY census consumer behaves EXACTLY as today — the re-routing is wired but strictly
 * inert. This boots a real Express server with the SAME wiring chain server.ts builds (the ledger
 * + the CredentialLocationGate + the consumers reading through it) and proves:
 *   - the wiring constructs end-to-end without error (feature is alive, not 503 / crash);
 *   - flag OFF → the in-use badge re-probes auth status exactly as today (no ledger short-circuit);
 *   - flag OFF → the quota poll reads the enrollment home exactly as today;
 *   - flag OFF → PATCH configHome is allowed (today's behavior), not 409.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { InUseAccountResolver } from '../../src/core/InUseAccountResolver.js';
import {
  CredentialLocationLedger,
  type IdentityOracle,
  type LedgerPoolView,
} from '../../src/core/CredentialLocationLedger.js';
import { CredentialLocationGate } from '../../src/core/CredentialLocationGate.js';
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

const noopOracle: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };
const USAGE = { five_hour: { utilization: 5, resets_at: '2026-06-07T00:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-06-12T00:00:00Z' } };
const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => USAGE });

describe('credential re-pointing census re-routing — E2E feature-alive (dark = strict no-op)', () => {
  let server: TestServer | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir) { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'credential-repointing-census-lifecycle.test cleanup' }); } catch { /* @silent-fallback-ok */ } dir = undefined; }
  });

  /** Build the server.ts wiring chain (ledger → gate → consumers) with the flag set as given. */
  async function bootWired(enabled: boolean): Promise<{ pool: SubscriptionPool; seenHomes: string[]; probeCalls: () => number }> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-census-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'claude-1', nickname: 'primary', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, '.claude-enroll'), email: 'a@x.com' });
    const poolView: LedgerPoolView = { list: () => pool.list().map((a) => ({ id: a.id, email: a.email, configHome: a.configHome, framework: a.framework })) };

    const ledger = new CredentialLocationLedger({ stateDir: dir, pool: poolView, oracle: noopOracle });
    // Seed the live slot for claude-1 at the default `~/.claude` home. This is DIFFERENT from its
    // enrollment home (`.claude-enroll`), so: (a) a flag-off quota read that leaked through would
    // visibly target `~/.claude` instead of the enrollment home, and (b) the in-use census #8 can
    // resolve the badge from `ledger.tenantOf('~/.claude')` when the flag is on.
    ledger.recordAssignment('~/.claude', 'claude-1');

    const gate = new CredentialLocationGate({
      isEnabled: () => enabled,
      ledger,
    });

    const seenHomes: string[] = [];
    const quotaPoller = new QuotaPoller({
      pool,
      fetchImpl: okFetch,
      tokenResolver: (a) => { seenHomes.push(a.configHome); return 'sk-ant-oat-x'; },
      locationGate: gate,
    });

    let probes = 0;
    const inUseAccountResolver = new InUseAccountResolver({
      probe: async () => { probes++; return 'a@x.com'; },
      locationGate: gate,
    });

    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 't', stateDir: dir, port: 0, subscriptionPool: { credentialRepointing: { enabled } } },
      startTime: new Date(),
      subscriptionPool: pool,
      quotaPoller,
      inUseAccountResolver,
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
    return { pool, seenHomes, probeCalls: () => probes };
  }

  const api = (p: string, init?: RequestInit) =>
    fetch(server!.url + p, { headers: { 'Content-Type': 'application/json' }, ...init }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('FLAG OFF: the full wiring is alive AND strictly inert (every consumer = today)', async () => {
    const { seenHomes, probeCalls } = await bootWired(false);

    // in-use badge: re-probes auth status (NOT the ledger short-circuit).
    const inUse = await api('/subscription-pool/in-use');
    expect(inUse.status).toBe(200);
    expect(inUse.body).toEqual({ enabled: true, activeAccountId: 'claude-1', activeEmail: 'a@x.com' });
    expect(probeCalls()).toBe(1); // it DID re-probe — flag-off behavior

    // quota poll: reads the ENROLLMENT home, not the ledger's live slot.
    const poll = await api('/subscription-pool/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ enabled: true, polled: 1 });
    expect(seenHomes.every((h) => h.endsWith('.claude-enroll'))).toBe(true);
    expect(seenHomes.some((h) => h === '~/.claude')).toBe(false); // ledger slot NOT consulted

    // PATCH configHome: allowed (today's behavior), not 409.
    const patch = await api('/subscription-pool/claude-1', { method: 'PATCH', body: JSON.stringify({ configHome: '/edited' }) });
    expect(patch.status).toBe(200);
  });

  it('FLAG ON: the same wiring now routes the in-use badge through the ledger (no re-probe)', async () => {
    const { probeCalls } = await bootWired(true);
    const inUse = await api('/subscription-pool/in-use');
    expect(inUse.status).toBe(200);
    expect(inUse.body).toEqual({ enabled: true, activeAccountId: 'claude-1', activeEmail: 'a@x.com' });
    expect(probeCalls()).toBe(0); // E4a liar stays dead — resolved from the ledger, no re-probe

    // PATCH configHome now refused (409).
    const patch = await api('/subscription-pool/claude-1', { method: 'PATCH', body: JSON.stringify({ configHome: '/edited' }) });
    expect(patch.status).toBe(409);
  });
});
