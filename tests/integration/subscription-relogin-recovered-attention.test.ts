/**
 * Tier-2 integration — a failed sign-in repair's attention row over the REAL HTTP pipeline
 * (createRoutes + a real TelegramAdapter with its HTTP layer stubbed + a real relogin store and
 * service). The service is wired to the adapter exactly as server.ts wires it: onTerminal raises
 * the condition-keyed row, onConditionCleared closes it through clearAttentionCondition, and the
 * hourly-pass resolver reads verified cell health.
 *
 * Both sides of the boundary: while the account is still signed out the row stays open (and the
 * hourly pass keeps it open); once the account is verified signed in, the next service tick
 * closes it with an honest resolution, and so does the hourly pass on its own.
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
import { SubscriptionReloginService } from '../../src/core/SubscriptionReloginService.js';
import type { SubscriptionReloginOrchestrator } from '../../src/core/SubscriptionReloginOrchestrator.js';
import {
  clearRecoveredReloginAttention,
  resolveSubscriptionReloginAttention,
  subscriptionReloginConditionKey,
} from '../../src/core/SubscriptionReloginAttention.js';

const PROJECT_NAME = 'relogin-recovered-attn-int';
const DIGEST = `sha256:${'a'.repeat(64)}`;
let AUTH = '';
const tmps: string[] = [];
const adapters: TelegramAdapter[] = [];

afterEach(async () => {
  deleteAgentToken(PROJECT_NAME);
  for (const a of adapters.splice(0)) await a.stop();
  vi.restoreAllMocks();
  for (const t of tmps.splice(0)) SafeFsExecutor.safeRmSync(t, { recursive: true, force: true, operation: 'test-cleanup' });
});

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-recovered-int-')); tmps.push(tmp);
  AUTH = generateAgentToken(PROJECT_NAME);
  const adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100,
    attentionHubFilter: 'all', getAttentionHubTopicId: () => 5151 }, tmp);
  adapters.push(adapter);
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 9999 }));

  const store = new SubscriptionReloginStore({ stateDir: path.join(tmp, '.instar') });
  let ep = store.suggest({ sourceEpisodeId: 11, accountId: 'sagemind-luna', machineId: 'machine-1', mode: 'unattended',
    inputDigest: DIGEST, profileId: 'luna-google', framework: 'claude-code', provider: 'anthropic' });
  ep = store.approve(ep.id, { inputDigest: DIGEST });
  ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'cli-starting', eventClass: 'cli-starting', incrementAttempt: true });
  ep = store.transition(ep.id, { expectedVersion: ep.version, to: 'failed', eventClass: 'repair-time-budget-exhausted',
    failureClass: 'repair-time-budget-exhausted' });

  let healthy = false;
  const cellVerifiedHealthy = (accountId: string, machineId: string) => healthy && accountId === 'sagemind-luna' && machineId === 'machine-1';
  const orchestrator = { tick: vi.fn(async () => ({ outcome: 'waiting' })) } as unknown as SubscriptionReloginOrchestrator;
  const service = new SubscriptionReloginService({ store, orchestrator, scanCandidates: async () => [],
    revalidate: async () => ({ admissible: false as const, reason: 'account-not-needs-reauth' }),
    sourceIncidentOpen: () => !healthy, slowRetry: { enabled: false },
    cellHealthy: (e) => cellVerifiedHealthy(e.accountId, e.machineId),
    // As server.ts: the terminal notice raises ONE condition-keyed row.
    onTerminal: async (e, deliveryKey) => {
      await adapter.createAttentionItem({ id: deliveryKey.replace(/:/g, '-'), title: 'Claude Code sign-in repair',
        summary: 'repair ended in failed', description: 'repair ended in failed', category: 'subscription-relogin',
        conditionKey: subscriptionReloginConditionKey(e), priority: 'HIGH', sourceContext: 'assisted-subscription-relogin' } as never);
    },
    onConditionCleared: (e) => { clearRecoveredReloginAttention(e, (m, r) => adapter.clearAttentionCondition(m, r)); },
  });
  adapter.registerAttentionConditionResolver('subscription-relogin', (item) => resolveSubscriptionReloginAttention(item, {
    getEpisode: (id) => store.get(id), listEpisodes: (accountId) => store.list({ accountId, limit: 50 }),
    localMachineId: 'machine-1', localCellHealthy: (accountId) => cellVerifiedHealthy(accountId, 'machine-1'),
  }));

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes({
    config: { projectName: PROJECT_NAME, projectDir: tmp, stateDir: path.join(tmp, '.instar'), port: 0, authToken: AUTH } as never,
    telegram: adapter, meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext));
  return { app, service, store, setHealthy: (v: boolean) => { healthy = v; }, episodeId: ep.id };
}
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const reloginRows = (items: Array<{ category?: string }>) => items.filter((i) => i.category === 'subscription-relogin');

describe('a failed sign-in repair attention row closes itself when the account is verified back', () => {
  it('still signed out: the row is open, and the hourly pass keeps it open', async () => {
    const h = setup();
    await h.service.tick();
    const open = await request(h.app).get('/attention?status=open').set(auth());
    expect(open.status).toBe(200);
    expect(reloginRows(open.body.items)).toHaveLength(1);
    const sweep = await request(h.app).post('/attention/lifecycle/sweep').set(auth()).send({});
    expect(sweep.status).toBe(200);
    expect(sweep.body.causeCleared).toBe(0);
    expect(reloginRows((await request(h.app).get('/attention?status=open').set(auth())).body.items)).toHaveLength(1);
  });

  it('verified signed in: the next service tick closes it with an honest resolution', async () => {
    const h = setup();
    await h.service.tick();
    const [row] = reloginRows((await request(h.app).get('/attention?status=open').set(auth())).body.items) as Array<{ id: string }>;
    h.setHealthy(true);
    await h.service.tick();
    expect(reloginRows((await request(h.app).get('/attention?status=open').set(auth())).body.items)).toHaveLength(0);
    const got = await request(h.app).get(`/attention/${row.id}`).set(auth());
    expect(got.body).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared' });
    expect(got.body.resolution).toMatch(/signed in again \(verified/);
    // The episode history is untouched.
    expect(h.store.get(h.episodeId)).toMatchObject({ state: 'failed' });
  });

  it('verified signed in: the hourly pass alone also closes it (resolver reads verified health)', async () => {
    const h = setup();
    await h.service.tick();
    h.setHealthy(true);
    const sweep = await request(h.app).post('/attention/lifecycle/sweep').set(auth()).send({});
    expect(sweep.body.causeCleared).toBe(1);
    expect(reloginRows((await request(h.app).get('/attention?status=open').set(auth())).body.items)).toHaveLength(0);
  });

  it('recovered before the held notice went out: no row is ever raised', async () => {
    const h = setup();
    h.setHealthy(true);
    await h.service.tick();
    const all = await request(h.app).get('/attention').set(auth());
    expect(reloginRows(all.body.items)).toHaveLength(0);
  });
});
