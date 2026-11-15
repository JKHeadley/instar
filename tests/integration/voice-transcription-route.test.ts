/**
 * GET /voice-transcription and the /capabilities voiceTranscription block through the real HTTP
 * pipeline (docs/specs/backup-on-machine-voice.md): local ready, nothing installed, a paid provider
 * configured, the off switch, and /capabilities never reading the stored (keychain) key.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { resetLocalTranscriberState } from '../../src/core/LocalVoiceTranscriber.js';
import { registerStoredTranscriptionKey, resetVoiceTranscriptionState } from '../../src/core/VoiceTranscription.js';

const servers: AgentServer[] = [];
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); resetLocalTranscriberState(); resetVoiceTranscriptionState(); });
afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/voice-transcription-route.test.ts' });
});

function fakes(withModel: boolean, withBinary = true): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-route-'));
  dirs.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (withBinary) fs.writeFileSync(path.join(bin, 'whisper-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  vi.stubEnv('GROQ_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'));
  vi.stubEnv('INSTAR_FFMPEG', path.join(bin, 'ffmpeg'));
  vi.stubEnv('INSTAR_WHISPER_CLI', withBinary ? path.join(bin, 'whisper-cli') : path.join(bin, 'absent'));
  vi.stubEnv('PATH', withBinary ? process.env.PATH ?? '' : bin);
  if (withModel) {
    const model = Buffer.alloc(1024 * 1024 + 16);
    model.write('lmgg', 0, 'latin1');
    fs.writeFileSync(path.join(root, 'ggml-base.bin'), model);
    vi.stubEnv('INSTAR_WHISPER_MODEL', path.join(root, 'ggml-base.bin'));
  } else {
    vi.stubEnv('INSTAR_WHISPER_MODEL', '');
  }
}

async function boot(extra: Partial<InstarConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'voice-route-srv-'));
  dirs.push(dir);
  const stateDir = path.join(dir, '.instar');
  for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  await new MachineIdentityManager(stateDir).generateIdentity({ name: 'route machine' });
  const config = {
    projectName: 'voice-route', projectDir: dir, stateDir, port: 0, authToken: 't', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    ...extra,
  } as unknown as InstarConfig;
  const sessionManager = createMockSessionManager() as any;
  sessionManager.on = () => undefined;
  const server = new AgentServer({ config, sessionManager, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir) });
  servers.push(server);
  return server.getApp();
}

const get = (app: Awaited<ReturnType<typeof boot>>, p: string) => request(app).get(p).set('Authorization', 'Bearer t');

describe('GET /voice-transcription', () => {
  it('local ready: active local, installed-unproven, plain summary naming this machine', async () => {
    fakes(true);
    const app = await boot();
    const r = await get(app, '/voice-transcription');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ active: 'local', paid: null, fallback: false, localEnabled: true, storedKeyChecked: true });
    expect(r.body.local).toMatchObject({ state: 'installed-unproven', ready: true, missing: [] });
    expect(r.body.summary).toContain(os.hostname());
  });

  it('nothing to transcribe with: active null and the missing pieces in plain words', async () => {
    fakes(false, false);
    const app = await boot();
    const r = await get(app, '/voice-transcription');
    expect(r.body.active).toBeNull();
    expect(r.body.local.state).toBe('missing');
    expect(r.body.local.missing).toContain('a whisper model file');
    expect(r.body.summary).toMatch(/can't be transcribed yet/);
  });

  it('a paid provider configured: paid first, local as the backup', async () => {
    fakes(true);
    vi.stubEnv('GROQ_API_KEY', 'gsk_test');
    const app = await boot();
    const r = await get(app, '/voice-transcription');
    expect(r.body).toMatchObject({ active: 'groq', paid: 'groq', fallback: true });
    expect(r.body.summary).toMatch(/Groq, with whisper\.cpp on this machine as the backup/);
  });

  it('the off switch: local is off and says so', async () => {
    fakes(true);
    const app = await boot({ voiceTranscription: { local: false } } as Partial<InstarConfig>);
    const r = await get(app, '/voice-transcription');
    expect(r.body).toMatchObject({ active: null, localEnabled: false, local: null });
    expect(r.body.summary).toMatch(/switched off/);
  });

  it('needs the bearer token', async () => {
    fakes(true);
    const app = await boot();
    expect((await request(app).get('/voice-transcription')).status).toBe(401);
  });
});

describe('/capabilities voiceTranscription', () => {
  it('carries active, local state and the summary, and never reads the stored key', async () => {
    fakes(true);
    const app = await boot();
    let reads = 0;
    registerStoredTranscriptionKey(() => { reads++; return null; });
    resetVoiceTranscriptionState(); // no cached full description: the capabilities path must not build one with the key
    const caps = await get(app, '/capabilities');
    expect(caps.status).toBe(200);
    expect(caps.body.voiceTranscription).toMatchObject({ configured: true, active: 'local', localState: 'installed-unproven', endpoints: ['GET /voice-transcription'] });
    expect(reads).toBe(0);
    // The status route reads it (fresh, full description).
    await get(app, '/voice-transcription');
    expect(reads).toBeGreaterThan(0);
  });
});
