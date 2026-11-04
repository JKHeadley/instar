/**
 * Media between the agent's machines over the real HTTP pipeline
 * (docs/specs/mobile-native-chat-media.md §4.8, §4.12, §4.7 health): two in-process machines, each
 * with the production device authenticator, routes and a real MeshRpcDispatcher behind
 * `POST /mesh/rpc`; machine B's copier sends signed envelopes through a real MeshRpcClient.
 *
 * A phone paired with A sends a photo; the events replicate to B; then on B: a download answers
 * `202 fetching` and later the verified bytes, the owner's dispatch pulls before delivering (or
 * says "still copying" and follows up once with "now available"), app-media-path pulls on demand,
 * a corrupted slice is never kept, an unregistered machine is refused, and `/health?scope=pool`
 * shows both machines' appMedia.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import type { AppDispatchInput } from '../../src/core/appInboundDispatch.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager, generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { APP_MEDIA_SLICE_BYTES, type AppMediaPullCommand } from '../../src/core/AppMediaReplicator.js';
import type { MediaMessageEvent } from '../../src/core/AppConversationStore.js';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/app-media-cross-machine.test.ts' });
});

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const png = (n = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;
const keys: Record<string, { priv: string; pub: string }> = {};
let nonce = 0;

async function machine(id: string, opts: { tamper?: { on: boolean } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mxm-${id}-`));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: `machine ${id}` });
  const kp = generateSigningKeyPair();
  keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false }, native: { media: { enabled: true } } }, sessions: { maxSessions: 3 }, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => id, isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const dispatched: AppDispatchInput[] = [];
  const svc: AppConversationService = new AppConversationService({
    stateDir: dir, machineId: () => id, registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger,
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  cleanups.push(() => svc.stop());
  const seen = new Set<string>();
  const dispatcher = new MeshRpcDispatcher({
    verify: {
      selfMachineId: id,
      verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
      isRegisteredPeer: (s) => !!keys[s] && s !== 'stranger',
      seenNonce: (s, n) => seen.has(`${s}:${n}`),
      now: () => Date.now(),
    },
    rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    // The production handler (server.ts), with an optional fault: one flipped byte per slice.
    handlers: {
      'app-media-pull': async (cmd: MeshCommand) => {
        const r = await svc.replicator.serve(cmd) as { dataB64?: string };
        if (!opts.tamper?.on || !r.dataB64) return r;
        const buf = Buffer.from(r.dataB64, 'base64');
        buf[0] ^= 1;
        return { ...r, dataB64: buf.toString('base64') };
      },
    },
  });
  const bindAuth = createConversationBindAuth(dir);
  const peerUrls: Array<{ machineId: string; url: string }> = [];
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: id, meshRpcDispatcher: dispatcher,
    resolvePeerUrls: () => peerUrls,
    sessionManager: { listRunningSessions: () => [], killSession: () => true, getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: bindAuth, appConversations: svc,
  } as unknown as RouteContext;
  const keep = (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody: Buffer }).rawBody = buf; };
  const app = express();
  app.use('/mobile/media/uploads', express.raw({ type: 'application/octet-stream', limit: '1mb', verify: keep }));
  app.use(express.json({ limit: '12mb', verify: keep }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => id, mediaEnabled: true }));
  app.use(createMobileMediaRouter({ pairing, service: svc, mediaEnabled: true }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const srv = await new Promise<import('node:http').Server>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { id, app, url, dir, svc, dev, deviceId: c.device.id, dispatched, registry, bindAuth, peerUrls };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return e;
}
type Env = Awaited<ReturnType<typeof machine>>;

let tick = 0;
function signed(e: Pick<Env, 'app' | 'dev' | 'deviceId'>, method: 'GET' | 'POST' | 'PUT', p: string, body?: unknown, raw?: Buffer) {
  const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, payload));
  const base = method === 'GET' ? request(e.app).get(p) : method === 'PUT' ? request(e.app).put(p) : request(e.app).post(p);
  const q = base.set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  if (raw) return q.set('Content-Type', 'application/octet-stream').send(raw);
  return payload ? q.set('Content-Type', 'application/json').send(payload.toString()) : q;
}

/** B's copier rides a real signed MeshRpcClient to A; `reach.on=false` makes A unreachable. */
function connect(b: Env, a: Env, reach = { on: true }) {
  const client = new MeshRpcClient({ selfMachineId: b.id, sign: (c) => sign(c, keys[b.id].priv), nonce: () => `n${++nonce}`, now: () => Date.now() });
  b.svc.replicator.attachTransport({
    peers: () => [{ machineId: a.id, online: true }],
    send: async (machineId, command, timeoutMs) => {
      if (!reach.on) throw new Error('connect ECONNREFUSED');
      return client.send({ machineId, url: a.url }, command, 0, { timeoutMs });
    },
  });
  return reach;
}

/** A phone paired with A sends a photo; every event replicates to B. */
async function sendOnA(a: Env, b: Env, bytes: Buffer, caption = 'Look at this') {
  const key = (await signed(a, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
  const file = { size: bytes.length, sha256: sha(bytes), declaredKind: 'photo', declaredType: 'image/png', filename: 'holiday.png' };
  const start = await signed(a, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...file, requestId: rid() });
  const uploadId = start.body.uploadId as string;
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) {
    expect((await signed(a, 'PUT', `/mobile/media/uploads/${uploadId}/chunks/${i}`, undefined, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))).status).toBe(200);
  }
  const sent = await signed(a, 'POST', `/mobile/chat/app/${key}`, { text: caption, requestId: rid(), attachments: [{ uploadId, ...file }] });
  expect(sent.status).toBe(200);
  b.svc.ingestReplicated(a.svc.store.syncEvents(key, null, 100).events);
  const ev = b.svc.store.syncEvents(key, null, 100).events.find((x) => x.kind === 'media-message') as MediaMessageEvent;
  expect(ev).toBeDefined();
  return { key, ev };
}

/** The failed attempts while A was unreachable put the file in backoff; let that window pass. */
function elapseBackoff(b: Env, h: string): void {
  b.svc.media.indexDb.prepare('UPDATE pulls SET nextAttemptAt = 0 WHERE sha256 = ?').run(h);
}

async function until(cond: () => boolean, b: Env, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) { await b.svc.replicator.tick(); await new Promise((r) => setTimeout(r, 30)); }
}

describe('copying between machines over signed MeshRpc', () => {
  it('a download on a machine without the file answers 202 fetching, then the verified bytes', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(APP_MEDIA_SLICE_BYTES + 900);
    const { key, ev } = await sendOnA(a, b, bytes);
    connect(b, a);
    const first = await signed(b, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${key}`);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ state: 'fetching' });
    await until(() => !!b.svc.media.locateBlob(sha(bytes)), b);
    const dl = await signed(b, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${key}`).buffer(true).parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (d: Buffer) => parts.push(d)); res.on('end', () => cb(null, Buffer.concat(parts))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(bytes)).toBe(true);
    // The copy is the bytes A holds, read independently from A's disk.
    expect(fs.readFileSync(b.svc.media.locateBlob(sha(bytes))!).equals(fs.readFileSync(a.svc.media.locateBlob(sha(bytes))!))).toBe(true);
    expect(b.svc.replicator.counters.slicesPulled).toBe(2);
    expect(a.svc.replicator.counters.slicesServed).toBe(2);
    const hist = await signed(b, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0].attachments[0]).toMatchObject({ attachmentId: ev.attachments[0].attachmentId, bytes: 'verified' });
  }, 30_000);

  it('a download answers 404 with the reason, not 202, when no copy can start', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(300);
    const { key } = await sendOnA(a, b, bytes);
    b.svc.replicator.attachTransport({ peers: () => [{ machineId: 'A', nickname: 'the mini', online: false }], send: async () => ({ ok: false }) });
    const r = await signed(b, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${key}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'media-unavailable', detail: 'This file is not on this machine: the mini is not reachable.' });
  }, 30_000);

  it('a corrupted slice is never kept, and the failure is counted for that peer', async () => {
    const tamper = { on: true };
    const a = await machine('A', { tamper });
    const b = await machine('B');
    const bytes = png(500);
    await sendOnA(a, b, bytes);
    connect(b, a);
    await b.svc.replicator.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(b.svc.media.locateBlob(sha(bytes))).toBeNull();
    expect(b.svc.replicator.counters.verifyFailures).toBe(1);
    expect(fs.readdirSync(b.svc.media.pullsDir)).toEqual([]);
  }, 30_000);

  it('an unregistered machine is refused at the envelope', async () => {
    const a = await machine('A');
    const kp = generateSigningKeyPair();
    keys.stranger = { priv: kp.privateKey, pub: kp.publicKey };
    const client = new MeshRpcClient({ selfMachineId: 'stranger', sign: (c) => sign(c, kp.privateKey), nonce: () => `s${++nonce}`, now: () => Date.now() });
    const cmd: AppMediaPullCommand = { type: 'app-media-pull', op: 'inventory' };
    const r = await client.send({ machineId: a.id, url: a.url }, cmd, 0);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe('the owner delivers media it does not hold yet', () => {
  it('pulls before delivering when the file arrives within the wait', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(300);
    const { key, ev } = await sendOnA(a, b, bytes);
    connect(b, a);
    const lines = await b.svc.sessionLinesFor(key, ev.messageId, ev.attachments, ev.text, 10_000);
    expect(lines).toHaveLength(1);
    const p = /^\[image:(.+)\]$/.exec(lines[0])![1];
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
  }, 30_000);

  it('past the wait: "still copying", then exactly one "now available" line when it lands', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(300);
    const { key, ev } = await sendOnA(a, b, bytes, 'Here is the plan for Saturday morning, see attached');
    const reach = connect(b, a, { on: false });
    const followUps: Array<{ alias: number; line: string }> = [];
    b.svc.setFollowUp((alias, line) => { followUps.push({ alias, line }); return true; });
    const lines = await b.svc.sessionLinesFor(key, ev.messageId, ev.attachments, ev.text, 200);
    expect(lines).toEqual(['[file still copying: holiday.png]']);
    reach.on = true;
    elapseBackoff(b, sha(bytes));
    await until(() => followUps.length > 0, b);
    expect(followUps).toHaveLength(1);
    expect(followUps[0].alias).toBe(b.registry.appAliasFor(key));
    expect(followUps[0].line).toMatch(/^\[app:-?\d+ "Plans" from Justin\] \[file now available: .+\] \(for the message "Here is the plan for Saturday morning, s"\)$/);
    const p = /\[file now available: (.+?)\]/.exec(followUps[0].line)![1];
    expect(fs.readFileSync(p).equals(bytes)).toBe(true);
    await b.svc.resolvePending(sha(bytes));
    expect(followUps).toHaveLength(1);
    expect(b.svc.pendingContext(key).lines).toEqual([]);
  }, 30_000);

  it('with no live session the line waits for the next delivery, and is delivered once', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(300);
    const { key, ev } = await sendOnA(a, b, bytes);
    const reach = connect(b, a, { on: false });
    b.svc.setFollowUp(() => false);
    await b.svc.sessionLinesFor(key, ev.messageId, ev.attachments, ev.text, 100);
    reach.on = true;
    elapseBackoff(b, sha(bytes));
    await until(() => b.svc.pendingContext(key).lines.length > 0, b);
    const pending = b.svc.pendingContext(key);
    expect(pending.lines).toHaveLength(1);
    expect(pending.lines[0]).toMatch(/^\[file now available: /);
    // The next phone message on B carries it in the session's context, then it is gone.
    await signed(b, 'POST', `/mobile/chat/app/${key}`, { text: 'did you get it?', requestId: rid() });
    expect(b.dispatched.at(-1)!.notes).toEqual(pending.lines);
    expect(b.svc.pendingContext(key).lines).toEqual([]);
  }, 30_000);

  it('app-media-path pulls an earlier file on demand', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(400);
    const { key, ev } = await sendOnA(a, b, bytes);
    connect(b, a);
    const alias = b.registry.appAliasFor(key)!;
    const token = b.bindAuth.mint('sess-app', [alias]) as string;
    const r = await request(b.app).get(`/app/media-path/${ev.attachments[0].attachmentId}?conversationId=${alias}`).set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', token);
    expect(r.status).toBe(200);
    expect(fs.readFileSync(r.body.path).equals(bytes)).toBe(true);
  }, 30_000);

  it('app-media-path says plainly why a file is not here when no machine can provide it', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const { key, ev } = await sendOnA(a, b, png(400));
    // No transport: this machine is not connected to the others.
    const alias = b.registry.appAliasFor(key)!;
    const token = b.bindAuth.mint('sess-app', [alias]) as string;
    const r = await request(b.app).get(`/app/media-path/${ev.attachments[0].attachmentId}?conversationId=${alias}`).set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', token);
    expect(r.status).toBe(404);
    expect(r.body.detail).toMatch(/not on this machine yet; this machine is not connected/);
  }, 30_000);
});

describe('/health appMedia', () => {
  it('?scope=pool merges every machine and marks an unreachable one failed', async () => {
    const a = await machine('A');
    const b = await machine('B');
    const bytes = png(300);
    await sendOnA(a, b, bytes);
    b.peerUrls.push({ machineId: a.id, url: a.url }, { machineId: 'C', url: 'http://127.0.0.1:1' });
    const r = await request(b.app).get('/health?scope=pool').set('Authorization', 'Bearer tok-1');
    expect(r.status).toBe(200);
    const pool = r.body.appMediaPool;
    expect(pool.machines.map((m: { machineId: string }) => m.machineId).sort()).toEqual(['A', 'B']);
    const am = pool.machines.find((m: { machineId: string }) => m.machineId === 'A').appMedia;
    expect(am.blobs).toBe(1);
    expect(am.singleCopyBlobs).toBeNull(); // A has no transport: cannot be measured, never 0
    expect(pool.failed.map((f: { machineId: string }) => f.machineId)).toEqual(['C']);
    // Without the token there is no pool read.
    const anon = await request(b.app).get('/health?scope=pool');
    expect(anon.body.appMediaPool).toBeUndefined();
  }, 30_000);
});
