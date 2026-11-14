// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the topic-intent layer is ALIVE on the production init path
 * (context-budget-layered-summaries Phase 1, §6, §6.4): with the layers on, the
 * boot path builds the layer store, wires the capture loop through
 * `wireLayerCapture` exactly as server.ts does, and a real turn produces an H1
 * whose freshness stamp the real briefing route serves; the layers' status
 * carries the budget and the ticker. With the layers off nothing is wired and
 * the briefing carries no stamp. Plus WIRED source checks on server.ts and
 * AgentServer.ts.
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
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import type { ExtractorInput } from '../../src/core/TopicIntentExtractor.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import { buildContextLayers, contextLayersEnabled } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-layer-topic-intent-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 141133;

describe('topic-intent layer — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ti-e2e-')); dirs.push(sd);
    const topicMemory = new TopicMemory(sd);
    await topicMemory.open();
    mems.push(topicMemory);
    const topicIntentStore = new TopicIntentStore(sd);
    // server.ts: the store, gated.
    const _contextLayers = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd }) : null;
    // server.ts: the capture block's layer wiring (dynamic import, same call shape).
    const layerWiring = _contextLayers
      ? (await import('../../src/monitoring/contextLayers/layerCaptureWiring.js')).wireLayerCapture({
          layers: _contextLayers, store: topicIntentStore, sessions: { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const },
          machine: 'm_e2e', projectDir: sd,
        })
      : null;
    const extractor = {
      async ingest(input: ExtractorInput) {
        const l = (g: string) => ({ goal: g, trend: 'on track', themes: ['e2e'] });
        topicIntentStore.updateAwareness(input.topicId, { topic: l('t'), recentArc: l('a'), currentWork: l('verify the layer path') }, {
          messageId: input.message.id, messageText: input.message.text, fromUser: input.message.fromUser, at: input.message.at, turn: input.message.turn,
        });
        return { emitted: [], createdRefs: [], awarenessInvalid: false, awarenessUpdated: true };
      },
    } as never;
    const captureLoop = createCaptureLoop({ ...(layerWiring ? layerWiring.captureDeps : {}), extractor, store: topicIntentStore, topicMemory });
    const ticker = layerWiring ? layerWiring.startTicker({ extractor, store: topicIntentStore, topicMemory }, { intervalMs: 3_600_000 }) : null;
    // AgentServer.ts: the briefing route with the freshness provider.
    const app = express();
    app.use(createTopicIntentRoutes({
      topicIntentStore,
      arcCheck: null,
      layerFreshness: _contextLayers ? (id: number) => _contextLayers.h1Freshness(id, topicMemory) : null,
    }));
    return { sd, topicMemory, captureLoop, app, layers: _contextLayers, ticker };
  }

  it('dev agent: a real turn produces H1 and the briefing serves its freshness stamp; status carries budget and ticker', async () => {
    const b = await boot({ developmentAgent: true });
    try {
      b.topicMemory.insertMessage({ messageId: 501, topicId: T, text: 'Verify the layer path end to end please', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
      const out = await b.captureLoop({ messageId: 501, topicId: T, text: 'Verify the layer path end to end please', fromUser: true, timestamp: Date.now() });
      expect(out.status).toBe('captured');
      expect(b.layers!.store.read(String(T), 'h1', 'current')?.data.goal).toBe('verify the layer path');
      const r = await request(b.app).get(`/topic-intent/${T}/briefing`);
      expect(r.status).toBe(200);
      expect(r.text).toMatch(/as of \S+, 0 messages behind/);
      const st = b.layers!.status();
      expect(st.budget.limits.perTopicDailyInputTokens).toBeGreaterThan(0);
      expect(st.ticker).not.toBeNull();
    } finally { b.ticker?.stop(); }
  });

  it('fleet agent: nothing wired, no layer records, and the briefing carries no stamp', async () => {
    const b = await boot({});
    b.topicMemory.insertMessage({ messageId: 7, topicId: T, text: 'An ordinary substantive request for the agent', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
    expect((await b.captureLoop({ messageId: 7, topicId: T, text: 'An ordinary substantive request for the agent', fromUser: true })).status).toBe('captured');
    expect(b.layers).toBeNull();
    expect(fs.existsSync(path.join(b.sd, 'state', 'context-layers'))).toBe(false);
    const r = await request(b.app).get(`/topic-intent/${T}/briefing`);
    expect(r.text).not.toContain('messages behind');
  });

  it('WIRED: server.ts wires the layer capture and ticker; AgentServer passes the freshness provider', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("(await import('../monitoring/contextLayers/layerCaptureWiring.js')).wireLayerCapture({");
    expect(src).toContain('...(layerWiring ? layerWiring.captureDeps : {}),');
    expect(src).toContain('layerWiring.startTicker({');
    expect(src).toContain("feature: 'contextBudget.layers.capture',");
    const as = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(as).toContain('options.contextLayers!.h1Freshness(topicId, options.topicMemory!)');
  });
});
