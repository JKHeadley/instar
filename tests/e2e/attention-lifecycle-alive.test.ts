// safe-git-allow: e2e fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * E2E — attention-lifecycle-close-on-cause "feature alive" lifecycle.
 *
 * Mirrors what server.ts wires: a REAL TelegramAdapter constructed with the
 * production defaults (no lifecycle config at all — the feature ships ON), the
 * REAL AttentionConditionStore with its `onClear` → `clearAttentionCondition`
 * wiring, the REAL routes. Proves: the layer is constructed and running by
 * default (GET /attention/lifecycle → 200, enabled:true, not 503); a condition
 * clearing in the store closes its attention item; the boot pass runs and
 * records lastSweepAt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { AttentionConditionStore, baseKeyOfItemId } from '../../src/core/AttentionConditionStore.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';

const PROJECT_NAME = 'attention-lifecycle-e2e';
let AUTH = '';
let tmp: string;
let adapter: TelegramAdapter;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-lc-e2e-')); AUTH = generateAgentToken(PROJECT_NAME); });
afterEach(async () => { deleteAgentToken(PROJECT_NAME); await adapter?.stop(); vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

function productionWiring() {
  // Exactly the shape server.ts builds: adapter first (defaults), then the
  // condition store with the late-bound onClear, then the resolver + active check.
  adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, getAttentionHubTopicId: () => 777 }, tmp);
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 777 }));
  const conditions = new AttentionConditionStore({
    filePath: path.join(tmp, 'state', 'attention-conditions.json'),
    onClear: (baseKey) => { adapter.clearAttentionCondition({ idPrefix: `${baseKey}:ep-` }, 'cleared: the condition ended'); },
  });
  adapter.setAttentionConditionActiveCheck((item) => conditions.isItemActive(item.id));
  adapter.registerAttentionConditionResolver('attention-condition-store', (item) => {
    if (!/:ep-\d+$/.test(item.id)) return 'unknown';
    if (conditions.isItemActive(item.id)) return 'active';
    return conditions.inactiveBaseKeys().includes(baseKeyOfItemId(item.id)) ? 'cleared' : 'unknown';
  });
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
  return { app, conditions };
}
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('E2E: attention lifecycle is alive by default', () => {
  it('GET /attention/lifecycle answers 200 enabled:true with production defaults (never 503), and the boot pass records lastSweepAt', async () => {
    const { app } = productionWiring();
    const before = await request(app).get('/attention/lifecycle').set(auth());
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, dryRun: false, lastSweepAt: null, resolvers: ['attention-condition-store'] });
    adapter.runAttentionLifecyclePass(); // what the 2-minute boot timer does
    const after = await request(app).get('/attention/lifecycle').set(auth());
    expect(after.body.lastSweepAt).toBeTruthy();
    expect(after.body.firstPassAt).toBeTruthy();
  });

  it('a condition raised through the store, then cleared, closes its attention item as cause-cleared; an active one is never expired', async () => {
    const { app, conditions } = productionWiring();
    const identity = { producer: 'stale-owner-release', conditionType: 'ambiguity', subject: 'm_abc', scope: 'owner' };
    const o = conditions.observe(identity);
    expect(o.shouldRaise).toBe(true);
    await adapter.createAttentionItem({ id: o.itemId, title: 'Your call: demote machine X?', summary: 's', category: 'ownership', priority: 'HIGH', sourceContext: 'stale-owner-release:m_abc' });
    expect((await request(app).get(`/attention/${encodeURIComponent(o.itemId)}`).set(auth())).body.status).toBe('OPEN');
    // Backdate far past every window: an ACTIVE condition still blocks expiry.
    const row = adapter.getAttentionItem(o.itemId)!;
    row.updatedAt = new Date(Date.now() - 200 * 86_400_000).toISOString();
    adapter.runAttentionLifecyclePass(); adapter.runAttentionLifecyclePass();
    expect(adapter.getAttentionItem(o.itemId)?.status).toBe('OPEN');
    // The producer clears the subject → the item closes through the real onClear wiring.
    expect(conditions.clearSubject('stale-owner-release', 'm_abc')).toBe(1);
    const closed = await request(app).get(`/attention/${encodeURIComponent(o.itemId)}`).set(auth());
    expect(closed.body).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared' });
    // And a row left open from BEFORE the wiring existed is caught by the pass via the resolver.
    const o2 = conditions.observe(identity);
    expect(o2.itemId).toMatch(/:ep-2$/);
    await adapter.createAttentionItem({ id: o2.itemId, title: 'Your call: demote machine X?', summary: 's', category: 'ownership', priority: 'HIGH', sourceContext: 'stale-owner-release:m_abc' });
    // Simulate the crash window: the record goes inactive without the callback firing.
    (conditions as unknown as { conditions: Map<string, { active: boolean }> }).conditions.get(baseKeyOfItemId(o2.itemId))!.active = false;
    const pass = adapter.runAttentionLifecyclePass();
    expect(pass.causeCleared).toBe(1);
    expect(adapter.getAttentionItem(o2.itemId)).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared' });
  });
});
