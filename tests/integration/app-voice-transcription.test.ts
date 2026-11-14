/**
 * Server-side voice transcription for app conversations, through the full HTTP pipeline
 * (docs/specs/mobile-native-chat-media.md §4.5.1, increment 2): an AgentServer on a development
 * agent with a transcription provider in the environment and no Telegram. A voice note sent from
 * the paired phone WITHOUT a phone transcript reaches the session as `[voice:<path>] <transcript>`,
 * produced by the shared VoiceTranscription module (the Telegram transcriber) posting the M4A as
 * audio/mp4; a failing provider still delivers the path with an honest "transcription
 * unavailable" note, and the send is still `delivered`.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
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
import { makeDevice } from '../helpers/mobileDevice.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';

const HOST = 'echo-media-e2e.example.dev';
const servers: AgentServer[] = [];
const dirs: string[] = [];

beforeAll(() => {
  // Voice delivery is under test; disk-capacity refusal has separate coverage.
  vi.spyOn(AppMediaStore.prototype, 'diskSpace').mockReturnValue({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 });
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/app-voice-transcription.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

async function boot(developmentAgent: boolean) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'voice-int-'));
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


const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

/** The provider stub: only the transcription endpoint is intercepted. */
function stubProvider(answer: (form: FormData) => Response, seen: Array<{ url: string; type: string; model: string }>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.groq.com/')) return realFetch(input as never, init);
    const form = init!.body as FormData;
    seen.push({ url, type: (form.get('file') as File).type, model: String(form.get('model')) });
    return answer(form);
  }) as typeof fetch;
}

describe('app voice notes are transcribed with the Telegram transcriber', () => {
  for (const scenario of ['transcribed', 'provider-fails'] as const) {
    it(scenario === 'transcribed' ? 'a voice note without a phone transcript reaches the session with the server transcript' : 'a failing provider still delivers the path with an honest note', async () => {
      vi.stubEnv('GROQ_API_KEY', 'test-groq-key');
      vi.stubEnv('OPENAI_API_KEY', '');
      const seen: Array<{ url: string; type: string; model: string }> = [];
      stubProvider(() => (scenario === 'transcribed'
        ? new Response(JSON.stringify({ text: 'bring the blue folder' }), { status: 200 })
        : new Response('overloaded', { status: 503 })), seen);
      const { server, stateDir, spawned } = await boot(true);
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
      const key = (await send('POST', '/mobile/conversations', { title: 'Voice', requestId: rid() })).body.conversationKey as string;
      const voice = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(3000)]);
      const d = { size: voice.length, sha256: sha(voice), declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a' };
      const start = await send('POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...d, requestId: rid() });
      expect(start.status).toBe(200);
      expect((await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/0`, undefined, voice)).status).toBe(200);
      const sent = await send('POST', `/mobile/chat/app/${key}`, { text: '', requestId: rid(), attachments: [{ uploadId: start.body.uploadId, ...d }] });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });

      expect(seen).toEqual([{ url: 'https://api.groq.com/openai/v1/audio/transcriptions', type: 'audio/mp4', model: 'whisper-large-v3' }]);
      const pointer = /Long message saved to (\S+?) —/.exec(spawned[0]!.message);
      const msg = pointer ? fs.readFileSync(pointer[1]!, 'utf8') : spawned[0]!.message;
      const line = scenario === 'transcribed'
        ? /\[voice:([^\]]+)\] bring the blue folder/.exec(msg)
        : /\[voice:([^\]]+)\] \(transcription unavailable: the transcription service failed; the audio file is at that path\)/.exec(msg);
      expect(line).not.toBeNull();
      expect(fs.readFileSync(line![1]!).equals(voice)).toBe(true);
    }, 30_000);
  }
});
