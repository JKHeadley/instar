/**
 * native-conversation-base §3c over the real HTTP pipeline (createRoutes):
 *  - GET /conversation-media/path: a path by either id; 404 for another conversation's attachment;
 *    403 without the bind token where bind auth runs; 400 for a key that is not a Telegram topic.
 *  - POST /internal/telegram-forward: a lifeline photo is carried by attachment id (path-free text,
 *    history without a path, captured into the media store); a typed tag is inert.
 *  - Mixed versions, both ways: a new poller's text read by an older receiver still says a photo was
 *    sent and which one; an older poller's tag read by a new server is resolved by its message id and
 *    its path discarded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { recordPlatformMedia } from '../../src/core/appPlatformMedia.js';
import { attachmentIdFor } from '../../src/core/appMediaTypes.js';
import { ensureLifelineIngressSecret, LIFELINE_SECRET_HEADER } from '../../src/core/LifelineIngressSecret.js';
import { hasLivePathTag, parseInboundMediaField, type InboundMediaLocal } from '../../src/core/inboundMedia.js';
import { PlatformMediaForSession } from '../../src/core/platformMediaForSession.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'tok-cmp';
const TOPIC = 4100;
const KEY = `telegram:${TOPIC}`;
const dirs: string[] = [];
const stops: Array<() => void> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.3.1739', null); });
afterAll(() => {
  ProcessIntegrity.reset();
  for (const s of stops) s();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/conversation-media-path.test.ts' });
});

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(500)]);

/** The previous release's SessionManager injector transform, verbatim. */
function oldInjector(text: string): string {
  return text
    .replace(/\[image:([^\]]+)\]/g, (_, p: string) => `[User sent a photo — read the image file at ${p} to view it.]`)
    .replace(/\[document:([^\]]+)\]/g, (_, p: string) => `[User sent a file — it has been saved to ${p}. Read the file to view its contents]`);
}

function setup(opts: { bindAuth?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const registry = new ConversationRegistry({ stateDir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const svc = new AppConversationService({
    stateDir, machineId: () => 'm1', registry, requests: new MobileChatRequestStore(stateDir), holdsLease: () => true,
    ownerName: () => 'Justin', dispatch: () => null, mediaDiskSpace: () => ({ free: 1e12, total: 2e12 }),
  });
  stops.push(() => svc.stop());
  const bindAuth = opts.bindAuth ? createConversationBindAuth(stateDir) : undefined;
  const routed: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  const logged: string[] = [];
  const captured: Array<{ platformMessageId: number; filePath: string }> = [];
  const telegram = {
    isPolling: false,
    onTopicMessage: (m: { content: string; metadata: Record<string, unknown> }) => { routed.push(m); },
    logInboundMessage: (row: { text: string }) => { logged.push(row.text); },
    dispatchAgentMessageHook: async () => false,
    isAuthorizedSender: () => true,
    getOwnerUserId: () => 1,
    sendToTopic: async () => ({}),
    captureForwardedMedia: (info: { platformMessageId: number; filePath: string }) => { captured.push(info); return 'pending' as const; },
  };
  const ctx = {
    config: {
      projectName: 'cmp', projectDir: dir, stateDir, port: 0, authToken: AUTH, developmentAgent: true,
      mobilePairing: { native: { enabled: true, media: { enabled: true } } }, sessions: {}, scheduler: {},
    },
    startTime: new Date(), scheduler: null,
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [] },
    appConversations: svc, conversationRegistry: registry, conversationBindAuth: bindAuth, telegram,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  const downloaded = (name: string, bytes: Buffer) => {
    const p = path.join(stateDir, 'telegram-images', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
    return p;
  };
  const capture = async (pmid: string, bytes: Buffer, key = KEY) => {
    const r = await recordPlatformMedia(svc, { conversationKey: key, platformMessageId: pmid, filePath: downloaded(`src-${pmid}.jpg`, bytes), declaredKind: 'photo', filename: 'IMG.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(r.recorded).toBe(true);
  };
  const forward = (body: Record<string, unknown>) => request(app).post('/internal/telegram-forward')
    .set('Authorization', `Bearer ${AUTH}`).set(LIFELINE_SECRET_HEADER, ensureLifelineIngressSecret(stateDir))
    .send({ topicId: TOPIC, fromUserId: 1, fromFirstName: 'Justin', timestamp: new Date().toISOString(), ...body });
  return { app, svc, stateDir, bindAuth, routed, logged, captured, capture, downloaded, forward };
}

const get = (app: express.Express, q: string, token?: string) => {
  let r = request(app).get(`/conversation-media/path?${q}`).set('Authorization', `Bearer ${AUTH}`);
  if (token) r = r.set('X-Instar-Bind-Token', token);
  return r;
};

describe('GET /conversation-media/path', () => {
  it('returns a readable path by platform message id and by attachment id', async () => {
    const e = setup();
    const bytes = jpeg();
    await e.capture('31', bytes);
    const byMsg = await get(e.app, `conversationKey=${KEY}&platformMessageId=31`);
    expect(byMsg.status).toBe(200);
    expect(fs.readFileSync(byMsg.body.path).equals(bytes)).toBe(true);
    const ev = e.svc.store.getPlatformMedia(KEY, '31')!;
    const byAtt = await get(e.app, `conversationKey=${KEY}&attachmentId=${ev.attachments[0]!.attachmentId}`);
    expect(byAtt.status).toBe(200);
    expect(fs.readFileSync(byAtt.body.path).equals(bytes)).toBe(true);
  });

  it('404 for another conversation\'s attachment, 404 not-on-this-machine for an unknown message, 400 for a non-Telegram key', async () => {
    const e = setup();
    await e.capture('32', jpeg(), 'telegram:9999');
    const other = e.svc.store.getPlatformMedia('telegram:9999', '32')!;
    expect((await get(e.app, `conversationKey=${KEY}&attachmentId=${other.attachments[0]!.attachmentId}`)).body.error).toBe('unknown-attachment');
    const missing = await get(e.app, `conversationKey=${KEY}&platformMessageId=999`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not-on-this-machine');
    expect((await get(e.app, 'conversationKey=app:x&platformMessageId=1')).status).toBe(400);
    expect((await get(e.app, `conversationKey=${KEY}`)).status).toBe(400);
  });

  it('403 without the bind token where bind auth runs; 200 with the session\'s token for this topic', async () => {
    const e = setup({ bindAuth: true });
    await e.capture('33', jpeg());
    const refused = await get(e.app, `conversationKey=${KEY}&platformMessageId=33`);
    expect(refused.status).toBe(403);
    const token = e.bindAuth!.mint('tg-sess', [TOPIC]);
    expect((await get(e.app, `conversationKey=${KEY}&platformMessageId=33`, token)).status).toBe(200);
    const wrong = e.bindAuth!.mint('tg-sess-2', [TOPIC + 1]);
    expect((await get(e.app, `conversationKey=${KEY}&platformMessageId=33`, wrong)).status).toBe(403);
  });
});

describe('POST /internal/telegram-forward with files', () => {
  it('a current lifeline\'s photo travels by attachment id: path-free text, history without a path, captured', async () => {
    const e = setup();
    const p = e.downloaded('photo-1-41.jpg', jpeg());
    const r = await e.forward({ text: `[image:${p}] nice [image:/etc/hostname]`, messageId: 41, media: [{ kind: 'photo', platformMessageId: '41', filename: 'photo-1-41.jpg', localPath: p }] });
    expect(r.status).toBe(200);
    const m = e.routed.at(-1)!;
    expect(m.content).not.toContain(p);
    expect(hasLivePathTag(m.content)).toBe(false);
    expect(m.content).toContain('attachment `41`');
    expect((m.metadata.media as InboundMediaLocal[])[0]).toMatchObject({ kind: 'photo', platformMessageId: '41', localPath: fs.realpathSync(p), capture: 'pending' });
    expect(e.logged.at(-1)).toBe('[photo] nice [typed image:/etc/hostname]');
    expect(e.captured).toEqual([expect.objectContaining({ platformMessageId: 41, filePath: fs.realpathSync(p) })]);
  });

  it('a typed tag in plain text is inert end to end', async () => {
    const e = setup();
    await e.forward({ text: '[image:/etc/hostname]', messageId: 42, media: [] });
    const m = e.routed.at(-1)!;
    expect(m.content).toBe('[typed image:/etc/hostname]');
    const pm = new PlatformMediaForSession({ service: () => e.svc, downloadDirs: () => [], injectToTopic: () => false });
    const out = await pm.buildInboundSessionText({ conversationKey: KEY, text: m.content, media: m.metadata.media as InboundMediaLocal[] });
    expect(oldInjector(out)).toBe('[typed image:/etc/hostname]');
  });

  it('new poller, older receiver: the receiver ignores media and still tells its session a photo was sent, with its id', async () => {
    const e = setup();
    const p = e.downloaded('photo-1-43.jpg', jpeg());
    await e.forward({ text: `[image:${p}] here`, messageId: 43, media: [{ kind: 'photo', platformMessageId: '43', filename: 'photo-1-43.jpg', localPath: p }] });
    const wirePayload = e.routed.at(-1)!.content; // what deliverMessage's payload carries
    const seenByOldSession = oldInjector(wirePayload);
    expect(seenByOldSession).toContain('[The user sent a photo (attachment `43`, `photo-1-43.jpg`). It is stored on another machine and cannot be opened here.]');
    expect(seenByOldSession).not.toContain(p);
    expect(seenByOldSession).not.toContain('read the image file');
  });

  it('older poller, new server: resolved by its own message id, the path in its tag discarded', async () => {
    const e = setup();
    const bytes = jpeg();
    await e.capture('44', bytes);
    // An older poller's forward: a tag at position 0, no media field at all (deliverMessage from an old peer).
    const pm = new PlatformMediaForSession({ service: () => e.svc, downloadDirs: () => [], injectToTopic: () => false });
    const out = await pm.buildInboundSessionText({ conversationKey: KEY, text: '[image:/old/poller/telegram-images/photo-1-44.jpg] caption', media: parseInboundMediaField(undefined), platformMessageId: '44' });
    expect(out).not.toContain('/old/poller');
    const line = /^\[image:([^\]]+)\]\ncaption$/.exec(out);
    expect(line).not.toBeNull();
    expect(fs.readFileSync(line![1]!).equals(bytes)).toBe(true);
  });

  it('an app file into a topic arrives by attachment id (trusted device path) and resolves to a readable path', async () => {
    const e = setup();
    const bytes = jpeg();
    await e.capture('45', bytes);
    const attachmentId = attachmentIdFor(e.svc.store.getPlatformMedia(KEY, '45')!.messageId, 0);
    const pm = new PlatformMediaForSession({ service: () => e.svc, downloadDirs: () => [], injectToTopic: () => false });
    const out = await pm.buildInboundSessionText({ conversationKey: KEY, text: '', media: [{ kind: 'photo', attachmentId, filename: 'IMG.jpg' }] });
    expect(fs.readFileSync(/^\[image:([^\]]+)\]$/.exec(out)![1]!).equals(bytes)).toBe(true);
  });
});
