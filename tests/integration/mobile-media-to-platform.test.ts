import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
/**
 * Files sent from the app into a Telegram topic and a Slack conversation, over the real HTTP
 * pipeline (docs/specs/mobile-native-chat-media.md §4.9, increment 3): uploads named for the
 * platform conversation, the signed send through the production device authenticator, the
 * `media-message` stored under `telegram:<topicId>` / the Slack canonical key, the session's file
 * lines, the mirror (Telegram: a real TelegramAdapter's multipart request with the right Bot API
 * method, fetch stubbed so nothing leaves; Slack: the bridge's upload), the 51,000,000-byte file
 * mirrored as a text line, history with attachments and `originVerified`, download by the
 * platform ref, retry idempotency, and the media-off refusals.
 */
import { describe, it, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';
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
import { buildMobileSlackBridge, createMobileSlackRouter, slackOwnerUserId, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { slackConversationHeldLocally } from '../../src/core/appPlatformMedia.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { Message } from '../../src/core/types.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PlatformMediaForSession } from '../../src/core/platformMediaForSession.js';
import { parseInboundMediaField } from '../../src/core/inboundMedia.js';

const HOST = 'echo.example.dev';
const OWNER = 'U0OWNER1';
const TOPIC = 42;
const dirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
beforeAll(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.2.36', null); });
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  ProcessIntegrity.reset();
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-media-to-platform.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const png = (n = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

/** Bot API requests the real adapter made (global fetch stubbed: nothing leaves the process). */
function stubBotApi(): Array<{ method: string; body: FormData | string }> {
  const seen: Array<{ method: string; body: FormData | string }> = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { body: FormData | string }) => {
    const method = String(url).split('/').pop() ?? '';
    seen.push({ method, body: init.body });
    const result = method === 'sendMediaGroup' ? [{ message_id: 901 }, { message_id: 902 }] : { message_id: 900 };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => '' };
  }));
  return seen;
}

async function setup(opts: { mediaEnabled?: boolean; owner?: string | null; enforceQuiet?: boolean; recordMirror?: boolean } = {}) {
  const mediaEnabled = opts.mediaEnabled ?? true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm2p-'));
  dirs.push(dir);
  await new MachineIdentityManager(dir).generateIdentity({ name: 'test machine' });
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: 0, authToken: 'tok-1', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false }, ...(opts.owner === null ? {} : { slackOwnerUserId: OWNER }), native: { media: { enabled: mediaEnabled } } },
    sessions: {}, scheduler: {}, threadline: { ownerName: 'Justin' },
  };
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const channelId = registry.mintForInbound('C0123ABC').id!;
  const threadId = registry.mintForInbound('C0123ABC:1793600000.000100').id!;
  const slackKeyOf = (id: number) => (registry.resolve(id) as { key: string }).key;
  const deps: MobilePairingDeps = { config: config as never, stateDir: dir, holdsLease: () => true };
  const pairing = new MobilePairingService(deps);
  pairing.nativeOn = true;
  cleanups.push(() => pairing.stop());
  const signer = loadMachineSigner(dir)!;
  const keyLookup = identityKeyLookup(dir);
  const keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer, keyLookup });
  pairing.keyLedger = keyLedger;
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry, requests: pairing.chatRequests()!, holdsLease: () => true, ownerName: () => 'Justin',
    signer, keyLookup, keyLedger, dispatch: () => null,
  });
  cleanups.push(() => svc.stop());

  // Telegram: a real adapter makes the media request (its fetch is stubbed per test); the rest is a stand-in.
  const realTg = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', pollIntervalMs: 100 }, dir);
  cleanups.push(() => realTg.stop());
  const gate = opts.enforceQuiet ? new NotificationSelectivityGate(dir, 'test-machine', () => ({ enabled: true, dryRun: false })) : null;
  if (gate) { realTg.selectivity = gate; cleanups.push(() => gate.close()); }
  const tgRows: Array<Record<string, unknown>> = [];
  const textMirrors: string[] = [];
  const mediaMirrors: Array<{ count: number; caption: string | null }> = [];
  const telegram = {
    getOwnerUserId: () => 4242,
    getAllTopicMappings: () => [{ topicId: TOPIC, topicName: 'Lifeline' }],
    getTopicHistory: (id: number, limit: number) => tgRows.filter((r) => r.topicId === id).slice(-limit),
    sendToTopic: async (_t: number, text: string, options?: Parameters<TelegramAdapter['sendToTopic']>[2]) => { textMirrors.push(text); return gate ? realTg.sendToTopic(_t, text, options) : { messageId: 1, topicId: TOPIC }; },
    sendMediaToTopic: async (...a: Parameters<TelegramAdapter['sendMediaToTopic']>) => {
      mediaMirrors.push({ count: a[1].length, caption: a[2] });
      return opts.recordMirror ? { recorded: true, delivered: false, quietId: 'recorded-copy' } : realTg.sendMediaToTopic(...a);
    },
  };
  const ctx = {
    config, startTime: new Date(), scheduler: null, meshSelfId: 'm1',
    sessionManager: { listRunningSessions: () => [], killSession: () => true },
    state: { getJobState: () => null, getSession: () => null, queryEvents: () => [], getCoherenceJournal: () => undefined },
    conversationRegistry: registry, conversationBindAuth: createConversationBindAuth(dir), appConversations: svc, telegram,
  } as unknown as RouteContext;

  // Slack: a stub adapter (nothing reaches Slack) with an upload that records what it was given.
  const logPath = path.join(dir, 'slack-messages.jsonl');
  const slackPosts: string[] = [];
  const slackUploads: Array<{ channelId: string; bytes: Buffer; options?: { threadTs?: string; initialComment?: string; filename?: string } }> = [];
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => [],
    getBotUserId: () => 'UBOT',
    getLogPath: () => logPath,
    logMessage: (e) => fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack' })}\n`),
    sendToChannel: async (_ch, text) => { slackPosts.push(text); return '1793615401.000001'; },
    uploadFile: async (channelId, filePath, _title, options) => { slackUploads.push({ channelId, bytes: fs.readFileSync(filePath), options }); },
    getSessionForChannel: () => 'sess-slack',
    isAuthorized: (u) => u === OWNER,
  };
  const slackDispatched: Message[] = [];
  let slackKills = 0;
  const bridge = buildMobileSlackBridge({
    adapter, registry, dispatch: () => async (m) => { slackDispatched.push(m); return 'delivered'; },
    killAllSessions: () => { slackKills++; return true; }, sendEscape: () => undefined, holdsLease: () => true,
  });

  const keep = (req: unknown, _res: unknown, buf: Buffer) => { (req as { rawBody: Buffer }).rawBody = buf; };
  const app = express();
  app.use('/mobile/media/uploads', express.raw({ type: 'application/octet-stream', limit: '1mb', verify: keep }));
  app.use(express.json({ verify: keep }));
  app.use(authMiddleware(() => 'tok-1', 'echo', undefined, deviceAuthenticator(pairing)));
  app.use(createRoutes(ctx));
  app.use(createMobileSlackRouter({ config: config as never, pairing, service: svc, slack: () => bridge, machineId: () => 'm1' }));
  app.use(createMobileConversationRouter({ config: config as never, pairing, service: svc, machineId: () => 'm1', mediaEnabled }));
  app.use(createMobileMediaRouter({
    pairing, service: svc, mediaEnabled,
    telegramTopicExists: (id) => id === TOPIC,
    // As AgentServer wires it: nothing Slack is served until the owner's Slack id is set.
    slackHeld: (key) => slackOwnerUserId(config as never) !== null && slackConversationHeldLocally(registry, key),
  }));
  app.use(createMobilePairingRouter(pairing, deps, ctx));
  // The inbound core stand-in: writes the Telegram history row with the eventId the route hands it.
  const ingested: Array<Record<string, unknown>> = [];
  const ingestRefusals: number[] = []; // push a status to make the next inbound-core call an early refusal
  ctx.mobileInbound = {
    ingest: async (req: { body: Record<string, unknown> }, res: { status(c: number): { json(b: unknown): unknown } }, trust: { deviceId: string; eventId: string }) => {
      const refuse = ingestRefusals.shift();
      if (refuse) { res.status(refuse).json({ ok: false, reason: 'server-boot-incomplete' }); return; }
      ingested.push(req.body);
      tgRows.push({ messageId: req.body.messageId, topicId: req.body.topicId, text: req.body.text, fromUser: true, timestamp: req.body.timestamp, sessionName: null, via: 'mobile-device', deviceId: trust.deviceId, eventId: trust.eventId });
      res.status(200).json({ ok: true });
    },
  };

  const dev = makeDevice();
  const c = pairing.devices.createPending({ deviceName: 'iPhone', label: null, publicKey: dev.publicKey, host: HOST });
  if (!c.ok) throw new Error('setup');
  const code = pairing.confirm.issue(c.device.id, Date.now() + 60_000);
  const e = { app, dir, svc, dev, gate, realTg, deviceId: c.device.id, ingested, ingestRefusals, textMirrors, mediaMirrors, slackPosts, slackUploads, slackDispatched, channelId, threadId, slackKeyOf, slackKills: () => slackKills };
  expect((await signed(e, 'POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
  return e;
}
type Env = Awaited<ReturnType<typeof setup>>;

/** The session text the serving machine builds from what the inbound core received (§3c). */
async function sessionTextOf(e: Pick<Env, 'svc'>, row: Record<string, unknown>): Promise<string> {
  const pm = new PlatformMediaForSession({ service: () => e.svc, downloadDirs: () => [], injectToTopic: () => false });
  return pm.buildInboundSessionText({ conversationKey: `telegram:${TOPIC}`, text: String(row.text ?? ''), media: parseInboundMediaField(row.media) });
}

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

const describeFile = (bytes: Buffer, over: Record<string, unknown> = {}) => ({ size: bytes.length, sha256: sha(bytes), declaredKind: 'photo', declaredType: 'image/png', filename: 'holiday.png', ...over });

async function upload(e: Env, ref: string, bytes: Buffer, over: Record<string, unknown> = {}): Promise<string> {
  const start = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: ref, ...describeFile(bytes, over), requestId: rid() });
  expect(start.status).toBe(200);
  const id = start.body.uploadId as string;
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) {
    const r = await signed(e, 'PUT', `/mobile/media/uploads/${id}/chunks/${i}`, undefined, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    expect(r.status).toBe(200);
  }
  return id;
}

describe('app → Telegram topic with files', () => {
  it('preserves an authenticated media mirror under enforcement while later automation stays quiet', async () => {
    const e = await setup({ enforceQuiet: true }); const seen = stubBotApi();
    const bytes = png(), uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const body = { text: 'My actual photo', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] };
    e.gate!.observeInbound(TOPIC, 'waiting-human');
    const result = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'delivered', mirrored: true, mirror: 'sent' });
    expect(seen.filter(row => row.method === 'sendPhoto')).toHaveLength(1);
    expect((await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body)).body).toEqual(result.body);
    expect(seen.filter(row => row.method === 'sendPhoto')).toHaveLength(1);
    expect(e.gate!.decide(TOPIC, { origin: 'automated', category: 'presence-standby', sourceContext: 'presence', inboundMessageId: 'waiting-human' }).decision).toBe('deliver');
    const before = seen.length;
    expect(await e.realTg.sendMediaToTopic(TOPIC, [{ data: bytes, filename: 'routine.png', mediaType: 'image/png', kind: 'photo' }], 'Routine screenshot')).toMatchObject({ recorded: true });
    expect(seen).toHaveLength(before);
  });
  it('keeps core ingress delivered when a mirror is terminally recorded instead of sent', async () => {
    const e = await setup({ recordMirror: true }); const seen = stubBotApi();
    const bytes = png(), uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const result = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'Accepted input', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'delivered', mirrored: false, mirror: 'recorded', mirrorQuietId: 'recorded-copy', partiallyMirrored: false });
    expect(e.ingested).toHaveLength(1); expect(seen).toHaveLength(0);
  });

  it('a photo is stored under telegram:<topicId>, reaches the session as a path, mirrors as sendPhoto, and shows in device history', async () => {
    const e = await setup();
    const seen = stubBotApi();
    const bytes = png();
    const uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'Look at this', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', mirrored: true, mirror: 'sent' });

    // Stored under telegram:<topicId> as a media-message with its signed origin.
    const ev = e.svc.store.getEvent(`telegram:${TOPIC}`, r.body.eventId as string);
    expect(ev).toMatchObject({ kind: 'media-message', role: 'operator', text: 'Look at this' });
    expect((ev as { attachments: Array<{ sha256: string; kind: string }> }).attachments[0]).toMatchObject({ sha256: sha(bytes), kind: 'photo' });

    // native-conversation-base §3c: the file travels by attachment id, never as a line in the text.
    // The machine serving the session builds the §4.5 line with a server-chosen path to a private
    // copy, then the caption.
    expect(e.ingested[0]!.text).toBe('Look at this');
    expect(e.ingested[0]!.media).toEqual([{ kind: 'photo', attachmentId: (ev as { attachments: Array<{ attachmentId: string }> }).attachments[0]!.attachmentId, filename: 'holiday.png' }]);
    const text = await sessionTextOf(e, e.ingested[0]!);
    const m = /^\[image:(.+)\]\nLook at this$/.exec(text);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(m![1]!)).toEqual(bytes);

    // The mirror went through the real adapter as sendPhoto, with the owner caption.
    expect(seen.map((s) => s.method)).toEqual(['sendPhoto']);
    const form = seen[0]!.body as FormData;
    expect(form.get('caption')).toBe('📱 Justin (from the app): Look at this');
    expect(form.get('message_thread_id')).toBe(String(TOPIC));
    expect(Buffer.from(await (form.get('photo') as Blob).arrayBuffer())).toEqual(bytes);
    expect(e.textMirrors).toEqual([]);

    // Device history: the stored caption (no server path), the attachment, and the verdict.
    const hist = await signed(e, 'GET', `/telegram/topics/${TOPIC}/messages`);
    expect(hist.status).toBe(200);
    const row = hist.body.messages.find((x: { eventId?: string }) => x.eventId === r.body.eventId);
    expect(row).toMatchObject({ text: 'Look at this', originVerified: 'verified', deliveryState: 'delivered' });
    expect(row.attachments[0]).toMatchObject({ sha256: sha(bytes), bytes: 'verified' });
    expect(JSON.stringify(hist.body)).not.toContain('session-files');

    // Download through the existing media route, by the topic ref.
    const dl = await signed(e, 'GET', `/mobile/media/${sha(bytes)}?ref=telegram:${TOPIC}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body)).toEqual(bytes);
  });

  it('several files mirror as one sendMediaGroup', async () => {
    const e = await setup();
    const seen = stubBotApi();
    const a = png(); const b = png(300);
    const ua = await upload(e, `telegram:${TOPIC}`, a);
    const ub = await upload(e, `telegram:${TOPIC}`, b, { filename: 'two.png' });
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: '', requestId: rid(), attachments: [{ uploadId: ua, ...describeFile(a) }, { uploadId: ub, ...describeFile(b, { filename: 'two.png' }) }] });
    expect(r.status).toBe(200);
    expect(seen.map((s) => s.method)).toEqual(['sendMediaGroup']);
    expect(JSON.parse(String((seen[0]!.body as FormData).get('media')))).toEqual([
      { type: 'photo', media: 'attach://file0', caption: '📱 Justin (from the app)' }, { type: 'photo', media: 'attach://file1' },
    ]);
  });

  it('a 51,000,000-byte file is delivered to the session but mirrored as the too-large text line', async () => {
    const e = await setup();
    const seen = stubBotApi();
    const big = Buffer.alloc(51_000_000, 7);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const over = { declaredKind: 'file', declaredType: 'application/octet-stream', filename: 'big.bin' };
    const uploadId = await upload(e, `telegram:${TOPIC}`, big, over);
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'big one', requestId: rid(), attachments: [{ uploadId, ...describeFile(big, over) }] });
    expect(r.status).toBe(200);
    expect(r.body.mirror).toBe('sent');
    expect(seen).toHaveLength(0);
    expect(e.mediaMirrors).toHaveLength(0);
    expect(e.textMirrors).toEqual(['📱 Justin (from the app): big one', '📱 Justin sent big.bin (too large for Telegram; open it in the app)']);
    expect(await sessionTextOf(e, e.ingested[0]!)).toMatch(/^\[(image|document):/);
  }, 120_000);

  it('a retry of the same request answers the recorded result: one dispatch, one mirror', async () => {
    const e = await setup();
    const seen = stubBotApi();
    const bytes = png();
    const uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const body = { text: 'once', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] };
    const a = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body);
    const b = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.eventId).toBe(a.body.eventId);
    expect(e.ingested).toHaveLength(1);
    expect(seen).toHaveLength(1);
    // The same id with different files is a different payload, never the old message.
    const other = png();
    const u2 = await upload(e, `telegram:${TOPIC}`, other);
    const c = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { ...body, attachments: [{ uploadId: u2, ...describeFile(other) }] });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('request-id-reused');
  });

  it('a retry after an early inbound refusal reuses the saved message and its files, delivered once', async () => {
    const e = await setup();
    stubBotApi();
    const bytes = png();
    const uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const body = { text: 'after boot', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] };
    e.ingestRefusals.push(503);
    const first = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body);
    expect(first.status).toBe(503);
    const again = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'delivered', mirror: 'sent' });
    expect(e.ingested).toHaveLength(1);
    expect(await sessionTextOf(e, e.ingested[0]!)).toMatch(/^\[image:.+\]\nafter boot$/);
  });

  it('a failed mirror never fails or repeats the dispatch', async () => {
    const e = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'down' }));
    const bytes = png();
    const uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'x', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'delivered', mirrored: false, mirror: 'failed' });
    expect(e.ingested).toHaveLength(1);
  });

  it('an upload names its topic: an unknown topic is refused, and a file uploaded for another conversation does not match', async () => {
    const e = await setup();
    stubBotApi();
    const bytes = png();
    expect((await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: 'telegram:999', ...describeFile(bytes), requestId: rid() })).status).toBe(404);
    const key = (await signed(e, 'POST', '/mobile/conversations', { title: 'Plans', requestId: rid() })).body.conversationKey as string;
    const uploadId = await upload(e, `app:${key}`, bytes);
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'x', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('attachment-mismatch');
    expect(e.ingested).toHaveLength(0);
  });

  it('the exact emergency-stop text with attachments is handled as the stop: files skipped, nothing stored or mirrored as media', async () => {
    const e = await setup();
    const seen = stubBotApi();
    const bytes = png();
    const uploadId = await upload(e, `telegram:${TOPIC}`, bytes);
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'stop everything', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(200);
    expect(r.body.mirror).toBeUndefined();
    // The inbound core (which runs the emergency-stop intercept) got the bare stop text, no file lines.
    expect(e.ingested).toHaveLength(1);
    expect(e.ingested[0]!.text).toBe('stop everything');
    expect(e.svc.store.getEvent(`telegram:${TOPIC}`, r.body.eventId as string)).toMatchObject({ kind: 'message' });
    expect(e.svc.media.getUpload(uploadId)!.state).toBe('complete');
    expect(seen).toHaveLength(0);
    // A malformed file list does not stop the stop either.
    const bad = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'stop everything', requestId: rid(), attachments: [{ bad: true }] });
    expect(bad.status).toBe(200);
  });

  it('a text-only send is unchanged', async () => {
    const e = await setup();
    const r = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'just words', requestId: rid() });
    expect(r.status).toBe(200);
    expect(r.body.mirror).toBeUndefined();
    expect(e.textMirrors).toEqual(['📱 Justin (from the app): just words']);
  });
});

describe('app → Slack conversation with files', () => {
  it('a file is stored under the canonical key, dispatched with its path, uploaded into Slack, and shown and downloadable in history', async () => {
    const e = await setup();
    const hist0 = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    const key = hist0.body.conversationKey as string;
    expect(key).toMatch(/^slack:/);
    const bytes = png();
    const over = { declaredKind: 'file', declaredType: 'image/png', filename: 'notes.png' };
    const uploadId = await upload(e, key, bytes, over);
    const r = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'for the channel', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes, over) }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, outcome: 'delivered', mirror: 'sent' });
    expect(e.svc.store.getEvent(key, r.body.eventId as string)).toMatchObject({ kind: 'media-message', text: 'for the channel' });
    expect(e.slackDispatched[0]!.content).toMatch(/^\[(image|document):[^\]]+\][^\n]*\nfor the channel$/);
    expect(e.slackUploads).toHaveLength(1);
    expect(e.slackUploads[0]!.bytes).toEqual(bytes);
    expect(e.slackUploads[0]!.options).toMatchObject({ filename: 'notes.png', initialComment: '📱 Justin (from the app): for the channel' });
    expect(e.slackPosts).toEqual([]);

    const hist = await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`);
    const row = hist.body.messages.find((x: { eventId: string }) => x.eventId === r.body.eventId);
    expect(row).toMatchObject({ text: 'for the channel', originVerified: 'verified' });
    expect(row.attachments[0]).toMatchObject({ sha256: sha(bytes), bytes: 'verified' });
    const dl = await signed(e, 'GET', `/mobile/media/${sha(bytes)}?ref=${encodeURIComponent(key)}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body)).toEqual(bytes);
  });

  it('an upload made for another conversation is refused with attachment-mismatch, nothing dispatched', async () => {
    const e = await setup();
    const bytes = png();
    // Uploaded for the thread conversation, sent into the channel conversation.
    const uploadId = await upload(e, e.slackKeyOf(e.threadId), bytes);
    const r = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'x', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'attachment-mismatch', index: 0 });
    expect(e.slackDispatched).toHaveLength(0);
    expect(e.slackUploads).toHaveLength(0);
    expect(e.svc.media.getUpload(uploadId)!.state).toBe('complete');
  });

  it('with the owner\'s Slack id unset, a Slack upload cannot start (404)', async () => {
    const e = await setup({ owner: null });
    const r = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: e.slackKeyOf(e.channelId), ...describeFile(png()), requestId: rid() });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('unknown-conversation');
  });

  it('the exact emergency-stop text with attachments is handled as the stop: files skipped', async () => {
    const e = await setup();
    const bytes = png();
    const uploadId = await upload(e, e.slackKeyOf(e.channelId), bytes);
    const r = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'stop everything', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'sentinel-kill', deliveryState: 'intercepted' });
    expect(e.slackKills()).toBe(1);
    expect(e.slackDispatched).toHaveLength(0);
    expect(e.slackUploads).toHaveLength(0);
    expect(e.svc.store.getEvent(e.slackKeyOf(e.channelId), r.body.eventId as string)).toMatchObject({ kind: 'message', text: 'stop everything' });
    expect(e.svc.media.getUpload(uploadId)!.state).toBe('complete');
  });

  it('a Slack retry with the same request id is idempotent', async () => {
    const e = await setup();
    const key = (await signed(e, 'GET', `/mobile/chat/slack/${e.channelId}/messages?machine=m1`)).body.conversationKey as string;
    const bytes = png();
    const uploadId = await upload(e, key, bytes);
    const body = { machine: 'm1', text: 'once', requestId: rid(), attachments: [{ uploadId, ...describeFile(bytes) }] };
    const a = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, body);
    const b = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, body);
    expect(b.status).toBe(200);
    expect(b.body.messageId).toBe(a.body.messageId);
    expect(e.slackDispatched).toHaveLength(1);
    expect(e.slackUploads).toHaveLength(1);
  });
});

describe('media off', () => {
  it('Telegram and Slack sends with files are refused as before, and uploads answer 503', async () => {
    const e = await setup({ mediaEnabled: false });
    const t = await signed(e, 'POST', `/mobile/chat/${TOPIC}`, { text: 'x', requestId: rid(), attachments: [] });
    expect(t.status).toBe(400);
    expect(t.body.error).toBe('media-target-unsupported');
    const s = await signed(e, 'POST', `/mobile/chat/slack/${e.channelId}`, { machine: 'm1', text: 'x', requestId: rid(), attachments: [] });
    expect(s.status).toBe(400);
    expect(s.body.error).toBe('media-target-unsupported');
    const u = await signed(e, 'POST', '/mobile/media/uploads', { conversationRef: `telegram:${TOPIC}`, ...describeFile(png()), requestId: rid() });
    expect(u.status).toBe(503);
    expect(e.ingested).toHaveLength(0);
  });
});
