import { describe, expect, it, vi } from 'vitest';
import { browseAppAttachments } from '../../src/core/AppAttachmentBrowse.js';
import type { AppMessageIndexRow, MediaMessageEvent, MediaRef, StoredAppEvent } from '../../src/core/AppConversationStore.js';
import type { AppAttachment } from '../../src/core/appMediaTypes.js';

const at = '2026-11-23T20:00:00.000Z';
const conversationKey = 'app:2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const key = (index: number) => String(index).padStart(3, '0');

function fixture(count: number) {
  const candidates: AppMessageIndexRow[] = Array.from({ length: count }, (_, i) => ({
    at, eventId: key(i), byteOffset: 1, byteLength: 100,
  }));
  const events = new Map<string, StoredAppEvent>();
  const refs = new Map<string, MediaRef>();
  const store = {
    attachmentIndexWindow: vi.fn((_chat, before) => candidates.slice(before ? Number(before.eventId) + 1 : 0, before ? Number(before.eventId) + 52 : 51)),
    readExactAttachmentEvent: vi.fn(async (_chat, row) => events.get(row.eventId) ?? null),
    mediaRef: vi.fn((id: string) => refs.get(id) ?? null),
  };
  const options = {
    store, conversationKey, kind: 'photo' as const, before: null,
    signal: new AbortController().signal, canRead: vi.fn(() => true),
    sealCursor: vi.fn((row: { eventId: string }) => row.eventId),
  };

  function add(index: number, media = true): MediaMessageEvent {
    const eventId = key(index);
    const item: AppAttachment = {
      attachmentId: eventId, index: 0, sha256: 'private hash', size: 12,
      declaredKind: 'file', kind: 'photo', filename: 'hello.jpg',
      mediaType: 'image/jpeg', declaredType: 'private type', transcript: 'private transcript',
    };
    const event: MediaMessageEvent & { ingestSeq: number } = {
      kind: 'media-message', eventId, messageId: 'message-' + eventId, at, conversationKey,
      attachments: [item], role: 'operator', text: 'private body', machineId: 'private machine', ingestSeq: index + 1,
    };
    events.set(eventId, media ? event : { ...event, kind: 'message' });
    refs.set(eventId, {
      canonicalKey: conversationKey, messageId: event.messageId, attachmentId: eventId,
      idx: 0, sha256: item.sha256, size: item.size, purged: false, tombstoned: false,
    });
    return event;
  }
  return { candidates, store, options, refs, add };
}

describe('browseAppAttachments', () => {
  it('does not consume the 51st candidate even when the first page is empty', async () => {
    const { add, options, store } = fixture(51);
    for (let i = 0; i < 51; i++) add(i, i === 50);
    const page = await browseAppAttachments(options);
    expect(page).toMatchObject({ coverage: 'local', rows: [], nextCursor: '049' });
    expect(store.readExactAttachmentEvent).toHaveBeenCalledTimes(50);
    const older = await browseAppAttachments({ ...options, before: { at, eventId: page.nextCursor! } });
    expect(older).toMatchObject({ rows: [{ eventId: '050' }], nextCursor: null });
    expect(JSON.stringify(older)).not.toContain('private');
  });

  it('charges the complete record and framing bytes before reading', async () => {
    const { add, candidates, options, store } = fixture(4);
    for (let i = 0; i < 4; i++) {
      add(i);
      candidates[i].byteLength = 256 * 1024 - 1;
    }
    const page = await browseAppAttachments(options);
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBe('002');
    expect(store.readExactAttachmentEvent).toHaveBeenCalledTimes(3);
  });

  it('omits hidden and purged evidence and marks mismatched or missing references incomplete', async () => {
    const { add, options, refs, store } = fixture(4);
    for (let i = 0; i < 4; i++) add(i);
    options.canRead.mockReturnValueOnce(false);
    refs.get('001')!.purged = true;
    refs.get('002')!.size += 1;
    refs.delete('003');
    expect(await browseAppAttachments(options)).toMatchObject({ rows: [], coverage: 'incomplete', nextCursor: null });
    expect(store.mediaRef).not.toHaveBeenCalledWith('000');
    const purgedOnly = await browseAppAttachments({ ...options, before: { at, eventId: '000' }, store: {
      ...store, attachmentIndexWindow: () => [{ at, eventId: '001', byteOffset: 1, byteLength: 100 }],
    } });
    expect(purgedOnly).toMatchObject({ rows: [], coverage: 'local' });
  });

  it('does not consume a projected row over the serialized ceiling', async () => {
    const { add, options, refs } = fixture(16);
    for (let i = 0; i < 16; i++) {
      const event = add(i);
      const first = event.attachments[0];
      event.attachments = Array.from({ length: 10 }, (_, index) => ({
        ...first, index, attachmentId: first.attachmentId + '-' + index,
        filename: '\u0001'.repeat(255), mediaType: '\u0001'.repeat(128),
      }));
      for (const item of event.attachments) refs.set(item.attachmentId, {
        ...refs.get(first.attachmentId)!, attachmentId: item.attachmentId, idx: item.index,
      });
    }
    const page = await browseAppAttachments(options);
    expect(page.rows.length).toBeLessThan(15);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
    const older = await browseAppAttachments({ ...options, before: { at, eventId: page.nextCursor! } });
    expect(Number(older.rows[0].eventId)).toBe(page.rows.length);
  });

  it('rejects an invalid ordering boundary or changed authorization before publishing', async () => {
    const { add, candidates, options, store } = fixture(2);
    add(0);
    add(1);
    candidates[0].at = 'invalid';
    await expect(browseAppAttachments(options)).rejects.toThrow('Unrepresentable');
    expect(store.readExactAttachmentEvent).not.toHaveBeenCalled();
    candidates[0].at = at;
    options.canRead.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(browseAppAttachments(options)).rejects.toThrow('evidence changed');
  });
});
