// safe-git-allow: e2e fixture cleanup uses SafeFsExecutor on tmp dirs only.
/**
 * E2E — "a failed sign-in repair stops alarming once the account is back" is ALIVE through the
 * production composition: the REAL createSubscriptionReloginRuntime (the factory server.ts
 * calls), its REAL verified-health check (pool active + no identity drift + live login check
 * `ok`), wired to a REAL TelegramAdapter + routes the way server.ts wires `onConditionCleared`
 * and the hourly-pass resolver. Proves the dependency is not a no-op: flipping the pool cell to a
 * verified sign-in closes the open row on the next runtime tick; a label-only `active` (no live
 * login check) does not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { createSubscriptionReloginRuntime } from '../../src/core/SubscriptionReloginRuntime.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import {
  clearRecoveredReloginAttention,
  resolveSubscriptionReloginAttention,
  subscriptionReloginConditionKey,
} from '../../src/core/SubscriptionReloginAttention.js';

const PROJECT_NAME = 'relogin-recovered-e2e';
const DIGEST = `sha256:${'c'.repeat(64)}`;
let AUTH = '';
const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  deleteAgentToken(PROJECT_NAME);
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'relogin-recovered-e2e cleanup' });
});

describe('failed sign-in repair attention — production composition alive', () => {
  it('closes the open row once the runtime verifies the account signed in; a label-only active does not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-recovered-e2e-')); roots.push(root);
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);

    // A failed repair already on disk (as after the 2026-10-26 time-budget failure).
    const seed = new SubscriptionReloginStore({ stateDir });
    let ep = seed.suggest({ sourceEpisodeId: 11, accountId: 'acct-1', machineId: 'machine-1', mode: 'unattended',
      inputDigest: DIGEST, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    ep = seed.approve(ep.id, { inputDigest: DIGEST });
    ep = seed.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
    ep = seed.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'repair-time-budget-exhausted', failureClass: 'repair-time-budget-exhausted' });
    seed.close();

    const adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, getAttentionHubTopicId: () => 777 }, root);
    cleanups.push(() => adapter.stop());
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 777 }));
    // The row the operator saw (raised while the account was still signed out).
    await adapter.createAttentionItem({ id: `subscription-relogin-${ep.id}-terminal-1`, title: 'Claude Code sign-in repair',
      summary: 'repair ended in failed', description: 'repair ended in failed', category: 'subscription-relogin',
      conditionKey: subscriptionReloginConditionKey(ep), priority: 'HIGH', sourceContext: 'assisted-subscription-relogin' } as never);

    let account: Record<string, unknown> = { id: 'acct-1', email: 'a@example.test', provider: 'anthropic', framework: 'claude-code',
      configHome: path.join(root, 'slot'), status: 'needs-reauth', enrolledAt: '2026-01-01T00:00:00Z', version: 1 };
    let loginCheck: 'ok' | 'signed-out' | 'unavailable' = 'signed-out';
    const source = { id: 11, accountId: 'acct-1', machineId: 'machine-1', openedAt: '2026-10-26T20:00:00Z', closedAt: null as string | null,
      causeClass: 'exchange-failed', corroboration: 'exchange-corroborated', outcome: null, provenance: 'observed' };
    const runtime = createSubscriptionReloginRuntime({ stateDir, projectDir: root,
      seatLease: new PlaywrightSeatLease({ filePath: path.join(root, 'seat-lease.json') }),
      machineId: 'machine-1', mode: 'unattended',
      pool: { getAvailability: () => ({ state: 'ready' }), get: (id: string) => (id === 'acct-1' ? { ...account } : null), update: vi.fn(), list: () => [{ ...account }] } as never,
      ledger: { listEpisodes: () => [{ ...source }], recordStatus: vi.fn(() => ({ changed: false })) } as never,
      enrollment: { getById: () => null, start: vi.fn(), refresh: vi.fn() } as never,
      profiles: { resolve: () => ({ profile: { id: 'profile-1' }, dirExists: true }), listProfiles: () => [] } as never,
      quotaPoller: { pollAccount: vi.fn(), loginCheck: () => loginCheck } as never,
      identityOracle: { resolveSlotTenant: vi.fn(async () => ({ email: 'a@example.test' })) } as never,
      pasteBack: { finish: vi.fn() } as never,
      createBrowser: () => { throw new Error('no browser in this test'); }, resolveSecret: async () => null,
      supervise: async ({ allowedActions }) => allowedActions[0]!,
      slowRetry: { enabled: false },
      // Exactly the server.ts wiring.
      onConditionCleared: (e) => { clearRecoveredReloginAttention(e, (m, r) => adapter.clearAttentionCondition(m, r)); },
    });
    cleanups.push(() => runtime.close());
    adapter.registerAttentionConditionResolver('subscription-relogin', (item) => resolveSubscriptionReloginAttention(item, {
      getEpisode: (id) => runtime.store.get(id), listEpisodes: (accountId) => runtime.store.list({ accountId, limit: 50 }),
      localMachineId: 'machine-1', localCellHealthy: (accountId) => runtime.cellVerifiedHealthy(accountId, 'machine-1'),
    }));
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes({
      config: { projectName: PROJECT_NAME, projectDir: root, stateDir, port: 0, authToken: AUTH } as never,
      telegram: adapter, meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
      state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
      sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
      mentorRunner: null, currentInboundByTopic: new Map(),
    } as unknown as RouteContext));
    const auth = { Authorization: `Bearer ${AUTH}` };
    const openRelogin = async () => ((await request(app).get('/attention?status=open').set(auth)).body.items as Array<{ category: string }>)
      .filter((i) => i.category === 'subscription-relogin');

    // Wiring integrity: the real health check is not a no-op in either direction.
    expect(runtime.cellVerifiedHealthy('acct-1', 'machine-1')).toBe(false);
    await runtime.service.tick();
    expect(await openRelogin()).toHaveLength(1);

    // Label-only "active" without a live login check is NOT verified: the row stays.
    account = { ...account, status: 'active' }; loginCheck = 'unavailable';
    expect(runtime.cellVerifiedHealthy('acct-1', 'machine-1')).toBe(false);
    await runtime.service.tick();
    expect(await openRelogin()).toHaveLength(1);

    // Verified: active + live login check ok + no identity drift → the next tick closes it.
    loginCheck = 'ok'; source.closedAt = '2026-10-26T20:28:28Z';
    expect(runtime.cellVerifiedHealthy('acct-1', 'machine-1')).toBe(true);
    expect(runtime.cellVerifiedHealthy('acct-1', 'machine-2')).toBe(false); // another machine's cell is never verifiable here
    await runtime.service.tick();
    expect(await openRelogin()).toHaveLength(0);
    const row = await request(app).get(`/attention/subscription-relogin-${ep.id}-terminal-1`).set(auth);
    expect(row.status).toBe(200);
    expect(row.body).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared' });
  });
});
