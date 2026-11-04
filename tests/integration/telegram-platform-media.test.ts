/**
 * Telegram media in the app's view of a Telegram conversation (docs/specs/mobile-native-chat-media.md
 * §4.9, Telegram half) over the real HTTP pipeline and the production device authenticator: a photo
 * and a document recorded from a Telegram topic appear as `attachments` on the device's history rows
 * with no server path in the text; a download with `ref=telegram:<topicId>` serves the bytes; a hash
 * not referenced in that topic (or referenced in another topic) answers 404; a bearer read keeps the
 * raw row; media off ⇒ the download route answers 503.
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
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { recordPlatformMedia } from '../../src/core/appPlatformMedia.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const HOST = 'echo.example.dev';
const TOPIC = 42;
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/telegram-platform-media.test.ts' });
});

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const jpeg = (n = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);

async function setup(opts: { mediaEnabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgmedia-'));
  dirs.push(dir);
  const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false }, native: { media: { enabled: opts.mediaEnabled ?? true } } }, sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' } };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    dispatch: () => async () => 'delivered',
  });
  // The Telegram log rows the adapter would hold (the handler's own text, with its download path).
  const rows: Array<Record<string, unknown>> = [];
  const telegram = {
    getTopicHistory: (_t: number, limit: number) => rows.slice(-limit),
    getTopicHistoryBefore: (_t: number, _b: number, limit: number) => rows.slice(-limit),
  };
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1', telegram,
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, appConversations: svc,
  } as unknown as RouteContext;
  const keep = (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody: Buffer }).rawBody = buf; };
  const app = express();
  app.use(express.json({ verify: keep }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileMediaRouter({ pairing, service: svc, mediaEnabled: opts.mediaEnabled ?? true }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, deviceId: c.device.id, rows };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;

let tick = 0;
function signed(e: Pick<Env, 'app' | 'dev' | 'deviceId'>, method: 'GET' | 'POST', p: string, body?: unknown) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now() + (tick++ % 1000));
  const sig = e.dev.sign(canonicalString(e.deviceId, HOST, method, p, time, payload));
  const q = (method === 'GET' ? request(e.app).get(p) : request(e.app).post(p))
    .set('X-Instar-Device', e.deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return payload ? q.set('Content-Type', 'application/json').send(payload.toString()) : q;
}

/** What the Telegram photo handler does: download, then (with media on) record, then log the row. */
async function telegramPhoto(e: Env, messageId: number, bytes: Buffer, caption = '', topic = TOPIC) {
  const p = path.join(e.dir, 'telegram-images', `photo-${Date.now()}-${messageId}.jpg`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  const r = await recordPlatformMedia(e.svc, { conversationKey: `telegram:${topic}`, platformMessageId: String(messageId), filePath: p, declaredKind: 'photo', filename: path.basename(p), declaredType: 'image/jpeg', at: new Date().toISOString() });
  e.rows.push({ messageId, topicId: topic, text: caption ? `[image:${p}] ${caption}` : `[image:${p}]`, fromUser: true, timestamp: new Date().toISOString(), sessionName: null });
  return { p, r };
}

describe('Telegram media in a device history read', () => {
  it('a recorded photo and document: rows carry attachments, the text has no path; the bearer read is unchanged', async () => {
    const e = await setup();
    const photo = jpeg();
    const { p, r } = await telegramPhoto(e, 101, photo, 'look at this');
    expect(r.recorded).toBe(true);
    const pdf = Buffer.from('%PDF-1.7 hello');
    const docPath = path.join(e.dir, 'telegram-documents', '1761999999999-Q3_report.pdf');
    fs.mkdirSync(path.dirname(docPath), { recursive: true });
    fs.writeFileSync(docPath, pdf);
    await recordPlatformMedia(e.svc, { conversationKey: `telegram:${TOPIC}`, platformMessageId: '102', filePath: docPath, declaredKind: 'file', filename: 'Q3 report.pdf', declaredType: 'application/pdf', at: new Date().toISOString() });
    e.rows.push({ messageId: 102, topicId: TOPIC, text: `[document:${docPath}]`, fromUser: true, timestamp: new Date().toISOString() });
    // A row typed in Telegram before media was on: no event, but still no path.
    e.rows.push({ messageId: 103, topicId: TOPIC, text: `[image:${path.join(e.dir, 'telegram-images', 'old.jpg')}]`, fromUser: true, timestamp: new Date().toISOString() });

    const res = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(res.status).toBe(200);
    const msgs = res.body.messages as Array<Record<string, any>>;
    expect(JSON.stringify(msgs)).not.toContain(e.dir);
    const byId = new Map(msgs.map((m) => [m.messageId, m]));
    expect(byId.get(101)!.text).toBe('[photo] look at this');
    expect(byId.get(101)!.attachments[0]).toMatchObject({ kind: 'photo', sha256: sha(photo), size: photo.length, mediaType: 'image/jpeg', bytes: 'verified' });
    expect(byId.get(102)!.text).toBe('[file: Q3 report.pdf]');
    expect(byId.get(102)!.attachments[0]).toMatchObject({ kind: 'file', mediaType: 'application/pdf', filename: 'Q3 report.pdf' });
    expect(byId.get(103)!.text).toBe('[photo]');
    expect(byId.get(103)!.attachments).toBeUndefined();

    const bearer = await request(e.app).get(`/telegram/topics/${TOPIC}/messages`).set('Authorization', 'Bearer tok-1');
    expect(bearer.status).toBe(200);
    expect((bearer.body.messages as Array<Record<string, unknown>>).find((m) => m.messageId === 101)!.text).toBe(`[image:${p}] look at this`);
    expect((bearer.body.messages as Array<Record<string, unknown>>).find((m) => m.messageId === 101)!.attachments).toBeUndefined();
  });

  it('downloads with ref=telegram:<topic>; a hash not referenced in that topic is 404', async () => {
    const e = await setup();
    const photo = jpeg();
    await telegramPhoto(e, 201, photo);
    const other = jpeg();
    await telegramPhoto(e, 202, other, '', 7); // recorded in topic 7, not 42
    const dl = await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=telegram:${TOPIC}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/jpeg');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(dl.body as Buffer).equals(photo)).toBe(true);
    expect((await signed(e, 'GET', `/mobile/media/${sha(other)}?ref=telegram:${TOPIC}`)).status).toBe(404);
    expect((await signed(e, 'GET', `/mobile/media/${sha(other)}?ref=telegram:7`)).status).toBe(200);
    expect((await signed(e, 'GET', `/mobile/media/${'0'.repeat(64)}?ref=telegram:${TOPIC}`)).status).toBe(404);
    expect((await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=telegram:abc`)).status).toBe(404);
    // A bearer token cannot download.
    expect((await request(e.app).get(`/mobile/media/${sha(photo)}?ref=telegram:${TOPIC}`).set('Authorization', 'Bearer tok-1')).status).toBe(403);
  });

  it('the same Telegram message recorded twice keeps one event', async () => {
    const e = await setup();
    const photo = jpeg();
    await telegramPhoto(e, 301, photo);
    const p2 = path.join(e.dir, 'again.jpg');
    fs.writeFileSync(p2, photo);
    const again = await recordPlatformMedia(e.svc, { conversationKey: `telegram:${TOPIC}`, platformMessageId: '301', filePath: p2, declaredKind: 'photo', filename: 'again.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(again).toMatchObject({ recorded: false, reason: 'duplicate' });
    expect(e.svc.store.mediaAttachmentIds(`telegram:${TOPIC}`)).toHaveLength(1);
  });

  it('with media off the download route answers 503', async () => {
    const e = await setup({ mediaEnabled: false });
    expect((await signed(e, 'GET', `/mobile/media/${'0'.repeat(64)}?ref=telegram:${TOPIC}`)).status).toBe(503);
  });
});
