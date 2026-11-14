/**
 * Feature-is-alive proof for keyword search over conversations (docs/specs/conversation-search.md):
 * an AgentServer booted on a development agent mounts the search route on its production path; a
 * phone paired through the real redeem/confirm path finds a word in an app conversation (200, not
 * 503), with the event id the history read uses; the agent's token reads the same; a fleet agent
 * (native conversations dark) answers 503. Wiring integrity: the hit comes from the server's own
 * app conversation store, and the server's TopicMemory is the index it uses (nothing unsearched).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { FakeEmbedder } from '../helpers/fakeEmbedder.js';

const HOST = 'echo-search-e2e.example.dev';
const servers: AgentServer[] = [];
const memories: TopicMemory[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const m of memories) m.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/conversation-search-alive.test.ts' });
});

async function boot(developmentAgent: boolean, conversationEmbedder?: FakeEmbedder) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'search-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // Every agent gets a machine identity at `instar init`; the receipt signer reads it.
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'native-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    mobilePairing: { multiRoute: { enabled: false } }, // the single-host path; multi-route has its own e2e
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: Array<{ message: string; options: { bootstrapConversationIds?: number[] } }> = [];
  sessionManager.spawnInteractiveSession = async (message: string, _name: string | undefined, options: { bootstrapConversationIds?: number[] }) => {
    spawned.push({ message, options });
    return 'app-session-1';
  };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const topicMemory = new TopicMemory(stateDir);
  await topicMemory.open();
  memories.push(topicMemory);
  const server = new AgentServer({ topicMemory, config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, conversationEmbedder });
  servers.push(server);
  return { server, stateDir, spawned };
}

describe('conversation search — production wiring', () => {
  it('is alive on a development agent: a phone and the agent token find a word, and by meaning', async () => {
    const embedder = new FakeEmbedder();
    const { server, stateDir } = await boot(true, embedder);
    const app = server.getApp();
    expect(server.appConversations).not.toBeNull();
    // Pair through the existing path (mint → redeem → owner code → confirm), owner DM stubbed.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true; // the Telegram path (no owner ⇒ the dashboard path, §4.4)
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now());
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    server.appConversations!.store.append({ eventId: 'e-agent-1', kind: 'message', conversationKey: key, at: new Date().toISOString(), machineId: server.appConversations!.deps.machineId(), messageId: 'msg-agent-1', role: 'agent', text: 'The rocket launch is on Friday' });

    const found = await send('GET', '/mobile/conversations/search?q=rocket');
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ mode: 'keyword', partial: false, unsearched: [] });
    expect(found.body.results).toHaveLength(1);
    expect(found.body.results[0]).toMatchObject({ ref: `app:${key}`, platform: 'app', title: 'Plans', messageId: 'e-agent-1', fromUser: false });
    const inside = await send('GET', `/mobile/conversations/search?q=friday&ref=app:${key}`);
    expect(inside.body.results.map((h: { messageId: string }) => h.messageId)).toEqual(['e-agent-1']);
    const tokenRead = await auth(request(app).get('/mobile/conversations/search?q=launch'));
    expect(tokenRead.status).toBe(200);
    expect(tokenRead.body.results[0].messageId).toBe('e-agent-1');

    // Meaning search: the server built the index from its own store and the injected model.
    expect(server.conversationEmbeddings).not.toBeNull();
    expect(fs.existsSync(path.join(stateDir, 'state', 'conversation-embeddings.db'))).toBe(true);
    const ticked = await server.conversationEmbeddings!.feeder.tick({ ignoreLoad: true });
    expect(ticked).toMatchObject({ ran: true, embedded: 1 });
    expect(embedder.calls).toEqual(['The rocket launch is on Friday']);
    const meaning = await send('GET', '/mobile/conversations/search?q=spaceship%20liftoff&mode=meaning');
    expect(meaning.status).toBe(200);
    expect(meaning.body).toMatchObject({ mode: 'meaning', coverage: 1, partial: false });
    expect(meaning.body.results.map((h: { messageId: string }) => h.messageId)).toEqual(['e-agent-1']);
    // The keyword answer carries no meaning field.
    expect(tokenRead.body.coverage).toBeUndefined();
  });

  it('answers meaning-unavailable on an agent without the model', async () => {
    const { server } = await boot(true);
    expect(server.conversationEmbeddings).toBeNull();
    const r = await request(server.getApp()).get('/mobile/conversations/search?q=rocket&mode=meaning').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    expect([r.status, r.body.error]).toEqual([503, 'meaning-unavailable']);
  });

  it('is dark on a fleet agent (native conversations off)', async () => {
    const { server } = await boot(false);
    const r = await request(server.getApp()).get('/mobile/conversations/search?q=rocket').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'native-e2e');
    expect(r.status).toBe(503);
  });
});
