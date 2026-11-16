// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the Anchor and ledger backfill on its real paths
 * (context-budget-layered-summaries §6.1, decision 9, §12, §14; Phase 1 S7):
 *  - an existing topic whose history was captured with the layers OFF (the
 *    real capture loop, the real extractor and the real production
 *    `createLlmExtractFn`, a scripted provider standing in for the model) →
 *    the layers come on with the backfill switch → the REAL lane built by
 *    `wireLayerCapture` over real TopicMemory, U and the ledger rebuilds the
 *    Anchor and the ledger: operator entries `backfilled-unconfirmed`, one
 *    backfill confirmation queued;
 *  - the confirmation reaches the REAL briefing route only after the user
 *    writes again, and the reply after that surfaces it (the live capture
 *    loop with the layers on);
 *  - GET /topic/:id/anchor (backfill block) and GET /context-budget/metrics
 *    (`anchors.backfill.pendingConfirmations`, the lane's status) through the
 *    real routes behind the real bearer middleware;
 *  - a non-owner lane and a switched-off lane do no work.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { TopicIntentExtractor, createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireLayerCapture } from '../../src/monitoring/contextLayers/layerCaptureWiring.js';
import { backfillStateFile } from '../../src/monitoring/contextLayers/backfillLane.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-backfill.test.ts';
const AUTH = 'integration-auth-token-0123456789';
const T = 161616;
const OWNER = 111;
const BLOCK = 'REBUILT FROM EARLIER HISTORY';
const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});
function tmp(p: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; }

function scriptedProvider(script: Record<string, { signals?: unknown[] }>) {
  let calls = 0;
  const provider: IntelligenceProvider = {
    async evaluate(prompt: string) {
      calls++;
      const msg = prompt.split('New message (')[1]?.split('Currently tracked refs')[0] ?? '';
      const id = Object.keys(script).find((k) => msg.includes(k));
      const l = (g: string) => ({ goal: g, trend: 'moving', themes: ['gate'] });
      return JSON.stringify({ signals: id ? script[id].signals ?? [] : [], awareness: { topic: l('design the gate'), recentArc: l('block or warn'), currentWork: l('the gate'), arcTransition: { kind: 'continue' } } });
    },
  };
  return { provider, calls: () => calls };
}

function appFor(sd: string, layers: ReturnType<typeof buildContextLayers>, store: TopicIntentStore, tm: TopicMemory): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: sd, stateDir: sd, port: 0, authToken: AUTH } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: tm, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null,
    startTime: new Date(),
    contextLayers: layers,
    topicIntentStore: store,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctx));
  app.use(createTopicIntentRoutes({ topicIntentStore: store }));
  return app;
}

const at = (i: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, i)).toISOString();
const HISTORY = [
  { messageId: 10, text: 'We are designing the fold gate for the pilot; it must keep my decisions.', fromUser: true },
  { messageId: 11, text: 'Should the gate block or warn?', fromUser: false },
  { messageId: 12, text: 'Block. Warnings get ignored every time.', fromUser: true },
  { messageId: 13, text: 'Blocking it is.', fromUser: false },
  { messageId: 14, text: 'Also cover the dashboard card in this topic.', fromUser: true },
  { messageId: 15, text: 'Adding the card.', fromUser: false },
];
const SCRIPT = {
  'Block. Warnings': { signals: [{ kind: 'new-ref', propositionText: 'the gate blocks', refKind: 'decision' }] },
  'Also cover the dashboard': { signals: [{ kind: 'new-ref', propositionText: 'the topic also covers the dashboard card', refKind: 'goal' }] },
};

/** An existing topic: captured before the layers existed, then the layers and the backfill switch come on. */
async function rig(o: { owner?: boolean | 'unknown'; on?: boolean } = {}) {
  const sd = tmp('cl-bf-int-');
  const tm = new TopicMemory(sd); await tm.open(); mems.push(tm);
  const store = new TopicIntentStore(sd);
  const { provider, calls } = scriptedProvider(SCRIPT);
  const extractor = new TopicIntentExtractor(store, createLlmExtractFn(provider));
  const oldLoop = createCaptureLoop({ extractor, store, topicMemory: tm });
  for (const m of HISTORY) {
    tm.insertMessage({ topicId: T, timestamp: at(m.messageId), sessionName: null, forwarded: false, ...(m.fromUser ? { telegramUserId: OWNER } : {}), ...m });
    await oldLoop({ messageId: m.messageId, topicId: T, text: m.text, fromUser: m.fromUser, timestamp: at(m.messageId) });
  }
  const sw = { on: o.on ?? true };
  const layers = buildContextLayers({ stateDir: sd });
  const wiring = wireLayerCapture({
    layers, store, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const },
    machine: 'm_int', projectDir: sd, topicMemory: tm,
    isOperator: ({ senderKey }) => senderKey === `telegram:${OWNER}`,
    backfillEnabled: () => sw.on,
  });
  const lane = wiring.startBackfillLane({
    stateDir: sd, start: false,
    topics: () => tm.listTopics().map((t) => ({ topicId: t.topicId, lastActivity: t.lastActivity })),
    isOwner: () => o.owner ?? true,
    latestMessageId: (t) => tm.getRecentMessages(t, 1)[0]?.messageId ?? null,
  })!;
  const liveLoop = createCaptureLoop({ ...wiring.captureDeps, extractor, store, topicMemory: tm });
  const live = async (messageId: number, text: string, fromUser: boolean) => {
    tm.insertMessage({ topicId: T, timestamp: at(messageId), sessionName: null, forwarded: false, ...(fromUser ? { telegramUserId: OWNER } : {}), messageId, text, fromUser });
    await liveLoop({ messageId, topicId: T, text, fromUser, timestamp: at(messageId) });
  };
  return { sd, tm, store, layers, wiring, lane, live, sw, calls, app: () => appFor(sd, layers, store, tm) };
}

describe('the backfill lane through the real wiring', () => {
  it('rebuilds an existing topic on its owner: the Anchor, a backfilled-unconfirmed decision, one confirmation — and no model call', async () => {
    const r = await rig();
    const before = r.calls();
    expect(await r.lane.tick()).toMatchObject({ ran: true, worked: [T] });
    expect(r.calls()).toBe(before);
    expect(r.layers.store.read(String(T), 'anchor', 'current')).toMatchObject({ status: 'anchored', data: { messageIds: [10], historyThroughMessageId: 15 } });
    const entries = r.layers.store.list(String(T), 'ledger-entry');
    // No stub was written before the layers existed: the decision never settled, so it stays pending (not relabelled).
    expect(entries.find((e) => e.data.type === 'decision')).toMatchObject({ status: 'pending', data: { boundMessageId: 12, fromHistory: true, statusBasis: 'no-stub' } });
    // The operator's purpose change from history is held as backfilled-unconfirmed.
    expect(entries.find((e) => e.data.type === 'evolution')).toMatchObject({ status: 'backfilled-unconfirmed', data: { boundMessageId: 14, backfillDerivedStatus: 'tentative', fromHistory: true } });
    expect(r.store.read(T).pending.outstanding).toMatchObject({ kind: 'backfill' });
    expect(r.lane.topicRecord(T)).toMatchObject({ status: 'done', source: 'lane', result: { entries: 2, backfilledUnconfirmed: 1 } });
    expect(fs.existsSync(backfillStateFile(r.sd))).toBe(true);
    expect(r.layers.status().backfillLane).toMatchObject({ wired: true, enabled: true, topics: { done: 1 } });
  });

  it('the confirmation reaches the briefing only after the user writes again, and the reply after that surfaces it', async () => {
    const r = await rig();
    await r.lane.tick();
    const brief = async () => (await request(r.app()).get(`/topic-intent/${T}/briefing`).set('Authorization', `Bearer ${AUTH}`)).text;
    expect(await brief()).not.toContain(BLOCK);
    await r.live(16, 'Status: gate work queued.', false);
    expect(await brief()).not.toContain(BLOCK);
    await r.live(17, 'Carry on with the gate please.', true);
    expect(await brief()).toContain(BLOCK);
    await r.live(18, 'On it; I rebuilt this topic from its history, tell me if anything is wrong.', false);
    // Asked once: it leaves the queue with that reply and is never rendered again.
    expect(r.store.read(T).pending.outstanding).toBeNull();
    expect(typeof r.layers.store.read(String(T), 'anchor', 'current')!.data.backfillConfirmSurfacedAt).toBe('number');
    await r.live(19, 'Next step?', true);
    expect(await brief()).not.toContain(BLOCK);
    const m = await request(r.app()).get('/context-budget/metrics').set('Authorization', `Bearer ${AUTH}`);
    expect(m.body.anchors.backfill).toMatchObject({ pendingConfirmations: 1, asked: 1, awaitingAsk: 0 });
  });

  it('GET /topic/:id/anchor and GET /context-budget/metrics expose the pending backfill confirmation (what the card and Home count), never the words', async () => {
    const r = await rig();
    await r.lane.tick();
    const app = r.app();
    const a = await request(app).get(`/topic/${T}/anchor`).set('Authorization', `Bearer ${AUTH}`);
    expect(a.status).toBe(200);
    expect(a.body.backfill).toMatchObject({ state: 'backfilled', backfilledUnconfirmed: 1, confirmation: 'pending', historyThroughMessageId: 15 });
    expect(a.body.pending).toMatchObject({ outstanding: { kind: 'backfill', awaitingUserActivity: true } });
    expect(a.body.counts.byStatus['backfilled-unconfirmed']).toBe(1);
    for (const w of ['fold gate for the pilot', 'Warnings get ignored', 'the gate blocks', 'dashboard card']) expect(a.text).not.toContain(w);
    const m = await request(app).get('/context-budget/metrics').set('Authorization', `Bearer ${AUTH}`);
    expect(m.status).toBe(200);
    expect(m.body.anchors.backfill).toMatchObject({ topicsBackfilled: 1, backfilledUnconfirmed: 1, pendingConfirmations: 1, awaitingAsk: 1, asked: 0, pendingTopics: [String(T)], lane: { wired: true, dailyCap: 20, startedToday: 1 } });
    expect((await request(app).get('/context-budget/metrics')).status).toBe(401);
  });

  it('a lane on a machine that does not own the topic, or with an unknown owner, does no work', async () => {
    for (const owner of [false, 'unknown'] as const) {
      const r = await rig({ owner });
      await r.lane.tick();
      expect(r.layers.store.read(String(T), 'anchor', 'current')).toBeNull();
      expect(r.store.read(T).pending.outstanding).toBeNull();
      expect(r.lane.topicRecord(T)).toBeNull();
    }
  });

  it('switch off: the lane does no work and writes no state', async () => {
    const r = await rig({ on: false });
    expect(await r.lane.tick()).toMatchObject({ ran: false, reason: 'switch-off' });
    expect(r.layers.store.read(String(T), 'anchor', 'current')).toBeNull();
    expect(fs.existsSync(backfillStateFile(r.sd))).toBe(false);
  });
});
