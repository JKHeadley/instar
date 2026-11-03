/**
 * Server voice transcripts as their own event (docs/specs/mobile-native-chat-media.md §4.5.1,
 * increment 2 remainder; §4.1 for older peers; §4.13 for signatures):
 *  - the `transcript` event kind, its validator, the replicated envelope, and an older peer that
 *    refuses (and counts) the kind;
 *  - the store's one-winner-per-attachment index, independent of arrival order;
 *  - the service: scrub + scan before storing, one transcription per attachment (never retried),
 *    late transcripts (stored `late`, one follow-up line or a note for the next delivery),
 *    platform conversations (stored, no follow-up promised), and notes that arrive after dispatch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AppConversationService, scrubServerTranscript, lateTranscriptLine, transcriptOneLine, voiceLinePending, transcriptForDelivery, VOICE_TRANSCRIBE_CONCURRENCY,
} from '../../src/core/AppConversationService.js';
import { AppConversationStore, MAX_STORED_TEXT, transcriptEventId, validateAppEvent, type MediaMessageEvent, type TranscriptEvent } from '../../src/core/AppConversationStore.js';
import { appConversationRecordStoreSchema, appEventFromReplicatedData, buildAppConversationRecordData } from '../../src/core/AppConversationsReplicatedStore.js';
import { validateReplicatedEnvelope, type StoreFieldSchema } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { TranscriptionUnavailableError } from '../../src/core/VoiceTranscription.js';
import { attachmentIdFor, CHUNK_BYTES, MAX_TRANSCRIPT_CHARS, type AppAttachment } from '../../src/core/appMediaTypes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-voice-transcript-event.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vtev-')); dirs.push(d); return d; };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const KEY = '33333333-3333-4333-8333-333333333333';
const AID = 'a'.repeat(64);
const INVITE = () => `tlinv1:${crypto.randomBytes(12).toString('base64url')}.${crypto.randomBytes(12).toString('base64url')}`;

const transcript = (over: Record<string, unknown> = {}) => ({
  eventId: 'tr-1', kind: 'transcript', conversationKey: KEY, messageId: 'msg-1', attachmentId: AID, text: 'hello',
  provider: 'groq', at: '2026-11-03T00:00:00.000Z', machineId: 'm1', ...over,
});

// ── The event kind ──────────────────────────────────────────────────────────────────

describe('the transcript event', () => {
  it('validates, with an empty text and a late marker allowed', () => {
    expect(validateAppEvent(transcript())).toEqual(transcript());
    expect(validateAppEvent(transcript({ text: '' }))).toMatchObject({ kind: 'transcript', text: '' });
    expect(validateAppEvent(transcript({ late: true }))).toMatchObject({ late: true });
  });
  it.each([
    ['no message id', { messageId: undefined }],
    ['a malformed attachment id', { attachmentId: 'xyz' }],
    ['no provider', { provider: undefined }],
    ['a provider with spaces', { provider: 'Groq Cloud' }],
    ['late: false (only true is a marker)', { late: false }],
    ['text over the store limit', { text: 'x'.repeat(MAX_STORED_TEXT + 1) }],
    ['a non-string text', { text: 7 }],
  ])('refuses %s', (_n, over) => {
    expect(validateAppEvent(transcript(over))).toBeNull();
  });
  it('a transcript is never read as a message (no text-only fallback)', () => {
    expect(validateAppEvent({ ...transcript(), kind: 'message' })).toBeNull(); // no role ⇒ not a message either
  });
  it('round-trips through the replicated envelope with nothing dropped', () => {
    for (const ev of [validateAppEvent(transcript())!, validateAppEvent(transcript({ late: true }))!]) {
      const data = buildAppConversationRecordData(ev)({ physical: 1, logical: 0, node: 'n' } as never, 'm1')!;
      for (const k of Object.keys(data)) {
        if (['recordKey', 'hlc', 'op', 'origin', 'observed'].includes(k)) continue;
        expect(appConversationRecordStoreSchema.knownFields, k).toContain(k);
      }
      expect(appEventFromReplicatedData(data)).toEqual(ev);
    }
  });
  it('§4.1: an older peer (whose validator has no transcript case) refuses the record and counts it; the current one accepts it', () => {
    const data = buildAppConversationRecordData(validateAppEvent(transcript())!)({ physical: Date.now(), logical: 0, node: 'm1' } as never, 'm1')!;
    // An older build's validator: identical except that `transcript` falls into its default case.
    const olderSchema: StoreFieldSchema = {
      knownFields: appConversationRecordStoreSchema.knownFields.filter((k) => !['attachmentId', 'provider', 'late'].includes(k)),
      validate: (raw, ctx) => (raw.eventKind === 'transcript' ? null : appConversationRecordStoreSchema.validate(raw, ctx)),
    };
    const counts = { schema: 0, dropped: 0, jail: 0 };
    const counters = { bumpSchemaReject: () => { counts.schema++; }, bumpDroppedField: () => { counts.dropped++; }, bumpJailReject: () => { counts.jail++; } } as never;
    expect(validateReplicatedEnvelope(data, olderSchema, counters)).toMatchObject({ ok: false, reason: 'store-schema-rejected' });
    expect(counts.schema).toBe(1);
    expect(validateReplicatedEnvelope(data, appConversationRecordStoreSchema, counters)).toMatchObject({ ok: true });
    expect(counts.schema).toBe(1);
  });
});

// ── The store index ─────────────────────────────────────────────────────────────────

describe('the store keeps one transcript per attachment', () => {
  const twoMachines = () => [
    validateAppEvent(transcript({ eventId: transcriptEventId(AID, 'm2'), machineId: 'm2', text: 'from m2', at: '2026-11-03T00:00:05.000Z' }))!,
    validateAppEvent(transcript({ eventId: transcriptEventId(AID, 'm1'), machineId: 'm1', text: 'from m1', at: '2026-11-03T00:00:01.000Z' }))!,
  ];
  it.each([['in order', false], ['reversed', true]])('the earliest wins whatever the arrival order (%s)', (_n, reverse) => {
    const store = new AppConversationStore({ stateDir: tmp(), machineId: () => 'm3' });
    const evs = twoMachines();
    for (const ev of reverse ? evs.reverse() : evs) store.ingestReplicated(ev);
    expect(store.transcriptFor(AID)?.text).toBe('from m1');
    store.close();
  });
  it('is not a chat message, survives an index rebuild, and an unknown attachment has none', () => {
    const store = new AppConversationStore({ stateDir: tmp(), machineId: () => 'm1' });
    store.append(validateAppEvent(transcript())!);
    expect(store.browseMessages(KEY, null).messages).toEqual([]);
    expect(store.hasMessage('msg-1')).toBe(false);
    store.rebuildIndex();
    expect(store.transcriptFor(AID)).toMatchObject({ kind: 'transcript', text: 'hello', provider: 'groq' });
    expect(store.transcriptFor('b'.repeat(64))).toBeNull();
    store.close();
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────────────

describe('scrubbing and lines', () => {
  it('runs the scan on the raw text first, then removes invites and desktop lines', () => {
    const scanned: string[] = [];
    const inv = INVITE();
    const out = scrubServerTranscript(`join with ${inv}\n/desktop 12 345678\nthanks`, (t) => scanned.push(t));
    expect(scanned[0]).toContain(inv);
    expect(out.text).toBe('join with [pairing invite removed]\n[desktop code removed]\nthanks');
    expect(out.kinds.sort()).toEqual(['desktop-code', 'pairing-invite']);
  });
  it('a clean transcript is unchanged; a scan that throws never stops the removal', () => {
    expect(scrubServerTranscript('just words', null)).toEqual({ text: 'just words', kinds: [] });
    expect(scrubServerTranscript(`x ${INVITE()}`, () => { throw new Error('boom'); }).text).toBe('x [pairing invite removed]');
  });
  it('text past the store limit is cut with a note, never refused, and still validates', () => {
    const out = scrubServerTranscript('w'.repeat(MAX_STORED_TEXT + 500), null).text;
    expect(out.length).toBeLessThanOrEqual(MAX_STORED_TEXT);
    expect(out).toMatch(/transcript cut here; the audio file has the rest\)$/);
    expect(validateAppEvent(transcript({ text: out }))).not.toBeNull();
  });
  it('a session line over 4000 characters says the full transcript is saved', () => {
    expect(transcriptOneLine('a b')).toBe('a b');
    expect(transcriptOneLine('x'.repeat(MAX_TRANSCRIPT_CHARS + 1))).toMatch(/full transcript is saved with the message\)$/);
  });
  it('pending and late lines are honest on both sides', () => {
    expect(voiceLinePending('/p', true)).toContain('it follows in a separate line');
    expect(voiceLinePending('/p', false)).toContain('saved with the message if it finishes');
    expect(lateTranscriptLine('/p', { ok: true, text: 'hi' }, 'cap')).toBe('[voice transcript ready: /p] (for the message "cap") hi');
    expect(lateTranscriptLine('/p', { ok: false, reason: 'the transcription service failed' }, '')).toBe('[voice transcript unavailable: /p] (transcription unavailable: the transcription service failed; the audio file is at that path)');
  });
});

// ── The service, with real blobs ────────────────────────────────────────────────────

const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), crypto.randomBytes(400)]);

interface Opts { transcribe?: (p: string, t: string, timeoutMs?: number) => Promise<string>; deadlineMs?: number; dir?: string; machineId?: string; concurrency?: number; ceilingMs?: number }
function service(o: Opts = {}) {
  const dir = o.dir ?? tmp();
  const m = o.machineId ?? 'm1';
  const reports: string[] = [];
  const followUps: Array<[number, string]> = [];
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => m, isRecordingEnabled: () => true });
  const svc = new AppConversationService({
    stateDir: dir, machineId: () => m, registry, requests: new MobileChatRequestStore(dir), holdsLease: () => true,
    ownerName: () => 'Justin', dispatch: () => null, reportDegradation: (_w, d) => reports.push(d),
    ...(o.transcribe ? { transcribeVoice: o.transcribe } : {}), ...(o.deadlineMs !== undefined ? { transcribeDeadlineMs: o.deadlineMs } : {}),
    ...(o.concurrency !== undefined ? { transcribeConcurrency: o.concurrency } : {}), ...(o.ceilingMs !== undefined ? { transcribeCeilingMs: o.ceilingMs } : {}),
    voiceProviderName: () => 'groq',
  });
  let followUpOk = true;
  svc.setFollowUp((alias, line) => { followUps.push([alias, line]); return followUpOk; });
  const scanned: string[] = [];
  svc.setInboundScan((t) => scanned.push(t));
  return { svc, reports, followUps, scanned, dir, setFollowUpOk: (v: boolean) => { followUpOk = v; } };
}

async function voiceMessage(svc: AppConversationService, opts: { key?: string; caption?: string; append?: boolean; bytes?: Buffer } = {}): Promise<MediaMessageEvent> {
  const key = opts.key ?? KEY;
  const bytes = opts.bytes ?? m4a();
  const messageId = `msg-${crypto.randomUUID()}`;
  if (key === KEY && !svc.store.getConversation(KEY)) {
    svc.store.append({ eventId: `cr-${KEY}`, kind: 'created', conversationKey: KEY, title: 'Trip', at: new Date().toISOString(), machineId: 'm1' });
    svc.reconcileAliases();
    svc.deps.registry.bindApp(svc.deps.registry.appAliasFor(KEY)!); // this machine owns it
  }
  const u = svc.media.startUpload({ deviceId: 'd', conversationRef: key.includes(':') ? key : `app:${key}`, size: bytes.length, sha256: sha(bytes), declaredKind: 'voice', declaredType: 'audio/mp4', filename: 'note.m4a' });
  if (!('uploadId' in u)) throw new Error(`upload refused: ${JSON.stringify(u)}`);
  for (let i = 0; i * CHUNK_BYTES < bytes.length; i++) svc.media.putChunk(svc.media.getUpload(u.uploadId)!, i, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
  await svc.media.finalizeUpload(u.uploadId);
  expect(svc.media.claimUploads([u.uploadId], messageId)).toBe(true);
  await svc.media.publishClaimed([u.uploadId]);
  const a: AppAttachment = {
    attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: sha(bytes), size: bytes.length, declaredKind: 'voice', kind: 'voice',
    mediaType: 'audio/mp4', declaredType: 'audio/mp4', filename: 'note.m4a',
  };
  const ev: MediaMessageEvent = { eventId: `ev-${messageId}`, kind: 'media-message', conversationKey: key, messageId, role: 'operator', text: opts.caption ?? '', at: new Date().toISOString(), machineId: 'm1', attachments: [a] };
  svc.store.append(ev);
  svc.media.markSent([u.uploadId], messageId);
  return ev;
}

const lines = (svc: AppConversationService, ev: MediaMessageEvent) => svc.sessionLinesFor(ev.conversationKey, ev.messageId, ev.attachments, ev.text, 50);
// Waits after a slow (50-60 ms) fake transcription are generous: the suite runs under full-suite load,
// where a 100 ms wait was not always enough (seen on a peer verifier, 2026-11-03).
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('storing the server transcript', () => {
  it('stores a scrubbed, unsigned transcript event with the provider; the session line carries the scrubbed text', async () => {
    const inv = INVITE();
    const { svc, scanned } = service({ transcribe: async () => `pair with ${inv} now` });
    const ev = await voiceMessage(svc);
    const [line] = await lines(svc, ev);
    expect(line).toMatch(/^\[voice:.+\] pair with \[pairing invite removed\] now$/);
    expect(scanned.some((t) => t.includes(inv))).toBe(true);
    const stored = svc.store.transcriptFor(ev.attachments[0]!.attachmentId)!;
    expect(stored).toMatchObject({ kind: 'transcript', messageId: ev.messageId, text: 'pair with [pairing invite removed] now', provider: 'groq', machineId: 'm1' });
    expect(stored.late).toBeUndefined();
    expect(stored.eventId).toBe(transcriptEventId(ev.attachments[0]!.attachmentId, 'm1'));
    // The signed media-message is untouched: no transcript was written into it.
    expect((svc.store.getMessageEvent(KEY, ev.messageId) as MediaMessageEvent).attachments[0]!.transcript).toBeUndefined();
  });

  it('one transcription per attachment: a second delivery reuses the stored transcript', async () => {
    let calls = 0;
    const { svc } = service({ transcribe: async () => { calls++; return 'once'; } });
    const ev = await voiceMessage(svc);
    await lines(svc, ev);
    expect((await lines(svc, ev))[0]).toMatch(/\] once$/);
    expect(calls).toBe(1);
  });

  it('a failure is recorded with its reason and never retried', async () => {
    let calls = 0;
    const { svc, reports } = service({ transcribe: async () => { calls++; throw new Error('Transcription API error (503)'); } });
    const ev = await voiceMessage(svc);
    expect((await lines(svc, ev))[0]).toMatch(/\(transcription unavailable: the transcription service failed; /);
    expect((await lines(svc, ev))[0]).toMatch(/\(transcription unavailable: the transcription service failed; /);
    expect(calls).toBe(1);
    expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)).toBeNull();
    expect(reports.filter((r) => r.includes('503'))).toHaveLength(1);
  });

  it('no provider: honest line, nothing stored, nothing retried', async () => {
    let calls = 0;
    const { svc } = service({ transcribe: async () => { calls++; throw new TranscriptionUnavailableError(); } });
    const ev = await voiceMessage(svc);
    await lines(svc, ev);
    expect((await lines(svc, ev))[0]).toMatch(/no transcription provider is configured/);
    expect(calls).toBe(1);
  });

  it('a run a restart interrupted reads as a failure on the next machine start, never re-run', async () => {
    const dir = tmp();
    const first = service({ dir, transcribe: () => new Promise<string>(() => { /* still running when the process dies */ }), deadlineMs: 20 });
    const ev = await voiceMessage(first.svc);
    await lines(first.svc, ev);
    first.svc.stop();
    let calls = 0;
    const second = service({ dir, transcribe: async () => { calls++; return 'too late'; } });
    expect((await second.svc.sessionLinesFor(KEY, ev.messageId, ev.attachments, '', 50))[0]).toMatch(/\(transcription unavailable: the server restarted before the transcript finished; /);
    expect(calls).toBe(0);
  });

  it('a transcript a peer already made is used here without transcribing', async () => {
    let calls = 0;
    const { svc } = service({ transcribe: async () => { calls++; return 'local'; } });
    const ev = await voiceMessage(svc);
    const aid = ev.attachments[0]!.attachmentId;
    svc.ingestReplicated([validateAppEvent(transcript({ eventId: transcriptEventId(aid, 'm2'), machineId: 'm2', messageId: ev.messageId, attachmentId: aid, text: 'from the peer' }))]);
    expect((await lines(svc, ev))[0]).toMatch(/\] from the peer$/);
    expect(calls).toBe(0);
  });

  it('a phone transcript is never replaced: the server neither transcribes nor stores', async () => {
    let calls = 0;
    const { svc } = service({ transcribe: async () => { calls++; return 'server'; } });
    const ev = await voiceMessage(svc);
    const withPhone = ev.attachments.map((a) => ({ ...a, transcript: 'from the phone' }));
    expect((await svc.sessionLinesFor(KEY, ev.messageId, withPhone, '', 50))[0]).toMatch(/\] from the phone$/);
    expect(calls).toBe(0);
    expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)).toBeNull();
  });
});

describe('late transcripts', () => {
  const slow = (text: string, ms = 60) => () => new Promise<string>((r) => setTimeout(() => r(text), ms));

  it('past the deadline: stored as late, and exactly one follow-up line reaches the live session', async () => {
    const { svc, followUps } = service({ transcribe: slow('arrived late'), deadlineMs: 15 });
    const ev = await voiceMessage(svc, { caption: 'listen' });
    const [line] = await lines(svc, ev);
    expect(line).toContain('transcript not ready after 60 s; it follows in a separate line');
    expect(followUps).toEqual([]);
    await settle(600);
    const stored = svc.store.transcriptFor(ev.attachments[0]!.attachmentId)!;
    expect(stored).toMatchObject({ text: 'arrived late', late: true });
    expect(followUps).toHaveLength(1);
    expect(followUps[0]![1]).toMatch(/^\[app:-?\d+ "Trip" from Justin\] \[voice transcript ready: .+\] \(for the message "listen"\) arrived late$/);
    // A later delivery uses the stored transcript and sends no second follow-up.
    expect((await lines(svc, ev))[0]).toMatch(/\] arrived late$/);
    await settle(30);
    expect(followUps).toHaveLength(1);
  });

  it('a late failure is a follow-up too, never silence', async () => {
    const { svc, followUps } = service({ transcribe: () => new Promise<string>((_r, rej) => setTimeout(() => rej(new Error('API error (500)')), 50)), deadlineMs: 10 });
    const ev = await voiceMessage(svc);
    await lines(svc, ev);
    await settle(600);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]![1]).toContain('[voice transcript unavailable: ');
    expect(followUps[0]![1]).toContain('(transcription unavailable: the transcription service failed;');
  });

  it('with no live session the late line waits for the next delivery, once', async () => {
    const { svc, setFollowUpOk } = service({ transcribe: slow('for later'), deadlineMs: 10 });
    setFollowUpOk(false);
    const ev = await voiceMessage(svc);
    await lines(svc, ev);
    await settle(600);
    const ctx = svc.pendingContext(KEY);
    expect(ctx.lines.some((l) => /^\[voice transcript ready: .+\] for later$/.test(l))).toBe(true);
    ctx.ack();
    expect(svc.pendingContext(KEY).lines).toEqual([]);
  });

  it('a Telegram conversation continued from the app: stored, and the line promises no follow-up', async () => {
    const { svc, followUps } = service({ transcribe: slow('platform words'), deadlineMs: 10 });
    const ev = await voiceMessage(svc, { key: 'telegram:4242' });
    const [line] = await lines(svc, ev);
    expect(line).toContain('saved with the message if it finishes');
    await settle(600);
    expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)).toMatchObject({ conversationKey: 'telegram:4242', text: 'platform words', late: true });
    expect(followUps).toEqual([]);
    expect(svc.pendingContext('telegram:4242').lines).toEqual([]);
  });

  it('two deliveries racing one slow transcription start the provider once and send one follow-up', async () => {
    let calls = 0;
    const { svc, followUps } = service({ transcribe: () => { calls++; return slow('shared', 60)(); }, deadlineMs: 10 });
    const ev = await voiceMessage(svc);
    await Promise.all([lines(svc, ev), lines(svc, ev)]);
    await settle(600);
    expect(calls).toBe(1);
    expect(followUps).toHaveLength(1);
  });
});

describe('notes that arrive after dispatch ([file now available])', () => {
  it('a voice note that lands later is transcribed then, and the transcript rides on the "now available" line', async () => {
    let calls = 0;
    const { svc, followUps } = service({ transcribe: async () => { calls++; return 'heard after landing'; } });
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes, caption: 'later' });
    // Simulate the owner not holding the blob at dispatch: a waiting pending-delivery row.
    svc.media.indexDb.prepare(`INSERT INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL)`)
      .run(ev.attachments[0]!.attachmentId, ev.messageId, KEY, sha(bytes), 'note.m4a', 'later', Date.now());
    await svc.resolvePending(sha(bytes));
    expect(calls).toBe(1);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]![1]).toMatch(/\[file now available: .+\] \(for the message "later"\) heard after landing$/);
    expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)?.text).toBe('heard after landing');
  });

  it('a "now available" line kept for the next delivery carries the stored transcript', async () => {
    const { svc, setFollowUpOk } = service({ transcribe: async () => 'kept words' });
    setFollowUpOk(false);
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes });
    svc.media.indexDb.prepare(`INSERT INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL)`)
      .run(ev.attachments[0]!.attachmentId, ev.messageId, KEY, sha(bytes), 'note.m4a', '', Date.now());
    await svc.resolvePending(sha(bytes));
    expect(svc.pendingContext(KEY).lines.some((l) => /^\[file now available: .+\] kept words$/.test(l))).toBe(true);
  });

  it('a photo that lands later is not transcribed', async () => {
    let calls = 0;
    const { svc } = service({ transcribe: async () => { calls++; return 'x'; } });
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes });
    const photoLike = ev.attachments.map((a) => ({ ...a, kind: 'file' as const, declaredKind: 'file' as const }));
    await svc.sessionLinesFor(KEY, ev.messageId, photoLike, '', 50);
    expect(calls).toBe(0);
  });
});

describe('signatures', () => {
  it('the server transcript lives outside the signed record: the verdict input is unchanged', async () => {
    const { svc } = service({ transcribe: async () => 'words' });
    const ev = await voiceMessage(svc);
    const before = JSON.stringify(svc.store.getMessageEvent(KEY, ev.messageId));
    await lines(svc, ev);
    const after = svc.store.getMessageEvent(KEY, ev.messageId);
    expect(JSON.stringify(after)).toBe(before);
    expect((svc.store.transcriptFor(ev.attachments[0]!.attachmentId) as TranscriptEvent & { origin?: unknown }).origin).toBeUndefined();
  });
});

// ── Second-pass review findings ─────────────────────────────────────────────────────

describe('finding 1: a per-process limit on provider calls', () => {
  it(`fires 8 voice notes at once: at most ${VOICE_TRANSCRIBE_CONCURRENCY} provider calls run together, and every one settles`, async () => {
    let running = 0;
    let peak = 0;
    let calls = 0;
    const { svc } = service({
      deadlineMs: 5_000,
      transcribe: async () => {
        calls++; running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 25));
        running--;
        return `note ${calls}`;
      },
    });
    const evs: MediaMessageEvent[] = [];
    for (let i = 0; i < 8; i++) evs.push(await voiceMessage(svc));
    const all = await Promise.all(evs.map((ev) => lines(svc, ev)));
    expect(calls).toBe(8);
    expect(peak).toBe(VOICE_TRANSCRIBE_CONCURRENCY);
    expect(running).toBe(0);
    for (const [line] of all) expect(line).toMatch(/^\[voice:.+\] note \d+$/);
    for (const ev of evs) expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)).not.toBeNull();
  });

  it('queue time counts toward the ceiling: a call still queued ends "timed out waiting"; a running one past it times out; both settle', async () => {
    const timeouts: Array<number | undefined> = [];
    const { svc } = service({
      concurrency: 1, ceilingMs: 60, deadlineMs: 2_000,
      transcribe: (_p, _t, timeoutMs) => { timeouts.push(timeoutMs); return new Promise((r) => setTimeout(() => r('too slow'), 150)); },
    });
    const first = await voiceMessage(svc);
    const second = await voiceMessage(svc);
    const [[a], [b]] = await Promise.all([lines(svc, first), lines(svc, second)]);
    // Which of the two reaches the one slot first is a race (seen on a loaded peer verifier,
    // 2026-11-03): exactly one ran and timed out, the other waited and timed out waiting.
    const ran = [a, b].filter((l) => /\(transcription unavailable: the transcription service timed out; /.test(l!));
    const waited = [a, b].filter((l) => /\(transcription unavailable: timed out waiting; /.test(l!));
    expect(ran).toHaveLength(1);
    expect(waited).toHaveLength(1);
    expect(timeouts).toHaveLength(1); // the queued call never reached the provider
    expect(timeouts[0]!).toBeLessThanOrEqual(60);
    // Recorded, never retried.
    const queued = waited[0] === a ? first : second;
    expect((await lines(svc, queued))[0]).toMatch(/timed out waiting/);
    await settle(150);
    expect(timeouts).toHaveLength(1);
  });
});

describe('finding 2: a peer transcript is scrubbed on read', () => {
  const peerTranscript = (svc: AppConversationService, ev: MediaMessageEvent, text: string) => {
    const aid = ev.attachments[0]!.attachmentId;
    svc.ingestReplicated([validateAppEvent(transcript({ eventId: transcriptEventId(aid, 'peer'), machineId: 'peer', messageId: ev.messageId, attachmentId: aid, text }))]);
  };

  it('a peer that skipped the scrub cannot hand an invite or a desktop code to a session', async () => {
    const inv = INVITE();
    const { svc, setFollowUpOk } = service({ transcribe: async () => 'unused' });
    setFollowUpOk(false);
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes });
    peerTranscript(svc, ev, `pair with ${inv}\n/desktop 12 345678\nbye`);
    expect(svc.store.transcriptFor(ev.attachments[0]!.attachmentId)!.text).toContain(inv); // stored as the peer wrote it
    // The dispatch line.
    const [line] = await lines(svc, ev);
    expect(line).not.toContain('tlinv1:');
    expect(line).not.toContain('/desktop');
    expect(line).toContain('[pairing invite removed]');
    // The "now available" line kept for the next delivery.
    svc.media.indexDb.prepare(`INSERT INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`)
      .run(ev.attachments[0]!.attachmentId, ev.messageId, KEY, sha(bytes), 'note.m4a', '', Date.now(), '/p/note.m4a');
    const ctx = svc.pendingContext(KEY).lines.join('\n');
    expect(ctx).toContain('[pairing invite removed]');
    expect(ctx).not.toContain('tlinv1:');
  });

  it('the late line and the delivery helper remove tokens on both sides of the rule', () => {
    const inv = INVITE();
    expect(lateTranscriptLine('/p', { ok: true, text: `use ${inv}` }, '')).toBe('[voice transcript ready: /p] use [pairing invite removed]');
    expect(transcriptForDelivery(`a\n/desktop 1 2\nb ${inv}`)).toBe('a\n[desktop code removed]\nb [pairing invite removed]');
    expect(transcriptForDelivery('nothing to remove here')).toBe('nothing to remove here');
  });
});

describe('finding 3: a transcript reaches the session once', () => {
  const waitingRow = (svc: AppConversationService, ev: MediaMessageEvent, bytes: Buffer) =>
    svc.media.indexDb.prepare(`INSERT INTO pending_deliveries (attachmentId, messageId, conversationKey, sha256, displayName, caption, createdAt, state, path) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL)`)
      .run(ev.attachments[0]!.attachmentId, ev.messageId, KEY, sha(bytes), 'note.m4a', '', Date.now());

  it('no live session: the "now available" line carries the late transcript, and no separate note repeats it', async () => {
    const { svc, setFollowUpOk } = service({ transcribe: () => new Promise((r) => setTimeout(() => r('said once'), 50)), deadlineMs: 10 });
    setFollowUpOk(false);
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes });
    waitingRow(svc, ev, bytes);
    await svc.resolvePending(sha(bytes));
    await settle(600);
    const ctx = svc.pendingContext(KEY).lines;
    expect(ctx.filter((l) => l.includes('said once'))).toHaveLength(1);
    expect(ctx.some((l) => l.startsWith('[file now available: ') && l.endsWith('said once'))).toBe(true);
    expect(svc.media.indexDb.prepare('SELECT COUNT(*) AS c FROM transcript_notes').get()).toEqual({ c: 0 });
  });

  it('the reverse: the late line reached a live session, so the "now available" line kept for later does not repeat it', async () => {
    const { svc, followUps, setFollowUpOk } = service({ transcribe: () => new Promise((r) => setTimeout(() => r('only in the late line'), 50)), deadlineMs: 10 });
    setFollowUpOk(false);
    const bytes = m4a();
    const ev = await voiceMessage(svc, { bytes });
    waitingRow(svc, ev, bytes);
    await svc.resolvePending(sha(bytes)); // no live session: the row stays for the next delivery
    setFollowUpOk(true); // a session is live when the late transcript lands
    await settle(600);
    expect(followUps.filter(([, l]) => l.includes('only in the late line'))).toHaveLength(1);
    const ctx = svc.pendingContext(KEY).lines;
    expect(ctx.some((l) => l.startsWith('[file now available: '))).toBe(true);
    expect(ctx.filter((l) => l.includes('only in the late line'))).toHaveLength(0);
  });
});
