/**
 * Feature-is-alive proof for team access (docs/specs/team-roles-and-access.md §4.1): an AgentServer
 * booted on its production path. The owner's phone pairs and invites a member with one shared
 * conversation; the member's phone pairs with the code held for the owner, reads and talks only in
 * that conversation, and loses everything when removed. With memory privacy off the invite is refused.
 * Wiring integrity: the team gate, the log, the router and the conversation change are live delegates.
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

const HOST = 'echo-team-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/team-access-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'team-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'users.json'), '[]');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'team-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } }, tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, threadline: { ownerName: 'Ann' },
  } as unknown as InstarConfig;
  const privacy = { on: false };
  const changed: string[] = [];
  const spawned: string[] = [];
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  sessionManager.memoryPrivacyStatus = () => ({ enabled: privacy.on, sandboxReady: privacy.on, multiPerson: false, ownerUserId: null, blocker: null, fix: null });
  sessionManager.applyConversationChange = async (ref: string, change: () => unknown) => { changed.push(ref); return change(); };
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  const app = server.getApp();
  const dms: string[] = [];
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true;
  return { server, app, privacy, changed, spawned, dms };
}

let clock = Date.now();
function client(app: Parameters<typeof request>[0], deviceId: string, dev: ReturnType<typeof makeDevice>) {
  return (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const time = String(++clock);
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
    q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    return raw ? q.send(raw.toString()) : q;
  };
}
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

describe('team access — production wiring', () => {
  it('runs the whole journey on a real server', async () => {
    const { server, app, privacy, changed, spawned, dms } = await boot();
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'team-e2e');
    expect(server.mobilePairing!.teamActionRunner).toBeTypeOf('function');

    // The owner's phone.
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const ownerDev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'Ann phone', devicePublicKey: ownerDev.publicKey });
    const owner = client(app, r.body.deviceId, ownerDev);
    const ownerCode = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    expect((await owner('POST', '/mobile/device/confirm', { code: ownerCode })).body.status).toBe('active');

    server.mobilePairing!.devices.setPresenceKey(r.body.deviceId, makeDevice().publicKey);
    const shared = (await owner('POST', '/mobile/conversations', { title: 'Client work', requestId: rid() })).body.conversationKey as string;
    const secret = (await owner('POST', '/mobile/conversations', { title: 'My notes', requestId: rid() })).body.conversationKey as string;
    expect(shared).toBeTruthy();
    const invite = { events: [
      { type: 'team-on' }, { type: 'owner-pin', personKey: 'owner-1' },
      { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
      { type: 'grant', personKey: 'mia', ref: shared, access: 'use' },
    ] };

    // Refused while memory privacy is off: the gate reads the real status.
    const refused = await owner('POST', '/mobile/team/invites', invite);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('memory-privacy-required');

    privacy.on = true;
    const inv = await owner('POST', '/mobile/team/invites', invite);
    expect(inv.status).toBe(200);
    expect(inv.body.disclosure).toMatch(/Scheduled jobs/);
    expect(changed).toEqual([shared]);

    // The member's phone: the code is held for the owner.
    const code = new URLSearchParams(String(inv.body.link).split('#')[1]).get('c');
    const miaDev = makeDevice();
    const redeemed = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code, deviceName: 'Mia phone', devicePublicKey: miaDev.publicKey, appCaps: ['standing'] });
    expect(redeemed.status).toBe(200);
    const mia = client(app, redeemed.body.deviceId, miaDev);
    const waiting = await owner('GET', '/mobile/team/invites/mia');
    expect(waiting.body.waiting).toHaveLength(1);
    expect((await mia('POST', '/mobile/device/confirm', { code: waiting.body.waiting[0].code.replace(/\s/g, '') })).body.status).toBe('active');

    // She sees and talks only in what she was given.
    const list = await mia('GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('Client work');
    expect(JSON.stringify(list.body)).not.toContain('My notes');
    const sent = await mia('POST', `/mobile/chat/app/${shared}`, { text: 'Hello from Mia', requestId: rid() });
    expect(sent.status).toBe(200);
    expect(spawned.some((s) => s.includes('Hello from Mia'))).toBe(true);
    expect((await mia('GET', `/mobile/chat/app/${secret}/messages`)).status).toBe(404);
    expect((await mia('POST', `/mobile/chat/app/${secret}`, { text: 'x', requestId: rid() })).status).toBe(404);
    expect((await mia('POST', '/mobile/team/invites', invite)).status).toBe(403);

    // Someone asks: it reaches the owner and gives nothing until the owner signs exactly that.
    const asked = await auth(request(app).post('/team/proposals')).send({ change: { kind: 'grant', personKey: 'mia', ref: secret, access: 'read' }, reason: 'Needs the notes' });
    expect(asked.status).toBe(201);
    const waitingRequests = await owner('GET', '/mobile/team/requests');
    expect(waitingRequests.body.requests[0].summary).toContain('My notes');
    expect((await mia('GET', `/mobile/chat/app/${secret}/messages`)).status).toBe(404);
    expect((await owner('POST', `/mobile/team/requests/${asked.body.id}/decline`, {})).status).toBe(200);

    // The agent can take access away, and it is gone at once.
    const lowered = await auth(request(app).post('/team/people/mia/lower')).send({ remove: true });
    expect(lowered.status).toBe(200);
    expect((await mia('GET', '/mobile/conversations')).status).toBe(401); // the phone itself is revoked
    expect(server.mobilePairing!.teamLog()!.isConfined(shared)).toBe(true);
    // A topic reference that is not the standard form is refused before anything is written.
    const odd = await owner('POST', '/mobile/team/grants', { events: [{ type: 'grant', personKey: 'mia', ref: 'telegram:01', access: 'use' }] });
    expect(odd.status).toBeGreaterThanOrEqual(400);
    // A grant cannot come before its person.
    const early = await owner('POST', '/mobile/team/invites', { events: [
      { type: 'grant', personKey: 'later', ref: `telegram:77`, access: 'use' }, { type: 'person-add', personKey: 'later', name: 'L', role: 'member' },
    ] });
    expect(early.status).toBe(404);
    // Two invites at once for one new key: the second sees the first.
    const twin = { events: [{ type: 'person-add', personKey: 'twin', name: 'Twin', role: 'member' }] };
    const both = await Promise.all([owner('POST', '/mobile/team/invites', twin), owner('POST', '/mobile/team/invites', twin)]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    // A removed person cannot come back under the same key, alone or hidden behind a new one.
    const reuse = await owner('POST', '/mobile/team/invites', { events: [{ type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' }] });
    expect(reuse.body.error).toBe('person-key-used');
    const hidden = await owner('POST', '/mobile/team/invites', { events: [
      { type: 'person-add', personKey: 'new-one', name: 'N', role: 'member' }, { type: 'person-add', personKey: 'mia', name: 'Mia', role: 'member' },
    ] });
    expect(hidden.status).toBe(400);
    expect(server.mobilePairing!.teamStanding('mia')).toBeNull();
    // The history still reads by name after the person has gone.
    const history = await owner('GET', '/mobile/team/activity');
    expect(history.body.lines.map((l: { text: string }) => l.text)).toContain('Mia was removed');
  });
});
