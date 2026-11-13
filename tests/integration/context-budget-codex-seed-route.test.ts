// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the Codex next-prompt seed through the REAL AgentServer and
 * routes, with a real TopicMemory and the real standing-packet stager
 * (context-budget-layered-summaries §9.6 Codex column; Phase 1 S17):
 * `POST /context-budget/codex-seed` offers the verified packet only on the
 * first Codex prompt after a rollout compaction; `POST
 * /context-budget/codex-seed/ack` writes the seeded marker; the next prompt
 * gets nothing; a Claude Code prompt never gets one; a packet that fails
 * verification is never offered; with the layers off every route is 503.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireStandingPacket } from '../../src/monitoring/contextLayers/standingPacketBoot.js';
import { rowRefFor } from '../../src/monitoring/contextLayers/LayerStore.js';
import { readCodexSeedMarker, CODEX_SEED_HEADER } from '../../src/monitoring/contextLayers/codexSeed.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import type { InstarConfig } from '../../src/core/types.js';

const OP = 'tests/integration/context-budget-codex-seed-route.test.ts';
const TOKEN = 'cs-it-token-0123456789abcdef01234';
const T = 141133;
const SID = '01a1c8e9-8b19-7d00-92cb-92bda3000002';
const WORDS = 'OPERATOR-WORDS: keep the seed verbatim.';

describe('Codex next-prompt seed — real AgentServer', () => {
  const dirs: string[] = [];
  const servers: AgentServer[] = [];
  const mems: TopicMemory[] = [];
  const stops: Array<() => void> = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) s();
    for (const s of servers.splice(0)) await s.stop();
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(o: { layers: boolean }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-it-')); dirs.push(root);
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'cs-it' }));
    const config = {
      projectName: 'cs-it', projectDir: root, stateDir, port: 0, authToken: TOKEN, requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, secrets: { forceFileKey: true },
    } as unknown as InstarConfig;
    const sessions = [{ id: 'inst-1', telegramTopicId: T, framework: 'codex-cli', claudeSessionId: SID }];
    const sessionManager = { listRunningSessions: () => sessions, getCachedRunningSessions: () => ({ count: 0, sessions: [] }), getSession: () => null, getSessionById: () => undefined, setClaudeSessionId: () => undefined };
    const topicMemory = new TopicMemory(stateDir); await topicMemory.open(); mems.push(topicMemory);
    topicMemory.insertMessage({ messageId: 1, topicId: T, text: WORDS, fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 10)).toISOString(), sessionName: null });
    const layers = o.layers ? buildContextLayers({ stateDir, authToken: TOKEN }) : undefined;
    if (layers) { const s = wireStandingPacket({ layers, stateDir, topicMemory, sessions: () => sessions, debounceMs: 60_000 }); stops.push(() => s.stop()); }
    const server = new AgentServer({ config, sessionManager: sessionManager as never, state: new StateManager(stateDir), topicMemory, contextLayers: layers });
    await server.start();
    servers.push(server);
    // A Codex rollout under a `sessions` directory, with one compaction after its first usage reading.
    const day = path.join(root, 'codex-home', 'sessions', '2026', '11', '10'); fs.mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-11-10T10-00-00-${SID}.jsonl`);
    const t = new Date().toISOString();
    fs.writeFileSync(rollout, [
      { timestamp: t, type: 'session_meta', payload: { id: SID, cli_version: '0.167.1' } },
      { timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200_000 }, model_context_window: 258_400 } } },
      { timestamp: t, type: 'compacted', payload: { message: '', window_id: 'w-it-1', replacement_history: [] } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    return { server, layers, stateDir, topicMemory, rollout };
  }

  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);
  const meta = { author: { sessionId: null, machine: 'm_it', model: null, kind: 'derived' as const }, asOf: { at: Date.now(), lastMessageId: 1 } };
  const anchor = (layers: NonNullable<Awaited<ReturnType<typeof boot>>['layers']>, text = WORDS) => {
    layers.store.writeProtected(String(T), 'u', 'm-1', [rowRefFor(1, text)], meta, { label: 'operator', authority: 'operator', rowId: 1, at: Date.now() });
    layers.store.writeProtected(String(T), 'anchor', 'current', [rowRefFor(1, text)], { ...meta, status: 'anchored' }, { at: [Date.now()] });
  };

  it('the first Codex prompt after a compaction gets the verified packet; the acknowledgement marks the epoch; the next prompt gets nothing', async () => {
    const b = await boot({ layers: true });
    anchor(b.layers!);
    const app = b.server.getApp();
    const offer = await auth(request(app).post('/context-budget/codex-seed')).send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' });
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({ deliver: true, epoch: 'w-it-1' });
    expect(offer.body.text.startsWith(CODEX_SEED_HEADER)).toBe(true);
    expect(offer.body.text).toContain(WORDS); // the operator's words verbatim
    expect(readCodexSeedMarker(b.stateDir, SID)).toBeNull(); // printed is not yet acknowledged
    const ack = await auth(request(app).post('/context-budget/codex-seed/ack')).send({ sessionId: SID, transcriptPath: b.rollout, epoch: offer.body.epoch, carrier: offer.body.carrier });
    expect(ack.status).toBe(200);
    expect(readCodexSeedMarker(b.stateDir, SID)).toMatchObject({ epoch: 'w-it-1', delivery: 'next-prompt', engine: 'codex-cli' });
    // Codex records the hook's output as model input; "already seeded" is read from there.
    fs.appendFileSync(b.rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: offer.body.text }] } })}\n`);
    const again = await auth(request(app).post('/context-budget/codex-seed')).send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' });
    expect(again.body).toEqual({ deliver: false, reason: 'already-seeded' });
    const st = await auth(request(app).get('/context-budget/codex-seed'));
    expect(st.body).toMatchObject({ delivery: 'next-prompt', offers: 2, delivered: 1, acks: 1, alreadySeeded: 1 });
  });

  it('a request for a session that is not this topic\'s live Codex session is refused', async () => {
    const b = await boot({ layers: true });
    anchor(b.layers!);
    const r = await auth(request(b.server.getApp()).post('/context-budget/codex-seed')).send({ topicId: T + 1, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' });
    expect(r.body).toEqual({ deliver: false, reason: 'not-this-topic-session' });
  });

  it('a Claude Code prompt is never offered a seed', async () => {
    const b = await boot({ layers: true });
    anchor(b.layers!);
    const r = await auth(request(b.server.getApp()).post('/context-budget/codex-seed')).send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'claude-code' });
    expect(r.body).toEqual({ deliver: false, reason: 'not-codex' });
  });

  it('a packet that fails verification (a protected row edited after U recorded it) is never offered and no marker is written', async () => {
    const b = await boot({ layers: true });
    anchor(b.layers!, 'a different text than the stored row');
    const r = await auth(request(b.server.getApp()).post('/context-budget/codex-seed')).send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' });
    expect(r.body).toEqual({ deliver: false, reason: 'packet-unverified' });
    expect(readCodexSeedMarker(b.stateDir, SID)).toBeNull();
  });

  it('an acknowledgement for an epoch the rollout does not hold is refused (409)', async () => {
    const b = await boot({ layers: true });
    const r = await auth(request(b.server.getApp()).post('/context-budget/codex-seed/ack')).send({ sessionId: SID, transcriptPath: b.rollout, epoch: 'forged', carrier: 'packet:00000000' });
    expect(r.status).toBe(409);
    expect(readCodexSeedMarker(b.stateDir, SID)).toBeNull();
  });

  it('bearer required; layers off ⇒ 503 on every seed route', async () => {
    const b = await boot({ layers: false });
    const app = b.server.getApp();
    expect((await request(app).post('/context-budget/codex-seed').send({})).status).toBe(401);
    expect((await auth(request(app).post('/context-budget/codex-seed')).send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' })).status).toBe(503);
    expect((await auth(request(app).post('/context-budget/codex-seed/ack')).send({})).status).toBe(503);
    expect((await auth(request(app).get('/context-budget/codex-seed'))).status).toBe(503);
  });
});
