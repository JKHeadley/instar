// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — H3 is ALIVE on the production init path
 * (context-budget-layered-summaries §6 row H3, §6.5, §18 wiring integrity "H3
 * is the summary table's only writer when contextBudget.enabled is on"): with
 * server.ts's own gate expression the layers are built, the chunk builder and
 * H3 are constructed the way server.ts constructs them (queued intelligence
 * over the shared provider, here a fake; the chunk builder's closed events
 * request H3), and a PostCompact through the real routes ends with H3 in the
 * summary table: `POST /topic/summarize` returns it (200, writer h3) and
 * `POST /topic/summary` is 409. A fleet agent (layers off) keeps today's
 * writers. Plus WIRED source checks on server.ts, AgentServer.ts, routes.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextLayers, contextLayersEnabled, type ContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { ChunkBuilder } from '../../src/monitoring/contextLayers/chunkBuilder.js';
import { H3Builder } from '../../src/monitoring/contextLayers/h3Builder.js';
import { TopicSummaryTable } from '../../src/memory/TopicSummaryTable.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { createQueuedIntelligence } from '../../src/core/TopicIntentCapture.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-layer-h3-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'context-budget', 'claude-transcript-compacted.jsonl');
const CS = 'c1a2b3c4-0000-4000-8000-0000000000aa';
const T = 141133;
const CHUNK = JSON.stringify({ attempted: 'Added a route.', outcome: 'Clean after one fix.', artifacts: ['src/server/routes.ts'], openThreads: [], summary: 'Route added and typechecked.' });
const H3 = JSON.stringify({ purpose: 'Adding a route.', summary: 'The agent added a route and typechecked it.' });

describe('H3 — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  afterEach(() => {
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clh3-e2e-')); dirs.push(root);
    const sd = path.join(root, '.instar');
    fs.mkdirSync(sd);
    const configHome = path.join(root, 'claude-home');
    const topicMemory = new TopicMemory(sd); await topicMemory.open(); mems.push(topicMemory);
    topicMemory.insertMessage({ messageId: 1, topicId: T, text: 'add the route', fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
    // server.ts: the layers, gated.
    const _contextLayers: ContextLayers | null = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd, authToken: 'e2e-auth-token-0123456789' }) : null;
    const calls: string[] = [];
    const sharedIntelligence = { evaluate: async (p: string) => { calls.push(p); return p.includes('LONG-TERM VIEW') ? H3 : CHUNK; } };
    const queued = createQueuedIntelligence(sharedIntelligence, (_lane, fn) => fn());
    let _h3Builder: H3Builder | null = null;
    // server.ts: the chunk builder, whose closed / c2 events request H3.
    const _chunkBuilder = _contextLayers ? new ChunkBuilder({
      store: _contextLayers.store, archive: _contextLayers.archive, budget: _contextLayers.budget, intelligence: queued, machine: 'm_e2e',
      onEvent: (e) => { if (e.kind === 'closed' || e.kind === 'c2') _h3Builder?.request(e.topicKey, e.kind === 'c2' ? 'c2' : 'chunk'); },
    }) : null;
    // server.ts: H3 over the same queued intelligence, writing the table through the single-writer funnel.
    if (_contextLayers && _chunkBuilder) {
      const chunksRef = _chunkBuilder;
      _h3Builder = new H3Builder({
        store: _contextLayers.store, budget: _contextLayers.budget, intelligence: queued,
        table: new TopicSummaryTable(topicMemory, () => _contextLayers !== null),
        readSummary: (id) => topicMemory.getTopicSummary(id),
        countMessagesAfter: (id, m) => topicMemory.countMessagesAfter(id, m),
        messageCount: (id) => topicMemory.getMessageCount(id),
        requestRangeClose: (k) => chunksRef.maybeCloseRange(k),
        machine: 'm_e2e',
      });
    }
    const session = { id: 'inst-1', tmuxSession: 'echo-t', telegramTopicId: T, claudeSessionId: CS, framework: 'claude-code', cwd: root };
    const transcript = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: CS, projectDir: root, configHome });
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.copyFileSync(FIXTURE, transcript);
    const ctx = {
      config: { projectName: 'e2e', projectDir: root, stateDir: sd, port: 0, authToken: 'e2e-auth-token-0123456789' } as never,
      sessionManager: { listRunningSessions: () => [], getSessionById: (id: string) => (id === session.id ? session : undefined), configHomeForSession: () => configHome } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextLayers: _contextLayers, chunkBuilder: _chunkBuilder, h3Builder: _h3Builder,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return { app, layers: _contextLayers, chunks: _chunkBuilder, h3: _h3Builder, calls, topicMemory };
  }

  it('dev agent: a PostCompact ends with H3 in the summary table; summarize returns it (writer h3); a second writer gets 409', async () => {
    const b = await boot({ developmentAgent: true });
    const res = await request(b.app).post('/hooks/post-compact').set('X-Instar-Session-Id', 'inst-1')
      .send({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'auto', compact_summary: 'summary' });
    expect(res.body).toMatchObject({ recorded: true, chunk: 'enqueued' });
    await new Promise((r) => setImmediate(r));
    await b.chunks!.idle();
    await b.h3!.idle();
    expect(b.calls.filter((c) => c.includes('LONG-TERM VIEW'))).toHaveLength(1);
    const s = await request(b.app).post('/topic/summarize').send({ topicId: T });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ writer: 'h3', purpose: 'Adding a route.', h3: { status: 'live' } });
    expect(s.body.currentSummary).toContain('The agent added a route and typechecked it.');
    expect(b.topicMemory.getTopicSummary(T)!.summary).toBe(s.body.currentSummary);
    const w = await request(b.app).post('/topic/summary').send({ topicId: T, summary: 'second writer', messageCount: 1, lastMessageId: 1 });
    expect(w.status).toBe(409);
    expect(w.body.error).toBe('summary-written-by-h3');
    expect((await request(b.app).get('/context-budget/layers')).body.h3).toMatchObject({ written: 1, tableWrites: 1 });
  });

  it('fleet agent: no layers, no H3; POST /topic/summary saves as before', async () => {
    const b = await boot({});
    expect(b.layers).toBeNull();
    expect(b.h3).toBeNull();
    const w = await request(b.app).post('/topic/summary').send({ topicId: T, summary: 'legacy writer', messageCount: 1, lastMessageId: 1 });
    expect(w.status).toBe(200);
    expect(b.topicMemory.getTopicSummary(T)!.summary).toBe('legacy writer');
    expect((await request(b.app).post('/topic/summarize').send({ topicId: T })).body.writer).toBeUndefined();
  });

  it('WIRED: server.ts builds H3 next to the chunks, requests it on chunk events, passes it, and turns the summarizer off under the layers', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("const { H3Builder, H3_COMPONENT } = await import('../monitoring/contextLayers/h3Builder.js');");
    expect(src).toContain("if (e.kind === 'closed' || e.kind === 'c2') _h3Builder?.request(e.topicKey, e.kind === 'c2' ? 'c2' : 'chunk');");
    expect(src).toContain('table: topicMemory ? new TopicSummaryTable(topicMemory, () => _contextLayers !== null) : null,');
    expect(src).toContain('requestRangeClose: (topicKey) => chunksRef.maybeCloseRange(topicKey),');
    expect(src).toContain('h3Builder: _h3Builder ?? undefined,');
    expect(src).toMatch(/if \(_contextLayers\) \{\n\s+console\.log\(pc\.dim\('  Topic auto-summarization handed to H3/);
    expect(src).toContain('new TopicSummarizer(summaryIntelligence, topicMemory, undefined, new LegacySummaryTable(topicMemory, () => _contextLayers !== null))');
    const as = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(as).toContain('h3Builder: options.h3Builder ?? null,');
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("const table = new TopicSummaryTable(ctx.topicMemory, () => !!ctx.contextLayers);");
    expect(routes).toContain("res.status(409).json({ error: 'summary-written-by-h3', reason: H3_OWNS_REASON, topicId });");
    expect(routes).toContain('res.json(h3SummarizeView(ctx.contextLayers.store, ctx.topicMemory, topicId));');
  });
});
