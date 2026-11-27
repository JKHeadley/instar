/**
 * Slack media in the app's view of a Slack conversation (docs/specs/mobile-native-chat-media.md
 * §4.9, Slack half) over the real HTTP pipeline, the production device authenticator, a real
 * conversation registry and a stub Slack adapter: files recorded from a Slack message (under the
 * key the registry mint gives its routing key) appear as `attachments` on the device's history
 * rows with no server path in the text, and the read names the `conversationKey` a download uses;
 * a download with that `ref` serves the bytes; a hash not referenced in that conversation, a
 * conversation this machine does not hold, or a malformed ref answers 404; a bearer read keeps
 * the raw row; the unified list's preview has no path.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createMobileConversationRouter } from '../../src/server/mobileConversationRoutes.js';
import { createMobileMediaRouter } from '../../src/server/mobileMediaRoutes.js';
import { buildMobileSlackBridge, createMobileSlackRouter, slackListRows, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { recordPlatformMedia, slackConversationHeldLocally, slackMediaConversationKey, slackPlatformMessageId } from '../../src/core/appPlatformMedia.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';

const HOST = 'echo.example.dev';
const OWNER = 'U0OWNER1';
const CHANNEL = 'C0123ABC';
const dirs: string[] = [];
const cleanups: Array<() => void> = [];
beforeAll(() => {
  ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null);
  // These tests cover media references, not the host's disk-capacity guard.
  vi.spyOn(AppMediaStore.prototype, 'diskSpace').mockReturnValue({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 });
});
afterAll(() => {
  vi.restoreAllMocks();
  ProcessIntegrity.reset();
  for (const c of cleanups) c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/slack-platform-media.test.ts' });
});

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const jpeg = (n = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);

async function setup(opts: { mediaEnabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmedia-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, slackOwnerUserId: OWNER, native: { media: { enabled: opts.mediaEnabled ?? true } } },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    dispatch: () => null,
  });
  cleanups.push(() => svc.stop());
  const logPath = path.join(dir, 'slack-messages.jsonl');
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [], getBotUserId: () => 'UBOT', getLogPath: () => logPath,
    logMessage: (e) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString() })}\n`),
    sendToChannel: async () => '1793615401.000001', getSessionForChannel: () => null, isAuthorized: (u) => u === OWNER,
  };
  const bridge = buildMobileSlackBridge({ adapter, registry, dispatch: () => null, killAllSessions: () => false, sendEscape: () => undefined, holdsLease: () => true });
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createMobileSlackRouter({ config: config as never, pairing, service: svc, slack: () => bridge, machineId: () => 'm1' }));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1', slackConversations: () => slackListRows(bridge) }));
  app.use(createMobileMediaRouter({ pairing, service: svc, mediaEnabled: opts.mediaEnabled ?? true, slackHeld: (k) => slackConversationHeldLocally(registry, k) }));
  app.use(createMobilePairingRouter(pairing, deps, { config } as never));
  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  // The conversation key exactly as the server's Slack hook computes it (the dispatch's mint).
  const key = slackMediaConversationKey(registry, CHANNEL)!;
  const convId = registry.mintForInbound(CHANNEL).id!;
  const e = { app, dir, svc, dev, deviceId: c.device.id, logPath, key, convId, registry };
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

/** What the Slack inbound path does with media on: download, record each file, log the row. */
async function slackMessage(e: Env, ts: string, files: Array<{ bytes: Buffer; kind: 'photo' | 'file'; name: string; type: string }>, caption = 'see', channel = CHANNEL) {
  const tags: string[] = [];
  const key = slackMediaConversationKey(e.registry, channel)!;
  for (const [i, f] of files.entries()) {
    const p = path.join(e.dir, 'slack-files', `${f.kind === 'photo' ? 'photo' : 'file'}-${Date.now()}-F${i}.${f.name.split('.').pop()}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.bytes);
    const r = await recordPlatformMedia(e.svc, { conversationKey: key, platformMessageId: slackPlatformMessageId(ts, i), filePath: p, declaredKind: f.kind, filename: f.name, declaredType: f.type, at: new Date(parseFloat(ts) * 1000).toISOString() });
    expect(r.recorded).toBe(true);
    tags.push(f.kind === 'photo' ? `[image:${p}]` : `[document:${p}]`);
  }
  fs.appendFileSync(e.logPath, `${JSON.stringify({ messageId: ts, channelId: channel, text: `${caption} ${tags.join(' ')}`, fromUser: true, timestamp: new Date(parseFloat(ts) * 1000).toISOString(), senderName: 'Justin', platform: 'slack' })}\n`);
}

const hist = (e: Env) => `/mobile/chat/slack/${e.convId}/messages?machine=m1`;

describe('Slack media in a device history read', () => {
  it('rows carry attachments in file order, the text has no path, the read names its conversationKey; bearer is raw', async () => {
    const e = await setup();
    const photo = jpeg();
    const pdf = Buffer.from('%PDF-1.7 slack');
    await slackMessage(e, '1793600001.000100', [{ bytes: pdf, kind: 'file', name: 'Q3 report.pdf', type: 'application/pdf' }, { bytes: photo, kind: 'photo', name: 'shot.jpg', type: 'image/jpeg' }]);
    // A row from before media was on: no event, still no path.
    fs.appendFileSync(e.logPath, `${JSON.stringify({ messageId: '1793600002.000100', channelId: CHANNEL, text: `[image:${path.join(e.dir, 'slack-files', 'old.png')}]`, fromUser: true, timestamp: new Date(1793600002000).toISOString() })}\n`);

    const res = await signed(e, 'GET', hist(e));
    expect(res.status).toBe(200);
    expect(res.body.conversationKey).toBe(e.key);
    expect(e.key).toBe(`slack:_:${CHANNEL}`);
    const msgs = res.body.messages as Array<Record<string, any>>;
    expect(JSON.stringify(msgs)).not.toContain(e.dir);
    const byTs = new Map(msgs.map((m) => [m.messageId, m]));
    const m1 = byTs.get('1793600001.000100')!;
    expect(m1.text).toBe('see [file: Q3 report.pdf] [photo]');
    expect(m1.attachments).toHaveLength(2);
    expect(m1.attachments[0]).toMatchObject({ kind: 'file', filename: 'Q3 report.pdf', mediaType: 'application/pdf', bytes: 'verified' });
    expect(m1.attachments[1]).toMatchObject({ kind: 'photo', sha256: sha(photo), size: photo.length, mediaType: 'image/jpeg' });
    expect(byTs.get('1793600002.000100')!.text).toBe('[photo]');
    expect(byTs.get('1793600002.000100')!.attachments).toBeUndefined();

    const bearer = await request(e.app).get(hist(e)).set('Authorization', 'Bearer tok-1');
    expect(bearer.status).toBe(200);
    const raw = (bearer.body.messages as Array<Record<string, unknown>>).find((m) => m.messageId === '1793600001.000100')!;
    expect(String(raw.text)).toContain(e.dir);
    expect(raw.attachments).toBeUndefined();

    // The unified list's preview never shows a path either.
    const list = await signed(e, 'GET', '/mobile/conversations');
    expect(list.status).toBe(200);
    const slackRow = list.body.conversations.find((c: { platform: string; id: number }) => c.platform === 'slack' && c.id === e.convId);
    expect(slackRow.lastPreview).toBe('[photo]');
  });

  it('downloads with ref=<conversationKey>; other conversations, unheld keys and bad refs are 404', async () => {
    const e = await setup();
    const photo = jpeg();
    await slackMessage(e, '1793600010.000100', [{ bytes: photo, kind: 'photo', name: 'shot.jpg', type: 'image/jpeg' }]);
    const other = jpeg();
    await slackMessage(e, '1793600011.000100', [{ bytes: other, kind: 'photo', name: 'o.jpg', type: 'image/jpeg' }], 'x', 'C0OTHER9');
    const dl = await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=${encodeURIComponent(e.key)}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.from(dl.body as Buffer).equals(photo)).toBe(true);
    // Referenced only in another conversation.
    expect((await signed(e, 'GET', `/mobile/media/${sha(other)}?ref=${encodeURIComponent(e.key)}`)).status).toBe(404);
    expect((await signed(e, 'GET', `/mobile/media/${sha(other)}?ref=${encodeURIComponent('slack:_:C0OTHER9')}`)).status).toBe(200);
    // A conversation this machine's registry never minted (another machine's, or made up).
    expect((await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=${encodeURIComponent('slack:_:C0NOTHERE')}`)).status).toBe(404);
    expect((await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=${encodeURIComponent('slack:T0WRONG:C0123ABC')}`)).status).toBe(404);
    expect((await signed(e, 'GET', `/mobile/media/${sha(photo)}?ref=slack:junk`)).status).toBe(404);
    // A bearer token cannot download.
    expect((await request(e.app).get(`/mobile/media/${sha(photo)}?ref=${encodeURIComponent(e.key)}`).set('Authorization', 'Bearer tok-1')).status).toBe(403);
  });

  it('with media off the download route answers 503', async () => {
    const e = await setup({ mediaEnabled: false });
    expect((await signed(e, 'GET', `/mobile/media/${'0'.repeat(64)}?ref=${encodeURIComponent(e.key)}`)).status).toBe(503);
  });
});
