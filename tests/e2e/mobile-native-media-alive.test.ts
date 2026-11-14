import { NotificationSelectivityGate } from '../../src/messaging/NotificationSelectivityGate.js';
/**
 * Feature-is-alive proof for media in app conversations (docs/specs/mobile-native-chat-media.md,
 * increment 1): an AgentServer booted on a development agent with no Telegram, no Slack and no
 * transcription provider builds the media store on its production path; a phone paired through
 * the existing redeem/confirm path uploads a photo and a voice note (with a phone transcript) in
 * signed chunks and sends them with a caption; the session receives `[image:<path>]` and
 * `[voice:<path>] <transcript>` and both files are readable; the agent replies through
 * POST /app/session-reply with a file; history shows both messages with downloadable attachments,
 * the operator message `originVerified: "verified"` and `bytes: "verified"`.
 * Wiring integrity: the media store, the raw chunk parser, the media router and the boot-time
 * app-media-path install are real. A fleet agent answers 503 media-off.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';

const HOST = 'echo-media-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];
const quietGates: NotificationSelectivityGate[] = [];

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const s of servers) await s.stop();
  for (const gate of quietGates) await gate.close();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-media-alive.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function boot(developmentAgent: boolean, telegramFactory?: (stateDir: string) => TelegramAdapter, slackFactory?: (stateDir: string) => SlackAdapter) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'media-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'media-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    mobilePairing: { multiRoute: { enabled: false }, ...(slackFactory ? { slackOwnerUserId: 'U0OWNER1' } : {}) },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: Array<{ message: string; options: { bootstrapConversationIds?: number[] } }> = [];
  sessionManager.spawnInteractiveSession = async (message: string, _name: string | undefined, options: { bootstrapConversationIds?: number[] }) => {
    spawned.push({ message, options });
    return 'app-session-1';
  };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const telegram = telegramFactory?.(stateDir);
  const slack = slackFactory?.(stateDir);
  // Slack runs with the conversation registry server.ts builds (the production path passes it).
  const conversationRegistry = slack ? new ConversationRegistry({ stateDir, machineId: () => 'e2e', isRecordingEnabled: () => true }) : undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, ...(telegram ? { telegram } : {}), ...(slack ? { slack, conversationRegistry } : {}) });
  servers.push(server);
  return { server, stateDir, dir, spawned, telegram, slack, conversationRegistry };
}

describe('media in app conversations — production wiring', () => {
  it('is alive with no messaging service and no transcription provider: upload, send, session paths, reply with a file, history', async () => {
    // No transcription provider: a voice note the phone did not transcribe must still arrive (§4.5.1).
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const { server, stateDir, dir, spawned } = await boot(true);
    const app = server.getApp();
    // Wiring integrity: the media store is real and the helper is installed at boot.
    expect(server.appConversations).not.toBeNull();
    expect(server.appConversations!.media).toBeInstanceOf(AppMediaStore);
    expect(fs.existsSync(path.join(stateDir, 'scripts', 'app-media-path'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'app-media', 'outbox'))).toBe(true);

    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const auth = (q: request.Test) => q.set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e');
    const m = await auth(request(app).post('/mobile/pairing-codes')).send({});
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

    // Regression fb-30fc4ffb-e4a: the 507 seen on a phone names the machine's nickname.
    const identity = new MachineIdentityManager(stateDir);
    identity.updateNickname(identity.loadIdentity().machineId, 'Mac Studio');
    const disk = vi.spyOn(server.appConversations!.media! as any, 'diskSpace').mockReturnValue({ free: 1, total: 1e12 });
    const refused = await send('POST', '/mobile/media/uploads', {
      requestId: rid(), conversationRef: `app:${key}`, size: 10, sha256: 'd'.repeat(64), declaredKind: 'file', declaredType: 'text/plain', filename: 'note.txt',
    });
    expect(refused.status).toBe(507);
    expect(refused.body).toMatchObject({ error: 'media-disk-floor', detail: "Mac Studio is nearly out of disk space, so the file wasn't stored." });
    disk.mockRestore();

    // A photo (two chunks) and a voice note, uploaded through the production raw-body parser.
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1024 * 1024 + 500)]);
    const voice = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(3000)]);
    const voice2 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(2000)]);
    const files = [
      { bytes: photo, declaredKind: 'photo', declaredType: 'image/jpeg', filename: 'beach.jpg' },
      { bytes: voice, declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a', transcript: 'meet at the pier at noon' },
      { bytes: voice2, declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'untranscribed.m4a' },
    ];
    const attachments: Array<Record<string, unknown>> = [];
    for (const f of files) {
      const d = { size: f.bytes.length, sha256: sha(f.bytes), declaredKind: f.declaredKind, declaredType: f.declaredType, filename: f.filename };
      const start = await send('POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...d, requestId: rid() });
      expect(start.status).toBe(200);
      for (let i = 0; i * start.body.chunkSize < f.bytes.length; i++) {
        const c = await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/${i}`, undefined, f.bytes.subarray(i * start.body.chunkSize, (i + 1) * start.body.chunkSize));
        expect(c.status).toBe(200);
      }
      attachments.push({ uploadId: start.body.uploadId, ...d, ...(f.transcript ? { transcript: f.transcript } : {}) });
    }
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: 'Photos from today', requestId: rid(), attachments });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });

    // The session got one line per file, with readable private copies, before the caption.
    // A bootstrap past 500 characters is handed to the session as a file it reads; read it the same way.
    const pointer = /Long message saved to (\S+?) —/.exec(spawned[0]!.message);
    const msg = pointer ? fs.readFileSync(pointer[1]!, 'utf8') : spawned[0]!.message;
    expect(msg).toContain('📱 signed');
    const image = /\[image:([^\]]+)\]/.exec(msg)![1]!;
    const note = /\[voice:([^\]]+)\] meet at the pier at noon/.exec(msg)![1]!;
    expect(fs.readFileSync(image).equals(photo)).toBe(true);
    expect(fs.readFileSync(note).equals(voice)).toBe(true);
    // Increment 2: no phone transcript and no provider ⇒ the path with an honest note.
    const note2 = /\[voice:([^\]]+)\] \(transcription unavailable: no transcription provider is configured; the audio file is at that path\)/.exec(msg)![1]!;
    expect(fs.readFileSync(note2).equals(voice2)).toBe(true);
    expect(msg).toContain('Photos from today');

    // The agent replies with a file through the relay route.
    const alias = spawned[0]!.options.bootstrapConversationIds![0]!;
    const token = createConversationBindAuth(stateDir).mint('app-session-1', [alias]);
    const itinerary = path.join(dir, 'itinerary.pdf');
    fs.writeFileSync(itinerary, '%PDF-1.7 day one: the pier');
    const reply = await auth(request(app).post('/app/session-reply')).set('X-Instar-Bind-Token', token)
      .send({ conversationId: alias, text: 'Here is the plan.', files: [{ path: itinerary }] });
    expect(reply.status).toBe(200);

    // History: both messages, each attachment downloadable and verified.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    const [op, ag] = hist.body.messages;
    expect(op).toMatchObject({ role: 'operator', originVerified: 'verified' });
    expect(op.attachments.map((a: { kind: string; bytes: string }) => [a.kind, a.bytes])).toEqual([['photo', 'verified'], ['voice', 'verified'], ['voice', 'verified']]);
    expect(ag).toMatchObject({ role: 'agent', text: 'Here is the plan.', originVerified: 'none' });
    expect(ag.attachments[0]).toMatchObject({ kind: 'file', mediaType: 'application/pdf', bytes: 'verified' });
    for (const a of [...op.attachments, ...ag.attachments]) {
      const dl = await send('GET', `/mobile/media/${a.sha256}?ref=app:${key}`);
      expect(dl.status).toBe(200);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
    }
    const health = await auth(request(app).get('/health'));
    expect(health.body.appMedia).toMatchObject({ liveBytes: photo.length + voice.length + voice2.length + fs.statSync(itinerary).size, openUploads: 0 });
  });

  it('server voice transcripts (§4.5.1) on the production path: the shared provider transcribes, the transcript is its own scrubbed event, history shows it unsigned', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk-e2e');
    vi.stubEnv('OPENAI_API_KEY', '');
    const invite = `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;
    const providerCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).startsWith('https://api.groq.com/')) {
        providerCalls.push(String(url));
        return new Response(JSON.stringify({ text: `book the ferry, invite ${invite}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const { server, spawned } = await boot(true);
    const app = server.getApp();
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
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
    const key = (await send('POST', '/mobile/conversations', { title: 'Ferry', requestId: rid() })).body.conversationKey as string;
    const voice = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(1500)]);
    const d = { size: voice.length, sha256: sha(voice), declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'ferry.m4a' };
    const start = await send('POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...d, requestId: rid() });
    expect((await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/0`, undefined, voice)).status).toBe(200);
    const sent = await send('POST', `/mobile/chat/app/${key}`, { text: '', requestId: rid(), attachments: [{ uploadId: start.body.uploadId, ...d }] });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });
    expect(providerCalls).toEqual(['https://api.groq.com/openai/v1/audio/transcriptions']);

    // The session line carries the scrubbed transcript; the invite never reaches it.
    const pointer = /Long message saved to (\S+?) —/.exec(spawned[0]!.message);
    const msg = pointer ? fs.readFileSync(pointer[1]!, 'utf8') : spawned[0]!.message;
    expect(msg).toMatch(/\[voice:[^\]]+\] book the ferry, invite \[pairing invite removed\]/);
    expect(msg).not.toContain('tlinv1:');

    // Stored as its own unsigned event, shown on the attachment; the operator message still verifies.
    const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
    const op = hist.body.messages[0];
    expect(op.originVerified).toBe('verified');
    expect(op.attachments[0].transcript).toBeUndefined();
    expect(op.attachments[0].serverTranscript).toMatchObject({ text: 'book the ferry, invite [pairing invite removed]', provider: 'groq', signed: false });
    const tr = server.appConversations!.store.transcriptFor(op.attachments[0].attachmentId);
    expect(tr).toMatchObject({ kind: 'transcript', provider: 'groq', messageId: op.messageId });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('Telegram media (§4.9): a photo a Telegram topic receives is recorded on the production path and served to the paired phone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) })));
    const { server, telegram } = await boot(true, (stateDir) => new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', pollIntervalMs: 100 }, stateDir));
    const app = server.getApp();
    // Wiring integrity: the hook is set on the real adapter and delegates to the real store.
    expect((telegram as unknown as { inboundMediaHook: unknown }).inboundMediaHook).toBeTypeOf('function');
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
    (telegram as unknown as { downloadFile: (id: string, dest: string) => Promise<void> }).downloadFile = async (_id, dest) => { fs.writeFileSync(dest, photo); };
    await (telegram as unknown as { handlePhotoMessage: (m: unknown, t: number) => Promise<void> }).handlePhotoMessage({
      message_id: 9001, date: Math.floor(Date.now() / 1000), from: { id: 5, first_name: 'J', is_bot: false }, chat: { id: -100123, type: 'supergroup' },
      message_thread_id: 42, caption: 'the view', photo: [{ file_id: 'p', file_unique_id: 'u', width: 800, height: 600 }],
    }, 42);
    let pm = null;
    for (let i = 0; i < 50 && !pm; i++) { pm = server.appConversations!.store.getPlatformMedia('telegram:42', '9001'); if (!pm) await new Promise((r) => setTimeout(r, 20)); }
    expect(pm?.attachments[0]).toMatchObject({ sha256: sha(photo), kind: 'photo' });

    // A phone paired through the production path reads the topic and downloads the photo.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let tick = 0;
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now() + (tick++ % 500));
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = (method === 'GET' ? request(app).get(p) : request(app).post(p)).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    const hist = await send('GET', '/telegram/topics/42/messages');
    expect(hist.status).toBe(200);
    const row = (hist.body.messages as Array<Record<string, any>>).find((x) => x.messageId === 9001)!;
    expect(row.text).toBe('[photo] the view');
    expect(row.attachments[0]).toMatchObject({ sha256: sha(photo), bytes: 'verified' });
    const dl = await send('GET', `/mobile/media/${sha(photo)}?ref=telegram:42`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body as Buffer).equals(photo)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('Slack media (§4.9): a file a Slack message carries is recorded on the production path and served to the paired phone', async () => {
    const slackFactory = (stateDir: string) => new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U0OWNER1'], workspaceMode: 'dedicated' } as never, stateDir);
    const { server, slack, conversationRegistry } = await boot(true, undefined, slackFactory);
    const app = server.getApp();
    const internals = slack as unknown as {
      inboundMediaHook: unknown; getUserInfo: () => Promise<{ name: string }>;
      apiClient: { call: () => Promise<Record<string, unknown>> };
      fileHandler: { downloadFile: (u: string, d: string) => Promise<string> };
      _handleMessage: (e: Record<string, unknown>) => Promise<void>;
    };
    // Wiring integrity: the hook is set on the real adapter and delegates to the real store.
    expect(internals.inboundMediaHook).toBeTypeOf('function');
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000)]);
    internals.getUserInfo = async () => ({ name: 'Justin' });
    internals.apiClient.call = async () => ({ ok: true });
    internals.fileHandler.downloadFile = async (_u, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, photo); return dest; };
    // _validateImageFile reads real image headers; a JPEG header passes.
    const ts = `${Math.floor(Date.now() / 1000)}.000100`;
    await internals._handleMessage({ user: 'U0OWNER1', text: 'the view', channel: 'D0E2ESLK', ts, subtype: 'file_share', files: [{ id: 'F0E2E1', name: 'view.jpg', mimetype: 'image/jpeg', url_private_download: 'https://files.slack.com/view.jpg' }] });
    const key = 'slack:_:D0E2ESLK';
    let pm = null;
    for (let i = 0; i < 50 && !pm; i++) { pm = server.appConversations!.store.getPlatformMedia(key, ts); if (!pm) await new Promise((r) => setTimeout(r, 20)); }
    expect(pm?.attachments[0]).toMatchObject({ sha256: sha(photo), kind: 'photo' });
    const convId = conversationRegistry!.mintForInbound('D0E2ESLK').id!;

    // A phone paired through the production path reads the conversation and downloads the file.
    server.mobilePairing!.deps.fetchFn = (async (url: string) => {
      const u = new URL(url);
      const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
      return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
    }) as unknown as typeof fetch;
    const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
    const dms: string[] = [];
    server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
    server.mobilePairing!.deps.telegramOwnerPresent = () => true;
    const dev = makeDevice();
    const r = await request(app).post('/mobile/pairing-codes/redeem').set('Host', HOST).send({ code: m.body.code, deviceName: 'e2e phone', devicePublicKey: dev.publicKey });
    const deviceId = r.body.deviceId as string;
    const code = /is (\d{3}) (\d{3})\./.exec(dms[0]!)!.slice(1).join('');
    let tick = 0;
    const send = (method: 'GET' | 'POST', p: string, body?: unknown) => {
      const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const time = String(Date.now() + (tick++ % 500));
      const sig = dev.sign(canonicalString(deviceId, HOST, method, p, time, raw));
      const q = (method === 'GET' ? request(app).get(p) : request(app).post(p)).set('X-Instar-Device', deviceId).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
      return raw ? q.set('Content-Type', 'application/json').send(raw.toString()) : q;
    };
    expect((await send('POST', '/mobile/device/confirm', { code })).body.status).toBe('active');
    const machine = server.appConversations!.deps.machineId();
    const hist = await send('GET', `/mobile/chat/slack/${convId}/messages?machine=${encodeURIComponent(machine)}`);
    expect(hist.status).toBe(200);
    expect(hist.body.conversationKey).toBe(key);
    const row = (hist.body.messages as Array<Record<string, any>>).find((x) => x.messageId === ts)!;
    expect(row.text).toBe('the view [photo]');
    expect(row.attachments[0]).toMatchObject({ sha256: sha(photo), bytes: 'verified' });
    const dl = await send('GET', `/mobile/media/${sha(photo)}?ref=${encodeURIComponent(key)}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body as Buffer).equals(photo)).toBe(true);
  });

  it('app → Telegram (§4.9): authenticated media remains mirrored with Quiet by Default enforcing', async () => {
    // The Bot API is stubbed: the real adapter builds the multipart request, nothing leaves.
    const botCalls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { body: unknown }) => {
      botCalls.push({ method: String(url).split('/').pop() ?? '', body: init?.body });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 77 } }), text: async () => '' };
    }));
    // The inbound core answers 503 server-boot-incomplete until the running version is known (as at boot).
    ProcessIntegrity.reset();
    ProcessIntegrity.initialize('1.2.36', null);
    try {
      const { server, telegram, spawned } = await boot(true, (stateDir) => {
        const tg = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', ownerUserId: 4242, authorizedUserIds: [4242], pollIntervalMs: 100 } as never, stateDir);
        const gate = new NotificationSelectivityGate(stateDir, 'ci-machine', () => ({ enabled: true, dryRun: false }));
        quietGates.push(gate); tg.selectivity = gate;
        tg.registerTopicSession(42, 'tg-session', 'Trip');
        return tg;
      });
      const app = server.getApp();
      // Wiring integrity: the real adapter carries the media send the route mirrors through.
      expect(typeof telegram!.sendMediaToTopic).toBe('function');
      server.mobilePairing!.deps.fetchFn = (async (url: string) => {
        const u = new URL(url);
        const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
        return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
      }) as unknown as typeof fetch;
      const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
      const dms: string[] = [];
      server.mobilePairing!.deps.ownerDM = async (text) => { dms.push(text); return 1; };
      server.mobilePairing!.deps.telegramOwnerPresent = () => true;
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

      const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000)]);
      const d = { size: photo.length, sha256: sha(photo), declaredKind: 'photo', declaredType: 'image/jpeg', filename: 'pier.jpg' };
      const start = await send('POST', '/mobile/media/uploads', { conversationRef: 'telegram:42', ...d, requestId: rid() });
      expect(start.status).toBe(200);
      expect((await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/0`, undefined, photo)).status).toBe(200);
      const sent = await send('POST', '/mobile/chat/42', { text: 'From the pier', requestId: rid(), attachments: [{ uploadId: start.body.uploadId, ...d }] });
      expect({ status: sent.status, body: sent.body }).toMatchObject({ status: 200, body: { ok: true, mirror: 'sent' } });

      // Stored under telegram:42 as a media-message; the session got the file as a readable path.
      expect(server.appConversations!.store.getEvent('telegram:42', sent.body.eventId as string)).toMatchObject({ kind: 'media-message', text: 'From the pier' });
      // The inbound core logs the delivered text in the topic's history (and hands it to the session).
      const fromHistory = (telegram!.getTopicHistory(42, 10) as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n');
      const pathMatch = /\[image:([^\]]+)\]/.exec(fromHistory) ?? /\[image:([^\]"]+)\]/.exec(JSON.stringify(spawned));
      expect(pathMatch).not.toBeNull();
      expect(fs.readFileSync(pathMatch![1]!).equals(photo)).toBe(true);
      // The mirror went out as sendPhoto through the production adapter.
      expect(botCalls.map((c) => c.method)).toContain('sendPhoto');
      const latest = telegram!.selectivity!.latestInbound(42);
      expect(latest).toBeDefined();
      expect(telegram!.selectivity!.decide(42, { origin: 'automated', category: 'presence-standby', sourceContext: 'presence', inboundMessageId: latest }).decision).toBe('deliver');
      const before = botCalls.filter(c => c.method === 'sendPhoto').length;
      expect(await telegram!.sendMediaToTopic(42, [{ data: photo, filename: 'routine.jpg', mediaType: 'image/jpeg', kind: 'photo' }], 'Routine screenshot')).toMatchObject({ recorded: true, delivered: false });
      expect(botCalls.filter(c => c.method === 'sendPhoto')).toHaveLength(before);


      // The paired phone sees the file in the topic's history and downloads it by the topic ref.
      const hist = await send('GET', '/telegram/topics/42/messages');
      const row = (hist.body.messages as Array<Record<string, any>>).find((x) => x.eventId === sent.body.eventId)!;
      expect(row).toMatchObject({ text: 'From the pier', originVerified: 'verified' });
      expect(row.attachments[0]).toMatchObject({ sha256: sha(photo), bytes: 'verified' });
      const dl = await send('GET', `/mobile/media/${sha(photo)}?ref=telegram:42`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(dl.body as Buffer).equals(photo)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      ProcessIntegrity.reset();
    }
  });

  it('a fleet agent sets no Slack media hook', async () => {
    const { slack } = await boot(false, undefined, (stateDir) => new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U0OWNER1'], workspaceMode: 'dedicated' } as never, stateDir));
    expect((slack as unknown as { inboundMediaHook: unknown }).inboundMediaHook).toBeNull();
  });

  it('a fleet agent sets no Telegram media hook', async () => {
    const { telegram } = await boot(false, (stateDir) => new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', pollIntervalMs: 100 }, stateDir));
    expect((telegram as unknown as { inboundMediaHook: unknown }).inboundMediaHook).toBeNull();
  });

  it('is off on a fleet agent: the media routes answer 503', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).post('/mobile/media/purge').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
    expect(res.status).toBe(503);
  });
});
