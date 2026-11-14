// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the ContextBudgetSentinel's §17 rows through the real routes
 * (context-budget-layered-summaries §7.8, §17, Phase 1 S12):
 *  - a stale H1 (real TopicMemory, real capture loop, real layer store) leads
 *    to a rebuild request through the capture wiring's re-projection seam,
 *    which brings H1 back within target; the route shows it;
 *  - an orphan fold hold is cleared loudly: the file is gone, the outbound
 *    check no longer holds, and the real DegradationReporter has the row;
 *  - GET /context-budget/sentinel carries all three rows.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ContextBudgetSentinel, ORPHAN_GRACE_MS } from '../../src/monitoring/ContextBudgetSentinel.js';
import { buildFoldCoordinator, buildFoldHolds } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { productionHoldCarriers } from '../../src/monitoring/contextBudgetSentinelBoot.js';
import { InMemorySelfHealEpisodeStore } from '../../src/core/SelfHealGate.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import type { ExtractorInput } from '../../src/core/TopicIntentExtractor.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireLayerCapture } from '../../src/monitoring/contextLayers/layerCaptureWiring.js';
import type { AdmissionToken } from '../../src/monitoring/selfaction/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-budget-sentinel-rows.test.ts';
const T = 141133;
const allow = async () => ({ outcome: 'allow' as const, token: { id: 't' } as AdmissionToken, reason: 'admitted' as const });

function appFor(stateDir: string, sentinel: ContextBudgetSentinel): express.Express {
  const ctx = {
    config: { projectName: 'echo', projectDir: stateDir, stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
    contextBudgetSentinel: sentinel,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

function fakeExtractor(store: TopicIntentStore) {
  return {
    async ingest(input: ExtractorInput) {
      const layer = (g: string) => ({ goal: g, trend: 'steady', themes: ['build'] });
      store.updateAwareness(input.topicId, { topic: layer('topic goal'), recentArc: layer('phase goal'), currentWork: layer(`working: ${input.message.text.slice(0, 40)}`) }, {
        messageId: input.message.id, messageText: input.message.text, fromUser: input.message.fromUser, at: input.message.at, turn: input.message.turn,
      });
      return { emitted: [], createdRefs: [], awarenessInvalid: false, awarenessUpdated: true };
    },
  };
}

describe('ContextBudgetSentinel §17 rows through the real routes', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  beforeEach(() => DegradationReporter.resetForTesting());
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function rig() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rows-it-')); dirs.push(stateDir);
    const memory = new TopicMemory(stateDir); await memory.open(); mems.push(memory);
    const intent = new TopicIntentStore(stateDir);
    const layers = buildContextLayers({ stateDir });
    const wiring = wireLayerCapture({ layers, store: intent, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const }, machine: 'm_it', projectDir: stateDir });
    const extractor = fakeExtractor(intent) as never;
    const wired = createCaptureLoop({ extractor, store: intent, topicMemory: memory, ...wiring.captureDeps });
    // The same extraction WITHOUT the projection hook: a turn whose layer write never happened.
    const unwired = createCaptureLoop({ extractor, store: intent, topicMemory: memory });
    let id = 100;
    const say = async (text: string, loop: typeof wired | null) => {
      id++;
      memory.insertMessage({ messageId: id, topicId: T, text, fromUser: true, timestamp: new Date(Date.now() + id).toISOString(), sessionName: null });
      if (loop) await loop({ messageId: id, topicId: T, text, fromUser: true, timestamp: Date.now() });
    };
    const built = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [{ topicKey: String(T) }], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => false, layerKindPresent: () => true });
    const holds = buildFoldHolds({ stateDir });
    let now = Date.now();
    const requests: string[] = [];
    const sentinel = new ContextBudgetSentinel({
      stateDir, machineId: built.holderId, coordinator: built.coordinator, store: new FoldRecordStore(stateDir),
      ownsFold: () => true, ownsTopic: () => true, candidates: () => [], tmuxAlive: () => false, kill: () => {}, fileBytes: () => null, attention: () => {},
      admit: allow, consumeToken: () => ({ proceed: true, valid: true }), episodeStore: new InMemorySelfHealEpisodeStore(),
      now: () => now,
      liveTopics: () => [String(T)],
      layers: {
        h1: (t) => layers.h1Freshness(Number(t), memory),
        requestRebuild: (t) => { requests.push(t); return wiring.reproject(Number(t)); },
      },
      holdHealth: { carriers: productionHoldCarriers({ stateDir, holds }), admit: allow, degradation: (r) => DegradationReporter.getInstance().report(r) },
    });
    return { stateDir, memory, intent, layers, wiring, wired, unwired, say, holds, sentinel, requests, advance: (ms: number) => { now += ms; }, app: appFor(stateDir, sentinel) };
  }

  it('a stale H1 leads to a rebuild request through the seam, which brings it back within target', async () => {
    const r = await rig();
    await r.say('Start the layer store work', r.wired);
    expect(r.layers.h1Freshness(T, r.memory)?.stale).toBe(false);
    // Three user turns whose projection never ran (the awareness moved, the layer did not).
    for (const t of ['add the archive', 'then the ticker', 'now the sentinel rows']) await r.say(t, r.unwired);
    expect(r.layers.h1Freshness(T, r.memory)).toMatchObject({ stale: true, userTurnsBehind: 3 });

    await r.sentinel.tick();
    expect(r.requests).toEqual([String(T)]);
    expect(r.layers.h1Freshness(T, r.memory)?.stale).toBe(false);
    expect(r.layers.store.read(String(T), 'h1', 'current')?.data.goal).toMatch(/^working: now the sentinel rows/);
    let body = (await request(r.app).get('/context-budget/sentinel')).body;
    expect(body.layerFreshness.topics[0]).toMatchObject({ topicKey: String(T), rebuildRequests: 1, lastRebuild: 'reprojected' });

    // The next tick reads it fresh: the episode is over.
    r.advance(5 * 60_000); await r.sentinel.tick();
    body = (await request(r.app).get('/context-budget/sentinel')).body;
    expect(body.layerFreshness.counts).toMatchObject({ topics: 1, fresh: 1, stale: 0 });
    expect(body.layerFreshness.topics[0]).toMatchObject({ staleSince: null, rebuildRequests: 0 });
  });

  it('when the awareness itself is behind, the seam writes nothing and says so (counted, no layer write)', async () => {
    const r = await rig();
    await r.say('Start the layer store work', r.wired);
    const before = r.layers.store.read(String(T), 'h1', 'current');
    for (const t of ['one', 'two', 'three']) await r.say(t, null); // no capture at all
    await r.sentinel.tick();
    expect(r.requests).toHaveLength(1);
    expect(r.layers.store.read(String(T), 'h1', 'current')).toEqual(before);
    const body = (await request(r.app).get('/context-budget/sentinel')).body;
    expect(body.layerFreshness.topics[0]).toMatchObject({ h1: { stale: true }, lastRebuild: 'awareness-behind' });
  });

  it('an orphan fold hold is cleared loudly: gone from disk, no longer held, and a degradation row', async () => {
    const r = await rig();
    expect(r.holds.write(String(T), 'foldgone', Date.now() + 60_000)).toBe(true);
    expect(r.holds.check(String(T))).toMatchObject({ held: true });
    r.advance(ORPHAN_GRACE_MS + 60_000);
    await r.sentinel.tick();
    expect(fs.existsSync(path.join(r.stateDir, 'state', 'context-layers', String(T), 'fold-hold.json'))).toBe(false);
    expect(r.holds.check(String(T))).toEqual({ held: false });
    const rows = DegradationReporter.getInstance().getEvents().filter((e) => e.feature === 'ContextBudgetSentinel.holdHealth');
    expect(rows).toHaveLength(1);
    expect(rows[0].fallback).toContain('foldgone');
    const body = (await request(r.app).get('/context-budget/sentinel')).body;
    expect(body.holdHealth.counts).toMatchObject({ cleared: 1, clearedTotal: 1 });
    expect(body.holdHealth.recentClears[0]).toMatchObject({ kind: 'fold-hold', foldId: 'foldgone' });
  });

  it('the status route carries all three rows', async () => {
    const r = await rig();
    await r.say('hello', r.wired);
    await r.sentinel.tick();
    const res = await request(r.app).get('/context-budget/sentinel');
    expect(res.status).toBe(200);
    expect(res.body.heartbeatFresh).toBe(true);
    expect(res.body.layerFreshness).toMatchObject({ state: 'ok', counts: { topics: 1 } });
    expect(res.body.layerFreshness.topics[0].h3).toEqual({ state: 'unavailable', reason: 'h3-not-built' });
    expect(res.body.holdHealth).toMatchObject({ state: 'ok', graceMs: ORPHAN_GRACE_MS, counts: { carriers: 0 } });
    expect(res.body.eligibleWithoutFold).toMatchObject({ state: 'ok', counts: { topics: 1, unknown: 1, foldedRecently: 0 } });
    expect(res.body.eligibleWithoutFold.topics[0].reason).toMatch(/^no-benefit-estimator/);
  });
});
