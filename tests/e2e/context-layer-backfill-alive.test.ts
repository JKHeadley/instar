// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the Anchor and ledger backfill is ALIVE on the production init path
 * (context-budget-layered-summaries §6.1, decision 9, §12, §14; Phase 1 S7).
 *
 * An agent with history (a topic captured before the layers existed) boots
 * the way server.ts boots it: the layers gated by `contextBudget.enabled`, the
 * capture wiring built through `wireLayerCapture` with the backfill switch
 * read from the live config, and the lane started through
 * `startBackfillLane` with the server's own owner rule (`topicOwnerCheck`).
 *  - dev agent, switch on: one tick rebuilds the topic; GET /topic/:id/anchor
 *    and GET /context-budget/metrics return 200 with the pending backfill
 *    confirmation and the lane wired;
 *  - dev agent, switch omitted: the lane is wired and reports itself off, and
 *    its tick does no work;
 *  - pool placement live and the ownership record naming another machine (or
 *    none): no work;
 *  - fleet agent: nothing built, the routes are 503.
 * Plus WIRED source checks on server.ts, the wiring and the manifest.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { topicOwnerCheck } from '../../src/monitoring/contextLayers/backfillLane.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/e2e/context-layer-backfill-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 171717;
const OWNER = 111;

const provider: IntelligenceProvider = {
  async evaluate(prompt: string) {
    const l = (g: string) => ({ goal: g, trend: 'converging', themes: ['gate'] });
    const msg = prompt.split('New message (')[1]?.split('Currently tracked refs')[0] ?? '';
    return JSON.stringify({
      signals: msg.includes('Block. Warnings') ? [{ kind: 'new-ref', propositionText: 'the gate blocks', refKind: 'decision' }]
        : msg.includes('Also cover the dashboard') ? [{ kind: 'new-ref', propositionText: 'the topic also covers the dashboard card', refKind: 'goal' }] : [],
      awareness: { topic: l('design the gate'), recentArc: l('block or warn'), currentWork: l('the gate'), arcTransition: { kind: 'continue' } },
    });
  },
};

describe('Anchor and ledger backfill — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean; backfill?: { enabled?: boolean } }; multiMachine?: { sessionPool?: { enabled?: boolean; stage?: string } } }, pool: { owner?: string | null; machines?: number } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-bf-e2e-')); dirs.push(root);
    const sd = path.join(root, 'agent'); fs.mkdirSync(sd, { recursive: true });
    const topicMemory = new TopicMemory(sd); await topicMemory.open(); mems.push(topicMemory);
    const topicIntentStore = new TopicIntentStore(sd);
    const captureExtractor = new TopicIntentExtractor(topicIntentStore, createLlmExtractFn(provider));
    // History: this topic was captured before the layers existed on this agent.
    const before = createCaptureLoop({ extractor: captureExtractor, store: topicIntentStore, topicMemory });
    const history = [
      { messageId: 600, text: 'We are designing the fold gate for the pilot; it must keep my decisions.', fromUser: true },
      { messageId: 601, text: 'Should the gate block or warn?', fromUser: false },
      { messageId: 602, text: 'Block. Warnings get ignored in practice.', fromUser: true },
      { messageId: 603, text: 'Blocking it is.', fromUser: false },
      { messageId: 604, text: 'Also cover the dashboard card in this topic.', fromUser: true },
    ];
    for (const m of history) {
      topicMemory.insertMessage({ topicId: T, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, m.messageId % 60)).toISOString(), sessionName: null, forwarded: false, ...(m.fromUser ? { telegramUserId: OWNER } : {}), ...m });
      await before({ messageId: m.messageId, topicId: T, text: m.text, fromUser: m.fromUser, timestamp: Date.now() });
    }

    // ── boot, as server.ts ─────────────────────────────────────────────────
    const liveConfig = { get: <V>(k: string, d: V): V => { const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), config); return (v === undefined ? d : v) as V; } };
    const _memoryPrivacyWired = new MemoryPrivacy({ stateDir: sd, instarRoot: root, agentId: 'e2e', config: () => ({}), users: () => [], reachable: () => ({ telegramOwnerId: OWNER }) });
    _memoryPrivacyWired.establishBaseline();
    const _contextLayers = contextLayersEnabled(config, liveConfig.get<boolean | undefined>('contextBudget.enabled', undefined)) ? buildContextLayers({ stateDir: sd }) : null;
    const layerWiring = _contextLayers
      ? (await import('../../src/monitoring/contextLayers/layerCaptureWiring.js')).wireLayerCapture({
          layers: _contextLayers, store: topicIntentStore, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const },
          machine: 'm_e2e', projectDir: sd,
          topicMemory: topicMemory ?? null,
          isOperator: ({ senderKey, userId }) => _memoryPrivacyWired.isOperator(senderKey) || _memoryPrivacyWired.isOwnerSender(senderKey, userId),
          bindingFingerprint: () => _memoryPrivacyWired.operatorBindingFingerprint(),
          backfillEnabled: () => liveConfig.get<boolean>('contextBudget.backfill.enabled', false) === true,
        })
      : null;
    const _meshSelfId = 'm_e2e';
    const sessionOwnershipRegistry = { ownerOf: (_k: string) => pool.owner ?? null };
    const lane = layerWiring && topicMemory
      ? layerWiring.startBackfillLane({
          stateDir: sd,
          topics: () => topicMemory.listTopics().map((t) => ({ topicId: t.topicId, lastActivity: t.lastActivity })),
          isOwner: topicOwnerCheck({
            poolPlacementLive: () => { const p = liveConfig.get<{ enabled?: boolean; stage?: string } | undefined>('multiMachine.sessionPool', undefined); return p?.enabled === true && !!p.stage && p.stage !== 'dark'; },
            multiMachine: () => (pool.machines ?? 1) > 1,
            ownerOf: (k) => sessionOwnershipRegistry.ownerOf(k),
            selfId: () => _meshSelfId,
          }),
          latestMessageId: (topicId) => topicMemory.lastMessageIdByRow(topicId),
          // The server starts the timer; the test ticks by hand.
          start: false,
        })
      : null;
    const ctx = {
      config: { projectName: 'echo', projectDir: sd, stateDir: sd, port: 0 } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      tokenLedger: null, featureMetricsLedger: null,
      startTime: new Date(),
      contextLayers: _contextLayers,
      topicIntentStore,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return { sd, app, layers: _contextLayers, layerWiring, lane, topicIntentStore };
  }

  it('dev agent, switch on: one tick rebuilds the existing topic; the anchor and metrics routes report the pending confirmation and the lane', async () => {
    const b = await boot({ developmentAgent: true, contextBudget: { backfill: { enabled: true } } });
    expect(b.lane).not.toBeNull();
    expect(await b.lane!.tick()).toMatchObject({ ran: true, worked: [T] });
    const a = await request(b.app).get(`/topic/${T}/anchor`);
    expect(a.status).toBe(200);
    expect(a.body.anchor).toMatchObject({ status: 'anchored', rows: [{ messageId: 600 }] });
    expect(a.body.backfill).toMatchObject({ state: 'backfilled', backfilledUnconfirmed: 1, confirmation: 'pending', historyThroughMessageId: 604 });
    expect(a.text).not.toContain('Warnings get ignored');
    const m = await request(b.app).get('/context-budget/metrics');
    expect(m.status).toBe(200);
    expect(m.body.anchors.backfill).toMatchObject({ pendingConfirmations: 1, lane: { wired: true, enabled: true, topics: { done: 1 } } });
    expect(b.topicIntentStore.read(T).pending.outstanding).toMatchObject({ kind: 'backfill' });
  });

  it('dev agent, switch omitted: the lane is wired and reports itself off, and does no work', async () => {
    const b = await boot({ developmentAgent: true });
    expect(await b.lane!.tick()).toMatchObject({ ran: false, reason: 'switch-off' });
    expect(b.layers!.store.read(String(T), 'anchor', 'current')).toBeNull();
    const m = await request(b.app).get('/context-budget/metrics');
    expect(m.body.anchors.backfill).toMatchObject({ pendingConfirmations: 0, lane: { wired: true, enabled: false } });
  });

  it('pool placement live: another machine\'s topic, or one with no ownership record, is not touched; this machine\'s is', async () => {
    const live = { developmentAgent: true, contextBudget: { backfill: { enabled: true } }, multiMachine: { sessionPool: { enabled: true, stage: 'live' } } };
    for (const owner of ['m_other', null]) {
      const b = await boot(live, { owner });
      await b.lane!.tick();
      expect(b.layers!.store.read(String(T), 'anchor', 'current')).toBeNull();
    }
    const mine = await boot(live, { owner: 'm_e2e' });
    expect(await mine.lane!.tick()).toMatchObject({ worked: [T] });
    // A pool of several machines with placement dark: no machine can tell it owns the topic.
    const dark = await boot({ developmentAgent: true, contextBudget: { backfill: { enabled: true } } }, { machines: 2, owner: 'm_e2e' });
    await dark.lane!.tick();
    expect(dark.layers!.store.read(String(T), 'anchor', 'current')).toBeNull();
  });

  it('fleet agent: nothing built, the routes are 503', async () => {
    const b = await boot({ contextBudget: { backfill: { enabled: true } } });
    expect(b.layers).toBeNull();
    expect(b.lane).toBeNull();
    expect((await request(b.app).get(`/topic/${T}/anchor`)).status).toBe(503);
    expect((await request(b.app).get('/context-budget/metrics')).status).toBe(503);
  });

  it('WIRED: server.ts reads the switch live and starts the lane with the owner rule; the wiring passes the switch to the ledger; the manifest registers it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("backfillEnabled: () => liveConfig.get<boolean>('contextBudget.backfill.enabled', false) === true,");
    expect(src).toContain('const backfillLane = layerWiring.startBackfillLane({');
    expect(src).toContain('topicOwnerCheck({');
    expect(src).toContain("return r && r.status === 'active' ? r.ownerMachineId : null;");
    expect(src).toContain('latestMessageId: (topicId) => tm.lastMessageIdByRow(topicId),');
    const wiring = fs.readFileSync(path.join(ROOT, 'src/monitoring/contextLayers/layerCaptureWiring.ts'), 'utf-8');
    expect(wiring).toContain('backfill: () => o.backfillEnabled?.() === true');
    expect(wiring).toContain('o.layers.attachBackfillLane(lane);');
    const manifest = fs.readFileSync(path.join(ROOT, 'src/monitoring/guardManifest.ts'), 'utf-8');
    expect(manifest).toContain("configPath: 'contextBudget.backfill.enabled'");
    const ladders = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/feature-ladders.json'), 'utf-8')) as { entries: Array<{ id: string }> };
    expect(ladders.entries.some((e) => e.id === 'contextBudget.backfill')).toBe(true);
  });
});
