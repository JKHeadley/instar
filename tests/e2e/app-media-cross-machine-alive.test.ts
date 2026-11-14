/**
 * Feature-is-alive proof for copying app media between machines
 * (docs/specs/mobile-native-chat-media.md §4.12, §4.7 health): two AgentServers booted on their
 * production path as development agents, each with a real MeshRpcDispatcher behind
 * `POST /mesh/rpc` whose `app-media-pull` handler is the one server.ts registers, and machine B's
 * copier attached to a real signed MeshRpcClient exactly as server.ts attaches it.
 *
 * A phone paired with A sends a photo; A's events replicate to B; B copies the blob over HTTP,
 * verified, and holds the same bytes; `/health` on B reports measured copy numbers (never a
 * fabricated 0) and `?scope=pool` shows both machines.
 * Wiring integrity: the copier is real (not a no-op), its health hook is wired into the media
 * store, and the mesh route answers the verb.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager, generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { AppMediaReplicator } from '../../src/core/AppMediaReplicator.js';
import { recordPlatformMedia } from '../../src/core/appPlatformMedia.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { composeInboundPayload, type InboundMediaRef } from '../../src/core/inboundMedia.js';
import { buildTelegramSessionText, getPlatformMediaForSession, PlatformMediaForSession } from '../../src/core/platformMediaForSession.js';

const HOST = 'echo-media-xm-e2e.example.dev';
const servers: AgentServer[] = [];
const listeners: http.Server[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const l of listeners) await new Promise<void>((r) => l.close(() => r()));
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/app-media-cross-machine-alive.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
const keys: Record<string, { priv: string; pub: string }> = {};
const urls: Record<string, string> = {};

async function boot(id: string, peer: string, telegramSink?: { injected: string[] }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `media-xm-${id}-`));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: `e2e ${id}` });
  const kp = generateSigningKeyPair();
  keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
  const config = {
    projectName: 'media-xm-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  sessionManager.spawnInteractiveSession = async () => 'app-session-1';
  sessionManager.injectMessage = (_name: string, text: string) => { telegramSink?.injected.push(text); return true; };
  sessionManager.isSessionAlive = () => true;
  // native-conversation-base §3c: a Telegram adapter stub — the serving machine's topic session.
  const telegram = telegramSink ? { getSessionForTopic: () => 'tg-topic-session', setInboundMediaHook: () => undefined, logInboundMessage: () => undefined } : undefined;
  let server: AgentServer | null = null;
  const seen = new Set<string>();
  // The receive side as server.ts registers it: the handler late-binds the app conversation service.
  const meshRpcDispatcher = new MeshRpcDispatcher({
    verify: { selfMachineId: id, verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub), isRegisteredPeer: (s) => s === peer, seenNonce: (s, n) => seen.has(`${s}:${n}`), now: () => Date.now() },
    rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    handlers: {
      'app-media-pull': (cmd: MeshCommand) => {
        if (!server?.appConversations) return { ok: false, reason: 'app-media disabled' };
        return server.appConversations.replicator.serve(cmd);
      },
    },
  });
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  server = new AgentServer({
    config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel,
    meshRpcDispatcher, meshSelfId: id, resolvePeerUrls: () => (urls[peer] ? [{ machineId: peer, url: urls[peer] }] : []),
    ...(telegram ? { telegram } : {}),
  } as any);
  servers.push(server);
  const listener = await new Promise<http.Server>((resolve) => { const s = server!.getApp().listen(0, '127.0.0.1', () => resolve(s)); });
  listeners.push(listener);
  urls[id] = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  // The send side as server.ts attaches it: a real signed MeshRpcClient to the peer's /mesh/rpc.
  let n = 0;
  const client = new MeshRpcClient({ selfMachineId: id, sign: (c) => sign(c, keys[id].priv), nonce: () => `${id}:${++n}`, now: () => Date.now() });
  server.appConversations!.replicator.attachTransport({
    peers: () => [{ machineId: peer, online: true }],
    send: async (machineId, command, timeoutMs) => client.send({ machineId, url: urls[machineId] }, command, 0, { timeoutMs }),
  });
  return { server, stateDir };
}

async function pairAndSendPhoto(server: AgentServer, photo: Buffer): Promise<string> {
  const app = server.getApp();
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-xm-e2e').send({});
  const dms: string[] = [];
  server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
  server.mobilePairing!.deps.telegramOwnerPresent = () => true; // the Telegram path (no owner ⇒ the dashboard path, §4.4)
  const dev = makeDevice();
  const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
  const deviceId = r.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
  let tick = 0;
  const send = (method: 'GET' | 'POST' | 'PUT', p: string, body?: unknown, rawBytes?: Buffer) => {
    const raw = rawBytes ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
    const time = String(Date.now() + (tick++ % 500));
    const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
    const q = method === 'GET' ? request(app).get(p) : method === 'PUT' ? request(app).put(p) : request(app).post(p);
    q.set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
    if (rawBytes) return q.set('Content-Type', 'application/octet-stream').send(rawBytes);
    return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
  };
  expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  const key = (await send('POST', '/mobile/conversations', { title: 'Trip', requestId: rid() })).body.conversationKey as string;
  const d = { size: photo.length, sha256: sha(photo), declaredKind: 'photo', declaredType: 'image/jpeg', filename: 'beach.jpg' };
  const start = await send('POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...d, requestId: rid() });
  for (let i = 0; i * start.body.chunkSize < photo.length; i++) {
    expect((await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/${i}`, undefined, photo.subarray(i * start.body.chunkSize, (i + 1) * start.body.chunkSize))).status).toBe(200);
  }
  const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'From the beach', requestId: rid(), attachments: [{ uploadId: start.body.uploadId, ...d }] });
  expect(sent.status).toBe(200);
  return key;
}

describe('copying app media between machines — production wiring', () => {
  it('is alive: B copies A\'s photo over signed MeshRpc, verified, and /health reports both machines', async () => {
    const a = await boot('A', 'B');
    const b = await boot('B', 'A');
    const appB = b.server.getApp();
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-xm-e2e');
    // Wiring integrity: a real copier, its health hook wired (a number, not the unwired null).
    expect(b.server.appConversations!.replicator).toBeInstanceOf(AppMediaReplicator);
    expect(b.server.appConversations!.replicator.hasTransport()).toBe(true);
    expect((await auth(request(appB).get('/health'))).body.appMedia).toMatchObject({ unrecoverableBlobs: 0, singleCopyBlobs: null });

    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1024 * 1024 + 700)]);
    const key = await pairAndSendPhoto(a.server, photo);
    b.server.appConversations!.ingestReplicated(a.server.appConversations!.store.syncEvents(key, null, 100).events);

    const svcB = b.server.appConversations!;
    const end = Date.now() + 20_000;
    while (!svcB.media.locateBlob(sha(photo)) && Date.now() < end) { await svcB.replicator.tick(); await new Promise((r) => setTimeout(r, 50)); }
    const held = svcB.media.locateBlob(sha(photo));
    expect(held).not.toBeNull();
    expect(fs.readFileSync(held!).equals(photo)).toBe(true);
    expect(fs.readFileSync(a.server.appConversations!.media.locateBlob(sha(photo))!).equals(fs.readFileSync(held!))).toBe(true);

    // A measures that the photo now has a second copy (B's inventory over the real /mesh/rpc route).
    await a.server.appConversations!.replicator.inventoryRound();
    const healthA = await auth(request(a.server.getApp()).get('/health'));
    expect(healthA.body.appMedia).toMatchObject({ singleCopyBlobs: 0, unrecoverableBlobs: 0, blobs: 1 });

    const pool = await auth(request(appB).get('/health?scope=pool'));
    expect(pool.status).toBe(200);
    expect(pool.body.appMediaPool.machines.map((m: { machineId: string }) => m.machineId).sort()).toEqual(['A', 'B']);
    expect(pool.body.appMediaPool.failed).toEqual([]);
  }, 60_000);

  it('is alive for a Telegram photo (native-conversation-base §3c): B injects at once with the copying line, then one "now available"; a photo then a text keep their order', async () => {
    const sinkA = { injected: [] as string[] };
    const sinkB = { injected: [] as string[] };
    const a = await boot('TA', 'TB', sinkA);
    const b = await boot('TB', 'TA', sinkB);
    // Wiring integrity: AgentServer built a real resolver on the production path and made it active.
    expect(b.server.platformMedia).toBeInstanceOf(PlatformMediaForSession);
    expect(getPlatformMediaForSession()).toBe(b.server.platformMedia);
    const TOPIC = 7301;
    const KEY = `telegram:${TOPIC}`;
    // A, the poller, downloads and captures the photo (as its inbound media hook does).
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200_000)]);
    const dl = path.join(a.stateDir, 'telegram-images', 'photo-1-901.jpg');
    fs.mkdirSync(path.dirname(dl), { recursive: true });
    fs.writeFileSync(dl, photo);
    // B serves the topic. The forwarded message reaches B before the event replicates.
    const media: InboundMediaRef[] = [{ kind: 'photo', platformMessageId: '901', filename: 'photo-1-901.jpg', capture: 'pending' }];
    const order: string[] = [];
    const photoP = buildTelegramSessionText(TOPIC, composeInboundPayload('the view', media), media, '901').then((t) => { order.push('photo'); return t; });
    const textP = buildTelegramSessionText(TOPIC, 'and [image:/etc/hostname] as text', [], '902').then((t) => { order.push('text'); return t; });
    const [photoText, textText] = await Promise.all([photoP, textP]);
    expect(order).toEqual(['photo', 'text']);
    expect(photoText).toBe('[file still copying: photo-1-901.jpg]\nthe view');
    expect(textText).toBe('and [typed image:/etc/hostname] as text');
    expect(textText).not.toContain('[image:');

    const r = await recordPlatformMedia(a.server.appConversations!, { conversationKey: KEY, platformMessageId: '901', filePath: dl, declaredKind: 'photo', filename: 'photo-1-901.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(r.recorded).toBe(true);
    b.server.appConversations!.ingestReplicated(a.server.appConversations!.store.syncEvents(KEY, null, 100).events);
    const svcB = b.server.appConversations!;
    const end = Date.now() + 20_000;
    while (!sinkB.injected.some((l) => l.includes('[file now available:')) && Date.now() < end) { await svcB.replicator.tick(); await new Promise((res) => setTimeout(res, 50)); }
    const lines = sinkB.injected.filter((l) => l.includes('[file now available:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`[telegram:${TOPIC}] [file now available: `)).toBe(true);
    const landed = /\[file now available: ([^\]]+)\]/.exec(lines[0]!)![1]!;
    expect(fs.readFileSync(landed).equals(photo)).toBe(true);
    await b.server.platformMedia!.sweep();
    expect(sinkB.injected.filter((l) => l.includes('[file now available:'))).toHaveLength(1);

    // The manual fetch route and the status route answer on the production app.
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-xm-e2e');
    // A session reaches it with its own bind token (INSTAR_BIND_TOKEN), as the production server issues it.
    const bindToken = createConversationBindAuth(b.stateDir).mint('tg-topic-session', [TOPIC]);
    expect((await auth(request(b.server.getApp()).get(`/conversation-media/path?conversationKey=${encodeURIComponent(KEY)}&platformMessageId=901`))).status).toBe(403);
    const got = await auth(request(b.server.getApp()).get(`/conversation-media/path?conversationKey=${encodeURIComponent(KEY)}&platformMessageId=901`)).set('X-Instar-Bind-Token', bindToken);
    expect(got.status).toBe(200);
    expect(fs.readFileSync(got.body.path).equals(photo)).toBe(true);
    const st = await auth(request(b.server.getApp()).get('/conversation-media/status'));
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ mediaOn: true, waiting: 0 });
    expect(st.body.counts.converted).toBe(1);
  }, 60_000);
});
