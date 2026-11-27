// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — H3 as the topic summary table's single writer
 * (context-budget-layered-summaries §6 row H3, §6.5, §18 tier 2 "POST
 * /topic/summary refusing under the switch") through the REAL AgentServer and
 * routes, with a real TopicMemory: a PostCompact on a real Claude Code
 * transcript fixture produces a chunk, the chunk triggers H3, H3 writes the
 * summary table, `POST /topic/summarize` returns it with `writer: h3`, and
 * `POST /topic/summary` returns 409. With the layers off both routes behave
 * exactly as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { ChunkBuilder } from '../../src/monitoring/contextLayers/chunkBuilder.js';
import { H3Builder } from '../../src/monitoring/contextLayers/h3Builder.js';
import { TopicSummaryTable } from '../../src/memory/TopicSummaryTable.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { InstarConfig } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-h3.test.ts';
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'context-budget', 'claude-transcript-compacted.jsonl');
const TOKEN = 'h3-it-token-0123456789abcdef0123';
const CS = 'c1a2b3c4-0000-4000-8000-0000000000aa';
const TOPIC = 141133;
const CHUNK_REPLY = JSON.stringify({ attempted: 'Added the bounded chunk lookup route.', outcome: 'A missing import broke the typecheck; fixed, clean.', artifacts: ['src/server/routes.ts'], openThreads: [], summary: 'The agent added the route, hit a TS2304, fixed the import.' });
const H3_REPLY = JSON.stringify({ purpose: 'Adding the chunk lookup route for the context budget.', summary: 'The agent added the bounded chunk lookup route and fixed a missing import.' });

describe('H3 — the topic summary table\'s single writer, real AgentServer', () => {
  const dirs: string[] = [];
  const servers: AgentServer[] = [];
  const mems: TopicMemory[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(o: { layers: boolean }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-it-')); dirs.push(root);
    const stateDir = path.join(root, '.instar');
    const configHome = path.join(root, 'claude-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'h3-it' }));
    const config = {
      projectName: 'h3-it', projectDir: root, stateDir, port: 0, authToken: TOKEN, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, secrets: { forceFileKey: true },
    } as unknown as InstarConfig;
    const session = { id: 'inst-topic', tmuxSession: 'echo-topic', telegramTopicId: TOPIC, claudeSessionId: CS, framework: 'claude-code', cwd: root };
    const sessionManager = {
      listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null, getSessionById: (id: string) => (id === session.id ? session : undefined), setClaudeSessionId: () => undefined,
      configHomeForSession: () => configHome,
    };
    const transcript = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: CS, projectDir: root, configHome });
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.copyFileSync(FIXTURE, transcript);
    const topicMemory = new TopicMemory(stateDir); await topicMemory.open(); mems.push(topicMemory);
    for (let i = 1; i <= 5; i++) topicMemory.insertMessage({ messageId: i, topicId: TOPIC, text: `message ${i}`, fromUser: i % 2 === 1, timestamp: new Date(Date.UTC(2026, 10, 10, 12, 0, i)).toISOString(), sessionName: null });
    topicMemory.saveTopicSummary(TOPIC, 'The legacy rolling summary.', 3, 3, 'Legacy purpose');
    const layers = o.layers ? buildContextLayers({ stateDir, authToken: TOKEN }) : undefined;
    const calls: string[] = [];
    const intelligence = { evaluate: async (p: string) => { calls.push(p); return p.includes('LONG-TERM VIEW') ? H3_REPLY : CHUNK_REPLY; } };
    let h3Builder: H3Builder | undefined;
    // Wired as server.ts wires it: a closed chunk / range requests an H3 rebuild.
    const chunkBuilder = layers ? new ChunkBuilder({
      store: layers.store, archive: layers.archive, budget: layers.budget, machine: 'm_it', intelligence,
      onEvent: (e) => { if (e.kind === 'closed' || e.kind === 'c2') h3Builder?.request(e.topicKey, e.kind === 'c2' ? 'c2' : 'chunk'); },
    }) : undefined;
    h3Builder = layers ? new H3Builder({
      store: layers.store, budget: layers.budget, intelligence, machine: 'm_it',
      table: new TopicSummaryTable(topicMemory, () => !!layers),
      readSummary: (id) => topicMemory.getTopicSummary(id),
      countMessagesAfter: (id, m) => topicMemory.countMessagesAfter(id, m),
      messageCount: (id) => topicMemory.getMessageCount(id),
      requestRangeClose: (k) => chunkBuilder!.maybeCloseRange(k),
    }) : undefined;
    const server = new AgentServer({
      config, sessionManager: sessionManager as never, state: new StateManager(stateDir), topicMemory,
      hookEventReceiver: new HookEventReceiver({ stateDir, resolveCurrentInstarSessionId: () => null, isLiveInstarSession: () => false }),
      subagentTracker: new SubagentTracker({ stateDir }),
      contextLayers: layers, chunkBuilder, h3Builder,
    });
    await server.start();
    servers.push(server);
    return { server, layers, chunkBuilder, h3Builder, calls, topicMemory };
  }

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);

  it('layers on: PostCompact → chunk → H3 → summary table; summarize returns writer h3; POST /topic/summary is 409', async () => {
    const b = await boot({ layers: true });
    const app = b.server.getApp();
    // Before H3 has built: summarize already says writer h3, shows the legacy text, never asks for a write.
    const before = await auth(request(app).post('/topic/summarize')).send({ topicId: TOPIC });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ writer: 'h3', needsUpdate: false, currentSummary: 'The legacy rolling summary.', h3: { status: 'not-built-yet' }, messages: [] });

    const pc = await auth(request(app).post('/hooks/post-compact')).set('X-Instar-Session-Id', 'inst-topic')
      .send({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'auto', compact_summary: 'we added the route' });
    expect(pc.body).toMatchObject({ recorded: true, chunk: 'enqueued' });
    await new Promise((r) => setImmediate(r));
    await b.chunkBuilder!.idle();
    await b.h3Builder!.idle();
    expect(b.calls.filter((c) => c.includes('LONG-TERM VIEW'))).toHaveLength(1);

    const row = b.topicMemory.getTopicSummary(TOPIC)!;
    expect(row.summary).toContain('The agent added the bounded chunk lookup route and fixed a missing import.');
    expect(row.summary).toMatch(/^\[Long-term view \(H3\), as of /);
    expect(row.purpose).toBe('Adding the chunk lookup route for the context budget.');
    expect(b.layers!.store.read(String(TOPIC), 'h3', 'legacy-retired')!.data).toMatchObject({ summary: 'The legacy rolling summary.' });

    const after = await auth(request(app).post('/topic/summarize')).send({ topicId: TOPIC });
    expect(after.body).toMatchObject({ writer: 'h3', needsUpdate: false, purpose: 'Adding the chunk lookup route for the context budget.', h3: { status: 'live' } });
    expect(after.body.currentSummary).toBe(row.summary);
    expect(after.body.h3.freshness).toMatch(/^as of /);

    const refused = await auth(request(app).post('/topic/summary')).send({ topicId: TOPIC, summary: 'A second writer.', messageCount: 5, lastMessageId: 5 });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'summary-written-by-h3', topicId: TOPIC });
    expect(refused.body.reason).toMatch(/only by the H3 layer/);
    expect(b.topicMemory.getTopicSummary(TOPIC)!.summary).toBe(row.summary);

    const status = await auth(request(app).get('/context-budget/layers'));
    expect(status.body.h3).toMatchObject({ written: 1, tableWrites: 1, legacyRetired: 1 });
    const caps = await auth(request(app).get('/capabilities'));
    expect(JSON.stringify(caps.body)).toContain('409 summary-written-by-h3 while the context layers are on');
  });

  it('layers off (fleet default): POST /topic/summary saves and summarize returns the legacy shape, exactly as before', async () => {
    const b = await boot({ layers: false });
    const app = b.server.getApp();
    const saved = await auth(request(app).post('/topic/summary')).send({ topicId: TOPIC, summary: 'Written by a session.', messageCount: 5, lastMessageId: 5, purpose: 'p' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ saved: true, topicId: TOPIC });
    expect(b.topicMemory.getTopicSummary(TOPIC)).toMatchObject({ summary: 'Written by a session.', lastMessageId: 5, purpose: 'p' });
    b.topicMemory.insertMessage({ messageId: 6, topicId: TOPIC, text: 'later', fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 12, 1)).toISOString(), sessionName: null });
    const s = await auth(request(app).post('/topic/summarize')).send({ topicId: TOPIC });
    expect(s.body.writer).toBeUndefined();
    expect(s.body).toMatchObject({ needsUpdate: true, currentSummary: 'Written by a session.', messagesSinceSummary: 1 });
    expect(s.body.messages).toHaveLength(1);
    expect((await auth(request(app).get('/context-budget/layers'))).status).toBe(503);
  });
});
