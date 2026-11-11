// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — context-budget-layered-summaries §6.5, §7.6, §9.1, §9.5
 * through the REAL AgentServer and routes: a real Claude Code transcript
 * fixture flows archive → chunk → route; a PostCompact POST enqueues exactly
 * one chunk build (after the response); with
 * `contextBudget.compactionRecovery.enabled` off nothing is enqueued; the
 * lookup routes are bearer-only, bounded, and 503 while the layers are off.
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
import type { InstarConfig } from '../../src/core/types.js';

const OP = 'tests/integration/context-layer-chunks.test.ts';
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'context-budget', 'claude-transcript-compacted.jsonl');
const TOKEN = 'chunks-it-token-0123456789abcdef';
const CS = 'c1a2b3c4-0000-4000-8000-0000000000aa';
const TOPIC = '141133';
const REPLY = JSON.stringify({ attempted: 'Added the bounded chunk lookup route.', outcome: 'A missing import broke the typecheck; fixed, clean.', artifacts: ['src/server/routes.ts'], openThreads: [], summary: 'The agent added the route [msg:1], hit a TS2304, fixed the import.' });

describe('context layer chunks — real AgentServer', () => {
  const dirs: string[] = [];
  const servers: AgentServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(o: { layers?: boolean; recovery?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-it-')); dirs.push(root);
    const stateDir = path.join(root, '.instar');
    const configHome = path.join(root, 'claude-home');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    const contextBudget = o.recovery === false ? { compactionRecovery: { enabled: false } } : undefined;
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'ch-it', ...(contextBudget ? { contextBudget } : {}) }));
    const config = {
      projectName: 'ch-it', projectDir: root, stateDir, port: 0, authToken: TOKEN, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, secrets: { forceFileKey: true },
      ...(contextBudget ? { contextBudget } : {}),
    } as unknown as InstarConfig;
    const session = { id: 'inst-topic', tmuxSession: 'echo-topic', telegramTopicId: Number(TOPIC), claudeSessionId: CS, framework: 'claude-code', cwd: root };
    const sessionManager = {
      listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null, getSessionById: (id: string) => (id === session.id ? session : undefined), setClaudeSessionId: () => undefined,
      configHomeForSession: () => configHome,
    };
    const transcript = resolveFrameworkTranscriptPath({ framework: 'claude-code', sessionId: CS, projectDir: root, configHome });
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.copyFileSync(FIXTURE, transcript);
    const layers = o.layers === false ? undefined : buildContextLayers({ stateDir, authToken: TOKEN });
    const calls: string[] = [];
    const chunkBuilder = layers ? new ChunkBuilder({
      store: layers.store, archive: layers.archive, budget: layers.budget, machine: 'm_it',
      intelligence: { evaluate: async (p: string) => { calls.push(p); return REPLY; } },
    }) : undefined;
    const server = new AgentServer({
      config, sessionManager: sessionManager as never, state: new StateManager(stateDir),
      hookEventReceiver: new HookEventReceiver({ stateDir, resolveCurrentInstarSessionId: () => null, isLiveInstarSession: () => false }),
      subagentTracker: new SubagentTracker({ stateDir }),
      contextLayers: layers, chunkBuilder,
    });
    await server.start();
    servers.push(server);
    return { server, layers, chunkBuilder, calls, transcript };
  }

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);
  const postCompact = (s: AgentServer) => auth(request(s.getApp()).post('/hooks/post-compact')).set('X-Instar-Session-Id', 'inst-topic')
    .send({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'auto', compact_summary: 'we added the route' });
  const settle = async (b: ChunkBuilder) => { await new Promise((r) => setImmediate(r)); await b.idle(); };

  it('a PostCompact enqueues exactly one build; the fixture span is archived, chunked and served by the routes', async () => {
    const b = await boot();
    const res = await postCompact(b.server);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recorded: true, topicKey: TOPIC, chunk: 'enqueued' });
    await settle(b.chunkBuilder!);
    expect(b.chunkBuilder!.status().enqueued).toBe(1);
    expect(b.calls).toHaveLength(1);
    // The model saw the pre-compaction span only: the operator turn labelled, the error flagged, nothing after the boundary.
    expect(b.calls[0]).toContain('OPERATOR');
    expect(b.calls[0]).toContain('TOOL-RESULT error');
    expect(b.calls[0]).not.toContain('Continuing after the compaction');
    expect(b.calls[0]).not.toContain('This session is being continued');

    const list = await auth(request(b.server.getApp()).get(`/topic/${TOPIC}/chunks`));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const span = list.body.items.find((i: { kind: string }) => i.kind === 'span');
    expect(span).toMatchObject({ status: 'closed', recordType: 'chunk', trigger: 'post-compact', sampling: 'complete: all 7 entries' });
    expect(span.entryRange).toMatchObject({ firstEntryId: 'e0000001-0000-4000-8000-000000000001', lastEntryId: 'e0000006-0000-4000-8000-000000000006', entries: 7 });
    expect(span.spans).toEqual([{ spanId: span.key, state: 'present' }]);
    expect(span.bytes).toBeGreaterThan(0);
    expect(list.body.items.some((i: { kind: string }) => i.kind === 'pre-layer')).toBe(true);
    const one = await auth(request(b.server.getApp()).get(`/topic/${TOPIC}/chunks/${span.key}`));
    expect(one.status).toBe(200);
    expect(one.body.record.data).toMatchObject({ attempted: 'Added the bounded chunk lookup route.', author: 'derived', sampledFrom: 7 });
    expect(b.layers!.archive.readSpan(TOPIC, span.key)!.map((e) => e.entryId)).toContain('e0000002-0000-4000-8000-000000000002:1');

    // A repeated PostCompact with no newer boundary reads to the end (the hook may fire
    // before its boundary is flushed): it chunks only the entries after the first span,
    // never the first span again and never the compaction summary.
    await postCompact(b.server);
    await settle(b.chunkBuilder!);
    expect(b.chunkBuilder!.status().enqueued).toBe(2);
    expect(b.calls).toHaveLength(2);
    const spans = b.chunkBuilder!.chunks(TOPIC).filter((c) => c.data.kind === 'span');
    expect(spans).toHaveLength(2);
    expect(b.layers!.archive.readSpan(TOPIC, String(spans[1].entryKey))!.map((e) => e.entryId)).toEqual(['e0000010-0000-4000-8000-000000000010']);
    // And a third with nothing new builds nothing.
    await postCompact(b.server);
    await settle(b.chunkBuilder!);
    expect(b.calls).toHaveLength(2);
  });

  it('with compactionRecovery off, the record is kept but nothing is enqueued', async () => {
    const b = await boot({ recovery: false });
    const res = await postCompact(b.server);
    expect(res.body).toMatchObject({ recorded: true, chunk: 'off' });
    await settle(b.chunkBuilder!);
    expect(b.chunkBuilder!.status().enqueued).toBe(0);
    expect(b.layers!.store.list(TOPIC, 'chunk')).toHaveLength(0);
    expect(b.layers!.archive.readIndex(TOPIC).spans).toHaveLength(0);
  });

  it('routes: 503 while the layers are off; bearer required; bad ids and unknown keys refused; pagination capped', async () => {
    const off = await boot({ layers: false });
    expect((await auth(request(off.server.getApp()).get(`/topic/${TOPIC}/chunks`))).status).toBe(503);
    expect((await auth(request(off.server.getApp()).get(`/topic/${TOPIC}/chunks/x`))).status).toBe(503);
    expect((await postCompact(off.server)).body.chunk).toBe('off');
    const on = await boot();
    expect((await request(on.server.getApp()).get(`/topic/${TOPIC}/chunks`)).status).toBe(401);
    expect((await auth(request(on.server.getApp()).get(`/topic/${TOPIC}/chunks/nope`))).status).toBe(404);
    expect((await auth(request(on.server.getApp()).get('/topic/_bad/chunks'))).status).toBe(400);
    expect((await auth(request(on.server.getApp()).get(`/topic/${TOPIC}/chunks?limit=abc`))).status).toBe(400);
    const capped = await auth(request(on.server.getApp()).get(`/topic/${TOPIC}/chunks?limit=99999`));
    expect(capped.body.limit).toBe(200);
  });
});
