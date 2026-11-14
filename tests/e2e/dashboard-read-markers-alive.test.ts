/**
 * Reading in the dashboard clears the count the phone sees (dashboard-read-markers; Justin: unread
 * synced like Telegram, where reading on Telegram Web clears the phone). An owner phone and an owner
 * browser on one production-booted agent: the agent replies, the phone's list shows it unread, the
 * browser reports it read through POST /mobile/conversations/read, and the phone's count is 0.
 *
 * Built on the alive proof for browser devices (docs/specs/dashboard-conversations-browser-device.md):
 * an AgentServer booted on a development agent with NO Telegram (the dashboard approval path) — the
 * operator unlocks the dashboard with the PIN, a browser key is set up through
 * POST /mobile/browser-devices, it creates an app conversation and sends a message signed by its
 * own key, the session tag says "💻 signed", history reads `originVerified: "verified"` with
 * `originClient: "browser"`, the ledger activation row carries `client: "browser"`, a route not
 * named for browsers is refused, and the status route answers the key's state.
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
import { canonicalString, keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { enrollProofMessage } from '../../src/server/mobileBrowserDevices.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { wireReadMarkerStore } from '../../src/core/ConversationReadMarkersWiring.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

const HOST = 'echo-browser-e2e.example.dev';
const PIN = '482915';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/dashboard-read-markers-alive.test.ts' });
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'readmark-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'browser-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: string[] = [];
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  // The read-marker store, as server.ts wires it with native chat and unread on (single machine).
  const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: () => undefined, removalEvidence: () => false });
  readMarkers.markCatchUpSettled();
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, readMarkers });
  servers.push(server);
  return { server, spawned, config, stateDir };
}

describe('dashboard read markers — production wiring', () => {
  it('a browser read clears the unread count a phone of the same person sees', async () => {
    const { server, spawned, stateDir } = await boot();
    const app = server.getApp();
    const mp = server.mobilePairing!;
    expect(server.conversationUnread?.enabled()).toBe(true);
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'browser-e2e');

    // An owner phone (registry + ledger, as the pairing paths leave it).
    const phone = makeDevice();
    const c = mp.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: phone.publicKey, host: HOST });
    if (!c.ok) throw new Error('phone pending');
    mp.keyLedger!.recordActivation(c.device, 'dashboard-pin', new Date().toISOString());
    mp.devices.applyConfirm(c.device.id, { ok: true, approvedVia: 'dashboard-pin' });
    const phoneId = c.device.id;

    // An owner browser, set up through the real route with a PIN session.
    const unlock = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    const browser = makeDevice();
    const enrollmentId = `${Date.now()}-${crypto.randomUUID()}`;
    const timeMs = String(Date.now());
    const setup = await auth(request(app).post('/mobile/browser-devices').set('Host', HOST)).set('X-Instar-Operator-Session', unlock.body.operatorSessionToken)
      .send({ publicKey: browser.publicKey, enrollmentId, timeMs, deviceName: 'e2e browser', proof: browser.sign(enrollProofMessage(HOST, browser.publicKey, enrollmentId, timeMs)) });
    expect(setup.status).toBe(201);
    const browserId = setup.body.deviceId as string;

    const signed = (dev: ReturnType<typeof makeDevice>, id: string) => (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now() + Math.floor(Math.random() * 1000));
      const sig = dev.sign(canonicalString(id, HOST, method, p, time, raw));
      const q = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
      q.set('Host', HOST).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.send(raw.toString()) : q;
    };
    const asPhone = signed(phone, phoneId);
    const asBrowser = signed(browser, browserId);

    // The phone starts a conversation and asks; the agent answers.
    const created = await asPhone('POST', '/mobile/conversations', { title: 'Unread sync', requestId: `${Date.now()}-${crypto.randomUUID()}` });
    const key = created.body.conversationKey as string;
    expect((await asPhone('POST', `/mobile/chat/app/${key}`, { text: 'Anything new?', requestId: `${Date.now()}-${crypto.randomUUID()}` })).status).toBe(200);
    // The phone's first list read sets the person's baseline; the reply comes after it.
    expect((await asPhone('GET', '/mobile/conversations')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const alias = Number(/\[app:(-?\d+) /.exec(spawned[0]!)![1]);
    const token = createConversationBindAuth(stateDir).mint('app-session-1', [alias]);
    const reply = await auth(request(app).post('/app/session-reply')).set('X-Instar-Bind-Token', token).send({ conversationId: alias, text: 'Yes: the report is ready.' });
    expect(reply.status).toBe(200);

    const phoneRow = async () => ((await asPhone('GET', '/mobile/conversations')).body.conversations as Array<Record<string, unknown>>).find((r) => r.id === key)!;
    expect(await phoneRow()).toMatchObject({ hasUnread: true, unreadCount: 1 });

    // The browser reads the conversation and reports the newest message read (what the page sends).
    const hist = await asBrowser('GET', `/mobile/chat/app/${key}/messages`);
    const newest = (hist.body.messages as Array<{ eventId: string; at: string }>).at(-1)!;
    const marked = await asBrowser('POST', '/mobile/conversations/read', { marks: [{ ref: `app:${key}`, id: newest.eventId, atMs: Date.parse(newest.at) }] });
    expect(marked.status).toBe(200);
    expect(marked.body.results[0]).toMatchObject({ ok: true, unreadCount: 0 });

    // The phone of the same person now sees it read.
    expect(await phoneRow()).toMatchObject({ hasUnread: false, unreadCount: 0 });
  });
});
