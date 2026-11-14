/**
 * Telegram media in the app's history (docs/specs/mobile-native-chat-media.md §4.9, Telegram half):
 * the `platform-media` event kind (validator, index, replication wire, idempotency, never a chat
 * message), the copy into the blob store through the reply-files admission, the device text with no
 * server path, and the TelegramAdapter hook (a voice note is copied before its download is deleted;
 * a failing hook never stops delivery).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, platformMediaMessageId, validateAppEvent, type AppEvent } from '../../src/core/AppConversationStore.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';
import { appEventFromReplicatedData, buildAppConversationRecordData } from '../../src/core/AppConversationsReplicatedStore.js';
import { attachmentIdFor } from '../../src/core/appMediaTypes.js';
import { deviceTextForRow, recordPlatformMedia } from '../../src/core/appPlatformMedia.js';
import type { AppConversationService } from '../../src/core/AppConversationService.js';
import { TelegramAdapter, type TelegramInboundMedia } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-platform-media.test.ts' }); });

const TKEY = 'telegram:4242';
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const jpeg = (n = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);

function pmEvent(pmid = '77', over: Record<string, unknown> = {}): AppEvent {
  const messageId = platformMediaMessageId(TKEY, pmid);
  return {
    eventId: messageId, kind: 'platform-media', conversationKey: TKEY, messageId, platformMessageId: pmid,
    attachments: [{ attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: 'a'.repeat(64), size: 1000, declaredKind: 'photo', kind: 'photo', mediaType: 'image/jpeg', declaredType: 'image/jpeg', filename: 'photo.jpg' }],
    at: new Date().toISOString(), machineId: 'm1', ...over,
  } as AppEvent;
}

function setup(opts: { max?: number; free?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmedia-'));
  dirs.push(dir);
  const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
  const media = new AppMediaStore({ stateDir: dir, store, maxStoreBytes: () => opts.max ?? 1e9, diskSpace: () => ({ free: opts.free ?? 1e12, total: 2e12 }) });
  const svc = { store, media, deps: { machineId: () => 'm1' } } as unknown as AppConversationService;
  const file = (name: string, bytes: Buffer) => { const p = path.join(dir, 'telegram-images', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  return { dir, store, media, svc, file };
}

describe('platform-media validator', () => {
  it('accepts a well-formed event and refuses an app key, a mismatched event id, or a bad platform id', () => {
    expect(validateAppEvent(pmEvent())).toMatchObject({ kind: 'platform-media', platformMessageId: '77' });
    expect(validateAppEvent(pmEvent('77', { conversationKey: '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab' }))).toBeNull();
    expect(validateAppEvent(pmEvent('77', { eventId: 'other-id' }))).toBeNull();
    expect(validateAppEvent(pmEvent('77', { platformMessageId: 'has space' }))).toBeNull();
    expect(validateAppEvent(pmEvent('77', { attachments: [] }))).toBeNull();
  });

  it('round-trips through the replicated wire with platformMessageId kept', () => {
    const ev = pmEvent('88');
    const data = buildAppConversationRecordData(ev)({ wall: 1, logical: 0, node: 'm1' } as never, 'm1');
    expect(data).not.toBeNull();
    expect(appEventFromReplicatedData(data!)).toMatchObject({ kind: 'platform-media', platformMessageId: '88', messageId: ev.eventId });
  });
});

describe('platform-media in the store', () => {
  it('indexes the reference (downloads and capacity) but is never a chat message; appends once', () => {
    const { store } = setup();
    const ev = pmEvent();
    expect(store.append(ev).appended).toBe(true);
    expect(store.append(ev).appended).toBe(false);
    expect(store.mediaRefInConversation(TKEY, 'a'.repeat(64))).toMatchObject({ canonicalKey: TKEY, idx: 0 });
    expect(store.mediaLiveBytes()).toBe(1000);
    expect(store.browseMessages(TKEY, null).messages).toEqual([]);
    expect(store.getConversation(TKEY)?.lastPreview ?? null).toBeNull();
    expect(store.getPlatformMedia(TKEY, '77')?.attachments[0]?.filename).toBe('photo.jpg');
    expect(store.getPlatformMedia(TKEY, '78')).toBeNull();
    const ref = store.mediaRefInConversation(TKEY, 'a'.repeat(64))!;
    expect(store.getMediaAttachments(TKEY, ref.messageId)?.[0]?.sha256).toBe('a'.repeat(64));
    // The same hash in another topic is not a reference there.
    expect(store.mediaRefInConversation('telegram:1', 'a'.repeat(64))).toBeNull();
  });

  it('survives an index rebuild from the files', () => {
    const { store } = setup();
    store.append(pmEvent());
    store.rebuildIndex();
    expect(store.mediaRefInConversation(TKEY, 'a'.repeat(64))).not.toBeNull();
    expect(store.mediaLiveBytes()).toBe(1000);
  });
});

describe('recordPlatformMedia', () => {
  it('publishes the blob, then the event, with the sniffed type; a repeat is a duplicate', async () => {
    const e = setup();
    const bytes = jpeg();
    const p = e.file('photo-1-77.jpg', bytes);
    const r = await recordPlatformMedia(e.svc, { conversationKey: TKEY, platformMessageId: '77', filePath: p, declaredKind: 'photo', filename: 'photo-1-77.jpg', declaredType: 'image/jpeg', at: new Date().toISOString(), width: 10, height: 20 });
    expect(r).toMatchObject({ recorded: true, sha256: sha(bytes) });
    expect(e.media.locateBlob(sha(bytes))).not.toBeNull();
    const pm = e.store.getPlatformMedia(TKEY, '77')!;
    expect(pm.attachments[0]).toMatchObject({ kind: 'photo', mediaType: 'image/jpeg', size: bytes.length, width: 10, height: 20 });
    expect(e.media.reservedBytes()).toBe(0);
    const again = await recordPlatformMedia(e.svc, { conversationKey: TKEY, platformMessageId: '77', filePath: p, declaredKind: 'photo', filename: 'x', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(again).toMatchObject({ recorded: false, reason: 'duplicate' });
  });

  it('a declared photo whose bytes are not an image is kept as a file', async () => {
    const e = setup();
    const p = e.file('fake.jpg', Buffer.from('<html>not an image</html>'));
    await recordPlatformMedia(e.svc, { conversationKey: TKEY, platformMessageId: '5', filePath: p, declaredKind: 'photo', filename: 'fake.jpg', declaredType: 'image/jpeg', at: new Date().toISOString() });
    expect(e.store.getPlatformMedia(TKEY, '5')!.attachments[0]).toMatchObject({ declaredKind: 'photo', kind: 'file', mediaType: 'application/octet-stream' });
  });

  it('refuses below the disk floor and over the store cap, recording nothing and holding nothing', async () => {
    const floor = setup({ free: 1 });
    const p1 = floor.file('a.jpg', jpeg());
    expect(await recordPlatformMedia(floor.svc, { conversationKey: TKEY, platformMessageId: '1', filePath: p1, declaredKind: 'photo', filename: 'a.jpg', declaredType: 'image/jpeg', at: '' })).toMatchObject({ recorded: false, reason: 'media-disk-floor' });
    expect(floor.store.getPlatformMedia(TKEY, '1')).toBeNull();
    const full = setup({ max: 10 });
    const p2 = full.file('b.jpg', jpeg());
    expect(await recordPlatformMedia(full.svc, { conversationKey: TKEY, platformMessageId: '2', filePath: p2, declaredKind: 'photo', filename: 'b.jpg', declaredType: 'image/jpeg', at: '' })).toMatchObject({ recorded: false, reason: 'media-store-full' });
    expect(full.media.reservedBytes()).toBe(0);
  });

  it('refuses a non-platform key and a missing file without throwing', async () => {
    const e = setup();
    expect(await recordPlatformMedia(e.svc, { conversationKey: '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab', platformMessageId: '1', filePath: '/x', declaredKind: 'file', filename: 'x', declaredType: 'x', at: '' })).toMatchObject({ recorded: false, reason: 'bad-conversation' });
    expect(await recordPlatformMedia(e.svc, { conversationKey: TKEY, platformMessageId: '1', filePath: path.join(e.dir, 'gone.jpg'), declaredKind: 'file', filename: 'x', declaredType: 'x', at: '' })).toMatchObject({ recorded: false, reason: 'file-not-found' });
  });
});

describe('deviceTextForRow', () => {
  it('replaces every server path', () => {
    expect(deviceTextForRow('[image:/Users/me/.instar/telegram-images/photo-1-2.jpg] look')).toBe('[photo] look');
    expect(deviceTextForRow('[document:/Users/me/.instar/telegram-documents/1761999999999-report.pdf] here')).toBe('[file: report.pdf] here');
    expect(deviceTextForRow('[document:/x/1761999999999-a_b.pdf]', [{ declaredKind: 'file', filename: 'My Report.pdf' } as never])).toBe('[file: My Report.pdf]');
    expect(deviceTextForRow('[voice:/tmp/v.ogg] hi')).toBe('[voice note] hi');
    expect(deviceTextForRow('[voice] a transcript')).toBe('[voice] a transcript');
    expect(deviceTextForRow('plain text')).toBe('plain text');
  });
});

describe('TelegramAdapter inbound media hook', () => {
  function adapter() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmedia-tg-'));
    dirs.push(dir);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) })));
    const a = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', pollIntervalMs: 100 }, dir);
    const bytes = jpeg();
    (a as unknown as { downloadFile: (id: string, dest: string) => Promise<void> }).downloadFile = async (_id, dest) => { fs.writeFileSync(dest, bytes); };
    (a as unknown as { transcribeVoice: () => Promise<string> }).transcribeVoice = async () => 'hello there';
    const delivered: string[] = [];
    a.onMessage(async (m) => { delivered.push(m.content); });
    return { a, delivered };
  }
  const base = { message_id: 77, date: 1_760_000_000, from: { id: 5, first_name: 'J', is_bot: false }, chat: { id: -100123, type: 'supergroup' }, message_thread_id: 42 };

  it('a voice note is handed over while its download still exists, then deleted; the session still gets the transcript', async () => {
    const { a, delivered } = adapter();
    const seen: Array<TelegramInboundMedia & { existed: boolean }> = [];
    a.setInboundMediaHook(async (info) => { seen.push({ ...info, existed: fs.existsSync(info.filePath) }); });
    await (a as unknown as { handleVoiceMessage: (m: unknown, t: number) => Promise<void> }).handleVoiceMessage({ ...base, voice: { file_id: 'f', file_unique_id: 'u', duration: 3 } }, 42);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ topicId: 42, platformMessageId: 77, declaredKind: 'voice', existed: true, durationMs: 3000 });
    expect(fs.existsSync(seen[0]!.filePath)).toBe(false);
    expect(delivered).toEqual(['[voice] hello there']);
    await a.stop();
  });

  it('a photo is handed over with its size; a throwing hook never stops delivery', async () => {
    const { a, delivered } = adapter();
    const seen: TelegramInboundMedia[] = [];
    a.setInboundMediaHook(async (info) => { seen.push(info); throw new Error('boom'); });
    await (a as unknown as { handlePhotoMessage: (m: unknown, t: number) => Promise<void> }).handlePhotoMessage({ ...base, caption: 'look', photo: [{ file_id: 'p', file_unique_id: 'u', width: 640, height: 480 }] }, 42);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]).toMatchObject({ declaredKind: 'photo', width: 640, height: 480, declaredType: 'image/jpeg' });
    expect(delivered).toHaveLength(1);
    // native-conversation-base §3c: the file travels by attachment id; the text is path-free.
    expect(delivered[0]).toMatch(/^\[The user sent a photo \(attachment `\d+`, `[^`]+`\)\. It is stored on another machine and cannot be opened here\.\]\nlook$/);
    await a.stop();
  });

  it('with no hook set (media off) nothing is copied and delivery is unchanged', async () => {
    const { a, delivered } = adapter();
    await (a as unknown as { handleDocumentMessage: (m: unknown, t: number) => Promise<void> }).handleDocumentMessage({ ...base, document: { file_id: 'd', file_unique_id: 'u', file_name: 'r.pdf', mime_type: 'application/pdf' } }, 42);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatch(/^\[The user sent a file \(attachment `\d+`, `r\.pdf`\)\. It is stored on another machine and cannot be opened here\.\]$/);
    await a.stop();
  });
});
