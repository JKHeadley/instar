// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the topic-intent layer on its real paths
 * (context-budget-layered-summaries §6 H1/H2, §6.4): a real TopicMemory, a
 * real TopicIntentStore, the real capture loop wired through
 * `wireLayerCapture` into a real layer store. A captured turn writes H1 with
 * its as-of; the briefing route serves the freshness stamp, which moves as
 * messages arrive; the budget defers (counted) instead of skipping silently;
 * a transcript-growth tick reaches the extractor with a bounded digest and
 * writes a tool-origin H1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicIntentStore } from '../../src/core/TopicIntent.js';
import { createCaptureLoop } from '../../src/core/TopicIntentCapture.js';
import type { ExtractorInput } from '../../src/core/TopicIntentExtractor.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireLayerCapture } from '../../src/monitoring/contextLayers/layerCaptureWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-layer-topic-intent.test.ts';
const T = 141133;
const dirs: string[] = [];
const mems: TopicMemory[] = [];
afterEach(() => {
  for (const m of mems.splice(0)) { try { m.close(); } catch { /* best-effort */ } }
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
});

/** An extractor stand-in that applies a real awareness update from the message text. */
function fakeExtractor(store: TopicIntentStore, seen: ExtractorInput[]) {
  return {
    async ingest(input: ExtractorInput) {
      seen.push(input);
      const layer = (g: string) => ({ goal: g, trend: 'steady', themes: ['build'] });
      store.updateAwareness(input.topicId, { topic: layer('topic goal'), recentArc: layer('phase goal'), currentWork: layer(`working: ${input.message.text.slice(0, 40)}`) }, {
        messageId: input.message.id, messageText: input.message.text, fromUser: input.message.fromUser, at: input.message.at, turn: input.message.turn,
      });
      return { emitted: [], createdRefs: [], awarenessInvalid: false, awarenessUpdated: true };
    },
  };
}

async function rig(limits?: { perTopicDailyInputTokens: number; componentDailyInputTokens: number }) {
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ti-')); dirs.push(sd);
  const memory = new TopicMemory(sd);
  await memory.open();
  mems.push(memory);
  const store = new TopicIntentStore(sd);
  const layers = buildContextLayers({ stateDir: sd });
  if (limits) (layers.budget as unknown as { o: { limits: () => typeof limits } }).o.limits = () => limits;
  const sessions = { listRunningSessions: () => [], checkSessionWorkState: async () => 'idle' as const };
  const wiring = wireLayerCapture({ layers, store, sessions, machine: 'm_it', projectDir: sd });
  const seen: ExtractorInput[] = [];
  const extractor = fakeExtractor(store, seen) as never;
  const loop = createCaptureLoop({ extractor, store, topicMemory: memory, ...wiring.captureDeps });
  const app = express();
  app.use(createTopicIntentRoutes({ topicIntentStore: store, layerFreshness: (id) => layers.h1Freshness(id, memory) }));
  let id = 100;
  const say = async (text: string, fromUser = true) => {
    id++;
    memory.insertMessage({ messageId: id, topicId: T, text, fromUser, timestamp: new Date(Date.now() + id).toISOString(), sessionName: null });
    return loop({ messageId: id, topicId: T, text, fromUser, timestamp: Date.now() });
  };
  return { sd, memory, store, layers, wiring, seen, extractor, app, say, lastId: () => id };
}

describe('topic-intent layer → layer store', () => {
  it('a captured turn writes H1 with author and as-of; the briefing carries a freshness stamp that moves with new messages', async () => {
    const r = await rig();
    const out = await r.say('Please build the layer store and wire the ticker next');
    expect(out.status).toBe('captured');
    const h1 = r.layers.store.read(String(T), 'h1', 'current')!;
    expect(h1.data.goal).toMatch(/^working: Please build the layer store/);
    expect(h1.asOf.lastMessageId).toBe(r.lastId());
    expect(h1.author.machine).toBe('m_it');
    let b = await request(r.app).get(`/topic-intent/${T}/briefing`);
    expect(b.text).toMatch(/as of \S+, 0 messages behind/);
    // Two more rows land without a capture (e.g. automation) → the stamp moves.
    r.memory.insertMessage({ messageId: 900, topicId: T, text: 'job notice', fromUser: false, timestamp: new Date(Date.now() + 5000).toISOString(), sessionName: null });
    r.memory.insertMessage({ messageId: 901, topicId: T, text: 'another notice', fromUser: false, timestamp: new Date(Date.now() + 6000).toISOString(), sessionName: null });
    b = await request(r.app).get(`/topic-intent/${T}/briefing`);
    expect(b.text).toMatch(/as of \S+, 2 messages behind/);
    expect(r.wiring.counts.projected).toBe(1);
  });

  it('over the per-topic ceiling a turn is deferred and counted, never silently skipped', async () => {
    const r = await rig({ perTopicDailyInputTokens: 1, componentDailyInputTokens: 1_000_000 });
    const out = await r.say('This substantive turn should be deferred by the budget brake');
    expect(out.status).toBe('deferred-budget');
    expect(r.seen).toHaveLength(0);
    expect(r.store.read(T).telemetry.capture?.budget_deferred).toBe(1);
    expect(r.layers.status().budget.deferred.topic).toBe(1);
  });

  it('a transcript-growth tick feeds a bounded, scrubbed digest and writes a tool-origin H1', async () => {
    const r = await rig();
    await r.say('Start the long tool-heavy refactor of the archive');
    const transcript = path.join(r.sd, 'session.jsonl');
    const line = (o: unknown) => JSON.stringify(o);
    fs.writeFileSync(transcript, line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n');
    const sessions = {
      listRunningSessions: () => [{ tmuxSession: 'tm', telegramTopicId: T, claudeSessionId: 'sid-1', framework: 'claude-code', cwd: r.sd }],
      checkSessionWorkState: async () => 'idle' as const,
    };
    const wiring = wireLayerCapture({ layers: r.layers, store: r.store, sessions, machine: 'm_it', projectDir: r.sd });
    const { ticker, stop } = wiring.startTicker({ extractor: r.extractor, store: r.store, topicMemory: r.memory }, { intervalMs: 3_600_000, baseMs: 0 });
    try {
      // Point the ticker at our transcript (the production resolver derives a path from the session id).
      (ticker as unknown as { d: { sessions: () => unknown[] } }).d.sessions = () => [{ topicId: T, sessionKey: 'sid-1', transcriptPath: transcript, tmuxSession: 'tm' }];
      await ticker.pass(); // baseline
      fs.appendFileSync(transcript, line({ type: 'user', message: { content: [{ type: 'tool_result', content: `compiled 12 files; key ghp_${'b'.repeat(36)}` }] } }) + '\n');
      await new Promise((res) => setTimeout(res, 5));
      await ticker.pass();
      expect(ticker.status().ticks).toBe(1);
      const tickInput = r.seen[r.seen.length - 1];
      expect(tickInput.message.fromUser).toBe(false);
      expect(tickInput.message.text).toMatch(/^\[transcript-growth tick: 1 of 1 recent tool results sampled, newest first; last tools: Bash\]/);
      expect(tickInput.message.text).not.toContain('b'.repeat(36));
      const h1 = r.layers.store.read(String(T), 'h1', 'current')!;
      expect(h1.data).toMatchObject({ origin: 'tool', disclosure: '1 results sampled' });
      expect(h1.status).toBe('tool');
      expect(r.store.read(T).telemetry.capture?.layer_ticks).toBe(1);
      expect(r.layers.status().ticker?.ticks).toBe(1);
    } finally { stop(); }
  });
});
