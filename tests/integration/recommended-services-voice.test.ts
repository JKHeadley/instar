/**
 * Voice transcription through the routes: a yes starts setup, the session stores the key through the key
 * route, the check passes only on the provider's own answer, the stored key reaches transcription itself,
 * and a switch-off removes it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { RECOMMENDED_SERVICE_CATALOG, type CatalogRow } from '../../src/recommended/catalog.js';
import { readSetupStates } from '../../src/recommended/setupState.js';
import { registerRecommendedServiceRoutes } from '../../src/server/recommendedServiceRoutes.js';
import { VOICE_TRANSCRIPTION_SECRET, registerStoredTranscriptionKey, resolveTranscriptionProvider, transcribeAudioFile } from '../../src/core/VoiceTranscription.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_a', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_a', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};
const PROVEN: CatalogRow = { ...RECOMMENDED_SERVICE_CATALOG.find((r) => r.id === 'voice-transcription')!, setupRecipe: 'voice-v1' };
const BASE = '/recommended-services/voice-transcription';
const GROQ = 'gsk_' + 'c'.repeat(52);

describe('voice transcription through the routes', () => {
  let dir: string;
  let ledger: RecommendedServicesLedger;
  let store: Record<string, string>;
  let start: ReturnType<typeof vi.fn>;
  let told: ReturnType<typeof vi.fn>;
  let groqAccepts: boolean;
  const saved = { g: process.env.GROQ_API_KEY, o: process.env.OPENAI_API_KEY };

  const fakeFetch = (async (url: string) => {
    if (String(url).endsWith('/models')) return groqAccepts
      ? new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }] }), { status: 200 })
      : new Response('{}', { status: 401 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const app = () => {
    const a = express();
    a.use(express.text({ type: 'text/plain' }));
    a.use(express.json());
    const router = express.Router();
    registerRecommendedServiceRoutes(router, {
      ledger: () => ledger, stateDir: dir, owner: () => '42', catalog: [PROVEN], port: 4040,
      checkPin: () => true, checkConfirmPin: () => true, recordApproval: () => undefined,
      openCommitment: () => 'CMT-1', finishCommitment: () => undefined, withdrawCommitment: () => undefined,
      startSetup: start, stopSetup: () => true, sessionForTopic: () => null, isSetupRunning: () => false,
      notifyStuck: async () => true, clearStuck: () => undefined, tellOwner: told,
      readSecret: (n) => store[n] ?? null, writeSecret: (n, v) => { store[n] = v; }, deleteSecret: (n) => { delete store[n]; },
      fetch: fakeFetch,
    });
    a.use(router);
    return a;
  };
  const say = async (a: express.Express, what: 'yes' | 'no', shutdown = false) => {
    const { body } = await request(a).get(`${BASE}/confirm`);
    return request(a).post(`${BASE}/confirm`).set('X-Instar-Request', '1').send({ token: body.token, pin: '1', answer: what, shutdown });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-voice-'));
    ledger = new RecommendedServicesLedger({ stateDir: dir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
    store = {}; groqAccepts = true;
    start = vi.fn(async () => ({ sessionName: 's-voice', topicId: 7 }));
    told = vi.fn();
    delete process.env.GROQ_API_KEY; delete process.env.OPENAI_API_KEY;
    registerStoredTranscriptionKey(() => store[VOICE_TRANSCRIPTION_SECRET] ?? null);
  });
  afterEach(() => {
    registerStoredTranscriptionKey(null);
    if (saved.g === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved.g;
    if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/recommended-services-voice.test.ts' });
  });

  it('a yes starts setup; the stored key passes the check and reaches transcription; a no with switch-off removes it', async () => {
    const a = app();
    expect((await say(a, 'yes')).status).toBe(200);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![2]).toContain('/recommended-services/voice-transcription/key');
    // Nothing transcribes yet.
    expect(resolveTranscriptionProvider()).toBeNull();
    const key = await request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(GROQ);
    expect(key.status).toBe(200);
    expect(store[VOICE_TRANSCRIPTION_SECRET]).toBe(GROQ);
    const verify = await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    expect(verify.status).toBe(200);
    expect(verify.body.result).toBe('pass');
    expect(readSetupStates(dir)['voice-transcription']?.verified?.result).toBe('pass');
    // The stored key is what transcription now uses, with no environment variable.
    expect(resolveTranscriptionProvider()).toMatchObject({ name: 'groq', apiKey: GROQ });
    const audio = path.join(dir, 'note.ogg');
    fs.writeFileSync(audio, Buffer.from('OggS'));
    let sentAuth = '';
    const text = await transcribeAudioFile(audio, { fetchImpl: (async (_u: string, init: RequestInit) => {
      sentAuth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 });
    }) as unknown as typeof fetch });
    expect(text).toBe('hello there');
    expect(sentAuth).toBe(`Bearer ${GROQ}`);

    const no = await say(a, 'no', true);
    expect(no.status).toBe(200);
    await vi.waitFor(() => expect(store[VOICE_TRANSCRIPTION_SECRET]).toBeUndefined());
    expect(resolveTranscriptionProvider()).toBeNull();
  });

  it('a refused key fails the check and the row is not working', async () => {
    const a = app();
    await say(a, 'yes');
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    groqAccepts = false;
    await request(a).post(`${BASE}/key`).set('X-Instar-Request', '1').type('text/plain').send(GROQ);
    const verify = await request(a).post(`${BASE}/verify`).set('X-Instar-Request', '1').send({});
    expect(verify.body.result).toBe('fail');
    expect(verify.body.detail).toContain('Groq refused the key');
  });
});
