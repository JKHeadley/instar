// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — chunks are ALIVE on the production init path
 * (context-budget-layered-summaries §6.5, §9.5, §7.6): with server.ts's own
 * gate expression the layers are built, the chunk builder is constructed the
 * way server.ts constructs it (queued intelligence wrapper over the shared
 * provider, here a fake), and a PostCompact for a session with a real
 * transcript file through the real routes produces an archive entry and a
 * chunk that `GET /topic/:id/chunks` returns (200, not 503). A fleet agent
 * (layers off) gets 503 and nothing on disk. Plus WIRED source checks on
 * server.ts, AgentServer.ts, routes.ts and the CapabilityIndex.
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
import { createQueuedIntelligence } from '../../src/core/TopicIntentCapture.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-layer-chunks-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'context-budget', 'claude-transcript-compacted.jsonl');
const CS = 'c1a2b3c4-0000-4000-8000-0000000000aa';
const T = 141133;
const REPLY = JSON.stringify({ attempted: 'Added a route.', outcome: 'Clean after one fix.', artifacts: ['src/server/routes.ts'], openThreads: [], summary: 'Route added and typechecked.' });

describe('context layer chunks — alive on the production init path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clch-e2e-')); dirs.push(root);
    const sd = path.join(root, '.instar');
    fs.mkdirSync(sd);
    const configHome = path.join(root, 'claude-home');
    // server.ts: the layers, gated.
    const _contextLayers: ContextLayers | null = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd, authToken: 'e2e-auth-token-0123456789' }) : null;
    // server.ts: the chunk builder, over the queued shared intelligence (a fake provider; a pass-through queue).
    const calls: string[] = [];
    const sharedIntelligence = { evaluate: async (p: string) => { calls.push(p); return REPLY; } };
    const _chunkBuilder = _contextLayers ? new ChunkBuilder({
      store: _contextLayers.store, archive: _contextLayers.archive, budget: _contextLayers.budget,
      intelligence: createQueuedIntelligence(sharedIntelligence, (_lane, fn) => fn()),
      machine: 'm_e2e',
    }) : null;
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
      triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
      startTime: new Date(), contextLayers: _contextLayers, chunkBuilder: _chunkBuilder,
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return { sd, app, layers: _contextLayers, builder: _chunkBuilder, calls };
  }

  const postCompact = (app: express.Express) => request(app).post('/hooks/post-compact').set('X-Instar-Session-Id', 'inst-1')
    .send({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'auto', compact_summary: 'summary' });

  it('dev agent: a PostCompact produces an archive entry and a chunk that GET /topic/:id/chunks returns', async () => {
    const b = boot({ developmentAgent: true });
    const res = await postCompact(b.app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recorded: true, chunk: 'enqueued' });
    await new Promise((r) => setImmediate(r));
    await b.builder!.idle();
    const idx = b.layers!.archive.readIndex(String(T));
    expect(idx.spans).toHaveLength(1);
    expect(idx.spans[0].entries).toBe(7);
    const list = await request(b.app).get(`/topic/${T}/chunks`);
    expect(list.status).toBe(200);
    const span = list.body.items.find((i: { kind: string }) => i.kind === 'span');
    expect(span).toMatchObject({ status: 'closed', key: idx.spans[0].spanId, spans: [{ spanId: idx.spans[0].spanId, state: 'present' }] });
    expect(b.calls).toHaveLength(1);
    const layersStatus = await request(b.app).get('/context-budget/layers');
    expect(layersStatus.body.chunks).toMatchObject({ enqueued: 1, closed: 1 });
  });

  it('fleet agent: no layers, no builder, 503 and nothing on disk', async () => {
    const b = boot({});
    expect(b.layers).toBeNull();
    expect((await postCompact(b.app)).body).toMatchObject({ recorded: true, chunk: 'off' });
    expect((await request(b.app).get(`/topic/${T}/chunks`)).status).toBe(503);
    expect(fs.existsSync(path.join(b.sd, 'state', 'context-archive'))).toBe(false);
  });

  it('WIRED: server.ts constructs the builder over the queued shared intelligence and passes it; AgentServer and routes carry it; the capability row lists the routes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("const { ChunkBuilder, CHUNK_COMPONENT } = await import('../monitoring/contextLayers/chunkBuilder.js');");
    expect(src).toContain('intelligence: sharedIntelligence ? queuedForChunks(sharedIntelligence, (lane, fn, costCents) => sharedLlmQueue.enqueue(lane, fn, costCents)) : null,');
    expect(src).toContain('chunkBuilder: _chunkBuilder ?? undefined,');
    expect(src).toContain("feature: 'contextBudget.layers.chunks',");
    const as = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(as).toContain('chunkBuilder: options.chunkBuilder ?? null,');
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("chunkBuilder.enqueue({ topicKey, transcriptPath, sessionKey: engineSessionId, trigger: 'post-compact', upTo: 'last-compact-boundary', sessionId: instarSessionId });");
    expect(routes).toContain("router.get('/topic/:id/chunks', (req, res) => {");
    expect(routes).toContain("router.get('/topic/:id/chunks/:k', (req, res) => {");
    const ci = fs.readFileSync(path.join(ROOT, 'src/server/CapabilityIndex.ts'), 'utf-8');
    expect(ci).toContain("'GET /topic/:id/chunks', 'GET /topic/:id/chunks/:k'");
  });
});
