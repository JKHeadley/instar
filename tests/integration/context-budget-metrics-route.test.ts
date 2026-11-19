// safe-fs-allow: test file — temp dirs via mkdtemp, removed through SafeFsExecutor.
// safe-git-allow: test file — no git calls.
/**
 * Integration — GET /context-budget/metrics (context-budget-layered-summaries
 * §11, Phase 1 S13) through the real router behind the real auth middleware:
 * a real TokenLedger scanning fixture transcripts in TWO config homes (the
 * default and a follow-me login), a real TopicMemory and TopicIntentStore, the
 * real layer store, and the capture loop wired through `wireLayerCapture` so
 * the per-trigger rollup and the LayerUpdate feature rows are real. 401
 * without the bearer, 503 when the layers are off, 400 on a bad query.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { claudeTranscriptRoots } from '../../src/monitoring/claudeTranscriptRoots.js';
import { buildContextLayers, type ContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireLayerCapture } from '../../src/monitoring/contextLayers/layerCaptureWiring.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { createCaptureLoop, captureTick } from '../../src/core/TopicIntentCapture.js';
import type { ExtractorInput } from '../../src/core/TopicIntentExtractor.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { setFeatureMetricsRecorder } from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-budget-metrics-route.test.ts';
const TOKEN = 'it-token-0123456789abcdef';
const TOPIC = 4242;
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const T0 = Date.now() - 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function req(n: number, tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = []) {
  return JSON.stringify({
    type: 'assistant', sessionId: SID, cwd: '/agent', timestamp: iso(T0 + n * 1000), uuid: `a-${n}`, requestId: `req-${n}`,
    message: { id: `m-${n}`, model: 'claude-opus-5-5', content: tools.map((t) => ({ type: 'tool_use', ...t })),
      usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, cache_creation: { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 } } },
  });
}
const prompt = (n: number, text: string) => JSON.stringify({ type: 'user', sessionId: SID, timestamp: iso(T0 + n * 1000), uuid: `u-${n}`, message: { role: 'user', content: `[telegram:${TOPIC} "t"] ${text}` } });

describe('GET /context-budget/metrics — integration', () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    setFeatureMetricsRecorder(null);
    for (const c of closers.splice(0)) { try { c(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  function app(ctxPart: Partial<RouteContext> & { stateDir: string; contextLayers: ContextLayers | null }) {
    const ctx = {
      config: { projectName: 'it', projectDir: ctxPart.stateDir, stateDir: ctxPart.stateDir, port: 0, authToken: TOKEN } as never,
      sessionManager: { listRunningSessions: () => [] } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      tokenLedger: null, featureMetricsLedger: null,
      startTime: new Date(), ...ctxPart,
    } as unknown as RouteContext;
    const a = express();
    a.use(express.json());
    a.use(authMiddleware(TOKEN));
    a.use('/', createRoutes(ctx));
    return a;
  }

  async function rig() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-it-')); dirs.push(home);
    const sd = path.join(home, '.instar'); fs.mkdirSync(sd);
    // Two config homes: the default holds the first part, a follow-me copy the whole session.
    const pa = path.join(home, '.claude', 'projects', '-agent'); const pb = path.join(home, '.claude-followme-acct', 'projects', '-agent');
    fs.mkdirSync(pa, { recursive: true }); fs.mkdirSync(pb, { recursive: true });
    const lines = [
      prompt(0, 'check the build'),
      req(1, [{ id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }]),
      req(2, [{ id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
      req(3, [{ id: 't3', name: 'Read', input: { file_path: '/repo/a.ts' } }]),
      prompt(4, 'now the docs'),
      req(5, [{ id: 't4', name: 'Bash', input: { command: 'npm run lint' } }]),
    ];
    fs.writeFileSync(path.join(pa, `${SID}.jsonl`), lines.slice(0, 3).join('\n') + '\n');
    fs.writeFileSync(path.join(pb, `${SID}.jsonl`), lines.join('\n') + '\n');
    const ledger = new TokenLedger({ dbPath: path.join(sd, 'server-data', 'token-ledger.db'), attributionBackfill: 'off', claudeProjectsDirs: () => claudeTranscriptRoots({ home, defaultHome: path.join(home, '.claude') }) });
    closers.push(() => ledger.close());
    ledger.scanAll();

    const memory = new TopicMemory(sd); await memory.open(); closers.push(() => memory.close());
    memory.insertMessage({ messageId: 1, topicId: TOPIC, text: 'check the build', fromUser: true, timestamp: iso(T0), sessionName: null });
    memory.insertMessage({ messageId: 2, topicId: TOPIC, text: 'now the docs', fromUser: true, timestamp: iso(T0 + 4000), sessionName: null });
    memory.insertMessage({ messageId: 3, topicId: TOPIC, text: 'agent reply', fromUser: false, timestamp: iso(T0 + 5000), sessionName: null });
    const store = new TopicIntentStore(sd);
    const layers = buildContextLayers({ stateDir: sd });
    const fm = new FeatureMetricsLedger({ dbPath: ':memory:' }); closers.push(() => fm.close?.());
    setFeatureMetricsRecorder(fm);
    const wiring = wireLayerCapture({ layers, store, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const }, machine: 'm_it', projectDir: sd });
    const extractor = {
      async ingest(input: ExtractorInput) {
        // The real extract fn reports provider usage through this observer.
        wiring.onExtractUsage(input, { inputTokens: 1500, outputTokens: 90 });
        const l = (g: string) => ({ goal: g, trend: 'steady', themes: ['it'] });
        store.updateAwareness(input.topicId, { topic: l('t'), recentArc: l('a'), currentWork: l(`work ${input.message.id}`) }, { messageId: input.message.id, messageText: input.message.text, fromUser: input.message.fromUser, at: input.message.at, turn: input.message.turn });
        return { emitted: [], createdRefs: [], awarenessInvalid: false, awarenessUpdated: true };
      },
    } as never;
    const loop = createCaptureLoop({ ...wiring.captureDeps, extractor, store, topicMemory: memory });
    expect((await loop({ messageId: 1, topicId: TOPIC, text: 'check the build and tell me what broke', fromUser: true, timestamp: Date.now() })).status).toBe('captured');
    expect((await captureTick({ ...wiring.captureDeps, extractor, store, topicMemory: memory }, TOPIC, '[transcript-growth tick: 1 of 1]')).status).toBe('captured');
    return { sd, ledger, layers, memory, store, fm };
  }

  it('401 without the bearer; 503 when the layers are off', async () => {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-it-off-')); dirs.push(sd);
    expect((await request(app({ stateDir: sd, contextLayers: null })).get('/context-budget/metrics')).status).toBe(401);
    const r = await request(app({ stateDir: sd, contextLayers: null })).get('/context-budget/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(503);
    expect(r.body.enableWith).toBe('contextBudget.enabled');
  });

  it('200 with per-session and per-topic numbers from two config homes, the per-trigger rollup and the LayerUpdate rows', async () => {
    const b = await rig();
    const a = app({ stateDir: b.sd, contextLayers: b.layers, tokenLedger: b.ledger, topicMemory: b.memory, topicIntentStore: b.store } as never);
    const r = await request(a).get(`/context-budget/metrics?topic=${TOPIC}&sinceHours=48`).set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.ledger.roots).toHaveLength(2);
    expect(r.body.sessions).toHaveLength(1);
    const s = r.body.sessions[0];
    expect(s.topicId).toBe(TOPIC);
    expect(s.cost.requests).toBe(4); // deduped across the two homes
    expect(s.cost.perRequest.inputWeighted).toBe(2 + 4_000 + 4_000);
    expect(s.liveContext.latest).toBe(42_002);
    expect(s.rework).toMatchObject({ status: 'ok', toolInputs: 4, repeats: 1, rate: 0.25 });
    expect(s.operatorMessages).toMatchObject({ delivered: 2, verbatimInContext: 2, share: 1, compactions: 0 });
    const t = r.body.topics.find((x: { topicId: number }) => x.topicId === TOPIC);
    expect(t.u).toMatchObject({ messages: 2, chars: 'check the build'.length + 'now the docs'.length });
    expect(t.extractor).toMatchObject({ extractions_attempted: 2, layer_ticks: 1 });
    expect(t.layerBytes).toBeGreaterThan(0);
    expect(t.layerUpdate.inputTokens24h).toBeGreaterThan(0);
    const day = r.body.extractorByDay.at(-1);
    expect(day.turn).toMatchObject({ attempts: 1, calls: 1, updated: 1, measuredCalls: 1, tokensIn: 1500 });
    expect(day.tick).toMatchObject({ attempts: 1, calls: 1, updated: 1, measuredCalls: 1, tokensOut: 90 });
    expect(r.body.anchors).toMatchObject({ source: 'layer store on this machine', ledger: { scope: 'listed-topics' } });
    expect(r.body.anchors).not.toHaveProperty('unavailable');
    expect(r.body.layerUpdate.reserve.componentDailyInputTokens).toBeGreaterThan(0);
    const row = b.fm.summary({}).features.find((f) => f.feature === 'LayerUpdate');
    expect(row).toBeDefined();
    expect(row!.fired).toBe(2);
  });

  it('400 on a bad query; an unknown topic is an empty, bounded answer', async () => {
    const b = await rig();
    const a = app({ stateDir: b.sd, contextLayers: b.layers, tokenLedger: b.ledger } as never);
    expect((await request(a).get('/context-budget/metrics?topic=abc').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(400);
    const r = await request(a).get('/context-budget/metrics?topic=999').set('Authorization', `Bearer ${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.sessions).toEqual([]);
    expect(r.body.topics[0]).toMatchObject({ topicId: 999, u: { unavailable: 'topic-memory-not-wired' } });
  });
});
