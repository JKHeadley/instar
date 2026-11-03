/**
 * Feature-is-alive proof for people and roles (docs/specs/mobile-app-people-and-roles.md): an
 * AgentServer booted on its production path, with a person in the agent's user registry
 * (users.json), mints a link FOR that person as an MSP, the owner's code message names them, the
 * phone confirms, creates its own app conversation and sends a message that reaches the session
 * tagged with the MSP's name — not the owner's. Slack answers owner-only (not 503), and the MSP's
 * conversation is stamped with its person.
 * Wiring integrity: the pairing service's conversation-owner lookup is wired to the real store.
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

const HOST = 'echo-people-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-app-people-roles-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'people-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  // The agent's user registry: the MSP is a known person.
  fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([{ id: 'justin', name: 'Justin', channels: [], permissions: ['user'] }]));
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'people-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Ann' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: string[] = [];
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, spawned };
}

describe('people and roles — production wiring', () => {
  it('pairs an MSP phone for a named person and its messages carry that person', async () => {
    const { server, spawned } = await boot();
    const app = server.getApp();
    expect(server.mobilePairing).not.toBeNull();
    expect(server.appConversations).not.toBeNull();
    // Wiring integrity: the shared check reads the real conversation store.
    expect(server.mobilePairing!.appConversationOwner).toBeTypeOf('function');

    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'people-e2e');

    const m = await auth(request(app).post('/mobile/pairing-codes')).send({ userId: 'justin', role: 'msp' });
    expect(m.status).toBe(200);
    expect(m.body.person).toEqual({ name: 'Justin', role: 'msp', userId: 'justin' });
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Justin phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    expect(dms[0]).toContain('pair a phone for Justin (MSP) with people-e2e');
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let t = Date.now();
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(++t);
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    expect((await send('GET', '/mobile/device')).body.person).toEqual({ name: 'Justin', role: 'msp' });

    const created = await send('POST', '/mobile/conversations', { title: 'Server checks', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    expect(server.appConversations!.store.getConversation(key)!.ownerPerson).toMatchObject({ userId: 'justin' });
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'Disk is at 80%, cleaning up.', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(sent.status).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain('"Server checks" from Justin');
    expect(spawned[0]).not.toContain('from Ann');

    // Slack is owner-only for this phone: refused by role, not by a missing feature.
    const slack = await send('GET', '/mobile/chat/slack/-5/messages');
    expect(slack.status).toBe(403);
    expect(slack.body.error).toBe('owner-only');
  });
});
