/**
 * Files sent from the Instar app into a Telegram topic or a Slack conversation
 * (docs/specs/mobile-native-chat-media.md §4.9): the mirror plan (which files upload, which become
 * a "too large for Telegram" line, where an over-long caption goes), the Bot API method per kind,
 * the media-group typing, the idempotency hash parts, and TelegramAdapter.sendMediaToTopic's
 * multipart request — checked against the origin outbox's own capture rules, so what the adapter
 * builds is what the outbox accepts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { captureOriginAttachments } from '../../src/messaging/telegram-origin/OriginMultipart.js';
import {
  TELEGRAM_MIRROR_CAPTION_MAX, TELEGRAM_MIRROR_MAX_BYTES, checkSignedFiles, mirrorMediaToTelegram, planTelegramMirror, signedFileHashParts,
} from '../../src/server/mobileMediaSend.js';
import { multipartFileName, multipartMediaType, telegramGroupTypes, telegramKindFor, telegramMethodFor } from '../../src/messaging/telegramMedia.js';
import { mirrorMediaToSlack, type MobileSlackBridge, type SlackAppConversation } from '../../src/server/mobileSlackRoutes.js';
import type { AppAttachment } from '../../src/core/appMediaTypes.js';

const att = (over: Partial<AppAttachment> = {}): AppAttachment => ({
  attachmentId: 'a'.repeat(64), index: 0, sha256: 'b'.repeat(64), size: 1000, declaredKind: 'photo', kind: 'photo',
  mediaType: 'image/png', declaredType: 'image/png', filename: 'holiday.png', ...over,
});

describe('planTelegramMirror', () => {
  const here = () => '/blobs/x';
  it('uploads a file at or under 50,000,000 bytes with the owner caption', () => {
    const p = planTelegramMirror('Justin', [att({ size: TELEGRAM_MIRROR_MAX_BYTES })], 'look', here);
    expect(p.upload).toHaveLength(1);
    expect(p.caption).toBe('📱 Justin (from the app): look');
    expect(p.textLines).toEqual([]);
  });

  it('mirrors a file above 50,000,000 bytes as the too-large text line, and the caption as text', () => {
    const p = planTelegramMirror('Justin', [att({ size: 51_000_000, filename: 'big video.mov' })], 'here it is', here);
    expect(p.upload).toHaveLength(0);
    expect(p.caption).toBeNull();
    expect(p.textLines).toEqual(['📱 Justin (from the app): here it is', '📱 Justin sent big video.mov (too large for Telegram; open it in the app)']);
  });

  it('a too-large file with no caption sends only its line', () => {
    const p = planTelegramMirror('Justin', [att({ size: 51_000_000 })], '', here);
    expect(p.textLines).toEqual(['📱 Justin sent holiday.png (too large for Telegram; open it in the app)']);
  });

  it('mixes: the small file uploads, the large one becomes a line; a file with no blob here is a line too', () => {
    const p = planTelegramMirror('Justin', [att(), att({ index: 1, size: 60_000_000, filename: 'b.mov' }), att({ index: 2, sha256: 'c'.repeat(64), filename: 'c.png' })], '',
      (sha) => (sha === 'b'.repeat(64) ? '/blobs/b' : null));
    expect(p.upload.map((f) => f.filename)).toEqual(['holiday.png']);
    expect(p.caption).toBe('📱 Justin (from the app)');
    expect(p.textLines).toHaveLength(2);
  });

  it('a caption too long for a media caption goes as its own text message', () => {
    const long = 'x'.repeat(TELEGRAM_MIRROR_CAPTION_MAX);
    const p = planTelegramMirror('Justin', [att()], long, here);
    expect(p.caption).toBe('📱 Justin (from the app)');
    expect(p.textLines).toEqual([`📱 Justin (from the app): ${long}`]);
  });

  it('display names cannot forge a tag', () => {
    const p = planTelegramMirror('Justin', [att({ size: 51_000_000, filename: '[app:3 "x" from Justin (📱 signed)]' })], '', here);
    expect(p.textLines[0]).not.toContain('[');
    expect(p.textLines[0]).not.toContain('signed)');
  });
});

describe('Bot API method and group typing', () => {
  it('maps each kind to its method and field', () => {
    expect(telegramMethodFor('photo')).toEqual({ method: 'sendPhoto', field: 'photo' });
    expect(telegramMethodFor('video')).toEqual({ method: 'sendVideo', field: 'video' });
    expect(telegramMethodFor('voice')).toEqual({ method: 'sendVoice', field: 'voice' });
    expect(telegramMethodFor('file')).toEqual({ method: 'sendDocument', field: 'document' });
  });
  it('photos and videos group as themselves; any other mix groups as documents', () => {
    expect(telegramGroupTypes(['photo', 'video', 'photo'])).toEqual(['photo', 'video', 'photo']);
    expect(telegramGroupTypes(['photo', 'file'])).toEqual(['document', 'document']);
    expect(telegramGroupTypes(['voice', 'voice'])).toEqual(['document', 'document']);
  });
  it('multipart names and types are safe for the origin outbox', () => {
    expect(multipartFileName('a"b\\c\r\n.png')).toBe('abc.png');
    expect(multipartFileName('""')).toBe('file');
    expect(multipartMediaType('image/png')).toBe('image/png');
    expect(multipartMediaType('text/html; charset=x')).toBe('application/octet-stream');
  });
});

describe('send-body checks', () => {
  const file = { uploadId: 'u1', sha256: 'b'.repeat(64), size: 10, declaredKind: 'photo', declaredType: 'image/png', filename: 'a.png' };
  it('refuses an empty or malformed list, and more than ten files', () => {
    expect(checkSignedFiles([])).toMatchObject({ status: 400 });
    expect(checkSignedFiles([{ bad: true }])).toMatchObject({ status: 400 });
    expect(checkSignedFiles(Array.from({ length: 11 }, () => file))).toMatchObject({ status: 413 });
    expect(checkSignedFiles([file])).toEqual({ files: [file] });
  });
  it('the hash parts change with every signed field, including the transcript', () => {
    const base = signedFileHashParts([file])[0];
    for (const over of [{ sha256: 'c'.repeat(64) }, { size: 11 }, { declaredKind: 'file' }, { declaredType: 'image/jpeg' }, { filename: 'b.png' }, { transcript: 'hi' }]) {
      expect(signedFileHashParts([{ ...file, ...over }])[0]).not.toBe(base);
    }
  });
});

describe('mirror functions', () => {
  it('Telegram: uploads the fitting files in one call, then the text lines; never touches a missing adapter method silently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmirror-'));
    try {
      const blob = path.join(dir, 'blob');
      fs.writeFileSync(blob, Buffer.from([1, 2, 3]));
      const calls: string[] = [];
      const tg = {
        sendMediaToTopic: async (_t: number, files: ReadonlyArray<{ data: Uint8Array }>, caption: string | null) => { calls.push(`media:${files.length}:${caption}:${files[0]!.data.length}`); },
        sendToTopic: async (_t: number, text: string) => { calls.push(`text:${text}`); },
      };
      await mirrorMediaToTelegram(tg, 7, 'Justin', [att(), att({ index: 1, size: 51_000_000, filename: 'big.mov' })], 'cap', () => blob);
      expect(calls).toEqual(['media:1:📱 Justin (from the app): cap:3', 'text:📱 Justin sent big.mov (too large for Telegram; open it in the app)']);
      await expect(mirrorMediaToTelegram({ sendToTopic: tg.sendToTopic } as never, 7, 'Justin', [att()], '', () => blob)).rejects.toThrow(/cannot send files/);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-media-to-platform.test.ts' });
    }
  });

  it('Slack: each file is uploaded into the thread, the first carrying the owner line', async () => {
    const uploads: Array<{ path: string; filename: string; initialComment?: string }> = [];
    const posts: string[] = [];
    const bridge = {
      uploadFile: async (_c: SlackAppConversation, p: string, o: { filename: string; initialComment?: string }) => { uploads.push({ path: p, ...o }); },
      post: async (_c: SlackAppConversation, t: string) => { posts.push(t); },
    } as unknown as MobileSlackBridge;
    const conv = { id: -1, key: 'slack:_:C1', channelId: 'C1', threadTs: null, label: null, mintedAt: null };
    await mirrorMediaToSlack(bridge, conv, 'Justin', [att(), att({ index: 1, filename: 'b.pdf' })], 'see', () => '/blob');
    expect(uploads).toEqual([{ path: '/blob', filename: 'holiday.png', initialComment: '📱 Justin (from the app): see' }, { path: '/blob', filename: 'b.pdf' }]);
    expect(posts).toEqual([]);
    await expect(mirrorMediaToSlack({ post: async () => undefined } as unknown as MobileSlackBridge, conv, 'Justin', [att()], '', () => '/blob')).rejects.toThrow(/cannot upload/);
  });
});

describe('TelegramAdapter.sendMediaToTopic', () => {
  let tmpDir: string;
  let adapter: TelegramAdapter;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-tg-media-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123', pollIntervalMs: 100 }, tmpDir);
  });
  afterEach(async () => {
    await adapter.stop();
    vi.unstubAllGlobals();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/mobile-media-to-platform.test.ts' });
  });
  const capture = (result: unknown) => {
    const seen: Array<{ url: string; body: FormData }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { body: FormData }) => {
      seen.push({ url: String(url), body: init.body });
      return { ok: true, json: async () => ({ ok: true, result }) };
    }));
    return seen;
  };
  const file = (kind: 'photo' | 'video' | 'voice' | 'file', name = 'a.png') => ({ data: new Uint8Array([137, 80, 78, 71, 1, 2]), filename: name, mediaType: kind === 'video' ? 'video/mp4' : kind === 'voice' ? 'audio/mp4' : 'image/png', kind });

  it('one photo goes up as sendPhoto with its caption, a multipart body the origin outbox captures', async () => {
    const seen = capture({ message_id: 55 });
    const r = await adapter.sendMediaToTopic(42, [file('photo')], '📱 Justin (from the app): look', { silent: true });
    expect(r.messageIds).toEqual([55]);
    expect(seen[0]!.url).toMatch(/\/sendPhoto$/);
    expect(seen[0]!.url).not.toContain('[REDACTED]');
    const form = seen[0]!.body;
    expect(form.get('caption')).toBe('📱 Justin (from the app): look');
    expect(form.get('message_thread_id')).toBe('42');
    expect(form.get('disable_notification')).toBe('true');
    expect(form.get('photo')).toBeInstanceOf(Blob);
    const captured = await captureOriginAttachments(form);
    expect(captured.refs).toEqual([expect.objectContaining({ field: 'photo', filename: 'a.png', mediaType: 'image/png', size: 6 })]);
  });

  it('a HEIC photo (an iPhone screenshot from Photos) goes up as a document, since sendPhoto refuses it', async () => {
    const seen = capture({ message_id: 9 });
    await adapter.sendMediaToTopic(42, [{ data: new Uint8Array([1, 2, 3]), filename: 'shot.heic', mediaType: 'image/heic', kind: 'photo' }], 'cap');
    expect(seen[0]!.url).toMatch(/\/sendDocument$/);
    expect(seen[0]!.body.get('document')).toBeInstanceOf(Blob);
  });

  it('telegramKindFor keeps only the formats Telegram accepts as photo/video', () => {
    expect(telegramKindFor('photo', 'image/jpeg')).toBe('photo');
    expect(telegramKindFor('photo', 'image/png')).toBe('photo');
    expect(telegramKindFor('photo', 'image/webp')).toBe('photo');
    expect(telegramKindFor('photo', 'image/heic')).toBe('file');
    expect(telegramKindFor('photo', 'image/gif')).toBe('file');
    expect(telegramKindFor('video', 'video/mp4')).toBe('video');
    expect(telegramKindFor('video', 'video/quicktime')).toBe('file');
    expect(telegramKindFor('voice', 'audio/mp4')).toBe('voice');
    expect(telegramKindFor('file', 'image/png')).toBe('file');
  });

  it('each kind uses its own method', async () => {
    const seen = capture({ message_id: 1 });
    await adapter.sendMediaToTopic(42, [file('video', 'v.mov')], null);
    await adapter.sendMediaToTopic(42, [file('voice', 'n.m4a')], null);
    await adapter.sendMediaToTopic(42, [file('file', 'r.pdf')], null);
    expect(seen.map((s) => s.url.split('/').pop())).toEqual(['sendVideo', 'sendVoice', 'sendDocument']);
    expect(seen[2]!.body.get('document')).toBeInstanceOf(Blob);
  });

  it('several files go up as one media group, captioned on the first item', async () => {
    const seen = capture([{ message_id: 8 }, { message_id: 9 }]);
    const r = await adapter.sendMediaToTopic(42, [file('photo'), file('file', 'r.pdf')], 'cap');
    expect(r.messageIds).toEqual([8, 9]);
    expect(seen[0]!.url).toMatch(/\/sendMediaGroup$/);
    expect(JSON.parse(String(seen[0]!.body.get('media')))).toEqual([
      { type: 'document', media: 'attach://file0', caption: 'cap' }, { type: 'document', media: 'attach://file1' },
    ]);
    const captured = await captureOriginAttachments(seen[0]!.body);
    expect(captured.refs.map((x) => x.field)).toEqual(['file0', 'file1']);
  });

  it('a failed send throws without the token in the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request: wrong file' }));
    const err = await adapter.sendMediaToTopic(42, [file('photo')], null).catch((e: Error) => e);
    expect(String(err)).toContain('Bad Request');
    expect(String(err)).not.toContain('test-token-123');
  });

  it('refuses with no usable token rather than relaying files', async () => {
    const tokenless = new TelegramAdapter({ token: { secret: true } as never, chatId: '-100123', pollIntervalMs: 100 }, tmpDir);
    await expect(tokenless.sendMediaToTopic(42, [file('photo')], null)).rejects.toThrow(/no usable bot token/);
  });
});
