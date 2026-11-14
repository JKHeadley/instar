/**
 * Feature-is-alive proof for unread messages (docs/specs/mobile-unread-messages.md §10 E2E): an
 * AgentServer booted on a development agent through its production constructor, with the read-marker
 * store handed in the way server.ts builds it, has the unread service wired (real store, real
 * pairing, real app store), a phone paired through the existing path reads the list with read fields
 * and a page total, reports what it read through POST /mobile/conversations/read (200, not 503), the
 * catch-up route answers the agent's token, and a reply push would carry the phone's badge.
 * Wiring integrity: the service is non-null and its deps delegate to real implementations.
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
import { wireReadMarkerStore } from '../../src/core/ConversationReadMarkersWiring.js';

const HOST = 'echo-unread-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-unread-messages-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'unread-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'unread-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async () => 'app-session-1';
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  // The store as server.ts builds it (no replication machinery in this boot: a single machine).
  const reports: string[] = [];
  const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: (what) => { reports.push(what); }, removalEvidence: () => false });
  readMarkers.markCatchUpSettled();
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, readMarkers });
  servers.push(server);
  return { server, stateDir, readMarkers, reports };
}

describe('unread messages — production wiring', () => {
  it('is alive on a development agent: the list carries read fields, the read route answers 200, the catch-up route answers the token', async () => {
    const { server, readMarkers } = await boot();
    const app = server.getApp();
    // Wiring integrity: the service is real and delegates to the real store, pairing and app store.
    expect(server.conversationUnread).not.toBeNull();
    expect(server.conversationUnread!.enabled()).toBe(true);
    expect(server.conversationUnread!.store).toBe(readMarkers);
    expect(server.mobilePairing!.nativeOn).toBe(true);
    expect(server.appConversations).not.toBeNull();
    expect(server.startConversationUnread(0)).toBe(server.conversationUnread);

    // Pair a phone through the existing path (mint → redeem → owner code → confirm).
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'unread-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
    expect(m.status).toBe(200);
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    expect(r.status).toBe(200);
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let tick = 0;
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now() + (tick++ % 1000));
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');

    // A conversation, the phone's first list read (sets the baseline), then an agent reply after it.
    const created = await send('POST', '/mobile/conversations', { title: 'Plans', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    expect(created.status).toBe(200);
    const key = created.body.conversationKey as string;
    const first = await send('GET', '/mobile/conversations');
    expect(first.status).toBe(200);
    expect(first.body.conversations[0]).toMatchObject({ id: key, hasUnread: false, unreadCount: 0 });
    expect(first.body).toMatchObject({ unreadTotal: 0, unreadTotalMore: false, unreadBeyondPage: false });
    expect(readMarkers.hasBaseline('owner')).toBe(true);
    const eventId = `ag-${crypto.randomUUID()}`;
    server.appConversations!.store.append({ kind: 'message', eventId, conversationKey: key, messageId: eventId, role: 'agent', text: 'hello back', at: new Date(Date.now() + 60_000).toISOString(), machineId: 'e2e' } as never);
    const list = await send('GET', '/mobile/conversations');
    expect(list.body.conversations[0]).toMatchObject({ id: key, hasUnread: true, unreadCount: 1 });
    expect(list.body.unreadTotal).toBe(1);
    // The history read carries the divider position for the phone.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.status).toBe(200);
    expect(hist.body.readUpTo).toEqual({ atMs: expect.any(Number), id: '' });
    // The phone reports what it read: 200, not 503, and the count clears.
    const read = await send('POST', '/mobile/conversations/read', { marks: [{ ref: key, id: eventId, atMs: Date.now() }] });
    expect(read.status).toBe(200);
    expect(read.body.results[0]).toMatchObject({ ref: `app:${key}`, ok: true, unreadCount: 0 });
    expect((await send('GET', '/mobile/conversations')).body.unreadTotal).toBe(0);
    // The catch-up route answers the agent's token and refuses the phone.
    const page = await auth(request(app).get('/mobile/conversations/read-markers'));
    expect(page.status).toBe(200);
    expect(page.body.records.some((x: { ref: string }) => x.ref === `app:${key}`)).toBe(true);
    expect((await send('GET', '/mobile/conversations/read-markers')).status).toBe(403);
    // The badge a reply push would carry for this phone: its app-conversation unread.
    const badge = (server.mobilePairing!.push as unknown as { deps: { badgeFor: (d: string, k: string, m: string | undefined) => number | null } }).deps.badgeFor(deviceId, key, 'not-landed-yet');
    expect(badge).toBe(1);
    // The agent's own reads carry no read fields.
    const agentList = await auth(request(app).get('/mobile/conversations'));
    expect(agentList.status).toBe(200);
    expect(agentList.body).not.toHaveProperty('unreadTotal');
    expect(agentList.body.conversations[0]).not.toHaveProperty('hasUnread');
  });
});
