/**
 * Tier-2 integration tests for WS5.2 R12 — the revocation data-plane fired over the REAL
 * /mandate/:id/revoke route pipeline (express + real MandateStore/Gate/Audit + a real
 * AccountFollowMeRevocation with real cooperative-wipe + durable store deps).
 *
 * Asserts:
 *   - revoking an `account-follow-me` mandate triggers a real local data-plane wipe (account is
 *     gone from the pool; the response carries the honest `removed` outcome).
 *   - revoking a NON-account-follow-me mandate is completely unaffected (no revocation payload).
 *   - DARK (flag off / executor unwired): the trigger is a strict no-op (control-plane revoke still
 *     succeeds, but no revocation runs and the account is untouched). [Tier-3 dark no-op]
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes } from '../../src/server/routes.js';
import { MandateStore } from '../../src/coordination/MandateStore.js';
import { MandateGate } from '../../src/coordination/MandateGate.js';
import { MandateAudit } from '../../src/coordination/MandateAudit.js';
import { ConditionsRegistry } from '../../src/coordination/conditions.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AccountFollowMeRevocation } from '../../src/core/AccountFollowMeRevocation.js';
import { DurablePendingWipeStore } from '../../src/core/AccountFollowMeRevocationStore.js';
import { buildCooperativeWipe } from '../../src/core/accountFollowMeCooperativeWipe.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const sign = (c: string) => `proof::${c}`;
const verifySig = (c: string, s: string) => s === `proof::${c}`;
const PIN = '123456';
const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';

let dir: string;

function buildHarness(opts: { wireRevocation: boolean; enabled: boolean }) {
  const store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig });
  const audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl') });
  const conditions = new ConditionsRegistry();
  const gate = new MandateGate({ store, conditions, audit });

  const pool = new SubscriptionPool({ stateDir: dir });
  pool.add({
    id: 'acct-x',
    nickname: 'SageMind - Justin',
    email: 'justin@example.com',
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: path.join(dir, 'home-acct-x'),
  });

  const revocation = new AccountFollowMeRevocation({
    enabled: () => opts.enabled,
    // Stub the side-effecting primitives so we don't spawn a real CLI; pool.remove is the REAL effect.
    cooperativeWipe: buildCooperativeWipe({ pool, frameworkLogout: () => true, deleteSlot: () => true }),
    pendingStore: new DurablePendingWipeStore({ stateDir: dir }),
    emitRevocationFailed: () => {},
    reconnectDeadlineMs: () => 60_000,
  });

  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    coordination: { store, gate, audit, conditions },
    subscriptionPool: pool,
    accountFollowMeRevocation: opts.wireRevocation ? revocation : null,
    config: { authToken: 'test', stateDir: dir, port: 0, dashboardPin: PIN },
    stateDir: dir,
  };
  app.use(createRoutes(ctx));
  return { app, store, pool };
}

function issueFollowMeMandate(store: MandateStore) {
  return store.issue({
    scope: 'account-follow-me',
    agents: [ECHO, DAWN],
    authorities: [
      {
        action: 'account-follow-me',
        bounds: {
          accountId: 'acct-x',
          targetMachineId: 'machine-self',
          targetMachineNickname: 'the mini',
          mechanism: 're-mint',
        },
      },
    ],
    author: 'justin',
    expiresAt: FUTURE,
  });
}

function issuePlainMandate(store: MandateStore) {
  return store.issue({
    scope: 'feedback-migration',
    agents: [ECHO, DAWN],
    authorities: [{ action: 'sign-code-review', bounds: { artifact: 'x', mutual: true } }],
    author: 'justin',
    expiresAt: FUTURE,
  });
}

async function revoke(url: string, id: string) {
  return fetch(`${url}/mandate/${id}/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN, reason: 'operator stop following' }),
  });
}

describe('WS5.2 R12 — /mandate/:id/revoke data-plane trigger', () => {
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-revoke-route-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); });

  it('revoking an account-follow-me mandate runs a real local wipe (account removed; honest outcome)', async () => {
    const { app, store, pool } = buildHarness({ wireRevocation: true, enabled: true });
    const m = issueFollowMeMandate(store);
    const server = await listen(app);
    try {
      const res = await revoke(server.url, m.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
      expect(body.accountFollowMeRevocation).toBeTruthy();
      expect(body.accountFollowMeRevocation.state).toBe('removed');
      expect(body.accountFollowMeRevocation.accountId).toBe('acct-x');
      // The REAL data-plane effect happened: the account is gone from the pool.
      expect(pool.get('acct-x')).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('revoking a NON-account-follow-me mandate is unaffected (no revocation payload, account intact)', async () => {
    const { app, store, pool } = buildHarness({ wireRevocation: true, enabled: true });
    const m = issuePlainMandate(store);
    const server = await listen(app);
    try {
      const res = await revoke(server.url, m.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
      expect(body.accountFollowMeRevocation).toBeUndefined();
      expect(pool.get('acct-x')).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('DARK (feature gate off): the trigger is a strict no-op — revoke succeeds, account untouched', async () => {
    const { app, store, pool } = buildHarness({ wireRevocation: true, enabled: false });
    const m = issueFollowMeMandate(store);
    const server = await listen(app);
    try {
      const res = await revoke(server.url, m.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
      // revoke() returns the feature-disabled no-op outcome; the account is NOT wiped.
      expect(body.accountFollowMeRevocation?.reason ?? 'feature-disabled').toBe('feature-disabled');
      expect(pool.get('acct-x')).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it('DARK (executor unwired): the route still revokes the mandate, no revocation runs', async () => {
    const { app, store, pool } = buildHarness({ wireRevocation: false, enabled: true });
    const m = issueFollowMeMandate(store);
    const server = await listen(app);
    try {
      const res = await revoke(server.url, m.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revoked).toBe(true);
      expect(body.accountFollowMeRevocation).toBeUndefined();
      expect(pool.get('acct-x')).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});
