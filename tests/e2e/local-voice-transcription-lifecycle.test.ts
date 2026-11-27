/**
 * Feature-is-alive proof for on-machine voice transcription (docs/specs/backup-on-machine-voice.md),
 * and the recommended-services catalog drill for the voice-transcription row's backup.
 *
 * An AgentServer booted on its production path with NO Groq/OpenAI key: GET /voice-transcription
 * answers 200 naming whisper.cpp on this machine, /capabilities carries the voiceTranscription block,
 * and a paired phone's voice note (no phone transcript) is transcribed by the local provider through
 * the real `transcribeVoice` wiring — the session line carries the text and the stored transcript is
 * labelled `local`. With no model installed, the line carries the plain missing-pieces reason.
 *
 * `ffmpeg` and `whisper-cli` are fake scripts (named by INSTAR_FFMPEG / INSTAR_WHISPER_CLI) that
 * replay the REAL captured whisper.cpp 1.9.5 output, so this runs the same on any machine.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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
import { resetLocalTranscriberState } from '../../src/core/LocalVoiceTranscriber.js';
import { resetVoiceTranscriptionState } from '../../src/core/VoiceTranscription.js';
import { useHermeticMediaDisk } from '../helpers/hermeticMediaDisk.js';

const HOST = 'echo-voice-e2e.example.dev';
const REAL_SPEECH_STDOUT = path.resolve(__dirname, '../fixtures/voice/whisper-cli-1.9.5-speech.stdout');
const servers: AgentServer[] = [];
const dirs: string[] = [];

afterEach(() => { vi.unstubAllEnvs(); resetLocalTranscriberState(); resetVoiceTranscriptionState(); });
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/local-voice-transcription-lifecycle.test.ts' });
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => `${Date.now()}-${crypto.randomUUID()}`;

function toneWav(seconds: number): Buffer {
  const n = 16000 * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Fake programs + model under a temp home; the environment points the transcriber at them. */
function installFakes(root: string, withModel: boolean): void {
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const wav = path.join(root, 'tone.wav');
  fs.writeFileSync(wav, toneWav(3));
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh\nfor a; do out="$a"; done; cp "${wav}" "$out"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'whisper-cli'), `#!/bin/sh\ncat "${REAL_SPEECH_STDOUT}"\n`, { mode: 0o755 });
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'));
  vi.stubEnv('XDG_STATE_HOME', path.join(home, 'state'));
  vi.stubEnv('INSTAR_FFMPEG', path.join(bin, 'ffmpeg'));
  vi.stubEnv('INSTAR_WHISPER_CLI', path.join(bin, 'whisper-cli'));
  if (withModel) {
    const model = Buffer.alloc(1024 * 1024 + 16);
    model.write('lmgg', 0, 'latin1');
    fs.writeFileSync(path.join(root, 'ggml-base.bin'), model);
    vi.stubEnv('INSTAR_WHISPER_MODEL', path.join(root, 'ggml-base.bin'));
  } else {
    vi.stubEnv('INSTAR_WHISPER_MODEL', '');
  }
}

async function boot() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'voice-e2e-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'e2e machine' });
  const config = {
    projectName: 'voice-e2e', projectDir: dir, stateDir, port: 0, authToken: 'e2e-token', developmentAgent: true,
    mobilePairing: { multiRoute: { enabled: false } },
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: HOST },
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    threadline: { ownerName: 'Justin' },
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const spawned: string[] = [];
  sessionManager.spawnInteractiveSession = async (message: string) => { spawned.push(message); return 'app-session-1'; };
  sessionManager.injectMessage = () => true;
  const tunnel = { lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' }, url: `https://${HOST}`, on: () => undefined } as any;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel });
  servers.push(server);
  useHermeticMediaDisk(server); // the host's free space must not decide the result
  return { server, dir, spawned };
}

/** Pair a phone and send one untranscribed voice note; returns the session text and the history. */
async function sendVoiceNote(server: AgentServer, spawned: string[]) {
  const app = server.getApp();
  server.mobilePairing!.deps.fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', HOST);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const m = await request(app).post('/mobile/pairing-codes').set('Authorization', 'Bearer e2e-token').set('X-Instar-AgentId', 'voice-e2e').send({});
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
  const key = (await send('POST', '/mobile/conversations', { title: 'Voice', requestId: rid() })).body.conversationKey as string;
  const voice = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(1500)]);
  const d = { size: voice.length, sha256: sha(voice), declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a' };
  const start = await send('POST', '/mobile/media/uploads', { conversationRef: `app:${key}`, ...d, requestId: rid() });
  expect((await send('PUT', `/mobile/media/uploads/${start.body.uploadId}/chunks/0`, undefined, voice)).status).toBe(200);
  const sent = await send('POST', `/mobile/chat/app/${key}`, { text: '', requestId: rid(), attachments: [{ uploadId: start.body.uploadId, ...d }] });
  expect(sent.status).toBe(200);
  expect(sent.body).toMatchObject({ ok: true, outcome: 'delivered' });
  const pointer = /Long message saved to (\S+?) —/.exec(spawned[0]!);
  const msg = pointer ? fs.readFileSync(pointer[1]!, 'utf8') : spawned[0]!;
  const hist = await send('GET', `/mobile/chat/app/${key}/messages`);
  return { msg, hist };
}

describe('on-machine voice transcription — production wiring', () => {
  it('is alive with no paid provider: the status route and capabilities name whisper.cpp, and an app voice note is transcribed locally', async () => {
    const { dir: fakesRoot } = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fakes-')) };
    dirs.push(fakesRoot);
    installFakes(fakesRoot, true);
    const { server, spawned } = await boot();
    const app = server.getApp();

    const status = await request(app).get('/voice-transcription').set('Authorization', 'Bearer e2e-token');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ active: 'local', paid: null, localEnabled: true, machine: os.hostname() });
    expect(status.body.local.state).toBe('installed-unproven');
    expect(status.body.summary).toMatch(/whisper\.cpp/);
    expect((await request(app).get('/voice-transcription')).status).toBe(401);

    const caps = await request(app).get('/capabilities').set('Authorization', 'Bearer e2e-token');
    expect(caps.status).toBe(200);
    expect(caps.body.voiceTranscription).toMatchObject({ endpoints: ['GET /voice-transcription'] });

    const { msg, hist } = await sendVoiceNote(server, spawned);
    expect(msg).toMatch(/\[voice:[^\]]+\] Hello Echo, this is a test voice note about the local transcriber\./);
    const op = hist.body.messages[0];
    expect(op.attachments[0].serverTranscript).toMatchObject({ provider: 'local', signed: false });
    const tr = server.appConversations!.store.transcriptFor(op.attachments[0].attachmentId);
    expect(tr).toMatchObject({ kind: 'transcript', provider: 'local' });

    // The run proved the install.
    const after = await request(app).get('/voice-transcription').set('Authorization', 'Bearer e2e-token');
    expect(after.body.local.state).toBe('proven');
  });

  it('with no model installed, the voice note arrives with the plain missing-pieces reason', async () => {
    const fakesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-fakes-'));
    dirs.push(fakesRoot);
    installFakes(fakesRoot, false);
    const { server, spawned } = await boot();
    const status = await request(server.getApp()).get('/voice-transcription').set('Authorization', 'Bearer e2e-token');
    expect(status.body.active).toBeNull();
    expect(status.body.local.missing).toEqual(['a whisper model file']);
    const { msg } = await sendVoiceNote(server, spawned);
    expect(msg).toMatch(/\[voice:[^\]]+\] \(transcription unavailable: the free on-machine transcriber \(whisper\.cpp\) needs a whisper model file, and no transcription service is set up; the audio file is at that path\)/);
  });
});
