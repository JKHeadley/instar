// safe-fs-allow: isolated HTTP fixture cleanup uses SafeFsExecutor.
/**
 * POST /subscription-pool/swap with targetAccountId, and the session's own framework.
 * Regression for 2026-11-28, Mama topic 144319: a Codex session tagged with a Claude account
 * (justin-gmail) must be movable onto one exact Codex account (codex-sagemindai) with no
 * sign-in, and the route must never pick an account of another framework.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'swap target HTTP cleanup' }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-target-http-')); dirs.push(dir);
  const state = new StateManager(dir);
  const pool = new SubscriptionPool({ stateDir: dir });
  const now = Date.now();
  const add = (id: string, framework: 'claude-code' | 'codex-cli', util: number) => {
    const home = path.join(dir, id); fs.mkdirSync(home);
    pool.addFixture({ id, nickname: id, email: `${id}@example.test`, framework, provider: framework === 'codex-cli' ? 'openai' : 'anthropic', configHome: home });
    pool.update(id, { lastQuota: { measuredAt: new Date(now).toISOString(), windowsListed: ['sevenDay'],
      sevenDay: { utilizationPct: util, resetsAt: new Date(now + 120 * 3_600_000).toISOString() } } });
  };
  add('justin-gmail', 'claude-code', 20);
  add('sagemind-justin', 'claude-code', 10);
  add('codex-amrch', 'codex-cli', 65);
  add('codex-sagemindai', 'codex-cli', 18);
  const refreshed: Array<{ sessionName: string; accountId: string; configHome: string }> = [];
  const refresh = vi.fn(async (o: { sessionName: string; accountId: string; configHome: string }) => { refreshed.push(o); return { ok: true }; });
  const scheduler = new QuotaAwareScheduler({ listAccounts: () => pool.list(), refreshFn: refresh as never });
  const running = [{ tmuxSession: 'echo-instar-windows-app', framework: 'codex-cli', subscriptionAccountId: 'justin-gmail', status: 'running' }];
  const app = express(); app.use(express.json());
  app.use(createRoutes({ config: { authToken: 'fixture', stateDir: dir, projectDir: dir, sessions: {}, subscriptionPool: {} }, startTime: new Date(), state,
    subscriptionPool: pool, quotaAwareScheduler: scheduler, sessionManager: { listRunningSessions: () => running } } as any));
  const swap = (body: Record<string, unknown>) => request(app).post('/subscription-pool/swap').set('Authorization', 'Bearer fixture')
    .send({ sessionName: 'echo-instar-windows-app', exhaustedAccountId: 'justin-gmail', ...body });
  return { swap, refreshed, pool };
}

describe('POST /subscription-pool/swap — exact target and session framework', () => {
  it('moves the Codex session tagged with a Claude account onto the exact Codex target', async () => {
    const x = fixture();
    const r = await x.swap({ targetAccountId: 'codex-sagemindai' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, swapped: true, toAccountId: 'codex-sagemindai' });
    expect(x.refreshed).toHaveLength(1);
    expect(x.refreshed[0].accountId).toBe('codex-sagemindai');
    expect(x.refreshed[0].configHome).toBe(x.pool.list().find((a) => a.id === 'codex-sagemindai')!.configHome);
  });

  it('with no target, the pick follows the session framework, never a Claude account', async () => {
    const x = fixture();
    const r = await x.swap({});
    expect(r.body.swapped).toBe(true);
    expect(x.pool.list().find((a) => a.id === r.body.toAccountId)?.framework).toBe('codex-cli');
  });

  it('refuses a target of another framework with 409, an unknown target with 404, and bad shapes with 400', async () => {
    const x = fixture();
    const mismatch = await x.swap({ targetAccountId: 'sagemind-justin' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('target-framework-mismatch');
    expect((await x.swap({ targetAccountId: 'nope' })).status).toBe(404);
    expect((await x.swap({ targetAccountId: '' })).status).toBe(400);
    expect((await x.swap({ targetAccountId: 7 })).status).toBe(400);
    expect((await x.swap({ targetAccountId: 'codex-sagemindai', balanceUnusedQuota: true })).status).toBe(400);
    expect(x.refreshed).toHaveLength(0);
  });
});
