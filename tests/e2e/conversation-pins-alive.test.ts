/**
 * Feature-is-alive proof for pinned messages (docs/specs/conversation-pinned-messages.md): an
 * AgentServer booted on a development agent mounts the pin routes on its production path; a phone
 * paired through the real redeem/confirm path pins a message in an app conversation (200, not 503),
 * the pin is listed, rides on the history read, the agent's token reads it, and unpinning clears it.
 * Wiring integrity: the pin events land in the server's own app conversation store.
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

const HOST = 'echo-pins-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/conversation-pins-alive.test.ts' });
});

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'pins-e2e-'));
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
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir, spawned };
}

describe('pinned messages — production wiring', () => {
  it('is alive on a development agent: pin, list, history, token read, unpin', async () => {
    const { server } = await boot(true);
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
    server.appConversations!.store.append({ eventId: 'e-agent-1', kind: 'message', conversationKey: key, at: new Date().toISOString(), machineId: server.appConversations!.deps.machineId(), messageId: 'msg-agent-1', role: 'agent', text: 'Here is the plan' });

    const pinned = await send('POST', `/mobile/chat/app/${key}/pins`, { messageId: 'msg-agent-1', pinned: true, requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({ ok: true, pinned: true, changed: true });
    expect(server.appConversations!.store.listPins(key).map((p) => p.messageId)).toEqual(['msg-agent-1']);
    const list = await send('GET', `/mobile/chat/app/${key}/pins`);
    expect(list.status).toBe(200);
    expect(list.body.pins[0]).toMatchObject({ messageId: 'msg-agent-1', preview: 'Here is the plan' });
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.pins.map((p: { messageId: string }) => p.messageId)).toEqual(['msg-agent-1']);
    const tokenRead = await auth(request(app).get(`/mobile/chat/app/${key}/pins`));
    expect(tokenRead.status).toBe(200);
    expect(tokenRead.body.pins).toHaveLength(1);
    const unpinned = await send('POST', `/mobile/chat/app/${key}/pins`, { messageId: 'msg-agent-1', pinned: false, requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(unpinned.body).toMatchObject({ ok: true, pinned: false, pins: [] });
  });
});
