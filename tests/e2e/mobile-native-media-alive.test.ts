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
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';

const HOST = 'echo-media-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/mobile-native-media-alive.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'media-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'media-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent,
    mobilePairing: { multiRoute: { enabled: false } },
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
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  return { server, stateDir, dir, spawned };
}

describe('media in app conversations — production wiring', () => {
  it('is alive with no messaging service and no transcription provider: upload, send, session paths, reply with a file, history', async () => {
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

    // A photo (two chunks) and a voice note, uploaded through the production raw-body parser.
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(1024 * 1024 + 500)]);
    const voice = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(3000)]);
    const files = [
      { bytes: photo, declaredKind: 'photo', declaredType: 'image/jpeg', filename: 'beach.jpg' },
      { bytes: voice, declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a', transcript: 'meet at the pier at noon' },
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
    expect(op.attachments.map((a: { kind: string; bytes: string }) => [a.kind, a.bytes])).toEqual([['photo', 'verified'], ['voice', 'verified']]);
    expect(ag).toMatchObject({ role: 'agent', text: 'Here is the plan.', originVerified: 'none' });
    expect(ag.attachments[0]).toMatchObject({ kind: 'file', mediaType: 'application/pdf', bytes: 'verified' });
    for (const a of [...op.attachments, ...ag.attachments]) {
      const dl = await send('GET', `/mobile/media/${a.sha256}?ref=app:${key}`);
      expect(dl.status).toBe(200);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
    }
    const health = await auth(request(app).get('/health'));
    expect(health.body.appMedia).toMatchObject({ liveBytes: photo.length + voice.length + fs.statSync(itinerary).size, openUploads: 0 });
  });

  it('is off on a fleet agent: the media routes answer 503', async () => {
    const { server } = await boot(false);
    const res = await request(server.getApp()).post('/mobile/media/purge').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'media-e2e').send({});
    expect(res.status).toBe(503);
  });
});
