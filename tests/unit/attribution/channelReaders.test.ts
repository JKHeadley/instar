import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelReaders } from '../../../src/core/attribution/channelReaders.js';
import type { SourceRef } from '../../../src/core/attribution/marker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const ref = (channel: SourceRef['channel'], conversation: string, message: string): SourceRef => ({ channel, conversation, message, date: '2026-10-08' });

describe('ChannelReaders', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-readers-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/channelReaders.test.ts:cleanup' }); });
  const write = (file: string, rows: unknown[]) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  };

  const telegramRow = { messageId: 123160, topicId: 102965, text: 'at least every hour', fromUser: true, telegramUserId: 42, forwarded: false, provenance: 'user', timestamp: '2026-10-08T04:34:33.000Z' };

  it('reads Telegram by topic and message, with the oldest date and an ASP verdict', async () => {
    write('telegram-messages.jsonl', [{ ...telegramRow, messageId: 1, timestamp: '2026-01-02T00:00:00.000Z' }, telegramRow]);
    const lookup = await new ChannelReaders({ stateDir: dir }).readLocal(ref('telegram', '102965', '123160'));
    expect(lookup.row).toMatchObject({ messageId: 123160 });
    expect(lookup.retainedFrom).toBe('2026-01-02');
    expect(lookup.authorship).toBe('UNRESOLVED');
  });

  it('reports a legacy row as unclassifiable, not as a person', async () => {
    write('telegram-messages.jsonl', [{ ...telegramRow, timestamp: '2026-07-30T00:00:00.000Z' }]);
    const lookup = await new ChannelReaders({ stateDir: dir }).readLocal(ref('telegram', '102965', '123160'));
    expect(lookup.authorship).toBe('unclassifiable');
  });

  it('reads Slack, iMessage and WhatsApp from their own logs by channel and message', async () => {
    const row = { messageId: 'abc.1', channelId: 'C1', text: 'hi', fromUser: true, platformUserId: 'U1', timestamp: '2026-10-08T00:00:00.000Z' };
    write('slack-messages.jsonl', [row]);
    write('imessage-messages.jsonl', [row]);
    write('whatsapp/messages.jsonl', [row]);
    const readers = new ChannelReaders({ stateDir: dir });
    for (const channel of ['slack', 'imessage', 'whatsapp'] as const) {
      expect((await readers.readLocal(ref(channel, 'C1', 'abc.1'))).row).toMatchObject({ platformUserId: 'U1' });
    }
    expect((await readers.readLocal(ref('slack', 'C2', 'abc.1'))).row).toBeNull();
  });

  it('an absent log reads as holding nothing, with no retained range', async () => {
    expect(await new ChannelReaders({ stateDir: dir }).readLocal(ref('slack', 'C1', '1'))).toEqual({ row: null, retainedFrom: null });
  });

  it('shares in-flight reads and reuses a parse until the file changes', async () => {
    write('telegram-messages.jsonl', [telegramRow]);
    const readers = new ChannelReaders({ stateDir: dir });
    const spy = vi.spyOn(fs, 'createReadStream');
    const r = ref('telegram', '102965', '123160');
    await Promise.all([readers.readLocal(r), readers.readLocal(r)]);
    expect(spy).toHaveBeenCalledTimes(1);
    await readers.readLocal(r);
    expect(spy).toHaveBeenCalledTimes(1);
    fs.appendFileSync(path.join(dir, 'telegram-messages.jsonl'), `${JSON.stringify({ ...telegramRow, messageId: 2 })}\n`);
    await readers.readLocal(r);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('the app channel reads the store, and a tombstone or fully purged message resolves removed', async () => {
    const event = { kind: 'message', eventId: 'e1', messageId: 'e1', role: 'operator', text: 'hello', at: '2026-10-08T00:00:00.000Z' };
    const store = {
      getConversation: (key: string) => (key === 'gone' ? { tombstoned: true, createdAt: '2026-01-01T00:00:00Z' } : key === 'live' ? { tombstoned: false, createdAt: '2026-01-01T00:00:00Z' } : null),
      getEvent: (_key: string, id: string) => (id === 'e1' ? event : id === 'm1' ? { ...event, kind: 'media-message', attachments: [{ attachmentId: 'a' }] } : null),
      getMessageEvent: () => null,
      isAttachmentPurged: () => true,
    };
    const readers = new ChannelReaders({ stateDir: dir, appStore: () => store as never });
    expect((await readers.readLocal(ref('app', 'live', 'e1'))).row).toMatchObject({ text: 'hello', timestamp: event.at });
    expect((await readers.readLocal(ref('app', 'gone', 'e1'))).removed).toBe(true);
    expect((await readers.readLocal(ref('app', 'live', 'm1'))).removed).toBe(true);
    expect(await readers.readLocal(ref('app', 'none', 'e1'))).toEqual({ row: null, retainedFrom: null });
  });

  it('threadline reads by seq and stays confined to the thread folder', async () => {
    const entries = [{ seq: 4, at: '2026-10-08T00:00:00.000Z', direction: 'inbound', peerFingerprint: 'fp', textRef: { kind: 'inline', text: 'peer words' } }];
    const log = {
      isPathConfined: (id: string) => id === 'thread-a',
      read: (_id: string, opts: { afterSeq?: number }) => ({ entries: opts.afterSeq === undefined ? entries : entries.filter((e) => e.seq > (opts.afterSeq as number)) }),
    };
    const readers = new ChannelReaders({ stateDir: dir, threadLog: () => log as never });
    expect((await readers.readLocal(ref('threadline', 'thread-a', '4'))).row).toMatchObject({ text: 'peer words', direction: 'inbound' });
    expect((await readers.readLocal(ref('threadline', 'thread-a', '4'))).row).not.toHaveProperty('textRef');
    expect((await readers.readLocal(ref('threadline', '../../etc', '4'))).row).toBeNull();
    expect((await readers.readLocal(ref('threadline', 'thread-a', 'x'))).row).toBeNull();
  });

  it('a local UNRESOLVED on a peer\'s row is no verdict; a real local verdict still counts', () => {
    const readers = new ChannelReaders({ stateDir: dir });
    expect(readers.localVerdictOnPeerRow(ref('telegram', '102965', '123160'), telegramRow)).toBeUndefined();
    expect(readers.localVerdictOnPeerRow(ref('telegram', '102965', '123160'), { ...telegramRow, timestamp: '2026-07-30T00:00:00.000Z' })).toBe('unclassifiable');
    expect(readers.localVerdictOnPeerRow(ref('slack', 'C', '1'), telegramRow)).toBeUndefined();
  });
});
