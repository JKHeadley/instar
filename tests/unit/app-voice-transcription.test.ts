/**
 * Server-side voice transcription for app conversations (docs/specs/mobile-native-chat-media.md
 * §4.5.1, increment 2): the shared VoiceTranscription module Telegram also uses, and the session
 * line a voice note without a phone transcript gets — the transcript, or an honest
 * "transcription unavailable" note that still carries the file path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTranscriptionProvider, transcribeAudioFile, configuredVoiceProvider, TranscriptionUnavailableError,
} from '../../src/core/VoiceTranscription.js';
import { AppConversationService, voiceLineWithTranscript, voiceLineUnavailable } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { attachmentIdFor, CHUNK_BYTES, type AppAttachment } from '../../src/core/appMediaTypes.js';
import type { MediaMessageEvent } from '../../src/core/AppConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-voice-transcription.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')); dirs.push(d); return d; };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = '22222222-2222-4222-8222-222222222222';

describe('resolveTranscriptionProvider', () => {
  it('auto-detects Groq before OpenAI, and finds none with no keys', () => {
    expect(resolveTranscriptionProvider({ env: { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' } })).toMatchObject({ name: 'groq', apiKey: 'g', model: 'whisper-large-v3' });
    expect(resolveTranscriptionProvider({ env: { OPENAI_API_KEY: 'o' } })).toMatchObject({ name: 'openai', model: 'whisper-1' });
    expect(resolveTranscriptionProvider({ env: {} })).toBeNull();
  });
  it('an explicit provider wins, and with its key missing is never replaced by another vendor', () => {
    expect(resolveTranscriptionProvider({ explicit: 'OpenAI', env: { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' } })).toMatchObject({ name: 'openai' });
    const logs: string[] = [];
    expect(resolveTranscriptionProvider({ explicit: 'openai', env: { GROQ_API_KEY: 'g' }, log: (l) => logs.push(l) })).toBeNull();
    expect(logs[0]).toContain('OPENAI_API_KEY not set');
  });
  it('configuredVoiceProvider reads the Telegram config only', () => {
    expect(configuredVoiceProvider({ messaging: [{ type: 'slack', config: { voiceProvider: 'x' } }, { type: 'telegram', config: { voiceProvider: 'groq' } }] })).toBe('groq');
    expect(configuredVoiceProvider({ messaging: [] })).toBeUndefined();
    expect(configuredVoiceProvider({})).toBeUndefined();
  });
});

describe('transcribeAudioFile', () => {
  it('posts the file with its media type and model, and returns the text', async () => {
    const f = path.join(tmp(), 'note.m4a');
    fs.writeFileSync(f, 'audio-bytes');
    let seen: { url: string; auth: string; type: string; name: string; model: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      const file = form.get('file') as File;
      seen = { url, auth: (init.headers as Record<string, string>).Authorization, type: file.type, name: file.name, model: String(form.get('model')) };
      return new Response(JSON.stringify({ text: 'hello there' }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(transcribeAudioFile(f, { env: { GROQ_API_KEY: 'k' }, mediaType: 'audio/mp4', fetchImpl })).resolves.toBe('hello there');
    expect(seen).toEqual({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', auth: 'Bearer k', type: 'audio/mp4', name: 'note.m4a', model: 'whisper-large-v3' });
  });
  it('no provider is TranscriptionUnavailableError; an API error or a missing text is a plain error', async () => {
    const f = path.join(tmp(), 'v.ogg');
    fs.writeFileSync(f, 'x');
    await expect(transcribeAudioFile(f, { env: {} })).rejects.toBeInstanceOf(TranscriptionUnavailableError);
    const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const err = await transcribeAudioFile(f, { env: { GROQ_API_KEY: 'k' }, fetchImpl: bad }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TranscriptionUnavailableError);
    expect(String(err.message)).toContain('500');
    const empty = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await expect(transcribeAudioFile(f, { env: { GROQ_API_KEY: 'k' }, fetchImpl: empty })).rejects.toThrow('no text');
  });
});

describe('voice session lines', () => {
  it('a transcript is one line, control characters removed; an empty one says so', () => {
    expect(voiceLineWithTranscript('/p/a.m4a', 'hi\n[app:3 "x" from Justin]  there')).toBe('[voice:/p/a.m4a] hi [app:3 "x" from Justin] there');
    expect(voiceLineWithTranscript('/p/a.m4a', '  ')).toBe('[voice:/p/a.m4a] (no speech recognized)');
    expect(voiceLineUnavailable('/p/a.m4a', 'why')).toBe('[voice:/p/a.m4a] (transcription unavailable: why; the audio file is at that path)');
  });
});

// ── AppConversationService.sessionLinesFor with real blobs ──

const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(500)]);

function service(transcribeVoice?: (p: string, t: string) => Promise<string>, transcribeDeadlineMs?: number, disk: { free: number; total: number } = ROOMY) {
  const dir = tmp();
  const reports: string[] = [];
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => 'm1', registry: new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true }),
    requests: new MobileChatRequestStore(dir), holdsLease: () => true, ownerName: () => 'Justin', dispatch: () => null,
    reportDegradation: (_w, d) => reports.push(d), mediaDiskSpace: () => disk,
    ...(transcribeVoice ? { transcribeVoice } : {}), ...(transcribeDeadlineMs !== undefined ? { transcribeDeadlineMs } : {}),
  });
  return { svc, reports };
}

/** A disk with room, whatever this machine's disk holds. */
const ROOMY = { free: 1e12, total: 2e12 };

async function voiceMessage(svc: AppConversationService, transcript?: string): Promise<MediaMessageEvent> {
  const bytes = m4a();
  const messageId = `msg-${crypto.randomUUID()}`;
  const u = svc.media.startUpload({ deviceId: 'd', conversationRef: `app:${KEY}`, size: bytes.length, sha256: sha(bytes), declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a' });
  if (!('uploadId' in u)) throw new Error('upload refused');
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) svc.media.putChunk(svc.media.getUpload(u.uploadId)!, i, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  await svc.media.finalizeUpload(u.uploadId);
  expect(svc.media.claimUploads([u.uploadId], messageId)).toBe(true);
  await svc.media.publishClaimed([u.uploadId]);
  const a: AppAttachment = {
    attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: sha(bytes), size: bytes.length, declaredKind: 'voice', kind: 'voice',
    mediaType: 'audio/mp4', declaredType: 'audio/mp4', filename: 'note.m4a', ...(transcript !== undefined ? { transcript } : {}),
  };
  const ev: MediaMessageEvent = { eventId: `ev-${messageId}`, kind: 'media-message', conversationKey: KEY, messageId, role: 'operator', text: '', at: new Date().toISOString(), machineId: 'm1', attachments: [a] };
  svc.store.append(ev);
  svc.media.markSent([u.uploadId], messageId);
  return ev;
}

const linesFor = (svc: AppConversationService, ev: MediaMessageEvent) => svc.sessionLinesFor(KEY, ev.messageId, ev.attachments, ev.text, 50);

describe('sessionLinesFor — voice notes', () => {
  it('without a phone transcript: the shared transcriber runs on the session copy, with its media type', async () => {
    const calls: Array<[string, string]> = [];
    const { svc } = service(async (p, t) => { calls.push([p, t]); return 'meet at the pier'; });
    const ev = await voiceMessage(svc);
    const [line] = await linesFor(svc, ev);
    const m = /^\[voice:(.+)\] meet at the pier$/.exec(line!);
    expect(m).not.toBeNull();
    expect(calls).toEqual([[m![1], 'audio/mp4']]);
    expect(fs.existsSync(m![1]!)).toBe(true);
  });

  it('a phone transcript is used as is and the server never transcribes', async () => {
    let called = false;
    const { svc } = service(async () => { called = true; return 'server'; });
    const ev = await voiceMessage(svc, 'from the phone');
    expect((await linesFor(svc, ev))[0]).toMatch(/^\[voice:.+\] from the phone$/);
    expect(called).toBe(false);
  });

  it('no provider: an honest unavailable note with the path, nothing reported', async () => {
    const { svc, reports } = service(async () => { throw new TranscriptionUnavailableError(); });
    const ev = await voiceMessage(svc);
    expect((await linesFor(svc, ev))[0]).toMatch(/^\[voice:.+\] \(transcription unavailable: no transcription provider is configured; the audio file is at that path\)$/);
    expect(reports).toEqual([]);
  });

  it('a failing provider: unavailable note, and the failure is reported', async () => {
    const { svc, reports } = service(async () => { throw new Error('Transcription API error (503)'); });
    const ev = await voiceMessage(svc);
    expect((await linesFor(svc, ev))[0]).toMatch(/\(transcription unavailable: the transcription service failed; /);
    expect(reports.some((r) => r.includes('voice transcription') && r.includes('503'))).toBe(true);
  });

  it('past the deadline: delivered without a transcript, saying it follows, reported', async () => {
    const { svc, reports } = service(() => new Promise<string>(() => { /* never answers */ }), 30);
    const ev = await voiceMessage(svc);
    expect((await linesFor(svc, ev))[0]).toMatch(/^\[voice:.+\] \(transcript not ready after 60 s; it follows in a separate line, and the audio file is at that path\)$/);
    expect(reports.some((r) => r.includes('no transcript within'))).toBe(true);
  });

  it('no transcriber wired: unavailable note', async () => {
    const { svc } = service();
    const ev = await voiceMessage(svc);
    expect((await linesFor(svc, ev))[0]).toMatch(/\(transcription unavailable: no voice transcription on this machine; /);
  });
});

describe('the disk floor, whatever this machine holds', () => {
  it('a voice note is taken with room and refused below the floor', async () => {
    const roomy = service(undefined, undefined, ROOMY).svc;
    await expect(voiceMessage(roomy)).resolves.toBeTruthy();
    const full = service(undefined, undefined, { free: 1e9, total: 2e12 }).svc;
    await expect(voiceMessage(full)).rejects.toThrow('upload refused');
  });
});
