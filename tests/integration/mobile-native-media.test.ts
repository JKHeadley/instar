/**
 * Media in app conversations over the real HTTP pipeline (docs/specs/mobile-native-chat-media.md,
 * increment 1): uploads through the production device authenticator (chunks signed over raw
 * bodies), a send with attachments, session lines, history with `originVerified` and `bytes`, the
 * download headers and ranges, the signed-record checks on each attachment field, redaction v2,
 * purge, app-reply files and app-media-path.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-native-media.test.ts' });
});

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const png = (n = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function setup(opts: { mediaEnabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmedia-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false }, native: { media: { enabled: opts.mediaEnabled ?? true } } }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
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
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger,
    dispatch: () => async (input) => { dispatched.push(input); svc.channels.register(String(input.alias), 'sess-app'); return 'delivered'; },
  });
  const bindAuth = createConversationBindAuth(dir);
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: bindAuth, appConversations: svc,
  } as unknown as RouteContext;
  const keep = (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody: Buffer }).rawBody = buf; };
  const app = express();
  app.use('/mobile/media/uploads', express.raw({ type: 'application/octet-stream', limit: '1mb', verify: keep }));
  app.use(express.json({ verify: keep }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1', mediaEnabled: opts.mediaEnabled ?? true }));
  app.use(createMobileMediaRouter({ pairing, service: svc, mediaEnabled: opts.mediaEnabled ?? true }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, dispatched, pairing, bindAuth, registry };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;

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

const newConversation = async (e: Env) => (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;

const describeFile = (bytes: Buffer, over: Record<string, unknown> = {}) => ({ size: bytes.length, sha256: sha(bytes), declaredKind: 'photo', declaredType: 'image/png', filename: 'holiday.png', ...over });

async function upload(e: Env, key: string, bytes: Buffer, over: Record<string, unknown> = {}): Promise<string> {
  const start = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...describeFile(bytes, over), requestId: rid() });
  expect(start.status).toBe(200);
  const id = start.body.uploadId as string;
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) {
    const r = await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/${i}`, undefined, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    expect(r.status).toBe(200);
  }
  return id;
}

const sendFile = async (e: Env, key: string, bytes: Buffer, extra: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => {
  const uploadId = await upload(e, key, bytes, over);
  return signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'Look at this', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes, over), ...extra }] });
};

describe('uploads through the device authenticator', () => {
  it('a chunk carries a raw signed body; JSON to the chunk route and octet to other routes are refused with 415', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    const start = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...describeFile(bytes), requestId: rid() });
    const id = start.body.uploadId as string;
    expect((await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/0`, { not: 'bytes' })).status).toBe(415);
    expect((await signed(e, 'POST', '/mobile/media/uploads', undefined, Buffer.from('x'))).status).toBe(415);
    expect((await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/07`, undefined, bytes)).status).toBe(403);
    const ok = await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/0`, undefined, bytes);
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('complete');
  });

  it('a bearer token cannot upload; a retry of the start answers the same upload; a changed field conflicts', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png(CHUNK_BYTES + 100);
    expect((await request(e.app).post('/mobile/media/uploads').set('Authorization', 'Bearer tok-1').send({})).status).toBe(403);
    const requestId = rid();
    const body = { conversationRef: `app:${key}`, ...describeFile(bytes), requestId };
    const a = await signed(e, 'POST', '/mobile/media/uploads', body);
    await signed(e, 'PUT', `/mobile/media/uploads/${a.body.uploadId}/chunks/0`, undefined, bytes.subarray(0, CHUNK_BYTES));
    const b = await signed(e, 'POST', '/mobile/media/uploads', body);
    expect(b.body.uploadId).toBe(a.body.uploadId);
    expect(b.body.received).toEqual([0]);
    expect((await signed(e, 'POST', '/mobile/media/uploads', { ...body, filename: 'other.png' })).status).toBe(409);
  });

  it('refuses control characters in an upload\'s name or type', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    for (const over of [{ filename: 'a\nb.png' }, { declaredType: 'image/png\r' }]) {
      const r = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...describeFile(bytes, over), requestId: rid() });
      expect(r.status).toBe(400);
    }
  });

  it('resumes after a dropped chunk, and an unknown upload answers 404 upload-unknown', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png(CHUNK_BYTES * 2 + 10);
    const a = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...describeFile(bytes), requestId: rid() });
    const id = a.body.uploadId as string;
    await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/1`, undefined, bytes.subarray(CHUNK_BYTES, 2 * CHUNK_BYTES));
    const st = await signed(e, 'GET', `/mobile/media/uploads/${id}`);
    expect(st.body).toMatchObject({ received: [1], state: 'open' });
    expect((await signed(e, 'GET', `/mobile/media/uploads/${crypto.randomUUID()}`)).body.error).toBe('upload-unknown');
  });

  it('chunks draw on their own bucket, not the read allowance', async () => {
    const e = await setup();
    for (let i = 0; i < 240; i++) expect(e.pairing.deviceBucketOk(e.deviceId, 240)).toBe(true);
    expect(e.pairing.deviceBucketOk(e.deviceId, 240)).toBe(false);
    expect(e.pairing.deviceRateOk(e.deviceId)).toBe(true);
  });

  it('a full replay guard still admits an emergency stop while reads are refused', async () => {
    const e = await setup();
    const key = await newConversation(e);
    for (let i = 0; i < 2000; i++) e.pairing.replay.admit(e.deviceId, `filler-${i}`);
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/messages`)).status).toBe(429);
    const stop = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop everything', requestId: rid() });
    expect(stop.status).not.toBe(429);
  });
});

describe('sending media', () => {
  it('delivers paths to the session, keeps the signature and serves the bytes', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    const sent = await sendFile(e, key, bytes);
    expect(sent.status).toBe(200);
    expect(sent.body.deliveryState).toBe('delivered');
    const d = e.dispatched[0]!;
    expect(d.originVerdict).toBe('verified');
    const line = /^\[image:(.+)\]\nLook at this$/.exec(d.text);
    expect(line).not.toBeNull();
    expect(fs.readFileSync(line![1]!).equals(bytes)).toBe(true);

    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    const row = hist.body.messages[0];
    expect(row).toMatchObject({ originVerified: 'verified', text: 'Look at this' });
    expect(row.attachments[0]).toMatchObject({ kind: 'photo', mediaType: 'image/png', sha256: sha(bytes), bytes: 'verified' });
    expect(JSON.stringify(hist.body)).not.toContain(e.dir);

    const dl = await signed(e, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${key}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(bytes)).toBe(true);
    expect(dl.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, no-store', 'cross-origin-resource-policy': 'same-origin' });

    const sync = await signed(e, 'GET', `/mobile/chat/app/${key}/events`);
    expect(sync.body.events.find((x: { kind: string }) => x.kind === 'media-message')).toMatchObject({ originVerified: 'verified' });
    expect(sent.body.reclassified).toBeUndefined();
  });

  it('honors a range and refuses an impossible one', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    await sendFile(e, key, bytes);
    const p = `/mobile/media/${sha(bytes)}?ref=app:${key}`;
    const part = await signed(e, 'GET', p).set('Range', 'bytes=2-5').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(part.status).toBe(206);
    expect((part.body as Buffer).equals(bytes.subarray(2, 6))).toBe(true);
    expect(part.headers['content-range']).toBe(`bytes 2-5/${bytes.length}`);
    expect((await signed(e, 'GET', p).set('Range', 'bytes=999999-')).status).toBe(416);
  });

  it('a misdeclared file is delivered as a file and never served as what it claims', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const sent = await sendFile(e, key, html, {}, { declaredKind: 'photo', declaredType: 'image/png', filename: 'x.html' });
    expect(sent.status).toBe(200);
    expect(sent.body.reclassified).toEqual([0]);
    expect(e.dispatched[0]!.originVerdict).toBe('verified');
    expect(e.dispatched[0]!.text).toContain('[document:');
    const dl = await signed(e, 'GET', `/mobile/media/${sha(html)}?ref=app:${key}`);
    expect(dl.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="x"$/);
  });

  it('a hash the named conversation does not reference answers the same 404 as one nobody holds', async () => {
    const e = await setup();
    const a = await newConversation(e);
    const b = await newConversation(e);
    const bytes = png();
    await sendFile(e, a, bytes);
    const held = await signed(e, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${b}`);
    const nobody = await signed(e, 'GET', `/mobile/media/${'c'.repeat(64)}?ref=app:${b}`);
    expect(held.status).toBe(404);
    expect(held.body).toEqual(nobody.body);
  });

  it('a revoked device is refused at once', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    await sendFile(e, key, bytes);
    expect(e.pairing.devices.revoke(e.deviceId)).toBe(true);
    expect((await signed(e, 'GET', `/mobile/media/${sha(bytes)}?ref=app:${key}`)).status).toBe(401);
  });

  it('a body that does not match its upload, or names one twice, is refused', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    const uploadId = await upload(e, key, bytes);
    const mismatch = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes, { filename: 'renamed.png' }) }] });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ error: 'attachment-mismatch', index: 0 });
    const send = () => signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect((await send()).status).toBe(200);
    expect((await send()).body.error).toBe('upload-already-sent');
  });

  it('a retried send answers the recorded result and appends nothing', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    const uploadId = await upload(e, key, bytes);
    const body = { text: 'once', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] };
    const a = await signed(e, 'POST', `/mobile/chat/app/${key}`, body);
    const b = await signed(e, 'POST', `/mobile/chat/app/${key}`, body);
    expect(b.body.messageId).toBe(a.body.messageId);
    expect(e.dispatched).toHaveLength(1);
  });

  it('refuses a record that would not fit, before any upload is claimed', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const uploads: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      const bytes = png();
      const over = { filename: `${String(i)}${'n'.repeat(250)}.png` };
      const uploadId = await upload(e, key, bytes, over);
      uploads.push({ uploadId, ...describeFile(bytes, over), transcript: 'word '.repeat(799) });
    }
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x'.repeat(4000), requestId: rid(), attachments: uploads });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('message-too-large');
    expect(e.svc.media.getUpload(uploads[0]!.uploadId as string)!.state).toBe('complete');
  });

  it('a Telegram send with attachments is refused, never stored without its files', async () => {
    const e = await setup();
    const r = await signed(e, 'POST', '/mobile/chat/77', { text: 'x', requestId: rid(), attachments: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('media-target-unsupported');
  });

  it('an exact emergency stop with attachments still stops', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const r = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'stop everything', requestId: rid(), attachments: [{ bad: true }] });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('sentinel-kill');
  });
});

describe('signed records with media', () => {
  const storedFile = (e: Env) => {
    const dir = path.join(e.dir, 'app-conversations');
    return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(dir, n)).find((f) => fs.readFileSync(f, 'utf8').includes('media-message'))!;
  };

  it.each([
    ['sha256', (a: Record<string, unknown>) => { a.sha256 = 'd'.repeat(64); }],
    ['size', (a: Record<string, unknown>) => { a.size = 7; }],
    ['declaredKind', (a: Record<string, unknown>) => { a.declaredKind = 'file'; }],
    ['declaredType', (a: Record<string, unknown>) => { a.declaredType = 'text/plain'; }],
    ['filename', (a: Record<string, unknown>) => { a.filename = 'other.png'; }],
    ['transcript', (a: Record<string, unknown>) => { a.transcript = 'something else'; }],
  ])('a changed stored %s reads failed', async (_n, change) => {
    const e = await setup();
    const key = await newConversation(e);
    await sendFile(e, key, png(), { transcript: 'said words' });
    const file = storedFile(e);
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => {
      if (!l.includes('media-message')) return l;
      const ev = JSON.parse(l) as { attachments: Array<Record<string, unknown>> };
      change(ev.attachments[0]!);
      return JSON.stringify(ev);
    });
    fs.writeFileSync(file, lines.join('\n'));
    e.svc.store.rebuildIndex();
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    expect(hist.body.messages[0].originVerified).toBe('failed');
  });

  it('the effective kind and media type are not part of the check', async () => {
    const e = await setup();
    const key = await newConversation(e);
    await sendFile(e, key, png());
    const file = storedFile(e);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"kind":"photo"', '"kind":"file"'));
    e.svc.store.rebuildIndex();
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/messages`)).body.messages[0].originVerified).toBe('verified');
  });

  it('an invite in a transcript or filename is removed everywhere, and the record reads redacted', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const inTranscript = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    const inName = `tlinv1:${crypto.randomBytes(9).toString('base64url')}.${crypto.randomBytes(9).toString('base64url')}`;
    const sent = await sendFile(e, key, png(), { transcript: `use ${inTranscript} please` }, { filename: `${inName}.png`, declaredKind: 'voice' });
    expect(sent.body.redacted).toBe(true);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    const row = hist.body.messages[0];
    expect(row.originVerified).toBe('redacted');
    expect(row.attachments[0].transcript).toBe('use [pairing invite removed] please');
    expect(row.attachments[0].filename).toContain('[pairing invite removed]');
    expect(e.dispatched[0]!.text).not.toContain('tlinv1:');
  });

  it('a changed attachment on a redacted record reads failed through the v2 payload', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const token = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    await sendFile(e, key, png(), { transcript: `use ${token}` });
    const file = storedFile(e);
    expect(fs.readFileSync(file, 'utf8')).toContain('"v":2');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"filename":"holiday.png"', '"filename":"other.png"'));
    e.svc.store.rebuildIndex();
    expect((await signed(e, 'GET', `/mobile/chat/app/${key}/messages`)).body.messages[0].originVerified).toBe('failed');
  });
});

describe('purge', () => {
  it('refuses a live conversation, then removes the bytes of a deleted one and keeps the record', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const bytes = png();
    await sendFile(e, key, bytes);
    const live = await signed(e, 'POST', '/mobile/media/purge', { conversationKeys: [key], requestId: rid() });
    expect(live.status).toBe(409);
    expect(live.body.error).toBe('conversation-live');
    await signed(e, 'DELETE' as never, `/mobile/conversations/${key}`, undefined).catch(() => undefined);
    e.svc.applyDelete(e.deviceId, rid(), key);
    expect(e.svc.media.locateBlob(sha(bytes))).toContain('deleted');
    const requestId = rid();
    const done = await signed(e, 'POST', '/mobile/media/purge', { conversationKeys: [key], requestId });
    expect(done.body).toMatchObject({ ok: true, purged: 1 });
    expect(e.svc.media.locateBlob(sha(bytes))).toBeNull();
    const again = await signed(e, 'POST', '/mobile/media/purge', { conversationKeys: [key], requestId });
    expect(again.body.purged).toBe(1);
  });

  it('batches a large purge and resumes it after a crash, merging repeated batches away', async () => {
    const e = await setup();
    const key = '33333333-3333-4333-8333-333333333333';
    e.svc.store.append({ eventId: 'c', kind: 'created', conversationKey: key, title: 'x', at: new Date().toISOString(), machineId: 'm1' });
    const ids = Array.from({ length: 1200 }, (_, i) => sha(`a${i}`));
    const first = e.svc.applyPurge('d', 'r', { [`app:${key}`]: ids });
    const repeat = e.svc.applyPurge('d', 'r', { [`app:${key}`]: ids });
    expect(first.purged).toBe(1200);
    expect(repeat.purged).toBe(1200);
    expect(e.svc.store.syncEvents(key, null, 100).events.filter((x) => x.kind === 'purge')).toHaveLength(3);
  });
});

describe('the agent side', () => {
  async function bound(e: Env, key: string) {
    const alias = e.registry.appAliasFor(key)!;
    return { alias, token: e.bindAuth.mint('sess-app', [alias]) as string };
  }

  it('a reply with a file round-trips, with and without a caption, and reads back to the phone', async () => {
    const e = await setup();
    const key = await newConversation(e);
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'send the report', requestId: rid() });
    const { alias, token } = await bound(e, key);
    const report = path.join(e.svc.media.outboxDir, 'report.pdf');
    fs.writeFileSync(report, '%PDF-1.7 the report body');
    const r = await request(e.app).post('/app/session-reply').set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: '', files: [{ path: report }] });
    expect(r.status).toBe(200);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    const row = hist.body.messages.at(-1);
    expect(row).toMatchObject({ role: 'agent', originVerified: 'none' });
    expect(row.attachments[0]).toMatchObject({ kind: 'file', mediaType: 'application/pdf', filename: 'report.pdf', bytes: 'verified' });
    const dl = await signed(e, 'GET', `/mobile/media/${row.attachments[0].sha256}?ref=app:${key}`);
    expect(dl.headers['content-type']).toMatch(/^application\/pdf/);
    // The exact repeat is suppressed; the reservation does not leak.
    const dup = await request(e.app).post('/app/session-reply').set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: '', files: [{ path: report }] });
    expect(dup.body.suppressed).toBe(true);
    expect(e.svc.media.reservedBytes()).toBe(0);
  });

  it('refuses a key-material path', async () => {
    const e = await setup();
    const key = await newConversation(e);
    await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'hi', requestId: rid() });
    const { alias, token } = await bound(e, key);
    const secret = path.join(e.dir, '.ssh', 'id_ed25519');
    fs.mkdirSync(path.dirname(secret));
    fs.writeFileSync(secret, 'key');
    const r = await request(e.app).post('/app/session-reply').set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: 'here', files: [{ path: secret }] });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('key-material');
  });

  it('app-media-path makes a copy on demand, for the bound conversation only', async () => {
    const e = await setup();
    const key = await newConversation(e);
    const other = await newConversation(e);
    const bytes = png();
    const sent = await sendFile(e, key, bytes);
    await signed(e, 'POST', `/mobile/chat/app/${other}`, { text: 'hi', requestId: rid() });
    const a = await bound(e, key);
    const b = await bound(e, other);
    const hist = await signed(e, 'GET', `/mobile/chat/app/${key}/messages`);
    const id = hist.body.messages[0].attachments[0].attachmentId as string;
    SafeFsExecutor.safeRmSync(path.dirname(/\[image:(.+)\]/.exec(e.dispatched[0]!.text)![1]!), { recursive: true, force: true, operation: 'tests/integration/mobile-native-media.test.ts' });
    const r = await request(e.app).get(`/app/media-path/${id}?conversationId=${a.alias}`).set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', a.token);
    expect(r.status).toBe(200);
    expect(fs.readFileSync(r.body.path).equals(bytes)).toBe(true);
    const crossed = await request(e.app).get(`/app/media-path/${id}?conversationId=${b.alias}`).set('Authorization', 'Bearer tok-1').set('X-Instar-Bind-Token', b.token);
    expect(crossed.status).toBe(404);
    expect(sent.status).toBe(200);
  });
});

describe('with the feature off', () => {
  it('the media routes answer 503, a send with attachments 400 and the reply 503', async () => {
    const e = await setup({ mediaEnabled: false });
    const key = await newConversation(e);
    const start = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...describeFile(png()), requestId: rid() });
    expect(start.status).toBe(503);
    expect(start.body.error).toBe('media-off');
    const send = await signed(e, 'POST', `/mobile/chat/app/${key}`, { text: 'x', requestId: rid(), attachments: [{ uploadId: 'u' }] });
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('media-off');
    expect((await signed(e, 'POST', '/mobile/media/purge', { conversationKeys: ['telegram:5'], requestId: rid() })).status).toBe(200);
  });
});
