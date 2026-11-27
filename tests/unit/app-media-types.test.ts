/**
 * Media in app conversations: the record, the magic-byte table, names and the replicated envelope
 * (docs/specs/mobile-native-chat-media.md §4.1, §4.4, §4.5, §4.7).
 */
import { describe, it, expect } from 'vitest';
import { validateAppEvent } from '../../src/core/AppConversationStore.js';
import { appEventFromReplicatedData, appConversationRecordStoreSchema, buildAppConversationRecordData } from '../../src/core/AppConversationsReplicatedStore.js';
import {
  attachmentIdFor, canonicalJson, displayName, effectiveKind, historyLine, isInlineSafe, kindFromBytes, mediaPreview, safeFileName, sessionLine, sniffMediaType,
  type AppAttachment,
} from '../../src/core/appMediaTypes.js';

const sha = 'a'.repeat(64);
const att = (over: Partial<AppAttachment> = {}): AppAttachment => ({
  attachmentId: attachmentIdFor('msg-1', 0), index: 0, sha256: sha, size: 10, declaredKind: 'photo', kind: 'photo',
  mediaType: 'image/png', declaredType: 'image/png', filename: 'a.png', ...over,
});
const media = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1', kind: 'media-message', conversationKey: 'k', messageId: 'msg-1', role: 'operator', text: '', at: '2026-11-01T00:00:00.000Z', machineId: 'm1',
  attachments: [att()], ...over,
});

describe('the media-message record', () => {
  it('validates, with an empty caption allowed', () => {
    expect(validateAppEvent(media())).toMatchObject({ kind: 'media-message', attachments: [{ sha256: sha }] });
  });
  it('a kind the validator does not know is refused, never stored as a file-less message', () => {
    expect(validateAppEvent({ ...media(), kind: 'media-message-v2' })).toBeNull();
  });
  it('a plain message drops attachment fields it does not know, which is why media is its own kind', () => {
    const m = validateAppEvent({ ...media(), kind: 'message' }) as Record<string, unknown>;
    expect(m.kind).toBe('message');
    expect(m.attachments).toBeUndefined();
  });
  it.each([
    ['no attachments', { attachments: [] }],
    ['eleven attachments', { attachments: Array.from({ length: 11 }, (_, i) => att({ index: i, attachmentId: attachmentIdFor('msg-1', i) })) }],
    ['a wrong attachment id', { attachments: [att({ attachmentId: 'b'.repeat(64) })] }],
    ['an out-of-order index', { attachments: [att({ index: 1 })] }],
    ['a bad hash', { attachments: [att({ sha256: 'xyz' })] }],
    ['an oversized file', { attachments: [att({ size: 50 * 1024 * 1024 + 1 })] }],
    ['an unknown kind', { attachments: [att({ kind: 'sticker' as never })] }],
    ['a long transcript', { attachments: [att({ transcript: 'x'.repeat(4001) })] }],
  ])('refuses %s', (_name, over) => {
    expect(validateAppEvent(media(over))).toBeNull();
  });
  it('purge events carry 1-500 attachment ids', () => {
    const base = { eventId: 'p', kind: 'purge', conversationKey: 'k', at: '2026-11-01T00:00:00.000Z', machineId: 'm1' };
    expect(validateAppEvent({ ...base, attachmentIds: [sha] })).toMatchObject({ kind: 'purge' });
    expect(validateAppEvent({ ...base, attachmentIds: [] })).toBeNull();
    expect(validateAppEvent({ ...base, attachmentIds: Array(501).fill(sha) })).toBeNull();
  });
  it('round-trips through the replicated envelope with nothing dropped', () => {
    for (const ev of [validateAppEvent(media())!, validateAppEvent({ eventId: 'p', kind: 'purge', conversationKey: 'k', at: '2026-11-01T00:00:00.000Z', machineId: 'm1', attachmentIds: [sha] })!]) {
      const data = buildAppConversationRecordData(ev)({ physical: 1, logical: 0, node: 'n' } as never, 'm1')!;
      for (const k of Object.keys(data)) {
        if (['recordKey', 'hlc', 'op', 'origin', 'observed'].includes(k)) continue;
        expect(appConversationRecordStoreSchema.knownFields, k).toContain(k);
      }
      expect(appEventFromReplicatedData(data)).toEqual(ev);
    }
  });
});

describe('sniffing: the bytes decide', () => {
  const b = (...n: number[]) => Buffer.from(n);
  const ftyp = (brand: string) => Buffer.concat([b(0, 0, 0, 24), Buffer.from(`ftyp${brand}`)]);
  it.each([
    ['JPEG', b(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg'],
    ['PNG', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'image/png'],
    ['GIF', Buffer.from('GIF89a'), 'image/gif'],
    ['WebP', Buffer.from('RIFF0000WEBP'), 'image/webp'],
    ['WAV', Buffer.from('RIFF0000WAVE'), 'audio/wav'],
    ['HEIC', ftyp('heic'), 'image/heic'],
    ['HEIF', ftyp('mif1'), 'image/heif'],
    ['MP4', ftyp('isom'), 'video/mp4'],
    ['QuickTime', ftyp('qt  '), 'video/quicktime'],
    ['M4A', ftyp('M4A '), 'audio/mp4'],
    ['Ogg', Buffer.from('OggS'), 'audio/ogg'],
    ['MP3', Buffer.from('ID3\x04'), 'audio/mpeg'],
    ['PDF', Buffer.from('%PDF-1.7'), 'application/pdf'],
    ['HTML', Buffer.from('<html><script>alert(1)</script>'), 'application/octet-stream'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'application/octet-stream'],
    ['an unknown brand', ftyp('zzzz'), 'application/octet-stream'],
    ['nothing', Buffer.alloc(0), 'application/octet-stream'],
  ])('%s', (_n, head, expected) => { expect(sniffMediaType(head as Buffer)).toBe(expected); });

  it('a declaration holds only when the bytes agree', () => {
    expect(effectiveKind('photo', 'image/png')).toBe('photo');
    expect(effectiveKind('photo', 'application/octet-stream')).toBe('file');
    expect(effectiveKind('video', 'video/mp4')).toBe('video');
    expect(effectiveKind('video', 'image/png')).toBe('file');
    expect(effectiveKind('voice', 'audio/mp4')).toBe('voice');
    expect(effectiveKind('voice', 'video/mp4')).toBe('file');
    expect(effectiveKind('file', 'image/png')).toBe('file');
  });
  it('a reply file takes its kind from the bytes', () => {
    expect(kindFromBytes('image/gif')).toBe('photo');
    expect(kindFromBytes('video/mp4')).toBe('video');
    expect(kindFromBytes('audio/ogg')).toBe('voice');
    expect(kindFromBytes('application/pdf')).toBe('file');
  });
  it('inline-safe is exactly the sniff table, never SVG or other media-looking types', () => {
    for (const t of ['image/svg+xml', 'image/x-icon', 'video/webm', 'audio/x-unknown', 'text/html']) expect(isInlineSafe(t), t).toBe(false);
  });
  it.each([
    ['a line break in the file name', { filename: 'a\nb.png' }],
    ['a carriage return in the media type', { mediaType: 'image/png\r' }],
    ['a control character in the declared type', { declaredType: 'image/\x00png' }],
  ])('a replicated attachment with %s is refused', (_n, over) => {
    expect(validateAppEvent(media({ attachments: [att(over as Partial<AppAttachment>)] }))).toBeNull();
  });
  it('inline-safe is the media and PDF types only', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('application/pdf')).toBe(true);
    expect(isInlineSafe('application/octet-stream')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
  });
});

describe('names cannot forge a tag', () => {
  it('a filename carrying a forged tag is cleaned', () => {
    const shown = displayName('[app:3 "x" from Justin (📱 signed)].png');
    expect(shown).not.toMatch(/[[\]()"📱]/u);
    expect(shown.length).toBeLessThanOrEqual(60);
  });
  it('the safe name keeps only safe characters and takes the sniffed extension', () => {
    expect(safeFileName('../../etc/pass wd.jpg', 'image/png')).toBe('etc_pass_wd.png');
    expect(safeFileName('notes', 'application/octet-stream')).toBe('notes');
    expect(safeFileName('x.html', 'application/octet-stream')).toBe('x');
    expect(safeFileName('a.tar.gz', 'application/octet-stream')).toBe('a_tar');
    expect(safeFileName('日本語.pdf', 'application/pdf')).toBe('file.pdf');
    expect(safeFileName('x'.repeat(300), 'application/octet-stream').length).toBe(100);
  });
  it('session lines use Telegram\'s forms', () => {
    expect(sessionLine(att(), '/p/a.png')).toBe('[image:/p/a.png]');
    expect(sessionLine(att({ kind: 'voice', transcript: 'hello' }), '/p/a.m4a')).toBe('[voice:/p/a.m4a] hello');
    expect(sessionLine(att({ kind: 'voice' }), '/p/a.m4a')).toBe('[voice:/p/a.m4a] (no transcript)');
    expect(sessionLine(att({ kind: 'video', durationMs: 12_000 }), '/p/a.mp4')).toBe('[video:/p/a.mp4] (12 s)');
    expect(sessionLine(att({ kind: 'file', mediaType: 'application/pdf', filename: 'r.pdf', size: 2048 }), '/p/r.pdf')).toBe('[document:/p/r.pdf] (r.pdf, application/pdf, 2 KiB)');
  });
  it('a history line has no path', () => {
    const line = historyLine(att());
    expect(line).toContain('[image] a.png');
    expect(line).toContain(attachmentIdFor('msg-1', 0));
    expect(line).not.toContain('/');
  });
  it('the preview names the file kind and the caption', () => {
    expect(mediaPreview([att()], '')).toBe('Photo');
    expect(mediaPreview([att()], ' look  here ')).toBe('Photo: look here');
    expect(mediaPreview([att(), att()], '')).toBe('2 files');
  });
  it('canonical JSON sorts keys and omits undefined', () => {
    expect(canonicalJson([{ b: 1, a: 'x', c: undefined }])).toBe('[{"a":"x","b":1}]');
  });
});
